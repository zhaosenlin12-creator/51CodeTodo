use crate::{
    ai_extract::{self, ExtractionContext, ExtractionWarning, InputKind, ParsedExtraction},
    ai_http::AiHttp,
    commands::StorageState,
};
use base64::Engine;
use image::ImageEncoder;
use serde::Serialize;
use std::path::Path;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionDraft {
    attachment_paths: Vec<String>,
    /// 无任务但识别到明确对象时保留的联系人。
    customer_name: Option<String>,
    /// 提炼出的要点摘要（无明确待办任务时由 AI 整理填充）。
    note: Option<String>,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum RecognitionResult {
    Ai {
        draft: AiDraft,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Local {
        draft: RecognitionDraft,
        message: String,
    },
    Empty {
        message: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDraft {
    customer_name: Option<String>,
    title: String,
    note: Option<String>,
    received_at: Option<String>,
    due_at: Option<String>,
    attachment_paths: Vec<String>,
}

fn finish_recognition(
    local: RecognitionDraft,
    extracted: Result<Option<ParsedExtraction>, String>,
    message: String,
) -> RecognitionResult {
    match extracted {
        Ok(Some(parsed)) => {
            let title = parsed.title.as_deref().map(str::trim).unwrap_or_default();
            // 无明确待办任务：不生成待办，只把 AI 提炼的要点摘要放进备注，保留截图。
            if title.is_empty() {
                return RecognitionResult::Local {
                    draft: RecognitionDraft {
                        attachment_paths: local.attachment_paths,
                        customer_name: parsed.customer_name,
                        note: parsed.note,
                    },
                    message: "未识别出待办任务，关键信息已填入备注".into(),
                };
            }
            let mut warnings = Vec::new();
            if parsed
                .warnings
                .contains(&ExtractionWarning::InvalidReceivedDate)
            {
                warnings.push("接收日期需核对");
            }
            if parsed.warnings.contains(&ExtractionWarning::InvalidDueDate) {
                warnings.push("完成日期需核对");
            }
            RecognitionResult::Ai {
                draft: AiDraft {
                    customer_name: parsed.customer_name,
                    title: title.to_string(),
                    note: parsed.note,
                    received_at: parsed.received_at,
                    due_at: parsed.due_at,
                    attachment_paths: local.attachment_paths,
                },
                message: (!warnings.is_empty()).then(|| warnings.join("；")),
            }
        }
        Ok(None) => RecognitionResult::Local {
            draft: local,
            message,
        },
        Err(error) => RecognitionResult::Local {
            draft: local,
            message: error.to_string(),
        },
    }
}

fn extract_with_user_key(
    provider: &str,
    key: &str,
    text: &str,
    context: &ExtractionContext,
    vision: Option<&[String]>,
) -> Result<Option<ParsedExtraction>, String> {
    if let Some(images) = vision {
        // 视觉直传：AI 直接看图（与官方同思路，准确率最高）；失败由调用方退回 OCR 文本。
        let messages = crate::ai_extract::build_vision_messages(text, context).map_err(|error| error.to_string())?;
        static HTTP_VISION: OnceLock<Result<AiHttp, crate::ai_http::AiHttpError>> = OnceLock::new();
        let content = HTTP_VISION.get_or_init(AiHttp::new).as_ref().map_err(ToString::to_string)?
            .complete_vision(provider, key, &messages, images).map_err(|error| error.to_string())?;
        return crate::ai_extract::parse_response(&content, context).map(Some).map_err(|error| error.to_string());
    }
    extract_text(text, context, |messages| {
        static HTTP: OnceLock<Result<AiHttp, crate::ai_http::AiHttpError>> = OnceLock::new();
        HTTP.get_or_init(AiHttp::new)
            .as_ref()
            .map_err(ToString::to_string)?
            .complete(provider, key, messages)
            .map_err(|error| error.to_string())
    })
}

fn extract_text(
    text: &str,
    context: &ExtractionContext,
    complete: impl FnOnce(&ai_extract::PromptMessages) -> Result<String, String>,
) -> Result<Option<ParsedExtraction>, String> {
    let messages = ai_extract::build_messages(text, context).map_err(|error| error.to_string())?;
    let content = complete(&messages)?;
    ai_extract::parse_response(&content, context)
        .map(Some)
        .map_err(|error| error.to_string())
}

/// 余额不足/限流/Key 无效/服务不可用/网络/超时属于可切换到下一个 Key 的故障；
/// 解析失败、内容被拒等切换服务商也不会改善，不切换。
fn failover_eligible(error: &str) -> bool {
    error.contains("余额不足")
        || error.contains("过于频繁")
        || error.contains("API Key 无效")
        || error.contains("暂时不可用")
        || error.contains("无法连接")
        || error.contains("超时")
}

static RECOGNIZING: AtomicBool = AtomicBool::new(false);
struct RecognitionPermit;
impl RecognitionPermit {
    fn acquire() -> Result<Self, String> {
        RECOGNIZING
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map(|_| Self)
            .map_err(|_| "正在识别，请等待当前识别完成".into())
    }
}
impl Drop for RecognitionPermit {
    fn drop(&mut self) {
        RECOGNIZING.store(false, Ordering::Release);
    }
}

/// Windows fallback: some screenshot tools (e.g. WeChat) place an `image/png`
/// format on the clipboard that arboard cannot read through its DIB path.
#[cfg(target_os = "windows")]
/// 剪贴板「复制图片内容」：依次探测常见位图注册格式（PNG/JPEG/BMP/WebP/GIF），
/// 任意一种拿到字节即返回；arboard 的 DIB 路径读不到时本函数替补。
fn read_clipboard_image_data() -> Result<Option<Vec<u8>>, String> {
    use clipboard_win::{formats::RawData, get_clipboard, register_format, Clipboard};

    let _clipboard =
        Clipboard::new_attempts(10).map_err(|error| format!("打开剪贴板失败：{error}"))?;
    for name in [
        "image/png",
        "image/jpeg",
        "image/bmp",
        "image/webp",
        "image/gif",
    ] {
        let Some(format) = register_format(name) else {
            continue;
        };
        if let Ok(bytes) = get_clipboard(RawData(format.get())) {
            if !bytes.is_empty() {
                return Ok(Some(bytes));
            }
        }
    }
    Ok(None)
}

use image::GenericImageView;

/// 剪贴板中「复制图片文件」场景：读取文件列表里第一个图片文件字节。
fn read_clipboard_image_file() -> Result<Option<Vec<u8>>, String> {
    use clipboard_win::{formats::FileList, get_clipboard, Clipboard};

    let _clipboard =
        Clipboard::new_attempts(5).map_err(|error| format!("打开剪贴板失败：{error}"))?;
    let files: Vec<String> = get_clipboard(FileList).unwrap_or_default();
    if files.is_empty() {
        return Ok(None);
    }
    // 与 TodoDialog 附件一致：文字类图片格式均可识别。
    let is_image_ext = |path: &str| {
        let lower = path.to_lowercase();
        [".png", ".jpg", ".jpeg", ".bmp", ".gif", ".webp"]
            .iter()
            .any(|ext| lower.ends_with(ext))
    };
    for path in files.iter().filter(|item| is_image_ext(item)) {
        if let Ok(bytes) = std::fs::read(path) {
            return Ok(Some(bytes));
        }
    }
    Ok(None)
}

/// 任意图片字节转 PNG 并存入附件（识别/附件的统一落盘格式）。
fn image_bytes_to_png_attachment(bytes: &[u8], app: &tauri::AppHandle) -> Result<String, String> {
    let decoded = image::load_from_memory(bytes).map_err(|_| "图片文件解码失败".to_string())?;
    let mut png = Vec::new();
    decoded
        .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
        .map_err(|_| "图片文件转码失败".to_string())?;
    let state = app.state::<StorageState>();
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "截图存储不可用".to_string())?;
    guard
        .as_ref()
        .map_err(Clone::clone)?
        .attachment_store()?
        .save_png(&png)
}

fn save_image(
    clipboard: &mut arboard::Clipboard,
    app: &tauri::AppHandle,
) -> Result<Option<String>, String> {
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => {
            #[cfg(target_os = "windows")]
            {
                if let Some(png) = read_clipboard_image_data()? {
                    let decoded = image::load_from_memory(&png)
                        .map_err(|_| "截图内容无法识别".to_string())?;
                    let (width, height) = decoded.dimensions();
                    if width == 0
                        || height == 0
                        || u64::from(width) * u64::from(height) > 32_000_000
                    {
                        return Err("截图尺寸过大，请截取需要记录的部分".into());
                    }
                    let state = app.state::<StorageState>();
                    let guard = state.inner.lock().map_err(|_| "截图存储不可用")?;
                    return guard
                        .as_ref()
                        .map_err(Clone::clone)?
                        .attachment_store()?
                        .save_png(&png)
                        .map(Some);
                }
            }
            return Ok(None);
        }
        Err(_) => return Err("暂时无法读取剪贴板图片，请重新复制后重试".into()),
    };
    if image.width == 0
        || image.height == 0
        || image.width.saturating_mul(image.height) > 32_000_000
    {
        return Err("截图尺寸过大，请截取需要记录的部分".into());
    }
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(
            &image.bytes,
            image.width as u32,
            image.height as u32,
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|_| "截图转换失败，请重新截图".to_string())?;
    let state = app.state::<StorageState>();
    let guard = state.inner.lock().map_err(|_| "截图存储不可用")?;
    guard
        .as_ref()
        .map_err(Clone::clone)?
        .attachment_store()?
        .save_png(&png)
        .map(Some)
}

#[tauri::command]
pub async fn pometodo_save_clipboard_attachment(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|_| "剪贴板暂时不可用".to_string())?;
        save_image(&mut clipboard, &app)
    })
    .await
    .map_err(|_| "读取剪贴板未完成".to_string())?
}

