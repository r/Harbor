//! A tiny stdio "agent" used only by `tests/acp_relay.rs` (and, for
//! argv[1] == "__sleep_forever", by itself as a grandchild) to exercise the
//! bridge's process management and relay without depending on a real ACP
//! agent being installed. Not part of the shipped bridge.
//!
//! Protocol: reads newline-delimited JSON objects from stdin. By default it
//! echoes each object back on stdout, verbatim, as its own line. A few
//! `__test_cmd` values change that:
//! - `"garbage"`: writes one non-JSON line to stdout instead of echoing.
//! - `"badutf8"`: writes one invalid-UTF-8 line to stdout, then keeps going.
//! - `"big"` with `"size": N`: echoes a JSON object with an N-byte padding
//!   string, to exercise the bridge's oversized-line handling.
//! - `"stderrbad"`: writes one invalid-UTF-8 line to stderr.
//! - `"stderrflood"`: writes 2000 1KB-ish lines to stderr, then a `"done"`
//!   marker object to stdout, to exercise stderr draining under load. Exits
//!   non-zero on the first failed stderr write (e.g. EPIPE from a bridge
//!   that stopped draining it) instead of ignoring it, so a test can tell
//!   stderr draining actually kept working from the agent surviving.
//! - `"stopreading"`: acks on stdout, then stops reading stdin forever (but
//!   keeps the process alive), modeling an agent that wedges and lets its
//!   stdin pipe - and the bridge's send queue behind it - fill up.
//! - `"spawn_grandchild"`: spawns a second copy of this binary (argv[1] =
//!   `__sleep_forever`) that inherits this process's stdout/stderr and
//!   never exits on its own, modeling a real agent launched through a
//!   wrapper (e.g. `npx` -> `node`) where killing the direct child alone
//!   leaves a descendant holding the pipe open.
//! - `"spawn_orphan_and_exit"`: spawns a second copy of this binary
//!   (`__sleep_forever`) with its own stdio (not inherited, so it won't
//!   hold this process's pipes open), then exits with code 0 right away -
//!   modeling an agent that exits normally while a background process it
//!   started is still running.
//! - `"env"`: writes `{"env": {...}}` with every variable in its own
//!   environment, so a test can check what the bridge passed it.
//! - `"cwd"`: writes `{"cwd": "<path>"}` with its actual current working
//!   directory, so a test can check what the bridge spawned it with.
//! - `"exit"` with `"code": N`: exits immediately with code N.

use std::io::{self, BufRead, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("__sleep_forever") {
        // A grandchild whose only job is to stay alive and keep holding
        // whatever stdio it inherited open.
        loop {
            std::thread::sleep(std::time::Duration::from_secs(3600));
        }
    }

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.trim().is_empty() {
            continue;
        }

        let value: serde_json::Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if let Some(cmd) = value.get("__test_cmd").and_then(|c| c.as_str()) {
            match cmd {
                "garbage" => {
                    let _ = writeln!(stdout, "not valid json {{{{");
                    let _ = stdout.flush();
                    continue;
                }
                "badutf8" => {
                    let _ = stdout.write_all(b"\xff\xfe not utf8 on stdout\n");
                    let _ = stdout.flush();
                    continue;
                }
                "env" => {
                    let vars: serde_json::Map<String, serde_json::Value> = std::env::vars_os()
                        .map(|(k, v)| {
                            (
                                k.to_string_lossy().into_owned(),
                                serde_json::Value::String(v.to_string_lossy().into_owned()),
                            )
                        })
                        .collect();
                    let payload = serde_json::json!({ "env": vars });
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&payload).unwrap());
                    let _ = stdout.flush();
                    continue;
                }
                "cwd" => {
                    let cwd = std::env::current_dir()
                        .map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    let payload = serde_json::json!({ "cwd": cwd });
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&payload).unwrap());
                    let _ = stdout.flush();
                    continue;
                }
                "exit" => {
                    let code = value.get("code").and_then(|c| c.as_i64()).unwrap_or(0) as i32;
                    let _ = stdout.flush();
                    std::process::exit(code);
                }
                "big" => {
                    let size = value.get("size").and_then(|s| s.as_u64()).unwrap_or(0) as usize;
                    let padding = "x".repeat(size);
                    let payload = serde_json::json!({ "big": padding });
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&payload).unwrap());
                    let _ = stdout.flush();
                    continue;
                }
                "stderrbad" => {
                    let mut stderr = io::stderr();
                    let _ = stderr.write_all(b"\xff bad stderr\n");
                    let _ = stderr.flush();
                    continue;
                }
                "stderrflood" => {
                    let mut stderr = io::stderr();
                    let line = vec![b'x'; 1023];
                    for _ in 0..2000 {
                        // Strict on purpose: if the bridge ever stops
                        // draining stderr, this write fails (EPIPE) and we
                        // exit instead of limping on - a test driving a
                        // lenient agent that ignores such errors can't
                        // distinguish "draining kept working" from "it
                        // didn't, but nothing noticed".
                        if stderr.write_all(&line).is_err() || stderr.write_all(b"\n").is_err() {
                            std::process::exit(42);
                        }
                    }
                    let _ = stderr.flush();
                    let payload = serde_json::json!({ "flood": "done" });
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&payload).unwrap());
                    let _ = stdout.flush();
                    continue;
                }
                "stopreading" => {
                    let _ = stdout.write_all(b"{\"stopped\":true}\n");
                    let _ = stdout.flush();
                    loop {
                        std::thread::sleep(std::time::Duration::from_secs(3600));
                    }
                }
                "spawn_grandchild" => {
                    let exe = std::env::current_exe().expect("current_exe");
                    let pid = std::process::Command::new(exe)
                        .arg("__sleep_forever")
                        .stdin(std::process::Stdio::null())
                        .spawn()
                        .map(|c| c.id())
                        .unwrap_or(0);
                    let payload = serde_json::json!({ "grandchild_pid": pid });
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&payload).unwrap());
                    let _ = stdout.flush();
                    continue;
                }
                "spawn_orphan_and_exit" => {
                    let exe = std::env::current_exe().expect("current_exe");
                    let pid = std::process::Command::new(exe)
                        .arg("__sleep_forever")
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null())
                        .spawn()
                        .map(|c| c.id())
                        .unwrap_or(0);
                    let payload = serde_json::json!({ "orphan_pid": pid });
                    let _ = writeln!(stdout, "{}", serde_json::to_string(&payload).unwrap());
                    let _ = stdout.flush();
                    std::process::exit(0);
                }
                _ => {}
            }
        }

        let _ = writeln!(stdout, "{}", serde_json::to_string(&value).unwrap());
        let _ = stdout.flush();
    }
}
