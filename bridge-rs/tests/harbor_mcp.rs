//! End-to-end tests for the `harbor-mcp` binary, driving the real
//! executable over newline-delimited JSON-RPC on stdin/stdout exactly as an
//! MCP client would, with a fake `~/.harbor/agent.sock` server standing in
//! for `harbor-bridge`'s `agent_tabs.rs` relay.
//!
//! Each test gets its own temporary `$HOME`, so tests are fully isolated
//! from each other and never touch the real `~/.harbor/agent.sock`.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const MCP_BIN: &str = env!("CARGO_BIN_EXE_harbor-mcp");

/// A fresh, *short* temp directory under `/tmp` (not `std::env::temp_dir()`,
/// which on macOS is a long per-user path under `/var/folders/...`): once
/// joined with `.harbor/agent.sock`, that would push well past
/// `sockaddr_un`'s ~104-byte `sun_path` limit and fail to bind with
/// "path must be shorter than SUN_LEN". Keep `prefix` short for the same
/// reason.
fn unique_dir(prefix: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = PathBuf::from("/tmp").join(format!("{}-{}-{}", prefix, std::process::id(), n));
    std::fs::create_dir_all(&dir).expect("create temp home dir");
    dir
}

/// A `harbor-mcp` subprocess, talking newline-delimited JSON-RPC.
struct Mcp {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    _home: PathBuf,
}

impl Mcp {
    /// Spawns `harbor-mcp` with `$HOME` set to a fresh temp directory (no
    /// `.harbor/agent.sock` inside it, so every call reaches the "Firefox
    /// isn't running" path unless the caller creates one first).
    fn spawn() -> Self {
        let home = unique_dir("h150mh");
        Self::spawn_in(home)
    }

    fn spawn_in(home: PathBuf) -> Self {
        let mut child = Command::new(MCP_BIN)
            .env("HOME", &home)
            .env_remove("HARBOR_AGENT_SOCKET")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn harbor-mcp");
        let stdin = child.stdin.take().unwrap();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Mcp {
            child,
            stdin,
            stdout,
            _home: home,
        }
    }

    fn send(&mut self, value: &Value) {
        let mut bytes = serde_json::to_vec(value).unwrap();
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .expect("write to harbor-mcp stdin");
        self.stdin.flush().unwrap();
    }

    /// Reads one response line, with a generous timeout enforced via a
    /// background thread (std's blocking `BufRead` has no native timeout).
    fn read_response(&mut self) -> Value {
        let mut line = String::new();
        let deadline = Instant::now() + Duration::from_secs(10);
        // `read_line` on a pipe blocks until data or EOF; polling
        // `fill_buf`-less is awkward with std alone, so just trust a
        // generous wall-clock bound via a watchdog thread that kills the
        // child if this takes too long, rather than genuinely polling.
        let child_id = self.child.id();
        let watchdog = std::thread::spawn(move || {
            while Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
            // Best-effort: if the read below is still blocked past the
            // deadline, killing the child unblocks it (EOF on stdout).
            let _ = Command::new("kill")
                .arg("-9")
                .arg(child_id.to_string())
                .status();
        });
        let n = self
            .stdout
            .read_line(&mut line)
            .expect("read from harbor-mcp stdout");
        // The watchdog thread exits on its own once the deadline passes;
        // nothing to join here since a successful read means we didn't need
        // it. Dropping the handle is fine - it's not holding any resource
        // this test cares about cleaning up before exiting.
        drop(watchdog);
        assert!(n > 0, "harbor-mcp closed stdout before answering");
        serde_json::from_str(line.trim()).expect("response must be valid JSON")
    }

    fn rpc(&mut self, id: i64, method: &str, params: Value) -> Value {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        self.read_response()
    }
}

