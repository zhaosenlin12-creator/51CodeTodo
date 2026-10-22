use crate::ai_extract::{ExtractionContext, ParsedExtraction};
use std::path::Path;

pub fn available(root: &Path) -> Result<(bool, String), String> {
    #[cfg(feature = "official-services")]
    {
        crate::official::available(root).map(|value| (value.available, value.message))
    }
    #[cfg(not(feature = "official-services"))]
    {
        let _ = root;
        Err("请使用自带 Key 配置智能整理".into())
    }
}

pub fn extract(
    root: &Path,
    text: &str,
    context: &ExtractionContext,
    images: Option<&[String]>,
) -> Result<Option<ParsedExtraction>, String> {
    #[cfg(feature = "official-services")]
    {
        crate::official::extract(root, text, context, images)
    }
    #[cfg(not(feature = "official-services"))]
    {
        let _ = (root, text, context, images);
        Err("请使用自带 Key 配置智能整理".into())
    }
}
