//! OAuth module for Harbor bridge.
//!
//! Provides OAuth 2.0 authentication for MCP servers that require
//! API access (Gmail, Google Drive, GitHub, etc.).

pub mod flow;
pub mod providers;
pub mod server;
pub mod storage;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::RwLock;

use crate::rpc::RpcError;

pub use flow::{start_flow, exchange_code};
pub use storage::{TokenStore, StoredTokens};

// Re-export for internal use by storage module
pub(crate) use flow::refresh_tokens;

// ============================================================================
// Types
// ============================================================================

/// OAuth provider configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthProviderConfig {
    /// Unique provider identifier (e.g., "google", "github")
    pub provider_id: String,
    /// Display name for UI
    pub display_name: String,
    /// OAuth authorization endpoint
    pub authorization_url: String,
    /// OAuth token endpoint
    pub token_url: String,
    /// OAuth revocation endpoint (optional)
    pub revocation_url: Option<String>,
    /// Whether to use PKCE (Proof Key for Code Exchange)
    pub pkce_enabled: bool,
}

/// OAuth tokens returned from token exchange.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthTokens {
    /// Access token for API calls
    pub access_token: String,
    /// Refresh token for obtaining new access tokens
    pub refresh_token: Option<String>,
    /// When the access token expires (Unix timestamp in milliseconds)
    pub expires_at: Option<i64>,
    /// Token type (usually "Bearer")
    pub token_type: String,
    /// Granted scopes (may differ from requested)
    pub scope: Option<String>,
}

/// State for an in-progress OAuth flow.
#[derive(Debug, Clone)]
pub struct OAuthFlowState {
    /// Random state parameter for CSRF protection
    pub state: String,
    /// PKCE code verifier (if PKCE enabled)
    pub code_verifier: Option<String>,
    /// Provider being used
    pub provider_id: String,
    /// Server this auth is for
    pub server_id: String,
    /// Requested scopes
    pub scopes: Vec<String>,
    /// When this flow was started (for timeout detection)
    #[allow(dead_code)]
    pub started_at: i64,
}

/// OAuth credentials (client ID and secret).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuthCredentials {
    pub client_id: String,
    pub client_secret: String,
}

/// Stored credentials file format.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CredentialsFile {
    /// Map of provider_id -> credentials
    providers: HashMap<String, OAuthCredentials>,
}

// ============================================================================
// Global State
// ============================================================================

lazy_static::lazy_static! {
    /// Active OAuth flows waiting for callback
    static ref PENDING_FLOWS: Arc<RwLock<HashMap<String, OAuthFlowState>>> = 
        Arc::new(RwLock::new(HashMap::new()));
    
    /// OAuth credentials loaded from environment
    static ref OAUTH_CREDENTIALS: Arc<RwLock<HashMap<String, OAuthCredentials>>> = 
        Arc::new(RwLock::new(HashMap::new()));
    
    /// Token store for persisted tokens
    static ref TOKEN_STORE: Arc<RwLock<Option<TokenStore>>> = 
        Arc::new(RwLock::new(None));
}

/// Get the path to the credentials file. Falls back to `./.harbor` if the
/// home directory can't be found - unchanged from before `credentials_file_path`
/// was pointed at the shared `paths::harbor_dir` helper, and deliberately
/// kept that way here rather than treating a missing home directory as
/// fatal (unlike `oauth::storage::TokenStore` and `acp::workspace_dir`).
fn credentials_file_path() -> std::path::PathBuf {
    crate::paths::harbor_dir()
        .unwrap_or_else(|| std::path::PathBuf::from(".").join(".harbor"))
        .join("oauth_credentials.json")
}

/// Load credentials from the credentials file.
fn load_credentials_file() -> CredentialsFile {
    let path = credentials_file_path();
    if path.exists() {
        match std::fs::read_to_string(&path) {
            Ok(contents) => {
                match serde_json::from_str(&contents) {
                    Ok(creds) => {
                        tracing::info!("Loaded credentials from {:?}", path);
                        return creds;
                    }
                    Err(e) => {
                        tracing::warn!("Failed to parse credentials file: {}", e);
                    }
                }
            }
            Err(e) => {
                tracing::warn!("Failed to read credentials file: {}", e);
            }
        }
    }
    CredentialsFile::default()
}

