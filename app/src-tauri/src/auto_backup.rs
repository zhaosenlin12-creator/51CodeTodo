use crate::commands::StorageState;
use pometodo_core::backup;
use tauri::Manager;

/// 启动时按需自动备份：仅当 autoBackupEnabled 且距上次满 24h 才执行；
/// 失败只记录、不阻断启动，也不覆盖已有备份文件。
pub fn run_on_start(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _ = maybe_backup(&app);
    });
}

fn maybe_backup(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<StorageState>();
    let mut guard = state.inner.lock().map_err(|_| "备份状态不可用")?;
    let storage = guard.as_mut().map_err(|error| error.clone())?;

    let settings = storage.repo.settings().map_err(|error| error.to_string())?;
    let interval = chrono::Duration::hours(24);
    let now = chrono::Local::now().fixed_offset();
    if !settings.auto_backup_due(&now, interval) {
        return Ok(());
    }

    let backups = storage.profile_directory.join("backups");
    std::fs::create_dir_all(&backups).map_err(|_| "无法创建备份目录")?;
    let stem = format!("auto-{}", now.format("%Y%m%d-%H%M%S"));
    let destination = (0..10)
        .map(|suffix| {
            backups.join(if suffix == 0 {
                format!("{stem}.zip")
            } else {
                format!("{stem}-{suffix}.zip")
            })
        })
        .find(|candidate| !candidate.exists())
        .ok_or("备份目录内同秒文件过多，请稍后重试")?;

    backup::export_backup(storage, &destination)?;
    storage
        .repo
        .update_settings(serde_json::json!({ "lastAutoBackupAt": now.to_rfc3339() }))
        .map_err(|error| error.to_string())?;
    Ok(())
}
