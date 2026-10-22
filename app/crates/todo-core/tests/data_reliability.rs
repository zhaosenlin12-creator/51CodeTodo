use pometodo_core::{
    backup::{export_backup, import_backup, prepare_backup},
    local::LocalStorage,
    models::{TodoDraft, TodoStatus},
    store::BackupRecord,
};
use std::{collections::BTreeMap, fs, io::Write, path::Path, process::Command};

const PNG_ONE: &[u8] = b"\x89PNG\r\n\x1a\nsynthetic-first-attachment";
const PNG_TWO: &[u8] = b"\x89PNG\r\n\x1a\nsynthetic-second-attachment";

fn draft(title: &str, attachment_paths: Vec<String>) -> TodoDraft {
    TodoDraft {
        customer_name: "隔离验收客户".into(),
        title: title.into(),
        note: "虚构内容\n第二行与 emoji 🍊".into(),
        received_at: "2026-09-06T09:30:00+08:00".into(),
        due_at: Some("2026-09-08T18:00:00+08:00".into()),
        attachment_paths,
        category: None,
        reminder_at: None,
    }
}

fn records(storage: &LocalStorage) -> serde_json::Value {
    serde_json::to_value(storage.repo.backup_records().unwrap()).unwrap()
}

fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
    let mut zip = zip::ZipWriter::new(fs::File::create(path).unwrap());
    for (name, bytes) in files {
        zip.start_file(*name, zip::write::SimpleFileOptions::default())
            .unwrap();
        zip.write_all(bytes).unwrap();
    }
    zip.finish().unwrap();
}

#[test]
fn restore_preserves_all_fields_shared_images_and_deleted_metadata_after_reopen() {
    let tmp = tempfile::tempdir().unwrap();
    let source_profile = tmp.path().join("source");
    let target_profile = tmp.path().join("target");
    let mut source = LocalStorage::open(&source_profile).unwrap();
    let one = source
        .attachment_store()
        .unwrap()
        .save_png(PNG_ONE)
        .unwrap();
    let two = source
        .attachment_store()
        .unwrap()
        .save_png(PNG_TWO)
        .unwrap();
    let pending = source
        .repo
        .create(draft("待处理", vec![one.clone(), two.clone(), one.clone()]))
        .unwrap();
    source.repo.set_urgent(&pending.id, true).unwrap();
    let active = source
        .repo
        .create(draft("进行中", vec![two.clone()]))
        .unwrap();
    source
        .repo
        .set_status(&active.id, TodoStatus::InProgress)
        .unwrap();
    let done = source
        .repo
        .create(draft("已完成", vec![one.clone()]))
        .unwrap();
    source
        .repo
        .set_status(&done.id, TodoStatus::Completed)
        .unwrap();
    let mut no_due = draft("已删除且无交付日期", vec![two.clone()]);
    no_due.due_at = None;
    let deleted = source.repo.create(no_due).unwrap();
    source.repo.delete(&deleted.id).unwrap();
    let expected = source.repo.backup_records().unwrap();
    let archive = tmp.path().join("roundtrip.zip");
    export_backup(&source, &archive).unwrap();
    let prepared = prepare_backup(&archive).unwrap();
    assert_eq!(prepared.task_count(), 3);
    assert_eq!(prepared.attachment_count(), 2);

    let mut target = LocalStorage::open(&target_profile).unwrap();
    target.repo.create(draft("恢复前原任务", vec![])).unwrap();
    target.repo.set_theme("dark").unwrap();
    let before = records(&target);
    let safety = import_backup(&mut target, prepared).unwrap();
    drop(target);
    let target = LocalStorage::open(&target_profile).unwrap();
    assert_eq!(target.repo.theme().unwrap(), "dark");
    let restored = target.repo.backup_records().unwrap();
    assert_eq!(restored.len(), expected.len());
    assert_eq!(target.repo.list().unwrap().len(), 3);
    let mut mapped = BTreeMap::new();
    for original in expected {
        let actual = restored
            .iter()
            .find(|r| r.task.id == original.task.id)
            .unwrap();
        assert_eq!(
            actual.task.attachment_paths.len(),
            original.task.attachment_paths.len()
        );
        let mut normalized: BackupRecord = actual.clone();
        for (old_id, new_id) in original
            .task
            .attachment_paths
            .iter()
            .zip(&actual.task.attachment_paths)
        {
            assert_ne!(old_id, new_id);
            if let Some(previous) = mapped.insert(old_id.clone(), new_id.clone()) {
                assert_eq!(previous, *new_id, "共享附件必须映射到同一新文件");
            }
            let original_bytes = source.attachment_store().unwrap().read_png(old_id).unwrap();
            assert_eq!(
                target.attachment_store().unwrap().read_png(new_id).unwrap(),
                original_bytes
            );
        }
        normalized.task.attachment_paths = original.task.attachment_paths.clone();
        assert_eq!(
            serde_json::to_value(normalized).unwrap(),
            serde_json::to_value(original).unwrap()
        );
    }
    assert_eq!(mapped.len(), 2);
    assert_ne!(mapped[&one], mapped[&two]);
    // 导入前副本不仅存在，还能实际恢复到另一份隔离存储。
    let mut recovery = LocalStorage::open(&tmp.path().join("recovery")).unwrap();
    import_backup(&mut recovery, prepare_backup(&safety).unwrap()).unwrap();
    assert_eq!(records(&recovery), before);
}

