use super::*;

#[test]
fn failed_restore_rolls_back_the_delete_and_keeps_preferences() {
    let mut current = TodoRepository::open_in_memory().unwrap();
    let saved = current.create(sample()).unwrap();
    current.set_theme("dark").unwrap();
    let mut source = TodoRepository::open_in_memory().unwrap();
    source.create(sample()).unwrap();
    let records = source.backup_records().unwrap();
    current.conn.execute_batch("CREATE TRIGGER fail_restore BEFORE INSERT ON todo_tasks BEGIN SELECT RAISE(ABORT, 'simulated disk failure'); END;").unwrap();
    assert!(current
        .replace_backup_records(&records, &std::collections::BTreeMap::new())
        .is_err());
    assert_eq!(current.list().unwrap()[0].id, saved.id);
    assert_eq!(current.theme().unwrap(), "dark");
}

fn sample() -> TodoDraft {
    TodoDraft {
        customer_name: "示例客户".into(),
        title: "准备示例文档".into(),
        note: "虚构测试内容".into(),
        received_at: "2026-09-06T09:00:00+08:00".into(),
        due_at: None,
        attachment_paths: vec![],
        category: None,
        reminder_at: None,
    }
}

#[test]
fn tasks_survive_reopen_with_nullable_due_date() {
    let temp = tempfile::tempdir().unwrap();
    let db = temp.path().join("todo.sqlite");
    let created = {
        let mut repo = TodoRepository::open(&db).unwrap();
        repo.create(sample()).unwrap()
    };
    let repo = TodoRepository::open(&db).unwrap();
    let tasks = repo.list().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].id, created.id);
    assert_eq!(tasks[0].customer_name, "示例客户");
    assert_eq!(tasks[0].due_at, None);
    assert_eq!(tasks[0].status, TodoStatus::Pending);
}

#[test]
fn required_fields_and_invalid_dates_do_not_create_rows() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    // 客户为选填：空白客户会保留为空字符串并正常建任务。
    let mut draft = sample();
    draft.customer_name = "  ".into();
    let created_without_customer = repo.create(draft).unwrap();
    assert_eq!(created_without_customer.customer_name, "");
    let mut draft = sample();
    draft.title = "\n".into();
    assert!(repo.create(draft).is_err());
    let mut draft = sample();
    draft.due_at = Some("明天".into());
    assert!(repo.create(draft).is_err());
    // 仅空客户任务入库。
    assert_eq!(repo.list().unwrap().len(), 1);
}

#[test]
fn edits_keep_identity_and_completion_can_be_reversed() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let created = repo.create(sample()).unwrap();
    let urgent = repo.set_urgent(&created.id, true).unwrap();
    assert!(urgent.urgent_at.is_some());
    let done = repo.set_status(&created.id, TodoStatus::Completed).unwrap();
    assert!(done.completed_at.is_some());
    assert!(done.urgent_at.is_none());
    let restored = repo
        .set_status(&created.id, TodoStatus::InProgress)
        .unwrap();
    assert!(restored.completed_at.is_none());
    let mut draft = sample();
    draft.title = "修改后的示例".into();
    draft.due_at = Some("2026-09-07T00:00:00+08:00".into());
    let edited = repo.update(&created.id, draft).unwrap();
    assert_eq!(edited.id, created.id);
    assert_eq!(edited.status, TodoStatus::InProgress);
    assert_eq!(edited.title, "修改后的示例");
    assert!(edited.due_at.is_some());
    let without_due = repo.update(&created.id, sample()).unwrap();
    assert!(without_due.due_at.is_none());
    assert!(repo.update("missing", sample()).is_err());
}

