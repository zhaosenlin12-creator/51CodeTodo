use crate::{attachments::AttachmentStore, store::TodoRepository};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Locations {
    pub data_directory: PathBuf,
    pub screenshot_directory: PathBuf,
}

pub struct LocalStorage {
    pub profile_directory: PathBuf,
    pub locations: Locations,
    pub repo: TodoRepository,
    pub attachments: Result<AttachmentStore, String>,
}

impl LocalStorage {
    pub fn open(profile: &Path) -> Result<Self, String> {
        fs::create_dir_all(profile).map_err(|e| format!("无法打开本地目录：{e}"))?;
        let profile = profile.canonicalize().map_err(|e| e.to_string())?;
        let manifest = profile.join("locations.json");
        let locations = match fs::File::open(&manifest) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(16_385)
                    .read_to_end(&mut bytes)
                    .map_err(|e| e.to_string())?;
                if bytes.len() > 16_384 {
                    return Err("本地目录配置过大，已保留原文件".into());
                }
                let locations: Locations =
                    serde_json::from_slice(&bytes).map_err(|_| "本地目录配置损坏，已保留原文件")?;
                if !locations.data_directory.is_absolute()
                    || !locations.screenshot_directory.is_absolute()
                {
                    return Err("本地目录配置无效，已保留原文件".into());
                }
                if !locations.data_directory.join("pometodo.sqlite").is_file() {
                    return Err(
                        "选择的数据目录或数据库已被移动，请恢复原位置后重启；不会创建空库覆盖记录"
                            .into(),
                    );
                }
                locations
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Locations {
                data_directory: profile.clone(),
                screenshot_directory: profile.join("attachments"),
            },
            Err(e) => return Err(format!("无法读取本地目录配置：{e}")),
        };
        let repo = TodoRepository::open(&locations.data_directory.join("pometodo.sqlite"))?;
        let attachments = AttachmentStore::open(&locations.screenshot_directory);
        Ok(Self {
            profile_directory: profile,
            locations,
            repo,
            attachments,
        })
    }

    pub fn attachment_store(&self) -> Result<&AttachmentStore, String> {
        self.attachments.as_ref().map_err(Clone::clone)
    }

    pub fn directory(&self, kind: &str) -> Result<&Path, String> {
        match kind {
            "data" => Ok(&self.locations.data_directory),
            "screenshots" => Ok(&self.locations.screenshot_directory),
            _ => Err("目录类型无效".into()),
        }
    }

    pub fn check_destination(&self, kind: &str, destination: &Path) -> Result<PathBuf, String> {
        self.directory(kind)?;
        if !destination.is_absolute() {
            return Err("请选择本机的完整目录".into());
        }
        fs::create_dir_all(destination).map_err(|e| format!("无法打开目标目录：{e}"))?;
        let destination = destination.canonicalize().map_err(|e| e.to_string())?;
        if fs::read_dir(&destination)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            return Err("请选择一个空文件夹，已有文件不会被覆盖".into());
        }
        Ok(destination)
    }

    pub fn change_directory(&mut self, kind: &str, destination: &Path) -> Result<(), String> {
        let destination = self.check_destination(kind, destination)?;
        let mut next = self.locations.clone();
        if kind == "data" {
            self.repo
                .snapshot_to(&destination.join("pometodo.sqlite"))?;
            let replacement = TodoRepository::open(&destination.join("pometodo.sqlite"))?;
            replacement.list()?;
            replacement.settings()?;
            next.data_directory = destination;
            self.save_locations(&next)?;
            self.repo = replacement;
        } else {
            let store = self.attachment_store()?;
            for id in self.repo.attachment_ids()? {
                store.read_png(&id)?;
            }
            for entry in
                fs::read_dir(&self.locations.screenshot_directory).map_err(|e| e.to_string())?
            {
                let entry = entry.map_err(|e| e.to_string())?;
                let id = entry.file_name().to_string_lossy().into_owned();
                // 未保存表单的截图也保留；只复制本程序发放的托管 PNG。
                if id
                    .strip_suffix(".png")
                    .and_then(|s| uuid::Uuid::parse_str(s).ok())
                    .is_none()
                {
                    continue;
                }
                write_new(&destination.join(&id), &store.read_png(&id)?)?;
            }
            let replacement = AttachmentStore::open(&destination)?;
            next.screenshot_directory = destination;
            self.save_locations(&next)?;
            self.attachments = Ok(replacement);
        }
        self.locations = next;
        Ok(())
    }

    fn save_locations(&self, locations: &Locations) -> Result<(), String> {
        let temporary = self
            .profile_directory
            .join(format!("locations-{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec_pretty(locations).map_err(|e| e.to_string())?;
        write_new(&temporary, &bytes)?;
        if let Err(error) = fs::rename(&temporary, self.profile_directory.join("locations.json")) {
            let _ = fs::remove_file(&temporary); // 只清理本次新建的唯一临时文件。
            return Err(format!("目录设置未保存，仍使用原目录：{error}"));
        }
        Ok(())
    }
}

pub(crate) fn write_new(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|e| format!("无法创建文件（不会覆盖已有文件）：{e}"))?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| format!("文件未写入完整：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TodoDraft;

    fn task() -> TodoDraft {
        TodoDraft {
            customer_name: "验收客户".into(),
            title: "安全换目录".into(),
            note: String::new(),
            received_at: "2026-09-06T00:00:00Z".into(),
            due_at: None,
            attachment_paths: vec![],
            category: None,
            reminder_at: None,
        }
    }

    #[test]
    fn changing_data_directory_keeps_source_and_survives_restart() {
        let tmp = tempfile::tempdir().unwrap();
        let profile = tmp.path().join("profile");
        let destination = tmp.path().join("new-data");
        let mut storage = LocalStorage::open(&profile).unwrap();
        let saved = storage.repo.create(task()).unwrap();
        storage.change_directory("data", &destination).unwrap();
        assert_eq!(storage.repo.list().unwrap()[0].id, saved.id);
        assert!(profile.join("pometodo.sqlite").is_file());
        assert_eq!(
            storage.locations.data_directory,
            destination.canonicalize().unwrap()
        );
        drop(storage);
        let reopened = LocalStorage::open(&profile).unwrap();
        assert_eq!(reopened.repo.list().unwrap()[0].id, saved.id);
        assert_eq!(
            reopened.locations.data_directory,
            destination.canonicalize().unwrap()
        );
    }

    #[test]
    fn missing_selected_database_never_becomes_an_empty_database() {
        let tmp = tempfile::tempdir().unwrap();
        let profile = tmp.path().join("profile");
        let destination = tmp.path().join("new-data");
        let mut storage = LocalStorage::open(&profile).unwrap();
        storage.change_directory("data", &destination).unwrap();
        drop(storage);
        std::fs::rename(
            destination.join("pometodo.sqlite"),
            destination.join("moved.sqlite"),
        )
        .unwrap();
        assert!(LocalStorage::open(&profile).is_err());
        assert!(!destination.join("pometodo.sqlite").exists());
    }

    #[test]
    fn occupied_target_and_failed_location_save_keep_current_tasks() {
        let tmp = tempfile::tempdir().unwrap();
        let profile = tmp.path().join("profile");
        let destination = tmp.path().join("new-data");
        let mut storage = LocalStorage::open(&profile).unwrap();
        let saved = storage.repo.create(task()).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(destination.join("pometodo.sqlite"), b"existing data").unwrap();
        assert!(storage.change_directory("data", &destination).is_err());
        assert_eq!(
            std::fs::read(destination.join("pometodo.sqlite")).unwrap(),
            b"existing data"
        );
        std::fs::create_dir(profile.join("locations.json")).unwrap();
        assert!(storage
            .change_directory("data", &tmp.path().join("another"))
            .is_err());
        assert_eq!(storage.repo.list().unwrap()[0].id, saved.id);
        assert_eq!(
            storage.locations.data_directory,
            profile.canonicalize().unwrap()
        );
    }

    #[test]
    fn screenshot_move_preserves_ids_and_original_files() {
        let tmp = tempfile::tempdir().unwrap();
        let profile = tmp.path().join("profile");
        let mut storage = LocalStorage::open(&profile).unwrap();
        let bytes = b"\x89PNG\r\n\x1a\nfixture";
        let id = storage.attachment_store().unwrap().save_png(bytes).unwrap();
        let mut draft = task();
        draft.attachment_paths.push(id.clone());
        storage.repo.create(draft).unwrap();
        let destination = tmp.path().join("pictures");
        storage
            .change_directory("screenshots", &destination)
            .unwrap();
        assert!(profile.join("attachments").join(&id).is_file());
        assert_eq!(
            storage.attachment_store().unwrap().read_png(&id).unwrap(),
            bytes
        );
        drop(storage);
        assert_eq!(
            LocalStorage::open(&profile)
                .unwrap()
                .attachment_store()
                .unwrap()
                .read_png(&id)
                .unwrap(),
            bytes
        );
    }
}
