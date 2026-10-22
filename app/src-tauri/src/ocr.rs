use crate::local_extract::{LocalDocument, TextLine};
use std::path::Path;

#[cfg(test)]
pub fn recognize_text(path: &Path) -> Result<String, String> {
    recognize_document(path).map(|document| document.text)
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    #[test]
    #[ignore = "需要本机 Windows OCR；只使用生成的虚构聊天图"]
    fn prefills_synthetic_chat_screenshot_offline() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/local-chat.png");
        let document = super::recognize_document(&path).unwrap();
        let fields = crate::local_extract::extract(&document);
        assert_eq!(
            fields.customer, "星河示例客户",
            "虚构图识字结果：{}",
            document.text
        );
        assert!(
            fields.title.contains("请准备一份测试说明"),
            "虚构图字段：{fields:?}"
        );
        // 系统 OCR 可能错字；这里验证最后一行归入任务且不丢失，文字准确率另行如实记录。
        assert!(fields.title.contains(document.text.lines().last().unwrap()));
        assert!(fields.note.contains("示例图片说明"));
    }
    #[test]
    #[ignore = "需要本机 Windows 中文 OCR 组件；显式运行的离线实机检查"]
    fn recognizes_synthetic_chinese_fixture_offline() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/local-ocr.png");
        let result = super::recognize_text(&path).expect("Windows 本地 OCR 应能读取测试图片");
        let compact: String = result.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(compact.contains("示例客户"), "中文识别结果：{result}");
        assert!(compact.contains("12345"), "数字识别结果：{result}");
    }
}

// 基于本机 sltool 的 Windows OCR 调用方式提取；无网络模型调用。
#[cfg(target_os = "windows")]
pub fn recognize_document(path: &Path) -> Result<LocalDocument, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{Interface, PCWSTR};
    use windows::Graphics::Imaging::{BitmapDecoder, IBitmapFrameWithSoftwareBitmap};
    use windows::Storage::Streams::IRandomAccessStream;
    use windows::Win32::System::WinRT::{
        CreateRandomAccessStreamOnFile, RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED,
    };

    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|error| error.to_string())?;
    struct RuntimeGuard;
    impl Drop for RuntimeGuard {
        fn drop(&mut self) {
            unsafe { RoUninitialize() };
        }
    }
    let _runtime = RuntimeGuard;
    let wide_path: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let stream: IRandomAccessStream =
        unsafe { CreateRandomAccessStreamOnFile(PCWSTR(wide_path.as_ptr()), 0) }
            .map_err(|error| error.to_string())?;
    let decoder = BitmapDecoder::CreateAsync(&stream)
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let frame: IBitmapFrameWithSoftwareBitmap =
        decoder.cast().map_err(|error| error.to_string())?;
    let bitmap = frame
        .GetSoftwareBitmapAsync()
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let engine = create_engine().map_err(|error| error.to_string())?;
    let max = windows::Media::Ocr::OcrEngine::MaxImageDimension()
        .map_err(|error| error.to_string())? as i32;
    if bitmap.PixelWidth().map_err(|error| error.to_string())? > max
        || bitmap.PixelHeight().map_err(|error| error.to_string())? > max
    {
        return Err("截图尺寸超过 Windows 识字范围".into());
    }
    let result = engine
        .RecognizeAsync(&bitmap)
        .map_err(|error| error.to_string())?
        .get()
        .map_err(|error| error.to_string())?;
    let lines = result.Lines().map_err(|error| error.to_string())?;
    let mut positioned = Vec::new();
    for index in 0..lines.Size().map_err(|error| error.to_string())? {
        let line = lines.GetAt(index).map_err(|error| error.to_string())?;
        let words = line.Words().map_err(|error| error.to_string())?;
        let mut top = f32::MAX;
        let mut bottom = 0.0_f32;
        let mut x_left = f32::MAX;
        let mut x_right = 0.0_f32;
        for word_index in 0..words.Size().map_err(|error| error.to_string())? {
            let word = words.GetAt(word_index).map_err(|error| error.to_string())?;
            let rect = word.BoundingRect().map_err(|error| error.to_string())?;
            top = top.min(rect.Y);
            bottom = bottom.max(rect.Y + rect.Height);
            x_left = x_left.min(rect.X);
            x_right = x_right.max(rect.X + rect.Width);
        }
        if top.is_finite() && bottom > top {
            positioned.push(TextLine {
                text: line
                    .Text()
                    .map_err(|error| error.to_string())?
                    .to_string_lossy(),
                top,
                bottom,
                x_left,
                x_right,
            });
        }
    }
    Ok(crate::local_extract::from_ocr(
        positioned,
        bitmap.PixelHeight().map_err(|error| error.to_string())? as f32,
        bitmap.PixelWidth().map_err(|error| error.to_string())? as f32,
    ))
}

#[cfg(target_os = "windows")]
fn create_engine() -> windows::core::Result<windows::Media::Ocr::OcrEngine> {
    use windows::{core::HSTRING, Globalization::Language, Media::Ocr::OcrEngine};
    if let Ok(engine) = OcrEngine::TryCreateFromUserProfileLanguages() {
        return Ok(engine);
    }
    for tag in ["zh-Hans", "en-US"] {
        if let Ok(language) = Language::CreateLanguage(&HSTRING::from(tag)) {
            if let Ok(engine) = OcrEngine::TryCreateFromLanguage(&language) {
                return Ok(engine);
            }
        }
    }
    OcrEngine::TryCreateFromUserProfileLanguages()
}

#[cfg(not(target_os = "windows"))]
pub fn recognize_document(_path: &Path) -> Result<LocalDocument, String> {
    Err("当前系统不支持 Windows 本地识字".into())
}
