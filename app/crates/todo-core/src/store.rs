use crate::models::{TodoDraft, TodoStatus, TodoTask};
use chrono::{DateTime, FixedOffset, NaiveTime, SecondsFormat, TimeDelta, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;
use std::time::Duration;

pub struct TodoRepository {
    conn: Connection,
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupRecord {
    pub task: TodoTask,
    pub created_at: String,
    pub deleted_at: Option<String>,
    pub version: i64,
}

/// 提醒实例状态机（对齐安装版 0.2.6 的 todo_reminders）：
/// scheduled → delivered → handled；snooze 回到 scheduled 并改 next_trigger_at；cancelled 终态。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderRow {
    pub instance_id: String,
    pub task_id: String,
    pub revision: i64,
    pub original_at: String,
    pub next_trigger_at: String,
    pub status: String,
    pub delivered_at: Option<String>,
    pub handled_at: Option<String>,
    pub action: Option<String>,
}

fn reminder_row(row: &Row<'_>) -> rusqlite::Result<ReminderRow> {
    Ok(ReminderRow {
        instance_id: row.get(0)?,
        task_id: row.get(1)?,
        revision: row.get(2)?,
        original_at: row.get(3)?,
        next_trigger_at: row.get(4)?,
        status: row.get(5)?,
        delivered_at: row.get(6)?,
        handled_at: row.get(7)?,
        action: row.get(8)?,
    })
}

/// 投递到外壳的一条提醒：外壳据此弹系统通知，不直接持有数据库句柄。
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReminderDispatch {
    pub instance_id: String,
    pub task_id: String,
    pub title: String,
    pub customer_name: String,
    pub original_at: String,
    pub action: Option<String>,
}

/// HH:mm 转当日分钟数；非法格式返回 None。
fn hhmm_minutes(text: &str) -> Option<i32> {
    let (hour, minute) = text.split_once(':')?;
    let hour: i32 = hour.trim().parse().ok()?;
    let minute: i32 = minute.trim().parse().ok()?;
    if (0..24).contains(&hour) && (0..60).contains(&minute) {
        Some(hour * 60 + minute)
    } else {
        None
    }
}

/// 免打扰区间支持跨夜：start>end 时（如 23:00→07:00）命中 now>=start 或 now<end。
fn in_quiet_hours(now_minutes: i32, start: i32, end: i32) -> bool {
    if start == end {
        return false;
    }
    if start < end {
        now_minutes >= start && now_minutes < end
    } else {
        now_minutes >= start || now_minutes < end
    }
}

pub fn validate_backup_records(records: &[BackupRecord]) -> Result<(), String> {
    let mut ids = std::collections::HashSet::new();
    if records.len() > 100_000 {
        return Err("备份任务数量超过限制".into());
    }
    for record in records {
        let task = &record.task;
        if uuid::Uuid::parse_str(&task.id).is_err() || !ids.insert(&task.id) || record.version < 1 {
            return Err("备份任务标识重复或无效".into());
        }
        validate(TodoDraft {
            customer_name: task.customer_name.clone(),
            title: task.title.clone(),
            note: task.note.clone(),
            received_at: task.received_at.clone(),
            due_at: task.due_at.clone(),
            attachment_paths: task.attachment_paths.clone(),
            category: task.category.clone(),
            reminder_at: task.reminder_at.clone(),
        })?;
        for date in [
            Some(&record.created_at),
            Some(&task.updated_at),
            record.deleted_at.as_ref(),
            task.completed_at.as_ref(),
            task.urgent_at.as_ref(),
            task.start_at.as_ref(),
            task.waiting_at.as_ref(),
            task.archived_at.as_ref(),
            task.reminder_at.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            DateTime::parse_from_rfc3339(date).map_err(|_| "备份中包含无效日期")?;
        }
    }
    Ok(())
}

const SELECT_TASK: &str = "SELECT id, customer_name, title, note, status, received_at,
    due_at, urgent_at, completed_at, attachment_paths, updated_at,
    category, start_at, waiting_at, archived_at, reminder_at, reminder_revision, created_at
    FROM todo_tasks";

fn storage_error(error: rusqlite::Error) -> String {
    format!("本地数据操作失败，请检查磁盘空间和目录权限：{error}")
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

/// v2 → v3：补齐任务扩展列、创建提醒实例表，幂等可重复执行。
fn ensure_v3(conn: &mut Connection) -> Result<(), String> {
    let existing: Vec<String> = conn
        .prepare("PRAGMA table_info(todo_tasks)")
        .map_err(storage_error)?
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(storage_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(storage_error)?;
    let additions = [
        ("category", "TEXT"),
        ("start_at", "TEXT"),
        ("waiting_at", "TEXT"),
        ("archived_at", "TEXT"),
        ("reminder_at", "TEXT"),
        ("reminder_revision", "INTEGER NOT NULL DEFAULT 0"),
    ];
    for (column, decl) in additions {
        if !existing.iter().any(|c| c == column) {
            conn.execute(
                &format!("ALTER TABLE todo_tasks ADD COLUMN {column} {decl}"),
                [],
            )
            .map_err(storage_error)?;
        }
    }
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS todo_reminders (
            instance_id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL,
            revision INTEGER NOT NULL DEFAULT 0,
            original_at TEXT NOT NULL,
            next_trigger_at TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('scheduled','delivered','handled','cancelled')),
            delivered_at TEXT, handled_at TEXT, action TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_reminder_due ON todo_reminders(status, next_trigger_at);
        PRAGMA user_version = 3;",
    )
    .map_err(storage_error)?;
    Ok(())
}

/// v3 → v4：新增 task_sync 同步元数据表（独立于 todo_tasks，不动既有任务列与备份格式），
/// 幂等可重复执行：表/索引存在即跳过，最后把 user_version 落到 4。
fn ensure_v4(conn: &mut Connection) -> Result<(), String> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS task_sync (
            task_id TEXT PRIMARY KEY,
            server_id TEXT,
            owner TEXT,
            assignee TEXT,
            sync_rev INTEGER NOT NULL DEFAULT 0,
            remote_updated_at TEXT,
            local_updated_at_at_push TEXT,
            pushed_version INTEGER NOT NULL DEFAULT 0,
            local_dirty INTEGER NOT NULL DEFAULT 1,
            remote_deleted INTEGER NOT NULL DEFAULT 0,
            remote_deleted_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_task_sync_server
            ON task_sync(server_id) WHERE server_id IS NOT NULL;
        PRAGMA user_version = 4;",
    )
    .map_err(storage_error)?;
    Ok(())
}

fn status_name(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Pending => "pending",
        TodoStatus::InProgress => "in_progress",
        TodoStatus::Waiting => "waiting",
        TodoStatus::Completed => "completed",
    }
}

