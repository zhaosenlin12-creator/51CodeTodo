use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TodoStatus {
    Pending,
    InProgress,
    Waiting,
    Completed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoTask {
    pub id: String,
    pub customer_name: String,
    pub title: String,
    pub note: String,
    pub status: TodoStatus,
    pub received_at: String,
    pub due_at: Option<String>,
    pub urgent_at: Option<String>,
    pub completed_at: Option<String>,
    pub attachment_paths: Vec<String>,
    pub updated_at: String,
    // ---- 0.2.6 扩展 ----
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub start_at: Option<String>,
    #[serde(default)]
    pub waiting_at: Option<String>,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub reminder_at: Option<String>,
    #[serde(default)]
    pub reminder_revision: i64,
    #[serde(default)]
    pub created_at: String,
    // ---- 团队同步（阶段二）----
    /// 服务端任务 ID（首次上行后由服务端回填）。
    #[serde(default)]
    pub server_id: Option<String>,
    /// 创建者成员 ID。
    #[serde(default)]
    pub owner: Option<String>,
    /// 被指派人成员 ID。
    #[serde(default)]
    pub assignee: Option<String>,
    /// 同步版本号（本地每次改动 +1，用于增量与冲突判断）。
    #[serde(default)]
    pub sync_rev: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoDraft {
    pub customer_name: String,
    pub title: String,
    pub note: String,
    pub received_at: String,
    pub due_at: Option<String>,
    pub attachment_paths: Vec<String>,
    // ---- 0.2.6 扩展（可空，编辑时可改）----
    #[serde(default)]
    pub category: Option<String>,
    #[serde(default)]
    pub reminder_at: Option<String>,
}
