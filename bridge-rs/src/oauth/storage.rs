//! OAuth token storage.
//!
//! Persists OAuth tokens to disk for reuse across sessions.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::OAuthTokens;

const TOKEN_FILE_NAME: &str = "oauth_tokens.json";

/// Stored tokens for a server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredTokens {
    /// Server ID this token is for
    pub server_id: String,
    /// OAuth provider (e.g., "google", "github")
    pub provider: String,
    /// The actual tokens
    pub tokens: OAuthTokens,
    /// Scopes that were granted
    pub scopes: Vec<String>,
    /// When tokens were first obtained (Unix timestamp ms)
    pub created_at: i64,
    /// When tokens were last updated (Unix timestamp ms)
    pub updated_at: i64,
}

/// Token store - manages persisted OAuth tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenStore {
    /// Tokens keyed by server ID
    pub tokens: HashMap<String, StoredTokens>,
}

impl TokenStore {
    /// Create a new empty token store.
    pub fn new() -> Self {
        Self {
            tokens: HashMap::new(),
        }
    }
    
    /// Get the path to the token file. Errors (rather than falling back to
    /// the current directory) if there's no home directory to find
    /// `~/.harbor` under - restoring the behavior from before this used the
    /// shared `paths::harbor_dir` helper, since silently writing OAuth
    /// tokens under the bridge's current directory would be worse than
    /// failing.
    fn get_token_path() -> Result<PathBuf, String> {
        Self::get_token_path_in(crate::paths::harbor_dir())
    }

    /// `get_token_path`, taking the harbor dir explicitly so the "no home
    /// directory" error is testable without relying on environment/global
    /// state.
    fn get_token_path_in(harbor_dir: Option<PathBuf>) -> Result<PathBuf, String> {
        let harbor_dir = harbor_dir.ok_or("Could not find home directory")?;

        // Create directory if it doesn't exist
        if !harbor_dir.exists() {
            fs::create_dir_all(&harbor_dir)
                .map_err(|e| format!("Failed to create .harbor directory: {}", e))?;
        }

        Ok(harbor_dir.join(TOKEN_FILE_NAME))
    }
    
    /// Load token store from disk.
    pub fn load() -> Result<Self, String> {
        let path = Self::get_token_path()?;
        
        if !path.exists() {
            return Ok(Self::new());
        }
        
        let contents = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read token file: {}", e))?;
        
        let store: TokenStore = serde_json::from_str(&contents)
            .map_err(|e| format!("Failed to parse token file: {}", e))?;
        
        Ok(store)
    }
    
    /// Save token store to disk.
    pub fn save(&self) -> Result<(), String> {
        let path = Self::get_token_path()?;
        
        let contents = serde_json::to_string_pretty(&self)
            .map_err(|e| format!("Failed to serialize tokens: {}", e))?;
        
        fs::write(&path, contents)
            .map_err(|e| format!("Failed to write token file: {}", e))?;
        
        // Set restrictive permissions on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = fs::Permissions::from_mode(0o600);
            fs::set_permissions(&path, perms)
                .map_err(|e| format!("Failed to set token file permissions: {}", e))?;
        }
        
        Ok(())
    }
    
    /// Get tokens for a server.
    pub fn get_tokens(&self, server_id: &str) -> Option<&StoredTokens> {
        self.tokens.get(server_id)
    }
    
    /// Set tokens for a server.
    pub fn set_tokens(&mut self, server_id: &str, tokens: StoredTokens) {
        self.tokens.insert(server_id.to_string(), tokens);
    }
    
    /// Remove tokens for a server.
    pub fn remove_tokens(&mut self, server_id: &str) {
        self.tokens.remove(server_id);
    }
    
    /// Check if tokens exist for a server.
    #[allow(dead_code)]
    pub fn has_tokens(&self, server_id: &str) -> bool {
        self.tokens.contains_key(server_id)
    }
    
    /// Check if tokens are expired for a server.
    #[allow(dead_code)]
    pub fn is_expired(&self, server_id: &str) -> bool {
        match self.tokens.get(server_id) {
            Some(stored) => {
                if let Some(expires_at) = stored.tokens.expires_at {
                    let now = chrono::Utc::now().timestamp_millis();
                    // Consider expired if less than 1 minute remaining
                    expires_at < now + 60_000
                } else {
                    false // No expiry means not expired
                }
            }
            None => true, // No tokens means "expired" (needs auth)
        }
    }
    
    /// Get access token for a server, refreshing if needed.
    #[allow(dead_code)]
    pub async fn get_access_token(
        &mut self,
        server_id: &str,
    ) -> Result<String, String> {
        let stored = self.tokens.get(server_id)
            .ok_or_else(|| format!("No tokens found for server: {}", server_id))?;
        
        // Check if refresh is needed
        if self.is_expired(server_id) {
            // Try to refresh
            if let Some(ref refresh_token) = stored.tokens.refresh_token {
                let credentials = super::get_credentials(&stored.provider).await
                    .ok_or_else(|| format!("No credentials for provider: {}", stored.provider))?;
                
                let new_tokens = super::refresh_tokens(refresh_token, &stored.provider, &credentials).await?;
                
                // Update stored tokens
                let mut updated = stored.clone();
                updated.tokens = new_tokens;
                updated.updated_at = chrono::Utc::now().timestamp_millis();
                self.tokens.insert(server_id.to_string(), updated);
                
                // Save to disk
                self.save()?;
                
                return Ok(self.tokens.get(server_id).unwrap().tokens.access_token.clone());
            } else {
                return Err("Token expired and no refresh token available".to_string());
            }
        }
        
        Ok(stored.tokens.access_token.clone())
    }
}

impl Default for TokenStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    
    #[test]
    fn test_token_store_new() {
        let store = TokenStore::new();
        assert!(store.tokens.is_empty());
    }

    #[test]
    fn get_token_path_errors_without_a_home_directory() {
        let err = TokenStore::get_token_path_in(None).unwrap_err();
        assert_eq!(err, "Could not find home directory");
    }
    
    #[test]
    fn test_token_store_set_get() {
        let mut store = TokenStore::new();
        let tokens = StoredTokens {
            server_id: "test-server".to_string(),
            provider: "google".to_string(),
            tokens: OAuthTokens {
                access_token: "test-token".to_string(),
                refresh_token: None,
                expires_at: None,
                token_type: "Bearer".to_string(),
                scope: None,
            },
            scopes: vec!["scope1".to_string()],
            created_at: 0,
            updated_at: 0,
        };
        
        store.set_tokens("test-server", tokens);
        assert!(store.has_tokens("test-server"));
        assert!(!store.has_tokens("other-server"));
    }
}
