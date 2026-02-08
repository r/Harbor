//! LLM module using any-llm for multi-provider support.

mod config;

pub use config::{LlmConfig, ProviderInstance};

use crate::rpc::RpcError;
use any_llm::{
    check_provider, completion, completion_stream, get_supported_providers, list_models as any_llm_list_models,
    CompletionRequest, Message, ProviderConfig, Tool, ToolFunction,
};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use std::sync::RwLock;
use tokio::sync::mpsc;

// Global configuration store
static CONFIG: RwLock<Option<LlmConfig>> = RwLock::new(None);

/// Initialize or update LLM configuration.
pub fn set_config(config: LlmConfig) {
    let mut cfg = CONFIG.write().unwrap();
    *cfg = Some(config);
}

/// Get current configuration.
pub fn get_config() -> Option<LlmConfig> {
    CONFIG.read().unwrap().clone()
}

/// Check health of LLM providers.
pub async fn health() -> Result<serde_json::Value, RpcError> {
    let providers = get_supported_providers();
    let mut statuses = Vec::new();

    for provider in &providers {
        let config = get_provider_config(provider);
        let status = check_provider(provider, config).await;
        statuses.push(status);
    }

    Ok(serde_json::json!({
        "status": "ok",
        "providers": statuses
    }))
}

/// List available models from all configured providers.
pub async fn list_models() -> Result<serde_json::Value, RpcError> {
    let mut all_models: Vec<serde_json::Value> = Vec::new();

    // Check local providers first (Ollama, Llamafile)
    for provider in &["ollama", "llamafile"] {
        let config = get_provider_config(provider);
        if let Ok(models) = any_llm_list_models(provider, config).await {
            // Prefix model IDs with provider name for routing
            for model in models {
                all_models.push(serde_json::json!({
                    "id": format!("{}:{}", provider, model.id),
                    "provider": provider,
                    "owned_by": model.owned_by,
                }));
            }
        }
    }

    // Check remote providers if configured
    let cfg = get_config();
    if let Some(config) = &cfg {
        for (_instance_id, settings) in &config.providers {
            // Use provider_type (e.g., "openai") not instance_id (e.g., "openai-3090e2")
            let provider_type = &settings.provider_type;
            if settings.enabled && settings.api_key.is_some() {
                let provider_config = Some(ProviderConfig {
                    api_key: Some(settings.api_key.clone()),
                    base_url: settings.base_url.clone(),
                    ..Default::default()
                });
                if let Ok(models) = any_llm_list_models(provider_type, provider_config).await {
                    // Prefix model IDs with provider type for routing
                    for model in models {
                        all_models.push(serde_json::json!({
                            "id": format!("{}:{}", provider_type, model.id),
                            "provider": provider_type,
                            "owned_by": model.owned_by,
                        }));
                    }
                }
            }
        }
    }

    Ok(serde_json::json!({ "models": all_models }))
}

/// Chat completion request.
pub async fn chat(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let request: ChatRequest = serde_json::from_value(params).map_err(|e| RpcError {
        code: -32602,
        message: format!("Invalid params: {}", e),
    })?;

    // Use provided model or fall back to default
    let model = request.model.or_else(|| {
        get_config().and_then(|c| c.default_model.clone())
    }).ok_or_else(|| RpcError {
        code: -32602,
        message: "No model specified and no default model configured".to_string(),
    })?;

    // Build messages, prepending system prompt if provided
    let mut messages: Vec<Message> = Vec::new();
    
    if let Some(system_prompt) = &request.system_prompt {
        messages.push(Message::system(system_prompt.clone()));
    }
    
    for m in request.messages {
        let msg = match m.role.as_str() {
            "system" => Message::system(m.content),
            "user" => Message::user(m.content),
            "assistant" => Message::assistant(m.content),
            "tool" => Message::tool(m.tool_call_id.unwrap_or_default(), m.content),
            _ => Message::user(m.content),
        };
        messages.push(msg);
    }

    // Convert tool definitions to any-llm format
    let tools: Option<Vec<Tool>> = request.tools.map(|defs| {
        defs.into_iter()
            .map(|d| Tool {
                tool_type: "function".to_string(),
                function: ToolFunction {
                    name: d.name,
                    description: d.description,
                    parameters: d.input_schema,
                },
            })
            .collect()
    });

    let provider_config = get_provider_config_for_model(&model);

    let completion_request = CompletionRequest {
        model,
        messages,
        tools,
        temperature: request.temperature,
        max_tokens: request.max_tokens,
        api_key: provider_config.and_then(|c| c.api_key.flatten()),
        ..Default::default()
    };

    let response = completion(completion_request).await.map_err(|e| RpcError {
        code: -32001,
        message: format!("LLM error: {}", e),
    })?;

    Ok(serde_json::to_value(response).unwrap())
}