fn read_task(row: &Row<'_>) -> rusqlite::Result<TodoTask> {
    let status: String = row.get(4)?;
    let status = match status.as_str() {
        "pending" => TodoStatus::Pending,
        "in_progress" => TodoStatus::InProgress,
        "waiting" => TodoStatus::Waiting,
        "completed" => TodoStatus::Completed,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let attachments: String = row.get(9)?;
    let attachment_paths = serde_json::from_str(&attachments).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(9, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(TodoTask {
        id: row.get(0)?,
        customer_name: row.get(1)?,
        title: row.get(2)?,
        note: row.get(3)?,
        status,
        received_at: row.get(5)?,
        due_at: row.get(6)?,
        urgent_at: row.get(7)?,
        completed_at: row.get(8)?,
        attachment_paths,
        updated_at: row.get(10)?,
        category: row.get(11)?,
        start_at: row.get(12)?,
        waiting_at: row.get(13)?,
        archived_at: row.get(14)?,
        reminder_at: row.get(15)?,
        reminder_revision: row.get(16)?,
        created_at: row.get(17)?,
        server_id: None,
        owner: None,
        assignee: None,
        sync_rev: 0,
    })
}

/// task_sync 元数据快照：水合进 TodoTask 的同步字段。
#[derive(Clone)]
struct SyncMeta {
    server_id: Option<String>,
    owner: Option<String>,
    assignee: Option<String>,
    sync_rev: i64,
}

fn load_sync_map(
    conn: &Connection,
) -> Result<std::collections::HashMap<String, SyncMeta>, String> {
    let mut map = std::collections::HashMap::new();
    let mut statement = conn
        .prepare(
            "SELECT task_id, server_id, owner, assignee, sync_rev FROM task_sync",
        )
        .map_err(storage_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                SyncMeta {
                    server_id: row.get(1)?,
                    owner: row.get(2)?,
                    assignee: row.get(3)?,
                    sync_rev: row.get(4)?,
                },
            ))
        })
        .map_err(storage_error)?;
    for row in rows {
        let (task_id, meta) = row.map_err(storage_error)?;
        map.insert(task_id, meta);
    }
    Ok(map)
}

fn apply_sync_meta(task: &mut TodoTask, meta: Option<&SyncMeta>) {
    if let Some(meta) = meta {
        task.server_id = meta.server_id.clone();
        task.owner = meta.owner.clone();
        task.assignee = meta.assignee.clone();
        task.sync_rev = meta.sync_rev;
    }
}

fn get_task(conn: &Connection, id: &str) -> Result<TodoTask, String> {
    let mut task = conn
        .query_row(
            &format!("{SELECT_TASK} WHERE id = ?1 AND deleted_at IS NULL"),
            [id],
            read_task,
        )
        .optional()
        .map_err(storage_error)?
        .ok_or_else(|| "这条待办不存在或已删除".to_string())?;
    let meta = load_sync_map(conn)?.remove(&task.id);
    apply_sync_meta(&mut task, meta.as_ref());
    Ok(task)
}

fn validate(mut draft: TodoDraft) -> Result<TodoDraft, String> {
    draft.customer_name = draft.customer_name.trim().to_string();
    draft.title = draft.title.trim().to_string();
    draft.note = draft.note.trim().to_string();
    if draft.title.is_empty() {
        return Err("请填写任务内容".into());
    }
    DateTime::parse_from_rfc3339(&draft.received_at)
        .map_err(|_| "接收日期无效，请重新选择".to_string())?;
    if let Some(date) = &draft.due_at {
        DateTime::parse_from_rfc3339(date)
            .map_err(|_| "完成日期无效，请重新选择或清空".to_string())?;
    }
    if let Some(reminder) = &draft.reminder_at {
        DateTime::parse_from_rfc3339(reminder)
            .map_err(|_| "提醒时间无效，请重新选择或清空".to_string())?;
    }
    draft.category = draft
        .category
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    Ok(draft)
}

