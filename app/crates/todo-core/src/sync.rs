//! 团队同步契约（阶段二）：成员、变更集与合并判断的纯逻辑，不依赖网络与数据库。
//! 客户端离线优先：本地先改，联网后把 Change 上行；服务端按 rev/updatedAt 合并后增量下发。
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub member_id: String,
    pub nickname: String,
    pub joined_at: String,
}

/// 上行/下行的单条任务快照；字段与服务端 board 接口对齐。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncTask {
    pub server_id: Option<String>,
    pub title: String,
    pub note: String,
    pub customer_name: String,
    /// pending / in_progress / waiting / completed
    pub status: String,
    pub assignee: Option<String>,
    pub owner: Option<String>,
    pub due_at: Option<String>,
    pub updated_at: String,
    pub rev: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Change {
    Upsert { task: SyncTask },
    Delete { server_id: String, updated_at: String },
}

/// 最后写入胜出：远端 updatedAt 不早于本地就接受远端；同刻以 rev 大者为准。
pub fn should_accept_remote(
    local_updated_at: &str,
    local_rev: i64,
    remote_updated_at: &str,
    remote_rev: i64,
) -> bool {
    match remote_updated_at.cmp(local_updated_at) {
        std::cmp::Ordering::Greater => true,
        std::cmp::Ordering::Less => false,
        std::cmp::Ordering::Equal => remote_rev >= local_rev,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newer_remote_wins_and_equal_timestamp_uses_rev() {
        assert!(should_accept_remote("2026-10-22T01:00:00Z", 1, "2026-10-22T02:00:00Z", 1));
        assert!(!should_accept_remote("2026-10-22T03:00:00Z", 1, "2026-10-22T02:00:00Z", 9));
        assert!(should_accept_remote("2026-10-22T02:00:00Z", 1, "2026-10-22T02:00:00Z", 2));
        assert!(!should_accept_remote("2026-10-22T02:00:00Z", 2, "2026-10-22T02:00:00Z", 1));
    }

    #[test]
    fn change_serializes_with_op_tag() {
        let change = Change::Upsert {
            task: SyncTask {
                server_id: Some("t_1".into()),
                title: "整理周报".into(),
                status: "pending".into(),
                updated_at: "2026-10-22T02:00:00Z".into(),
                rev: 1,
                ..Default::default()
            },
        };
        let value = serde_json::to_value(&change).unwrap();
        assert_eq!(value["op"], "upsert");
        assert_eq!(value["task"]["title"], "整理周报");
    }
}