/// 截图直传视觉识别：长边压缩到 2000 后重编码 PNG（小字识别更稳），压缩失败或过大返回 Err（上层跳过直传）。
fn prepare_vision_image(path: &Path) -> Result<Vec<String>, String> {
    let bytes = std::fs::read(path).map_err(|_| "无法读取截图")?;
    let decoded = image::load_from_memory(&bytes).map_err(|_| "图片解码失败")?;
    let narrowed = if decoded.width() > 2000 || decoded.height() > 2000 {
        decoded.thumbnail(2000, 2000)
    } else {
        decoded
    };

    let render = |img: &image::DynamicImage| -> Result<String, String> {
        let mut png = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|_| "图片压缩失败")?;
        if png.len() > 5 * 1024 * 1024 {
            return Err("图片过大".into());
        }
        let encoded = base64::engine::general_purpose::STANDARD.encode(&png);
        if encoded.len() > 6 * 1024 * 1024 {
            return Err("图片过大".into());
        }
        Ok(encoded)
    };

    // 单图直传：完整原图（不裁剪）。界面干扰由提示词规则处理（左侧列表/搜索框一律忽略），
    // 完整图对各类截图（含无左栏的聊天区截图、网页、表格）都无损。省 token、更快。
    Ok(vec![render(&narrowed)?])
}

