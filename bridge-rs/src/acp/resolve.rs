//! Resolves a bare command name to an absolute path through the user's
//! login shell.
//!
//! Firefox started from the Dock doesn't inherit the user's shell `PATH`
//! (no `.zprofile`, no Homebrew's `/opt/homebrew/bin`, etc.), so the bridge's
//! own environment can't find an `npx`-based agent preset either. This asks
//! the user's actual login shell to resolve the name the way a terminal
//! would - without ever running a shell *on* anything the caller sends: the
//! name is always passed as an argument to the shell's `-c` script, never
//! interpolated into it.

use serde_json::{json, Value};

use crate::rpc::RpcError;

/// Bare command name: no path separators, no shell metacharacters. Checked
/// before anything is run. A name that fails this is treated exactly like
/// one that doesn't resolve to anything (`null`), not a `-32602` error -
/// this is a lookup, not a mutation, so there is nothing to reject. This is
/// also what stops a name like `/bin/sh` (a real, existing path) from
/// "resolving": `command -v` treats an operand containing `/` as a literal
/// path check, not a `PATH` search, so skipping this check would let an
/// existing absolute path through as if it were a bare command name.
fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && bytes
            .iter()
            .all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'+' | b'-'))
}

/// `acp.resolve_command {name}` -> `{path: string | null}`. Unix only:
/// elsewhere, and for a name that's missing, invalid, unresolved, or a
/// login shell that times out, this returns `{"path": null}` - never an
/// error.
pub async fn resolve_command(params: Value) -> Result<Value, RpcError> {
    let name = params.get("name").and_then(|v| v.as_str());
    let path = match name {
        Some(name) if valid_name(name) => resolve(name).await,
        _ => None,
    };
    Ok(json!({ "path": path }))
}

#[cfg(not(unix))]
async fn resolve(_name: &str) -> Option<String> {
    None
}

