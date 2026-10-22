//! 无模型的基础填表：只使用明确字段和识字版面，不推断自然语言日期。
#[derive(Clone, Debug, Default)]
pub struct TextLine {
    pub text: String,
    pub top: f32,
    pub bottom: f32,
    /// 水平坐标（OCR 像素）；用于区分左侧历史列表与右侧当前对话区。
    pub x_left: f32,
    pub x_right: f32,
}

#[derive(Clone, Default, Debug)]
pub struct LocalDocument {
    pub text: String,
    /// 截图宽度（OCR 像素），用于右侧对话区比例过滤。
    pub width: f32,
    pub customer: String,
    /// 带坐标的行（按 top 排序）。
    pub lines: Vec<TextLine>,
    pub blocks: Vec<String>,
    pub latest_message: bool,
}

#[derive(Default, Debug)]
pub struct LocalFields {
    pub customer: String,
    pub title: String,
    pub note: String,
}

/// 右侧对话区过滤：聊天软件界面左侧约 1/3 是历史会话列表，不属于当前内容。
/// 从原文档重建一份只含右区行的文档（头部客户名与最后消息按行结构重算）。
pub fn right_region(document: &LocalDocument, fraction: f32) -> LocalDocument {
    if document.width <= 0.0 || document.lines.is_empty() {
        return document.clone();
    }
    let threshold = document.width * fraction;
    let right: Vec<TextLine> = document
        .lines
        .iter()
        .filter(|line| line.x_left >= threshold)
        .cloned()
        .collect();
    if right.is_empty() {
        return document.clone();
    }
    from_ocr(right, 0.0, document.width)
}

fn cjk(character: char) -> bool {
    matches!(
        character,
        '\u{3400}'..='\u{9fff}' | '，' | '。' | '；' | '：' | '、' | '！' | '？'
    )
}

fn normalize_ocr_line(text: &str) -> String {
    let chars: Vec<char> = text.trim().chars().collect();
    let mut result = String::new();
    for (index, character) in chars.iter().enumerate() {
        if character.is_whitespace() {
            let previous = result.chars().last();
            let next = chars[index + 1..]
                .iter()
                .find(|c| !c.is_whitespace())
                .copied();
            if previous.is_some_and(cjk) && next.is_some_and(cjk) {
                continue;
            }
            if result.ends_with(' ') {
                continue;
            }
            result.push(' ');
        } else {
            result.push(*character);
        }
    }
    result
}

fn is_timestamp(text: &str) -> bool {
    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
    let Some((prefix, minutes)) = compact.rsplit_once([':', '：']) else {
        return false;
    };
    if minutes.len() != 2 || !minutes.bytes().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let hour_start = prefix
        .char_indices()
        .rev()
        .find(|(_, c)| !c.is_ascii_digit())
        .map_or(0, |(i, c)| i + c.len_utf8());
    let (label, hour) = prefix.split_at(hour_start);
    if !(1..=2).contains(&hour.len())
        || hour.parse::<u8>().map_or(true, |h| h > 23)
        || minutes.parse::<u8>().map_or(true, |m| m > 59)
    {
        return false;
    }
    label.is_empty()
        || matches!(label, "今天" | "昨天" | "前天" | "上午" | "下午" | "晚上")
        || ((label.starts_with("星期") || label.starts_with('周')) && label.chars().count() <= 3)
        || label
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '-' | '/' | '年' | '月' | '日'))
}

pub fn from_text(text: &str) -> LocalDocument {
    let blocks: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    LocalDocument {
        text: blocks.join("\n"),
        blocks,
        ..Default::default()
    }
}

