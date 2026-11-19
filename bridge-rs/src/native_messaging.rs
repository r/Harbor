//! Native Messaging protocol handler for browser extension communication.
//!
//! The native messaging protocol uses stdin/stdout with length-prefixed JSON messages.
//! Message format: 4-byte little-endian length prefix, followed by JSON payload.
//!
//! Message types:
//! - `rpc`: RPC request from extension, expects `rpc_response` back
//! - `rpc_stream`: Streaming RPC request, sends multiple `stream` messages
//! - `ping`: Health check, responds with `status`
//! - `shutdown`: Graceful shutdown request

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};

use crate::acp;
use crate::llm;
use crate::rpc::{self, RpcRequest};

/// Message from the browser extension
#[derive(Debug, serde::Deserialize)]
struct IncomingMessage {
    #[serde(rename = "type")]
    msg_type: String,
    
    // RPC fields
    id: Option<serde_json::Value>,
    method: Option<String>,
    #[serde(default)]
    params: serde_json::Value,
    // host_response fields (when msg_type == "host_response")
    #[serde(default)]
    result: Option<serde_json::Value>,
    #[serde(default)]
    error: Option<serde_json::Value>,
}

/// Payload for sending host_request to the extension (MCP server asked host to open tab / get content).
pub type HostRequestSender = mpsc::Sender<HostRequestItem>;
pub type HostRequestItem = (
    String,
    String,
    serde_json::Value,
    serde_json::Value,
    tokio::sync::oneshot::Sender<Result<serde_json::Value, serde_json::Value>>,
);

/// Message to the browser extension
#[derive(Debug, serde::Serialize)]
struct OutgoingMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(flatten)]
    payload: serde_json::Value,
}

/// Console log message from JS servers
#[derive(Debug, Clone, serde::Serialize)]
pub struct ConsoleLogMessage {
    pub server_id: String,
    pub level: String,
    pub message: String,
}

// Global broadcast channel for console logs
lazy_static::lazy_static! {
    static ref CONSOLE_LOG_TX: broadcast::Sender<ConsoleLogMessage> = {
        let (tx, _) = broadcast::channel(100);
        tx
    };
}

/// Get a sender for console log messages (used by JS runtime)
pub fn get_console_log_sender() -> broadcast::Sender<ConsoleLogMessage> {
    CONSOLE_LOG_TX.clone()
}

/// Read a native messaging message from stdin
fn read_message(stdin: &mut io::StdinLock) -> io::Result<Option<IncomingMessage>> {
    // Read 4-byte length prefix (little-endian)
    let mut len_bytes = [0u8; 4];
    match stdin.read_exact(&mut len_bytes) {
        Ok(_) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    
    let len = u32::from_le_bytes(len_bytes) as usize;
    
    // Sanity check on message length (max 10MB for large code transfers)
    if len > 10 * 1024 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Message too large",
        ));
    }
    
    // Read the JSON payload
    let mut buffer = vec![0u8; len];
    stdin.read_exact(&mut buffer)?;
    
    // Parse JSON
    let message: IncomingMessage = serde_json::from_slice(&buffer)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    
    Ok(Some(message))
}

/// Write a native messaging message to stdout
fn write_message(stdout: &mut io::StdoutLock, message: &OutgoingMessage) -> io::Result<()> {
    let json = serde_json::to_vec(message)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    
    let len = json.len() as u32;
    let len_bytes = len.to_le_bytes();
    
    stdout.write_all(&len_bytes)?;
    stdout.write_all(&json)?;
    stdout.flush()?;
    
    Ok(())
}

/// Thread-safe message writer
struct MessageWriter {
    tx: mpsc::Sender<OutgoingMessage>,
}

impl MessageWriter {
    fn new() -> (Self, mpsc::Receiver<OutgoingMessage>) {
        let (tx, rx) = mpsc::channel(100);
        (Self { tx }, rx)
    }

    async fn send(&self, msg_type: &str, payload: serde_json::Value) {
        let msg = OutgoingMessage {
            msg_type: msg_type.to_string(),
            payload,
        };
        let _ = self.tx.send(msg).await;
    }

    async fn send_rpc_response(&self, id: serde_json::Value, result: Option<serde_json::Value>, error: Option<serde_json::Value>) {
        let mut payload = serde_json::json!({ "id": id });
        if let Some(r) = result {
            payload["result"] = r;
        }
        if let Some(e) = error {
            payload["error"] = e;
        }
        self.send("rpc_response", payload).await;
    }

