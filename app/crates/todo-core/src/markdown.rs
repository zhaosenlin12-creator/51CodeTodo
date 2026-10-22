use chrono::DateTime;

use crate::models::{TodoStatus, TodoTask};

/// 导出 Markdown：先校验所有时间戳可解析（安装版遇无效时间直接报错），
/// 再生成「# PomeTodo 任务清单」+ 汇总表（| 项目 | 数量 |）+ 分组任务清单。
pub fn render_markdown(tasks: &[TodoTask]) -> Result<String, String> {
    for task in tasks {
        validate_timestamp("接收时间", &task.received_at)?;
        validate_timestamp_opt("交付时间", task.due_at.as_deref())?;
        validate_timestamp_opt("完成时间", task.completed_at.as_deref())?;
    }

    let pending = tasks.iter().filter(|t| t.status == TodoStatus::Pending).count();
    let in_progress = tasks.iter().filter(|t| t.status == TodoStatus::InProgress).count();
    let waiting = tasks.iter().filter(|t| t.status == TodoStatus::Waiting).count();
    let completed = tasks.iter().filter(|t| t.status == TodoStatus::Completed).count();

    let mut out = String::new();
    out.push_str("# PomeTodo 任务清单\n\n");
    out.push_str("## 汇总\n\n");
    out.push_str("| 项目 | 数量 |\n| --- | --- |\n");
    out.push_str(&format!("| 未完成 | {pending} |\n"));
    out.push_str(&format!("| 进行中 | {in_progress} |\n"));
    if waiting > 0 {
        out.push_str(&format!("| 搁置 | {waiting} |\n"));
    }
    out.push_str(&format!("| 已完成 | {completed} |\n"));

    append_section(&mut out, "未完成", tasks, TodoStatus::Pending);
    append_section(&mut out, "进行中", tasks, TodoStatus::InProgress);
    if waiting > 0 {
        append_section(&mut out, "搁置", tasks, TodoStatus::Waiting);
    }
    append_section(&mut out, "已完成", tasks, TodoStatus::Completed);

    Ok(out)
}

fn append_section(out: &mut String, title: &str, tasks: &[TodoTask], status: TodoStatus) {
    let items: Vec<&TodoTask> = tasks.iter().filter(|t| t.status == status).collect();
    if items.is_empty() {
        return;
    }
    out.push_str(&format!("\n## {title}\n\n"));
    for task in items {
        let subject = if task.customer_name.trim().is_empty() {
            task.title.clone()
        } else {
            format!("{}：{}", task.customer_name.trim(), task.title.trim())
        };
        let mut line = format!("- {subject}");
        if let Some(due) = task.due_at.as_deref().and_then(parse_local) {
            line.push_str(&format!("（交付 {due}）"));
        }
        if status == TodoStatus::Completed {
            if let Some(done) = task.completed_at.as_deref().and_then(parse_local) {
                line.push_str(&format!("（完成 {done}）"));
            }
        }
        let note = task.note.trim();
        if !note.is_empty() {
            line.push_str(&format!(" — {note}"));
        }
        out.push_str(&line);
        out.push('\n');
    }
}

fn validate_timestamp(label: &str, value: &str) -> Result<(), String> {
    if DateTime::parse_from_rfc3339(value).is_err() {
        return Err(format!("任务中包含无效{label}，无法导出 Markdown"));
    }
    Ok(())
}

fn validate_timestamp_opt(label: &str, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(value) => validate_timestamp(label, value),
        None => Ok(()),
    }
}

fn parse_local(value: &str) -> Option<String> {
    let date = DateTime::parse_from_rfc3339(value).ok()?;
    let local = date.with_timezone(&chrono::Local);
    Some(local.format("%Y-%m-%d %H:%M").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::TodoStatus;

    fn task(id: &str, status: TodoStatus, due: Option<&str>, completed: Option<&str>) -> TodoTask {
        TodoTask {
            id: id.into(),
            customer_name: "示例客户".into(),
            title: format!("任务{id}"),
            note: "备注".into(),
            status,
            received_at: "2026-09-06T10:00:00+08:00".into(),
            due_at: due.map(str::to_string),
            urgent_at: None,
            completed_at: completed.map(str::to_string),
            attachment_paths: vec![],
            updated_at: "2026-09-06T10:00:00+08:00".into(),
            category: None,
            start_at: None,
            waiting_at: None,
            archived_at: None,
            reminder_at: None,
            reminder_revision: 0,
            created_at: "2026-09-06T10:00:00+08:00".into(),
            server_id: None,
            owner: None,
            assignee: None,
            sync_rev: 0,
        }
    }

    #[test]
    fn renders_summary_table_and_grouped_lists() {
        let md = render_markdown(&[
            task("1", TodoStatus::Pending, Some("2026-09-08T00:00:00+08:00"), None),
            task("2", TodoStatus::InProgress, None, None),
            task("3", TodoStatus::Completed, None, Some("2026-09-07T12:00:00+08:00")),
        ])
        .unwrap();
        assert!(md.starts_with("# PomeTodo 任务清单"));
        assert!(md.contains("| 项目 | 数量 |"));
        assert!(md.contains("| 未完成 | 1 |"));
        assert!(md.contains("| 进行中 | 1 |"));
        assert!(md.contains("| 已完成 | 1 |"));
        assert!(md.contains("## 未完成"));
        assert!(md.contains("## 进行中"));
        assert!(md.contains("## 已完成"));
        assert!(md.contains("交付"));
        assert!(md.contains("完成 2026-09-07 12:00"));
    }

    #[test]
    fn rejects_invalid_timestamp_before_rendering() {
        let mut bad = task("1", TodoStatus::Pending, None, None);
        bad.received_at = "not-a-time".into();
        assert_eq!(
            render_markdown(&[bad]).unwrap_err(),
            "任务中包含无效接收时间，无法导出 Markdown"
        );
    }
}
