use crate::{
    attachments::AttachmentStore,
    local::LocalStorage,
    store::{validate_backup_records, BackupRecord},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

const MAX_ENTRIES: usize = 5000;
const MAX_ENTRY: u64 = 32 * 1024 * 1024;
const MAX_TOTAL: u64 = 512 * 1024 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    format: String,
    version: u32,
    tasks: Vec<BackupRecord>,
}

pub struct PreparedBackup {
    records: Vec<BackupRecord>,
    ids: BTreeSet<String>,
    directory: tempfile::TempDir,
}

impl PreparedBackup {
    pub fn task_count(&self) -> usize {
        self.records
            .iter()
            .filter(|r| r.deleted_at.is_none())
            .count()
    }
    pub fn attachment_count(&self) -> usize {
        self.ids.len()
    }
}

pub fn export_backup(storage: &LocalStorage, destination: &Path) -> Result<(), String> {
    if destination.exists() {
        return Err("该备份文件已存在，请使用新的文件名".into());
    }
    let parent = destination
        .parent()
        .filter(|p| p.is_dir())
        .ok_or("备份目录不可用")?;
    let records = storage.repo.backup_records()?;
    let ids: BTreeSet<_> = records
        .iter()
        .flat_map(|r| r.task.attachment_paths.iter().cloned())
        .collect();
    if ids.len() + 1 > MAX_ENTRIES {
        return Err("备份截图数量超过本版限制".into());
    }
    let manifest = serde_json::to_vec(&Manifest {
        format: "pometodo-backup".into(),
        version: 1,
        tasks: records,
    })
    .map_err(|e| e.to_string())?;
    if manifest.len() as u64 > MAX_ENTRY {
        return Err("备份任务数据超过 32 MB".into());
    }
    let mut temporary =
        tempfile::NamedTempFile::new_in(parent).map_err(|e| format!("无法创建备份：{e}"))?;
    {
        let mut zip = zip::ZipWriter::new(temporary.as_file_mut());
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        zip.start_file("tasks.json", options)
            .map_err(|e| e.to_string())?;
        zip.write_all(&manifest).map_err(|e| e.to_string())?;
        let mut total = manifest.len() as u64;
        for id in ids {
            let bytes = storage.attachment_store()?.read_png(&id)?;
            total += bytes.len() as u64;
            if total > MAX_TOTAL {
                return Err("备份内容超过 512 MB，请分开保存截图".into());
            }
            zip.start_file(format!("screenshots/{id}"), options)
                .map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|e| format!("备份尚未写入磁盘：{e}"))?;
    temporary
        .persist_noclobber(destination)
        .map_err(|e| format!("备份未完成，已有文件未覆盖：{e}"))?;
    Ok(())
}

pub fn prepare_backup(path: &Path) -> Result<PreparedBackup, String> {
    let file = File::open(path).map_err(|e| format!("无法打开备份：{e}"))?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_TOTAL {
        return Err("备份文件超过 512 MB".into());
    }
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "备份 ZIP 无效或损坏")?;
    if zip.len() > MAX_ENTRIES {
        return Err("备份文件数量超过限制".into());
    }
    let directory = tempfile::tempdir().map_err(|e| e.to_string())?;
    let images = directory.path().join("screenshots");
    fs::create_dir(&images).map_err(|e| e.to_string())?;
    let mut names = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut manifest = None;
    let mut total = 0;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(|_| "备份文件无法读取")?;
        let name = entry.name().to_string();
        let mode = entry.unix_mode().unwrap_or(0) & 0o170000;
        if entry.enclosed_name().is_none()
            || name.contains(['\\', ':'])
            || !names.insert(name.clone())
            || (mode != 0 && mode != 0o100000 && mode != 0o040000)
        {
            return Err("备份包含不安全或重复的文件路径".into());
        }
        if entry.is_dir() && name == "screenshots/" {
            continue;
        }
        let image_id = name.strip_prefix("screenshots/").filter(|id| {
            id.strip_suffix(".png")
                .and_then(|s| uuid::Uuid::parse_str(s).ok())
                .is_some_and(|id_uuid| format!("{id_uuid}.png") == *id)
        });
        if name != "tasks.json" && image_id.is_none() {
            return Err(
                "这不是当前 PomeTodo 的任务备份；当前版本尚不支持旧 WPF 备份，请保留原备份文件"
                    .into(),
            );
        }
        if entry.size() > MAX_ENTRY {
            return Err("备份中的单个文件超过 32 MB".into());
        }
        let mut bytes = Vec::new();
        (&mut entry)
            .take(MAX_ENTRY + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "备份内容损坏或未下载完整")?;
        total += bytes.len() as u64;
        if bytes.len() as u64 > MAX_ENTRY || total > MAX_TOTAL {
            return Err("备份解压大小超过限制".into());
        }
        if name == "tasks.json" {
            let data: Manifest = serde_json::from_slice(&bytes).map_err(|_| "备份任务格式无效")?;
            if data.format != "pometodo-backup" || data.version != 1 {
                return Err("备份版本不兼容，请使用对应版本的 PomeTodo".into());
            }
            manifest = Some(data);
        } else if let Some(id) = image_id {
            crate::local::write_new(&images.join(id), &bytes)?;
            ids.insert(id.to_string());
        }
    }
    let records = manifest.ok_or("备份缺少任务清单")?.tasks;
    validate_backup_records(&records)?;
    let store = AttachmentStore::open(&images)?;
    for id in &ids {
        store.read_png(id)?;
    }
    for record in &records {
        for id in &record.task.attachment_paths {
            if !ids.contains(id) {
                return Err("备份缺少任务引用的截图，当前记录未改变".into());
            }
        }
    }
    Ok(PreparedBackup {
        records,
        ids,
        directory,
    })
}