pub fn from_ocr(mut lines: Vec<TextLine>, image_height: f32, image_width: f32) -> LocalDocument {
    lines.sort_by(|a, b| a.top.total_cmp(&b.top));
    for line in &mut lines {
        line.text = normalize_ocr_line(&line.text);
    }
    lines.retain(|line| !line.text.is_empty());
    let has_times = lines.iter().any(|line| is_timestamp(&line.text));
    // 顶部标题候选取「顶部条带」中的行：优先取右侧区域（x>=33%，聊天界面为当前对话标题，
    // 左侧是搜索框/头像/历史列表等干扰），搜索框关键词剔除；无右区候选时回退顶部首行。
    let top_lines: Vec<&TextLine> = lines
        .iter()
        .filter(|line| line.top < image_height * 0.12)
        .collect();
    let mut header_candidate: Option<&TextLine> = None;
    let mut first_any: Option<&TextLine> = None;
    for line in top_lines {
        if line.text.chars().count() > 30
            || is_timestamp(&line.text)
            || line.text.contains([':', '：', '，', '。', '！', '？'])
        {
            continue;
        }
        if first_any.is_none() {
            first_any = Some(line);
        }
        if line.x_left >= image_width * 0.33
            && !line.text.contains("搜索")
            && !line.text.contains("Search")
        {
            header_candidate = Some(line);
            break;
        }
        if header_candidate.is_none() && line.x_left >= image_width * 0.33 {
            header_candidate = Some(line);
        }
    }
    let header = (header_candidate.or(first_any)).filter(|first| {
        has_times
            && first.top < image_height * 0.12
            && first.text.chars().count() <= 30
            && !is_timestamp(&first.text)
            && !first.text.contains([':', '：', '，', '。', '！', '？'])
            && lines
                .iter()
                .find(|next| next.text != first.text)
                .is_some_and(|next| next.top - first.bottom > (first.bottom - first.top) * 2.0)
            && (image_width <= 0.0 || first.x_left > 0.0 || true)
    });
    let mut document = LocalDocument {
        text: lines
            .iter()
            .map(|line| line.text.as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        customer: header.map_or(String::new(), |line| line.text.clone()),
        latest_message: header.is_some(),
        ..Default::default()
    };
    let mut previous_bottom = None;
    for (index, line) in lines.iter().enumerate() {
        if header.is_some() && (index == 0 || is_timestamp(&line.text)) {
            previous_bottom = None;
            continue;
        }
        let joins_previous = previous_bottom
            .is_some_and(|bottom| line.top - bottom <= (line.bottom - line.top).max(1.0) * 0.8);
        if joins_previous {
            let block = document.blocks.last_mut().unwrap();
            block.push('\n');
            block.push_str(&line.text);
        } else {
            document.blocks.push(line.text.clone());
        }
        previous_bottom = Some(line.bottom);
    }
    document
}

fn labeled(text: &str) -> Option<(&str, &str)> {
    text.split_once([':', '：'])
        .map(|(label, value)| (label.trim(), value.trim()))
}

pub fn extract(document: &LocalDocument) -> LocalFields {
    let mut fields = LocalFields {
        customer: document.customer.clone(),
        ..Default::default()
    };
    let mut explicit = false;
    let mut remaining = Vec::new();
    for line in document.text.lines() {
        match labeled(line) {
            Some(("客户" | "客户名称" | "甲方" | "来源", value)) if !value.is_empty() => {
                if fields.customer.is_empty() {
                    fields.customer = value.to_string();
                } else {
                    remaining.push(line.to_string());
                }
                explicit = true;
            }
            Some(("任务" | "任务内容" | "待办" | "待办事项", value)) if !value.is_empty() =>
            {
                if fields.title.is_empty() {
                    fields.title = value.to_string();
                } else {
                    remaining.push(line.to_string());
                }
                explicit = true;
            }
            Some(("备注", value)) => remaining.push(value.to_string()),
            _ if !(document.latest_message && is_timestamp(line)) && line != document.customer => {
                remaining.push(line.to_string())
            }
            _ => {}
        }
    }
    let blocks = if explicit {
        &remaining
    } else {
        &document.blocks
    };
    let chosen = if fields.title.is_empty() && !blocks.is_empty() {
        Some(if !explicit && document.latest_message {
            blocks.len() - 1
        } else {
            0
        })
    } else {
        None
    };
    if let Some(index) = chosen {
        fields.title = blocks[index].lines().fold(String::new(), |mut text, line| {
            if !text.is_empty()
                && !(text.chars().last().is_some_and(cjk) && line.chars().next().is_some_and(cjk))
            {
                text.push(' ');
            }
            text.push_str(line);
            text
        });
    }
    let too_long = fields.title.chars().count() > 80;
    let mut notes: Vec<String> = blocks
        .iter()
        .enumerate()
        .filter(|(index, _)| Some(*index) != chosen || too_long)
        .map(|(_, text)| text.clone())
        .collect();
    if too_long {
        if chosen.is_none() {
            notes.insert(0, fields.title.clone());
        }
        fields.title = fields.title.chars().take(80).collect();
    }
    fields.note = notes.join("\n");
    fields
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(text: &str, top: f32) -> TextLine {
        TextLine {
            text: text.into(),
            top,
            bottom: top + 24.0,
            x_left: 0.0,
            x_right: 100.0,
        }
    }
    #[test]
    fn screenshot_keeps_layout_and_prefills_header_and_latest_message() {
        let doc = from_ocr(
            vec![
                line("星 河 示 例 客 户", 20.0),
                line("星期五 14：56", 200.0),
                line("示例图片上的文字", 350.0),
                line("昨天 10:25", 540.0),
                line("请 准 备 一 份 测 试 说 明，", 600.0),
                line("时 间 待 确 认。", 630.0),
            ],
            800.0,
            800.0,
        );
        let fields = extract(&doc);
        assert_eq!(fields.customer, "星河示例客户");
        assert_eq!(fields.title, "请准备一份测试说明，时间待确认。");
        assert_eq!(fields.note, "示例图片上的文字");
        assert!(doc.text.contains('\n'));
        assert!(!fields.note.contains("10:25"));
    }
    #[test]
    fn plain_text_uses_first_line_as_title_and_preserves_remaining_lines() {
        let fields = extract(&from_text("准备测试说明\n附上英文 API Key 使用方法"));
        assert_eq!(fields.customer, "");
        assert_eq!(fields.title, "准备测试说明");
        assert_eq!(fields.note, "附上英文 API Key 使用方法");
    }
    #[test]
    fn explicit_fields_take_precedence_and_other_details_are_retained() {
        let fields = extract(&from_text(
            "客户：星河工作室\n任务：核对初稿\n备注：等待反馈\n交付：待确认",
        ));
        assert_eq!(fields.customer, "星河工作室");
        assert_eq!(fields.title, "核对初稿");
        assert_eq!(fields.note, "等待反馈\n交付：待确认");
    }
    #[test]
    fn unknown_layout_does_not_invent_a_customer_or_discard_long_content() {
        let content = "测试内容".repeat(60);
        let fields = extract(&from_ocr(vec![line(&content, 50.0)], 200.0, 800.0));
        assert_eq!(fields.customer, "");
        assert_eq!(fields.title.chars().count(), 80);
        assert!(fields.note.contains(&content));
        assert_eq!(extract(&from_text(" \n ")).title, "");
    }
    #[test]
    fn ordinary_digits_and_english_spacing_are_not_timestamp_noise() {
        assert!(!is_timestamp("10:25 前确认报价"));
        assert!(!is_timestamp("2026 年展板 20 张"));
        assert_eq!(
            normalize_ocr_line("API Key 测 试 说 明"),
            "API Key 测试说明"
        );
    }
    #[test]
    fn non_chat_time_lines_and_repeated_fields_are_preserved() {
        let fields = extract(&from_text("客户：示例\n任务：确认会议\n10:25"));
        assert_eq!(fields.note, "10:25");
        let document = from_ocr(
            vec![line("会议安排", 100.0), line("10:25", 170.0)],
            200.0,
            800.0,
        );
        assert!(extract(&document).note.contains("10:25"));
        let fields = extract(&from_text(
            "客户：甲方\n任务：准备初稿\n客户：乙方\n任务：发送报价",
        ));
        assert_eq!(fields.customer, "甲方");
        assert_eq!(fields.title, "准备初稿");
        assert_eq!(fields.note, "客户：乙方\n任务：发送报价");
    }
}
