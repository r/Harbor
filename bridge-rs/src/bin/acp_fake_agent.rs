//! A tiny stdio "agent" used only by `src/acp/mod.rs` tests to exercise the
//! bridge's process management and relay without depending on a real ACP
//! agent being installed. Not part of the shipped bridge.
//!
//! Protocol: reads newline-delimited JSON objects from stdin. By default it
//! echoes each object back on stdout, verbatim, as its own line. Two test
//! control fields change that:
//! - `{"__test_cmd": "garbage"}` writes one non-JSON line instead of echoing.
//! - `{"__test_cmd": "big", "size": N}` echoes a JSON object with an N-byte
//!   padding string, to exercise the bridge's oversized-line handling.
//! - `{"__test_cmd": "exit", "code": N}` exits immediately with code N.

use std::io::{self, BufRead, Write};

fn main() {
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
                _ => {}
            }
        }

        let _ = writeln!(stdout, "{}", serde_json::to_string(&value).unwrap());
        let _ = stdout.flush();
    }
}
