use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub struct AttachmentStore {
    root: PathBuf,
}
const MAX_PNG_BYTES: u64 = 32 * 1024 * 1024;
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";

impl AttachmentStore {
    pub fn open(root: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(root).map_err(|error| format!("无法创建截图目录：{error}"))?;
        let root = root
            .canonicalize()
            .map_err(|error| format!("无法打开截图目录：{error}"))?;
        Ok(Self { root })
    }

    pub fn save_png(&self, bytes: &[u8]) -> Result<String, String> {
        if !bytes.starts_with(PNG_SIGNATURE) || bytes.len() as u64 > MAX_PNG_BYTES {
            return Err("截图格式无效或超过 32 MB，请缩小后重试".into());
        }
        let id = format!("{}.png", uuid::Uuid::new_v4());
        let target = self.root.join(&id);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| format!("保存截图失败：{error}"))?;
        if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
            drop(file);
            // target 由本方法在已核实的托管目录中创建，只清理该未完成文件。
            let _ = std::fs::remove_file(&target);
            return Err(format!("保存截图失败：{error}"));
        }
        Ok(id)
    }

    pub fn path_for(&self, id: &str) -> Result<PathBuf, String> {
        let stem = id.strip_suffix(".png").ok_or("无效的截图标识")?;
        if id.contains(['/', '\\', ':']) || uuid::Uuid::parse_str(stem).is_err() {
            return Err("无效的截图标识".into());
        }
        let resolved = self
            .root
            .join(id)
            .canonicalize()
            .map_err(|_| "截图不存在或已被移动".to_string())?;
        if resolved.parent() != Some(self.root.as_path()) || !resolved.is_file() {
            return Err("只能读取 PomeTodo 保存的截图".into());
        }
        Ok(resolved)
    }

    pub fn read_png(&self, id: &str) -> Result<Vec<u8>, String> {
        let path = self.path_for(id)?;
        let file = std::fs::File::open(path).map_err(|error| format!("读取截图失败：{error}"))?;
        let mut bytes = Vec::new();
        file.take(MAX_PNG_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| format!("读取截图失败：{error}"))?;
        if bytes.len() as u64 > MAX_PNG_BYTES || !bytes.starts_with(PNG_SIGNATURE) {
            return Err("截图文件无效或超过 32 MB".into());
        }
        Ok(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const PNG_SAMPLE: &[u8] = b"\x89PNG\r\n\x1a\nsynthetic-test-payload";

    #[test]
    fn only_managed_attachments_can_be_read() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("attachments");
        let store = AttachmentStore::open(&root).unwrap();
        let id = store.save_png(PNG_SAMPLE).unwrap();
        assert!(!Path::new(&id).is_absolute());
        assert_eq!(store.read_png(&id).unwrap(), PNG_SAMPLE);
        assert!(store.path_for("../private.png").is_err());
        assert!(store.path_for("C:\\private.png").is_err());
        assert!(store.path_for("missing.png").is_err());
        assert!(store.path_for("..\\private.png").is_err());
        assert!(store.save_png(b"not-png").is_err());
    }

    #[test]
    fn separate_saves_never_overwrite_each_other() {
        let temp = tempfile::tempdir().unwrap();
        let store = AttachmentStore::open(temp.path()).unwrap();
        let one = store.save_png(PNG_SAMPLE).unwrap();
        let two = store.save_png(PNG_SAMPLE).unwrap();
        assert_ne!(one, two);
        assert_eq!(store.read_png(&one).unwrap(), PNG_SAMPLE);
        assert_eq!(store.read_png(&two).unwrap(), PNG_SAMPLE);
    }
}