/// Save credentials to the credentials file.
fn save_credentials_file(creds: &CredentialsFile) -> Result<(), String> {
    let path = credentials_file_path();
    
    // Ensure directory exists
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    
    let json = serde_json::to_string_pretty(creds)
        .map_err(|e| format!("Failed to serialize credentials: {}", e))?;
    
    std::fs::write(&path, json)
        .map_err(|e| format!("Failed to write credentials file: {}", e))?;
    
    tracing::info!("Saved credentials to {:?}", path);
    Ok(())
}

/// Initialize OAuth module - load credentials and stored tokens.
pub async fn init() {
    let mut creds = OAUTH_CREDENTIALS.write().await;
    
    // First, load from credentials file
    let file_creds = load_credentials_file();
    for (provider_id, credentials) in file_creds.providers {
        tracing::info!("Loaded {} OAuth credentials from file", provider_id);
        creds.insert(provider_id, credentials);
    }
    
    // Then, override with environment variables (env vars take precedence)
    // Google
    if let (Ok(client_id), Ok(client_secret)) = (
        std::env::var("HARBOR_GOOGLE_CLIENT_ID"),
        std::env::var("HARBOR_GOOGLE_CLIENT_SECRET"),
    ) {
        if !client_id.is_empty() && !client_secret.is_empty() {
            tracing::info!("Loaded Google OAuth credentials from environment");
            creds.insert("google".to_string(), OAuthCredentials {
                client_id,
                client_secret,
            });
        }
    }
    
    // GitHub
    if let (Ok(client_id), Ok(client_secret)) = (
        std::env::var("HARBOR_GITHUB_CLIENT_ID"),
        std::env::var("HARBOR_GITHUB_CLIENT_SECRET"),
    ) {
        if !client_id.is_empty() && !client_secret.is_empty() {
            tracing::info!("Loaded GitHub OAuth credentials from environment");
            creds.insert("github".to_string(), OAuthCredentials {
                client_id,
                client_secret,
            });
        }
    }
    
    drop(creds);
    
    // Load token store
    match TokenStore::load() {
        Ok(store) => {
            let count = store.tokens.len();
            *TOKEN_STORE.write().await = Some(store);
            if count > 0 {
                tracing::info!("Loaded {} stored OAuth tokens", count);
            }
        }
        Err(e) => {
            tracing::warn!("Failed to load token store: {}", e);
            *TOKEN_STORE.write().await = Some(TokenStore::new());
        }
    }
}

/// Set credentials for a provider (and save to file).
pub async fn set_credentials(provider_id: &str, client_id: &str, client_secret: &str) -> Result<(), String> {
    let credentials = OAuthCredentials {
        client_id: client_id.to_string(),
        client_secret: client_secret.to_string(),
    };
    
    // Update in-memory credentials
    OAUTH_CREDENTIALS.write().await.insert(provider_id.to_string(), credentials.clone());
    
    // Save to file
    let mut file_creds = load_credentials_file();
    file_creds.providers.insert(provider_id.to_string(), credentials);
    save_credentials_file(&file_creds)?;
    
    Ok(())
}

/// Remove credentials for a provider.
pub async fn remove_credentials(provider_id: &str) -> Result<(), String> {
    // Remove from in-memory
    OAUTH_CREDENTIALS.write().await.remove(provider_id);
    
    // Save to file
    let mut file_creds = load_credentials_file();
    file_creds.providers.remove(provider_id);
    save_credentials_file(&file_creds)?;
    
    Ok(())
}

/// Get credentials for a provider.
pub async fn get_credentials(provider_id: &str) -> Option<OAuthCredentials> {
    OAUTH_CREDENTIALS.read().await.get(provider_id).cloned()
}

/// Check if a provider is configured.
#[allow(dead_code)]
pub async fn is_provider_configured(provider_id: &str) -> bool {
    OAUTH_CREDENTIALS.read().await.contains_key(provider_id)
}

/// List configured providers.
pub async fn list_configured_providers() -> Vec<String> {
    OAUTH_CREDENTIALS.read().await.keys().cloned().collect()
}

/// Store a pending flow.
pub async fn store_pending_flow(flow: OAuthFlowState) {
    PENDING_FLOWS.write().await.insert(flow.state.clone(), flow);
}