impl Drop for Mcp {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn answers_initialize_with_no_socket_present() {
    let mut mcp = Mcp::spawn();
    let resp = mcp.rpc(1, "initialize", json!({ "protocolVersion": "2025-06-18" }));
    assert_eq!(resp["result"]["protocolVersion"], json!("2025-06-18"));
    assert_eq!(
        resp["result"]["capabilities"]["tools"]["listChanged"],
        json!(false)
    );
    assert_eq!(resp["result"]["serverInfo"]["name"], json!("harbor"));
}

#[test]
fn answers_tools_list_with_no_socket_present() {
    let mut mcp = Mcp::spawn();
    let resp = mcp.rpc(1, "tools/list", json!({}));
    let tools = resp["result"]["tools"].as_array().expect("tools array");
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    assert_eq!(
        names,
        vec![
            "open_page",
            "list_pages",
            "list_page_tools",
            "call_page_tool"
        ]
    );
    for tool in tools {
        assert!(tool["description"].as_str().unwrap().len() > 10);
        assert!(tool["inputSchema"].is_object());
    }
}

#[test]
fn ping_and_an_unknown_method_are_answered_with_no_socket_present() {
    let mut mcp = Mcp::spawn();
    let pong = mcp.rpc(2, "ping", json!({}));
    assert_eq!(pong["result"], json!({}));

    let unknown = mcp.rpc(3, "not/a/real/method", json!({}));
    assert_eq!(unknown["error"]["code"], json!(-32601));
}

#[test]
fn a_notification_gets_no_reply_and_does_not_desync_the_connection() {
    let mut mcp = Mcp::spawn();
    mcp.send(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }));
    // Nothing to read for that - prove the connection is still fine by
    // sending a real request right after and getting its own answer back.
    let resp = mcp.rpc(1, "ping", json!({}));
    assert_eq!(resp["result"], json!({}));
}

#[test]
fn tools_call_without_a_socket_returns_the_not_running_error() {
    let mut mcp = Mcp::spawn();
    let resp = mcp.rpc(
        1,
        "tools/call",
        json!({ "name": "list_pages", "arguments": {} }),
    );
    assert_eq!(resp["result"]["isError"], json!(true));
    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("Firefox"), "unexpected error text: {text}");
}

#[test]
fn tools_call_with_an_unknown_tool_name_is_an_error_without_a_socket_either() {
    let mut mcp = Mcp::spawn();
    let resp = mcp.rpc(
        1,
        "tools/call",
        json!({ "name": "delete_everything", "arguments": {} }),
    );
    assert_eq!(resp["result"]["isError"], json!(true));
    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    assert!(
        text.contains("Unknown tool"),
        "unexpected error text: {text}"
    );
}

// =============================================================================
// A fake `agent.sock` server standing in for `harbor-bridge`'s relay
// =============================================================================

/// A minimal fake of `agent_tabs.rs`'s socket protocol: accepts one
/// connection, answers every request line it reads with
/// `{"id": <same id>, "result": <fixed result>}`, using whatever `result`
/// the test configured for that `op` (or a generic default).
struct FakeAgentSock {
    socket_path: PathBuf,
    accept_thread: Option<std::thread::JoinHandle<()>>,
}

impl FakeAgentSock {
    fn start(home: &std::path::Path, result_for_op: Value) -> Self {
        let harbor_dir = home.join(".harbor");
        std::fs::create_dir_all(&harbor_dir).unwrap();
        let socket_path = harbor_dir.join("agent.sock");
        let _ = std::fs::remove_file(&socket_path);
        let listener = UnixListener::bind(&socket_path).expect("bind fake agent.sock");

        let accept_thread = std::thread::spawn(move || {
            let Ok((stream, _)) = listener.accept() else {
                return;
            };
            handle_one_connection(stream, result_for_op);
        });

        FakeAgentSock {
            socket_path,
            accept_thread: Some(accept_thread),
        }
    }
}

fn handle_one_connection(stream: UnixStream, result: Value) {
    let mut reader = BufReader::new(stream.try_clone().expect("clone fake socket"));
    let mut writer = stream;
    loop {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let req: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let id = req["id"].clone();
        let response = json!({ "id": id, "result": result });
        let mut out = serde_json::to_vec(&response).unwrap();
        out.push(b'\n');
        if writer.write_all(&out).is_err() {
            break;
        }
    }
}

