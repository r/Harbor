//! HTTP and WebSocket server for Safari extension communication.
//!
//! Safari extensions can't use native messaging reliably due to sandbox restrictions.
//! This server provides alternative communication channels:
//! - HTTP POST /rpc for request/response
//! - WebSocket /ws for persistent bidirectional communication (preferred)

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{header, Method, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};
use tower_http::cors::{Any, CorsLayer};

use crate::rpc;

/// Default port for the HTTP server
pub const DEFAULT_PORT: u16 = 8766;

/// RPC request from extension
#[derive(Debug, Deserialize)]
pub struct HttpRpcRequest {
    pub id: serde_json::Value,
    pub method: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// RPC response to extension
#[derive(Debug, Serialize)]
pub struct HttpRpcResponse {
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<HttpRpcErrorResponse>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRpcErrorResponse {
    pub code: i64,
    pub message: String,
}

/// WebSocket message types (bidirectional)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum WsMessage {
    /// RPC request from client
    #[serde(rename = "rpc")]
    Rpc {
        id: serde_json::Value,
        method: String,
        #[serde(default)]
        params: serde_json::Value,
    },
    /// RPC response to client
    #[serde(rename = "rpc_response")]
    RpcResponse {
        id: serde_json::Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<HttpRpcErrorResponse>,
    },
    /// Streaming token from LLM
    #[serde(rename = "stream")]
    Stream {
        id: serde_json::Value,
        event: StreamEvent,
    },
    /// Server-initiated status message
    #[serde(rename = "status")]
    Status { status: String, message: String },
    /// Console log from JS server
    #[serde(rename = "console")]
    Console {
        server_id: String,
        level: String,
        message: String,
    },
    /// Ping/pong for keepalive
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "pong")]
    Pong,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEvent {
    pub id: String,
    #[serde(rename = "type")]
    pub event_type: String, // "token", "done", "error"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<HttpRpcErrorResponse>,
}

/// Server state shared across handlers
struct ServerState {
    /// Broadcast channel for server-initiated messages (logs, status updates)
    broadcast_tx: broadcast::Sender<WsMessage>,
}

impl ServerState {
    fn new() -> Self {
        let (broadcast_tx, _) = broadcast::channel(100);
        Self { broadcast_tx }
    }
}

/// Run the HTTP/WebSocket server for Safari extension communication
pub async fn run_http_server(port: u16) -> Result<(), String> {
    let state = Arc::new(RwLock::new(ServerState::new()));

    // CORS layer to allow Safari extension to make requests
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::ACCEPT]);

    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/rpc", post(rpc_handler))
        .route("/ws", get(ws_handler))
        .layer(cors)
        .with_state(state);

    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind to port {}: {}", port, e))?;

    tracing::info!(
        "Harbor HTTP/WebSocket server listening on http://127.0.0.1:{}",
        port
    );

    axum::serve(listener, app)
        .await
        .map_err(|e| format!("HTTP server error: {}", e))
}

/// Health check endpoint
async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "type": "status",
        "message": "Harbor bridge HTTP server running",
        "websocket": "/ws"
    }))
}

/// HTTP RPC endpoint - handles the same RPC calls as native messaging
async fn rpc_handler(
    State(_state): State<Arc<RwLock<ServerState>>>,
    Json(request): Json<HttpRpcRequest>,
) -> (StatusCode, Json<HttpRpcResponse>) {
    tracing::info!(
        "HTTP RPC request: {} (id: {:?})",
        request.method,
        request.id
    );

    // Convert to internal RPC request format
    let internal_request = rpc::RpcRequest {
        id: request.id.clone(),
        method: request.method,
        params: request.params,
    };

    // Handle the request using the same RPC handler as native messaging
    let result = rpc::handle(internal_request).await;

    let response = HttpRpcResponse {
        id: request.id,
        result: result.result,
        error: result.error.map(|e| HttpRpcErrorResponse {
            code: e.code,
            message: e.message,
        }),
    };

    (StatusCode::OK, Json(response))
}

/// WebSocket upgrade handler
async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<RwLock<ServerState>>>,
) -> impl IntoResponse {
    tracing::info!("WebSocket connection request");
    ws.on_upgrade(move |socket| handle_websocket(socket, state))
}

