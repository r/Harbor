//! JavaScript runtime for MCP servers using QuickJS.
//!
//! Provides a sandboxed JavaScript environment with controlled access to:
//! - Network (fetch) with host allowlists
//! - Filesystem with path allowlists  
//! - Environment variables
//! - MCP stdio interface
//! - MCP.requestHost (ask host to open tab / get content; bridge → extension → Web Agents)

mod runtime;
mod sandbox;

pub use runtime::{JsServer, JsServerConfig, ServerHandle};
pub use sandbox::Capabilities;

use crate::native_messaging::HostRequestSender;
use crate::rpc::RpcError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

// Global registry of running JS servers
lazy_static::lazy_static! {
    static ref SERVERS: Arc<RwLock<HashMap<String, ServerHandle>>> = Arc::new(RwLock::new(HashMap::new()));
}

#[derive(Debug, Deserialize)]
pub struct StartServerParams {
    /// Unique server ID
    pub id: String,
    /// JavaScript code to run
    pub code: String,
    /// Environment variables to inject
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Capabilities/permissions
    #[serde(default)]
    pub capabilities: Capabilities,
}

#[derive(Debug, Deserialize)]
pub struct StopServerParams {
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct CallServerParams {
    pub id: String,
    pub request: serde_json::Value,
    /// Optional context (origin, tabId) for host requests (browser capture).
    #[serde(default)]
    pub context: Option<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct ServerInfo {
    pub id: String,
    pub running: bool,
}

/// Start a new JS MCP server
pub async fn start_server(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let params: StartServerParams = serde_json::from_value(params).map_err(|e| RpcError {
        code: -32602,
        message: format!("Invalid params: {}", e),
    })?;

    let mut servers = SERVERS.write().await;
    
    if servers.contains_key(&params.id) {
        return Err(RpcError {
            code: -32000,
            message: format!("Server '{}' is already running", params.id),
        });
    }

    let config = JsServerConfig {
        id: params.id.clone(),
        code: params.code,
        env: params.env,
        capabilities: params.capabilities,
    };

    let handle = JsServer::start(config).await.map_err(|e| RpcError {
        code: -32000,
        message: format!("Failed to start server: {}", e),
    })?;

    servers.insert(params.id.clone(), handle);

    tracing::info!("Started JS MCP server: {}", params.id);

    Ok(serde_json::json!({
        "id": params.id,
        "status": "running"
    }))
}

/// Stop a running JS MCP server
pub async fn stop_server(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let params: StopServerParams = serde_json::from_value(params).map_err(|e| RpcError {
        code: -32602,
        message: format!("Invalid params: {}", e),
    })?;

    let mut servers = SERVERS.write().await;
    
    if let Some(handle) = servers.remove(&params.id) {
        handle.stop().await;
        tracing::info!("Stopped JS MCP server: {}", params.id);
        Ok(serde_json::json!({
            "id": params.id,
            "status": "stopped"
        }))
    } else {
        Err(RpcError {
            code: -32000,
            message: format!("Server '{}' not found", params.id),
        })
    }
}

/// Send an MCP request to a running JS server
pub async fn call_server(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let params: CallServerParams = serde_json::from_value(params).map_err(|e| RpcError {
        code: -32602,
        message: format!("Invalid params: {}", e),
    })?;

    let servers = SERVERS.read().await;
    
    let handle = servers.get(&params.id).ok_or_else(|| RpcError {
        code: -32000,
        message: format!("Server '{}' not found", params.id),
    })?;

    handle.call(params.request).await.map_err(|e| RpcError {
        code: -32000,
        message: format!("Server call failed: {}", e),
    })
}

/// Send an MCP request to a running JS server with host request capability (browser capture).
/// When the JS server calls MCP.requestHost(), the bridge sends host_request to the extension.
pub async fn call_server_with_host(
    params: serde_json::Value,
    host_request_tx: HostRequestSender,
) -> Result<serde_json::Value, RpcError> {
    let params: CallServerParams = serde_json::from_value(params).map_err(|e| RpcError {
        code: -32602,
        message: format!("Invalid params: {}", e),
    })?;

    let servers = SERVERS.read().await;
    
    let handle = servers.get(&params.id).ok_or_else(|| RpcError {
        code: -32000,
        message: format!("Server '{}' not found", params.id),
    })?;

    handle
        .call_with_host(params.request, params.context, Some(host_request_tx))
        .await
        .map_err(|e| RpcError {
            code: -32000,
            message: format!("Server call failed: {}", e),
        })
}

/// List all running JS servers
pub async fn list_servers() -> Result<serde_json::Value, RpcError> {
    let servers = SERVERS.read().await;
    
    let list: Vec<ServerInfo> = servers
        .keys()
        .map(|id| ServerInfo {
            id: id.clone(),
            running: true,
        })
        .collect();

    Ok(serde_json::json!({ "servers": list }))
}