/// Get and remove a pending flow by state.
pub async fn take_pending_flow(state: &str) -> Option<OAuthFlowState> {
    PENDING_FLOWS.write().await.remove(state)
}

/// Get the token store.
pub async fn get_token_store() -> tokio::sync::RwLockReadGuard<'static, Option<TokenStore>> {
    TOKEN_STORE.read().await
}

/// Get mutable token store.
pub async fn get_token_store_mut() -> tokio::sync::RwLockWriteGuard<'static, Option<TokenStore>> {
    TOKEN_STORE.write().await
}

// ============================================================================
// RPC Handlers
// ============================================================================

/// Start an OAuth flow for a server.
/// Returns the authorization URL to open in browser.
pub async fn rpc_start_flow(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let provider_id = params.get("provider")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'provider' parameter".to_string(),
        })?;
    
    let server_id = params.get("server_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'server_id' parameter".to_string(),
        })?;
    
    let scopes: Vec<String> = params.get("scopes")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    
    if scopes.is_empty() {
        return Err(RpcError {
            code: -32602,
            message: "Missing or empty 'scopes' parameter".to_string(),
        });
    }
    
    // Check if provider is configured
    let credentials = get_credentials(provider_id).await.ok_or_else(|| RpcError {
        code: -32000,
        message: format!("OAuth provider '{}' is not configured", provider_id),
    })?;
    
    // Start the flow
    let (auth_url, flow_state) = start_flow(provider_id, server_id, &scopes, &credentials)
        .map_err(|e| RpcError {
            code: -32000,
            message: format!("Failed to start OAuth flow: {}", e),
        })?;
    
    // Store the pending flow
    let state = flow_state.state.clone();
    store_pending_flow(flow_state).await;
    
    // Start the callback server if not running
    server::ensure_server_running().await.map_err(|e| RpcError {
        code: -32000,
        message: format!("Failed to start OAuth callback server: {}", e),
    })?;
    
    Ok(serde_json::json!({
        "auth_url": auth_url,
        "state": state,
    }))
}

/// Get tokens for a server (with automatic refresh if expired).
pub async fn rpc_get_tokens(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let server_id = params.get("server_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'server_id' parameter".to_string(),
        })?;
    
    // Use get_access_token which handles refresh automatically
    let mut store = get_token_store_mut().await;
    
    match store.as_mut() {
        Some(s) => {
            // Check if we have tokens at all
            if !s.has_tokens(server_id) {
                return Ok(serde_json::json!({
                    "has_tokens": false,
                }));
            }
            
            // Get access token (this will refresh if needed)
            match s.get_access_token(server_id).await {
                Ok(access_token) => {
                    // Get the stored data for additional info
                    let stored = s.get_tokens(server_id);
                    Ok(serde_json::json!({
                        "has_tokens": true,
                        "access_token": access_token,
                        "expires_at": stored.map(|t| t.tokens.expires_at).flatten(),
                        "provider": stored.map(|t| &t.provider),
                        "scopes": stored.map(|t| &t.scopes),
                    }))
                }
                Err(e) => {
                    tracing::error!("Failed to get/refresh access token: {}", e);
                    Err(RpcError {
                        code: -32000,
                        message: format!("Failed to get access token: {}", e),
                    })
                }
            }
        }
        None => Ok(serde_json::json!({
            "has_tokens": false,
        })),
    }
}

/// Check OAuth status for a server.
pub async fn rpc_status(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let server_id = params.get("server_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'server_id' parameter".to_string(),
        })?;
    
    let store = get_token_store().await;
    let stored = store.as_ref().and_then(|s| s.get_tokens(server_id));
    
    match stored {
        Some(tokens) => {
            let now = chrono::Utc::now().timestamp_millis();
            let is_expired = tokens.tokens.expires_at
                .map(|exp| exp < now + 60_000) // Consider expired if < 1 min remaining
                .unwrap_or(false);
            
            Ok(serde_json::json!({
                "authenticated": true,
                "provider": tokens.provider,
                "scopes": tokens.scopes,
                "is_expired": is_expired,
                "expires_at": tokens.tokens.expires_at,
                "has_refresh_token": tokens.tokens.refresh_token.is_some(),
            }))
        }
        None => Ok(serde_json::json!({
            "authenticated": false,
        })),
    }
}