#[test]
fn deleted_tasks_are_hidden_but_keep_sync_metadata() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let task = repo.create(sample()).unwrap();
    repo.delete(&task.id).unwrap();
    assert!(repo.list().unwrap().is_empty());
    let metadata: (Option<String>, i64) = repo
        .conn
        .query_row(
            "SELECT deleted_at, version FROM todo_tasks WHERE id = ?1",
            [&task.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert!(metadata.0.is_some());
    assert_eq!(metadata.1, 2);
    assert!(repo.update(&task.id, sample()).is_err());
    assert!(repo.set_status(&task.id, TodoStatus::Pending).is_err());
    // 删除重试是幂等的，不复活或重复写入。
    repo.delete(&task.id).unwrap();
}

#[test]
fn storage_write_failures_reach_the_caller() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let task = repo.create(sample()).unwrap();
    repo.conn.execute_batch("PRAGMA query_only = ON").unwrap();
    assert!(repo.create(sample()).is_err());
    assert!(repo.update(&task.id, sample()).is_err());
    assert!(repo.delete(&task.id).is_err());
    assert_eq!(repo.list().unwrap()[0].title, task.title);
}

#[test]
fn corrupt_or_newer_databases_are_never_replaced() {
    let temp = tempfile::tempdir().unwrap();
    let corrupt = temp.path().join("corrupt.sqlite");
    std::fs::write(&corrupt, b"not a database").unwrap();
    assert!(TodoRepository::open(&corrupt).is_err());
    assert_eq!(std::fs::read(&corrupt).unwrap(), b"not a database");
    let future = temp.path().join("future.sqlite");
    let conn = rusqlite::Connection::open(&future).unwrap();
    conn.execute_batch("PRAGMA user_version = 999").unwrap();
    drop(conn);
    assert!(TodoRepository::open(&future).is_err());
}

#[test]
fn theme_preference_survives_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("settings.sqlite");
    let mut repo = TodoRepository::open(&path).unwrap();
    assert_eq!(repo.theme().unwrap(), "system");
    repo.set_theme("dark").unwrap();
    assert!(repo.set_theme("arbitrary").is_err());
    drop(repo);
    let repo = TodoRepository::open(&path).unwrap();
    assert_eq!(repo.theme().unwrap(), "dark");
}

#[test]
fn category_and_reminder_persist_through_edit_and_reopen() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("tasks.sqlite");
    let mut draft = sample();
    draft.category = Some("工作".into());
    draft.reminder_at = Some("2026-09-07T09:00:00+08:00".into());
    let created = {
        let mut repo = TodoRepository::open(&path).unwrap();
        let task = repo.create(draft).unwrap();
        // 非法提醒时间拒绝，且不落库。
        let mut bad = sample();
        bad.reminder_at = Some("明天".into());
        assert!(repo.create(bad).is_err());
        task
    };
    let repo = TodoRepository::open(&path).unwrap();
    let task = &repo.list().unwrap()[0];
    assert_eq!(task.id, created.id);
    assert_eq!(task.category.as_deref(), Some("工作"));
    assert!(task.reminder_at.is_some());
    assert_eq!(task.reminder_revision, 0);
    // 清除提醒后 revision 递增。
    let mut repo = TodoRepository::open(&path).unwrap();
    let cleared = repo.set_reminder(&created.id, None).unwrap();
    assert!(cleared.reminder_at.is_none());
    assert_eq!(cleared.reminder_revision, 1);
}

#[test]
fn start_and_waiting_timestamps_follow_workflow() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let task = repo.create(sample()).unwrap();
    let started = repo.set_status(&task.id, TodoStatus::InProgress).unwrap();
    assert!(started.start_at.is_some());
    assert!(started.waiting_at.is_none());
    let waiting = repo.set_status(&task.id, TodoStatus::Waiting).unwrap();
    assert!(waiting.waiting_at.is_some());
    let back = repo.set_status(&task.id, TodoStatus::Pending).unwrap();
    assert!(back.waiting_at.is_none());
    // 完成清除加急，保留完成时间。
    let done = repo.set_status(&task.id, TodoStatus::Completed).unwrap();
    assert!(done.completed_at.is_some());
}

#[test]
fn archive_and_unarchive_keep_task_hidden_flag() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let task = repo.create(sample()).unwrap();
    let archived = repo.archive(&task.id).unwrap();
    assert!(archived.archived_at.is_some());
    let restored = repo.unarchive(&task.id).unwrap();
    assert!(restored.archived_at.is_none());
}