/// 识别输入长度上限：超出时按字符截断（避免整屏截图 OCR 文本超模型输入限制）。
fn truncate_document(text: &str) -> String {
    const MAX_CHARS: usize = 4000;
    let trimmed = text.trim();
    let mut count = 0usize;
    let mut end = None;
    for (index, ch) in trimmed.char_indices() {
        count += 1;
        if count == MAX_CHARS {
            end = Some(index + ch.len_utf8());
            break;
        }
    }
    match end {
        Some(end) => format!("{}…（内容过长已截断）", &trimmed[..end]),
        None => trimmed.to_string(),
    }
}

fn decode_attachment_png(encoded: &str) -> Result<Vec<u8>, String> {
    use image::ImageDecoder;
    const MAX_BYTES: usize = 32 * 1024 * 1024;
    if encoded.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("图片超过 32 MB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| "图片格式无效")?;
    if bytes.len() > MAX_BYTES {
        return Err("图片超过 32 MB".into());
    }
    let decoder = image::codecs::png::PngDecoder::new(std::io::Cursor::new(&bytes))
        .map_err(|_| "图片格式无效")?;
    let (width, height) = decoder.dimensions();
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 32_000_000 {
        return Err("截图尺寸过大".into());
    }
    image::DynamicImage::from_decoder(decoder).map_err(|_| "图片内容不完整或无法读取")?;
    Ok(bytes)
}

#[tauri::command]
pub async fn pometodo_import_attachment(
    app: tauri::AppHandle,
    png: String,
) -> Result<String, String> {
    // Receives only bytes selected/dropped by the user, never an arbitrary filesystem path.
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = decode_attachment_png(&png)?;
        let state = app.state::<StorageState>();
        let guard = state.inner.lock().map_err(|_| "截图存储不可用")?;
        guard
            .as_ref()
            .map_err(Clone::clone)?
            .attachment_store()?
            .save_png(&bytes)
    })
    .await
    .map_err(|_| "添加截图未完成".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_extract::{ExtractionWarning, ParsedExtraction};
    #[test]
    fn imported_image_is_validated_before_storage() {
        let encode = |bytes| base64::engine::general_purpose::STANDARD.encode(bytes);
        let fixture = include_bytes!("../tests/fixtures/local-ocr.png");
        assert_eq!(
            decode_attachment_png(&encode(fixture.as_slice())).unwrap(),
            fixture
        );
        assert!(decode_attachment_png(&encode(b"not an image".as_slice())).is_err());
        assert!(decode_attachment_png(&encode(&fixture[..40])).is_err());
        assert!(decode_attachment_png("not base64!").is_err());
    }

    fn local() -> RecognitionDraft {
        RecognitionDraft {
            attachment_paths: vec!["synthetic-image".into()],
            customer_name: None,
            note: None,
        }
    }

    #[test]
    fn failed_ai_keeps_screenshot_without_overwriting_any_manual_field() {
        let result = finish_recognition(local(), Err("请求超时".into()), "本地读取".into());
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["kind"], "local");
        for field in ["title", "receivedAt", "dueAt"] {
            assert!(
                value["draft"].get(field).is_none(),
                "must preserve manual {field}"
            );
        }
        assert!(
            value["draft"].get("note").map_or(true, |v| v.is_null()),
            "note 保持为空"
        );
        assert!(
            value["draft"]
                .get("customerName")
                .map_or(true, |v| v.is_null()),
            "customerName 保持为空"
        );
        assert_eq!(value["draft"]["attachmentPaths"][0], "synthetic-image");
        assert!(value["draft"].get("dueAt").is_none());
        assert!(value["message"].as_str().unwrap().contains("请求超时"));
    }

    #[test]
    fn successful_ai_clears_missing_deadline_and_explains_date_warnings() {
        let parsed = ParsedExtraction {
            customer_name: None,
            title: Some("核对初稿".into()),
            note: None,
            received_at: None,
            due_at: None,
            warnings: vec![ExtractionWarning::InvalidDueDate],
        };
        let value = serde_json::to_value(finish_recognition(
            local(),
            Ok(Some(parsed)),
            "本地读取".into(),
        ))
        .unwrap();
        assert_eq!(value["kind"], "ai");
        assert_eq!(value["draft"]["title"], "核对初稿");
        assert!(value["draft"].get("dueAt").unwrap().is_null());
        assert_eq!(value["draft"]["attachmentPaths"][0], "synthetic-image");
        assert!(value["message"].as_str().unwrap().contains("完成日期"));
    }


    #[test]
    fn official_vision_sends_original_image_and_never_falls_back_to_text() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-06T10:00:00+08:00").unwrap();
        let base = ParsedExtraction {
            title: Some("核对初稿".into()),
            customer_name: None,
            note: None,
            received_at: None,
            due_at: None,
            warnings: vec![],
        };
        // 直传成功：complete 收到图片 base64。
        let mut saw_vision = false;
        let result = arrange_clipboard(
            || Ok(("official".into(), String::new())),
            || {
                Ok(ClipboardInput {
                    text: String::new(),
                    attachment: Some("img".into()),
                })
            },
            |_| {
                let mut document = crate::local_extract::LocalDocument::default();
                document.text = "虚构客户：请核对初稿".into();
                Ok(document)
            },
            |id| {
                assert_eq!(id, "img");
                Ok(vec!["BASE64PNG".into()])
            },
            |_, _, _, _, vision| {
                assert_eq!(vision, Some(&["BASE64PNG".to_string()][..]));
                saw_vision = true;
                Ok(Some(base.clone()))
            },
            now,
        )
        .unwrap();
        assert!(saw_vision);
        assert_eq!(
            serde_json::to_value(result).unwrap()["draft"]["title"],
            "核对初稿"
        );
        // 直传失败（模型/网络错误或截图无法处理）：直接报错，不降级为整屏 OCR 文本。
        let mut calls = 0;
        let result = arrange_clipboard(
            || Ok(("official".into(), String::new())),
            || {
                Ok(ClipboardInput {
                    text: String::new(),
                    attachment: Some("img".into()),
                })
            },
            |_| panic!("official 直传路径不得使用本地 OCR"),
            |_| Ok(vec!["BASE64PNG".into()]),
            |_, _, _, _, vision| {
                calls += 1;
                assert!(vision.is_some(), "只允许带图调用");
                Err("直传失败".into())
            },
            now,
        );
        assert_eq!(calls, 1, "失败后不得再次用文本调用");
        let value = serde_json::to_value(result.unwrap()).unwrap();
        assert_eq!(value["kind"], "local");
        assert!(
            value["message"].as_str().unwrap().contains("直传失败"),
            "失败以明确提示呈现: {value}"
        );
    }

    #[test]
    fn official_vision_failure_via_processing_never_falls_back_to_text() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-06T10:00:00+08:00").unwrap();
        let result = arrange_clipboard(
            || Ok(("official".into(), String::new())),
            || {
                Ok(ClipboardInput {
                    text: String::new(),
                    attachment: Some("img".into()),
                })
            },
            |_| panic!("official 路径不得使用本地 OCR"),
            |_| Err("图片解码失败".into()),
            |_, _, _, _, _| panic!("截图处理失败不得继续调用模型"),
            now,
        );
        let value = serde_json::to_value(result.unwrap()).unwrap();
        assert_eq!(value["kind"], "local");
        assert!(
            value["message"].as_str().unwrap().contains("截图无法识别"),
            "失败以明确提示呈现: {value}"
        );
    }

    #[test]
    fn summary_only_keeps_screenshot_and_key_points_in_note_without_ai_success() {
        let parsed = ParsedExtraction {
            customer_name: None,
            title: None,
            note: Some("10 分钟后热饭，热好就关火".into()),
            received_at: None,
            due_at: None,
            warnings: vec![],
        };
        let value = serde_json::to_value(finish_recognition(
            local(),
            Ok(Some(parsed)),
            "本地读取".into(),
        ))
        .unwrap();
        assert_eq!(value["kind"], "local");
        assert_eq!(value["draft"]["note"], "10 分钟后热饭，热好就关火");
        assert_eq!(value["draft"]["attachmentPaths"][0], "synthetic-image");
        assert!(value["message"].as_str().unwrap().contains("关键信息"));
    }

    #[test]
    fn local_reading_preserves_manual_dates_and_never_claims_ai_success() {
        let value = serde_json::to_value(finish_recognition(
            local(),
            Ok(None),
            "未配置 AI，已读取原文".into(),
        ))
        .unwrap();
        assert_eq!(value["kind"], "local");
        assert!(value["draft"].get("dueAt").is_none());
    }

    #[test]
    fn recognition_permit_rejects_overlap_and_releases_after_failure() {
        let first = RecognitionPermit::acquire().unwrap();
        assert!(RecognitionPermit::acquire().is_err());
        drop(first);
        assert!(RecognitionPermit::acquire().is_ok());
    }

    #[test]
    fn byok_vision_sends_image_first_and_never_ocrs() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-06T10:00:00+08:00").unwrap();
        let parsed = ParsedExtraction {
            customer_name: Some("虚构客户".into()),
            title: Some("核对初稿".into()),
            note: None,
            received_at: None,
            due_at: None,
            warnings: vec![],
        };
        let result = arrange_clipboard(
            || Ok(("qwen".into(), "byok-key".into())),
            || Ok(ClipboardInput { text: String::new(), attachment: Some("img".into()) }),
            |_| panic!("视觉直传成功时不得使用本地 OCR"),
            |id| { assert_eq!(id, "img"); Ok(vec!["BASE64PNG".into()]) },
            |_, _, _, _, vision| {
                assert_eq!(vision, Some(&["BASE64PNG".to_string()][..]));
                Ok(Some(parsed.clone()))
            },
            now,
        ).unwrap();
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["kind"], "ai");
        assert_eq!(value["draft"]["title"], "核对初稿");
    }

    #[test]
    fn byok_vision_failure_falls_back_to_ocr_text_without_image() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-06T10:00:00+08:00").unwrap();
        let mut calls = 0;
        let result = arrange_clipboard(
            || Ok(("glm".into(), "byok-key".into())),
            || Ok(ClipboardInput { text: String::new(), attachment: Some("img".into()) }),
            |_| {
                let mut document = crate::local_extract::LocalDocument::default();
                document.text = "虚构客户：请核对初稿".into();
                Ok(document)
            },
            |_| Err("模型无视觉权限".into()),
            |_, _, _, _, vision| {
                calls += 1;
                assert!(vision.is_none(), "降级路径不带图");
                Ok(Some(ParsedExtraction { customer_name: None, title: Some("核对初稿".into()), note: None, received_at: None, due_at: None, warnings: vec![] }))
            },
            now,
        ).unwrap();
        assert_eq!(calls, 1);
        assert_eq!(serde_json::to_value(result).unwrap()["draft"]["title"], "核对初稿");
    }

    #[test]
    fn rejected_selection_never_reads_clipboard_ocr_or_model() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-06T10:00:00+08:00").unwrap();
        let result = arrange_clipboard(
            || Err("智能整理尚未开启".into()),
            || panic!("must not read clipboard"),
            |_| panic!("must not OCR"),
            |_| panic!("must not read vision"),
            |_, _, _, _, _| panic!("must not call model"),
            now,
        );
        assert!(matches!(result, Err(message) if message == "智能整理尚未开启"));
    }

    #[test]
    fn three_byok_providers_pipeline_http_parse_and_sqlite_reopen() {
        use pometodo_core::{
            local::LocalStorage,
            models::TodoDraft,
            smart_arrange::{SmartArrangePreferences, SmartArrangeSource},
        };
        for provider in ["deepseek", "qwen", "glm"] {
            for image_input in [false, true] {
                let dir = tempfile::tempdir().unwrap();
                let mut storage = LocalStorage::open(dir.path()).unwrap();
                storage
                    .repo
                    .update_settings(serde_json::json!({"aiProvider":provider}))
                    .unwrap();
                storage
                    .repo
                    .set_smart_arrange_preferences(SmartArrangePreferences {
                        enabled: true,
                        source: SmartArrangeSource::Byok,
                    })
                    .unwrap();
                crate::secrets::KeyStore::new(&storage.profile_directory.join("secrets"))
                    .save(provider, "synthetic-only-key")
                    .unwrap();
                let png = include_bytes!("../tests/fixtures/local-ocr.png");
                let attachment = storage.attachment_store().unwrap().save_png(png).unwrap();
                let content = serde_json::json!({"customerName":"虚构客户","title":"核对初稿","note":"测试说明","receivedAt":null,"dueAt":null}).to_string();
                let envelope = serde_json::json!({"choices":[{"message":{"role":"assistant","content":content},"finish_reason":"stop"}]}).to_string();
                let (url, server) = crate::ai_http::tests::server(
                    "200 OK",
                    "",
                    envelope,
                    std::time::Duration::ZERO,
                );
                let result = arrange_clipboard(
                    || crate::smart_arrange::selected_user_key(&storage),
                    || {
                        Ok(ClipboardInput {
                            text: if image_input {
                                String::new()
                            } else {
                                "虚构客户：请核对初稿".into()
                            },
                            attachment: Some(attachment.clone()),
                        })
                    },
                    |_| {
                        assert!(image_input);
                        let mut document = crate::local_extract::LocalDocument::default();
                        document.text = "虚构客户：请核对初稿".into();
                        Ok(document)
                    },
                    |_| {
                        // 视觉模型对中转/无视觉 key 可能失败：降级 OCR 文本路径（本用例专测降级）。
                        assert!(image_input);
                        Err("vision_not_available".into())
                    },
                    |selected, key, text, context, _vision| {
                        assert_eq!(selected, provider);
                        assert_eq!(
                            context.kind,
                            if image_input {
                                InputKind::Ocr
                            } else {
                                InputKind::Text
                            }
                        );
                        extract_text(text, context, |messages| {
                            AiHttp::complete_loopback(&url, selected, key, messages)
                                .map_err(|e| e.to_string())
                        })
                    },
                    chrono::DateTime::parse_from_rfc3339("2026-09-06T10:00:00+08:00").unwrap(),
                )
                .unwrap();
                let request = server.join().unwrap();
                assert!(request.contains("synthetic-only-key"));
                let RecognitionResult::Ai { draft, .. } = result else {
                    panic!("expected parsed AI result")
                };
                let saved = storage
                    .repo
                    .create(TodoDraft {
                        customer_name: draft.customer_name.unwrap(),
                        title: draft.title,
                        note: draft.note.unwrap(),
                        received_at: "2026-09-06T10:00:00+08:00".into(),
                        due_at: draft.due_at,
                        attachment_paths: draft.attachment_paths,
                        category: None,
                        reminder_at: None,
                    })
                    .unwrap();
                drop(storage);
                let reopened = LocalStorage::open(dir.path()).unwrap();
                let tasks = reopened.repo.list().unwrap();
                assert_eq!(tasks[0].id, saved.id);
                assert_eq!(tasks[0].title, "核对初稿");
                assert_eq!(
                    std::fs::read(
                        reopened
                            .attachment_store()
                            .unwrap()
                            .path_for(&attachment)
                            .unwrap()
                    )
                    .unwrap(),
                    png
                );
            }
        }
    }
}