impl Drop for FakeAgentSock {
    fn drop(&mut self) {
        if let Some(t) = self.accept_thread.take() {
            // The accept thread exits on its own once the connection closes
            // or is never made; give it a moment but don't block forever on
            // a test machine under load.
            let _ = t.join();
        }
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

#[test]
fn tools_call_relays_through_a_fake_socket_and_returns_its_result() {
    let home = unique_dir("h150fh");
    let fixed_result = json!({ "content": [{ "type": "text", "text": "it worked" }] });
    let _fake = FakeAgentSock::start(&home, fixed_result.clone());

    let mut mcp = Mcp::spawn_in(home);
    let resp = mcp.rpc(
        1,
        "tools/call",
        json!({ "name": "list_pages", "arguments": { "x": 1 } }),
    );
    assert_eq!(resp["result"], fixed_result);
}

#[test]
fn tools_call_relay_reports_the_requested_op_and_arguments() {
    // A fake server that echoes the request it received back as the
    // result's text, so this test can check what actually crossed the
    // socket (op and params), not just that *something* came back.
    let home = unique_dir("h150eh");
    let harbor_dir = home.join(".harbor");
    std::fs::create_dir_all(&harbor_dir).unwrap();
    let socket_path = harbor_dir.join("agent.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let thread = std::thread::spawn(move || {
        let Ok((stream, _)) = listener.accept() else {
            return;
        };
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut writer = stream;
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        let req: Value = serde_json::from_str(line.trim()).unwrap();
        let echoed = json!({
            "content": [{ "type": "text", "text": "echo" }],
            "structuredContent": { "op": req["op"], "params": req["params"], "agentId": req["agentId"], "agentName": req["agentName"] },
        });
        let response = json!({ "id": req["id"], "result": echoed });
        let mut out = serde_json::to_vec(&response).unwrap();
        out.push(b'\n');
        writer.write_all(&out).unwrap();
    });

    let mut mcp = Mcp::spawn_in(home);
    let resp = mcp.rpc(
        1,
        "tools/call",
        json!({ "name": "call_page_tool", "arguments": { "page": "p1", "tool": "pause", "input": {} } }),
    );
    thread.join().unwrap();

    assert_eq!(
        resp["result"]["structuredContent"]["op"],
        json!("call_page_tool")
    );
    assert_eq!(
        resp["result"]["structuredContent"]["params"],
        json!({ "page": "p1", "tool": "pause", "input": {} })
    );
    assert!(!resp["result"]["structuredContent"]["agentId"]
        .as_str()
        .unwrap()
        .is_empty());
    assert_eq!(
        resp["result"]["structuredContent"]["agentName"],
        json!("agent")
    );
    let _ = std::fs::remove_file(&socket_path);
}

#[test]
fn a_dropped_connection_mid_call_is_reported_as_not_running() {
    // A fake server that accepts and then closes without ever answering.
    let home = unique_dir("h150dh");
    let harbor_dir = home.join(".harbor");
    std::fs::create_dir_all(&harbor_dir).unwrap();
    let socket_path = harbor_dir.join("agent.sock");
    let listener = UnixListener::bind(&socket_path).unwrap();
    let thread = std::thread::spawn(move || {
        if let Ok((stream, _)) = listener.accept() {
            drop(stream);
        }
    });

    let mut mcp = Mcp::spawn_in(home);
    let resp = mcp.rpc(
        1,
        "tools/call",
        json!({ "name": "list_pages", "arguments": {} }),
    );
    thread.join().unwrap();

    assert_eq!(resp["result"]["isError"], json!(true));
    let text = resp["result"]["content"][0]["text"].as_str().unwrap();
    assert!(text.contains("Firefox"), "unexpected error text: {text}");
    let _ = std::fs::remove_file(&socket_path);
}