#[test]
fn reminder_state_machine_schedules_delivers_snoozes_and_cancels() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let task = repo.create(sample()).unwrap();
    let row = ReminderRow {
        instance_id: "i1".into(),
        task_id: task.id.clone(),
        revision: 0,
        original_at: "2026-09-07T08:00:00+08:00".into(),
        next_trigger_at: "2026-09-07T08:00:00+08:00".into(),
        status: "scheduled".into(),
        action: Some("notify".into()),
        delivered_at: None,
        handled_at: None,
    };
    repo.schedule_reminder(&row).unwrap();
    // 未到点不取。
    assert!(repo
        .due_reminders("2026-09-07T07:59:00+08:00")
        .unwrap()
        .is_empty());
    let due = repo
        .due_reminders("2026-09-07T08:00:00+08:00")
        .unwrap();
    assert_eq!(due.len(), 1);
    repo.mark_reminder_delivered("i1").unwrap();
    assert!(repo
        .due_reminders("2026-09-07T09:00:00+08:00")
        .unwrap()
        .is_empty());
    repo.snooze_reminder("i1", "2026-09-07T09:00:00+08:00", "snooze")
        .unwrap();
    assert_eq!(
        repo.due_reminders("2026-09-07T09:00:00+08:00").unwrap().len(),
        1
    );
    repo.cancel_reminder("i1").unwrap();
    assert!(repo
        .due_reminders("2026-09-07T10:00:00+08:00")
        .unwrap()
        .is_empty());
}

#[test]
fn v2_database_migrates_to_v3_columns_and_reminders_table() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("v2.sqlite");
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE todo_tasks (
                id TEXT PRIMARY KEY, customer_name TEXT NOT NULL DEFAULT '',
                title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL, received_at TEXT NOT NULL,
                due_at TEXT, urgent_at TEXT, completed_at TEXT,
                attachment_paths TEXT NOT NULL DEFAULT '[]',
                created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE app_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            PRAGMA user_version = 2;",
        )
        .unwrap();
    }
    let repo = TodoRepository::open(&path).unwrap();
    let version: i64 = repo
        .conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    // v2 → v3 → v4 一路迁移到位。
    assert_eq!(version, 4);
    let columns: Vec<String> = repo
        .conn
        .prepare("PRAGMA table_info(todo_tasks)")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for needed in ["category", "start_at", "waiting_at", "archived_at", "reminder_at", "reminder_revision"] {
        assert!(columns.iter().any(|c| c == needed), "missing {needed}");
    }
    let exists: i64 = repo
        .conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='todo_reminders'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(exists, 1);
}

#[test]
fn quiet_hours_match_overnight_and_same_day_windows() {
    // 跨夜 23:00 → 07:00。
    assert!(in_quiet_hours(23 * 60 + 30, 23 * 60, 7 * 60));
    assert!(in_quiet_hours(3 * 60, 23 * 60, 7 * 60));
    assert!(!in_quiet_hours(8 * 60, 23 * 60, 7 * 60));
    // 同日 09:00 → 17:00。
    assert!(in_quiet_hours(10 * 60, 9 * 60, 17 * 60));
    assert!(!in_quiet_hours(20 * 60, 9 * 60, 17 * 60));
    // 起止相同视为关闭。
    assert!(!in_quiet_hours(12 * 60, 12 * 60, 12 * 60));
}

#[test]
fn poll_delivers_enabled_reminder_and_marks_it_delivered() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    repo.update_settings(serde_json::json!({"taskReminderEnabled": true})).unwrap();
    let task = repo.create(sample()).unwrap();
    repo.schedule_reminder(&ReminderRow {
        instance_id: "i1".into(),
        task_id: task.id.clone(),
        revision: 0,
        original_at: "2026-09-07T08:00:00+08:00".into(),
        next_trigger_at: "2026-09-07T08:00:00+08:00".into(),
        status: "scheduled".into(),
        action: Some("notify".into()),
        delivered_at: None,
        handled_at: None,
    })
    .unwrap();
    let now = DateTime::parse_from_rfc3339("2026-09-07T08:00:00+08:00").unwrap();
    let dispatched = repo.poll_due_reminders(now).unwrap();
    assert_eq!(dispatched.len(), 1);
    assert_eq!(dispatched[0].task_id, task.id);
    assert_eq!(dispatched[0].title, "准备示例文档");
    // 再次轮询不重复投递。
    assert!(repo.poll_due_reminders(now).unwrap().is_empty());
}