#[cfg(unix)]
async fn resolve(name: &str) -> Option<String> {
    use std::process::Stdio;
    use std::time::{Duration, Instant};
    use tokio::process::Command;

    /// How long to wait for the login shell before giving up and returning
    /// `null`. A login shell can run arbitrary startup files (`.zprofile`
    /// etc); this bounds how long a slow or hung one can hold up the
    /// caller.
    const RESOLVE_TIMEOUT: Duration = Duration::from_secs(5);
    /// Cap on how much of the shell's stdout is kept. A resolved path is
    /// tiny; this is just a sanity bound, generous for any real path.
    const MAX_OUTPUT_BYTES: usize = 4096;
    /// The only variables the login shell runs with: enough to find and run
    /// itself, read its startup files, and find the command. No API keys,
    /// no terminal/session identifiers - this is the bridge's own (not the
    /// caller's) idea of each, taken from its process environment.
    const INHERITED_ENV: &[&str] = &["HOME", "USER", "LOGNAME", "SHELL", "PATH"];

    let shell = login_shell();
    let mut command = Command::new(shell);
    command
        .env_clear()
        .arg("-l")
        .arg("-c")
        .arg(r#"command -v -- "$1""#)
        .arg("_")
        .arg(name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // Its own process group, same reason as the real agents in `mod.rs`
    // (`process_group(0)` there, `kill_process_group` here): a login shell
    // can background a job from a startup file (a `.zprofile` line ending
    // in `&`), and that job inherits the shell's stdout fd and keeps it
    // open - and keeps running - long after the shell itself has printed
    // its answer and exited. Putting the shell in its own group lets the
    // group-kill below reach that backgrounded job too, not just the
    // direct child `kill_on_drop` would otherwise be limited to.
    command.process_group(0);
    for key in INHERITED_ENV {
        if let Ok(value) = std::env::var(key) {
            command.env(key, value);
        }
    }

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(_) => return None,
    };
    let pid = child.id();
    let mut stdout = child.stdout.take();

    // Read with its own deadline rather than waiting for true EOF: a
    // backgrounded holdover job (see above) keeps the pipe's write end
    // open, so EOF may never come even though the real answer already
    // arrived. `read_capped_with_deadline` keeps whatever was read so far
    // once the deadline passes, instead of discarding it - which is what a
    // single outer `tokio::time::timeout` around the whole read would do.
    // It also polls the direct child's own exit status, so a holdover job
    // doesn't force every successful resolution to wait out the full
    // deadline: once the shell we actually asked to run has exited, its
    // own output is complete, whatever a backgrounded descendant still
    // holding the pipe open might do afterward.
    let deadline = Instant::now() + RESOLVE_TIMEOUT;
    let output = match stdout.as_mut() {
        Some(out) => read_capped_with_deadline(out, MAX_OUTPUT_BYTES, deadline, &mut child).await,
        None => Vec::new(),
    };
    drop(stdout);

    // Always reap the whole group - whether the shell finished cleanly, a
    // holdover job kept the pipe open past the deadline, or the shell
    // itself never answered at all. `kill_process_group` is the same
    // `/bin/kill -KILL -<pid>` used for real agents; `child.kill()` +
    // `wait()` after it is the same direct-child fallback/reap as there
    // too, so nothing here is left a zombie or, for a backgrounded job
    // sharing this group, orphaned and still running.
    if let Some(pid) = pid {
        super::kill_process_group(pid).await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;

    let text = std::str::from_utf8(&output).ok()?;
    // The *last* non-empty line, not the first: a login shell's startup
    // files can print a banner (a MOTD, a version-manager notice, ...)
    // before the actual `command -v` output, and that output is always
    // the final thing printed since it's the last thing the script runs.
    let candidate = text.lines().map(str::trim).filter(|line| !line.is_empty()).last()?;
    if is_executable_absolute_path(candidate) {
        Some(candidate.to_string())
    } else {
        None
    }
}

/// The user's login shell: the bridge's own `$SHELL`, if it's an existing
/// absolute executable, falling back to `/bin/zsh` then `/bin/sh` if it
/// isn't (unset, empty, relative, or pointing nowhere real) - never
/// anything caller-influenced.
#[cfg(unix)]
fn login_shell() -> String {
    if let Ok(value) = std::env::var("SHELL") {
        if is_executable_absolute_path(&value) {
            return value;
        }
    }
    if is_executable_absolute_path("/bin/zsh") {
        return "/bin/zsh".to_string();
    }
    "/bin/sh".to_string()
}

/// Reads `reader` until EOF, the `cap` byte limit, `deadline`, or the
/// direct child's own exit, whichever comes first - keeping whatever was
/// read so far rather than discarding it, however the loop ends.
///
/// Each individual read is bounded by a short poll interval (not the full
/// remaining time): if nothing arrives within one interval, this checks
/// whether `child` has already exited. That matters because a backgrounded
/// holdover job (a `.zprofile` line ending in `&`) keeps the pipe's write
/// end open - and so keeps blocking a read that's only waiting for EOF -
/// long after the shell actually asked to run has printed its answer and
/// exited; without the exit check, every resolution past a holdover job
/// would wait out the entire `deadline` instead of returning as soon as the
/// real answer is in. The exit check only ends the loop on an *empty* poll
/// interval, never instead of draining data that's actually arriving, so a
/// multi-line answer is still read in full. `deadline` remains the backstop
/// for a shell that never exits at all.
#[cfg(unix)]
async fn read_capped_with_deadline<R>(
    reader: &mut R,
    cap: usize,
    deadline: std::time::Instant,
    child: &mut tokio::process::Child,
) -> Vec<u8>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    /// How often an empty read re-checks whether the direct child has
    /// already exited. Small enough that a fast resolution past a holdover
    /// job still feels immediate, large enough not to busy-poll.
    const POLL_INTERVAL: std::time::Duration = std::time::Duration::from_millis(50);

    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        let slice = remaining.min(POLL_INTERVAL);
        match tokio::time::timeout(slice, reader.read(&mut chunk)).await {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                if buf.len() < cap {
                    let take = (cap - buf.len()).min(n);
                    buf.extend_from_slice(&chunk[..take]);
                }
            }
            Ok(Err(_)) => break,
            Err(_) => {
                // Nothing arrived in this poll interval. If the direct
                // child has already exited, nothing more of *its* output
                // is coming - what's left open is, at most, a backgrounded
                // descendant's copy of the same pipe. Otherwise, keep
                // polling until `deadline`.
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
            }
        }
    }
    buf
}

/// True only if `path` is absolute and names an executable regular file -
/// never a directory, and never a relative path even if the shell somehow
/// printed one.
#[cfg(unix)]
fn is_executable_absolute_path(path: &str) -> bool {
    if !path.starts_with('/') {
        return false;
    }
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.is_file() {
        return false;
    }
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_name_rejects_slashes_empty_and_overlong() {
        assert!(valid_name("npx"));
        assert!(valid_name("node_modules.bin-tool+x"));
        assert!(!valid_name(""));
        assert!(!valid_name("a/b"));
        assert!(!valid_name("/bin/sh"));
        assert!(!valid_name(&"a".repeat(65)));
        assert!(valid_name(&"a".repeat(64)));
        assert!(!valid_name("x;touch /tmp/pwned"));
    }
}
