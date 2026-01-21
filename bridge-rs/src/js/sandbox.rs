//! Sandbox capabilities and permission checking for JS servers.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// Capabilities that can be granted to a JS server.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct Capabilities {
    /// Network access permissions
    #[serde(default)]
    pub network: NetworkCapabilities,
    
    /// Filesystem access permissions
    #[serde(default)]
    pub filesystem: FilesystemCapabilities,
}

/// Network access capabilities
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct NetworkCapabilities {
    /// List of allowed host patterns (e.g., "*.googleapis.com", "api.example.com")
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
}

/// Filesystem access capabilities
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct FilesystemCapabilities {
    /// List of allowed path prefixes for reading
    #[serde(default)]
    pub read_paths: Vec<String>,
    
    /// List of allowed path prefixes for writing
    #[serde(default)]
    pub write_paths: Vec<String>,
}

impl NetworkCapabilities {
    /// Check if a URL's host is allowed
    #[allow(dead_code)]
    pub fn is_host_allowed(&self, url: &str) -> bool {
        if self.allowed_hosts.is_empty() {
            return false;
        }

        let parsed = match url::Url::parse(url) {
            Ok(u) => u,
            Err(_) => return false,
        };

        let host = match parsed.host_str() {
            Some(h) => h,
            None => return false,
        };

        for pattern in &self.allowed_hosts {
            if pattern == "*" {
                return true;
            }
            
            if pattern.starts_with("*.") {
                // Wildcard subdomain match
                let suffix = &pattern[1..]; // ".example.com"
                if host.ends_with(suffix) || host == &pattern[2..] {
                    return true;
                }
            } else if host == pattern {
                return true;
            }
        }

        false
    }
}

impl FilesystemCapabilities {
    /// Check if a path is allowed for reading
    #[allow(dead_code)]
    pub fn can_read(&self, path: &Path) -> bool {
        self.is_path_allowed(path, &self.read_paths)
    }

    /// Check if a path is allowed for writing
    #[allow(dead_code)]
    pub fn can_write(&self, path: &Path) -> bool {
        self.is_path_allowed(path, &self.write_paths)
    }

    #[allow(dead_code)]
    fn is_path_allowed(&self, path: &Path, allowed: &[String]) -> bool {
        if allowed.is_empty() {
            return false;
        }

        // Canonicalize to prevent path traversal attacks
        let canonical = match path.canonicalize() {
            Ok(p) => p,
            // If path doesn't exist yet (for write), check parent
            Err(_) => {
                if let Some(parent) = path.parent() {
                    match parent.canonicalize() {
                        Ok(p) => p.join(path.file_name().unwrap_or_default()),
                        Err(_) => return false,
                    }
                } else {
                    return false;
                }
            }
        };

        for prefix in allowed {
            let allowed_path = PathBuf::from(prefix);
            if let Ok(allowed_canonical) = allowed_path.canonicalize() {
                if canonical.starts_with(&allowed_canonical) {
                    return true;
                }
            }
            // Also check if the prefix is a home-relative path
            if prefix.starts_with("~/") {
                if let Some(home) = dirs::home_dir() {
                    let expanded = home.join(&prefix[2..]);
                    if let Ok(expanded_canonical) = expanded.canonicalize() {
                        if canonical.starts_with(&expanded_canonical) {
                            return true;
                        }
                    }
                }
            }
        }

        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_host_matching() {
        let caps = NetworkCapabilities {
            allowed_hosts: vec![
                "api.example.com".to_string(),
                "*.googleapis.com".to_string(),
            ],
        };

        assert!(caps.is_host_allowed("https://api.example.com/foo"));
        assert!(caps.is_host_allowed("https://gmail.googleapis.com/v1/users"));
        assert!(caps.is_host_allowed("https://www.googleapis.com/oauth2"));
        assert!(!caps.is_host_allowed("https://evil.com/steal"));
        assert!(!caps.is_host_allowed("https://example.com/foo")); // exact match required
    }

    #[test]
    fn test_wildcard_all() {
        let caps = NetworkCapabilities {
            allowed_hosts: vec!["*".to_string()],
        };
        assert!(caps.is_host_allowed("https://anything.com/foo"));
    }
}
