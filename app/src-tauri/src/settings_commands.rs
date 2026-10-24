use crate::{commands::with_storage, secrets::KeyStore};
use pometodo_core::{
    local::LocalStorage,
    settings::{AppSettings, CustomerSetting},
};
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::Emitter;
#[cfg(windows)]
use tauri_plugin_autostart::ManagerExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub(crate) settings: AppSettings,
    pub(crate) customers: Vec<CustomerSetting>,
    key_configured: BTreeMap<String, bool>,
    pub(crate) data_directory: String,
    pub(crate) screenshot_directory: String,
    version: String,
}

pub(crate) fn snapshot(
    app: &tauri::AppHandle,
    storage: &LocalStorage,
) -> Result<SettingsSnapshot, String> {
    let repo = &storage.repo;
    let keys = KeyStore::new(&storage.profile_directory.join("secrets"));
    let mut key_configured = BTreeMap::new();
    for provider in ["minimax", "deepseek", "qwen", "glm"] {
        key_configured.insert(provider.into(), keys.configured(provider)?);
    }
    let mut settings = repo.settings()?;
    #[cfg(windows)]
    {
        settings.start_with_windows = app
            .autolaunch()
            .is_enabled()
            .map_err(|_| "无法读取 Windows 开机启动状态")?;
    }
    Ok(SettingsSnapshot {
        settings,
        customers: repo.customers()?,
        key_configured,
        data_directory: storage.locations.data_directory.display().to_string(),
        screenshot_directory: storage.locations.screenshot_directory.display().to_string(),
        version: app.package_info().version.to_string(),
    })
}

#[tauri::command]
pub async fn pometodo_settings_load(app: tauri::AppHandle) -> Result<SettingsSnapshot, String> {
    let app_copy = app.clone();
    with_storage(app, move |storage| snapshot(&app_copy, storage)).await
}

#[tauri::command]
pub async fn pometodo_settings_update(
    app: tauri::AppHandle,
    patch: serde_json::Value,
) -> Result<SettingsSnapshot, String> {
    let app_copy = app.clone();
    let result = with_storage(app.clone(), move |storage| {
        let mut result = snapshot(&app_copy, storage)?;
        let repo = &mut storage.repo;
        let previous = result.settings.clone();
        let next = previous.patched(patch.clone())?;
        #[cfg(windows)]
        {
            let autolaunch = app_copy.autolaunch();
            let was_enabled = autolaunch
                .is_enabled()
                .map_err(|_| "无法读取 Windows 开机启动状态")?;
            let change_autostart =
                patch.get("startWithWindows").is_some() && was_enabled != next.start_with_windows;
            if change_autostart {
                if next.start_with_windows {
                    autolaunch.enable()
                } else {
                    autolaunch.disable()
                }
                .map_err(|_| "Windows 未能更改开机启动设置")?;
            }
            if let Err(error) = repo.update_settings(patch) {
                if change_autostart {
                    let rollback = if was_enabled {
                        autolaunch.enable()
                    } else {
                        autolaunch.disable()
                    };
                    if rollback.is_err() {
                        return Err(format!("{error}；开机启动状态未能还原，请重新检查设置"));
                    }
                }
                return Err(error);
            }
            if !change_autostart {
                result.settings.start_with_windows = was_enabled;
            }
        }
        #[cfg(not(windows))]
        repo.update_settings(patch)?;
        result.settings = next;
        Ok(result)
    })
    .await?;
    let _ = app.emit(
        "pometodo-floating-enabled",
        result.settings.floating_ball_enabled,
    );
    #[cfg(windows)]
    {
        crate::window_effects::apply(&app, &result.settings);
        if let Err(error) = crate::floating::refresh(&app) {
            let _ = app.emit("pometodo-system-error", error);
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn pometodo_customer_rename(
    app: tauri::AppHandle,
    original_name: String,
    display_name: String,
) -> Result<SettingsSnapshot, String> {
    let app_copy = app.clone();
    with_storage(app, move |storage| {
        let mut result = snapshot(&app_copy, storage)?;
        let repo = &mut storage.repo;
        repo.rename_customer(&original_name, &display_name)?;
        for row in &mut result.customers {
            if row.original_name.to_lowercase() == original_name.to_lowercase() {
                row.display_name = display_name.trim().into();
            }
        }
        result
            .customers
            .sort_by_key(|row| row.display_name.to_lowercase());
        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn pometodo_customer_hide(
    app: tauri::AppHandle,
    original_name: String,
) -> Result<SettingsSnapshot, String> {
    let app_copy = app.clone();
    with_storage(app, move |storage| {
        let mut result = snapshot(&app_copy, storage)?;
        let repo = &mut storage.repo;
        repo.hide_customer(&original_name)?;
        result
            .customers
            .retain(|row| row.original_name.to_lowercase() != original_name.to_lowercase());
        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn pometodo_key_save(
    app: tauri::AppHandle,
    provider: String,
    key: String,
) -> Result<SettingsSnapshot, String> {
    let app_copy = app.clone();
    with_storage(app, move |storage| {
        let mut result = snapshot(&app_copy, storage)?;
        if !matches!(provider.as_str(), "deepseek" | "qwen" | "glm") {
            return Err("不支持的 AI 服务商".into());
        }
        KeyStore::new(&storage.profile_directory.join("secrets")).save(&provider, &key)?;
        result.key_configured.insert(provider, true);
        Ok(result)
    })
    .await
}

#[tauri::command]
pub async fn pometodo_key_clear(
    app: tauri::AppHandle,
    provider: String,
) -> Result<SettingsSnapshot, String> {
    let app_copy = app.clone();
    with_storage(app, move |storage| {
        let mut result = snapshot(&app_copy, storage)?;
        if !matches!(provider.as_str(), "deepseek" | "qwen" | "glm") {
            return Err("不支持的 AI 服务商".into());
        }
        KeyStore::new(&storage.profile_directory.join("secrets")).clear(&provider)?;
        result.key_configured.insert(provider, false);
        Ok(result)
    })
    .await
}
