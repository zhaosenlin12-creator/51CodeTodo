//! 团队同步引擎（阶段二 M9）：离线优先，本地先改，联网后 push 上行、pull 增量下行。
//! 后台线程静默运行，网络/凭证错误留下次；手动同步错误直接返回前端展示。
use crate::commands::StorageState;
use crate::sync_http::SyncHttp;
use pometodo_core::models::TodoStatus;
use pometodo_core::sync::{should_accept_remote, Member, SyncTask};
use pometodo_core::store::TodoRepository;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// 内存中的成员列表缓存：避免配置接口每次都打网络；pull/join/members 后刷新。
#[derive(Default)]
pub struct MemberCache {
    inner: Mutex<Vec<Member>>,
}

impl MemberCache {
    pub fn set(&self, members: Vec<Member>) {
        if let Ok(mut guard) = self.inner.lock() {
            *guard = members;
        }
    }

    pub fn snapshot(&self) -> Vec<Member> {
        self.inner
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncSummary {
    pub pushed: usize,
    pub pulled: usize,
    pub rev: i64,
    pub members: Vec<Member>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigSnapshot {
    pub enabled: bool,
    pub server_url: Option<String>,
    pub nickname: Option<String>,
    pub member_id: Option<String>,
    pub has_token: bool,
    pub last_rev: i64,
    pub members: Vec<Member>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfigPatch {
    pub enabled: Option<bool>,
    pub server_url: Option<String>,
    pub access_token: Option<String>,
    pub nickname: Option<String>,
}

fn status_name(status: TodoStatus) -> &'static str {
    match status {
        TodoStatus::Pending => "pending",
        TodoStatus::InProgress => "in_progress",
        TodoStatus::Waiting => "waiting",
        TodoStatus::Completed => "completed",
    }
}

fn build_client(repo: &TodoRepository) -> Result<SyncHttp, String> {
    let url = repo
        .sync_server_url()?
        .ok_or_else(|| "请先填写团队服务器地址".to_string())?;
    SyncHttp::new(&url, repo.sync_access_token()?.as_deref()).map_err(|error| error.to_string())
}

/// 上行：枚举本地待推任务，客户端生成 serverId；新建任务 owner=我的 memberId，
/// 已落库（含远端拉入）的 owner 原样保留不被翻转；rev=本地 sync_rev+1。
fn push_changes(
    repo: &mut TodoRepository,
    client: &SyncHttp,
    member_id: &str,
) -> Result<usize, String> {
    let pending = repo.pending_push_tasks()?;
    if pending.is_empty() {
        return Ok(0);
    }
    let mut changes = Vec::with_capacity(pending.len());
    let mut planned: Vec<(String, String, i64, String)> = Vec::new();
    for task in pending {
        let server_id = task.server_id.clone().unwrap_or_else(|| {
            format!("t_{}", uuid::Uuid::new_v4().simple().to_string())
        });
        let rev = task.sync_rev + 1;
        let sync_task = SyncTask {
            server_id: Some(server_id.clone()),
            title: task.title.clone(),
            note: task.note.clone(),
            customer_name: task.customer_name.clone(),
            status: status_name(task.status).to_string(),
            assignee: task.assignee.clone(),
            // owner 是创建者、不可被后续编辑翻转：已有落库 owner（含远端拉取的任务）原样保留，
            // 仅本地新建、尚无 owner 时才回填当前成员，避免 B 改 A 的任务把 owner 改成 B。
            owner: task.owner.clone().or_else(|| Some(member_id.to_string())),
            due_at: task.due_at.clone(),
            updated_at: task.updated_at.clone(),
            rev,
        };
        changes.push(serde_json::json!({ "op": "upsert", "task": sync_task }));
        planned.push((task.id, server_id, rev, task.updated_at));
    }
    client.push(member_id, &changes).map_err(|error| error.to_string())?;
    let pushed = planned.len();
    for (local_id, server_id, rev, updated_at) in planned {
        repo.mark_pushed(&local_id, &server_id, rev, &updated_at)?;
    }
    Ok(pushed)
}

/// 下行：增量拉取 since 之后的任务；墓碑软删，其余用最后写入胜出判断是否接受。
fn pull_board(
    repo: &mut TodoRepository,
    client: &SyncHttp,
    since: i64,
) -> Result<(usize, i64, Vec<Member>), String> {
    let board = client.board(since).map_err(|error| error.to_string())?;
    let local = repo.list()?;
    let mut applied = 0;
    for remote in board.tasks {
        if remote.deleted.unwrap_or(false) {
            repo.mark_remote_deleted(&remote.serverId, &remote.updatedAt)?;
            applied += 1;
            continue;
        }
        let accept = local
            .iter()
            .find(|task| task.server_id.as_deref() == Some(remote.serverId.as_str()))
            .map(|task| {
                should_accept_remote(&task.updated_at, task.sync_rev, &remote.updatedAt, remote.rev)
            })
            .unwrap_or(true);
        if accept {
            let sync_task = SyncTask {
                server_id: Some(remote.serverId),
                title: remote.title,
                note: remote.note,
                customer_name: remote.customerName,
                status: remote.status,
                assignee: remote.assignee,
                owner: remote.owner,
                due_at: remote.dueAt,
                updated_at: remote.updatedAt,
                rev: remote.rev,
            };
            repo.upsert_remote(&sync_task)?;
            applied += 1;
        }
    }
    Ok((applied, board.rev, board.members))
}

/// 完整一次：先 push 后 pull，成功后落 lastRev。供手动与后台共用。
pub fn synchronize(
    repo: &mut TodoRepository,
    client: &SyncHttp,
) -> Result<SyncSummary, String> {
    let member_id = repo
        .sync_member_id()?
        .ok_or_else(|| "尚未加入团队，请先填写昵称并点击加入".to_string())?;
    let pushed = push_changes(repo, client, &member_id)?;
    let since = repo.sync_last_rev()?;
    let (pulled, rev, members) = pull_board(repo, client, since)?;
    repo.set_sync_last_rev(rev)?;
    Ok(SyncSummary {
        pushed,
        pulled,
        rev,
        members,
    })
}

fn snapshot(repo: &TodoRepository, members: Vec<Member>) -> Result<SyncConfigSnapshot, String> {
    Ok(SyncConfigSnapshot {
        enabled: repo.sync_enabled()?,
        server_url: repo.sync_server_url()?,
        nickname: repo.sync_nickname()?,
        member_id: repo.sync_member_id()?,
        has_token: repo.sync_access_token()?.is_some(),
        last_rev: repo.sync_last_rev()?,
        members,
    })
}

#[tauri::command]
pub async fn pometodo_sync_config_get(
    app: tauri::AppHandle,
) -> Result<SyncConfigSnapshot, String> {
    let members = app.state::<MemberCache>().snapshot();
    crate::commands::with_storage(app, move |storage| snapshot(&storage.repo, members)).await
}

#[tauri::command]
pub async fn pometodo_sync_config_update(
    app: tauri::AppHandle,
    patch: SyncConfigPatch,
) -> Result<SyncConfigSnapshot, String> {
    let members = app.state::<MemberCache>().snapshot();
    crate::commands::with_storage(app.clone(), move |storage| {
        let repo = &mut storage.repo;
        if let Some(enabled) = patch.enabled {
            repo.set_sync_enabled(enabled)?;
        }
        if let Some(url) = patch.server_url {
            let trimmed = url.trim().to_string();
            if !trimmed.is_empty() {
                SyncHttp::new(&trimmed, None).map_err(|error| error.to_string())?;
            }
            repo.set_sync_server_url(Some(trimmed))?;
        }
        if let Some(token) = patch.access_token {
            repo.set_sync_access_token(Some(token))?;
        }
        if let Some(nickname) = patch.nickname {
            let trimmed = nickname.trim().to_string();
            if trimmed.is_empty() {
                return Err("昵称不能为空".into());
            }
            if trimmed.chars().count() > 24 {
                return Err("昵称最长 24 个字".into());
            }
            repo.set_sync_nickname(Some(trimmed))?;
        }
        snapshot(repo, members)
    })
    .await
}

#[tauri::command]
pub async fn pometodo_sync_join(app: tauri::AppHandle) -> Result<Member, String> {
    let member = crate::commands::with_storage(app.clone(), |storage| {
        let repo = &mut storage.repo;
        let nickname = repo
            .sync_nickname()?
            .ok_or_else(|| "请先填写昵称".to_string())?;
        let client = build_client(repo)?;
        let member = client.join(&nickname).map_err(|error| error.to_string())?;
        repo.set_sync_member_id(Some(member.member_id.clone()))?;
        Ok(member)
    })
    .await?;
    // 加入后刷新成员缓存。
    let _ = refresh_members(&app);
    Ok(member)
}

#[tauri::command]
pub async fn pometodo_sync_now(app: tauri::AppHandle) -> Result<SyncSummary, String> {
    let summary = crate::commands::with_storage(app.clone(), |storage| {
        let client = build_client(&storage.repo)?;
        synchronize(&mut storage.repo, &client)
    })
    .await?;
    app.state::<MemberCache>().set(summary.members.clone());
    if summary.pushed > 0 || summary.pulled > 0 {
        let _ = app.emit("pometodo-sync-changed", &summary);
    }
    Ok(summary)
}

#[tauri::command]
pub async fn pometodo_sync_members(app: tauri::AppHandle) -> Result<Vec<Member>, String> {
    let members = crate::commands::with_storage(app.clone(), |storage| {
        let client = build_client(&storage.repo)?;
        client.members().map_err(|error| error.to_string())
    })
    .await?;
    app.state::<MemberCache>().set(members.clone());
    Ok(members)
}

fn refresh_members(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<StorageState>();
    let mut guard = state
        .inner
        .lock()
        .map_err(|_| "数据操作中断，请重启软件".to_string())?;
    let storage = guard.as_mut().map_err(|error| error.clone())?;
    let client = build_client(&storage.repo)?;
    let members = client.members().map_err(|error| error.to_string())?;
    app.state::<MemberCache>().set(members);
    Ok(())
}

/// 后台周期线程：仅在开关开启、地址与 memberId 齐备时运行；错误静默留下次。
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        let _ = background_tick(&app);
        std::thread::sleep(Duration::from_secs(30));
    });
}

