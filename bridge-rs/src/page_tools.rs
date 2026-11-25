//! Bridge-hosted MCP endpoint for page tools.
//!
//! An ACP agent reaches a page's registered tools over `127.0.0.1`, the same
//! way it would talk to any other MCP server: `initialize`, `tools/list` and
//! `tools/call` over streamable HTTP. The bridge holds NO tool state here -
//! like `acp/mod.rs`, it is a relay. `tools/list` and `tools/call` become
//! `host_request`s to the extension (`page_tools.list` / `page_tools.call`),
//! using the same channel other JS-hosted MCP servers already use to ask the
//! host for something (see `native_messaging::HostRequestSender`). The
//! extension's answer becomes the response; a `tools/call` result is passed
//! through unchanged.
//!
//! One listener is started lazily, bound to `127.0.0.1:0` (an OS-chosen
//! port), the first time a tab needs an endpoint. Each endpoint is a random,
//! unguessable path token mapped to an opaque endpoint id; `page_tools.open`
//! and `page_tools.close` (native-messaging RPCs from the extension) create
//! and remove that mapping. Closing is idempotent, and the whole listener
//! goes away when the bridge process exits - there is nothing else to shut
//! down.
//!
//! Like `acp.*`, none of this is reachable over the Safari HTTP/WebSocket
//! surface (see `http_server::is_page_tools_method`): that surface has no
//! equivalent of native messaging's single long-lived connection to track
//! endpoints on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, State},
    http::{header, HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use base64::Engine;
use rand::RngCore;
use serde_json::{json, Value};
use tokio::sync::{oneshot, Mutex};

use crate::native_messaging::{HostRequestItem, HostRequestSender};
use crate::rpc::RpcError;

/// Requests over this size are rejected with 413 before they ever reach a
/// handler (the `DefaultBodyLimit` layer in `build_router`); the manual
/// check in `handle_mcp` is belt-and-suspenders only.
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// How long a `tools/list` or `tools/call` relay waits for the extension's
/// `host_response` before giving up. Production traffic uses this; tests
/// construct their own `PageToolsState` with a much shorter value so a
/// deliberately-unanswered request doesn't make the suite slow.
const DEFAULT_HOST_TIMEOUT: Duration = Duration::from_secs(70);

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

/// A fresh id correlating one relayed `host_request` with its
/// `host_response`. Never leaves the bridge, so it only needs to be unique,
/// not unguessable.
fn new_request_id() -> String {
    format!(
        "page-tools-{:x}",
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    )
}

struct Inner {
    /// Set once, the first time an endpoint is opened.
    port: Option<u16>,
    /// token -> endpoint id, for incoming HTTP requests.
    tokens: HashMap<String, String>,
    /// endpoint id -> token, so `page_tools.close` can remove both sides.
    endpoints: HashMap<String, String>,
    counter: u64,
}

/// Shared, process-lifetime state for the page-tools endpoint. Holds the
/// listener's port and the token <-> endpoint id maps - never any tool
/// data, which always lives in the extension.
pub struct PageToolsState {
    inner: Mutex<Inner>,
    host_timeout: Duration,
    /// Set once, from `run_native_messaging`, right after that function
    /// creates its `host_request` channel. Unset in `--http-server` mode,
    /// where nothing ever calls `set_host_request_tx`: every relay then
    /// fails cleanly (see `send_host_request`) - academic anyway, since
    /// `page_tools.open` itself is refused on that surface (see
    /// `http_server::is_page_tools_method`), so the listener this state
    /// drives is never started there.
    host_request_tx: OnceLock<HostRequestSender>,
}

impl PageToolsState {
    fn new(host_timeout: Duration) -> Self {
        Self {
            inner: Mutex::new(Inner {
                port: None,
                tokens: HashMap::new(),
                endpoints: HashMap::new(),
                counter: 0,
            }),
            host_timeout,
            host_request_tx: OnceLock::new(),
        }
    }

    fn set_host_request_tx(&self, tx: HostRequestSender) {
        let _ = self.host_request_tx.set(tx);
    }
}

static GLOBAL: OnceLock<Arc<PageToolsState>> = OnceLock::new();

fn global_state() -> Arc<PageToolsState> {
    GLOBAL
        .get_or_init(|| Arc::new(PageToolsState::new(DEFAULT_HOST_TIMEOUT)))
        .clone()
}

/// Called once from `run_native_messaging`, right after it creates its
/// `host_request` channel, so the HTTP handlers below (which run on the
/// page-tools listener's own task, not on that function's call stack) can
/// reach it too.
pub fn set_host_request_sender(tx: HostRequestSender) {
    global_state().set_host_request_tx(tx);
}

// =============================================================================
// page_tools.open / page_tools.close (native-messaging RPCs)
// =============================================================================

/// `page_tools.open {}` -> `{ endpointId, url }`. Starts the shared listener
/// on first use, then mints a fresh token and endpoint id.
pub async fn open() -> Result<Value, RpcError> {
    open_on(&global_state()).await
}

/// `page_tools.close { endpointId }` -> `{ closed: bool }`. Idempotent: an
/// unknown id is not an error, just `closed: false`.
pub async fn close(params: Value) -> Result<Value, RpcError> {
    close_on(&global_state(), params).await
}

async fn open_on(state: &Arc<PageToolsState>) -> Result<Value, RpcError> {
    let port = ensure_listener(state).await.map_err(RpcError::internal)?;

    let token = generate_token();
    let mut inner = state.inner.lock().await;
    inner.counter += 1;
    // Unguessable too, not just unique: the extension answers page_tools.*
    // host requests only for an endpoint id it opened, and any code that can
    // send a host request (a JS MCP server running in this bridge can) must
    // not be able to name another session's endpoint.
    let endpoint_id = format!("pt-{}-{}", inner.counter, &generate_token()[..16]);
    inner.tokens.insert(token.clone(), endpoint_id.clone());
    inner.endpoints.insert(endpoint_id.clone(), token.clone());
    drop(inner);

    tracing::info!("page_tools: opened endpoint {}", endpoint_id);
    Ok(json!({
        "endpointId": endpoint_id,
        "url": format!("http://127.0.0.1:{}/mcp/{}", port, token),
    }))
}

async fn close_on(state: &Arc<PageToolsState>, params: Value) -> Result<Value, RpcError> {
    let endpoint_id = params
        .get("endpointId")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError::invalid_params("endpointId is required"))?
        .to_string();

    let mut inner = state.inner.lock().await;
    let closed = match inner.endpoints.remove(&endpoint_id) {
        Some(token) => {
            inner.tokens.remove(&token);
            true
        }
        None => false,
    };
    drop(inner);

    if closed {
        tracing::info!("page_tools: closed endpoint {}", endpoint_id);
    }
    Ok(json!({ "closed": closed }))
}

