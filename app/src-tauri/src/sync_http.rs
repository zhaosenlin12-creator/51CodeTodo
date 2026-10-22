//! 团队同步网络层：照搬 ai_http.rs 的安全模式——仅放行 https 与回环 http、
//! 禁止重定向、连接/整体超时、响应体 128KB 硬上限、令牌头敏感标注、状态码归类，
//! 不自动重试。鉴权头使用服务端要求的 `x-access-token`（非 Authorization Bearer）。
use pometodo_core::sync::Member;
use reqwest::blocking::{Client, ClientBuilder};
use reqwest::header::HeaderValue;
use serde::Deserialize;
use serde_json::Value;
use std::io::Read;
use std::time::Duration;

const MAX_HTTP_RESPONSE_BYTES: usize = 131_072;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SyncHttpError {
    /// 401/403：访问令牌无效或缺失。
    Credentials,
    /// 402：服务端要求付费/余额不足。
    Balance,
    /// 429：限流。
    RateLimited,
    /// 5xx：服务暂时不可用。
    Unavailable,
    /// 3xx：返回跳转，已停止跟随。
    Redirect,
    Timeout,
    Network,
    /// 地址不是 https，也不是回环 http。
    InvalidUrl,
    /// 请求构造无效。
    InvalidRequest,
    TooLarge,
    InvalidResponse,
    /// 其他 4xx：服务端拒绝本次请求。
    Rejected,
}

impl std::fmt::Display for SyncHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Credentials => "访问令牌无效或缺失，请检查团队同步设置",
            Self::Balance => "团队服务端提示付费或额度不足",
            Self::RateLimited => "团队服务端限流，请稍后再试",
            Self::Unavailable => "团队服务暂时不可用，请稍后重试",
            Self::Redirect => "团队服务端返回了地址跳转，已停止请求",
            Self::Timeout => "连接团队服务器超时，请检查网络后重试",
            Self::Network => "无法连接团队服务器，请检查网络与地址",
            Self::InvalidUrl => "服务器地址需为 https，或本机回环 http://127.0.0.1",
            Self::InvalidRequest => "同步请求配置无效",
            Self::TooLarge => "团队服务端返回内容过长，已拒绝",
            Self::InvalidResponse => "团队服务端返回了无法识别的数据",
            Self::Rejected => "团队服务端拒绝了本次请求",
        })
    }
}
impl std::error::Error for SyncHttpError {}

fn client_builder(timeout: Duration) -> ClientBuilder {
    Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("PomeTodo/", env!("CARGO_PKG_VERSION")))
}

/// 仅放行 https；http 只允许 127.0.0.1/localhost 本机联调。
fn validate_base(base: &str) -> Result<String, SyncHttpError> {
    let trimmed = base.trim().trim_end_matches('/').to_string();
    if trimmed.is_empty() {
        return Err(SyncHttpError::InvalidUrl);
    }
    let (scheme, rest) = trimmed.split_once("://").ok_or(SyncHttpError::InvalidUrl)?;
    let host = rest.split('/').next().unwrap_or("");
    let host_name = host.split(':').next().unwrap_or("");
    match scheme.to_ascii_lowercase().as_str() {
        "https" => {}
        "http" if host_name == "127.0.0.1" || host_name == "localhost" => {}
        _ => return Err(SyncHttpError::InvalidUrl),
    }
    if host_name.is_empty() {
        return Err(SyncHttpError::InvalidUrl);
    }
    Ok(trimmed)
}

fn sanitize_token(token: Option<&str>) -> Option<String> {
    token
        .map(str::trim)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 8192
                && value.is_ascii()
                && !value.chars().any(char::is_control)
        })
        .map(str::to_string)
}

