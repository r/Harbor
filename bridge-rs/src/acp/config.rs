//! ACP (Agent Client Protocol) agent configuration.
//!
//! Lives in `acp.json` next to `llm.json` (see `llm::config::LlmConfig::config_path`).
//! A missing file means no agents are configured; it is not an error.
//!
//! Commands, args and env come only from this file. RPC messages from the
//! extension may only select an agent by `id` - they can never carry a
//! command, argument or environment variable to execute.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

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

    /// Writes `acp.json` atomically: a temp file in the same directory,
    /// fsynced, then renamed over the real path, with the directory itself
    /// fsynced afterward so the rename survives a crash right after it.
    /// Mode `0600` on unix. Creates the harbor config dir
    /// (`dirs::config_dir()/harbor`) if it's missing. On any failure the
    /// temp file is removed rather than left behind - the rename either
    /// lands the whole new file or nothing changes, there is no window
    /// where a reader could see a partial write, and no stray `.tmp` file
    /// survives a failed save.
    ///
    /// `acp.save_agents` is additionally handled inline in
    /// `native_messaging.rs`'s read loop (the same treatment as
    /// `acp.send`), never spawned onto its own task, specifically so two
    /// saves sent back to back are applied in that same order - the second
    /// one doesn't start until the first has fully landed on disk. The
    /// process-wide lock below is a second, independent guard against the
    /// same hazard (concurrent callers racing the temp-file-then-rename
    /// sequence against each other) that holds even if another caller of
    /// this function is ever added without going through that same
    /// ordering guarantee - including the direct, in-process callers in
    /// this module's own tests.
    pub fn save_atomic(&self) -> io::Result<()> {
        let _guard = save_lock().lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let path = Self::config_path();
        let dir = path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));
        std::fs::create_dir_all(&dir)?;

        let contents = serde_json::to_vec_pretty(self)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

        let tmp_path = unique_temp_path(&dir);
        let result =
            write_temp_file(&tmp_path, &contents).and_then(|_| std::fs::rename(&tmp_path, &path));
        match &result {
            Ok(()) => fsync_dir_best_effort(&dir),
            Err(_) => {
                let _ = std::fs::remove_file(&tmp_path);
            }
        }
        result
    }
}

/// Process-wide lock around the whole temp-file-then-rename sequence in
/// `save_atomic`. No `.await` happens while held - it's plain, fast,
/// synchronous file I/O - so a `std::sync::Mutex` (not an async one) is
/// enough; held across a `?` early return is fine too, since there's
/// nothing left to unwind that the `Err(_) => remove_file` arm above
/// doesn't already clean up before the guard drops.
fn save_lock() -> &'static std::sync::Mutex<()> {
    static SAVE_LOCK: OnceLock<std::sync::Mutex<()>> = OnceLock::new();
    SAVE_LOCK.get_or_init(|| std::sync::Mutex::new(()))
}

/// A temp file path in `dir` that can't collide with `acp.json` itself or
/// with another concurrent save. Pid plus a nanosecond timestamp alone
/// isn't unique enough under a burst of saves: `SystemTime::now()`'s
/// granularity on macOS is only about a microsecond, so two saves from the
/// same process within that window produced the same name - `write_temp_file`
/// then opened (with `create(true)`, no `create_new`) whichever one of them
/// lost the race to a half-written file from the other, or simply raced its
/// own already-renamed-away temp path and got `ENOENT`. A monotonic
/// per-process counter (always distinct, however fast it's called) added to
/// the name, plus `create_new` in `write_temp_file` (which fails loudly on a
/// collision instead of silently reusing the file), is what actually
/// guarantees uniqueness - the timestamp is kept only so a leftover file
/// from a failed save is still identifiable by roughly when it happened.
fn unique_temp_path(dir: &Path) -> PathBuf {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    dir.join(format!(
        ".acp.json.tmp.{}.{}.{}",
        std::process::id(),
        now.as_nanos(),
        n
    ))
}