/// Get provider configuration for a specific provider instance or type.
/// Accepts either an instance ID or a provider type.
fn get_provider_config(provider: &str) -> Option<ProviderConfig> {
    let cfg = get_config()?;
    let instance = cfg.resolve_provider(provider)?;

    if !instance.enabled {
        return None;
    }

    Some(ProviderConfig {
        api_key: Some(instance.api_key.clone()),
        base_url: instance.base_url.clone(),
        ..Default::default()
    })
}

/// Get provider configuration based on model string (e.g., "openai:gpt-4o").
fn get_provider_config_for_model(model: &str) -> Option<ProviderConfig> {
    let provider = model.split(':').next()?;
    get_provider_config(provider)
}

/// Get the actual provider type from an instance ID or type string.
fn resolve_provider_type(provider: &str) -> Option<String> {
    let cfg = get_config()?;
    
    // First check if it's an instance ID
    if let Some(instance) = cfg.get_instance(provider) {
        return Some(instance.provider_type.clone());
    }
    
    // Otherwise assume it's a provider type
    Some(provider.to_string())
}

// =============================================================================
// RPC-specific types
// =============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    #[serde(default)]
    pub model: Option<String>,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    /// System prompt to prepend
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    /// Tools available for the model to call
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<ToolDefinition>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
    /// For tool responses
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

/// Tool definition for the chat API
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default = "default_input_schema")]
    pub input_schema: serde_json::Value,
}

fn default_input_schema() -> serde_json::Value {
    serde_json::json!({ "type": "object", "properties": {} })
}

// =============================================================================
// Configuration RPC handlers
// =============================================================================

/// List supported provider types (for UI dropdown).
pub async fn list_provider_types() -> Result<serde_json::Value, RpcError> {
    let types = get_supported_providers();
    let cfg = get_config();

    let type_info: Vec<serde_json::Value> = types
        .iter()
        .map(|t| {
            let instance_count = cfg
                .as_ref()
                .map(|c| c.get_instances_by_type(t).len())
                .unwrap_or(0);

            let needs_api_key = matches!(t.as_str(), "openai" | "anthropic" | "mistral" | "groq");
            let is_local = matches!(t.as_str(), "ollama" | "llamafile" | "lmstudio");

            serde_json::json!({
                "type": t,
                "needs_api_key": needs_api_key,
                "is_local": is_local,
                "instance_count": instance_count,
            })
        })
        .collect();

    Ok(serde_json::json!({ "provider_types": type_info }))
}

