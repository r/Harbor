//! LLM configuration storage.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

/// Configuration for a single provider instance.
/// Supports multiple instances of the same provider type (e.g., two OpenAI accounts).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderInstance {
    /// Unique instance ID (e.g., "openai-work", "openai-personal")
    pub id: String,
    /// Provider type (e.g., "openai", "anthropic", "ollama")
    pub provider_type: String,
    /// User-defined display name
    pub name: String,
    /// Whether this instance is enabled
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// API key (for cloud providers)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    /// Custom base URL
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
    /// Whether this is the default instance for its provider type
    #[serde(default)]
    pub is_type_default: bool,
}

fn default_true() -> bool {
    true
}

impl ProviderInstance {
    /// Create a new provider instance with auto-generated ID
    pub fn new(provider_type: &str, name: &str) -> Self {
        let id = format!("{}-{}", provider_type, uuid_simple());
        Self {
            id,
            provider_type: provider_type.to_string(),
            name: name.to_string(),
            enabled: true,
            api_key: None,
            base_url: None,
            is_type_default: false,
        }
    }

    /// Create a new provider instance with a specific ID
    #[allow(dead_code)]
    pub fn with_id(id: &str, provider_type: &str, name: &str) -> Self {
        Self {
            id: id.to_string(),
            provider_type: provider_type.to_string(),
            name: name.to_string(),
            enabled: true,
            api_key: None,
            base_url: None,
            is_type_default: false,
        }
    }
}

/// Generate a simple unique ID suffix
fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{:x}", now.as_millis() & 0xFFFFFF)
}

/// Legacy configuration for migration (v1 format)
#[derive(Debug, Clone, Deserialize)]
struct LegacyProviderSettings {
    enabled: bool,
    api_key: Option<String>,
    base_url: Option<String>,
}

/// Legacy config format for migration
#[derive(Debug, Clone, Deserialize)]
struct LegacyLlmConfig {
    default_model: Option<String>,
    #[serde(default)]
    providers: HashMap<String, LegacyProviderSettings>,
}

/// A configured model with a user-friendly name.
/// Allows the Web Agents API to reference models by name.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelAlias {
    /// User-friendly name (e.g., "my-llama", "work-gpt4")
    pub name: String,
    /// Actual model ID (e.g., "ollama:llama3.2:latest")
    pub model_id: String,
    /// Whether this is the default model
    #[serde(default)]
    pub is_default: bool,
}

/// Global LLM configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LlmConfig {
    /// Config version for migration detection
    #[serde(default = "default_version")]
    pub version: u32,

    /// Default model to use (e.g., "ollama:llama3.2") - legacy, use models instead
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,

    /// Global default provider instance ID
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_provider: Option<String>,

    /// Provider instances keyed by instance ID
    #[serde(default)]
    pub providers: HashMap<String, ProviderInstance>,
    
    /// Configured models with user-friendly names
    #[serde(default)]
    pub models: Vec<ModelAlias>,
}

fn default_version() -> u32 {
    2
}

