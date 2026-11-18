//! ACP (Agent Client Protocol) agent configuration.
//!
//! Lives in `acp.json` next to `llm.json` (see `llm::config::LlmConfig::config_path`).
//! A missing file means no agents are configured; it is not an error.
//!
//! Commands, args and env come only from this file. RPC messages from the
//! extension may only select an agent by `id` - they can never carry a
//! command, argument or environment variable to execute.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// A single configured ACP agent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    pub id: String,
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
}

/// Top level `acp.json` shape: `{"agents": [...]}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AcpConfig {
    #[serde(default)]
    pub agents: Vec<AgentConfig>,
}

impl AcpConfig {
    /// Path to `acp.json`, next to `llm.json`.
    pub fn config_path() -> PathBuf {
        dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("harbor")
            .join("acp.json")
    }

    /// Load the real on-disk configuration. A missing file yields no agents.
    pub fn load() -> Self {
        Self::load_from(&Self::config_path())
    }

    /// Load configuration from an explicit path. Used directly by tests so
    /// they never touch the real config directory. A missing or malformed
    /// file yields no agents rather than an error: the bridge should still
    /// start, just with nothing to open.
    pub fn load_from(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(contents) => serde_json::from_str(&contents).unwrap_or_else(|e| {
                tracing::warn!("Failed to parse {}: {}", path.display(), e);
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    /// Find an agent by id.
    pub fn find(&self, id: &str) -> Option<&AgentConfig> {
        self.agents.iter().find(|a| a.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_has_no_agents() {
        let config = AcpConfig::load_from(Path::new("/nonexistent/path/acp.json"));
        assert!(config.agents.is_empty());
    }

    #[test]
    fn parses_documented_shape() {
        let dir = std::env::temp_dir().join(format!("harbor-acp-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("acp.json");
        std::fs::write(
            &path,
            r#"{"agents":[{"id":"goose","name":"goose","command":"goose","args":["acp"],"env":{}}]}"#,
        )
        .unwrap();

        let config = AcpConfig::load_from(&path);
        assert_eq!(config.agents.len(), 1);
        let agent = config.find("goose").expect("goose agent");
        assert_eq!(agent.command, "goose");
        assert_eq!(agent.args, vec!["acp".to_string()]);

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn malformed_file_has_no_agents() {
        let dir = std::env::temp_dir().join(format!("harbor-acp-bad-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("acp.json");
        std::fs::write(&path, "not json").unwrap();

        let config = AcpConfig::load_from(&path);
        assert!(config.agents.is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }
}
