//! Shared on-disk locations, so "where does Harbor keep its data" has one
//! definition.

use std::path::PathBuf;

/// Harbor's per-user data directory: `~/.harbor`, or `None` if the home
/// directory can't be found. Distinct from `dirs::config_dir()/harbor` (see
/// `llm::config::LlmConfig::config_path` and `acp::config::AcpConfig::config_path`),
/// which is the OS-specific config location for `llm.json`/`acp.json`. This
/// one holds data that isn't user-edited config: OAuth tokens and
/// credentials (`oauth::storage`, `oauth::credentials_file_path`), and
/// per-site ACP working directories (`acp::workspace_dir`).
///
/// Deliberately returns `None` rather than picking a fallback itself: the
/// right fallback (or whether there even is one) differs by caller.
/// `oauth::credentials_file_path` falls back to the current directory
/// (unchanged, pre-existing behavior); `oauth::storage::TokenStore` and
/// `acp::workspace_dir` treat it as an error instead, since silently
/// writing OAuth tokens or an agent's working directory under whatever the
/// bridge's current directory happens to be would be worse than failing.
pub fn harbor_dir() -> Option<PathBuf> {
    harbor_dir_in(dirs::home_dir())
}

/// `harbor_dir`, taking the home directory explicitly so the "no home
/// directory" case is testable without relying on environment/global state.
fn harbor_dir_in(home: Option<PathBuf>) -> Option<PathBuf> {
    home.map(|h| h.join(".harbor"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_home_directory_yields_none() {
        assert_eq!(harbor_dir_in(None), None);
    }

    #[test]
    fn home_directory_is_joined_with_dot_harbor() {
        assert_eq!(
            harbor_dir_in(Some(PathBuf::from("/home/u"))),
            Some(PathBuf::from("/home/u/.harbor"))
        );
    }
}
