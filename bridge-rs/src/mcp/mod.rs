//! MCP tool registry for Safari compatibility.
//! 
//! In Safari, Harbor's WASM servers run in the browser extension,
//! but Web Agents can only communicate with the bridge via HTTP.
//! This module maintains a registry of tools that Harbor syncs to the bridge,
//! allowing Web Agents to query available tools.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use tokio::sync::RwLock;

use crate::rpc::RpcError;

/// A registered MCP tool
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegisteredTool {
    #[serde(rename = "serverId", alias = "server_id")]
    pub server_id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", rename = "inputSchema", alias = "input_schema")]
    pub input_schema: Option<serde_json::Value>,
}

/// Global tool registry
fn tool_registry() -> &'static RwLock<HashMap<String, RegisteredTool>> {
    static REGISTRY: OnceLock<RwLock<HashMap<String, RegisteredTool>>> = OnceLock::new();
    REGISTRY.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Register tools from a server
#[derive(Debug, Deserialize)]
pub struct RegisterToolsParams {
    pub server_id: String,
    pub tools: Vec<ToolInfo>,
}

#[derive(Debug, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "inputSchema")]
    pub input_schema: Option<serde_json::Value>,
}

pub async fn register_tools(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let params: RegisterToolsParams = serde_json::from_value(params).map_err(|e| RpcError {
        code: -32602,
        message: format!("Invalid params: {}", e),
    })?;
    
    let mut registry = tool_registry().write().await;
    
    for tool in params.tools {
        let full_name = format!("{}/{}", params.server_id, tool.name);
        registry.insert(full_name.clone(), RegisteredTool {
            server_id: params.server_id.clone(),
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
        });
    }
    
    Ok(serde_json::json!({ "ok": true }))
}

/// Unregister tools from a server
#[derive(Debug, Deserialize)]
pub struct UnregisterToolsParams {
    pub server_id: String,
}

pub async fn unregister_tools(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let params: UnregisterToolsParams = serde_json::from_value(params).map_err(|e| RpcError {
        code: -32602,
        message: format!("Invalid params: {}", e),
    })?;
    
    let mut registry = tool_registry().write().await;
    
    // Remove all tools from this server
    registry.retain(|_, tool| tool.server_id != params.server_id);
    
    Ok(serde_json::json!({ "ok": true }))
}

/// List all registered tools
pub async fn list_tools() -> Result<serde_json::Value, RpcError> {
    let registry = tool_registry().read().await;
    
    let tools: Vec<RegisteredTool> = registry.values().cloned().collect();
    
    Ok(serde_json::json!({ "tools": tools }))
}

// ============================================================================
// Tool Call Queue (for WASM servers that run in Harbor, not the bridge)
// ============================================================================

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

static CALL_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
pub struct PendingToolCall {
    pub call_id: String,
    #[serde(rename = "serverId")]
    pub server_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    pub args: serde_json::Value,
    #[serde(skip)]
    #[allow(dead_code)]
    pub created_at: Instant,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolCallResult {
    pub call_id: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

fn pending_calls() -> &'static RwLock<HashMap<String, PendingToolCall>> {
    static PENDING: OnceLock<RwLock<HashMap<String, PendingToolCall>>> = OnceLock::new();
    PENDING.get_or_init(|| RwLock::new(HashMap::new()))
}

fn call_results() -> &'static RwLock<HashMap<String, ToolCallResult>> {
    static RESULTS: OnceLock<RwLock<HashMap<String, ToolCallResult>>> = OnceLock::new();
    RESULTS.get_or_init(|| RwLock::new(HashMap::new()))
}

/// Call a tool - queues for WASM servers, calls directly for JS servers
#[derive(Debug, Deserialize)]
pub struct CallToolParams {
    #[serde(rename = "serverId")]
    pub server_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

pub async fn call_tool(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let params: CallToolParams = serde_json::from_value(params).map_err(|e| RpcError {
        code: -32602,
        message: format!("Invalid params: {}", e),
    })?;
    
    // First, try calling via JS runtime (works for JS servers)
    let js_request = serde_json::json!({
        "id": params.server_id,
        "request": {
            "method": "tools/call",
            "params": {
                "name": params.tool_name,
                "arguments": params.args
            }
        }
    });
    
    match crate::js::call_server(js_request).await {
        Ok(result) => {
            // JS server call succeeded — pass through the full MCP result (content + any extra keys e.g. searchResult)
            if let Some(mcp_result) = result.get("result") {
                return Ok(serde_json::json!({ "result": mcp_result }));
            }
            Ok(serde_json::json!({ "result": result }))
        }
        Err(_) => {
            // JS call failed - queue for Harbor to handle (WASM servers)
            let call_id = format!("call-{}", CALL_COUNTER.fetch_add(1, Ordering::SeqCst));
            
            let pending = PendingToolCall {
                call_id: call_id.clone(),
                server_id: params.server_id,
                tool_name: params.tool_name,
                args: params.args,
                created_at: Instant::now(),
            };
            
            pending_calls().write().await.insert(call_id.clone(), pending);
            
            // Wait for result with timeout (capture can include scroll-to-end for article pages)
            let timeout = Duration::from_secs(60);
            let start = Instant::now();
            
            loop {
                tokio::time::sleep(Duration::from_millis(100)).await;
                
                if let Some(result) = call_results().write().await.remove(&call_id) {
                    // Clean up pending
                    pending_calls().write().await.remove(&call_id);
                    
                    if let Some(err) = result.error {
                        return Err(RpcError {
                            code: -32000,
                            message: err,
                        });
                    }
                    return Ok(serde_json::json!({ "result": result.result }));
                }
                
                if start.elapsed() > timeout {
                    pending_calls().write().await.remove(&call_id);
                    return Err(RpcError {
                        code: -32000,
                        message: "Tool call timed out waiting for Harbor".to_string(),
                    });
                }
            }
        }
    }
}

/// Get pending tool calls (called by Harbor to execute WASM tools)
pub async fn poll_pending_calls() -> Result<serde_json::Value, RpcError> {
    let pending = pending_calls().read().await;
    let calls: Vec<&PendingToolCall> = pending.values().collect();
    Ok(serde_json::json!({ "calls": calls }))
}

/// Submit a tool call result (called by Harbor after executing WASM tool)
#[derive(Debug, Deserialize)]
pub struct SubmitResultParams {
    pub call_id: String,
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

pub async fn submit_call_result(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let params: SubmitResultParams = serde_json::from_value(params).map_err(|e| RpcError {
        code: -32602,
        message: format!("Invalid params: {}", e),
    })?;
    
    let result = ToolCallResult {
        call_id: params.call_id.clone(),
        result: params.result,
        error: params.error,
    };
    
    call_results().write().await.insert(params.call_id, result);
    
    Ok(serde_json::json!({ "ok": true }))
}