struct ClipboardInput {
    text: String,
    attachment: Option<String>,
}

// 依赖边界用于隔离剪贴板/本地 OCR/HTTP；生产与离线联测执行同一个流程。
/// 聊天/截图识别编排：
/// 官方服务截图 → 原图视觉直传（模型自行区分界面区域，不做本地裁剪/规则）；
/// 直传失败 → 明确报错，不降级为「整屏 OCR 文本」——无图文本会把左栏界面文字当成聊天内容（串词根源）。
/// 自带 Key 截图 → OCR 文本路径（自带模型按文字接口处理）；文本剪贴板 → 直接识别。
fn arrange_clipboard(
    select: impl FnOnce() -> Result<(String, String), String>,
    read: impl FnOnce() -> Result<ClipboardInput, String>,
    ocr: impl FnMut(&str) -> Result<crate::local_extract::LocalDocument, String>,
    vision: impl FnMut(&str) -> Result<Vec<String>, String>,
    complete: impl FnMut(
        &str,
        &str,
        &str,
        &ExtractionContext,
        Option<&[String]>,
    ) -> Result<Option<ParsedExtraction>, String>,
    now: chrono::DateTime<chrono::FixedOffset>,
) -> Result<RecognitionResult, String> {
    let (provider, key) = select()?;
    let input = read()?;
    let kind = if input.text.trim().is_empty() {
        InputKind::Ocr
    } else {
        InputKind::Text
    };
    let context = ExtractionContext { now, kind };
    let attachment_paths = input.attachment.clone().into_iter().collect::<Vec<_>>();
    let is_text_mode = !input.text.trim().is_empty();
    let mut ocr = ocr;
    let mut vision = vision;
    let mut complete = complete;

    let extracted: Result<Option<ParsedExtraction>, String> = if is_text_mode {
        complete(&provider, &key, &input.text, &context, None)
    } else {
        match input.attachment.as_deref() {
            None => {
                return Ok(RecognitionResult::Empty {
                    message: "剪贴板中没有文字或截图".into(),
                })
            }
            Some(id) => {
                if provider == "official" {
                    // 只走原图直传。失败即报错重试，不换无图文本路径（串词隐患）。
                    match vision(id) {
                        Ok(images) => complete(&provider, &key, "", &context, Some(&images)),
                        Err(error) => Err(format!("截图无法识别：{error}，请重试或换更清晰的截图")),
                    }
                } else {
                    // 自带 Key：视觉直传优先（AI 直接识图）；任何失败回退 OCR 文本（兼容无视觉模型/中转 key）。
                    let vision_result = vision(id)
                        .and_then(|images| complete(&provider, &key, "", &context, Some(&images)));
                    match vision_result {
                        Ok(value) => Ok(value),
                        Err(_) => match ocr(id) {
                            Ok(document) => {
                                let text = truncate_document(&document.text);
                                complete(&provider, &key, &text, &context, None)
                            }
                            Err(error) => Err(error),
                        },
                    }
                }
            }
        }
    };
    Ok(finish_recognition(
        RecognitionDraft {
            attachment_paths,
            customer_name: None,
            note: None,
        },
        extracted,
        "未读出文字，请手动填写".into(),
    ))
}

