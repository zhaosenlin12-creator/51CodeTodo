// 非 Windows 平台（Android/iOS）占位实现：桌面专属能力（浮球、托盘菜单、剪贴板 OCR）暂不支持。
use tauri::Manager;
use tauri::State;

use crate::commands::StorageState;

#[tauri::command]
pub async fn pometodo_recognize_clipboard() -> Result<(), String> {
    Err("当前平台暂不支持剪贴板识别".into())
}

#[tauri::command]
pub async fn pometodo_arrange_text(
    app: tauri::AppHandle,
    text: String,
) -> Result<serde_json::Value, String> {
    use crate::ai_extract::{build_messages, parse_response, ExtractionContext, InputKind};
    use crate::ai_http::AiHttp;
    use std::sync::OnceLock;

    let text = text.trim().to_string();
    if text.is_empty() {
        return Ok(serde_json::json!({"kind":"empty","message":"没有文字"}));
    }

    // 读设置与 Key
    let (preferences, keys) = {
        let state = app.state::<StorageState>();
        let guard = state.inner.lock().map_err(|_| "无法读取设置")?;
        let storage = guard.as_ref().map_err(Clone::clone)?;
        let prefs = crate::distribution::effective_preferences(
            storage.repo.smart_arrange_preferences()?,
        );
        crate::smart_arrange::require_enabled(&prefs)?;
        let keys = crate::smart_arrange::candidate_user_keys(storage)?;
        (prefs, keys)
    };
    if keys.is_empty() {
        return Err("请先在设置里配置 AI Key".into());
    }

    let now = chrono::Local::now().fixed_offset();
    let context = ExtractionContext { now, kind: InputKind::Text };

    static HTTP: OnceLock<Result<AiHttp, crate::ai_http::AiHttpError>> = OnceLock::new();
    let http = HTTP.get_or_init(AiHttp::new).as_ref().map_err(ToString::to_string)?.clone();

    let mut last_err: Option<String> = None;
    for (provider, key) in keys {
        let messages = match build_messages(&text, &context) {
            Ok(m) => m,
            Err(e) => return Err(e.to_string()),
        };
        match http.complete(&provider, &key, &messages) {
            Ok(content) => {
                match parse_response(&content, &context) {
                    Ok(parsed) => {
                        let title = parsed.title.unwrap_or_default().trim().to_string();
                        if title.is_empty() {
                            return Ok(serde_json::json!({
                                "kind":"local",
                                "draft":{"note":parsed.note,"attachmentPaths":[]},
                                "message":"未识别出待办，信息已填入备注"
                            }));
                        }
                        return Ok(serde_json::json!({
                            "kind":"ai",
                            "draft":{
                                "customerName":parsed.customer_name,
                                "title":title,
                                "note":parsed.note,
                                "receivedAt":parsed.received_at,
                                "dueAt":parsed.due_at,
                                "attachmentPaths":[]
                            }
                        }));
                    }
                    Err(e) => {
                        last_err = Some(e.to_string());
                    }
                }
            }
            Err(e) => {
                let es = e.to_string();
                if es.contains("余额不足") || es.contains("频繁") || es.contains("Key 无效")
                    || es.contains("不可用") || es.contains("连接") || es.contains("超时")
                {
                    last_err = Some(es);
                    continue;
                }
                return Err(es);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "所有 Key 都不可用".into()))
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