/// List all configured provider instances.
pub async fn list_providers() -> Result<serde_json::Value, RpcError> {
    let supported_types = get_supported_providers();
    let cfg = get_config().unwrap_or_default();

    // Check which local providers are actually running
    let mut local_available: std::collections::HashSet<String> = std::collections::HashSet::new();
    for local_type in &["ollama", "llamafile", "lmstudio"] {
        let status = check_provider(local_type, None).await;
        if status.available {
            local_available.insert(local_type.to_string());
        }
    }

    let mut provider_info: Vec<serde_json::Value> = Vec::new();

    // Add configured instances
    for instance in cfg.providers.values() {
        let needs_api_key = matches!(instance.provider_type.as_str(), "openai" | "anthropic" | "mistral" | "groq");
        let is_local = matches!(instance.provider_type.as_str(), "ollama" | "llamafile" | "lmstudio");
        let is_global_default = cfg.default_provider.as_deref() == Some(&instance.id);
        let is_available = is_local && local_available.contains(&instance.provider_type);

        provider_info.push(serde_json::json!({
            "id": instance.id,
            "type": instance.provider_type,
            "name": instance.name,
            "configured": instance.enabled && (is_local || instance.api_key.is_some()),
            "needs_api_key": needs_api_key,
            "is_local": is_local,
            "is_default": is_global_default,
            "is_type_default": instance.is_type_default,
            "has_api_key": instance.api_key.is_some(),
            "base_url": instance.base_url,
            "available": is_available || (!is_local && instance.api_key.is_some()),
        }));
    }

    // Add unconfigured provider types (for backwards compat with old UI)
    // For local providers that are running, mark them as auto-detected
    for ptype in &supported_types {
        let has_instance = cfg.get_instances_by_type(ptype).len() > 0;
        if !has_instance {
            let needs_api_key = matches!(ptype.as_str(), "openai" | "anthropic" | "mistral" | "groq");
            let is_local = matches!(ptype.as_str(), "ollama" | "llamafile" | "lmstudio");
            let is_available = local_available.contains(ptype.as_str());
            
            // Auto-detected local providers show as configured
            let auto_configured = is_local && is_available;

            provider_info.push(serde_json::json!({
                "id": ptype,
                "type": ptype,
                "name": if auto_configured { format!("{} (auto-detected)", get_type_display_name(ptype)) } else { get_type_display_name(ptype) },
                "configured": auto_configured,
                "needs_api_key": needs_api_key,
                "is_local": is_local,
                "is_default": false,
                "is_type_default": false,
                "available": is_available,
                "has_api_key": false,
            }));
        }
    }

    Ok(serde_json::json!({ 
        "providers": provider_info,
        "default_provider": cfg.default_provider,
    }))
}

/// Get display name for a provider type
fn get_type_display_name(provider_type: &str) -> String {
    match provider_type {
        "ollama" => "Ollama".to_string(),
        "llamafile" => "Llamafile".to_string(),
        "openai" => "OpenAI".to_string(),
        "anthropic" => "Anthropic".to_string(),
        "mistral" => "Mistral".to_string(),
        "groq" => "Groq".to_string(),
        "lmstudio" => "LM Studio".to_string(),
        other => {
            let mut chars = other.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().chain(chars).collect(),
                None => other.to_string(),
            }
        }
    }
}

/// Check a specific provider's status.
/// Accepts either an instance ID or a provider type.
pub async fn check_provider_status(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let provider_param = params
        .get("provider")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'provider' parameter".to_string(),
        })?;

    // Resolve to provider type for the check
    let provider_type = resolve_provider_type(provider_param)
        .unwrap_or_else(|| provider_param.to_string());
    
    let config = get_provider_config(provider_param);
    let status = check_provider(&provider_type, config).await;

    Ok(serde_json::to_value(status).unwrap())
}

/// Update or create a provider instance.
/// If 'id' is provided, updates existing instance.
/// If only 'provider' (type) is provided, creates a new instance or updates existing if only one.
pub async fn configure_provider(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let instance_id = params.get("id").and_then(|v| v.as_str());
    let provider_type = params.get("provider").and_then(|v| v.as_str());
    let name = params.get("name").and_then(|v| v.as_str());
    let api_key = params.get("api_key").and_then(|v| v.as_str()).map(String::from);
    let base_url = params.get("base_url").and_then(|v| v.as_str()).map(String::from);
    let enabled = params.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);

    let mut cfg = get_config().unwrap_or_default();

    let result_id: String;

    if let Some(id) = instance_id {
        // Update existing instance
        if let Some(instance) = cfg.get_instance_mut(id) {
            if let Some(n) = name {
                instance.name = n.to_string();
            }
            if api_key.is_some() {
                instance.api_key = api_key;
            }
            if base_url.is_some() || params.get("base_url").is_some() {
                instance.base_url = base_url;
            }
            instance.enabled = enabled;
            result_id = id.to_string();
        } else {
            return Err(RpcError {
                code: -32602,
                message: format!("Provider instance '{}' not found", id),
            });
        }
    } else if let Some(ptype) = provider_type {
        // Check if there's already an instance of this type
        let existing = cfg.get_instances_by_type(ptype);
        
        if existing.len() == 1 && instance_id.is_none() {
            // Update the single existing instance
            let existing_id = existing[0].id.clone();
            if let Some(instance) = cfg.get_instance_mut(&existing_id) {
                if let Some(n) = name {
                    instance.name = n.to_string();
                }
                if api_key.is_some() {
                    instance.api_key = api_key;
                }
                if base_url.is_some() || params.get("base_url").is_some() {
                    instance.base_url = base_url;
                }
                instance.enabled = enabled;
            }
            result_id = existing_id;
        } else {
            // Create new instance
            let display_name = name
                .map(String::from)
                .unwrap_or_else(|| get_type_display_name(ptype));
            
            let mut instance = ProviderInstance::new(ptype, &display_name);
            instance.api_key = api_key;
            instance.base_url = base_url;
            instance.enabled = enabled;
            
            result_id = cfg.add_instance(instance);
        }
    } else {
        return Err(RpcError {
            code: -32602,
            message: "Missing 'provider' or 'id' parameter".to_string(),
        });
    }

    set_config(cfg.clone());

    if let Err(e) = cfg.save() {
        tracing::warn!("Failed to save config: {}", e);
    }

    Ok(serde_json::json!({
        "ok": true,
        "id": result_id,
    }))
}