/// 共享识别编排：选择来源、读取输入、OCR/视觉压缩、调用模型与兜底降级。
/// 识别追踪日志（仅元信息：模式/附件id/结果类型；不含正文与密钥）。
fn trace_recognition(
    app: &tauri::AppHandle,
    mode: &str,
    id: Option<&str>,
    result: &Result<RecognitionResult, String>,
) {
    let kind = match result {
        Ok(value) => serde_json::to_value(value)
            .map(|v| v["kind"].as_str().map_or("ai?".into(), |k| k.to_string()))
            .unwrap_or_else(|_| "?".into()),
        Err(_) => "error".into(),
    };
    let root = {
        let state = app.state::<StorageState>();
        let guard = state.inner.lock().ok();
        guard
            .and_then(|guard| {
                guard
                    .as_ref()
                    .ok()
                    .map(|storage| storage.profile_directory.clone())
            })
            .map(|path| path.clone())
    };
    let Some(root) = root else { return };
    let _ = std::fs::create_dir_all(root.join("logs"));
    let line = format!(
        "[{}] mode={} id={} result={}
",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
        mode,
        id.unwrap_or("-"),
        kind
    );
    let _ = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("logs").join("recognize.log"))
        .and_then(|mut file| std::io::Write::write_all(&mut file, line.as_bytes()));
}

