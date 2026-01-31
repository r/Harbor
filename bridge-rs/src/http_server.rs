//! HTTP server for Safari extension communication.
//!
//! Safari extensions can't use native messaging reliably due to sandbox restrictions.
//! This HTTP server provides an alternative communication channel.

use axum::{
    extract::State,
    http::{header, Method, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::RwLock;
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

#[derive(Debug, Serialize)]
pub struct HttpRpcErrorResponse {
    pub code: i64,
    pub message: String,
}

/// Server state
struct ServerState {
    // Could add state here if needed
}

/// Run the HTTP server for Safari extension communication
pub async fn run_http_server(port: u16) -> Result<(), String> {
    let state = Arc::new(RwLock::new(ServerState {}));
    
    // CORS layer to allow Safari extension to make requests
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::ACCEPT]);
    
    let app = Router::new()
        .route("/health", get(health_handler))
        .route("/rpc", post(rpc_handler))
        .layer(cors)
        .with_state(state);
    
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| format!("Failed to bind to port {}: {}", port, e))?;
    
    tracing::info!("Harbor HTTP server listening on http://127.0.0.1:{}", port);
    
    axum::serve(listener, app)
        .await
        .map_err(|e| format!("HTTP server error: {}", e))
}

/// Health check endpoint
async fn health_handler() -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "type": "status",
        "message": "Harbor bridge HTTP server running"
    }))
}

/// RPC endpoint - handles the same RPC calls as native messaging
async fn rpc_handler(
    State(_state): State<Arc<RwLock<ServerState>>>,
    Json(request): Json<HttpRpcRequest>,
) -> (StatusCode, Json<HttpRpcResponse>) {
    tracing::info!("HTTP RPC request: {} (id: {:?})", request.method, request.id);
    
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
