//! PomeTodo standalone updater, adapted from PomeType's release flow.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, State};

use crate::distribution::{DOWNLOAD_PATH, MANIFEST_URL, UPDATE_CHANNEL};
const MAX_INSTALLER_BYTES: u64 = 256 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 64 * 1024;
const PROGRESS_EVENT: &str = "pometodo-update-progress";

pub fn should_show_on_start(
    start_minimized: bool,
    args: impl IntoIterator<Item = std::ffi::OsString>,
) -> bool {
    !start_minimized || args.into_iter().any(|arg| arg == "--show-after-update")
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelease {
    version: String,
    release_notes: String,
    published_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    current_version: String,
    channel: &'static str,
    available: bool,
    release: Option<UpdateRelease>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    stage: &'static str,
    downloaded_bytes: u64,
    total_bytes: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    ok: bool,
    product: String,
    platform: String,
    channel: String,
    installer_type: String,
    version: String,
    download_url: String,
    sha256: String,
    byte_length: u64,
    release_notes: String,
    published_at: String,
}

fn version_parts(value: &str) -> Result<[u32; 3], String> {
    let parts: Vec<_> = value.split('.').collect();
    if parts.len() != 3
        || parts.iter().any(|part| {
            part.is_empty()
                || (part.len() > 1 && part.starts_with('0'))
                || !part.bytes().all(|b| b.is_ascii_digit())
        })
    {
        return Err("版本号格式无效".into());
    }
    let values: Vec<u32> = parts
        .iter()
        .map(|part| part.parse().map_err(|_| "版本号格式无效".to_string()))
        .collect::<Result<_, _>>()?;
    Ok([values[0], values[1], values[2]])
}

fn is_newer(version: &str, current: &str) -> Result<bool, String> {
    Ok(version_parts(version)? > version_parts(current)?)
}

fn allowed_download_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "https"
        && url.host_str() == Some("www.shiliux.com")
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().starts_with(DOWNLOAD_PATH)
        && url.path().ends_with(".exe")
        && url
            .path()
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-".contains(&b))
}

fn parse_manifest(body: &str) -> Result<Manifest, String> {
    if body.len() > MAX_MANIFEST_BYTES {
        return Err("版本清单过大".into());
    }
    let manifest: Manifest =
        serde_json::from_str(body.trim_start_matches('\u{feff}')).map_err(|_| "版本清单无效")?;
    if !manifest.ok
        || manifest.product != "pometodo"
        || manifest.platform != "windows-x86_64"
        || manifest.channel != UPDATE_CHANNEL
        || manifest.installer_type != "nsis"
        || !allowed_download_url(&manifest.download_url)
        || manifest.sha256.len() != 64
        || !manifest.sha256.bytes().all(|b| b.is_ascii_hexdigit())
        || manifest.byte_length == 0
        || manifest.byte_length > MAX_INSTALLER_BYTES
        || manifest.release_notes.len() > 8000
        || chrono::DateTime::parse_from_rfc3339(&manifest.published_at).is_err()
    {
        return Err("版本清单校验失败".into());
    }
    version_parts(&manifest.version)?;
    Ok(manifest)
}

impl Manifest {
    fn summary(&self) -> UpdateRelease {
        UpdateRelease {
            version: self.version.clone(),
            release_notes: self.release_notes.clone(),
            published_at: self.published_at.clone(),
        }
    }
}

struct CachedInstaller {
    path: PathBuf,
    manifest: Manifest,
}

#[derive(Default)]
pub struct UpdateState {
    busy: AtomicBool,
    manifest: Mutex<Option<Manifest>>,
    ready: Mutex<Option<CachedInstaller>>,
}

struct BusyGuard<'a>(&'a AtomicBool);
impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn claim(busy: &AtomicBool) -> Result<BusyGuard<'_>, String> {
    busy.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "更新操作正在进行")?;
    Ok(BusyGuard(busy))
}

fn package_mode(status: u32) -> Result<bool, String> {
    match status {
        122 => Ok(true),
        15700 => Ok(false),
        _ => Err("无法确认安装渠道，请稍后重试".into()),
    }
}

fn is_store_package() -> Result<bool, String> {
    #[cfg(windows)]
    {
        use windows::{core::PWSTR, Win32::Storage::Packaging::Appx::GetCurrentPackageFullName};
        let mut len = 0;
        package_mode(unsafe { GetCurrentPackageFullName(&mut len, PWSTR::null()).0 })
    }
    #[cfg(not(windows))]
    {
        Err("更新仅支持 Windows 独立版".into())
    }
}

fn require_standalone() -> Result<(), String> {
    if is_store_package()? {
        Err("请通过 Microsoft Store 更新商店版".into())
    } else {
        Ok(())
    }
}

fn client_builder(timeout: Duration) -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
}

fn client(timeout: Duration) -> Result<reqwest::Client, String> {
    client_builder(timeout)
        .build()
        .map_err(|_| "无法建立更新连接".into())
}

fn progress(app: &tauri::AppHandle, stage: &'static str, downloaded: u64, total: u64) {
    let _ = app.emit(
        PROGRESS_EVENT,
        UpdateProgress {
            stage,
            downloaded_bytes: downloaded,
            total_bytes: Some(total),
        },
    );
}

