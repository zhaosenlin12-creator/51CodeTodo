use crate::{
    commands::with_storage,
    settings_commands::{snapshot, SettingsSnapshot},
};
use pometodo_core::{
    backup::{self, PreparedBackup},
    local::Locations,
    markdown,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

enum Pending {
    Directory {
        kind: String,
        destination: PathBuf,
        locations: Locations,
    },
    Import {
        prepared: PreparedBackup,
        locations: Locations,
    },
}

#[derive(Default)]
pub struct PendingFiles(Mutex<HashMap<String, (Instant, Pending)>>);

impl PendingFiles {
    fn remember(&self, value: Pending) -> Result<String, String> {
        let mut pending = self.0.lock().map_err(|_| "文件预览状态不可用")?;
        pending.retain(|_, (time, _)| time.elapsed() < Duration::from_secs(900));
        if pending.len() >= 4 {
            let oldest = pending
                .iter()
                .min_by_key(|(_, (time, _))| *time)
                .map(|(key, _)| key.clone());
            if let Some(key) = oldest {
                pending.remove(&key);
            }
        }
        let token = uuid::Uuid::new_v4().to_string();
        pending.insert(token.clone(), (Instant::now(), value));
        Ok(token)
    }

    fn take(&self, token: &str) -> Result<Pending, String> {
        let (time, value) = self
            .0
            .lock()
            .map_err(|_| "文件预览状态不可用")?
            .remove(token)
            .ok_or("预览已失效，请重新选择文件或目录")?;
        if time.elapsed() >= Duration::from_secs(900) {
            return Err("预览已超过 15 分钟，请重新选择".into());
        }
        Ok(value)
    }
}

fn locations_match(left: &Locations, right: &Locations) -> Result<(), String> {
    if left.data_directory != right.data_directory
        || left.screenshot_directory != right.screenshot_directory
    {
        return Err("数据位置已变化，请重新选择并核对预览".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirectoryPreview {
    token: String,
    kind: String,
    source: String,
    destination: String,
    message: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    token: String,
    file_name: String,
    task_count: usize,
    attachment_count: usize,
    message: String,
}
#[derive(Serialize)]
pub struct ActionResult {
    snapshot: SettingsSnapshot,
    message: String,
}
#[derive(Serialize)]
pub struct ExportResult {
    message: String,
}

#[tauri::command]
pub async fn pometodo_choose_directory(
    app: tauri::AppHandle,
    kind: String,
) -> Result<Option<DirectoryPreview>, String> {
    let check_kind = kind.clone();
    with_storage(app.clone(), move |storage| {
        storage.directory(&check_kind).map(|_| ())
    })
    .await?;
    let app_copy = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app_copy
            .dialog()
            .file()
            .set_title("选择新的空文件夹")
            .blocking_pick_folder()
    })
    .await
    .map_err(|_| "文件夹选择未完成")?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let destination = selected.into_path().map_err(|_| "请选择本机文件夹")?;
    let app_copy = app.clone();
    with_storage(app, move |storage| {
        let destination = storage.check_destination(&kind, &destination)?;
        let source = storage.directory(&kind)?.display().to_string();
        let token = app_copy
            .state::<PendingFiles>()
            .remember(Pending::Directory {
                kind: kind.clone(),
                destination: destination.clone(),
                locations: storage.locations.clone(),
            })?;
        Ok(Some(DirectoryPreview {
            token,
            kind,
            source,
            destination: destination.display().to_string(),
            message: "确认后完整复制并切换保存位置；原目录文件会保留。数据目录和截图目录分别管理。"
                .into(),
        }))
    })
    .await
}

#[tauri::command]
pub async fn pometodo_apply_directory(
    app: tauri::AppHandle,
    token: String,
) -> Result<ActionResult, String> {
    let pending = app.state::<PendingFiles>().take(&token)?;
    let Pending::Directory {
        kind,
        destination,
        locations,
    } = pending
    else {
        return Err("目录预览类型无效，请重新选择".into());
    };
    let app_copy = app.clone();
    with_storage(app, move |storage| {
        locations_match(&storage.locations, &locations)?;
        let mut result = snapshot(&app_copy, storage)?;
        storage.change_directory(&kind, &destination)?;
        result.data_directory = storage.locations.data_directory.display().to_string();
        result.screenshot_directory = storage.locations.screenshot_directory.display().to_string();
        Ok(ActionResult {
            snapshot: result,
            message: "保存位置已更换，原目录副本已保留。".into(),
        })
    })
    .await
}

#[tauri::command]
pub async fn pometodo_export_backup(app: tauri::AppHandle) -> Result<Option<ExportResult>, String> {
    let app_copy = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app_copy
            .dialog()
            .file()
            .set_title("导出任务和截图备份")
            .add_filter("PomeTodo 备份", &["zip"])
            .set_file_name(format!(
                "PomeTodo-{}.zip",
                chrono::Local::now().format("%Y%m%d-%H%M%S")
            ))
            .blocking_save_file()
    })
    .await
    .map_err(|_| "备份位置选择未完成")?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let destination = selected.into_path().map_err(|_| "请选择本机文件位置")?;
    with_storage(app, move |storage| {
        backup::export_backup(storage, &destination)?;
        Ok(Some(ExportResult {
            message: format!(
                "任务和截图已备份到 {}；不包含 API Key。",
                destination.display()
            ),
        }))
    })
    .await
}