pub fn import_backup(
    storage: &mut LocalStorage,
    prepared: PreparedBackup,
) -> Result<PathBuf, String> {
    let backups = storage.profile_directory.join("backups");
    fs::create_dir_all(&backups).map_err(|e| format!("无法保存导入前备份，当前记录未改变：{e}"))?;
    let safety = backups.join(format!("before-import-{}.zip", uuid::Uuid::new_v4()));
    export_backup(storage, &safety)?;
    let source = AttachmentStore::open(&prepared.directory.path().join("screenshots"))?;
    let mut image_map = BTreeMap::new();
    for id in prepared.ids {
        // 新发放标识，绝不覆盖已有截图；数据库提交失败时旧引用仍然有效。
        let new_id = storage
            .attachment_store()?
            .save_png(&source.read_png(&id)?)?;
        image_map.insert(id, new_id);
    }
    storage
        .repo
        .replace_backup_records(&prepared.records, &image_map)?;
    Ok(safety)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        local::LocalStorage,
        models::{TodoDraft, TodoStatus},
    };
    use std::io::Write;

    fn draft() -> TodoDraft {
        TodoDraft {
            customer_name: "虚构客户".into(),
            title: "备份验证".into(),
            note: "无真实数据".into(),
            received_at: "2026-09-06T00:00:00Z".into(),
            due_at: None,
            attachment_paths: vec![],
            category: None,
            reminder_at: None,
        }
    }

    #[test]
    fn backup_round_trip_keeps_task_identity_status_images_and_safety_copy() {
        let tmp = tempfile::tempdir().unwrap();
        let mut storage = LocalStorage::open(&tmp.path().join("profile")).unwrap();
        let png = b"\x89PNG\r\n\x1a\nfixture";
        let attachment = storage.attachment_store().unwrap().save_png(png).unwrap();
        let mut input = draft();
        input.attachment_paths.push(attachment.clone());
        let task = storage.repo.create(input).unwrap();
        let task = storage
            .repo
            .set_status(&task.id, TodoStatus::InProgress)
            .unwrap();
        let archive = tmp.path().join("backup.zip");
        export_backup(&storage, &archive).unwrap();
        storage.repo.delete(&task.id).unwrap();
        let new_task = storage.repo.create(draft()).unwrap();
        storage.repo.set_theme("dark").unwrap();
        let prepared = prepare_backup(&archive).unwrap();
        assert_eq!(prepared.task_count(), 1);
        assert_eq!(prepared.attachment_count(), 1);
        let safety = import_backup(&mut storage, prepared).unwrap();
        let current = storage.repo.list().unwrap();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].id, task.id);
        assert_eq!(current[0].status, TodoStatus::InProgress);
        assert_eq!(current[0].updated_at, task.updated_at);
        assert_eq!(storage.repo.theme().unwrap(), "dark");
        assert_ne!(current[0].attachment_paths[0], attachment);
        assert_eq!(
            storage
                .attachment_store()
                .unwrap()
                .read_png(&current[0].attachment_paths[0])
                .unwrap(),
            png
        );
        assert!(storage
            .attachment_store()
            .unwrap()
            .path_for(&attachment)
            .is_ok());
        let old = prepare_backup(&safety).unwrap();
        assert_eq!(
            old.records
                .iter()
                .find(|r| r.deleted_at.is_none())
                .unwrap()
                .task
                .id,
            new_task.id
        );
    }

    #[test]
    fn export_never_overwrites_an_existing_file_or_includes_secrets() {
        let tmp = tempfile::tempdir().unwrap();
        let storage = LocalStorage::open(&tmp.path().join("profile")).unwrap();
        std::fs::create_dir(storage.profile_directory.join("secrets")).unwrap();
        std::fs::write(
            storage.profile_directory.join("secrets/key"),
            b"dummy-secret",
        )
        .unwrap();
        let archive = tmp.path().join("backup.zip");
        export_backup(&storage, &archive).unwrap();
        let before = std::fs::read(&archive).unwrap();
        assert!(export_backup(&storage, &archive).is_err());
        assert_eq!(std::fs::read(&archive).unwrap(), before);
        let mut zip = zip::ZipArchive::new(std::fs::File::open(archive).unwrap()).unwrap();
        assert_eq!(zip.len(), 1);
        assert_eq!(zip.by_index(0).unwrap().name(), "tasks.json");
    }

    #[test]
    fn unsafe_zip_paths_and_incomplete_archives_are_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for (index, name) in [
            "../escape.txt",
            "screenshots/../../escape.png",
            "secrets/deepseek.key",
            "tasks.json",
        ]
        .iter()
        .enumerate()
        {
            let path = tmp.path().join(format!("invalid-{index}.zip"));
            let mut writer = zip::ZipWriter::new(std::fs::File::create(&path).unwrap());
            writer
                .start_file(*name, zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"invalid data").unwrap();
            writer.finish().unwrap();
            assert!(prepare_backup(&path).is_err());
        }
        assert!(!tmp.path().join("escape.txt").exists());
    }

    #[test]
    fn backup_failure_does_not_replace_current_records() {
        let tmp = tempfile::tempdir().unwrap();
        let mut storage = LocalStorage::open(&tmp.path().join("profile")).unwrap();
        let original = storage.repo.create(draft()).unwrap();
        let archive = tmp.path().join("backup.zip");
        export_backup(&storage, &archive).unwrap();
        let prepared = prepare_backup(&archive).unwrap();
        std::fs::write(storage.profile_directory.join("backups"), b"blocked folder").unwrap();
        assert!(import_backup(&mut storage, prepared).is_err());
        assert_eq!(storage.repo.list().unwrap()[0].id, original.id);
    }
}