#[test]
fn poll_defers_inside_quiet_hours_and_skips_when_disabled() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let task = repo.create(sample()).unwrap();
    let seed = |repo: &mut TodoRepository| {
        repo.schedule_reminder(&ReminderRow {
            instance_id: "i1".into(),
            task_id: task.id.clone(),
            revision: 0,
            original_at: "2026-09-07T23:30:00+08:00".into(),
            next_trigger_at: "2026-09-07T23:30:00+08:00".into(),
            status: "scheduled".into(),
            action: None,
            delivered_at: None,
            handled_at: None,
        })
        .unwrap();
    };
    // 默认关闭任务提醒：不投递。
    seed(&mut repo);
    let night = DateTime::parse_from_rfc3339("2026-09-07T23:30:00+08:00").unwrap();
    assert!(repo.poll_due_reminders(night).unwrap().is_empty());
    // 开启任务提醒但处于免打扰：顺延到 07:00，不投递。
    repo.update_settings(serde_json::json!({
        "taskReminderEnabled": true,
        "quietHoursEnabled": true,
        "quietHoursStart": "23:00",
        "quietHoursEnd": "07:00"
    }))
    .unwrap();
    let dispatched = repo.poll_due_reminders(night).unwrap();
    assert!(dispatched.is_empty());
    let row: String = repo
        .conn
        .query_row(
            "SELECT next_trigger_at FROM todo_reminders WHERE instance_id='i1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(row.starts_with("2026-09-08T07:00:00"));
}

#[test]
fn set_reminder_creates_and_cancels_instance_in_step() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let task = repo.create(sample()).unwrap();
    let set = repo
        .set_reminder(&task.id, Some("2026-09-09T10:00:00+08:00".into()))
        .unwrap();
    let scheduled: i64 = repo
        .conn
        .query_row(
            "SELECT COUNT(*) FROM todo_reminders WHERE task_id=?1 AND status='scheduled'",
            [&task.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(scheduled, 1);
    assert_eq!(set.reminder_revision, 1);
    // 清空提醒：旧实例作废，不再有 scheduled。
    repo.set_reminder(&task.id, None).unwrap();
    let open: i64 = repo
        .conn
        .query_row(
            "SELECT COUNT(*) FROM todo_reminders WHERE task_id=?1 AND status='scheduled'",
            [&task.id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(open, 0);
}

// ---- 团队同步（阶段二 M7）：task_sync 持久化 ----

fn remote_task(server_id: &str, title: &str, status: &str, updated_at: &str, rev: i64) -> crate::sync::SyncTask {
    crate::sync::SyncTask {
        server_id: Some(server_id.into()),
        title: title.into(),
        note: "远端备注".into(),
        customer_name: "远端客户".into(),
        status: status.into(),
        assignee: Some("m2".into()),
        owner: Some("m1".into()),
        due_at: None,
        updated_at: updated_at.into(),
        rev,
    }
}

fn build_v3_db(path: &std::path::Path) {
    let conn = rusqlite::Connection::open(path).unwrap();
    conn.execute_batch(
        "CREATE TABLE todo_tasks (
            id TEXT PRIMARY KEY, customer_name TEXT NOT NULL DEFAULT '',
            title TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL, received_at TEXT NOT NULL,
            due_at TEXT, urgent_at TEXT, completed_at TEXT,
            attachment_paths TEXT NOT NULL DEFAULT '[]',
            category TEXT, start_at TEXT, waiting_at TEXT, archived_at TEXT,
            reminder_at TEXT, reminder_revision INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE app_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE todo_reminders (
            instance_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0, original_at TEXT NOT NULL,
            next_trigger_at TEXT NOT NULL, status TEXT NOT NULL,
            delivered_at TEXT, handled_at TEXT, action TEXT
        );
        INSERT INTO todo_tasks (id, title, status, received_at, created_at, updated_at)
            VALUES ('local-1','旧任务','pending','2026-10-01T09:00:00+08:00',
                    '2026-10-01T09:00:00+08:00','2026-10-01T09:00:00+08:00');
        PRAGMA user_version = 3;",
    )
    .unwrap();
    drop(conn);
}

#[test]
fn v3_database_migrates_to_v4_task_sync_idempotently() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("v3.sqlite");
    build_v3_db(&path);
    let repo = TodoRepository::open(&path).unwrap();
    let version: i64 = repo
        .conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 4);
    let exists: i64 = repo
        .conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_sync'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(exists, 1);
    // 旧任务原样保留，不被迁移改动。
    let tasks = repo.list().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].title, "旧任务");
    drop(repo);
    // 重复打开幂等：不报错、不重复建表、数据仍在。
    let reopened = TodoRepository::open(&path).unwrap();
    assert_eq!(reopened.list().unwrap().len(), 1);
    let version: i64 = reopened
        .conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 4);
}