fn background_tick(app: &tauri::AppHandle) -> Result<(), String> {
    let summary = {
        let state = app.state::<StorageState>();
        let mut guard = state
            .inner
            .lock()
            .map_err(|_| "数据操作中断，请重启软件".to_string())?;
        let storage = guard.as_mut().map_err(|error| error.clone())?;
        if !storage.repo.sync_enabled()? {
            return Ok(());
        }
        if storage.repo.sync_server_url()?.is_none() {
            return Ok(());
        }
        if storage.repo.sync_member_id()?.is_none() {
            return Ok(());
        }
        let client = build_client(&storage.repo)?;
        synchronize(&mut storage.repo, &client)?
    };
    app.state::<MemberCache>().set(summary.members.clone());
    if summary.pushed > 0 || summary.pulled > 0 {
        let _ = app.emit("pometodo-sync-changed", &summary);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_http::SyncHttpError;
    use crate::sync_http::tests::raw_server;
    use pometodo_core::models::TodoDraft;

    fn draft() -> TodoDraft {
        TodoDraft {
            customer_name: "客户甲".into(),
            title: "待办一件".into(),
            note: "备注".into(),
            received_at: "2026-10-22T09:00:00+08:00".into(),
            due_at: None,
            attachment_paths: vec![],
            category: None,
            reminder_at: None,
        }
    }

    fn prepared_repo(url: &str) -> TodoRepository {
        let mut repo = TodoRepository::open_in_memory().unwrap();
        repo.set_sync_server_url(Some(url.into())).unwrap();
        repo.set_sync_member_id(Some("m_local".into())).unwrap();
        repo.set_sync_last_rev(0).unwrap();
        repo
    }

    #[test]
    fn join_persists_member_id_and_parses_member() {
        let (url, server) = raw_server(
            "/join",
            "200 OK",
            r#"{"memberId":"m_abc","nickname":"小明","joinedAt":"2026-10-22T00:00:00Z"}"#.into(),
        );
        let mut repo = TodoRepository::open_in_memory().unwrap();
        repo.set_sync_server_url(Some(url.clone())).unwrap();
        repo.set_sync_nickname(Some("小明".into())).unwrap();
        let client = SyncHttp::for_test(&url, None).unwrap();
        let member = client.join("小明").unwrap();
        repo.set_sync_member_id(Some(member.member_id.clone())).unwrap();
        assert_eq!(repo.sync_member_id().unwrap().as_deref(), Some("m_abc"));
        let request = server.join().unwrap();
        assert!(request.contains("\"nickname\":\"小明\""));
    }

    #[test]
    fn new_task_push_generates_server_id_and_clears_pending() {
        let (url, server) = raw_server(
            "/push",
            "200 OK",
            r#"{"rev":5,"accepted":1}"#.into(),
        );
        let mut repo = prepared_repo(&url);
        repo.create(draft()).unwrap();
        assert_eq!(repo.pending_push_tasks().unwrap().len(), 1);
        let client = SyncHttp::for_test(&url, None).unwrap();
        let pushed = push_changes(&mut repo, &client, "m_local").unwrap();
        assert_eq!(pushed, 1);
        assert!(repo.pending_push_tasks().unwrap().is_empty());
        let request = server.join().unwrap();
        assert!(request.contains("\"op\":\"upsert\""));
        assert!(request.contains("\"owner\":\"m_local\""));
        assert!(request.contains("t_"));
        // 回填了 serverId 与 rev。
        let task = &repo.list().unwrap()[0];
        assert!(task.server_id.as_deref().unwrap().starts_with("t_"));
        assert_eq!(task.sync_rev, 1);
    }

    #[test]
    fn remote_task_keeps_creator_owner_when_another_member_edits_assignee() {
        // 远端拉入的任务 owner=m_other；本地成员 m_local 只改指派，上行不得把 owner 翻成 m_local。
        let (url, server) = raw_server(
            "/push",
            "200 OK",
            r#"{"rev":5,"accepted":1}"#.into(),
        );
        let mut repo = prepared_repo(&url);
        let remote = repo
            .upsert_remote(&SyncTask {
                server_id: Some("t_owned".into()),
                title: "别人创建的任务".into(),
                note: String::new(),
                customer_name: String::new(),
                status: "pending".into(),
                assignee: None,
                owner: Some("m_other".into()),
                due_at: None,
                updated_at: "2026-10-22T08:00:00Z".into(),
                rev: 3,
            })
            .unwrap();
        repo.set_assignee(&remote.id, Some("m_b".into())).unwrap();
        let client = SyncHttp::for_test(&url, None).unwrap();
        let pushed = push_changes(&mut repo, &client, "m_local").unwrap();
        assert_eq!(pushed, 1);
        let request = server.join().unwrap();
        let body_start = request.find("\r\n\r\n").unwrap() + 4;
        let payload: serde_json::Value = serde_json::from_str(request[body_start..].trim()).unwrap();
        let task = &payload["changes"][0]["task"];
        assert_eq!(task["owner"].as_str(), Some("m_other"));
        assert_ne!(task["owner"].as_str(), Some("m_local"));
        assert_eq!(task["assignee"].as_str(), Some("m_b"));
    }

    #[test]
    fn incremental_pull_creates_remote_task_and_advances_rev() {
        let (url, _server) = raw_server(
            "/board",
            "200 OK",
            r#"{"rev":7,"members":[],"tasks":[{"serverId":"t_remote","title":"远端任务","note":"","customerName":"","status":"pending","assignee":null,"owner":"m_other","dueAt":null,"updatedAt":"2026-10-22T02:00:00Z","rev":7}]}"#.into(),
        );
        let mut repo = prepared_repo(&url);
        let client = SyncHttp::for_test(&url, None).unwrap();
        let (applied, rev, _members) = pull_board(&mut repo, &client, 0).unwrap();
        assert_eq!(applied, 1);
        assert_eq!(rev, 7);
        let tasks = repo.list().unwrap();
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].title, "远端任务");
        assert_eq!(tasks[0].server_id.as_deref(), Some("t_remote"));
    }

    #[test]
    fn older_remote_is_rejected_by_last_write_wins() {
        // 本地已有更新的同 serverId 任务。
        let mut repo = TodoRepository::open_in_memory().unwrap();
        repo.upsert_remote(&SyncTask {
            server_id: Some("t_x".into()),
            title: "本地较新".into(),
            note: String::new(),
            customer_name: String::new(),
            status: "completed".into(),
            assignee: None,
            owner: Some("m_local".into()),
            due_at: None,
            updated_at: "2026-10-22T09:00:00Z".into(),
            rev: 10,
        })
        .unwrap();
        let (url, _server) = raw_server(
            "/board",
            "200 OK",
            r#"{"rev":11,"members":[],"tasks":[{"serverId":"t_x","title":"远端更旧","note":"","customerName":"","status":"pending","assignee":null,"owner":"m_local","dueAt":null,"updatedAt":"2026-10-22T01:00:00Z","rev":3}]}"#.into(),
        );
        let client = SyncHttp::for_test(&url, None).unwrap();
        let (applied, _, _) = pull_board(&mut repo, &client, 0).unwrap();
        assert_eq!(applied, 0);
        let task = &repo.list().unwrap()[0];
        assert_eq!(task.title, "本地较新");
        assert_eq!(task.status, TodoStatus::Completed);
    }

    #[test]
    fn remote_tombstone_soft_deletes_local_task() {
        let (url, _server) = raw_server(
            "/board",
            "200 OK",
            r#"{"rev":9,"members":[],"tasks":[{"serverId":"t_gone","deleted":true,"title":"x","note":"","customerName":"","status":"pending","assignee":null,"owner":null,"dueAt":null,"updatedAt":"2026-10-22T08:00:00Z","rev":9}]}"#.into(),
        );
        let mut repo = prepared_repo(&url);
        // 先有本地同 serverId。
        repo.upsert_remote(&SyncTask {
            server_id: Some("t_gone".into()),
            title: "待删".into(),
            ..Default::default()
        })
        .unwrap();
        let client = SyncHttp::for_test(&url, None).unwrap();
        let (applied, _, _) = pull_board(&mut repo, &client, 0).unwrap();
        assert_eq!(applied, 1);
        assert!(repo.list().unwrap().is_empty());
    }

    #[test]
    fn unauthorized_server_classifies_credentials_error() {
        let (url, _server) = raw_server("/join", "401 Unauthorized", "{}".into());
        let client = SyncHttp::for_test(&url, Some("bad-token")).unwrap();
        assert_eq!(client.join("小明"), Err(SyncHttpError::Credentials));
    }

    #[test]
    fn offline_synchronize_returns_error_without_panic() {
        let mut repo = prepared_repo("http://127.0.0.1:1");
        let client = SyncHttp::for_test("http://127.0.0.1:1", None).unwrap();
        let result = synchronize(&mut repo, &client);
        assert!(result.is_err());
    }
}