/// Starts the shared listener if it isn't running yet, returning its port
/// either way. The lock around the check-and-bind means only the first of
/// several concurrent callers actually binds.
async fn ensure_listener(state: &Arc<PageToolsState>) -> Result<u16, String> {
    let mut inner = state.inner.lock().await;
    if let Some(port) = inner.port {
        return Ok(port);
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| format!("failed to bind page-tools listener: {}", e))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("failed to read page-tools listener port: {}", e))?
        .port();
    inner.port = Some(port);
    drop(inner);

    let router = build_router(state.clone());
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, router).await {
            tracing::error!("page_tools: http server error: {}", e);
        }
    });

    tracing::info!("page_tools: listening on 127.0.0.1:{}", port);
    Ok(port)
}

/// 32 random bytes, base64url-encoded with no padding: unguessable, and
/// distinct from the opaque endpoint id it maps to.
fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

// =============================================================================
// HTTP server
// =============================================================================

fn build_router(state: Arc<PageToolsState>) -> Router {
    Router::new()
        .route("/mcp/:token", any(handle_mcp))
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

/// Finds the endpoint id for `candidate`, comparing it against every live
/// token rather than stopping at the first match - so how long a wrong
/// token takes to reject says nothing about how close it was to a real one.
/// The token itself is never logged, here or anywhere else in this module;
/// only the endpoint id it resolves to (if any) is.
fn find_token(tokens: &HashMap<String, String>, candidate: &str) -> Option<String> {
    let candidate_bytes = candidate.as_bytes();
    let mut found = None;
    for (token, endpoint_id) in tokens.iter() {
        if constant_time_eq(token.as_bytes(), candidate_bytes) {
            found = Some(endpoint_id.clone());
        }
    }
    found
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

async fn handle_mcp(
    State(state): State<Arc<PageToolsState>>,
    Path(token): Path<String>,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let (endpoint_id, port) = {
        let inner = state.inner.lock().await;
        (find_token(&inner.tokens, &token), inner.port.unwrap_or(0))
    };

    let Some(endpoint_id) = endpoint_id else {
        return StatusCode::NOT_FOUND.into_response();
    };

    // Blocks DNS rebinding: a request that reached this process over a name
    // other than the loopback address/port it's actually listening on is
    // rejected, whatever the path.
    let expected_host = format!("127.0.0.1:{}", port);
    let host_ok = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|h| h == expected_host);
    if !host_ok {
        return StatusCode::FORBIDDEN.into_response();
    }

    // No web page can call this endpoint, even cross-origin with a "simple"
    // request: any Origin header at all is refused, not just a mismatched
    // one.
    if headers.contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }

    match method {
        Method::DELETE => return StatusCode::NO_CONTENT.into_response(),
        Method::POST => {}
        _ => return StatusCode::METHOD_NOT_ALLOWED.into_response(),
    }

    let content_type_ok = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .eq_ignore_ascii_case("application/json")
        });
    if !content_type_ok {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }

    if body.len() > MAX_BODY_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }

    let request: Value = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };

    if !request.is_object() {
        // Catches a JSON-RPC batch (a top-level array), which this endpoint
        // doesn't support, along with any other non-object body.
        return StatusCode::BAD_REQUEST.into_response();
    }

    let method_name = request
        .get("method")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let id = request.get("id").cloned();

    if id.is_none() || method_name.starts_with("notifications/") {
        return StatusCode::ACCEPTED.into_response();
    }
    let id = id.unwrap();
    let params = request.get("params").cloned().unwrap_or_else(|| json!({}));

    let body = match dispatch(&state, &endpoint_id, &method_name, params).await {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    };
    (StatusCode::OK, Json(body)).into_response()
}