#[test]
fn fresh_database_contains_task_sync_table_at_version_4() {
    let repo = TodoRepository::open_in_memory().unwrap();
    let exists: i64 = repo
        .conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_sync'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(exists, 1);
    let version: i64 = repo
        .conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .unwrap();
    assert_eq!(version, 4);
}

#[test]
fn upsert_remote_deduplicates_by_server_id_and_updates_snapshot() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let first = repo
        .upsert_remote(&remote_task("s_1", "第一版", "pending", "2026-10-22T01:00:00Z", 1))
        .unwrap();
    assert_eq!(first.server_id.as_deref(), Some("s_1"));
    assert_eq!(first.sync_rev, 1);
    assert_eq!(first.owner.as_deref(), Some("m1"));
    assert_eq!(first.assignee.as_deref(), Some("m2"));
    let second = repo
        .upsert_remote(&remote_task("s_1", "第二版", "completed", "2026-10-22T03:00:00Z", 2))
        .unwrap();
    assert_eq!(second.id, first.id);
    let tasks = repo.list().unwrap();
    assert_eq!(tasks.len(), 1);
    assert_eq!(tasks[0].title, "第二版");
    assert_eq!(tasks[0].status, TodoStatus::Completed);
    assert_eq!(tasks[0].sync_rev, 2);
    assert!(tasks[0].completed_at.is_some());
}

#[test]
fn mark_remote_deleted_hides_task_and_tombstones_then_revives_on_newer_upsert() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let task = repo
        .upsert_remote(&remote_task("s_2", "待删除", "pending", "2026-10-22T01:00:00Z", 1))
        .unwrap();
    repo.mark_remote_deleted("s_2", "2026-10-22T04:00:00Z")
        .unwrap();
    assert!(repo.list().unwrap().is_empty());
    let tombstone: i64 = repo
        .conn
        .query_row(
            "SELECT remote_deleted FROM task_sync WHERE server_id='s_2'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(tombstone, 1);
    // 墓碑任务不再进入待上行队列。
    assert!(repo.pending_push_tasks().unwrap().is_empty());
    // 远端重新下发更新：复活并沿用本地行。
    let revived = repo
        .upsert_remote(&remote_task("s_2", "复活", "in_progress", "2026-10-22T05:00:00Z", 2))
        .unwrap();
    assert_eq!(revived.id, task.id);
    assert_eq!(repo.list().unwrap().len(), 1);
}

#[test]
fn bind_server_id_hydrates_server_id_and_rev_after_local_push() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let local = repo.create(sample()).unwrap();
    repo.bind_server_id(&local.id, "s_9", 3).unwrap();
    let tasks = repo.list().unwrap();
    assert_eq!(tasks[0].server_id.as_deref(), Some("s_9"));
    assert_eq!(tasks[0].sync_rev, 3);
    assert!(repo.bind_server_id("missing", "s_x", 1).is_err());
}