    async fn send_stream_event(&self, id: serde_json::Value, event: serde_json::Value) {
        self.send("stream", serde_json::json!({
            "id": id,
            "event": event,
        })).await;
    }

    async fn send_console_log(&self, log: &ConsoleLogMessage) {
        self.send("console", serde_json::json!({
            "server_id": log.server_id,
            "level": log.level,
            "message": log.message,
        })).await;
    }

    /// Send a host_request to the extension (bridge → extension; MCP server asked for browser capture).
    async fn send_host_request(&self, id: &str, method: &str, params: serde_json::Value, context: serde_json::Value) {
        self.send("host_request", serde_json::json!({
            "id": id,
            "method": method,
            "params": params,
            "context": context,
        })).await;
    }
}

/// Run the native messaging event loop.
pub async fn run_native_messaging() {
    tracing::info!("Starting native messaging handler");
    
    // Create message writer
    let (writer, mut write_rx) = MessageWriter::new();
    let writer = Arc::new(writer);
    
    // Subscribe to console logs
    let mut console_rx = CONSOLE_LOG_TX.subscribe();
    
    // Spawn stdout writer task
    let write_handle = tokio::task::spawn_blocking(move || {
        let mut stdout = io::stdout().lock();
        while let Some(msg) = write_rx.blocking_recv() {
            if let Err(e) = write_message(&mut stdout, &msg) {
                tracing::error!("Failed to write message: {}", e);
                break;
            }
        }
    });

    // Send initial ready message
    writer.send("status", serde_json::json!({
        "status": "ready",
        "message": "Harbor bridge is running",
    })).await;

    // Spawn console log forwarder
    let console_writer = writer.clone();
    tokio::spawn(async move {
        while let Ok(log) = console_rx.recv().await {
            console_writer.send_console_log(&log).await;
        }
    });

    // Create channel for incoming messages
    let (msg_tx, mut msg_rx) = mpsc::channel::<IncomingMessage>(32);
    // Channel for host requests (JS server asks bridge to send host_request and wait for host_response)
    let (host_request_tx, mut host_request_rx) = mpsc::channel::<HostRequestItem>(32);
    let pending_host: Arc<RwLock<HashMap<String, tokio::sync::oneshot::Sender<Result<serde_json::Value, serde_json::Value>>>>> =
        Arc::new(RwLock::new(HashMap::new()));

    // Spawn stdin reader task
    tokio::task::spawn_blocking(move || {
        let mut stdin = io::stdin().lock();
        loop {
            match read_message(&mut stdin) {
                Ok(Some(msg)) => {
                    if msg_tx.blocking_send(msg).is_err() {
                        break;
                    }
                }
                Ok(None) => {
                    tracing::info!("Native messaging connection closed (EOF)");
                    break;
                }
                Err(e) => {
                    tracing::error!("Error reading native message: {}", e);
                    break;
                }
            }
        }
    });

    // Process incoming messages and host requests
    loop {
        tokio::select! {
            msg = msg_rx.recv() => {
                match msg {
                    Some(msg) if msg.msg_type == "host_response" => {
                        let id = msg.id.as_ref().and_then(|v| v.as_str()).map(String::from);
                        if let Some(id) = id {
                            let outcome = if let Some(err) = msg.error {
                                Err(err)
                            } else {
                                Ok(msg.result.unwrap_or(serde_json::Value::Null))
                            };
                            if let Some(tx) = pending_host.write().await.remove(&id) {
                                let _ = tx.send(outcome);
                            }
                        }
                    }
                    // `acp.send` is handled inline, never spawned: the read
                    // loop below hands stdin frames to `msg_tx` strictly in
                    // arrival order, and this `recv()` processes them one at
                    // a time, so enqueuing here (rather than inside a
                    // separately-scheduled spawned task, which would race
                    // other such tasks for the agent's stdin) is what keeps
                    // writes to the agent in the order the extension sent
                    // them. Every other message type keeps going through
                    // the existing spawn-per-message dispatch below.
                    Some(msg) if msg.msg_type == "rpc" && msg.method.as_deref() == Some("acp.send") => {
                        let id = msg.id.clone().unwrap_or(serde_json::Value::Null);
                        match acp::enqueue_send(msg.params).await {
                            Ok(result) => writer.send_rpc_response(id, Some(result), None).await,
                            Err(e) => writer.send_rpc_response(id, None, Some(serde_json::json!({
                                "code": e.code,
                                "message": e.message,
                            }))).await,
                        }
                    }
                    Some(msg) => {
                        // Noted here, in arrival order, so a cancel that
                        // follows can't run before the stream is known.
                        note_incoming_stream(&msg);
                        let writer_clone = writer.clone();
                        let host_tx = host_request_tx.clone();
                        tokio::spawn(async move {
                            handle_message(msg, writer_clone, host_tx).await;
                        });
                    }
                    None => {
                        // stdin closed (extension disconnected, or the
                        // native host was torn down): stop the loop so we
                        // actually shut down below, instead of only waiting
                        // forever on host_request_rx, which nothing will
                        // ever send to again.
                        tracing::info!("Native messaging stdin closed");
                        break;
                    }
                }
            }
            Some((id, method, params, context, response_tx)) = host_request_rx.recv() => {
                pending_host.write().await.insert(id.clone(), response_tx);
                writer.send_host_request(&id, &method, params, context).await;
            }
        }
    }

    tracing::info!("Native messaging handler exiting");
    drop(write_handle);
    // The extension disconnected (or we're shutting down): every agent
    // process the bridge started must die with it.
    acp::shutdown_all().await;
    // Exit directly rather than falling off the end of main(): a lingering
    // clone of the outbound-message sender (e.g. held by the console-log
    // forwarder task, which loops forever on a broadcast channel that is
    // never closed) would otherwise keep the blocking stdout-writer task
    // parked in `write_rx.blocking_recv()` forever, and dropping the tokio
    // Runtime at the end of `main()` waits for exactly that kind of
    // outstanding blocking task - hanging the process on a clean stdin EOF
    // instead of exiting. `std::process::exit` sidesteps that, matching the
    // explicit `"shutdown"` message handling below.
    std::process::exit(0);
}