#[test]
fn missing_or_corrupt_backup_images_are_rejected_without_changing_current_records() {
    let tmp = tempfile::tempdir().unwrap();
    let mut storage = LocalStorage::open(&tmp.path().join("profile")).unwrap();
    let id = storage
        .attachment_store()
        .unwrap()
        .save_png(PNG_ONE)
        .unwrap();
    storage
        .repo
        .create(draft("原任务", vec![id.clone()]))
        .unwrap();
    let before = records(&storage);
    let manifest = serde_json::to_vec(&serde_json::json!({
        "format": "pometodo-backup", "version": 1,
        "tasks": storage.repo.backup_records().unwrap()
    }))
    .unwrap();
    let missing = tmp.path().join("missing.zip");
    write_zip(&missing, &[("tasks.json", &manifest)]);
    let error = prepare_backup(&missing).err().unwrap();
    assert!(error.contains("缺少任务引用的截图"), "{error}");
    let corrupt = tmp.path().join("corrupt.zip");
    let image_name = format!("screenshots/{id}");
    write_zip(
        &corrupt,
        &[("tasks.json", &manifest), (&image_name, b"not-png")],
    );
    assert!(prepare_backup(&corrupt).is_err());
    assert_eq!(records(&storage), before);
    assert_eq!(
        storage.attachment_store().unwrap().read_png(&id).unwrap(),
        PNG_ONE
    );
    assert!(!storage.profile_directory.join("backups").exists());
}

#[test]
fn missing_source_image_does_not_publish_an_incomplete_export() {
    let tmp = tempfile::tempdir().unwrap();
    let mut storage = LocalStorage::open(&tmp.path().join("profile")).unwrap();
    let missing = format!("{}.png", uuid::Uuid::new_v4());
    // 直接种入引用来模拟保存后截图被外部移动；没有读取真实文件。
    storage
        .repo
        .create(draft("缺失截图", vec![missing]))
        .unwrap();
    let before = records(&storage);
    let destination = tmp.path().join("export.zip");
    assert!(export_backup(&storage, &destination).is_err());
    assert!(!destination.exists());
    assert_eq!(records(&storage), before);
    assert_eq!(fs::read_dir(tmp.path()).unwrap().count(), 1);
}

#[test]
fn legacy_wpf_json_and_zip_are_rejected_without_modifying_the_source_or_current_data() {
    let tmp = tempfile::tempdir().unwrap();
    let mut storage = LocalStorage::open(&tmp.path().join("profile")).unwrap();
    storage.repo.create(draft("现有任务", vec![])).unwrap();
    let before = records(&storage);
    // 按只读 TodoSnapshot/TodoItem 源码构造的虚构旧格式，不加载旧数据库。
    let json = serde_json::to_vec(&serde_json::json!({
        "schema_version": 2,
        "Tasks": [{
            "Uuid": "e0c07480-f26f-4f7b-8264-64951b57c1dc",
            "Id": "f951350a-3086-44f9-b095-2b88d198bcf3",
            "CustomerName": "虚构旧客户", "Title": "旧格式任务", "Note": "旧备注",
            "Status": "InProgress", "ReceivedAt": "2026-09-06T09:00:00+08:00",
            "DueAt": null, "CreatedAt": "2026-09-06T09:00:00+08:00",
            "UpdatedAt": "2026-09-06T10:00:00+08:00", "CompletedAt": null,
            "DeletedAt": null, "Version": 2, "ReminderAt": null,
            "NeedsReview": false, "Source": "Screenshot", "Confidence": 0.95,
            "AttachmentPaths": ["C:\\fictional-old\\shot.png"]
        }], "Customers": []
    }))
    .unwrap();
    let json_path = tmp.path().join("todos.json");
    fs::write(&json_path, &json).unwrap();
    assert!(prepare_backup(&json_path).is_err());
    let archive = tmp.path().join("legacy.zip");
    write_zip(
        &archive,
        &[("todos.json", &json), ("screenshots/shot.png", PNG_ONE)],
    );
    let archive_bytes = fs::read(&archive).unwrap();
    let error = prepare_backup(&archive).err().unwrap();
    assert!(error.contains("尚不支持旧 WPF"), "{error}");
    assert_eq!(fs::read(&json_path).unwrap(), json);
    assert_eq!(fs::read(&archive).unwrap(), archive_bytes);
    assert_eq!(records(&storage), before);
}