impl TodoRepository {
    pub fn backup_records(&self) -> Result<Vec<BackupRecord>, String> {
        let columns = SELECT_TASK
            .strip_suffix(" FROM todo_tasks")
            .expect("task query has a fixed table");
        let mut statement = self
            .conn
            .prepare(&format!(
                "{columns}, created_at, deleted_at, version FROM todo_tasks"
            ))
            .map_err(storage_error)?;
        let result = statement
            .query_map([], |row| {
                Ok(BackupRecord {
                    task: read_task(row)?,
                    created_at: row.get(18)?,
                    deleted_at: row.get(19)?,
                    version: row.get(20)?,
                })
            })
            .map_err(storage_error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage_error)?;
        validate_backup_records(&result)?;
        Ok(result)
    }

    pub fn replace_backup_records(
        &mut self,
        records: &[BackupRecord],
        images: &std::collections::BTreeMap<String, String>,
    ) -> Result<(), String> {
        validate_backup_records(records)?;
        let tx = self.conn.transaction().map_err(storage_error)?;
        tx.execute("DELETE FROM todo_tasks", [])
            .map_err(storage_error)?;
        // 恢复会整体替换任务集合，清掉旧的同步绑定，避免孤儿 server_id 阻断重新上行。
        tx.execute("DELETE FROM task_sync", [])
            .map_err(storage_error)?;
        for record in records {
            let t = &record.task;
            let attachments = t
                .attachment_paths
                .iter()
                .map(|id| {
                    images
                        .get(id)
                        .cloned()
                        .ok_or_else(|| "备份缺少任务截图".to_string())
                })
                .collect::<Result<Vec<_>, _>>()?;
            let attachments = serde_json::to_string(&attachments).map_err(|e| e.to_string())?;
            tx.execute("INSERT INTO todo_tasks(id,customer_name,title,note,status,received_at,due_at,urgent_at,completed_at,attachment_paths,category,start_at,waiting_at,archived_at,reminder_at,reminder_revision,created_at,updated_at,deleted_at,version) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20)",
                params![t.id,t.customer_name,t.title,t.note,status_name(t.status),t.received_at,t.due_at,t.urgent_at,t.completed_at,attachments,t.category,t.start_at,t.waiting_at,t.archived_at,t.reminder_at,t.reminder_revision,record.created_at,t.updated_at,record.deleted_at,record.version]).map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)
    }

    /// 调用方持有存储锁；SQLite 在线备份包含 WAL 中已提交的事务。
    pub fn snapshot_to(&self, path: &Path) -> Result<(), String> {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .map_err(|error| format!("无法创建备份文件（不会覆盖已有文件）：{error}"))?;
        self.conn
            .backup(rusqlite::DatabaseName::Main, path, None)
            .map_err(storage_error)
    }

    pub fn attachment_ids(&self) -> Result<std::collections::BTreeSet<String>, String> {
        let mut statement = self
            .conn
            .prepare("SELECT attachment_paths FROM todo_tasks")
            .map_err(storage_error)?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(storage_error)?;
        let mut ids = std::collections::BTreeSet::new();
        for row in rows {
            let values: Vec<String> = serde_json::from_str(&row.map_err(storage_error)?)
                .map_err(|_| "截图记录损坏，操作已停止")?;
            ids.extend(values);
        }
        Ok(ids)
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        Self::from_connection(Connection::open(path).map_err(storage_error)?)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        Self::from_connection(Connection::open_in_memory().map_err(storage_error)?)
    }