/// Handle an incoming message
async fn handle_message(msg: IncomingMessage, writer: Arc<MessageWriter>, host_request_tx: HostRequestSender) {
    tracing::debug!("Received message type: {}", msg.msg_type);

    match msg.msg_type.as_str() {
        "ping" => {
            writer.send("status", serde_json::json!({
                "status": "pong",
                "message": "Bridge is alive",
            })).await;
        }
        
        "shutdown" => {
            tracing::info!("Received shutdown request");
            acp::shutdown_all().await;
            std::process::exit(0);
        }
        
        "status" => {
            writer.send("status", serde_json::json!({
                "status": "ready",
                "message": "Harbor bridge is running",
            })).await;
        }
        
        "rpc" => {
            let id = msg.id.clone().unwrap_or(serde_json::Value::Null);
            let method = msg.method.clone().unwrap_or_default();
            
            // Check if this is a streaming method
            if rpc::is_streaming_method(&method) {
                handle_streaming_rpc(id, method, msg.params, writer).await;
            } else {
                handle_rpc(id, method, msg.params, writer, host_request_tx).await;
            }
        }
        
        _ => {
            tracing::debug!("Unknown message type: {}", msg.msg_type);
        }
    }
}

/// Handle a regular RPC request
async fn handle_rpc(
    id: serde_json::Value,
    method: String,
    params: serde_json::Value,
    writer: Arc<MessageWriter>,
    host_request_tx: HostRequestSender,
) {
    let response = if method == "js.call" {
        match crate::js::call_server_with_host(params, host_request_tx).await {
            Ok(value) => rpc::RpcResponse::success(id.clone(), value),
            Err(e) => rpc::RpcResponse::error(id.clone(), e),
        }
    } else {
        let request = RpcRequest { id: id.clone(), method, params };
        rpc::handle(request).await
    };

    writer.send_rpc_response(
        response.id,
        response.result,
        response.error.map(|e| serde_json::json!({
            "code": e.code,
            "message": e.message,
        })),
    ).await;
}

/// Reserve an `llm.chat_stream` request's id as it's read, before its
/// handler is spawned, so an `llm.cancel_stream` for it is never lost to
/// the handlers running out of order.
fn note_incoming_stream(msg: &IncomingMessage) {
    if msg.msg_type == "rpc" && msg.method.as_deref() == Some("llm.chat_stream") {
        if let Some(id) = &msg.id {
            llm::reserve_stream(&llm::stream_key(id));
        }
    }
}

