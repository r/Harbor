//! Agent Client Protocol (ACP) process relay.
//!
//! The bridge holds NO ACP protocol state here: it is a process manager and
//! framer. It starts a user-configured agent (e.g. `goose acp`) as a
//! long-lived child process and relays newline-delimited JSON-RPC between
//! the agent's stdio and the extension. Message content is never inspected
//! beyond "is this one JSON object".
//!
//! Commands, args and env come only from `acp.json` (see `config.rs`).
//! Messages from the extension can only select an agent by `id`, and can
//! never carry a command to run. Processes are always spawned directly
//! (`tokio::process::Command`), never through a shell.

pub mod config;

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, RwLock};

use crate::rpc::RpcError;
use config::AcpConfig;

/// Maximum number of agent processes the bridge will run at once.
const MAX_LIVE_AGENTS: usize = 8;

/// Maximum serialized size of a single `acp.send` message written to an
/// agent's stdin. Chosen as a generous but bounded limit for ACP payloads
/// (e.g. file contents embedded in a tool call); documented here rather
/// than enforced anywhere else.
const MAX_SEND_BYTES: usize = 4 * 1024 * 1024;

/// Native messaging enforces (on the browser side) a 1 MB cap on a single
/// message written by the host. `write_message` in `native_messaging.rs`
/// does not itself check size today, so we keep a single agent stdout line
/// safely under that cap before it ever reaches the outbound envelope
/// (`{"type":"stream","event":{"type":"message","message": <line>}}`), which
/// adds its own overhead on top of the raw line. Leaving ~100 KB of
/// headroom for that envelope plus JSON escaping.
const MAX_OUTBOUND_LINE_BYTES: usize = 900 * 1024;

/// How much of a stderr/garbage line to keep when logging it.
const LOG_TRUNCATE_BYTES: usize = 2000;

struct ChannelHandle {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
}

type ChannelMap = Arc<RwLock<HashMap<String, Arc<ChannelHandle>>>>;

static CHANNELS: OnceLock<ChannelMap> = OnceLock::new();
static CHANNEL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn channels() -> ChannelMap {
    CHANNELS
        .get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
        .clone()
}

/// A fresh opaque channel id. Not a security boundary (it never leaves the
/// bridge/extension trust boundary), just unique per open process.
fn new_channel_id() -> String {
    let n = CHANNEL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("acp-{:x}-{:x}", now.as_nanos(), n)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}... [truncated, {} bytes total]", &s[..max], s.len())
    }
}

// =============================================================================
// RPC handlers (non-streaming)
// =============================================================================

/// `acp.list_agents {}` -> `{agents:[{id,name}]}`. Never leaks command/args/env.
pub async fn list_agents() -> Result<Value, RpcError> {
    list_agents_for(&AcpConfig::load())
}

fn list_agents_for(_config: &AcpConfig) -> Result<Value, RpcError> {
    // RED: not implemented yet.
    Err(RpcError::internal("not implemented"))
}

/// `acp.send {channel, message}` -> writes `message` + "\n" to the agent's stdin.
pub async fn send(_params: Value) -> Result<Value, RpcError> {
    // RED: not implemented yet.
    Err(RpcError::internal("not implemented"))
}

/// `acp.close {channel}` -> kills the agent process and ends its stream.
pub async fn close(_params: Value) -> Result<Value, RpcError> {
    // RED: not implemented yet.
    Err(RpcError::internal("not implemented"))
}