/// Handle a WebSocket connection
async fn handle_websocket(socket: WebSocket, state: Arc<RwLock<ServerState>>) {
    tracing::info!("WebSocket client connected");

    let (mut sender, mut receiver) = socket.split();

    // Subscribe to broadcast channel for server-initiated messages
    let mut broadcast_rx = {
        let state_read = state.read().await;
        state_read.broadcast_tx.subscribe()
    };

    // Send initial status message
    let welcome = WsMessage::Status {
        status: "ready".to_string(),
        message: "Harbor bridge WebSocket connected".to_string(),
    };
    if let Ok(json) = serde_json::to_string(&welcome) {
        let _ = sender.send(Message::Text(json)).await;
    }

    // Spawn task to forward broadcast messages to this client
    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                // Forward broadcast messages
                result = broadcast_rx.recv() => {
                    match result {
                        Ok(msg) => {
                            if let Ok(json) = serde_json::to_string(&msg) {
                                if sender.send(Message::Text(json)).await.is_err() {
                                    break;
                                }
                            }
                        }
                        Err(broadcast::error::RecvError::Closed) => break,
                        Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    }
                }
            }
        }
        sender
    });

    // Handle incoming messages
    let state_clone = state.clone();
    let mut recv_task = tokio::spawn(async move {
        while let Some(result) = receiver.next().await {
            match result {
                Ok(Message::Text(text)) => {
                    match serde_json::from_str::<WsMessage>(&text) {
                        Ok(msg) => {
                            handle_ws_message(msg, &state_clone).await;
                        }
                        Err(e) => {
                            tracing::warn!("Invalid WebSocket message: {}", e);
                        }
                    }
                }
                Ok(Message::Ping(data)) => {
                    tracing::debug!("WebSocket ping received");
                    // Pong is sent automatically by axum
                    let _ = data; // suppress unused warning
                }
                Ok(Message::Close(_)) => {
                    tracing::info!("WebSocket client requested close");
                    break;
                }
                Err(e) => {
                    tracing::warn!("WebSocket error: {}", e);
                    break;
                }
                _ => {}
            }
        }
    });

    // Wait for either task to finish
    tokio::select! {
        _ = &mut send_task => {
            recv_task.abort();
        }
        _ = &mut recv_task => {
            send_task.abort();
        }
    }

    tracing::info!("WebSocket client disconnected");
}

/// Handle an incoming WebSocket message
async fn handle_ws_message(msg: WsMessage, state: &Arc<RwLock<ServerState>>) {
    match msg {
        WsMessage::Rpc { id, method, params } => {
            tracing::info!("WebSocket RPC request: {} (id: {:?})", method, id);

            // Handle streaming requests differently
            let is_stream = method == "llm.chat" && !params.get("safari_no_stream").is_some_and(|v| v == true);

            if is_stream {
                // For streaming, we'll send multiple messages
                handle_streaming_rpc(id, method, params, state).await;
            } else {
                // Standard request/response
                let internal_request = rpc::RpcRequest {
                    id: id.clone(),
                    method,
                    params,
                };

                let result = rpc::handle(internal_request).await;

                let response = WsMessage::RpcResponse {
                    id,
                    result: result.result,
                    error: result.error.map(|e| HttpRpcErrorResponse {
                        code: e.code,
                        message: e.message,
                    }),
                };

                // Broadcast response
                let state_read = state.read().await;
                let _ = state_read.broadcast_tx.send(response);
            }
        }
        WsMessage::Ping => {
            let state_read = state.read().await;
            let _ = state_read.broadcast_tx.send(WsMessage::Pong);
        }
        _ => {
            tracing::debug!("Ignoring unexpected WebSocket message type");
        }
    }
}

/// Handle a streaming RPC request (like LLM chat)
async fn handle_streaming_rpc(
    id: serde_json::Value,
    method: String,
    params: serde_json::Value,
    state: &Arc<RwLock<ServerState>>,
) {
    let request_id = id.as_str().unwrap_or("unknown").to_string();
    
    // For now, handle streaming by making the request and sending tokens as they arrive
    // The actual streaming implementation depends on the RPC handler supporting it
    
    // First, try to handle as a streaming request if the method supports it
    let internal_request = rpc::RpcRequest {
        id: id.clone(),
        method: method.clone(),
        params: params.clone(),
    };

    // Get the result (for now, this is non-streaming, we'll enhance later)
    let result = rpc::handle(internal_request).await;

    // If it's an LLM response with content, simulate streaming by sending the content
    if let Some(ref result_value) = result.result {
        if let Some(content) = result_value.get("content").and_then(|c| c.as_str()) {
            // Send the content as a single token (could be chunked for larger responses)
            let token_event = WsMessage::Stream {
                id: id.clone(),
                event: StreamEvent {
                    id: request_id.clone(),
                    event_type: "token".to_string(),
                    token: Some(content.to_string()),
                    finish_reason: None,
                    model: result_value.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()),
                    error: None,
                },
            };

            let state_read = state.read().await;
            let _ = state_read.broadcast_tx.send(token_event);

            // Send done event
            let done_event = WsMessage::Stream {
                id: id.clone(),
                event: StreamEvent {
                    id: request_id,
                    event_type: "done".to_string(),
                    token: None,
                    finish_reason: result_value.get("finish_reason").and_then(|f| f.as_str()).map(|s| s.to_string()),
                    model: result_value.get("model").and_then(|m| m.as_str()).map(|s| s.to_string()),
                    error: None,
                },
            };
            let _ = state_read.broadcast_tx.send(done_event);
            return;
        }
    }

    // Fall back to regular response
    let response = WsMessage::RpcResponse {
        id,
        result: result.result,
        error: result.error.map(|e| HttpRpcErrorResponse {
            code: e.code,
            message: e.message,
        }),
    };

    let state_read = state.read().await;
    let _ = state_read.broadcast_tx.send(response);
}

/// Broadcast a message to all connected WebSocket clients.
/// Can be called from other parts of the codebase to push updates.
#[allow(dead_code)]
async fn broadcast_message(_state: &Arc<RwLock<ServerState>>, _msg: WsMessage) {
    // This function can be used by other modules to push messages
    // For now, it's a placeholder for future use (e.g., console log forwarding)
}
