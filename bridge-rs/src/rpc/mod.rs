//! RPC request handling for the native messaging bridge.
//!
//! This module uses a handler registry pattern to dispatch RPC methods
//! to their appropriate handlers. Each domain module (llm, fs, oauth, etc.)
//! registers its own handlers during initialization.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::{fs, js, llm, mcp, oauth};

// =============================================================================
// Types
// =============================================================================

#[derive(Debug, Deserialize)]
pub struct RpcRequest {
  pub id: serde_json::Value,
  pub method: String,
  #[serde(default)]
  pub params: serde_json::Value,
}

#[derive(Debug, Serialize)]
pub struct RpcResponse {
  pub id: serde_json::Value,
  pub result: Option<serde_json::Value>,
  pub error: Option<RpcError>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RpcError {
  pub code: i64,
  pub message: String,
}

impl RpcError {
  pub fn new(code: i64, message: impl Into<String>) -> Self {
    RpcError {
      code,
      message: message.into(),
    }
  }

  /// Standard JSON-RPC error: Method not found
  pub fn method_not_found(method: &str) -> Self {
    RpcError::new(-32601, format!("Unknown method: {}", method))
  }

  /// Standard JSON-RPC error: Invalid params
  #[allow(dead_code)]
  pub fn invalid_params(message: impl Into<String>) -> Self {
    RpcError::new(-32602, message)
  }

  /// Standard JSON-RPC error: Internal error
  #[allow(dead_code)]
  pub fn internal(message: impl Into<String>) -> Self {
    RpcError::new(-32603, message)
  }
}

impl RpcResponse {
  pub fn success(id: serde_json::Value, result: serde_json::Value) -> Self {
    RpcResponse {
      id,
      result: Some(result),
      error: None,
    }
  }