impl LlmConfig {
    /// Get the configuration file path.
    pub fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("harbor")
            .join("llm.json")
    }

    /// Load configuration from disk, migrating from legacy format if needed.
    pub fn load() -> Result<Self, std::io::Error> {
        let path = Self::config_path();
        if !path.exists() {
            return Ok(Self::default());
        }

        let contents = std::fs::read_to_string(&path)?;

        // Try to detect config version
        let raw: serde_json::Value = serde_json::from_str(&contents)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        // Check if it's the new format (has version field >= 2)
        let version = raw.get("version").and_then(|v| v.as_u64()).unwrap_or(1);

        if version >= 2 {
            // New format - parse directly
            let mut config: Self = serde_json::from_value(raw)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            
            // Ensure default_model is set if there's a default configured model
            // This syncs the configured models system with the legacy default_model field
            if config.default_model.is_none() {
                if let Some(default_model) = config.models.iter().find(|m| m.is_default) {
                    config.default_model = Some(default_model.model_id.clone());
                }
            }
            
            Ok(config)
        } else {
            // Legacy format - migrate
            let legacy: LegacyLlmConfig = serde_json::from_value(raw)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            let migrated = Self::migrate_from_legacy(legacy);
            
            // Save migrated config
            if let Err(e) = migrated.save() {
                tracing::warn!("Failed to save migrated config: {}", e);
            }
            
            Ok(migrated)
        }
    }

    /// Migrate from legacy config format (v1)
    fn migrate_from_legacy(legacy: LegacyLlmConfig) -> Self {
        let mut config = Self {
            version: 2,
            default_model: legacy.default_model.clone(),
            default_provider: None,
            providers: HashMap::new(),
            models: Vec::new(),
        };

        // Convert each legacy provider to a new instance
        // Use the provider type as the instance ID for backwards compatibility
        for (provider_type, settings) in legacy.providers {
            let display_name = get_provider_display_name(&provider_type);
            let instance = ProviderInstance {
                id: provider_type.clone(), // Use type as ID for compatibility
                provider_type: provider_type.clone(),
                name: display_name,
                enabled: settings.enabled,
                api_key: settings.api_key,
                base_url: settings.base_url,
                is_type_default: true, // Only instance, so it's the default
            };
            config.providers.insert(provider_type, instance);
        }

        // Set global default from default_model if present
        if let Some(ref model) = config.default_model {
            let provider_type = model.split(':').next().unwrap_or("");
            if config.providers.contains_key(provider_type) {
                config.default_provider = Some(provider_type.to_string());
            }
        }

        config
    }

    /// Save configuration to disk.
    pub fn save(&self) -> Result<(), std::io::Error> {
        let path = Self::config_path();

        // Create parent directory if needed
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let contents = serde_json::to_string_pretty(self)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        std::fs::write(&path, contents)?;
        Ok(())
    }

    /// Check if a provider instance is enabled.
    #[allow(dead_code)]
    pub fn is_provider_enabled(&self, instance_id: &str) -> bool {
        self.providers
            .get(instance_id)
            .map(|s| s.enabled)
            .unwrap_or(false)
    }

    /// Get a provider instance by ID.
    pub fn get_instance(&self, instance_id: &str) -> Option<&ProviderInstance> {
        self.providers.get(instance_id)
    }

    /// Get a provider instance by ID (mutable).
    pub fn get_instance_mut(&mut self, instance_id: &str) -> Option<&mut ProviderInstance> {
        self.providers.get_mut(instance_id)
    }

    /// Find instances by provider type.
    pub fn get_instances_by_type(&self, provider_type: &str) -> Vec<&ProviderInstance> {
        self.providers
            .values()
            .filter(|p| p.provider_type == provider_type)
            .collect()
    }

    /// Get the default instance for a provider type.
    pub fn get_type_default(&self, provider_type: &str) -> Option<&ProviderInstance> {
        let instances = self.get_instances_by_type(provider_type);
        
        // If only one instance, return it
        if instances.len() == 1 {
            return instances.into_iter().next();
        }

        // Otherwise find the one marked as default
        instances.into_iter().find(|p| p.is_type_default)
    }

    /// Resolve a provider string to an instance.
    /// Accepts either an instance ID or a provider type.
    pub fn resolve_provider(&self, provider: &str) -> Option<&ProviderInstance> {
        // First try as instance ID
        if let Some(instance) = self.get_instance(provider) {
            return Some(instance);
        }

        // Then try as provider type
        self.get_type_default(provider)
    }

    /// Get the global default provider instance.
    #[allow(dead_code)]
    pub fn get_global_default(&self) -> Option<&ProviderInstance> {
        self.default_provider
            .as_ref()
            .and_then(|id| self.get_instance(id))
    }

    /// Add a new provider instance.
    pub fn add_instance(&mut self, mut instance: ProviderInstance) -> String {
        let id = instance.id.clone();
        
        // If this is the first instance of this type, make it the type default
        let existing = self.get_instances_by_type(&instance.provider_type);
        if existing.is_empty() {
            instance.is_type_default = true;
        }

        // If no global default, set this as the global default
        if self.default_provider.is_none() {
            self.default_provider = Some(id.clone());
        }

        self.providers.insert(id.clone(), instance);
        id
    }

    /// Remove a provider instance.
    pub fn remove_instance(&mut self, instance_id: &str) -> Option<ProviderInstance> {
        let removed = self.providers.remove(instance_id)?;

        // If this was the global default, clear it or pick another
        if self.default_provider.as_deref() == Some(instance_id) {
            self.default_provider = self.providers.keys().next().cloned();
        }

        // If this was a type default, pick another instance of the same type
        if removed.is_type_default {
            if let Some(next) = self.providers.values_mut()
                .find(|p| p.provider_type == removed.provider_type) 
            {
                next.is_type_default = true;
            }
        }

        Some(removed)
    }

    /// Set the global default provider.
    pub fn set_global_default(&mut self, instance_id: &str) -> bool {
        if self.providers.contains_key(instance_id) {
            self.default_provider = Some(instance_id.to_string());
            true
        } else {
            false
        }
    }

    /// Set the type default for a provider type.
    pub fn set_type_default(&mut self, instance_id: &str) -> bool {
        let instance = match self.providers.get(instance_id) {
            Some(i) => i.clone(),
            None => return false,
        };

        let provider_type = instance.provider_type.clone();

        // Clear is_type_default on all instances of this type
        for p in self.providers.values_mut() {
            if p.provider_type == provider_type {
                p.is_type_default = false;
            }
        }

        // Set the new default
        if let Some(p) = self.providers.get_mut(instance_id) {
            p.is_type_default = true;
        }

        true
    }

    // =========================================================================
    // Model Alias Methods
    // =========================================================================

    /// Get all configured models.
    #[allow(dead_code)]
    pub fn get_models(&self) -> &[ModelAlias] {
        &self.models
    }

    /// Get a model by name.
    #[allow(dead_code)]
    pub fn get_model(&self, name: &str) -> Option<&ModelAlias> {
        self.models.iter().find(|m| m.name == name)
    }

    /// Get the default model.
    #[allow(dead_code)]
    pub fn get_default_model(&self) -> Option<&ModelAlias> {
        self.models.iter().find(|m| m.is_default)
            .or_else(|| self.models.first())
    }

    /// Add a new model alias.
    pub fn add_model(&mut self, model_id: &str, name: Option<&str>) -> String {
        // Auto-generate name if not provided
        let base_name = name.map(|s| s.to_string()).unwrap_or_else(|| {
            // Extract a friendly name from model_id (e.g., "ollama:llama3.2:latest" -> "llama3.2")
            let parts: Vec<&str> = model_id.split(':').collect();
            if parts.len() >= 2 {
                parts[1].to_string()
            } else {
                model_id.to_string()
            }
        });

        // Ensure unique name
        let mut final_name = base_name.clone();
        let mut suffix = 1;
        while self.models.iter().any(|m| m.name == final_name) {
            suffix += 1;
            final_name = format!("{}-{}", base_name, suffix);
        }

        // If this is the first model, make it default
        let is_default = self.models.is_empty();

        self.models.push(ModelAlias {
            name: final_name.clone(),
            model_id: model_id.to_string(),
            is_default,
        });

        final_name
    }

    /// Remove a model by name.
    pub fn remove_model(&mut self, name: &str) -> bool {
        let initial_len = self.models.len();
        self.models.retain(|m| m.name != name);
        
        let removed = self.models.len() < initial_len;
        
        // If we removed the default, set a new default
        if removed && !self.models.iter().any(|m| m.is_default) {
            if let Some(first) = self.models.first_mut() {
                first.is_default = true;
            }
        }
        
        removed
    }

    /// Set a model as the default.
    pub fn set_default_model_by_name(&mut self, name: &str) -> bool {
        let exists = self.models.iter().any(|m| m.name == name);
        if !exists {
            return false;
        }

        for model in &mut self.models {
            model.is_default = model.name == name;
        }
        true
    }

    /// Resolve a model reference to an actual model ID.
    /// Accepts either a configured model name or a raw model ID.
    #[allow(dead_code)]
    pub fn resolve_model(&self, model_ref: &str) -> Option<String> {
        // First try as a configured model name
        if let Some(alias) = self.get_model(model_ref) {
            return Some(alias.model_id.clone());
        }
        
        // Otherwise treat it as a raw model ID
        Some(model_ref.to_string())
    }
}

/// Get display name for a provider type
fn get_provider_display_name(provider_type: &str) -> String {
    match provider_type {
        "ollama" => "Ollama".to_string(),
        "llamafile" => "Llamafile".to_string(),
        "openai" => "OpenAI".to_string(),
        "anthropic" => "Anthropic".to_string(),
        "mistral" => "Mistral".to_string(),
        "groq" => "Groq".to_string(),
        "lmstudio" => "LM Studio".to_string(),
        other => {
            // Capitalize first letter
            let mut chars = other.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().chain(chars).collect(),
                None => other.to_string(),
            }
        }
    }
}