fn run_recognition(
    app: &tauri::AppHandle,
    read: impl FnOnce() -> Result<ClipboardInput, String>,
) -> Result<RecognitionResult, String> {
    let (preferences, root) = {
        let state = app.state::<StorageState>();
        let guard = state.inner.lock().map_err(|_| "无法读取智能整理设置")?;
        let storage = guard.as_ref().map_err(Clone::clone)?;
        (
            crate::distribution::effective_preferences(storage.repo.smart_arrange_preferences()?),
            storage.profile_directory.clone(),
        )
    };
    arrange_clipboard(
        || {
            crate::smart_arrange::require_enabled(&preferences)?;
            if preferences.source == pometodo_core::smart_arrange::SmartArrangeSource::Official {
                let (available, message) = crate::service_extension::available(&root)?;
                if !available {
                    return Err(message);
                }
                return Ok(("official".into(), String::new()));
            }
            let state = app.state::<StorageState>();
            let guard = state.inner.lock().map_err(|_| "无法读取智能整理设置")?;
            crate::smart_arrange::selected_user_key(guard.as_ref().map_err(Clone::clone)?)
        },
        read,
        |id| {
            let state = app.state::<StorageState>();
            let path = {
                let guard = state.inner.lock().map_err(|_| "截图存储不可用")?;
                guard
                    .as_ref()
                    .map_err(Clone::clone)?
                    .attachment_store()?
                    .path_for(id)?
            };
            crate::ocr::recognize_document(&path)
        },
        |id| {
            let state = app.state::<StorageState>();
            let path = {
                let guard = state.inner.lock().map_err(|_| "截图存储不可用")?;
                guard
                    .as_ref()
                    .map_err(Clone::clone)?
                    .attachment_store()?
                    .path_for(id)?
            };
            prepare_vision_image(&path)
        },
        |provider, key, text, context, vision| {
            let result = if provider == "official" {
                crate::service_extension::extract(&root, text, context, vision)
            } else if vision.is_some() {
                // 视觉直传仍走首选服务商；失败由上层退回 OCR 文本后再参与切换。
                extract_with_user_key(provider, key, text, context, vision)
            } else {
                // 文本 / OCR 文本：按偏好顺序自动切换到下一个可用 Key。
                let candidates = {
                    let state = app.state::<StorageState>();
                    let guard = state.inner.lock().map_err(|_| "无法读取智能整理设置")?;
                    crate::smart_arrange::candidate_user_keys(guard.as_ref().map_err(Clone::clone)?)
                }?;
                let mut last: Option<String> = None;
                let mut final_result: Result<Option<ParsedExtraction>, String> =
                    Err("没有可用的服务商".into());
                for (candidate_provider, candidate_key) in candidates {
                    match extract_with_user_key(&candidate_provider, &candidate_key, text, context, None)
                    {
                        Ok(value) => {
                            final_result = Ok(value);
                            break;
                        }
                        Err(error) => {
                            if !failover_eligible(&error) {
                                final_result = Err(error);
                                break;
                            }
                            last = Some(error);
                        }
                    }
                }
                final_result.or_else(|_| Err(last.unwrap_or_else(|| "没有可用的服务商".into())))
            };
            // 图片整理失败时给出更具体的引导；网络等其他失败保持原提示。
            result.map_err(|error| {
                if context.kind == InputKind::Ocr && error.contains("未能整理出待办") {
                    "未能从截图整理出待办，可换更清晰的截图或手动填写".into()
                } else {
                    error
                }
            })
        },
        chrono::Local::now().fixed_offset(),
    )
}

