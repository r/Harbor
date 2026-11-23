//! `~/.harbor/agent.sock`: lets the person's own agent, running outside the
//! browser (via the `harbor-mcp` stdio binary, see `src/bin/harbor_mcp.rs`),
//! reach a page's registered tools through the extension. Like
//! `page_tools.rs`, the bridge holds NO tool state here - it is a relay.
//! Each request line read off the socket becomes one `host_request` to the
//! extension, method `agent_tabs.request`, context
//! `{ "origin": "harbor-bridge-agent-tabs" }`; the extension's answer (an MCP
//! `CallToolResult`) becomes the response, passed through unchanged.
//!
//! Unlike `page_tools.rs`'s HTTP listener, nothing outside
//! `native_messaging::run_native_messaging` ever needs to reach this
//! listener, so it has no lazily-started global state: it is spawned once,
//! directly, right where the `host_request` channel is created, and simply
//! never spawned at all in `--http-server` mode (see `main.rs`) - which is
//! also why `agent_tabs.*` is refused on that surface
//! (`http_server::is_agent_tabs_method`), same as `page_tools.*`.
//!
//! The socket sits in `~/.harbor`, created mode `0700` if missing (or
//! tightened if it exists looser), with the socket itself mode `0600`: only
//! the person's own user account can connect. That is the whole
//! authentication story - no port, no token. A stale socket file left behind
//! by a bridge process that didn't exit cleanly is removed before binding.
//!
//! Every request line is validated before anything is relayed: `op` must be
//! one of the four known operations, `agentId`/`agentName` must be strings
//! of at most 128 characters, and a line over 1 MB is dropped outright.
//! Requests on one connection are answered concurrently (each spawns its own
//! task), matched back to the right request by `id` - never by arrival
//! order. Only the op and the agent name are ever logged; params and results
//! can carry page content and are never written to the log.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWriteExt, BufReader};
use tokio::sync::{mpsc, oneshot};

use crate::native_messaging::{HostRequestItem, HostRequestSender};
use crate::paths;
use crate::rpc::RpcError;

/// How long one relayed request waits for the extension's `host_response`
/// before giving up and answering with a timeout `CallToolResult`.
/// Production traffic uses this; tests pass a much shorter value so a
/// deliberately-unanswered request doesn't make the suite slow.
pub const DEFAULT_HOST_TIMEOUT: Duration = Duration::from_secs(70);

/// A request line over this size is dropped without a response - there is
/// no reliable way to recover a request id from a line this corrupt anyway.
const MAX_LINE_BYTES: usize = 1024 * 1024;

/// A string field (`agentId`, `agentName`) longer than this is rejected.
/// Counted in characters, not bytes, matching the wire contract's wording.
const MAX_FIELD_CHARS: usize = 128;

const VALID_OPS: [&str; 4] = [
    "open_page",
    "list_pages",
    "list_page_tools",
    "call_page_tool",
];

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh id correlating one relayed `host_request` with its
/// `host_response`. Never leaves the bridge, so it only needs to be unique,
/// not unguessable (mirrors `page_tools::new_request_id`).
fn new_request_id() -> String {
    format!(
        "agent-tabs-{:x}",
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

/// Resolves where the agent socket lives: `$HARBOR_AGENT_SOCKET` if set,
/// else `<harbor_dir>/agent.sock`. The environment override exists only for
/// tests - each spawns its own `harbor-bridge`/`harbor-mcp` subprocess with
/// an isolated environment, so it can point both ends at a private socket
/// without ever touching the real `~/.harbor/agent.sock`. Production code
/// never sets this variable. `harbor_mcp.rs` restates this same resolution
/// (it is a separate binary target and can't `use` this module); keep the
/// two in sync.
pub fn socket_path() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("HARBOR_AGENT_SOCKET") {
        return Some(PathBuf::from(p));
    }
    paths::harbor_dir().map(|d| d.join("agent.sock"))
}

/// `agent_tabs.info {}` -> `{ mcpCommand, socketPath }`, for the sidebar's
/// connect snippet. Refused over the HTTP/WebSocket surface
/// (`http_server::is_agent_tabs_method`), same as every other `agent_tabs.*`
/// method.
pub async fn info() -> Result<Value, RpcError> {
    let mcp_command = mcp_command_path()
        .ok_or_else(|| RpcError::internal("could not determine the path to harbor-mcp"))?;
    let socket =
        socket_path().ok_or_else(|| RpcError::internal("no home directory is available"))?;
    Ok(json!({
        "mcpCommand": mcp_command.to_string_lossy(),
        "socketPath": socket.to_string_lossy(),
    }))
}

/// The absolute path to the `harbor-mcp` binary, assumed to sit next to the
/// currently running bridge executable (that's where the installer places
/// it).
fn mcp_command_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join(binary_name("harbor-mcp")))
}