#[tauri::command]
pub async fn pometodo_export_markdown(app: tauri::AppHandle) -> Result<Option<ExportResult>, String> {
    let app_copy = app.clone();
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app_copy
            .dialog()
            .file()
            .set_title("导出 PomeTodo Markdown")
            .add_filter("PomeTodo Markdown", &["md"])
            .set_file_name(format!(
                "PomeTodo-{}.md",
                chrono::Local::now().format("%Y%m%d-%H%M%S")
            ))
            .blocking_save_file()
    })
    .await
    .map_err(|_| "Markdown 位置选择未完成")?;
    let Some(selected) = selected else {
        return Ok(None);
    };
    let destination = selected.into_path().map_err(|_| "请选择本机文件位置")?;
    if destination.exists() {
        return Err("该 Markdown 文件已存在，请使用新的文件名".into());
    }
    with_storage(app, move |storage| {
        let tasks = storage.repo.list().map_err(|error| error.to_string())?;
        let content = markdown::render_markdown(&tasks)?;
        std::fs::write(&destination, content.as_bytes())
            .map_err(|_| "Markdown 文件写入失败，请更换位置后重试")?;
        Ok(Some(ExportResult {
            message: format!("任务清单已导出到 {}", destination.display()),
        }))
    })
    .await
}

#[tauri::command]
pub async fn pometodo_choose_backup_import(
    app: tauri::AppHandle,
) -> Result<Option<ImportPreview>, String> {
    let locations = with_storage(app.clone(), |storage| Ok(storage.locations.clone())).await?;
    let app_copy = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let selected = app_copy
            .dialog()
            .file()
            .set_title("导入 PomeTodo 任务备份")
            .add_filter("PomeTodo 备份", &["zip"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(None);
        };
        let path = selected.into_path().map_err(|_| "请选择本机备份文件")?;
        let prepared = backup::prepare_backup(&path)?;
        let task_count = prepared.task_count();
        let attachment_count = prepared.attachment_count();
        let token = app_copy.state::<PendingFiles>().remember(Pending::Import {
            prepared,
            locations,
        })?;
        Ok(Some(ImportPreview {
            token,
            file_name: path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            task_count,
            attachment_count,
            message: "将替换当前任务，导入前自动备份原记录。API Key 和本机设置保持当前值。".into(),
        }))
    })
    .await
    .map_err(|_| "备份预检未完成".to_string())?
}

#[tauri::command]
pub async fn pometodo_import_backup(
    app: tauri::AppHandle,
    token: String,
) -> Result<ActionResult, String> {
    let pending = app.state::<PendingFiles>().take(&token)?;
    let Pending::Import {
        prepared,
        locations,
    } = pending
    else {
        return Err("备份预览类型无效，请重新选择".into());
    };
    let app_copy = app.clone();
    let result = with_storage(app.clone(), move |storage| {
        locations_match(&storage.locations, &locations)?;
        let mut result = snapshot(&app_copy, storage)?;
        let safety = backup::import_backup(storage, prepared)?;
        let mut message = format!("任务已导入；原记录已备份到 {}。", safety.display());
        match storage.repo.customers() {
            Ok(customers) => result.customers = customers,
            Err(error) => {
                result.customers.clear();
                message.push_str(&format!("客户列表暂未刷新，请重新打开设置：{error}"));
            }
        }
        Ok(ActionResult {
            snapshot: result,
            message,
        })
    })
    .await?;
    if let Err(error) = crate::floating::refresh(&app) {
        let _ = app.emit("pometodo-system-error", error);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preview_tokens_are_single_use_and_cannot_supply_arbitrary_paths() {
        let files = PendingFiles::default();
        let locations = Locations {
            data_directory: PathBuf::from("data"),
            screenshot_directory: PathBuf::from("images"),
        };
        let token = files
            .remember(Pending::Directory {
                kind: "data".into(),
                destination: PathBuf::from("selected"),
                locations,
            })
            .unwrap();
        assert!(files.take("C:\\unselected").is_err());
        assert!(files.take(&token).is_ok());
        assert!(files.take(&token).is_err());
    }
}