#[tauri::command]
pub async fn pometodo_check_update(state: State<'_, UpdateState>) -> Result<UpdateCheck, String> {
    let _guard = claim(&state.busy)?;
    let current = env!("CARGO_PKG_VERSION").to_string();
    if is_store_package()? {
        return Ok(UpdateCheck {
            current_version: current,
            channel: "store",
            available: false,
            release: None,
        });
    }
    // A failed new check must not leave an earlier server snapshot actionable.
    *state.manifest.lock().map_err(|_| "无法读取更新状态")? = None;
    *state.ready.lock().map_err(|_| "无法读取更新状态")? = None;
    let mut response = client(Duration::from_secs(20))?
        .get(MANIFEST_URL)
        .send()
        .await
        .map_err(|_| "无法检查更新，请稍后重试")?;
    if !response.status().is_success() {
        return Err("更新服务暂不可用".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "读取版本信息失败")? {
        if bytes.len() + chunk.len() > MAX_MANIFEST_BYTES {
            return Err("版本清单过大".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = std::str::from_utf8(&bytes).map_err(|_| "版本清单编码无效")?;
    let manifest = parse_manifest(text)?;
    let available = is_newer(&manifest.version, &current)?;
    let release = available.then(|| manifest.summary());
    *state.manifest.lock().map_err(|_| "无法记录更新状态")? = available.then_some(manifest);
    Ok(UpdateCheck {
        current_version: current,
        channel: UPDATE_CHANNEL,
        available,
        release,
    })
}

fn verify_bytes(downloaded: u64, digest: &str, manifest: &Manifest) -> Result<(), String> {
    if downloaded != manifest.byte_length || !digest.eq_ignore_ascii_case(&manifest.sha256) {
        Err("安装包校验失败，请重新下载".into())
    } else {
        Ok(())
    }
}

fn verify_reader(reader: &mut impl Read, manifest: &Manifest) -> Result<(), String> {
    let mut hasher = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|_| "无法读取已下载的安装包")?;
        if count == 0 {
            break;
        }
        total += count as u64;
        if total > manifest.byte_length {
            return Err("安装包大小不符".into());
        }
        hasher.update(&buffer[..count]);
    }
    verify_bytes(total, &format!("{:x}", hasher.finalize()), manifest)
}

#[tauri::command]
pub async fn pometodo_download_update(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    let _guard = claim(&state.busy)?;
    require_standalone()?;
    let manifest = state
        .manifest
        .lock()
        .map_err(|_| "无法读取更新状态")?
        .clone()
        .ok_or("请先检查新版本")?;
    if !is_newer(&manifest.version, env!("CARGO_PKG_VERSION"))? {
        return Err("没有可安装的新版本".into());
    }
    *state.ready.lock().map_err(|_| "无法读取更新状态")? = None;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|_| "无法创建更新缓存")?
        .join("updates");
    std::fs::create_dir_all(&cache).map_err(|_| "无法创建更新缓存")?;
    let path = cache.join(format!(
        "PomeTodoSetup-{}-{}.exe",
        manifest.version,
        uuid::Uuid::new_v4()
    ));
    download_installer(
        &manifest,
        &path,
        client(Duration::from_secs(30 * 60))?,
        |total| {
            progress(&app, "downloading", total, manifest.byte_length);
        },
    )
    .await?;
    progress(&app, "ready", manifest.byte_length, manifest.byte_length);
    *state.ready.lock().map_err(|_| "无法记录下载结果")? = Some(CachedInstaller { path, manifest });
    Ok(())
}

// The command supplies the validated manifest and its own cache path. Keeping
// transport here allows real HTTP and disk failure tests without a live window.
async fn download_installer(
    manifest: &Manifest,
    path: &std::path::Path,
    http: reqwest::Client,
    mut report: impl FnMut(u64),
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| "无法保存更新文件")?;
    let result = async {
        let mut response = http
            .get(&manifest.download_url)
            .send()
            .await
            .map_err(|_| "下载失败，请稍后重试")?;
        if !response.status().is_success() {
            return Err("下载服务暂不可用".to_string());
        }
        if response
            .content_length()
            .is_some_and(|size| size != manifest.byte_length)
        {
            return Err("安装包大小不符".into());
        }
        let mut total = 0u64;
        let mut hasher = Sha256::new();
        report(0);
        while let Some(chunk) = response.chunk().await.map_err(|_| "下载中断，请重试")? {
            total += chunk.len() as u64;
            if total > manifest.byte_length {
                return Err("安装包大小不符".into());
            }
            file.write_all(&chunk).map_err(|_| "更新文件写入失败")?;
            hasher.update(&chunk);
            report(total);
        }
        file.sync_all().map_err(|_| "更新文件保存失败")?;
        verify_bytes(total, &format!("{:x}", hasher.finalize()), manifest)
    }
    .await;
    drop(file);
    if let Err(error) = result {
        let _ = std::fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub async fn pometodo_install_update(
    app: tauri::AppHandle,
    state: State<'_, UpdateState>,
) -> Result<(), String> {
    let _guard = claim(&state.busy)?;
    require_standalone()?;
    let ready = state.ready.lock().map_err(|_| "无法读取更新状态")?;
    let installer = ready.as_ref().ok_or("请先完成更新下载")?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Prevent write/delete replacement between the final hash check and launch.
        options.share_mode(1);
    }
    let mut file = options
        .open(&installer.path)
        .map_err(|_| "安装包已失效，请重新下载")?;
    verify_reader(&mut file, &installer.manifest)?;
    progress(
        &app,
        "installing",
        installer.manifest.byte_length,
        installer.manifest.byte_length,
    );
    std::process::Command::new(&installer.path)
        .args(["/P", "/UPDATE", "/R", "/ARGS", "--show-after-update"])
        .spawn()
        .map_err(|_| "无法启动更新，请重试")?;
    // The UI owns the unsaved-form gate. Exit only after the verified installer starts.
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests;