/// Revoke OAuth tokens for a server.
pub async fn rpc_revoke(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let server_id = params.get("server_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'server_id' parameter".to_string(),
        })?;
    
    let mut store = get_token_store_mut().await;
    if let Some(ref mut s) = *store {
        s.remove_tokens(server_id);
        if let Err(e) = s.save() {
            tracing::warn!("Failed to save token store after revoke: {}", e);
        }
    }
    
    Ok(serde_json::json!({
        "success": true,
    }))
}

/// List available OAuth providers.
pub async fn rpc_list_providers(_params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let configured = list_configured_providers().await;
    
    let providers: Vec<serde_json::Value> = vec![
        serde_json::json!({
            "id": "google",
            "name": "Google",
            "configured": configured.contains(&"google".to_string()),
            "scopes": {
                "gmail.readonly": "Read-only access to Gmail",
                "gmail.send": "Send emails",
                "gmail.modify": "Read, send, and manage emails",
            }
        }),
        serde_json::json!({
            "id": "github",
            "name": "GitHub",
            "configured": configured.contains(&"github".to_string()),
            "scopes": {
                "repo": "Full access to repositories",
                "read:user": "Read user profile",
            }
        }),
    ];
    
    Ok(serde_json::json!({
        "providers": providers,
    }))
}

/// Get OAuth credentials configuration status.
pub async fn rpc_get_credentials_status(_params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let creds = OAUTH_CREDENTIALS.read().await;
    
    let mut providers: HashMap<String, serde_json::Value> = HashMap::new();
    
    // Google
    if let Some(c) = creds.get("google") {
        providers.insert("google".to_string(), serde_json::json!({
            "configured": true,
            "client_id_preview": format!("{}...", &c.client_id[..c.client_id.len().min(12)]),
        }));
    } else {
        providers.insert("google".to_string(), serde_json::json!({
            "configured": false,
        }));
    }
    
    // GitHub
    if let Some(c) = creds.get("github") {
        providers.insert("github".to_string(), serde_json::json!({
            "configured": true,
            "client_id_preview": format!("{}...", &c.client_id[..c.client_id.len().min(12)]),
        }));
    } else {
        providers.insert("github".to_string(), serde_json::json!({
            "configured": false,
        }));
    }
    
    Ok(serde_json::json!({
        "providers": providers,
    }))
}

/// Set OAuth credentials for a provider.
pub async fn rpc_set_credentials(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let provider_id = params.get("provider")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'provider' parameter".to_string(),
        })?;
    
    let client_id = params.get("client_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'client_id' parameter".to_string(),
        })?;
    
    let client_secret = params.get("client_secret")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'client_secret' parameter".to_string(),
        })?;
    
    // Validate provider
    if provider_id != "google" && provider_id != "github" {
        return Err(RpcError {
            code: -32602,
            message: format!("Unknown provider: {}", provider_id),
        });
    }
    
    // Validate inputs
    if client_id.trim().is_empty() {
        return Err(RpcError {
            code: -32602,
            message: "client_id cannot be empty".to_string(),
        });
    }
    if client_secret.trim().is_empty() {
        return Err(RpcError {
            code: -32602,
            message: "client_secret cannot be empty".to_string(),
        });
    }
    
    // Save credentials
    set_credentials(provider_id, client_id.trim(), client_secret.trim())
        .await
        .map_err(|e| RpcError {
            code: -32000,
            message: format!("Failed to save credentials: {}", e),
        })?;
    
    tracing::info!("Configured OAuth credentials for {}", provider_id);
    
    Ok(serde_json::json!({
        "success": true,
        "provider": provider_id,
    }))
}

/// Remove OAuth credentials for a provider.
pub async fn rpc_remove_credentials(params: serde_json::Value) -> Result<serde_json::Value, RpcError> {
    let provider_id = params.get("provider")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError {
            code: -32602,
            message: "Missing 'provider' parameter".to_string(),
        })?;
    
    remove_credentials(provider_id)
        .await
        .map_err(|e| RpcError {
            code: -32000,
            message: format!("Failed to remove credentials: {}", e),
        })?;
    
    tracing::info!("Removed OAuth credentials for {}", provider_id);
    
    Ok(serde_json::json!({
        "success": true,
        "provider": provider_id,
    }))
}