#[cfg(windows)]
fn binary_name(name: &str) -> String {
    format!("{name}.exe")
}

#[cfg(not(windows))]
fn binary_name(name: &str) -> String {
    name.to_string()
}

// =============================================================================
// The socket listener
// =============================================================================

/// Starts the listener at `socket_path()`, using `DEFAULT_HOST_TIMEOUT`.
/// Called once from `native_messaging::run_native_messaging`, spawned onto
/// its own task. Does nothing but log if `socket_path()` can't be resolved
/// (no home directory) - the rest of the bridge still has to run.
pub async fn start_listener(host_request_tx: HostRequestSender) {
    let Some(path) = socket_path() else {
        tracing::warn!("agent_tabs: no home directory, not starting the agent-tabs listener");
        return;
    };
    if let Err(e) = start_listener_at(path, host_request_tx, DEFAULT_HOST_TIMEOUT).await {
        tracing::error!("agent_tabs: listener failed: {}", e);
    }
}

/// Ensures `dir` exists with mode `0700`, creating it if missing, tightening
/// it (and logging) if it exists looser. A no-op on non-unix targets beyond
/// creating the directory - there's no portable permission bits to set.
fn ensure_dir_secure(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(dir) {
            Ok(meta) => {
                let mode = meta.permissions().mode() & 0o777;
                if mode != 0o700 {
                    tracing::warn!(
                        "agent_tabs: {} had mode {:o}, tightening to 0700",
                        dir.display(),
                        mode
                    );
                    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
                }
                Ok(())
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                std::fs::create_dir_all(dir)?;
                std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
                Ok(())
            }
            Err(e) => Err(e),
        }
    }
    #[cfg(not(unix))]
    {
        std::fs::create_dir_all(dir)
    }
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

/// Binds the Unix socket at `socket_path` (replacing a stale one left by an
/// unclean shutdown) and accepts connections forever, each on its own task.
/// Unix-only: on any other target this logs and returns without binding
/// anything, matching the design doc ("Windows is left for later"). Takes
/// `socket_path` by value (not `&Path`) so callers - production and tests
/// alike - can `tokio::spawn` the call: a spawned future must be `'static`,
/// which a borrow of a caller-local path could never satisfy.
#[cfg(unix)]
pub async fn start_listener_at(
    socket_path: PathBuf,
    host_request_tx: HostRequestSender,
    timeout: Duration,
) -> io::Result<()> {
    use tokio::net::UnixListener;

    if let Some(dir) = socket_path.parent() {
        ensure_dir_secure(dir)?;
    }
    if socket_path.exists() {
        std::fs::remove_file(&socket_path)?;
    }
    let listener = UnixListener::bind(&socket_path)?;
    set_mode(&socket_path, 0o600)?;
    tracing::info!("agent_tabs: listening on {}", socket_path.display());

    loop {
        let (stream, _addr) = listener.accept().await?;
        let tx = host_request_tx.clone();
        tokio::spawn(async move {
            handle_connection(stream, tx, timeout).await;
        });
    }
}

#[cfg(not(unix))]
pub async fn start_listener_at(
    _socket_path: PathBuf,
    _host_request_tx: HostRequestSender,
    _timeout: Duration,
) -> io::Result<()> {
    tracing::warn!("agent_tabs: Unix sockets aren't available on this platform yet");
    Ok(())
}