#[test]
fn set_assignee_and_set_owner_round_trip_and_can_clear() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let local = repo.create(sample()).unwrap();
    repo.set_owner(&local.id, Some("m1".into())).unwrap();
    repo.set_assignee(&local.id, Some("m2".into())).unwrap();
    let tasks = repo.list().unwrap();
    assert_eq!(tasks[0].owner.as_deref(), Some("m1"));
    assert_eq!(tasks[0].assignee.as_deref(), Some("m2"));
    repo.set_assignee(&local.id, None).unwrap();
    let tasks = repo.list().unwrap();
    assert!(tasks[0].assignee.is_none());
    assert_eq!(tasks[0].owner.as_deref(), Some("m1"));
    assert!(repo.set_assignee("missing", Some("m3".into())).is_err());
}

#[test]
fn sync_preferences_round_trip_and_default_when_absent() {
    let temp = tempfile::tempdir().unwrap();
    let path = temp.path().join("prefs.sqlite");
    {
        let mut repo = TodoRepository::open(&path).unwrap();
        assert_eq!(repo.sync_member_id().unwrap(), None);
        assert_eq!(repo.sync_last_rev().unwrap(), 0);
        assert!(!repo.sync_enabled().unwrap());
        assert_eq!(repo.sync_server_url().unwrap(), None);
        repo.set_sync_member_id(Some("m-123".into())).unwrap();
        repo.set_sync_last_rev(42).unwrap();
        repo.set_sync_enabled(true).unwrap();
        repo.set_sync_server_url(Some("https://todo.example.com".into())).unwrap();
        repo.set_sync_access_token(Some("tok".into())).unwrap();
        repo.set_sync_nickname(Some("小明".into())).unwrap();
    }
    let mut repo = TodoRepository::open(&path).unwrap();
    assert_eq!(repo.sync_member_id().unwrap().as_deref(), Some("m-123"));
    assert_eq!(repo.sync_last_rev().unwrap(), 42);
    assert!(repo.sync_enabled().unwrap());
    assert_eq!(repo.sync_server_url().unwrap().as_deref(), Some("https://todo.example.com"));
    assert_eq!(repo.sync_access_token().unwrap().as_deref(), Some("tok"));
    assert_eq!(repo.sync_nickname().unwrap().as_deref(), Some("小明"));
    repo.set_sync_access_token(None).unwrap();
    assert!(repo.sync_access_token().unwrap().is_none());
}

#[test]
fn pending_push_tasks_lists_unsynced_then_dirty_but_not_clean_or_remote() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let a = repo.create(sample()).unwrap();
    // 从未上行：待推。
    let pending = repo.pending_push_tasks().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, a.id);
    // 上行成功并回填快照：不再待推。
    repo.mark_pushed(&a.id, "s_a", 1, "2026-10-22T01:00:00Z")
        .unwrap();
    assert!(repo.pending_push_tasks().unwrap().is_empty());
    // 本地再改动：重新待推。
    let mut draft = sample();
    draft.title = "改过的标题".into();
    repo.update(&a.id, draft).unwrap();
    let pending = repo.pending_push_tasks().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, a.id);
    // 远端下行任务自带快照：不进入待上行队列。
    repo.upsert_remote(&remote_task("s_b", "远端任务", "pending", "2026-10-22T02:00:00Z", 1))
        .unwrap();
    let pending: Vec<String> = repo
        .pending_push_tasks()
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    assert_eq!(pending.len(), 1);
    assert!(pending.contains(&a.id));
}

#[test]
fn assignment_only_change_re_enters_push_queue_after_pushed() {
    let mut repo = TodoRepository::open_in_memory().unwrap();
    let a = repo.create(sample()).unwrap();
    repo.mark_pushed(&a.id, "s_a", 1, "2026-10-22T01:00:00Z")
        .unwrap();
    assert!(repo.pending_push_tasks().unwrap().is_empty());
    // 仅改指派、不动任务正文：local_dirty 标记让它重新进入上行队列。
    repo.set_assignee(&a.id, Some("m2".into())).unwrap();
    let pending = repo.pending_push_tasks().unwrap();
    assert_eq!(pending.len(), 1);
    assert_eq!(pending[0].id, a.id);
    assert_eq!(pending[0].assignee.as_deref(), Some("m2"));
    // 再次推送后清空。
    repo.mark_pushed(&a.id, "s_a", 2, "2026-10-22T02:00:00Z")
        .unwrap();
    assert!(repo.pending_push_tasks().unwrap().is_empty());
}
