// 非 Windows 平台（Android/iOS）占位实现：桌面专属能力（浮球、托盘菜单、剪贴板 OCR）暂不支持。
use tauri::State;

use crate::commands::StorageState;

#[tauri::command]
pub async fn pometodo_recognize_clipboard() -> Result<(), String> {
    Err("当前平台暂不支持剪贴板识别".into())
}

#[tauri::command]
pub async fn pometodo_arrange_text(_app: tauri::AppHandle, _text: String) -> Result<serde_json::Value, String> {
    Err("移动端智能整理开发中，请在电脑端使用".into())
}

#[tauri::command]
pub async fn pometodo_recognize_attachment(_state: State<'_, StorageState>, _path: String) -> Result<(), String> {
    Err("当前平台暂不支持附件识别".into())
}

#[tauri::command]
pub async fn pometodo_save_clipboard_attachment() -> Result<(), String> {
    Err("当前平台暂不支持".into())
}

#[tauri::command]
pub async fn pometodo_import_attachment() -> Result<(), String> {
    Err("当前平台暂不支持".into())
}

#[tauri::command]
pub async fn pometodo_float_expand(_expanded: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn pometodo_float_present() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub async fn pometodo_float_preview_state() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub async fn pometodo_float_menu() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn pometodo_open_main(_task_id: Option<String>, _settings: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn pometodo_menu_snapshot() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn pometodo_menu_present() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn pometodo_menu_action(_action: String) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn pometodo_choose_directory() -> Result<Option<()>, String> {
    Err("移动端使用应用私有目录，无需手动选择文件夹".into())
}

#[tauri::command]
pub async fn pometodo_apply_directory() -> Result<(), String> {
    Err("移动端暂不支持切换数据目录".into())
}

#[tauri::command]
pub async fn pometodo_export_backup() -> Result<Option<()>, String> {
    Err("移动端暂不支持本地备份导出".into())
}

#[tauri::command]
pub async fn pometodo_export_markdown() -> Result<Option<()>, String> {
    Err("移动端暂不支持导出 Markdown".into())
}

#[tauri::command]
pub async fn pometodo_choose_backup_import() -> Result<Option<()>, String> {
    Err("移动端暂不支持从本地文件导入备份".into())
}