/// 粘贴并整理：识别剪贴板内容。
#[tauri::command]
pub async fn pometodo_recognize_clipboard(
    app: tauri::AppHandle,
) -> Result<RecognitionResult, String> {
    let permit = RecognitionPermit::acquire()?;
    let read = {
        let app = app.clone();
        move || {
            let mut clipboard =
                arboard::Clipboard::new().map_err(|_| "剪贴板暂时不可用".to_string())?;
            let text = match clipboard.get_text() {
                Ok(text) => text,
                Err(arboard::Error::ContentNotAvailable) => String::new(),
                Err(_) => return Err("剪贴板正在使用，请重新复制后重试".into()),
            };
            // 依次尝试：剪贴板位图/PNG → 复制的图片文件 → 有文字走文本识别，最后才提示。
            let attachment = match save_image(&mut clipboard, &app) {
                Ok(Some(value)) => Some(value),
                Ok(None) | Err(_) => match read_clipboard_image_file() {
                    Ok(Some(bytes)) => Some(image_bytes_to_png_attachment(&bytes, &app)?),
                    Ok(None) | Err(_) if !text.trim().is_empty() => None,
                    Ok(None) | Err(_) => {
                        return Err("剪贴板中没有可识别的截图，请重新截图或把图片拖入附件框".into())
                    }
                },
            };
            Ok(ClipboardInput { text, attachment })
        }
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let result = run_recognition(&app, read);
        trace_recognition(&app, "clipboard", None, &result);
        result
    })
    .await
    .map_err(|_| "读取剪贴板未完成".to_string())?
}

/// 粘贴并整理：优先识别附件箱中最新的一张截图。
#[tauri::command]
pub async fn pometodo_recognize_attachment(
    app: tauri::AppHandle,
    id: String,
) -> Result<RecognitionResult, String> {
    let permit = RecognitionPermit::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let result = run_recognition(&app, || {
            Ok(ClipboardInput {
                text: String::new(),
                attachment: Some(id.clone()),
            })
        });
        trace_recognition(&app, "attachment", Some(&id), &result);
        result
    })
    .await
    .map_err(|_| "读取附件识别未完成".to_string())?
}

/// 移动端：直接对传入的文本做 AI 整理（读不了系统剪贴板时用）。
#[tauri::command]
pub async fn pometodo_arrange_text(
    app: tauri::AppHandle,
    text: String,
) -> Result<RecognitionResult, String> {
    let permit = RecognitionPermit::acquire()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let result = run_recognition(&app, || {
            Ok(ClipboardInput { text, attachment: None })
        });
        trace_recognition(&app, "arrange_text", None, &result);
        result
    })
    .await
    .map_err(|_| "文本整理未完成".to_string())?
}