/// Add a new provider instance.
pub async fn add_provider(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let provider_type = params
        .get("type")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'type' parameter".to_string(),
        })?;

    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'name' parameter".to_string(),
        })?;

    let api_key = params.get("api_key").and_then(|v| v.as_str()).map(String::from);
    let base_url = params.get("base_url").and_then(|v| v.as_str()).map(String::from);

    // Validate provider type
    let supported = get_supported_providers();
    if !supported.contains(&provider_type.to_string()) {
        return Err(RpcError {
            code: -32602,
            message: format!("Unsupported provider type: {}", provider_type),
        });
    }

    let mut cfg = get_config().unwrap_or_default();
    
    let mut instance = ProviderInstance::new(provider_type, name);
    instance.api_key = api_key;
    instance.base_url = base_url;
    
    let id = cfg.add_instance(instance);
    set_config(cfg.clone());

    if let Err(e) = cfg.save() {
        tracing::warn!("Failed to save config: {}", e);
    }

    Ok(serde_json::json!({
        "ok": true,
        "id": id,
    }))
}

/// Remove a provider instance.
pub async fn remove_provider(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let instance_id = params
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'id' parameter".to_string(),
        })?;

    let mut cfg = get_config().unwrap_or_default();
    
    let removed = cfg.remove_instance(instance_id);
    if removed.is_none() {
        return Err(RpcError {
            code: -32602,
            message: format!("Provider instance '{}' not found", instance_id),
        });
    }

    set_config(cfg.clone());

    if let Err(e) = cfg.save() {
        tracing::warn!("Failed to save config: {}", e);
    }

    Ok(serde_json::json!({
        "ok": true,
    }))
}

/// Set the global default provider.
pub async fn set_default_provider(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let instance_id = params
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'id' parameter".to_string(),
        })?;

    let mut cfg = get_config().unwrap_or_default();
    
    if !cfg.set_global_default(instance_id) {
        return Err(RpcError {
            code: -32602,
            message: format!("Provider instance '{}' not found", instance_id),
        });
    }

    set_config(cfg.clone());

    if let Err(e) = cfg.save() {
        tracing::warn!("Failed to save config: {}", e);
    }

    Ok(serde_json::json!({
        "ok": true,
        "default_provider": instance_id,
    }))
}

/// Set the type default for a provider.
pub async fn set_type_default(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let instance_id = params
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'id' parameter".to_string(),
        })?;

    let mut cfg = get_config().unwrap_or_default();
    
    if !cfg.set_type_default(instance_id) {
        return Err(RpcError {
            code: -32602,
            message: format!("Provider instance '{}' not found", instance_id),
        });
    }

    set_config(cfg.clone());

    if let Err(e) = cfg.save() {
        tracing::warn!("Failed to save config: {}", e);
    }

    Ok(serde_json::json!({
        "ok": true,
    }))
}

