use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub struct KeyStore {
    root: PathBuf,
}

impl KeyStore {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }
    fn path(&self, provider: &str) -> Result<PathBuf, String> {
        if !matches!(
            provider,
            "minimax"
                | "deepseek"
                | "qwen"
                | "glm"
                | "official-session"
                | "official-order"
                | "official-extraction"
        ) {
            return Err("不支持的 AI 服务商".into());
        }
        Ok(self.root.join(format!("{provider}.key")))
    }
    pub fn configured(&self, provider: &str) -> Result<bool, String> {
        match std::fs::metadata(self.path(provider)?) {
            Ok(metadata) => Ok(metadata.is_file()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err("无法读取密钥保存状态".into()),
        }
    }
    pub fn save(&self, provider: &str, key: &str) -> Result<(), String> {
        let destination = self.path(provider)?;
        let key = key.trim();
        if key.is_empty()
            || key.len()
                > if provider == "official-extraction" {
                    131_072
                } else {
                    8192
                }
            || key.chars().any(char::is_control)
            || key.chars().all(|c| c == '•' || c == '*')
        {
            return Err("请输入有效的 API Key".into());
        }
        let encrypted = crypt(provider, key.as_bytes(), true)?;
        std::fs::create_dir_all(&self.root).map_err(|_| "无法创建密钥保存目录")?;
        static SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let sequence = SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时间异常")?
            .as_nanos();
        let temporary = self
            .root
            .join(format!(".{provider}-{timestamp}-{sequence}.tmp"));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|_| "密钥文件无法写入")?;
        let written = file
            .write_all(b"POMEKEY1")
            .and_then(|_| file.write_all(&encrypted))
            .and_then(|_| file.sync_all());
        drop(file);
        if written.is_err() || std::fs::rename(&temporary, &destination).is_err() {
            let _ = std::fs::remove_file(&temporary);
            return Err("密钥保存失败，原密钥保持不变".into());
        }
        Ok(())
    }
    pub fn read(&self, provider: &str) -> Result<Option<String>, String> {
        let file = match std::fs::File::open(self.path(provider)?) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(_) => return Err("无法读取本机密钥，请重新保存".into()),
        };
        let mut bytes = Vec::new();
        let limit = if provider == "official-extraction" {
            196_608
        } else {
            65_536
        };
        file.take(limit + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "密钥读取失败")?;
        if bytes.len() > limit as usize || !bytes.starts_with(b"POMEKEY1") {
            return Err("密钥文件损坏，请重新保存".into());
        }
        let decrypted = crypt(provider, &bytes[8..], false)?;
        String::from_utf8(decrypted)
            .map(Some)
            .map_err(|_| "密钥内容无效，请重新保存".into())
    }
    pub fn clear(&self, provider: &str) -> Result<(), String> {
        match std::fs::remove_file(self.path(provider)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("密钥未能清除，请检查保存目录".into()),
        }
    }
}

#[cfg(target_os = "windows")]
fn crypt(provider: &str, bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows::{
        core::PCWSTR,
        Win32::{
            Foundation::{LocalFree, HLOCAL},
            Security::Cryptography::{
                CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
            },
        },
    };
    let entropy = format!("PomeTodo/APIKey/v1/{provider}").into_bytes();
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    let result = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                PCWSTR::null(),
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                None,
                Some(&entropy),
                None,
                None,
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    result.map_err(|_| {
        if encrypt {
            "Windows 无法加密密钥".to_string()
        } else {
            "密钥无法解密，请在当前 Windows 账户重新保存".to_string()
        }
    })?;
    if output.pbData.is_null() {
        return Err("Windows 未返回有效的密钥数据".into());
    }
    let data =
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
    unsafe {
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
    }
    Ok(data)
}

#[cfg(not(target_os = "windows"))]
fn crypt(_provider: &str, _bytes: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> {
    Err("此版本仅支持 Windows 本机密钥加密".into())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;

    #[test]
    fn fake_keys_round_trip_without_plaintext_and_can_be_replaced() {
        let dir = tempfile::tempdir().unwrap();
        let store = KeyStore::new(dir.path());
        assert_eq!(store.read("deepseek").unwrap(), None);
        store
            .save("deepseek", "pometodo-fake-key-for-local-test")
            .unwrap();
        let bytes = std::fs::read(dir.path().join("deepseek.key")).unwrap();
        assert!(!bytes.windows(8).any(|w| w == b"fake-key"));
        assert_eq!(
            store.read("deepseek").unwrap().as_deref(),
            Some("pometodo-fake-key-for-local-test")
        );
        store.save("deepseek", "second-fake-local-key").unwrap();
        assert_eq!(
            store.read("deepseek").unwrap().as_deref(),
            Some("second-fake-local-key")
        );
        assert_eq!(store.read("qwen").unwrap(), None);
        store.clear("deepseek").unwrap();
        store.clear("deepseek").unwrap();
        assert_eq!(store.read("deepseek").unwrap(), None);
        assert!(store.save("../escaped", "invalid").is_err());
        assert!(store.save("glm", " \n ").is_err());
    }

    #[test]
    fn corrupt_key_is_reported_and_not_overwritten_by_reading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("glm.key");
        std::fs::write(&path, b"broken-secret-file").unwrap();
        let store = KeyStore::new(dir.path());
        assert!(store.read("glm").is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"broken-secret-file");
    }
}