#[allow(dead_code)]
async fn kill(handle: &ChannelHandle) {
    let mut child = handle.child.lock().await;
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Kill every agent process the bridge started. Called on extension
/// disconnect and on bridge shutdown: the bridge must never leave an agent
/// process running after it stops relaying for it.
pub async fn shutdown_all() {
    // RED: not implemented yet.
}

// =============================================================================
// Streaming RPC: acp.open
// =============================================================================

/// `acp.open {agentId}`. Streaming method: never sends an `rpc_response`,
/// only `stream` events on the calling request's id. The first event is
/// `{"type":"open","channel":<id>}` carrying the opaque channel used by
/// subsequent `acp.send` / `acp.close` calls. Each agent stdout line becomes
/// `{"type":"message","message":<parsed JSON>}`. A non-JSON line is dropped
/// (logged, not forwarded). An oversized line is dropped with
/// `{"type":"error",...}` instead of a `message` event. The stream ends with
/// `{"type":"exit","code":<code or null>}` when the process exits, or an
/// `{"type":"error","fatal":true,...}` for failures that never produced a
/// channel (unknown agent, process cap, spawn failure).
pub async fn open_stream(params: Value, event_tx: mpsc::Sender<Value>) {
    open_stream_with_config(params, event_tx, AcpConfig::load()).await
}

async fn open_stream_with_config(
    _params: Value,
    event_tx: mpsc::Sender<Value>,
    _config: AcpConfig,
) {
    // RED: not implemented yet. Always reports a fatal error instead of
    // spawning anything, so every test that expects a working relay fails.
    send_fatal(&event_tx, "not implemented").await;
}

#[allow(dead_code)]
async fn forward_stdout_line(channel: &str, line: &str, event_tx: &mpsc::Sender<Value>) {
    let _ = (channel, line, event_tx);
}

/// Remove the channel (if still present) and wait for its process to exit,
/// returning the exit code. If the channel was already removed (e.g. by an
/// explicit `acp.close` that already killed and waited on it), there is
/// nothing left to reap.
#[allow(dead_code)]
async fn reap(channel: &str) -> Option<i32> {
    let removed = channels().write().await.remove(channel);
    match removed {
        Some(handle) => {
            let mut child = handle.child.lock().await;
            match child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        }
        None => None,
    }
}

async fn send_fatal(event_tx: &mpsc::Sender<Value>, message: &str) {
    let _ = event_tx
        .send(json!({ "type": "error", "fatal": true, "message": message }))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use config::AgentConfig;
    use std::time::Duration;
    use tokio::time::timeout;

    /// Serializes tests that touch the global channel registry/cap, so they
    /// don't race or step on each other's agent processes.
    static TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    /// Locate the `acp_fake_agent` bin target built alongside this test
    /// binary. `CARGO_BIN_EXE_<name>` is only set for integration test and
    /// bench targets, not for a binary crate's own unit test harness (this
    /// one), so we derive the path from our own executable's location
    /// instead: `cargo test`/`cargo build` place every `src/bin/*` target
    /// as a sibling of `debug/deps/<this test binary>`.
    fn fake_agent_path() -> std::path::PathBuf {
        let mut path = std::env::current_exe().expect("current_exe");
        path.pop(); // drop the test binary file name
        path.pop(); // drop `deps/`
        path.push(if cfg!(windows) {
            "acp_fake_agent.exe"
        } else {
            "acp_fake_agent"
        });
        assert!(
            path.exists(),
            "acp_fake_agent not built at {}; run `cargo build` first",
            path.display()
        );
        path
    }

    fn fake_agent_config(id: &str) -> AcpConfig {
        AcpConfig {
            agents: vec![AgentConfig {
                id: id.to_string(),
                name: format!("{} display name", id),
                command: fake_agent_path().to_string_lossy().into_owned(),
                args: vec![],
                env: HashMap::new(),
            }],
        }
    }

    async fn recv_timeout(rx: &mut mpsc::Receiver<Value>) -> Option<Value> {
        timeout(Duration::from_secs(5), rx.recv())
            .await
            .expect("timed out waiting for acp event")
    }

    /// Opens the fake agent and returns its channel id and event receiver,
    /// after consuming the initial `open` event.
    async fn open_fake_agent(id: &str) -> (String, mpsc::Receiver<Value>) {
        let (tx, mut rx) = mpsc::channel(32);
        let config = fake_agent_config(id);
        let agent_id = id.to_string();
        tokio::spawn(async move {
            open_stream_with_config(json!({ "agentId": agent_id }), tx, config).await;
        });
        let event = recv_timeout(&mut rx).await.expect("open event");
        assert_eq!(event["type"], "open");
        let channel = event["channel"].as_str().unwrap().to_string();
        (channel, rx)
    }

    #[test]
    fn list_agents_hides_commands_and_env() {
        let config = AcpConfig {
            agents: vec![AgentConfig {
                id: "goose".to_string(),
                name: "Goose".to_string(),
                command: "goose".to_string(),
                args: vec!["acp".to_string()],
                env: HashMap::from([("SECRET".to_string(), "x".to_string())]),
            }],
        };

        let result = list_agents_for(&config).unwrap();
        assert_eq!(result, json!({ "agents": [{ "id": "goose", "name": "Goose" }] }));

        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("goose\",\"args\""));
        assert!(!serialized.contains("SECRET"));
        assert!(!serialized.contains("command"));
    }

    #[tokio::test]
    async fn open_rejects_unknown_agent_id() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (tx, mut rx) = mpsc::channel(32);
        let config = AcpConfig::default();
        open_stream_with_config(json!({ "agentId": "nope" }), tx, config).await;

        let event = recv_timeout(&mut rx).await.expect("error event");
        assert_eq!(event["type"], "error");
        assert_eq!(event["fatal"], true);
        assert!(rx.recv().await.is_none(), "stream should end after a fatal error");
    }

    #[tokio::test]
    async fn open_rejects_missing_agent_id() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (tx, mut rx) = mpsc::channel(32);
        open_stream_with_config(json!({}), tx, AcpConfig::default()).await;
        let event = recv_timeout(&mut rx).await.expect("error event");
        assert_eq!(event["type"], "error");
        assert_eq!(event["fatal"], true);
    }

    #[tokio::test]
    async fn open_and_relay_both_directions() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (channel, mut rx) = open_fake_agent("echo").await;

        send(json!({ "channel": channel, "message": { "hello": "world" } }))
            .await
            .expect("send should succeed");

        let event = recv_timeout(&mut rx).await.expect("message event");
        assert_eq!(event, json!({ "type": "message", "message": { "hello": "world" } }));

        close(json!({ "channel": channel })).await.expect("close should succeed");
        let exit = recv_timeout(&mut rx).await.expect("exit event");
        assert_eq!(exit["type"], "exit");
    }

    #[tokio::test]
    async fn non_json_stdout_is_dropped_not_forwarded() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (channel, mut rx) = open_fake_agent("echo").await;

        send(json!({ "channel": channel.clone(), "message": { "__test_cmd": "garbage" } }))
            .await
            .unwrap();
        send(json!({ "channel": channel.clone(), "message": { "marker": "after-garbage" } }))
            .await
            .unwrap();

        // The garbage line must never surface as a message event: the next
        // event the extension sees is the echo of the second, valid send.
        let event = recv_timeout(&mut rx).await.expect("message event");
        assert_eq!(
            event,
            json!({ "type": "message", "message": { "marker": "after-garbage" } })
        );

        close(json!({ "channel": channel })).await.unwrap();
    }

    #[tokio::test]
    async fn oversized_stdout_line_is_dropped_with_error_event() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (channel, mut rx) = open_fake_agent("echo").await;

        send(json!({
            "channel": channel.clone(),
            "message": { "__test_cmd": "big", "size": MAX_OUTBOUND_LINE_BYTES + 1024 },
        }))
        .await
        .unwrap();
        send(json!({ "channel": channel.clone(), "message": { "marker": "after-big" } }))
            .await
            .unwrap();

        let error_event = recv_timeout(&mut rx).await.expect("error event");
        assert_eq!(error_event["type"], "error");

        let message_event = recv_timeout(&mut rx).await.expect("message event");
        assert_eq!(
            message_event,
            json!({ "type": "message", "message": { "marker": "after-big" } })
        );

        close(json!({ "channel": channel })).await.unwrap();
    }

    #[tokio::test]
    async fn close_kills_the_process() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (channel, mut rx) = open_fake_agent("echo").await;

        close(json!({ "channel": channel.clone() })).await.unwrap();

        let exit = recv_timeout(&mut rx).await.expect("exit event after close");
        assert_eq!(exit["type"], "exit");

        // Channel is gone: a second close is rejected as unknown.
        let err = close(json!({ "channel": channel })).await.unwrap_err();
        assert_eq!(err.code, -32602);
    }

    #[tokio::test]
    async fn disconnect_kills_every_open_agent() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (_c1, mut rx1) = open_fake_agent("echo").await;
        let (_c2, mut rx2) = open_fake_agent("echo").await;

        shutdown_all().await;

        let exit1 = recv_timeout(&mut rx1).await.expect("exit event for agent 1");
        assert_eq!(exit1["type"], "exit");
        let exit2 = recv_timeout(&mut rx2).await.expect("exit event for agent 2");
        assert_eq!(exit2["type"], "exit");
    }

    #[tokio::test]
    async fn opening_beyond_the_cap_is_rejected() {
        let _guard = TEST_LOCK.lock().unwrap();
        let mut channels_and_rx = Vec::new();
        for _ in 0..MAX_LIVE_AGENTS {
            channels_and_rx.push(open_fake_agent("echo").await);
        }

        let (tx, mut rx) = mpsc::channel(32);
        open_stream_with_config(json!({ "agentId": "echo" }), tx, fake_agent_config("echo")).await;
        let event = recv_timeout(&mut rx).await.expect("cap error event");
        assert_eq!(event["type"], "error");
        assert_eq!(event["fatal"], true);

        shutdown_all().await;
        for (_, mut rx) in channels_and_rx {
            let exit = recv_timeout(&mut rx).await.expect("exit event during cleanup");
            assert_eq!(exit["type"], "exit");
        }
    }

    #[tokio::test]
    async fn send_rejects_non_object_message() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (channel, mut rx) = open_fake_agent("echo").await;

        let err = send(json!({ "channel": channel.clone(), "message": "not-an-object" }))
            .await
            .unwrap_err();
        assert_eq!(err.code, -32602);

        close(json!({ "channel": channel })).await.unwrap();
        let _ = recv_timeout(&mut rx).await;
    }

    #[tokio::test]
    async fn send_rejects_oversized_message() {
        let _guard = TEST_LOCK.lock().unwrap();
        let (channel, mut rx) = open_fake_agent("echo").await;

        let huge = "x".repeat(MAX_SEND_BYTES + 1024);
        let err = send(json!({ "channel": channel.clone(), "message": { "data": huge } }))
            .await
            .unwrap_err();
        assert_eq!(err.code, -32602);
        assert!(err.message.contains("limit"));

        close(json!({ "channel": channel })).await.unwrap();
        let _ = recv_timeout(&mut rx).await;
    }

    #[tokio::test]
    async fn send_rejects_unknown_channel() {
        let _guard = TEST_LOCK.lock().unwrap();
        let err = send(json!({ "channel": "does-not-exist", "message": {} }))
            .await
            .unwrap_err();
        assert_eq!(err.code, -32602);
    }

    #[tokio::test]
    async fn close_rejects_unknown_channel() {
        let _guard = TEST_LOCK.lock().unwrap();
        let err = close(json!({ "channel": "does-not-exist" })).await.unwrap_err();
        assert_eq!(err.code, -32602);
    }
}