    fn from_connection(mut conn: Connection) -> Result<Self, String> {
        conn.busy_timeout(Duration::from_secs(3))
            .map_err(storage_error)?;
        let version: i64 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .map_err(storage_error)?;
        if version > 4 {
            return Err("这份数据来自较新的 PomeTodo，请更新软件后打开".into());
        }
        if version == 0 {
            let tables: i64 = conn.query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
                [], |row| row.get(0),
            ).map_err(storage_error)?;
            if tables != 0 {
                return Err("无法识别这份数据库，已保留原文件，请通过数据导入处理".into());
            }
            let tx = conn.transaction().map_err(storage_error)?;
            tx.execute_batch(
                "CREATE TABLE todo_tasks (
                    id TEXT PRIMARY KEY,
                    customer_name TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL CHECK(length(trim(title)) > 0),
                    note TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL CHECK(status IN ('pending','in_progress','waiting','completed')),
                    received_at TEXT NOT NULL, due_at TEXT, urgent_at TEXT, completed_at TEXT,
                    attachment_paths TEXT NOT NULL DEFAULT '[]',
                    category TEXT, start_at TEXT, waiting_at TEXT, archived_at TEXT,
                    reminder_at TEXT, reminder_revision INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX idx_todo_visible ON todo_tasks(deleted_at, status, updated_at);
                CREATE TABLE app_preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE todo_reminders (
                    instance_id TEXT PRIMARY KEY,
                    task_id TEXT NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 0,
                    original_at TEXT NOT NULL,
                    next_trigger_at TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('scheduled','delivered','handled','cancelled')),
                    delivered_at TEXT, handled_at TEXT, action TEXT
                );
                CREATE INDEX idx_reminder_due ON todo_reminders(status, next_trigger_at);
                CREATE TABLE IF NOT EXISTS task_sync (
                    task_id TEXT PRIMARY KEY,
                    server_id TEXT,
                    owner TEXT,
                    assignee TEXT,
                    sync_rev INTEGER NOT NULL DEFAULT 0,
                    remote_updated_at TEXT,
                    local_updated_at_at_push TEXT,
                    pushed_version INTEGER NOT NULL DEFAULT 0,
                    local_dirty INTEGER NOT NULL DEFAULT 1,
                    remote_deleted INTEGER NOT NULL DEFAULT 0,
                    remote_deleted_at TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS idx_task_sync_server
                    ON task_sync(server_id) WHERE server_id IS NOT NULL;
                PRAGMA user_version = 3;",
            )
            .map_err(storage_error)?;
            tx.commit().map_err(storage_error)?;
        }
        if version == 1 {
            // 客户改选填：重建任务表去掉客户非空约束，数据与列顺序原样保留。
            let tx = conn.transaction().map_err(storage_error)?;
            tx.execute_batch(
                "CREATE TABLE todo_tasks_v2 (
                    id TEXT PRIMARY KEY,
                    customer_name TEXT NOT NULL DEFAULT '',
                    title TEXT NOT NULL CHECK(length(trim(title)) > 0),
                    note TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed')),
                    received_at TEXT NOT NULL, due_at TEXT, urgent_at TEXT, completed_at TEXT,
                    attachment_paths TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
                    deleted_at TEXT, version INTEGER NOT NULL DEFAULT 1
                );
                INSERT INTO todo_tasks_v2 SELECT id, customer_name, title, note, status, received_at, due_at, urgent_at, completed_at, attachment_paths, created_at, updated_at, deleted_at, version FROM todo_tasks;
                DROP TABLE todo_tasks;
                ALTER TABLE todo_tasks_v2 RENAME TO todo_tasks;
                CREATE INDEX idx_todo_visible ON todo_tasks(deleted_at, status, updated_at);
                PRAGMA user_version = 2;",
            )
            .map_err(storage_error)?;
            tx.commit().map_err(storage_error)?;
        }
        if version <= 2 {
            ensure_v3(&mut conn)?;
        }
        if version <= 3 {
            ensure_v4(&mut conn)?;
        }
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
        )
        .map_err(storage_error)?;
        // 启动时确认所需列可读；不能把损坏或不兼容结构当成空任务列表。
        conn.prepare(&format!("{SELECT_TASK} WHERE deleted_at IS NULL LIMIT 0"))
            .map_err(storage_error)?;
        Ok(Self { conn })
    }

    pub fn list(&self) -> Result<Vec<TodoTask>, String> {
        let mut stmt = self
            .conn
            .prepare(&format!(
                "{SELECT_TASK} WHERE deleted_at IS NULL ORDER BY updated_at DESC, id"
            ))
            .map_err(storage_error)?;
        let mut tasks = stmt
            .query_map([], read_task)
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        let meta = load_sync_map(&self.conn)?;
        for task in &mut tasks {
            let snapshot = meta.get(&task.id).cloned();
            apply_sync_meta(&mut *task, snapshot.as_ref());
        }
        Ok(tasks)
    }

    pub fn create(&mut self, draft: TodoDraft) -> Result<TodoTask, String> {
        let draft = validate(draft)?;
        let attachments =
            serde_json::to_string(&draft.attachment_paths).map_err(|error| error.to_string())?;
        let id = uuid::Uuid::new_v4().to_string();
        let timestamp = now();
        let tx = self.conn.transaction().map_err(storage_error)?;
        tx.execute(
            "INSERT INTO todo_tasks (id, customer_name, title, note, status, received_at, due_at,
                attachment_paths, category, reminder_at, created_at, updated_at)
             VALUES (?1,?2,?3,?4,'pending',?5,?6,?7,?8,?9,?10,?10)",
            params![id, draft.customer_name, draft.title, draft.note, draft.received_at, draft.due_at, attachments, draft.category, draft.reminder_at, timestamp],
        ).map_err(storage_error)?;
        let result = get_task(&tx, &id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn update(&mut self, id: &str, draft: TodoDraft) -> Result<TodoTask, String> {
        let draft = validate(draft)?;
        let attachments =
            serde_json::to_string(&draft.attachment_paths).map_err(|error| error.to_string())?;
        let tx = self.conn.transaction().map_err(storage_error)?;
        tx.execute(
            "UPDATE todo_tasks SET customer_name=?2, title=?3, note=?4, received_at=?5, due_at=?6,
                attachment_paths=?7, category=?8, reminder_at=?9, updated_at=?10, version=version+1
             WHERE id=?1 AND deleted_at IS NULL",
            params![id, draft.customer_name, draft.title, draft.note, draft.received_at, draft.due_at, attachments, draft.category, draft.reminder_at, now()],
        ).map_err(storage_error)?;
        let result = get_task(&tx, id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn set_status(&mut self, id: &str, status: TodoStatus) -> Result<TodoTask, String> {
        let tx = self.conn.transaction().map_err(storage_error)?;
        let existing = get_task(&tx, id)?;
        if existing.status == status {
            return Ok(existing);
        }
        let timestamp = now();
        let completed_at = (status == TodoStatus::Completed).then_some(timestamp.clone());
        tx.execute(
            "UPDATE todo_tasks SET status=?2, completed_at=?3,
                start_at=CASE WHEN ?2='in_progress' THEN COALESCE(start_at, ?4) ELSE start_at END,
                waiting_at=CASE WHEN ?2='waiting' THEN ?4 ELSE NULL END,
                urgent_at=CASE WHEN ?2='completed' THEN NULL ELSE urgent_at END,
                updated_at=?4, version=version+1 WHERE id=?1 AND deleted_at IS NULL",
            params![id, status_name(status), completed_at, timestamp],
        )
        .map_err(storage_error)?;
        let result = get_task(&tx, id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn set_urgent(&mut self, id: &str, urgent: bool) -> Result<TodoTask, String> {
        let tx = self.conn.transaction().map_err(storage_error)?;
        let task = get_task(&tx, id)?;
        if urgent && task.status == TodoStatus::Completed {
            return Err("已完成的待办无需加急".into());
        }
        let timestamp = now();
        let urgent_at = urgent.then_some(timestamp.clone());
        tx.execute(
            "UPDATE todo_tasks SET urgent_at=?2, updated_at=?3, version=version+1 WHERE id=?1 AND deleted_at IS NULL",
            params![id, urgent_at, timestamp],
        ).map_err(storage_error)?;
        let result = get_task(&tx, id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn delete(&mut self, id: &str) -> Result<(), String> {
        self.conn.execute(
            "UPDATE todo_tasks SET deleted_at=?2, updated_at=?2, version=version+1 WHERE id=?1 AND deleted_at IS NULL",
            params![id, now()],
        ).map_err(storage_error)?;
        Ok(())
    }

    /// 归档已完成任务（仅记录归档时间，不删除）。
    pub fn archive(&mut self, id: &str) -> Result<TodoTask, String> {
        let tx = self.conn.transaction().map_err(storage_error)?;
        get_task(&tx, id)?;
        let timestamp = now();
        tx.execute(
            "UPDATE todo_tasks SET archived_at=?2, updated_at=?3, version=version+1
             WHERE id=?1 AND deleted_at IS NULL",
            params![id, timestamp, now()],
        )
        .map_err(storage_error)?;
        let result = get_task(&tx, id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn unarchive(&mut self, id: &str) -> Result<TodoTask, String> {
        let tx = self.conn.transaction().map_err(storage_error)?;
        get_task(&tx, id)?;
        tx.execute(
            "UPDATE todo_tasks SET archived_at=NULL, updated_at=?2, version=version+1 WHERE id=?1 AND deleted_at IS NULL",
            params![id, now()],
        )
        .map_err(storage_error)?;
        let result = get_task(&tx, id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    /// 设置/清除任务提醒时间；每次修改递增 reminder_revision，供投递层作废旧实例。
    pub fn set_reminder(
        &mut self,
        id: &str,
        reminder_at: Option<String>,
    ) -> Result<TodoTask, String> {
        if let Some(reminder) = &reminder_at {
            DateTime::parse_from_rfc3339(reminder)
                .map_err(|_| "提醒时间无效，请重新选择或清空".to_string())?;
        }
        let tx = self.conn.transaction().map_err(storage_error)?;
        get_task(&tx, id)?;
        tx.execute(
            "UPDATE todo_tasks SET reminder_at=?2, reminder_revision=reminder_revision+1,
                updated_at=?3, version=version+1 WHERE id=?1 AND deleted_at IS NULL",
            params![id, reminder_at, now()],
        )
        .map_err(storage_error)?;
        let result = get_task(&tx, id)?;
        // 同步提醒实例：先作废该任务所有未终结实例，再按新时间建立 scheduled。
        tx.execute(
            "UPDATE todo_reminders SET status='cancelled', handled_at=?2
             WHERE task_id=?1 AND status IN ('scheduled','delivered')",
            params![id, now()],
        )
        .map_err(storage_error)?;
        if let Some(at) = &result.reminder_at {
            let instance_id = format!("{}:{}", result.id, result.reminder_revision);
            tx.execute(
                "INSERT INTO todo_reminders
                    (instance_id, task_id, revision, original_at, next_trigger_at, status,
                     delivered_at, handled_at, action)
                 VALUES (?1,?2,?3,?4,?5,'scheduled',NULL,NULL,'notify')",
                params![instance_id, result.id, result.reminder_revision, at, at],
            )
            .map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    /// 列出到点且仍处于 scheduled 的提醒实例，供投递引擎取出。
    pub fn due_reminders(&self, now: &str) -> Result<Vec<ReminderRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT instance_id, task_id, revision, original_at, next_trigger_at,
                    status, delivered_at, handled_at, action
                 FROM todo_reminders
                 WHERE status='scheduled' AND next_trigger_at<=?1
                 ORDER BY next_trigger_at",
            )
            .map_err(storage_error)?;
        let rows = stmt
            .query_map([now], reminder_row)
            .map_err(storage_error)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(storage_error)
    }

    pub fn schedule_reminder(&mut self, row: &ReminderRow) -> Result<(), String> {
        self.conn.execute(
            "INSERT INTO todo_reminders
                (instance_id, task_id, revision, original_at, next_trigger_at, status,
                 delivered_at, handled_at, action)
             VALUES (?1,?2,?3,?4,?5,'scheduled',NULL,NULL,?6)",
            params![row.instance_id, row.task_id, row.revision, row.original_at, row.next_trigger_at, row.action],
        ).map_err(storage_error)?;
        Ok(())
    }

    pub fn mark_reminder_delivered(&mut self, instance_id: &str) -> Result<(), String> {
        self.conn.execute(
            "UPDATE todo_reminders SET status='delivered', delivered_at=?2
             WHERE instance_id=?1 AND status='scheduled'",
            params![instance_id, now()],
        ).map_err(storage_error)?;
        Ok(())
    }

    /// 稍后提醒：从 delivered 回到 scheduled，改下次触发时间，action 记录为 snooze。
    pub fn snooze_reminder(
        &mut self,
        instance_id: &str,
        next_trigger_at: &str,
        action: &str,
    ) -> Result<(), String> {
        self.conn.execute(
            "UPDATE todo_reminders SET status='scheduled', next_trigger_at=?2,
                action=?3, delivered_at=NULL WHERE instance_id=?1 AND status='delivered'",
            params![instance_id, next_trigger_at, action],
        ).map_err(storage_error)?;
        Ok(())
    }

    pub fn cancel_reminder(&mut self, instance_id: &str) -> Result<(), String> {
        self.conn.execute(
            "UPDATE todo_reminders SET status='cancelled', handled_at=?2
             WHERE instance_id=?1 AND status!='cancelled'",
            params![instance_id, now()],
        ).map_err(storage_error)?;
        Ok(())
    }

    /// 改期一个仍在 scheduled 的实例（免打扰延后、手动改期共用）。
    pub fn reschedule_reminder(
        &mut self,
        instance_id: &str,
        next_trigger_at: &str,
        action: Option<&str>,
    ) -> Result<(), String> {
        self.conn.execute(
            "UPDATE todo_reminders SET next_trigger_at=?2, action=?3
             WHERE instance_id=?1 AND status='scheduled'",
            params![instance_id, next_trigger_at, action],
        ).map_err(storage_error)?;
        Ok(())
    }

    /// 由外壳定时调用：取出到点提醒；免打扰时段不打扰，顺延到免打扰结束。
    /// 返回需要投递的条目，调用方（外壳）负责弹系统通知，随后可 snooze/cancel。
    pub fn poll_due_reminders(
        &mut self,
        now: DateTime<FixedOffset>,
    ) -> Result<Vec<ReminderDispatch>, String> {
        let settings = self.settings()?;
        if !settings.task_reminder_enabled {
            return Ok(Vec::new());
        }
        let due = self.due_reminders(&now.to_rfc3339())?;
        let mut out = Vec::new();
        let now_minutes = hhmm_minutes(&now.format("%H:%M").to_string()).unwrap_or(0);
        for row in due {
            let mut deferred = false;
            if settings.quiet_hours_enabled {
                if let (Some(start), Some(end)) = (
                    hhmm_minutes(&settings.quiet_hours_start),
                    hhmm_minutes(&settings.quiet_hours_end),
                ) {
                    if in_quiet_hours(now_minutes, start, end) {
                        if let Some(wake) = NaiveTime::parse_from_str(&settings.quiet_hours_end, "%H:%M")
                        .ok()
                        .map(|time| now.date_naive().and_time(time))
                        .and_then(|candidate| candidate.and_local_timezone(*now.offset()).single())
                    {
                        let wake = if wake <= now {
                            wake + TimeDelta::days(1)
                        } else {
                            wake
                        };
                        self.reschedule_reminder(&row.instance_id, &wake.to_rfc3339(), Some("quiet"))?;
                        deferred = true;
                    }
                    }
                }
            }
            if deferred {
                continue;
            }
            self.mark_reminder_delivered(&row.instance_id)?;
            let task = get_task(&self.conn, &row.task_id)?;
            out.push(ReminderDispatch {
                instance_id: row.instance_id,
                task_id: row.task_id,
                title: task.title,
                customer_name: task.customer_name,
                original_at: row.original_at,
                action: row.action,
            });
        }
        Ok(out)
    }

    pub fn theme(&self) -> Result<String, String> {
        Ok(self
            .conn
            .query_row(
                "SELECT value FROM app_preferences WHERE key='theme'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?
            .unwrap_or_else(|| "system".into()))
    }

    pub(crate) fn read_preference(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT value FROM app_preferences WHERE key=?1",
                [key],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)
    }

    pub(crate) fn save_preferences(&mut self, values: &[(&str, &str)]) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(storage_error)?;
        for (key, value) in values {
            tx.execute("INSERT INTO app_preferences(key,value) VALUES (?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key,value]).map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)
    }

    pub fn set_theme(&mut self, theme: &str) -> Result<(), String> {
        if !matches!(theme, "light" | "dark" | "system") {
            return Err("不支持的主题选项".into());
        }
        self.conn.execute(
            "INSERT INTO app_preferences(key,value) VALUES ('theme',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [theme],
        ).map_err(storage_error)?;
        Ok(())
    }

    // ---- 团队同步（阶段二）：task_sync 元数据与上行/下行原语 ----

    /// 远端状态字符串映射本地状态机；未知值回落 pending。
    fn remote_status(status: &str) -> TodoStatus {
        match status {
            "in_progress" => TodoStatus::InProgress,
            "waiting" => TodoStatus::Waiting,
            "completed" => TodoStatus::Completed,
            _ => TodoStatus::Pending,
        }
    }

    /// 按 server_id 落地远端快照：绕过本地标题非空等校验；本地无此任务则新建，
    /// 已存在则覆盖快照并复活（远端重新下发视为最新）。返回水合后的本地任务。
    pub fn upsert_remote(&mut self, task: &crate::sync::SyncTask) -> Result<TodoTask, String> {
        let server_id = task
            .server_id
            .clone()
            .ok_or_else(|| "远端任务缺少 serverId".to_string())?;
        let status = Self::remote_status(&task.status);
        let completed_at = (status == TodoStatus::Completed).then(|| task.updated_at.clone());
        let tx = self.conn.transaction().map_err(storage_error)?;
        let existing: Option<String> = tx
            .query_row(
                "SELECT task_id FROM task_sync WHERE server_id=?1",
                [&server_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        let local_id = match existing {
            Some(local_id) => {
                tx.execute(
                    "UPDATE todo_tasks SET title=?2, note=?3, customer_name=?4, status=?5,
                        due_at=?6, completed_at=?7, urgent_at=NULL,
                        deleted_at=NULL, updated_at=?8, version=version+1
                     WHERE id=?1",
                    params![local_id, task.title.trim(), task.note.trim(), task.customer_name.trim(),
                        status_name(status), task.due_at, completed_at, task.updated_at],
                )
                .map_err(storage_error)?;
                local_id
            }
            None => {
                let local_id = uuid::Uuid::new_v4().to_string();
                let received_at = DateTime::parse_from_rfc3339(&task.updated_at)
                    .map(|_| task.updated_at.clone())
                    .unwrap_or_else(|_| now());
                tx.execute(
                    "INSERT INTO todo_tasks (id, customer_name, title, note, status, received_at,
                        due_at, completed_at, attachment_paths, created_at, updated_at)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'[]',?6,?6)",
                    params![local_id, task.customer_name.trim(), task.title.trim(), task.note.trim(),
                        status_name(status), received_at, task.due_at, completed_at],
                )
                .map_err(storage_error)?;
                local_id
            }
        };
        let local_version: i64 = tx
            .query_row(
                "SELECT version FROM todo_tasks WHERE id=?1",
                [&local_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        tx.execute(
            "INSERT INTO task_sync (task_id, server_id, owner, assignee, sync_rev,
                remote_updated_at, local_updated_at_at_push, pushed_version, local_dirty,
                remote_deleted, remote_deleted_at)
             VALUES (?1,?2,?3,?4,?5,?6,?6,?7,0,0,NULL)
             ON CONFLICT(task_id) DO UPDATE SET
                server_id=excluded.server_id, owner=excluded.owner, assignee=excluded.assignee,
                sync_rev=excluded.sync_rev, remote_updated_at=excluded.remote_updated_at,
                local_updated_at_at_push=excluded.local_updated_at_at_push,
                pushed_version=excluded.pushed_version, local_dirty=0,
                remote_deleted=0, remote_deleted_at=NULL",
            params![local_id, server_id, task.owner, task.assignee, task.rev, task.updated_at, local_version],
        )
        .map_err(storage_error)?;
        let result = get_task(&tx, &local_id)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    /// 远端墓碑：按 server_id 软删本地行，并在 task_sync 记录已删除，避免重复拉起。
    pub fn mark_remote_deleted(&mut self, server_id: &str, updated_at: &str) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(storage_error)?;
        let local_id: Option<String> = tx
            .query_row(
                "SELECT task_id FROM task_sync WHERE server_id=?1",
                [server_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some(local_id) = local_id {
            tx.execute(
                "UPDATE todo_tasks SET deleted_at=?2, updated_at=?2, version=version+1 WHERE id=?1",
                params![local_id, updated_at],
            )
            .map_err(storage_error)?;
            tx.execute(
                "UPDATE task_sync SET remote_deleted=1, remote_deleted_at=?2, remote_updated_at=?2
                 WHERE task_id=?1",
                params![local_id, updated_at],
            )
            .map_err(storage_error)?;
        }
        tx.commit().map_err(storage_error)
    }

    /// 本地任务首次上行成功后回填 server_id 与 rev；快照取本地当前 updated_at 与 version。
    pub fn bind_server_id(&mut self, local_id: &str, server_id: &str, rev: i64) -> Result<(), String> {
        let (local_updated, local_version): (String, i64) = self
            .conn
            .query_row(
                "SELECT updated_at, version FROM todo_tasks WHERE id=?1",
                [local_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| "本地任务不存在，无法绑定服务端标识".to_string())?;
        self.conn.execute(
            "INSERT INTO task_sync (task_id, server_id, sync_rev, local_updated_at_at_push,
                pushed_version, local_dirty, remote_deleted)
             VALUES (?1,?2,?3,?4,?5,0,0)
             ON CONFLICT(task_id) DO UPDATE SET
                server_id=excluded.server_id, sync_rev=excluded.sync_rev,
                local_updated_at_at_push=excluded.local_updated_at_at_push,
                pushed_version=excluded.pushed_version, local_dirty=0, remote_deleted=0",
            params![local_id, server_id, rev, local_updated, local_version],
        )
        .map_err(storage_error)?;
        Ok(())
    }

    /// 写入被指派人成员 ID（写 task_sync，不动 todo_tasks 既有列）。
    pub fn set_assignee(&mut self, local_id: &str, assignee: Option<String>) -> Result<(), String> {
        self.upsert_sync_field(local_id, "assignee", assignee)
    }

    /// 写入创建者成员 ID（写 task_sync，不动 todo_tasks 既有列）。
    pub fn set_owner(&mut self, local_id: &str, owner: Option<String>) -> Result<(), String> {
        self.upsert_sync_field(local_id, "owner", owner)
    }

    fn upsert_sync_field(
        &mut self,
        local_id: &str,
        column: &str,
        value: Option<String>,
    ) -> Result<(), String> {
        let exists: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM todo_tasks WHERE id=?1",
                [local_id],
                |row| row.get(0),
            )
            .map_err(storage_error)?;
        if exists == 0 {
            return Err("本地任务不存在，无法同步指派".to_string());
        }
        let value = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        self.conn.execute(
            &format!(
                "INSERT INTO task_sync (task_id, {column}, local_dirty) VALUES (?1,?2,1)
                 ON CONFLICT(task_id) DO UPDATE SET
                    {column}=excluded.{column}, local_dirty=1"
            ),
            params![local_id, value],
        )
        .map_err(storage_error)?;
        Ok(())
    }

    /// 枚举待上行任务：从未建立 task_sync 行，或本地 version/updated_at 新于最后推送快照；
    /// 远端已墓碑的任务不再上行。version 单调递增作为主判据，避免同毫秒时间戳漏判。
    pub fn pending_push_tasks(&self) -> Result<Vec<TodoTask>, String> {
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.customer_name, t.title, t.note, t.status, t.received_at,
                t.due_at, t.urgent_at, t.completed_at, t.attachment_paths, t.updated_at,
                t.category, t.start_at, t.waiting_at, t.archived_at, t.reminder_at,
                t.reminder_revision, t.created_at
             FROM todo_tasks t
             LEFT JOIN task_sync s ON s.task_id = t.id
             WHERE t.deleted_at IS NULL
               AND COALESCE(s.remote_deleted, 0) = 0
               AND (
                    s.task_id IS NULL
                    OR COALESCE(s.local_dirty, 0) = 1
                    OR t.version > COALESCE(s.pushed_version, 0)
                    OR t.updated_at > COALESCE(s.local_updated_at_at_push, '')
               )",
        )
        .map_err(storage_error)?;
        let mut tasks = stmt
            .query_map([], read_task)
            .map_err(storage_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(storage_error)?;
        let meta = load_sync_map(&self.conn)?;
        for task in &mut tasks {
            let snapshot = meta.get(&task.id).cloned();
            apply_sync_meta(&mut *task, snapshot.as_ref());
        }
        Ok(tasks)
    }

    /// 上行成功后回填 server_id/rev/远端 updated_at，并把本地快照刷新为本次推送的 updated_at。
    pub fn mark_pushed(
        &mut self,
        local_id: &str,
        server_id: &str,
        rev: i64,
        updated_at: &str,
    ) -> Result<(), String> {
        let (local_updated, local_version): (String, i64) = self
            .conn
            .query_row(
                "SELECT updated_at, version FROM todo_tasks WHERE id=?1",
                [local_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?
            .ok_or_else(|| "本地任务不存在，无法标记已推送".to_string())?;
        self.conn.execute(
            "INSERT INTO task_sync (task_id, server_id, sync_rev, remote_updated_at,
                local_updated_at_at_push, pushed_version, local_dirty, remote_deleted)
             VALUES (?1,?2,?3,?4,?5,?6,0,0)
             ON CONFLICT(task_id) DO UPDATE SET
                server_id=excluded.server_id, sync_rev=excluded.sync_rev,
                remote_updated_at=excluded.remote_updated_at,
                local_updated_at_at_push=excluded.local_updated_at_at_push,
                pushed_version=excluded.pushed_version, local_dirty=0, remote_deleted=0",
            params![local_id, server_id, rev, updated_at, local_updated, local_version],
        )
        .map_err(storage_error)?;
        Ok(())
    }

    // ---- 团队同步偏好（app_preferences 键值存取）----

    fn opt_preference(&self, key: &str) -> Result<Option<String>, String> {
        Ok(self.read_preference(key)?.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        }))
    }

    fn set_opt_preference(&mut self, key: &str, value: Option<String>) -> Result<(), String> {
        let value = value
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        self.save_preferences(&[(key, value.as_deref().unwrap_or(""))])
    }

    pub fn sync_member_id(&self) -> Result<Option<String>, String> {
        self.opt_preference("sync.memberId")
    }

    pub fn set_sync_member_id(&mut self, value: Option<String>) -> Result<(), String> {
        self.set_opt_preference("sync.memberId", value)
    }

    pub fn sync_last_rev(&self) -> Result<i64, String> {
        Ok(self
            .read_preference("sync.lastRev")?
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or(0))
    }

    pub fn set_sync_last_rev(&mut self, rev: i64) -> Result<(), String> {
        self.save_preferences(&[("sync.lastRev", &rev.to_string())])
    }

    pub fn sync_enabled(&self) -> Result<bool, String> {
        Ok(self
            .read_preference("sync.enabled")?
            .map(|value| value.eq_ignore_ascii_case("true"))
            .unwrap_or(false))
    }

    pub fn set_sync_enabled(&mut self, enabled: bool) -> Result<(), String> {
        self.save_preferences(&[("sync.enabled", if enabled { "true" } else { "false" })])
    }

    pub fn sync_server_url(&self) -> Result<Option<String>, String> {
        self.opt_preference("sync.serverUrl")
    }

    pub fn set_sync_server_url(&mut self, value: Option<String>) -> Result<(), String> {
        self.set_opt_preference("sync.serverUrl", value)
    }

    pub fn sync_access_token(&self) -> Result<Option<String>, String> {
        self.opt_preference("sync.accessToken")
    }

    pub fn set_sync_access_token(&mut self, value: Option<String>) -> Result<(), String> {
        self.set_opt_preference("sync.accessToken", value)
    }

    pub fn sync_nickname(&self) -> Result<Option<String>, String> {
        self.opt_preference("sync.nickname")
    }

    pub fn set_sync_nickname(&mut self, value: Option<String>) -> Result<(), String> {
        self.set_opt_preference("sync.nickname", value)
    }
}

#[cfg(test)]
mod tests;