  pub fn error(id: serde_json::Value, error: RpcError) -> Self {
    RpcResponse {
      id,
      result: None,
      error: Some(error),
    }
  }
}

// =============================================================================
// Handler Registry
// =============================================================================

/// Type alias for RPC handler functions.
/// Handlers receive params and return a Result with JSON value or error.
pub type RpcHandler = fn(
  serde_json::Value,
) -> Pin<Box<dyn Future<Output = Result<serde_json::Value, RpcError>> + Send>>;

/// Global handler registry.
static HANDLERS: OnceLock<HashMap<&'static str, RpcHandler>> = OnceLock::new();

/// Initialize the handler registry with all method handlers.
fn get_handlers() -> &'static HashMap<&'static str, RpcHandler> {
  HANDLERS.get_or_init(|| {
    let mut handlers: HashMap<&'static str, RpcHandler> = HashMap::new();

    // System handlers
    handlers.insert("system.health", |_| {
      Box::pin(async { Ok(serde_json::json!({ "status": "ok" })) })
    });

    // LLM handlers
    register_llm_handlers(&mut handlers);

    // Filesystem handlers
    register_fs_handlers(&mut handlers);

    // JavaScript MCP server handlers
    register_js_handlers(&mut handlers);

    // OAuth handlers
    register_oauth_handlers(&mut handlers);

    // MCP tool registry handlers
    register_mcp_handlers(&mut handlers);

    handlers
  })
}

// =============================================================================
// Domain Handler Registration
// =============================================================================

fn register_llm_handlers(handlers: &mut HashMap<&'static str, RpcHandler>) {
  handlers.insert("llm.health", |_| Box::pin(llm::health()));
  handlers.insert("llm.list_models", |_| Box::pin(llm::list_models()));
  handlers.insert("llm.chat", |p| Box::pin(llm::chat(p)));
  handlers.insert("llm.list_providers", |_| Box::pin(llm::list_providers()));
  handlers.insert("llm.list_provider_types", |_| Box::pin(llm::list_provider_types()));
  handlers.insert("llm.check_provider", |p| Box::pin(llm::check_provider_status(p)));
  handlers.insert("llm.configure_provider", |p| Box::pin(llm::configure_provider(p)));
  handlers.insert("llm.add_provider", |p| Box::pin(llm::add_provider(p)));
  handlers.insert("llm.remove_provider", |p| Box::pin(llm::remove_provider(p)));
  handlers.insert("llm.set_default_provider", |p| Box::pin(llm::set_default_provider(p)));
  handlers.insert("llm.set_type_default", |p| Box::pin(llm::set_type_default(p)));
  handlers.insert("llm.get_config", |_| Box::pin(llm::get_configuration()));
  handlers.insert("llm.set_default_model", |p| Box::pin(llm::set_default_model(p)));
  handlers.insert("llm.list_configured_models", |_| Box::pin(llm::list_configured_models()));
  handlers.insert("llm.get_configured_models_metadata", |_| Box::pin(llm::get_configured_models_metadata()));
  handlers.insert("llm.add_configured_model", |p| Box::pin(llm::add_configured_model(p)));
  handlers.insert("llm.remove_configured_model", |p| Box::pin(llm::remove_configured_model(p)));
  handlers.insert("llm.set_configured_model_default", |p| {
    Box::pin(llm::set_configured_model_default(p))
  });
}

fn register_fs_handlers(handlers: &mut HashMap<&'static str, RpcHandler>) {
  handlers.insert("fs.read", |p| Box::pin(fs::read(p)));
  handlers.insert("fs.write", |p| Box::pin(fs::write(p)));
  handlers.insert("fs.list", |p| Box::pin(fs::list(p)));
}

fn register_js_handlers(handlers: &mut HashMap<&'static str, RpcHandler>) {
  handlers.insert("js.start_server", |p| Box::pin(js::start_server(p)));
  handlers.insert("js.stop_server", |p| Box::pin(js::stop_server(p)));
  handlers.insert("js.call", |p| Box::pin(js::call_server(p)));
  handlers.insert("js.list_servers", |_| Box::pin(js::list_servers()));
}

fn register_oauth_handlers(handlers: &mut HashMap<&'static str, RpcHandler>) {
  handlers.insert("oauth.start_flow", |p| Box::pin(oauth::rpc_start_flow(p)));
  handlers.insert("oauth.get_tokens", |p| Box::pin(oauth::rpc_get_tokens(p)));
  handlers.insert("oauth.status", |p| Box::pin(oauth::rpc_status(p)));
  handlers.insert("oauth.revoke", |p| Box::pin(oauth::rpc_revoke(p)));
  handlers.insert("oauth.list_providers", |p| Box::pin(oauth::rpc_list_providers(p)));
  handlers.insert("oauth.get_credentials_status", |p| {
    Box::pin(oauth::rpc_get_credentials_status(p))
  });
  handlers.insert("oauth.set_credentials", |p| Box::pin(oauth::rpc_set_credentials(p)));
  handlers.insert("oauth.remove_credentials", |p| Box::pin(oauth::rpc_remove_credentials(p)));
}

fn register_mcp_handlers(handlers: &mut HashMap<&'static str, RpcHandler>) {
  handlers.insert("mcp.register_tools", |p| Box::pin(mcp::register_tools(p)));
  handlers.insert("mcp.unregister_tools", |p| Box::pin(mcp::unregister_tools(p)));
  handlers.insert("mcp.list_tools", |_| Box::pin(mcp::list_tools()));
  handlers.insert("mcp.call_tool", |p| Box::pin(mcp::call_tool(p)));
  handlers.insert("mcp.poll_pending_calls", |_| Box::pin(mcp::poll_pending_calls()));
  handlers.insert("mcp.submit_call_result", |p| Box::pin(mcp::submit_call_result(p)));
}

// =============================================================================
// Request Handling
// =============================================================================

/// Handle an RPC request and return a response.
pub async fn handle(request: RpcRequest) -> RpcResponse {
  let handlers = get_handlers();

  match handlers.get(request.method.as_str()) {
    Some(handler) => {
      let result = handler(request.params).await;
      match result {
        Ok(value) => RpcResponse::success(request.id, value),
        Err(error) => RpcResponse::error(request.id, error),
      }
    }
    None => RpcResponse::error(request.id, RpcError::method_not_found(&request.method)),
  }
}

/// Check if a method is a streaming method.
/// Streaming methods are handled differently (they send multiple messages).
pub fn is_streaming_method(method: &str) -> bool {
  matches!(method, "llm.chat_stream")
}

/// List all registered RPC methods.
/// Useful for debugging and introspection.
#[allow(dead_code)]
pub fn list_methods() -> Vec<&'static str> {
  let mut methods: Vec<&'static str> = get_handlers().keys().copied().collect();
  methods.sort();
  methods
}

// =============================================================================
// Tests
// =============================================================================

#[cfg(test)]
mod tests {
  use super::*;

  #[tokio::test]
  async fn test_system_health() {
    let request = RpcRequest {
      id: serde_json::json!(1),
      method: "system.health".to_string(),
      params: serde_json::json!({}),
    };

    let response = handle(request).await;
    assert!(response.error.is_none());
    assert!(response.result.is_some());
  }

  #[tokio::test]
  async fn test_unknown_method() {
    let request = RpcRequest {
      id: serde_json::json!(1),
      method: "unknown.method".to_string(),
      params: serde_json::json!({}),
    };

    let response = handle(request).await;
    assert!(response.error.is_some());
    assert_eq!(response.error.unwrap().code, -32601);
  }

  #[test]
  fn test_list_methods() {
    let methods = list_methods();
    assert!(methods.contains(&"system.health"));
    assert!(methods.contains(&"llm.chat"));
    assert!(methods.contains(&"fs.read"));
  }
}