/// Writes `contents` to `path`, mode `0600` on unix from the moment the
/// file is created (not set afterward, which would leave a window where a
/// concurrent reader with the right permissions could see the file at a
/// looser mode), then `fsync`s it before returning. Does not rename -
/// that's the caller's job, once this has succeeded. `create_new` (not
/// `create` + `truncate`) so that if `unique_temp_path` were ever handed a
/// name that collides anyway, this fails loudly instead of silently
/// overwriting - or getting overwritten by - another save's in-progress
/// temp file.
fn write_temp_file(path: &Path, contents: &[u8]) -> io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    // Belt-and-suspenders against a process umask widening the mode the
    // file was actually created with.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// Best-effort `fsync` of the directory itself after a rename into it, so
/// the rename is durable across a crash right after `save_atomic` returns
/// success - not just the temp file's own contents, which `write_temp_file`
/// already `fsync`s before the rename. Unix only (opening a directory as a
/// `File` isn't portable); failure is logged, not propagated - a save that
/// already landed the rename is still a success even if this best-effort
/// extra durability step can't run (e.g. a filesystem that doesn't support
/// it).
fn fsync_dir_best_effort(dir: &Path) {
    #[cfg(unix)]
    {
        match std::fs::File::open(dir) {
            Ok(dir_file) => {
                if let Err(e) = dir_file.sync_all() {
                    tracing::warn!("acp: failed to fsync {} after a save: {}", dir.display(), e);
                }
            }
            Err(e) => {
                tracing::warn!("acp: failed to open {} to fsync after a save: {}", dir.display(), e);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
    }
}

// =============================================================================
// Validation for `acp.save_agents`
// =============================================================================

/// At most this many agents in one `acp.json`.
pub const MAX_AGENTS: usize = 32;
/// `id` is at most this many bytes (see `valid_id`).
pub const MAX_ID_BYTES: usize = 32;
/// `name` is at most this many characters.
pub const MAX_NAME_CHARS: usize = 64;
/// `command` is at most this many bytes.
pub const MAX_COMMAND_BYTES: usize = 1024;
/// `args` has at most this many entries.
pub const MAX_ARGS: usize = 64;
/// Each `args` entry is at most this many bytes.
pub const MAX_ARG_BYTES: usize = 4096;
/// `env` has at most this many key/value pairs.
pub const MAX_ENV_PAIRS: usize = 64;
/// Each `env` value is at most this many bytes.
pub const MAX_ENV_VALUE_BYTES: usize = 4096;

/// `^[a-z0-9][a-z0-9-]{0,31}$`: lowercase/digit first, then up to 31 more
/// lowercase/digit/hyphen characters.
fn valid_id(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() || b.len() > MAX_ID_BYTES {
        return false;
    }
    matches!(b[0], b'a'..=b'z' | b'0'..=b'9')
        && b.iter().all(|&c| matches!(c, b'a'..=b'z' | b'0'..=b'9' | b'-'))
}

/// `^[A-Za-z_][A-Za-z0-9_]*$`. Its character class already excludes a NUL
/// byte (and everything else outside `[A-Za-z0-9_]`), so an env key never
/// needs its own separate NUL check the way `name`, `command`, `args` and
/// env *values* do below - those are otherwise-unrestricted strings.
fn valid_env_key(s: &str) -> bool {
    let b = s.as_bytes();
    if b.is_empty() {
        return false;
    }
    matches!(b[0], b'A'..=b'Z' | b'a'..=b'z' | b'_')
        && b.iter()
            .all(|&c| matches!(c, b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_'))
}

/// A NUL byte can't be represented in a native OS string on the platforms
/// the bridge runs on (constructing a `CString`/an `OsStr` argument from
/// one fails outright), so it would otherwise surface as a confusing
/// process-spawn error far from here rather than a clear validation
/// message naming the field.
fn contains_nul(s: &str) -> bool {
    s.contains('\0')
}

/// Parses and validates the raw `agents` array from `acp.save_agents`,
/// returning a human-readable message naming the first offending field
/// (e.g. `"agents[1].command must be ..."`) on failure, for the caller to
/// wrap as a `-32602` error. Parses directly from JSON `Value` rather than
/// deriving `Deserialize` on untrusted input, so a field of the wrong type
/// gets the same field-naming treatment as one that's the right type but
/// out of bounds, instead of a generic serde type-mismatch message.
pub fn parse_and_validate_agents(agents: &[Value]) -> Result<Vec<AgentConfig>, String> {
    if agents.len() > MAX_AGENTS {
        return Err(format!("agents: at most {} agents are allowed", MAX_AGENTS));
    }

    let mut parsed = Vec::with_capacity(agents.len());
    let mut seen_ids: HashSet<String> = HashSet::new();

    for (i, value) in agents.iter().enumerate() {
        let prefix = format!("agents[{}]", i);
        if !value.is_object() {
            return Err(format!("{} must be an object", prefix));
        }

        let id = value
            .get("id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("{}.id must be a string", prefix))?;
        if !valid_id(id) {
            return Err(format!(
                "{}.id must match ^[a-z0-9][a-z0-9-]{{0,31}}$",
                prefix
            ));
        }
        if !seen_ids.insert(id.to_string()) {
            return Err(format!("{}.id duplicates an earlier agent id: {}", prefix, id));
        }

        let name = value
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("{}.name must be a string", prefix))?;
        if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
            return Err(format!(
                "{}.name must be a non-empty string of at most {} chars",
                prefix, MAX_NAME_CHARS
            ));
        }
        if contains_nul(name) {
            return Err(format!("{}.name must not contain a NUL byte", prefix));
        }

        let command = value
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("{}.command must be a string", prefix))?;
        if command.is_empty() || command.len() > MAX_COMMAND_BYTES {
            return Err(format!(
                "{}.command must be a non-empty string of at most {} bytes",
                prefix, MAX_COMMAND_BYTES
            ));
        }
        if contains_nul(command) {
            return Err(format!("{}.command must not contain a NUL byte", prefix));
        }

        let args_value = value
            .get("args")
            .cloned()
            .unwrap_or_else(|| Value::Array(vec![]));
        let args_array = args_value
            .as_array()
            .ok_or_else(|| format!("{}.args must be an array", prefix))?;
        if args_array.len() > MAX_ARGS {
            return Err(format!("{}.args must have at most {} entries", prefix, MAX_ARGS));
        }
        let mut args = Vec::with_capacity(args_array.len());
        for (j, arg) in args_array.iter().enumerate() {
            let arg = arg
                .as_str()
                .ok_or_else(|| format!("{}.args[{}] must be a string", prefix, j))?;
            if arg.len() > MAX_ARG_BYTES {
                return Err(format!(
                    "{}.args[{}] must be at most {} bytes",
                    prefix, j, MAX_ARG_BYTES
                ));
            }
            if contains_nul(arg) {
                return Err(format!("{}.args[{}] must not contain a NUL byte", prefix, j));
            }
            args.push(arg.to_string());
        }

        let env_value = value
            .get("env")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        let env_obj = env_value
            .as_object()
            .ok_or_else(|| format!("{}.env must be an object", prefix))?;
        if env_obj.len() > MAX_ENV_PAIRS {
            return Err(format!("{}.env must have at most {} entries", prefix, MAX_ENV_PAIRS));
        }
        let mut env = HashMap::with_capacity(env_obj.len());
        for (key, val) in env_obj.iter() {
            if !valid_env_key(key) {
                return Err(format!(
                    "{}.env key '{}' must match ^[A-Za-z_][A-Za-z0-9_]*$",
                    prefix, key
                ));
            }
            let val_str = val
                .as_str()
                .ok_or_else(|| format!("{}.env.{} must be a string", prefix, key))?;
            if val_str.len() > MAX_ENV_VALUE_BYTES {
                return Err(format!(
                    "{}.env.{} must be at most {} bytes",
                    prefix, key, MAX_ENV_VALUE_BYTES
                ));
            }
            if contains_nul(val_str) {
                return Err(format!("{}.env.{} must not contain a NUL byte", prefix, key));
            }
            env.insert(key.clone(), val_str.to_string());
        }

        parsed.push(AgentConfig {
            id: id.to_string(),
            name: name.to_string(),
            command: command.to_string(),
            args,
            env,
        });
    }

    Ok(parsed)
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

    fn valid_agent_value() -> Value {
        serde_json::json!({
            "id": "goose",
            "name": "Goose",
            "command": "goose",
            "args": ["acp"],
            "env": {"GOOSE_MODE": "approve"}
        })
    }

    #[test]
    fn parse_and_validate_agents_accepts_the_documented_shape() {
        let agents = parse_and_validate_agents(&[valid_agent_value()]).expect("should validate");
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "goose");
        assert_eq!(agents[0].args, vec!["acp".to_string()]);
    }

    /// Table of every documented validation rule, each paired with a
    /// substring the rejection message must contain, so a passing test here
    /// proves both "rejected" and "names the right field".
    fn invalid_cases() -> Vec<(&'static str, Value, &'static str)> {
        vec![
            (
                "id_bad_chars",
                serde_json::json!([{"id": "Bad_ID!", "name": "n", "command": "c", "args": [], "env": {}}]),
                ".id",
            ),
            (
                "id_too_long",
                serde_json::json!([{"id": "a".repeat(33), "name": "n", "command": "c", "args": [], "env": {}}]),
                ".id",
            ),
            (
                "id_duplicate",
                serde_json::json!([
                    {"id": "dup", "name": "n", "command": "c", "args": [], "env": {}},
                    {"id": "dup", "name": "n2", "command": "c2", "args": [], "env": {}},
                ]),
                ".id",
            ),
            (
                "name_empty",
                serde_json::json!([{"id": "a1", "name": "", "command": "c", "args": [], "env": {}}]),
                ".name",
            ),
            (
                "name_too_long",
                serde_json::json!([{"id": "a1", "name": "a".repeat(65), "command": "c", "args": [], "env": {}}]),
                ".name",
            ),
            (
                "command_empty",
                serde_json::json!([{"id": "a1", "name": "n", "command": "", "args": [], "env": {}}]),
                ".command",
            ),
            (
                "command_too_long",
                serde_json::json!([{"id": "a1", "name": "n", "command": "a".repeat(1025), "args": [], "env": {}}]),
                ".command",
            ),
            (
                "too_many_args",
                serde_json::json!([{"id": "a1", "name": "n", "command": "c", "args": vec!["x"; 65], "env": {}}]),
                ".args",
            ),
            (
                "arg_too_long",
                serde_json::json!([{"id": "a1", "name": "n", "command": "c", "args": ["a".repeat(4097)], "env": {}}]),
                ".args",
            ),
            (
                "too_many_env",
                serde_json::json!([{
                    "id": "a1", "name": "n", "command": "c", "args": [],
                    "env": (0..65).map(|i| (format!("K{}", i), "v".to_string())).collect::<HashMap<_, _>>(),
                }]),
                ".env",
            ),
            (
                "env_bad_key",
                serde_json::json!([{"id": "a1", "name": "n", "command": "c", "args": [], "env": {"1BAD": "v"}}]),
                ".env",
            ),
            (
                "env_value_too_long",
                serde_json::json!([{"id": "a1", "name": "n", "command": "c", "args": [], "env": {"K": "a".repeat(4097)}}]),
                ".env",
            ),
            (
                "too_many_agents",
                Value::Array((0..33).map(|i| {
                    serde_json::json!({"id": format!("a{}", i), "name": "n", "command": "c", "args": [], "env": {}})
                }).collect()),
                "agents",
            ),
        ]
    }

    #[test]
    fn parse_and_validate_agents_rejects_every_documented_rule() {
        for (label, agents_value, expected_substring) in invalid_cases() {
            let agents_array = agents_value.as_array().expect("case must be an array");
            let result = parse_and_validate_agents(agents_array);
            let message = match result {
                Ok(_) => panic!("case {}: expected rejection, got Ok", label),
                Err(message) => message,
            };
            assert!(
                message.contains(expected_substring),
                "case {}: expected message to contain {:?}, got {:?}",
                label,
                expected_substring,
                message
            );
        }
    }

    #[test]
    fn save_atomic_writes_mode_0600_and_leaves_no_tmp_file() {
        let dir = std::env::temp_dir().join(format!(
            "harbor-acp-save-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("acp.json");

        let config = AcpConfig {
            agents: vec![AgentConfig {
                id: "goose".to_string(),
                name: "Goose".to_string(),
                command: "goose".to_string(),
                args: vec!["acp".to_string()],
                env: HashMap::new(),
            }],
        };
        let contents = serde_json::to_vec_pretty(&config).unwrap();
        let tmp_path = unique_temp_path(&dir);
        write_temp_file(&tmp_path, &contents).unwrap();
        std::fs::rename(&tmp_path, &path).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        let leftover: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name != "acp.json")
            .collect();
        assert!(leftover.is_empty(), "leftover files: {:?}", leftover);

        std::fs::remove_dir_all(&dir).ok();
    }
}