#[test]
fn committed_data_survives_process_exit_without_dropping_storage() {
    const CHILD_PROFILE: &str = "POMETODO_RELIABILITY_CHILD_PROFILE";
    if let Some(profile) = std::env::var_os(CHILD_PROFILE) {
        let profile = Path::new(&profile);
        let mut storage = LocalStorage::open(profile).unwrap();
        let id = storage
            .attachment_store()
            .unwrap()
            .save_png(PNG_TWO)
            .unwrap();
        let mut input = draft("子进程写入", vec![id]);
        input.due_at = None;
        let task = storage.repo.create(input).unwrap();
        storage
            .repo
            .set_status(&task.id, TodoStatus::InProgress)
            .unwrap();
        storage.repo.set_urgent(&task.id, true).unwrap();
        storage.repo.set_theme("dark").unwrap();
        fs::write(
            profile.join("expected.json"),
            serde_json::to_vec(&records(&storage)).unwrap(),
        )
        .unwrap();
        // 跳过 LocalStorage/SQLite 析构，检验已提交 WAL 的跨进程恢复。
        std::process::exit(0);
    }
    let tmp = tempfile::tempdir().unwrap();
    let profile = tmp.path().join("child-profile");
    let output = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "committed_data_survives_process_exit_without_dropping_storage",
            "--nocapture",
        ])
        .env(CHILD_PROFILE, &profile)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "子进程失败：{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected: serde_json::Value =
        serde_json::from_slice(&fs::read(profile.join("expected.json")).unwrap()).unwrap();
    let reopened = LocalStorage::open(&profile).unwrap();
    assert_eq!(records(&reopened), expected);
    assert_eq!(reopened.repo.theme().unwrap(), "dark");
    let current = reopened.repo.list().unwrap();
    assert_eq!(current.len(), 1);
    assert_eq!(current[0].due_at, None);
    assert_eq!(
        reopened
            .attachment_store()
            .unwrap()
            .read_png(&current[0].attachment_paths[0])
            .unwrap(),
        PNG_TWO
    );
}

#[test]
fn sqlite_write_failure_keeps_saved_records_and_caller_draft_recoverable_after_reopen() {
    let tmp = tempfile::tempdir().unwrap();
    let profile = tmp.path().join("profile");
    let mut storage = LocalStorage::open(&profile).unwrap();
    let id = storage
        .attachment_store()
        .unwrap()
        .save_png(PNG_ONE)
        .unwrap();
    let saved = storage
        .repo
        .create(draft("已保存原任务", vec![id.clone()]))
        .unwrap();
    let before = records(&storage);
    let conn = rusqlite::Connection::open(profile.join("pometodo.sqlite")).unwrap();
    conn.execute_batch(
        "CREATE TRIGGER reject_insert BEFORE INSERT ON todo_tasks BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;
         CREATE TRIGGER reject_update BEFORE UPDATE ON todo_tasks BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;",
    ).unwrap();
    let retry_input = draft("尚未保存输入", vec![id.clone()]);
    let create_error = storage.repo.create(retry_input.clone()).unwrap_err();
    let edit_error = storage
        .repo
        .update(&saved.id, retry_input.clone())
        .unwrap_err();
    assert!(create_error.contains("本地数据操作失败"), "{create_error}");
    assert!(edit_error.contains("本地数据操作失败"), "{edit_error}");
    assert!(storage
        .repo
        .set_status(&saved.id, TodoStatus::Completed)
        .is_err());
    assert!(storage.repo.set_urgent(&saved.id, true).is_err());
    assert!(storage.repo.delete(&saved.id).is_err());
    assert_eq!(records(&storage), before);
    drop(storage);
    let mut reopened = LocalStorage::open(&profile).unwrap();
    assert_eq!(records(&reopened), before);
    assert_eq!(
        reopened.attachment_store().unwrap().read_png(&id).unwrap(),
        PNG_ONE
    );
    conn.execute_batch("DROP TRIGGER reject_insert; DROP TRIGGER reject_update;")
        .unwrap();
    let retried = reopened.repo.create(retry_input).unwrap();
    assert_eq!(retried.title, "尚未保存输入");
    assert_eq!(retried.attachment_paths, vec![id]);
    assert_eq!(reopened.repo.list().unwrap().len(), 2);
}