/// Handle a streaming RPC request
async fn handle_streaming_rpc(
    id: serde_json::Value,
    method: String,
    params: serde_json::Value,
    writer: Arc<MessageWriter>,
) {
    match method.as_str() {
        "llm.chat_stream" => {
            let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(32);
            
            // Spawn the streaming task, and keep a handle so
            // `llm.cancel_stream` can stop it when the page stops reading.
            // Aborting drops `event_tx`, which ends the loop below.
            let stream_id = id.clone();
            let key = llm::stream_key(&id);
            // A stream cancelled before this point is never started; its
            // event_tx is dropped, so the loop below ends at once.
            llm::spawn_stream(&key, async move {
                llm::chat_stream(stream_id, params, event_tx).await;
            });

            // Forward events to the extension
            while let Some(event) = event_rx.recv().await {
                let event_json = serde_json::to_value(&event).unwrap_or_default();
                writer.send_stream_event(id.clone(), event_json).await;
                
                if event.event_type == "done" || event.event_type == "error" {
                    break;
                }
            }
            llm::finish_stream(&key);
        }
        "acp.open" => {
            let (event_tx, mut event_rx) = tokio::sync::mpsc::channel(32);

            tokio::spawn(async move {
                acp::open_stream(params, event_tx).await;
            });

            // The stream stays open for the life of the agent process: it
            // ends when the process exits (an "exit" event) or when
            // `open_stream` returns early without ever opening a channel
            // (a fatal "error" event, after which the sender is dropped and
            // `recv` returns `None`).
            while let Some(event) = event_rx.recv().await {
                let is_exit = event.get("type").and_then(|t| t.as_str()) == Some("exit");
                writer.send_stream_event(id.clone(), event).await;
                if is_exit {
                    break;
                }
            }
        }
        _ => {
            writer.send_rpc_response(
                id,
                None,
                Some(serde_json::json!({
                    "code": -32601,
                    "message": format!("Unknown streaming method: {}", method),
                })),
            ).await;
        }
    }
}

#[cfg(test)]
mod stream_cancel_tests {
    use super::*;
    use std::time::Duration;

    fn chat_stream_message(id: &str) -> IncomingMessage {
        IncomingMessage {
            msg_type: "rpc".to_string(),
            id: Some(serde_json::json!(id)),
            method: Some("llm.chat_stream".to_string()),
            params: serde_json::json!({
                "model": "ollama:never-called",
                "messages": [{ "role": "user", "content": "hi" }],
            }),
            result: None,
            error: None,
        }
    }

    #[tokio::test]
    async fn a_cancel_handled_before_the_stream_task_starts_stops_the_stream() {
        // The read loop notes the stream in arrival order; the cancel that
        // follows it can then run before the stream's handler does.
        let msg = chat_stream_message("early-cancel");
        note_incoming_stream(&msg);
        let cancelled = llm::cancel_stream(serde_json::json!({ "id": "early-cancel" }))
            .await
            .unwrap();
        assert_eq!(cancelled, serde_json::json!({ "cancelled": true }));

        let (writer, mut out) = MessageWriter::new();
        tokio::time::timeout(
            Duration::from_secs(5),
            handle_streaming_rpc(msg.id.clone().unwrap(), "llm.chat_stream".to_string(), msg.params, Arc::new(writer)),
        )
        .await
        .expect("the cancelled stream kept running");
        assert!(out.try_recv().is_err(), "a cancelled stream still sent events");

        // Nothing is left behind for that id.
        let again = llm::cancel_stream(serde_json::json!({ "id": "early-cancel" }))
            .await
            .unwrap();
        assert_eq!(again, serde_json::json!({ "cancelled": false }));
    }

    #[test]
    fn only_chat_stream_requests_are_noted() {
        let mut other = chat_stream_message("not-a-stream");
        other.method = Some("llm.chat".to_string());
        note_incoming_stream(&other);
        assert!(!llm::is_stream_known("not-a-stream"));
        note_incoming_stream(&chat_stream_message("a-stream"));
        assert!(llm::is_stream_known("a-stream"));
        llm::finish_stream("a-stream");
    }
}