/// Get current configuration (safe version without API keys).
pub async fn get_configuration() -> Result<serde_json::Value, RpcError> {
    let cfg = get_config().unwrap_or_default();

    let providers: serde_json::Map<String, serde_json::Value> = cfg
        .providers
        .iter()
        .map(|(k, v)| {
            (
                k.clone(),
                serde_json::json!({
                    "id": v.id,
                    "type": v.provider_type,
                    "name": v.name,
                    "enabled": v.enabled,
                    "has_api_key": v.api_key.is_some(),
                    "base_url": v.base_url,
                    "is_type_default": v.is_type_default,
                }),
            )
        })
        .collect();

    Ok(serde_json::json!({
        "version": cfg.version,
        "default_model": cfg.default_model,
        "default_provider": cfg.default_provider,
        "providers": providers
    }))
}

/// Set default model (legacy - sets the default_model field).
pub async fn set_default_model(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let model = params
        .get("model")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'model' parameter".to_string(),
        })?;

    let mut cfg = get_config().unwrap_or_default();
    cfg.default_model = Some(model.to_string());
    set_config(cfg.clone());

    if let Err(e) = cfg.save() {
        tracing::warn!("Failed to save config: {}", e);
    }

    Ok(serde_json::json!({
        "ok": true,
        "default_model": model
    }))
}

// =============================================================================
// Configured Models (Named Aliases)
// =============================================================================

/// List all configured models.
pub async fn list_configured_models() -> Result<serde_json::Value, RpcError> {
    let cfg = get_config().unwrap_or_default();
    
    let models: Vec<serde_json::Value> = cfg.models.iter().map(|m| {
        serde_json::json!({
            "name": m.name,
            "model_id": m.model_id,
            "is_default": m.is_default,
        })
    }).collect();
    
    Ok(serde_json::json!({
        "models": models
    }))
}

/// Provider prefixes that are considered local (no API key, run on this machine).
const LOCAL_PROVIDER_PREFIXES: [&str; 2] = ["ollama:", "llamafile:"];

fn is_local_model(model_id: &str) -> bool {
    LOCAL_PROVIDER_PREFIXES
        .iter()
        .any(|prefix| model_id.starts_with(prefix))
}

/// Return metadata for each configured model (e.g. local vs remote).
/// Companion to list_configured_models; use model_id to correlate.
pub async fn get_configured_models_metadata() -> Result<serde_json::Value, RpcError> {
    let cfg = get_config().unwrap_or_default();
    let metadata: Vec<serde_json::Value> = cfg
        .models
        .iter()
        .map(|m| {
            serde_json::json!({
                "model_id": m.model_id,
                "is_local": is_local_model(&m.model_id),
            })
        })
        .collect();
    Ok(serde_json::json!({ "metadata": metadata }))
}

/// Add a configured model.
pub async fn add_configured_model(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let model_id = params
        .get("model_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'model_id' parameter".to_string(),
        })?;
    
    let name = params.get("name").and_then(|v| v.as_str());
    
    let mut cfg = get_config().unwrap_or_default();
    let final_name = cfg.add_model(model_id, name);
    set_config(cfg.clone());
    
    if let Err(e) = cfg.save() {
        tracing::warn!("Failed to save config: {}", e);
    }
    
    Ok(serde_json::json!({
        "ok": true,
        "name": final_name,
        "model_id": model_id,
    }))
}

/// Remove a configured model.
pub async fn remove_configured_model(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'name' parameter".to_string(),
        })?;
    
    let mut cfg = get_config().unwrap_or_default();
    let removed = cfg.remove_model(name);
    
    if !removed {
        return Err(RpcError {
            code: -32602,
            message: format!("Model '{}' not found", name),
        });
    }
    
    set_config(cfg.clone());
    
    if let Err(e) = cfg.save() {
        tracing::warn!("Failed to save config: {}", e);
    }
    
    Ok(serde_json::json!({
        "ok": true,
    }))
}

/// Set a configured model as default.
pub async fn set_configured_model_default(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let name = params
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'name' parameter".to_string(),
        })?;
    
    let mut cfg = get_config().unwrap_or_default();
    
    // Get the model_id before setting as default
    let model_id = cfg.models.iter()
        .find(|m| m.name == name)
        .map(|m| m.model_id.clone());
    
    if !cfg.set_default_model_by_name(name) {
        return Err(RpcError {
            code: -32602,
            message: format!("Model '{}' not found", name),
        });
    }
    
    // Also update the legacy default_model field so chat() picks it up
    if let Some(model_id) = model_id {
        cfg.default_model = Some(model_id);
    }
    
    set_config(cfg.clone());
    
    if let Err(e) = cfg.save() {
        tracing::warn!("Failed to save config: {}", e);
    }
    
    Ok(serde_json::json!({
        "ok": true,
        "default": name,
    }))
}