#[cfg(unix)]
async fn handle_connection(
    stream: tokio::net::UnixStream,
    host_request_tx: HostRequestSender,
    timeout: Duration,
) {
    let (read_half, write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);
    // Requests are answered concurrently (see the module doc), so every
    // in-flight task's response line goes through this one channel to a
    // single writer task, rather than each task writing to the socket
    // directly and racing to interleave partial lines.
    let (line_tx, mut line_rx) = mpsc::channel::<Vec<u8>>(32);

    let writer_task = tokio::spawn(async move {
        let mut write_half = write_half;
        while let Some(bytes) = line_rx.recv().await {
            if write_half.write_all(&bytes).await.is_err() {
                break;
            }
        }
    });

    loop {
        match read_capped_line(&mut reader, MAX_LINE_BYTES).await {
            Ok(CappedLine::Eof) => break,
            Ok(CappedLine::TooLong) => {
                tracing::warn!("agent_tabs: dropped an oversized request line");
            }
            Ok(CappedLine::Line(bytes)) => {
                let tx = line_tx.clone();
                let host_tx = host_request_tx.clone();
                tokio::spawn(async move {
                    if let Some(response) = process_request_line(&bytes, host_tx, timeout).await {
                        let mut out = serde_json::to_vec(&response).unwrap_or_default();
                        out.push(b'\n');
                        let _ = tx.send(out).await;
                    }
                });
            }
            Err(e) => {
                tracing::warn!("agent_tabs: connection read error: {}", e);
                break;
            }
        }
    }
    drop(line_tx);
    let _ = writer_task.await;
}

/// The result of reading one newline-delimited line, capped at `cap` bytes
/// (not counting the newline itself).
#[derive(Debug, PartialEq, Eq)]
enum CappedLine {
    /// The connection closed with no more data.
    Eof,
    /// A complete line, within the cap.
    Line(Vec<u8>),
    /// A line was found, but it exceeded the cap; its content is discarded.
    TooLong,
}

/// Reads one line (bytes up to, but not including, the next `\n`) from
/// `reader`, discarding anything past `cap` bytes rather than growing the
/// buffer without limit - `AsyncBufReadExt::read_line` has no size cap of
/// its own. `reader` should already be a `BufReader` so that reading one
/// byte at a time here doesn't mean one syscall per byte.
async fn read_capped_line<R>(reader: &mut R, cap: usize) -> io::Result<CappedLine>
where
    R: AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut buf = Vec::new();
    let mut too_long = false;
    let mut byte = [0u8; 1];
    loop {
        let n = reader.read(&mut byte).await?;
        if n == 0 {
            return Ok(if too_long {
                CappedLine::TooLong
            } else if buf.is_empty() {
                CappedLine::Eof
            } else {
                CappedLine::Line(buf)
            });
        }
        if byte[0] == b'\n' {
            return Ok(if too_long {
                CappedLine::TooLong
            } else {
                CappedLine::Line(buf)
            });
        }
        if !too_long {
            buf.push(byte[0]);
            if buf.len() > cap {
                too_long = true;
                buf.clear();
            }
        }
    }
}

// =============================================================================
// Request validation and relay
// =============================================================================

struct ParsedRequest {
    id: Value,
    agent_id: String,
    agent_name: String,
    op: String,
    params: Value,
}

/// Why a request line was rejected before it reached the relay.
#[derive(Debug)]
enum Rejected {
    /// No usable `id` to answer with at all (not valid JSON, or not even a
    /// JSON object) - the line is simply dropped, logged, never answered.
    Unanswerable { reason: String },
    /// A line with a readable `id`, but invalid in some other way - answered
    /// with an `isError` `CallToolResult`, matched back to that `id`.
    Invalid { id: Value, message: String },
}

fn parse_and_validate(line: &[u8]) -> Result<ParsedRequest, Rejected> {
    let value: Value = serde_json::from_slice(line).map_err(|e| Rejected::Unanswerable {
        reason: format!("invalid JSON: {e}"),
    })?;
    if !value.is_object() {
        return Err(Rejected::Unanswerable {
            reason: "request must be a JSON object".to_string(),
        });
    }
    let id = value.get("id").cloned().unwrap_or(Value::Null);

    let op = match value.get("op").and_then(|v| v.as_str()) {
        Some(o) if VALID_OPS.contains(&o) => o.to_string(),
        _ => {
            return Err(Rejected::Invalid {
                id,
                message: format!("op must be one of: {}", VALID_OPS.join(", ")),
            })
        }
    };

    let agent_id = match value.get("agentId").and_then(|v| v.as_str()) {
        Some(s) if s.chars().count() <= MAX_FIELD_CHARS => s.to_string(),
        _ => {
            return Err(Rejected::Invalid {
                id,
                message: "agentId must be a string of at most 128 characters".to_string(),
            })
        }
    };

    let agent_name = match value.get("agentName").and_then(|v| v.as_str()) {
        Some(s) if s.chars().count() <= MAX_FIELD_CHARS => s.to_string(),
        _ => {
            return Err(Rejected::Invalid {
                id,
                message: "agentName must be a string of at most 128 characters".to_string(),
            })
        }
    };

    let params = value.get("params").cloned().unwrap_or_else(|| json!({}));

    Ok(ParsedRequest {
        id,
        agent_id,
        agent_name,
        op,
        params,
    })
}

