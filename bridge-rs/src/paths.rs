//! Shared on-disk locations, so "where does Harbor keep its data" has one
//! definition.

use std::path::PathBuf;

/// Harbor's per-user data directory: `~/.harbor`. Distinct from
/// `dirs::config_dir()/harbor` (see `llm::config::LlmConfig::config_path` and
/// `acp::config::AcpConfig::config_path`), which is the OS-specific config
/// location for `llm.json`/`acp.json`. This one holds data that isn't
/// user-edited config: OAuth tokens and credentials (`oauth::storage`,
/// `oauth::credentials_file_path`), and per-site ACP working directories
/// (`acp::workspace_dir`).
///
/// Falls back to the current directory if the home directory can't be
/// found, matching the fallback `LlmConfig::config_path` /
/// `AcpConfig::config_path` already use for their own (different) base dir.
pub fn harbor_dir() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".harbor")
}