// =============================================================================
// Streaming Chat
// =============================================================================

/// Stream event for chat completion
#[derive(Debug, Clone, Serialize)]
pub struct StreamEvent {
    pub id: serde_json::Value,
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finish_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<serde_json::Value>,
}

/// Streaming chat completion.
/// Sends stream events to the provided channel.
pub async fn chat_stream(
    request_id: serde_json::Value,
    params: serde_json::Value,
    event_tx: mpsc::Sender<StreamEvent>,
) {
    // Parse request
    let request: Result<ChatRequest, _> = serde_json::from_value(params);
    
    match request {
        Ok(request) => {
            // Use provided model or fall back to default
            let model = match request.model.or_else(|| {
                get_config().and_then(|c| c.default_model.clone())
            }) {
                Some(m) => m,
                None => {
                    let _ = event_tx.send(StreamEvent {
                        id: request_id,
                        event_type: "error".to_string(),
                        token: None,
                        finish_reason: None,
                        model: None,
                        error: Some(serde_json::json!({
                            "code": -32602,
                            "message": "No model specified and no default model configured"
                        })),
                    }).await;
                    return;
                }
            };

            // Build completion request
            let messages: Vec<Message> = request
                .messages
                .into_iter()
                .map(|m| match m.role.as_str() {
                    "system" => Message::system(m.content),
                    "user" => Message::user(m.content),
                    "assistant" => Message::assistant(m.content),
                    _ => Message::user(m.content),
                })
                .collect();

            let provider_config = get_provider_config_for_model(&model);

            let completion_request = CompletionRequest {
                model: model.clone(),
                messages,
                temperature: request.temperature,
                max_tokens: request.max_tokens,
                api_key: provider_config.and_then(|c| c.api_key.flatten()),
                stream: Some(true),
                ..Default::default()
            };

            // Try to create stream
            match completion_stream(completion_request).await {
                Ok(mut stream) => {
                    while let Some(chunk_result) = stream.next().await {
                        let event = match chunk_result {
                            Ok(chunk) => {
                                let content = chunk.choices.get(0)
                                    .and_then(|c| c.delta.content.as_ref())
                                    .cloned();
                                
                                let finish_reason = chunk.choices.get(0)
                                    .and_then(|c| c.finish_reason.as_ref())
                                    .map(|r| format!("{:?}", r));
                                
                                StreamEvent {
                                    id: request_id.clone(),
                                    event_type: if finish_reason.is_some() { "done".to_string() } else { "token".to_string() },
                                    token: content,
                                    finish_reason,
                                    model: Some(model.clone()),
                                    error: None,
                                }
                            }
                            Err(e) => {
                                StreamEvent {
                                    id: request_id.clone(),
                                    event_type: "error".to_string(),
                                    token: None,
                                    finish_reason: None,
                                    model: Some(model.clone()),
                                    error: Some(serde_json::json!({
                                        "code": -32001,
                                        "message": format!("Stream error: {}", e)
                                    })),
                                }
                            }
                        };
                        
                        let is_done = event.event_type == "done" || event.event_type == "error";
                        if event_tx.send(event).await.is_err() {
                            break; // Receiver dropped
                        }
                        if is_done {
                            break;
                        }
                    }
                }
                Err(e) => {
                    let _ = event_tx.send(StreamEvent {
                        id: request_id,
                        event_type: "error".to_string(),
                        token: None,
                        finish_reason: None,
                        model: Some(model),
                        error: Some(serde_json::json!({
                            "code": -32001,
                            "message": format!("Failed to start stream: {}", e)
                        })),
                    }).await;
                }
            }
        }
        Err(e) => {
            let _ = event_tx.send(StreamEvent {
                id: request_id,
                event_type: "error".to_string(),
                token: None,
                finish_reason: None,
                model: None,
                error: Some(serde_json::json!({
                    "code": -32602,
                    "message": format!("Invalid params: {}", e)
                })),
            }).await;
        }
    }
}