async fn dispatch(
    state: &Arc<PageToolsState>,
    endpoint_id: &str,
    method: &str,
    params: Value,
) -> Result<Value, (i64, String)> {
    match method {
        "initialize" => Ok(initialize_result(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => relay_list(state, endpoint_id).await,
        "tools/call" => Ok(relay_call(state, endpoint_id, params).await),
        _ => Err((-32601, format!("Unknown method: {}", method))),
    }
}

fn initialize_result(params: &Value) -> Value {
    let requested = params.get("protocolVersion").and_then(|v| v.as_str());
    // clippy's `manual_unwrap_or` suggests `requested.unwrap_or("2025-06-18")`
    // here, but that would be wrong: an unrecognized requested version (e.g.
    // `Some("1999-01-01")`) must also fall through to the default, not be
    // echoed back as-is, which only this match (not `unwrap_or`) does.
    #[allow(clippy::manual_unwrap_or)]
    let version = match requested {
        Some(v @ ("2025-06-18" | "2025-03-26")) => v,
        _ => "2025-06-18",
    };
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": {
            "name": "harbor-page-tools",
            "version": env!("CARGO_PKG_VERSION"),
        },
    })
}

/// Only `name`, `description` and `inputSchema` survive from whatever the
/// extension sends for one tool - this is page-supplied data crossing a
/// trust boundary, so nothing else riding along with it is passed on
/// unexamined.
fn normalize_tool(tool: &Value) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(name) = tool.get("name") {
        out.insert("name".to_string(), name.clone());
    }
    if let Some(description) = tool.get("description") {
        out.insert("description".to_string(), description.clone());
    }
    let schema = tool
        .get("inputSchema")
        .cloned()
        .unwrap_or_else(|| json!({ "type": "object" }));
    out.insert("inputSchema".to_string(), schema);
    // MCP's optional Tool fields, passed on only with the right type. The
    // extension has already validated them; `annotations` are the page's own
    // hints for the agent, and no Harbor gate reads them.
    if let Some(title) = tool.get("title").filter(|t| t.is_string()) {
        out.insert("title".to_string(), title.clone());
    }
    if let Some(output) = tool.get("outputSchema").filter(|s| s.is_object()) {
        out.insert("outputSchema".to_string(), output.clone());
    }
    if let Some(annotations) = tool.get("annotations").filter(|a| a.is_object()) {
        out.insert("annotations".to_string(), annotations.clone());
    }
    // Harbor's own provenance for the tool (`harbor/provenance`, set by the
    // extension from the browser's record of the page's origin), so the
    // agent can see where the tool came from. Only an object is passed on.
    if let Some(meta) = tool.get("_meta").filter(|m| m.is_object()) {
        out.insert("_meta".to_string(), meta.clone());
    }
    Value::Object(out)
}