#[derive(Deserialize)]
struct MembersEnvelope {
    members: Vec<Member>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct BoardEnvelope {
    pub rev: i64,
    pub members: Vec<Member>,
    pub tasks: Vec<BoardTaskDto>,
}

/// 服务端 board 任务快照（camelCase）。
#[derive(Debug, Deserialize)]
#[allow(non_snake_case)]
pub(crate) struct BoardTaskDto {
    pub serverId: String,
    pub title: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub customerName: String,
    pub status: String,
    pub assignee: Option<String>,
    pub owner: Option<String>,
    pub dueAt: Option<String>,
    pub updatedAt: String,
    pub rev: i64,
    #[serde(default)]
    pub deleted: Option<bool>,
}

#[derive(Deserialize)]
struct PushAckDto {
    rev: i64,
}

#[derive(Debug)]
pub struct SyncHttp {
    client: Client,
    base: String,
    token: Option<String>,
}

impl SyncHttp {
    pub fn new(base: &str, token: Option<&str>) -> Result<Self, SyncHttpError> {
        let base = validate_base(base)?;
        let client = client_builder(Duration::from_secs(15))
            .build()
            .map_err(|_| SyncHttpError::Network)?;
        Ok(Self {
            client,
            base,
            token: sanitize_token(token),
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(base: &str, token: Option<&str>) -> Result<Self, SyncHttpError> {
        let base = validate_base(base)?;
        let client = client_builder(Duration::from_secs(3))
            .no_proxy()
            .build()
            .map_err(|_| SyncHttpError::Network)?;
        Ok(Self {
            client,
            base,
            token: sanitize_token(token),
        })
    }

    fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Vec<u8>, SyncHttpError> {
        let url = format!("{}{path}", self.base);
        let mut request = match method {
            reqwest::Method::GET => self.client.get(url),
            reqwest::Method::POST => self.client.post(url).json(body.unwrap_or(&Value::Null)),
            _ => return Err(SyncHttpError::InvalidRequest),
        };
        if let Some(token) = &self.token {
            let mut header = HeaderValue::from_str(token).map_err(|_| SyncHttpError::Credentials)?;
            header.set_sensitive(true);
            request = request.header("x-access-token", header);
        }
        let response = request.send().map_err(classify_send_error)?;
        match response.status().as_u16() {
            200..=299 => {}
            300..=399 => return Err(SyncHttpError::Redirect),
            401 | 403 => return Err(SyncHttpError::Credentials),
            402 => return Err(SyncHttpError::Balance),
            429 => return Err(SyncHttpError::RateLimited),
            500..=599 => return Err(SyncHttpError::Unavailable),
            _ => return Err(SyncHttpError::Rejected),
        }
        if response
            .content_length()
            .is_some_and(|len| len > MAX_HTTP_RESPONSE_BYTES as u64)
        {
            return Err(SyncHttpError::TooLarge);
        }
        let mut bytes = Vec::new();
        response
            .take((MAX_HTTP_RESPONSE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| {
                let request_timeout = error
                    .get_ref()
                    .and_then(|source| source.downcast_ref::<reqwest::Error>())
                    .is_some_and(reqwest::Error::is_timeout);
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) || request_timeout
                {
                    SyncHttpError::Timeout
                } else {
                    SyncHttpError::Network
                }
            })?;
        if bytes.len() > MAX_HTTP_RESPONSE_BYTES {
            return Err(SyncHttpError::TooLarge);
        }
        Ok(bytes)
    }

    pub fn join(&self, nickname: &str) -> Result<Member, SyncHttpError> {
        let body = serde_json::json!({ "nickname": nickname });
        let bytes = self.send(reqwest::Method::POST, "/join", Some(&body))?;
        serde_json::from_slice::<Member>(&bytes).map_err(|_| SyncHttpError::InvalidResponse)
    }

    pub fn members(&self) -> Result<Vec<Member>, SyncHttpError> {
        let bytes = self.send(reqwest::Method::GET, "/members", None)?;
        serde_json::from_slice::<MembersEnvelope>(&bytes)
            .map(|envelope| envelope.members)
            .map_err(|_| SyncHttpError::InvalidResponse)
    }

    pub fn board(&self, since: i64) -> Result<BoardEnvelope, SyncHttpError> {
        let bytes = self.send(reqwest::Method::GET, &format!("/board?since={since}"), None)?;
        serde_json::from_slice::<BoardEnvelope>(&bytes).map_err(|_| SyncHttpError::InvalidResponse)
    }

    pub fn push(&self, member_id: &str, changes: &[Value]) -> Result<i64, SyncHttpError> {
        let body = serde_json::json!({ "memberId": member_id, "changes": changes });
        let bytes = self.send(reqwest::Method::POST, "/push", Some(&body))?;
        serde_json::from_slice::<PushAckDto>(&bytes)
            .map(|ack| ack.rev)
            .map_err(|_| SyncHttpError::InvalidResponse)
    }
}

fn classify_send_error(error: reqwest::Error) -> SyncHttpError {
    if error.is_timeout() {
        SyncHttpError::Timeout
    } else if error.is_builder() {
        SyncHttpError::InvalidRequest
    } else {
        SyncHttpError::Network
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::thread;

    /// 极简回环服务：按路径返回固定 JSON，回传收到的原始请求供断言。
    pub(crate) fn raw_server(
        route: &str,
        status: &'static str,
        body: String,
    ) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let route = route.to_string();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut bytes = Vec::new();
            loop {
                let mut buffer = [0; 2048];
                let n = stream.read(&mut buffer).unwrap();
                if n == 0 {
                    break;
                }
                bytes.extend_from_slice(&buffer[..n]);
                if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                    let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                    if let Some(length) = header
                        .lines()
                        .find_map(|l| l.strip_prefix("content-length:"))
                    {
                        let length: usize = length.trim().parse().unwrap_or(0);
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    } else {
                        break;
                    }
                }
            }
            let request = String::from_utf8(bytes).unwrap();
            let matched = request.contains(route.as_str());
            let response = if matched {
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                )
            } else {
                "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".to_string()
            };
            let _ = stream.write_all(response.as_bytes());
            request
        });
        (url, handle)
    }