fn error_result(message: &str) -> Value {
    json!({
        "content": [{ "type": "text", "text": message }],
        "isError": true,
    })
}

/// Validates one line and, if valid, relays and awaits the result; returns
/// the full `{id, result}` response line to write, or `None` if the line
/// can't be answered at all (see `Rejected::Unanswerable`).
async fn process_request_line(
    line: &[u8],
    host_request_tx: HostRequestSender,
    timeout: Duration,
) -> Option<Value> {
    match parse_and_validate(line) {
        Err(Rejected::Unanswerable { reason }) => {
            tracing::warn!("agent_tabs: dropping an unanswerable request: {}", reason);
            None
        }
        Err(Rejected::Invalid { id, message }) => {
            tracing::info!("agent_tabs: rejected an invalid request");
            Some(json!({ "id": id, "result": error_result(&message) }))
        }
        Ok(req) => {
            tracing::info!("agent_tabs: op={} agent={}", req.op, req.agent_name);
            let result = relay(&req, &host_request_tx, timeout).await;
            Some(json!({ "id": req.id, "result": result }))
        }
    }
}

/// Relays one validated request to the extension over
/// `host_request`/`host_response` and waits for the answer, or `timeout`,
/// whichever comes first. The extension's own `CallToolResult` is passed
/// through verbatim on success; every failure mode (no channel, the channel
/// closing, a `host_response` error, or a timeout) becomes the bridge's own
/// `isError` `CallToolResult` instead - the caller never sees a raw relay
/// failure.
async fn relay(
    req: &ParsedRequest,
    host_request_tx: &HostRequestSender,
    timeout: Duration,
) -> Value {
    let request_id = new_request_id();
    let (response_tx, response_rx) = oneshot::channel();
    let context = json!({ "origin": "harbor-bridge-agent-tabs" });
    let params = json!({
        "agentId": req.agent_id,
        "agentName": req.agent_name,
        "op": req.op,
        "params": req.params,
    });
    let item: HostRequestItem = (
        request_id,
        "agent_tabs.request".to_string(),
        params,
        context,
        response_tx,
    );
    if host_request_tx.send(item).await.is_err() {
        return error_result("The browser extension is not connected.");
    }

    match tokio::time::timeout(timeout, response_rx).await {
        Ok(Ok(Ok(value))) => value,
        Ok(Ok(Err(_))) => error_result("The browser could not complete this request."),
        Ok(Err(_)) => error_result("The browser could not complete this request."),
        Err(_) => error_result("The browser did not respond in time."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    const TEST_TIMEOUT: Duration = Duration::from_millis(150);

    /// A fresh, *short* directory under `/tmp` (not `std::env::temp_dir()`,
    /// which on macOS is a long per-user path under `/var/folders/...` -
    /// long enough that a socket path built from it can exceed
    /// `sockaddr_un`'s ~104-byte `sun_path` limit and fail to bind).
    fn unique_dir(prefix: &str) -> PathBuf {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        PathBuf::from("/tmp").join(format!("{}-{}-{}", prefix, std::process::id(), n))
    }

    #[cfg(unix)]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    // -------------------------------------------------------------------
    // Directory and socket permissions
    // -------------------------------------------------------------------

    #[test]
    fn ensure_dir_secure_creates_a_missing_directory_with_mode_0700() {
        let dir = unique_dir("hbr150-dir-missing");
        assert!(!dir.exists());
        ensure_dir_secure(&dir).unwrap();
        assert!(dir.is_dir());
        #[cfg(unix)]
        assert_eq!(mode_of(&dir), 0o700);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ensure_dir_secure_tightens_a_looser_existing_directory() {
        use std::os::unix::fs::PermissionsExt;
        let dir = unique_dir("hbr150-dir-loose");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(mode_of(&dir), 0o755);

        ensure_dir_secure(&dir).unwrap();
        assert_eq!(mode_of(&dir), 0o700);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_socket_itself_is_mode_0600() {
        let dir = unique_dir("hbr150-sock-mode");
        let path = dir.join("agent.sock");
        let (tx, _rx) = mpsc::channel(4);
        tokio::spawn(start_listener_at(path.clone(), tx, TEST_TIMEOUT));
        wait_for_socket(&path).await;
        assert_eq!(mode_of(&path), 0o600);
        assert_eq!(mode_of(&dir), 0o700);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_stale_socket_file_is_replaced() {
        let dir = unique_dir("hbr150-sock-stale");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("agent.sock");
        // A leftover socket file from an unclean shutdown: bind one, then
        // drop it without unlinking (the file stays on disk, now
        // unconnectable).
        {
            let stale = tokio::net::UnixListener::bind(&path).unwrap();
            drop(stale);
        }
        assert!(path.exists());

        let (tx, _rx) = mpsc::channel(4);
        tokio::spawn(start_listener_at(path.clone(), tx, TEST_TIMEOUT));
        wait_for_socket(&path).await;

        // A fresh connection succeeds - if the stale file had not been
        // replaced, this would hang or fail to connect to a live listener.
        tokio::net::UnixStream::connect(&path)
            .await
            .expect("connect to the replaced socket");
        std::fs::remove_dir_all(&dir).ok();
    }

    // -------------------------------------------------------------------
    // Test helpers: a tiny client over the real socket
    // -------------------------------------------------------------------

    async fn wait_for_socket(path: &Path) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if tokio::net::UnixStream::connect(path).await.is_ok() {
                return;
            }
            if std::time::Instant::now() >= deadline {
                panic!("socket {} never came up", path.display());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Spawns a listener on a fresh temp socket with a fake host-request
    /// channel the test controls, returning the socket path and the
    /// receiving end of that channel.
    async fn spawn_test_listener(timeout: Duration) -> (PathBuf, mpsc::Receiver<HostRequestItem>) {
        let dir = unique_dir("hbr150-agent-tabs");
        let path = dir.join("agent.sock");
        let (tx, rx) = mpsc::channel::<HostRequestItem>(32);
        tokio::spawn(start_listener_at(path.clone(), tx, timeout));
        wait_for_socket(&path).await;
        (path, rx)
    }

    async fn send_line<W: tokio::io::AsyncWrite + Unpin>(stream: &mut W, value: &Value) {
        use tokio::io::AsyncWriteExt;
        let mut bytes = serde_json::to_vec(value).unwrap();
        bytes.push(b'\n');
        stream.write_all(&bytes).await.unwrap();
    }

    /// Reads and parses exactly one newline-delimited JSON response.
    async fn read_response(
        reader: &mut tokio::io::BufReader<tokio::net::unix::OwnedReadHalf>,
    ) -> Value {
        use tokio::io::AsyncBufReadExt;
        let mut line = String::new();
        tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
            .await
            .expect("timed out waiting for a response")
            .expect("read error");
        serde_json::from_str(line.trim()).expect("response must be valid JSON")
    }

    fn good_request(id: &str, op: &str) -> Value {
        json!({ "id": id, "agentId": "agent-1", "agentName": "goose", "op": op, "params": {} })
    }

    // -------------------------------------------------------------------
    // Validation
    // -------------------------------------------------------------------

    #[test]
    fn a_well_formed_request_parses() {
        let line = serde_json::to_vec(&good_request("1", "list_pages")).unwrap();
        let req = parse_and_validate(&line).expect("should parse");
        assert_eq!(req.id, json!("1"));
        assert_eq!(req.agent_id, "agent-1");
        assert_eq!(req.agent_name, "goose");
        assert_eq!(req.op, "list_pages");
    }

    #[test]
    fn an_unknown_op_is_invalid_but_answerable() {
        let mut req = good_request("1", "delete_everything");
        req["op"] = json!("delete_everything");
        let line = serde_json::to_vec(&req).unwrap();
        match parse_and_validate(&line) {
            Err(Rejected::Invalid { id, message }) => {
                assert_eq!(id, json!("1"));
                assert!(message.contains("op must be one of"));
            }
            other => panic!("expected Invalid, got {:?}", other.map(|r| r.id).ok()),
        }
    }

    #[test]
    fn an_agent_id_over_128_characters_is_invalid() {
        let mut req = good_request("1", "list_pages");
        req["agentId"] = json!("x".repeat(129));
        let line = serde_json::to_vec(&req).unwrap();
        assert!(matches!(
            parse_and_validate(&line),
            Err(Rejected::Invalid { .. })
        ));

        let mut ok = good_request("1", "list_pages");
        ok["agentId"] = json!("x".repeat(128));
        let line = serde_json::to_vec(&ok).unwrap();
        assert!(parse_and_validate(&line).is_ok());
    }

    #[test]
    fn an_agent_name_over_128_characters_is_invalid() {
        let mut req = good_request("1", "list_pages");
        req["agentName"] = json!("x".repeat(129));
        let line = serde_json::to_vec(&req).unwrap();
        assert!(matches!(
            parse_and_validate(&line),
            Err(Rejected::Invalid { .. })
        ));
    }

    #[test]
    fn a_missing_agent_id_or_agent_name_is_invalid() {
        let mut req = good_request("1", "list_pages");
        req.as_object_mut().unwrap().remove("agentId");
        let line = serde_json::to_vec(&req).unwrap();
        assert!(matches!(
            parse_and_validate(&line),
            Err(Rejected::Invalid { .. })
        ));

        let mut req = good_request("1", "list_pages");
        req.as_object_mut().unwrap().remove("agentName");
        let line = serde_json::to_vec(&req).unwrap();
        assert!(matches!(
            parse_and_validate(&line),
            Err(Rejected::Invalid { .. })
        ));
    }

    #[test]
    fn invalid_json_is_unanswerable_not_invalid() {
        assert!(matches!(
            parse_and_validate(b"not json"),
            Err(Rejected::Unanswerable { .. })
        ));
        assert!(matches!(
            parse_and_validate(b"[1,2,3]"),
            Err(Rejected::Unanswerable { .. })
        ));
    }

    // -------------------------------------------------------------------
    // End-to-end over the real socket: relay, errors, timeout, concurrency
    // -------------------------------------------------------------------

    #[tokio::test]
    async fn a_valid_request_is_relayed_and_the_hosts_result_is_returned_verbatim() {
        let (path, mut rx) = spawn_test_listener(TEST_TIMEOUT).await;
        let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read_half);

        let mut bytes = serde_json::to_vec(&good_request("req-1", "open_page")).unwrap();
        bytes.push(b'\n');
        use tokio::io::AsyncWriteExt;
        write_half.write_all(&bytes).await.unwrap();

        let (id, method, params, context, response_tx) =
            rx.recv().await.expect("a host_request should arrive");
        assert_eq!(method, "agent_tabs.request");
        assert_eq!(context, json!({ "origin": "harbor-bridge-agent-tabs" }));
        assert_eq!(params["op"], json!("open_page"));
        assert_eq!(params["agentId"], json!("agent-1"));
        assert_eq!(params["agentName"], json!("goose"));
        let _ = id;
        response_tx
            .send(Ok(
                json!({ "content": [{ "type": "text", "text": "opened" }] }),
            ))
            .unwrap();

        let resp = read_response(&mut reader).await;
        assert_eq!(resp["id"], json!("req-1"));
        assert_eq!(
            resp["result"],
            json!({ "content": [{ "type": "text", "text": "opened" }] })
        );
    }

    #[tokio::test]
    async fn a_host_error_becomes_an_is_error_result() {
        let (path, mut rx) = spawn_test_listener(TEST_TIMEOUT).await;
        let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read_half);
        send_line(&mut write_half, &good_request("req-err", "list_pages")).await;

        let (_id, _method, _params, _context, response_tx) = rx.recv().await.unwrap();
        response_tx.send(Err(json!("boom"))).unwrap();

        let resp = read_response(&mut reader).await;
        assert_eq!(resp["id"], json!("req-err"));
        assert_eq!(resp["result"]["isError"], json!(true));
        assert!(!resp["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn an_unanswered_request_times_out_with_an_is_error_result() {
        let (path, mut rx) = spawn_test_listener(TEST_TIMEOUT).await;
        let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read_half);
        send_line(&mut write_half, &good_request("req-timeout", "list_pages")).await;

        // Receive the host_request but never answer it - held well past
        // TEST_TIMEOUT so the response can only come from the timeout path.
        let (_id, _method, _params, _context, response_tx) = rx.recv().await.unwrap();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(response_tx);
        });

        let resp = read_response(&mut reader).await;
        assert_eq!(resp["id"], json!("req-timeout"));
        assert_eq!(resp["result"]["isError"], json!(true));
    }

    #[tokio::test]
    async fn an_invalid_request_is_answered_without_touching_the_host() {
        let (path, mut rx) = spawn_test_listener(TEST_TIMEOUT).await;
        let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read_half);

        let mut bad = good_request("req-bad", "list_pages");
        bad["op"] = json!("not_a_real_op");
        send_line(&mut write_half, &bad).await;

        let resp = read_response(&mut reader).await;
        assert_eq!(resp["id"], json!("req-bad"));
        assert_eq!(resp["result"]["isError"], json!(true));
        assert!(
            rx.try_recv().is_err(),
            "an invalid request must never reach the host"
        );
    }

    #[tokio::test]
    async fn an_oversized_line_is_dropped_with_no_response_and_the_connection_keeps_working() {
        let (path, mut rx) = spawn_test_listener(TEST_TIMEOUT).await;
        let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read_half);

        let mut huge = good_request("req-huge", "list_pages");
        huge["params"] = json!({ "pad": "x".repeat(MAX_LINE_BYTES + 4096) });
        send_line(&mut write_half, &huge).await;
        send_line(&mut write_half, &good_request("req-after", "list_pages")).await;

        let (_id, _method, _params, _context, response_tx) = rx
            .recv()
            .await
            .expect("the second, valid request should still reach the host");
        response_tx.send(Ok(json!({ "content": [] }))).unwrap();

        let resp = read_response(&mut reader).await;
        assert_eq!(
            resp["id"],
            json!("req-after"),
            "the oversized line's own id must never appear"
        );
    }

    #[tokio::test]
    async fn concurrent_requests_on_one_connection_are_matched_back_by_id() {
        let (path, mut rx) = spawn_test_listener(Duration::from_secs(5)).await;
        let stream = tokio::net::UnixStream::connect(&path).await.unwrap();
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = tokio::io::BufReader::new(read_half);

        send_line(&mut write_half, &good_request("A", "list_pages")).await;
        send_line(&mut write_half, &good_request("B", "list_pages")).await;

        let first = rx.recv().await.unwrap();
        let second = rx.recv().await.unwrap();

        // Answer out of arrival order: the second host_request received
        // answers first. Responses must still be matched by id, not by
        // completion order.
        second
            .4
            .send(Ok(json!({ "content": [], "marker": "second" })))
            .unwrap();
        first
            .4
            .send(Ok(json!({ "content": [], "marker": "first" })))
            .unwrap();

        let mut by_id = std::collections::HashMap::new();
        for _ in 0..2 {
            let resp = read_response(&mut reader).await;
            by_id.insert(
                resp["id"].as_str().unwrap().to_string(),
                resp["result"].clone(),
            );
        }
        assert_eq!(by_id["A"]["marker"], json!("first"));
        assert_eq!(by_id["B"]["marker"], json!("second"));
    }

    // -------------------------------------------------------------------
    // agent_tabs.info
    // -------------------------------------------------------------------

    #[tokio::test]
    async fn info_reports_an_mcp_command_next_to_the_current_executable_and_the_socket_path() {
        std::env::set_var("HARBOR_AGENT_SOCKET", "/tmp/hbr150-info-test.sock");
        let result = info().await.unwrap();
        std::env::remove_var("HARBOR_AGENT_SOCKET");

        let mcp_command = result["mcpCommand"].as_str().unwrap();
        assert!(
            mcp_command.ends_with("harbor-mcp"),
            "unexpected mcpCommand: {mcp_command}"
        );
        assert!(Path::new(mcp_command).is_absolute());
        assert_eq!(result["socketPath"], json!("/tmp/hbr150-info-test.sock"));
    }
}