async fn relay_list(
    state: &Arc<PageToolsState>,
    endpoint_id: &str,
) -> Result<Value, (i64, String)> {
    match send_host_request(
        state,
        "page_tools.list",
        json!({ "endpointId": endpoint_id }),
    )
    .await
    {
        Ok(value) => {
            let tools: Vec<Value> = value
                .get("tools")
                .and_then(|t| t.as_array())
                .cloned()
                .unwrap_or_default();
            Ok(json!({ "tools": tools.iter().map(normalize_tool).collect::<Vec<_>>() }))
        }
        Err(_) => Err((-32603, "Page tool list failed".to_string())),
    }
}

async fn relay_call(state: &Arc<PageToolsState>, endpoint_id: &str, params: Value) -> Value {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let arguments = params
        .get("arguments")
        .cloned()
        .unwrap_or_else(|| json!({}));

    match send_host_request(
        state,
        "page_tools.call",
        json!({ "endpointId": endpoint_id, "name": name, "arguments": arguments }),
    )
    .await
    {
        Ok(value) => value,
        Err(_) => json!({
            "content": [{ "type": "text", "text": "Page tool call failed" }],
            "isError": true,
        }),
    }
}

/// Relays one request to the extension over `host_request`/`host_response`
/// and waits for the answer, or `state.host_timeout`, whichever comes
/// first. The bridge never interprets the result: callers get it back
/// verbatim on success, and turn any `Err` into their own fallback (see
/// `relay_list`/`relay_call`).
async fn send_host_request(
    state: &Arc<PageToolsState>,
    method: &str,
    params: Value,
) -> Result<Value, Value> {
    let Some(tx) = state.host_request_tx.get() else {
        return Err(json!("page tools: no host request channel configured"));
    };

    let id = new_request_id();
    let (response_tx, response_rx) = oneshot::channel();
    let context = json!({ "origin": "harbor-bridge-page-tools" });
    let item: HostRequestItem = (id, method.to_string(), params, context, response_tx);
    if tx.send(item).await.is_err() {
        return Err(json!("page tools: host request channel closed"));
    }

    match tokio::time::timeout(state.host_timeout, response_rx).await {
        Ok(Ok(outcome)) => outcome,
        Ok(Err(_)) => Err(json!("page tools: host response channel closed")),
        Err(_) => Err(json!("page tools: host response timed out")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// A short timeout so the timeout-path tests below don't make the suite
    /// slow; production uses `DEFAULT_HOST_TIMEOUT` (70s) instead.
    const TEST_TIMEOUT: Duration = Duration::from_millis(100);

    fn test_state() -> Arc<PageToolsState> {
        Arc::new(PageToolsState::new(TEST_TIMEOUT))
    }

    /// Opens a fresh endpoint on its own listener and returns `(endpoint_id,
    /// port, token)`, extracted from the returned URL for tests that need to
    /// build requests by hand (e.g. a deliberately wrong token).
    async fn open_for_test(state: &Arc<PageToolsState>) -> (String, u16, String) {
        let opened = open_on(state).await.expect("open_on should succeed");
        let endpoint_id = opened["endpointId"].as_str().unwrap().to_string();
        let url = opened["url"].as_str().unwrap().to_string();
        let rest = url.strip_prefix("http://127.0.0.1:").unwrap();
        let (port_str, token) = rest.split_once("/mcp/").unwrap();
        (endpoint_id, port_str.parse().unwrap(), token.to_string())
    }

    /// A fake extension: answers the first `host_request` it receives with
    /// `outcome`, whatever the method. Returns the join handle so callers
    /// that care can await it, but most tests just let it finish on its own.
    fn fake_extension_answering(
        state: &Arc<PageToolsState>,
        outcome: Result<Value, Value>,
    ) -> tokio::task::JoinHandle<()> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<HostRequestItem>(4);
        state.set_host_request_tx(tx);
        tokio::spawn(async move {
            let (_id, _method, _params, _context, response_tx) =
                rx.recv().await.expect("a host_request should arrive");
            let _ = response_tx.send(outcome);
        })
    }

    async fn raw_request(
        port: u16,
        method: &str,
        path: &str,
        host: &str,
        origin: Option<&str>,
        content_type: Option<&str>,
        body: &[u8],
    ) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let mut request =
            format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n");
        if let Some(ct) = content_type {
            request.push_str(&format!("Content-Type: {ct}\r\n"));
        }
        if let Some(o) = origin {
            request.push_str(&format!("Origin: {o}\r\n"));
        }
        request.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
        stream
            .write_all(request.as_bytes())
            .await
            .expect("write head");
        stream.write_all(body).await.expect("write body");
        let mut buf = vec![0u8; 512];
        let n = stream.read(&mut buf).await.expect("read response");
        let text = String::from_utf8_lossy(&buf[..n]);
        text.lines()
            .next()
            .unwrap_or("")
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    }

    #[test]
    fn constant_time_eq_matches_only_identical_bytes() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
        assert!(constant_time_eq(b"", b""));
    }

    #[tokio::test]
    async fn open_mints_distinct_endpoints_on_the_same_listener() {
        let state = test_state();
        let (id_a, port_a, token_a) = open_for_test(&state).await;
        let (id_b, port_b, token_b) = open_for_test(&state).await;
        assert_ne!(id_a, id_b);
        assert_ne!(token_a, token_b);
        assert_eq!(
            port_a, port_b,
            "a second open should reuse the one listener"
        );
    }

    #[tokio::test]
    async fn endpoint_ids_carry_a_random_part_and_never_contain_the_token() {
        let state = test_state();
        let (id, _port, token) = open_for_test(&state).await;
        // "pt-<counter>-<random>"; the random part is base64url, so it may
        // itself contain '-'. Take everything after the second '-'.
        let random = id.splitn(3, '-').nth(2).unwrap_or("");
        assert_eq!(
            random.len(),
            16,
            "endpoint id {id:?} has no 16-character random part"
        );
        assert!(
            !id.contains(&token),
            "the endpoint id must not reveal the URL token"
        );
    }

    #[tokio::test]
    async fn close_is_idempotent_and_an_unknown_id_is_not_an_error() {
        let state = test_state();
        let (endpoint_id, _port, _token) = open_for_test(&state).await;

        let first = close_on(&state, json!({ "endpointId": endpoint_id }))
            .await
            .unwrap();
        assert_eq!(first, json!({ "closed": true }));

        let second = close_on(&state, json!({ "endpointId": endpoint_id }))
            .await
            .unwrap();
        assert_eq!(second, json!({ "closed": false }));

        let unknown = close_on(&state, json!({ "endpointId": "pt-never-opened" }))
            .await
            .unwrap();
        assert_eq!(unknown, json!({ "closed": false }));
    }

    #[tokio::test]
    async fn a_closed_token_404s() {
        let state = test_state();
        let (endpoint_id, port, token) = open_for_test(&state).await;
        close_on(&state, json!({ "endpointId": endpoint_id }))
            .await
            .unwrap();

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn an_unknown_token_404s() {
        let state = test_state();
        let (_endpoint_id, port, _token) = open_for_test(&state).await;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{}/mcp/not-a-real-token", port))
            .header("content-type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);
    }

    #[tokio::test]
    async fn a_mismatched_host_header_is_403() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;

        let status = raw_request(
            port,
            "POST",
            &format!("/mcp/{}", token),
            "evil.example:9999",
            None,
            Some("application/json"),
            br#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#,
        )
        .await;
        assert_eq!(status, 403);
    }

    #[tokio::test]
    async fn a_correct_host_header_is_accepted() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;

        let status = raw_request(
            port,
            "POST",
            &format!("/mcp/{}", token),
            &format!("127.0.0.1:{}", port),
            None,
            Some("application/json"),
            br#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#,
        )
        .await;
        assert_eq!(status, 200);
    }

    #[tokio::test]
    async fn any_origin_header_is_403() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;

        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "application/json")
            .header(reqwest::header::ORIGIN, "http://evil.example")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 403);
    }

    #[tokio::test]
    async fn get_is_405_and_delete_is_204_and_does_not_close() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/mcp/{}", port, token);

        let get_resp = client.get(&url).send().await.unwrap();
        assert_eq!(get_resp.status(), 405);

        let delete_resp = client.delete(&url).send().await.unwrap();
        assert!(delete_resp.status() == 200 || delete_resp.status() == 204);

        // The endpoint must still work after DELETE: only page_tools.close
        // removes it.
        let ping_resp = client
            .post(&url)
            .header("content-type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(ping_resp.status(), 200);
    }

    #[tokio::test]
    async fn wrong_content_type_is_415() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "text/plain")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 415);
    }

    #[tokio::test]
    async fn oversized_body_is_413() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let client = reqwest::Client::new();
        let huge = vec![b'a'; MAX_BODY_BYTES + 1];
        let resp = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "application/json")
            .body(huge)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 413);
    }

    #[tokio::test]
    async fn a_batch_array_is_400() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "application/json")
            .body(r#"[{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}]"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 400);
    }

    #[tokio::test]
    async fn initialize_echoes_a_supported_version_and_defaults_otherwise() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let client = reqwest::Client::new();
        let url = format!("http://127.0.0.1:{}/mcp/{}", port, token);

        for (requested, expected) in [
            ("2025-06-18", "2025-06-18"),
            ("2025-03-26", "2025-03-26"),
            ("1999-01-01", "2025-06-18"),
        ] {
            let resp: Value = client
                .post(&url)
                .header("content-type", "application/json")
                .body(
                    json!({
                        "jsonrpc": "2.0",
                        "id": 1,
                        "method": "initialize",
                        "params": { "protocolVersion": requested },
                    })
                    .to_string(),
                )
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            assert_eq!(resp["result"]["protocolVersion"], json!(expected));
            assert_eq!(
                resp["result"]["capabilities"]["tools"]["listChanged"],
                json!(false)
            );
            assert_eq!(
                resp["result"]["serverInfo"]["name"],
                json!("harbor-page-tools")
            );
        }
    }

    #[tokio::test]
    async fn a_notification_gets_202_with_an_empty_body() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "application/json")
            .body(r#"{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}"#)
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 202);
        let text = resp.text().await.unwrap();
        assert!(text.is_empty());
    }

    #[tokio::test]
    async fn ping_returns_an_empty_object() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let client = reqwest::Client::new();
        let resp: Value = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":7,"method":"ping","params":{}}"#)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(resp["id"], json!(7));
        assert_eq!(resp["result"], json!({}));
    }

    #[tokio::test]
    async fn an_unknown_method_is_minus_32601() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let client = reqwest::Client::new();
        let resp: Value = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"not/a/real/method","params":{}}"#)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(resp["error"]["code"], json!(-32601));
    }

    #[tokio::test]
    async fn tools_list_passes_harbors_provenance_meta_but_only_as_an_object() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let _handle = fake_extension_answering(
            &state,
            Ok(json!({
                "tools": [
                    { "name": "a", "description": "a", "_meta": { "harbor/provenance": { "source": "page-tool", "origin": "https://tale.example" } } },
                    { "name": "b", "description": "b", "_meta": "not an object" },
                ],
            })),
        );
        let client = reqwest::Client::new();
        let resp: Value = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(
            tools[0]["_meta"]["harbor/provenance"]["origin"],
            json!("https://tale.example")
        );
        assert!(tools[1].get("_meta").is_none());
    }

    #[tokio::test]
    async fn tools_list_relays_through_http_and_keeps_only_known_fields() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let _handle = fake_extension_answering(
            &state,
            Ok(json!({
                "tools": [{
                    "name": "doit",
                    "description": "does it",
                    "inputSchema": { "type": "object", "properties": {} },
                    "unexpectedExtraField": "dropped",
                }],
            })),
        );

        let client = reqwest::Client::new();
        let resp: Value = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "application/json")
            .body(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}"#)
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        let tools = resp["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], json!("doit"));
        assert_eq!(tools[0]["description"], json!("does it"));
        assert_eq!(tools[0]["inputSchema"]["type"], json!("object"));
        assert!(tools[0].get("unexpectedExtraField").is_none());
    }

    #[tokio::test]
    async fn tools_list_keeps_title_output_schema_and_annotations() {
        let state = test_state();
        let (endpoint_id, _port, _token) = open_for_test(&state).await;
        let _handle = fake_extension_answering(
            &state,
            Ok(json!({
                "tools": [
                    {
                        "name": "reading_position",
                        "title": "Reading position",
                        "outputSchema": { "type": "object" },
                        "annotations": { "readOnlyHint": true },
                    },
                    // Wrong types are dropped, not passed on.
                    { "name": "odd", "title": 5, "outputSchema": [], "annotations": "yes" },
                    // MCP requires outputSchema.type "object".
                    { "name": "list", "outputSchema": { "type": "array" } },
                ],
            })),
        );

        let result = relay_list(&state, &endpoint_id).await.unwrap();
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools[0]["title"], json!("Reading position"));
        assert_eq!(tools[0]["outputSchema"], json!({ "type": "object" }));
        assert_eq!(tools[0]["annotations"], json!({ "readOnlyHint": true }));
        assert!(tools[1].get("title").is_none());
        assert!(tools[1].get("outputSchema").is_none());
        assert!(tools[1].get("annotations").is_none());
        assert!(tools[2].get("outputSchema").is_none());
    }

    #[tokio::test]
    async fn tools_list_defaults_a_missing_input_schema() {
        let state = test_state();
        let (endpoint_id, _port, _token) = open_for_test(&state).await;
        let _handle =
            fake_extension_answering(&state, Ok(json!({ "tools": [{ "name": "bare" }] })));

        let result = relay_list(&state, &endpoint_id).await.unwrap();
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools[0]["inputSchema"], json!({ "type": "object" }));
    }

    #[tokio::test]
    async fn tools_call_relays_the_call_tool_result_verbatim() {
        let state = test_state();
        let (_endpoint_id, port, token) = open_for_test(&state).await;
        let _handle = fake_extension_answering(
            &state,
            Ok(json!({
                "content": [{ "type": "text", "text": "it worked" }],
                "structuredContent": { "ok": true },
            })),
        );

        let client = reqwest::Client::new();
        let resp: Value = client
            .post(format!("http://127.0.0.1:{}/mcp/{}", port, token))
            .header("content-type", "application/json")
            .body(
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "tools/call",
                    "params": { "name": "doit", "arguments": { "x": 1 } },
                })
                .to_string(),
            )
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();

        assert_eq!(resp["result"]["content"][0]["text"], json!("it worked"));
        assert_eq!(resp["result"]["structuredContent"]["ok"], json!(true));
        assert!(resp.get("error").is_none());
    }

    #[tokio::test]
    async fn a_call_error_from_the_extension_gives_is_error_text() {
        let state = test_state();
        let (endpoint_id, _port, _token) = open_for_test(&state).await;
        let _handle = fake_extension_answering(&state, Err(json!("the handler threw")));

        let result = relay_call(
            &state,
            &endpoint_id,
            json!({ "name": "doit", "arguments": {} }),
        )
        .await;
        assert_eq!(result["isError"], json!(true));
        assert_eq!(result["content"][0]["text"], json!("Page tool call failed"));
    }

    #[tokio::test]
    async fn a_call_that_times_out_gives_is_error_text() {
        let state = test_state();
        let (endpoint_id, _port, _token) = open_for_test(&state).await;

        // A fake extension that receives the request but never answers it,
        // exercising the timeout path rather than an explicit error. The
        // state's TEST_TIMEOUT (100ms) is what keeps this test fast.
        let (tx, mut rx) = tokio::sync::mpsc::channel::<HostRequestItem>(4);
        state.set_host_request_tx(tx);
        tokio::spawn(async move {
            let (_id, _method, _params, _context, response_tx) =
                rx.recv().await.expect("a host_request should arrive");
            // Hold the sender well past TEST_TIMEOUT without using it.
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(response_tx);
        });

        let result = relay_call(
            &state,
            &endpoint_id,
            json!({ "name": "doit", "arguments": {} }),
        )
        .await;
        assert_eq!(result["isError"], json!(true));
        assert_eq!(result["content"][0]["text"], json!("Page tool call failed"));
    }

    #[tokio::test]
    async fn a_list_error_from_the_extension_gives_minus_32603() {
        let state = test_state();
        let (endpoint_id, _port, _token) = open_for_test(&state).await;
        let _handle = fake_extension_answering(&state, Err(json!("listing failed")));

        let err = relay_list(&state, &endpoint_id).await.unwrap_err();
        assert_eq!(err.0, -32603);
    }

    #[tokio::test]
    async fn a_list_that_times_out_gives_minus_32603() {
        let state = test_state();
        let (endpoint_id, _port, _token) = open_for_test(&state).await;

        let (tx, mut rx) = tokio::sync::mpsc::channel::<HostRequestItem>(4);
        state.set_host_request_tx(tx);
        tokio::spawn(async move {
            let (_id, _method, _params, _context, response_tx) =
                rx.recv().await.expect("a host_request should arrive");
            tokio::time::sleep(Duration::from_secs(5)).await;
            drop(response_tx);
        });

        let err = relay_list(&state, &endpoint_id).await.unwrap_err();
        assert_eq!(err.0, -32603);
    }

    #[tokio::test]
    async fn no_host_request_sender_fails_cleanly() {
        // Simulates --http-server mode: nothing ever calls
        // set_host_request_tx on this state.
        let state = test_state();
        let (endpoint_id, _port, _token) = open_for_test(&state).await;

        let call_result = relay_call(
            &state,
            &endpoint_id,
            json!({ "name": "doit", "arguments": {} }),
        )
        .await;
        assert_eq!(call_result["isError"], json!(true));

        let list_result = relay_list(&state, &endpoint_id).await;
        assert_eq!(list_result.unwrap_err().0, -32603);
    }
}