    #[test]
    fn rejects_plain_http_non_loopback_and_bad_scheme() {
        assert!(SyncHttp::new("https://example.com", None).is_ok());
        assert_eq!(
            SyncHttp::new("http://example.com", None).unwrap_err(),
            SyncHttpError::InvalidUrl
        );
        assert_eq!(
            SyncHttp::new("ftp://127.0.0.1:3170", None).unwrap_err(),
            SyncHttpError::InvalidUrl
        );
        assert!(SyncHttp::new("http://127.0.0.1:3170", None).is_ok());
        assert!(SyncHttp::new("http://localhost:3170", None).is_ok());
        assert_eq!(
            SyncHttp::new("", None).unwrap_err(),
            SyncHttpError::InvalidUrl
        );
    }

    #[test]
    fn join_sends_nickname_and_sensitive_token_header() {
        let (url, server) = raw_server(
            "/join",
            "200 OK",
            r#"{"memberId":"m_abc","nickname":"小明","joinedAt":"2026-10-22T00:00:00Z"}"#.into(),
        );
        let client = SyncHttp::for_test(&url, Some("secret-token")).unwrap();
        let member = client.join("小明").unwrap();
        assert_eq!(member.member_id, "m_abc");
        let request = server.join().unwrap();
        assert!(request.to_lowercase().contains("x-access-token: secret-token"));
        assert!(request.contains("\"nickname\":\"小明\""));
    }

    #[test]
    fn classifies_401_402_429_5xx_and_redirect() {
        for (route, status, expected) in [
            ("/join", "401 Unauthorized", SyncHttpError::Credentials),
            ("/join", "402 Payment Required", SyncHttpError::Balance),
            ("/board", "429 Too Many Requests", SyncHttpError::RateLimited),
            ("/board", "503 Unavailable", SyncHttpError::Unavailable),
            ("/members", "307 Temporary Redirect", SyncHttpError::Redirect),
        ] {
            let (url, server) = raw_server(route, status, "{}".into());
            let client = SyncHttp::for_test(&url, None).unwrap();
            let result = match route {
                "/join" => client.join("x").err(),
                "/board" => client.board(0).err(),
                _ => client.members().err(),
            };
            assert_eq!(result, Some(expected));
            server.join().unwrap();
        }
    }

    #[test]
    fn oversized_response_is_refused() {
        let (url, server) = raw_server("/board", "200 OK", "x".repeat(MAX_HTTP_RESPONSE_BYTES + 1));
        let client = SyncHttp::for_test(&url, None).unwrap();
        assert_eq!(client.board(0).unwrap_err(), SyncHttpError::TooLarge);
        server.join().unwrap();
    }
}
