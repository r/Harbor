//! End-to-end tests for the ACP relay, driving the real `harbor-bridge`
//! binary over native-messaging framing exactly as the extension would.
//!
//! These exist because the bugs they guard against only show up in the real
//! dispatch path: the native messaging read loop's stdin-EOF handling,
//! concurrently-spawned message handlers racing for an agent's stdin, and
//! the process *tree* a real agent wrapper (e.g. `npx` -> `node`) creates. A
//! unit test that calls `acp::open_stream_with_config` directly in-process
//! can't observe any of that - only a real subprocess exercising
//! `native_messaging.rs`'s actual loop can. Pure, no-process logic (config
//! parsing, the `list_agents`
//! transform, the `acp.*`-over-HTTP rejection) stays unit-tested in
//! `src/acp/` and `src/http_server.rs`.
//!
//! Each test spawns its own `harbor-bridge --native-messaging` subprocess
//! with a private `$HOME`, so tests are fully isolated from each other (no
//! shared global state to coordinate, unlike calling the relay in-process).

use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc as std_mpsc;
use std::time::{Duration, Instant};

const BRIDGE_BIN: &str = env!("CARGO_BIN_EXE_harbor-bridge");
const FAKE_AGENT_BIN: &str = env!("CARGO_BIN_EXE_acp_fake_agent");

/// Mirrors `acp::MAX_LIVE_AGENTS` in `src/acp/mod.rs`. Integration tests
/// can't `use` that constant (this crate has no `[lib]` target for `tests/`
/// to link against), so it's restated here; keep the two in sync.
const MAX_LIVE_AGENTS: usize = 8;

/// A plausible `workspace` (site origin) for tests that don't care which
/// one they get, just that `acp.open` accepts something valid.
const WORKSPACE: &str = "https://example.com";

/// Lowercase hex SHA-256 of `workspace`, mirroring `acp::workspace_hash` in
/// `src/acp/mod.rs` (see the `MAX_LIVE_AGENTS` comment above for why this
/// crate restates rather than `use`s bridge internals). `sha2` is already a
/// direct dependency of `harbor-bridge` (see `src/oauth/flow.rs`), so this
/// doesn't add one just for the test.
fn workspace_hash(workspace: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(workspace.as_bytes());
    hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

// =============================================================================
// Native messaging framing (mirrors native_messaging.rs's read/write_message)
// =============================================================================

fn read_frame<R: Read>(r: &mut R) -> io::Result<Option<Value>> {
    let mut len_bytes = [0u8; 4];
    match r.read_exact(&mut len_bytes) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_le_bytes(len_bytes) as usize;
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    let value: Value = serde_json::from_slice(&buf)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    Ok(Some(value))
}

fn write_frame(stdin: &mut ChildStdin, value: &Value) {
    let bytes = serde_json::to_vec(value).expect("frame must serialize");
    let len = (bytes.len() as u32).to_le_bytes();
    stdin.write_all(&len).expect("write frame length");
    stdin.write_all(&bytes).expect("write frame body");
    stdin.flush().expect("flush frame");
}

// =============================================================================
// Test harness: a running bridge subprocess, speaking native messaging
// =============================================================================

fn unique_dir(prefix: &str) -> PathBuf {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap();
    let dir = std::env::temp_dir().join(format!("{}-{:x}-{}", prefix, now.as_nanos(), n));
    std::fs::create_dir_all(&dir).expect("create temp home dir");
    dir
}

/// `dirs::config_dir()`'s result under a given `$HOME`, covering both the
/// macOS path (this ticket's dev platform) and the Linux XDG fallback, so
/// this file doesn't silently pass with an empty agent list on either.
fn config_dir_candidates(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join("Library").join("Application Support"),
        home.join(".config"),
    ]
}

fn write_acp_config(home: &Path, agents: Value) {
    for base in config_dir_candidates(home) {
        let dir = base.join("harbor");
        std::fs::create_dir_all(&dir).expect("create harbor config dir");
        std::fs::write(
            dir.join("acp.json"),
            serde_json::to_string(&json!({ "agents": agents })).unwrap(),
        )
        .expect("write acp.json");
    }
}

fn fake_agent(id: &str) -> Value {
    json!({ "id": id, "name": id, "command": FAKE_AGENT_BIN, "args": [], "env": {} })
}

/// A full `acp.save_agents`-shaped agent, with every field an actual value
/// (not relying on `args`/`env` defaults), for tests of
/// `acp.get_agents`/`acp.save_agents`.
fn full_agent(id: &str, name: &str, command: &str, args: Vec<&str>, env: Vec<(&str, &str)>) -> Value {
    json!({
        "id": id,
        "name": name,
        "command": command,
        "args": args,
        "env": env.into_iter().collect::<std::collections::HashMap<_, _>>(),
    })
}

/// The real, host-OS-specific `dirs::config_dir()/harbor` under `home` -
/// the one of `config_dir_candidates`'s two paths the running bridge
/// process actually reads/writes on this platform (both are populated by
/// `write_acp_config` so `AcpConfig::load` finds agents regardless of
/// which OS runs the test, but only one is live for save/atomicity
/// assertions).
fn real_config_dir(home: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        home.join("Library").join("Application Support").join("harbor")
    } else {
        home.join(".config").join("harbor")
    }
}

fn is_rpc_response(m: &Value, id: &str) -> bool {
    m["type"] == "rpc_response" && m["id"] == json!(id)
}

fn is_stream_event(m: &Value, id: &str, event_type: &str) -> bool {
    m["type"] == "stream" && m["id"] == json!(id) && m["event"]["type"] == event_type
}

fn is_any_stream(m: &Value, id: &str) -> bool {
    m["type"] == "stream" && m["id"] == json!(id)
}

/// `kill -0 <pid>`: true if a process with this pid exists (and is ours or
/// otherwise signalable), regardless of what it's doing. Used to check
/// liveness of agent grandchildren from outside the bridge.
fn process_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null()) // expected to print "No such process" once it's dead
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

struct Bridge {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: std_mpsc::Receiver<Value>,
    /// Frames already read off `rx` that didn't match an earlier
    /// `wait_for`'s predicate. Must not be discarded: e.g. an `exit` stream
    /// event can arrive interleaved with (or even before, depending on
    /// scheduling) the `rpc_response` for the `acp.close` that caused it,
    /// and a later `wait_for` call still needs to be able to see it.
    buffer: std::collections::VecDeque<Value>,
    _home: PathBuf,
}

impl Bridge {
    fn spawn(agents: Value) -> Self {
        Self::spawn_with_env(agents, &[])
    }

    /// `spawn`, with extra variables set in the bridge's own environment
    /// (on top of what the test process inherited).
    fn spawn_with_env(agents: Value, bridge_env: &[(&str, &str)]) -> Self {
        let home = unique_dir("hbr80-home");
        write_acp_config(&home, agents);

        let mut child = Command::new(BRIDGE_BIN)
            .arg("--native-messaging")
            .envs(bridge_env.iter().copied())
            .env("HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("failed to spawn harbor-bridge");

        let stdin = child.stdin.take().expect("bridge stdin");
        let mut stdout: ChildStdout = child.stdout.take().expect("bridge stdout");

        let (tx, rx) = std_mpsc::channel();
        std::thread::spawn(move || loop {
            match read_frame(&mut stdout) {
                Ok(Some(v)) => {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
                Ok(None) | Err(_) => break,
            }
        });

        let mut bridge = Bridge {
            child,
            stdin: Some(stdin),
            rx,
            buffer: std::collections::VecDeque::new(),
            _home: home,
        };
        bridge.expect_ready();
        bridge
    }

    fn send(&mut self, value: Value) {
        write_frame(self.stdin.as_mut().expect("stdin already closed"), &value);
    }

    fn wait_for<F: Fn(&Value) -> bool>(&mut self, pred: F, timeout: Duration) -> Option<Value> {
        // Anything buffered from an earlier call that wasn't a match for
        // that call's predicate might match this one.
        if let Some(pos) = self.buffer.iter().position(|m| pred(m)) {
            return self.buffer.remove(pos);
        }
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            match self.rx.recv_timeout(remaining) {
                Ok(v) => {
                    if pred(&v) {
                        return Some(v);
                    }
                    self.buffer.push_back(v);
                }
                Err(_) => return None,
            }
        }
    }

    fn expect_ready(&mut self) {
        let ready = self.wait_for(|m| m["status"] == "ready", Duration::from_secs(5));
        assert!(ready.is_some(), "bridge never reported ready");
    }

    /// Sends `acp.open` with an explicit `params` object and waits for the
    /// first stream event (`"open"` or a fatal `"error"`) on `req_id`. Used
    /// directly only by tests exercising `workspace` validation; everything
    /// else goes through `open_raw`/`open`.
    fn open_raw_params(&mut self, req_id: &str, params: Value) -> Value {
        self.send(json!({
            "type": "rpc", "id": req_id, "method": "acp.open", "params": params,
        }));
        self.wait_for(|m| is_any_stream(m, req_id), Duration::from_secs(5))
            .unwrap_or_else(|| panic!("no stream event for acp.open (id {})", req_id))
    }

    /// Sends `acp.open` and waits for the first stream event (`"open"` or a
    /// fatal `"error"`) on `req_id`.
    fn open_raw(&mut self, agent_id: &str, workspace: &str, req_id: &str) -> Value {
        self.open_raw_params(req_id, json!({ "agentId": agent_id, "workspace": workspace }))
    }

    /// `open_raw`, asserting success, returning the channel id.
    fn open(&mut self, agent_id: &str, workspace: &str, req_id: &str) -> String {
        let (channel, _cwd) = self.open_with_cwd(agent_id, workspace, req_id);
        channel
    }

    /// `open_raw`, asserting success, returning the channel id and the
    /// `cwd` the bridge reported for it.
    fn open_with_cwd(&mut self, agent_id: &str, workspace: &str, req_id: &str) -> (String, String) {
        let event = self.open_raw(agent_id, workspace, req_id);
        assert_eq!(event["event"]["type"], "open", "unexpected open event: {:?}", event);
        let channel = event["event"]["channel"].as_str().unwrap().to_string();
        let cwd = event["event"]["cwd"].as_str().unwrap().to_string();
        (channel, cwd)
    }

    /// Sends a plain (non-streaming) RPC and waits for its `rpc_response`.
    fn rpc(&mut self, id: &str, method: &str, params: Value) -> Value {
        self.send(json!({ "type": "rpc", "id": id, "method": method, "params": params }));
        self.wait_for(|m| is_rpc_response(m, id), Duration::from_secs(5))
            .unwrap_or_else(|| panic!("no rpc_response for {} (id {})", method, id))
    }

    fn close(&mut self, channel: &str) -> Value {
        self.rpc("close", "acp.close", json!({ "channel": channel }))
    }

    /// Drops the write half of the bridge's stdin, simulating the extension
    /// disconnecting (or the OS tearing down the native messaging pipe).
    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    fn wait_exit(&mut self, timeout: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Ok(Some(status)) = self.child.try_wait() {
                return Some(status);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn shutdown(&mut self) {
        self.send(json!({ "type": "shutdown" }));
        let status = self.wait_exit(Duration::from_secs(5));
        assert!(status.is_some(), "bridge did not exit after an explicit shutdown");
    }
}

impl Drop for Bridge {
    fn drop(&mut self) {
        // Best-effort graceful cleanup first (this is what actually kills
        // any agents the bridge still has open, via `acp::shutdown_all`),
        // then fall back to force-killing the bridge itself so a failing
        // assertion never leaks a process.
        self.stdin.take();
        if self.wait_exit(Duration::from_secs(2)).is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

// =============================================================================
// Tests
// =============================================================================

#[test]
fn list_agents_over_native_messaging_hides_commands() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let resp = bridge.rpc("L", "acp.list_agents", json!({}));
    assert_eq!(
        resp["result"]["agents"],
        json!([{ "id": "fake", "name": "fake" }])
    );
    let raw = serde_json::to_string(&resp).unwrap();
    assert!(!raw.contains("command"), "command path must never reach the extension");
    bridge.shutdown();
}

#[test]
fn open_rejects_unknown_and_missing_agent_id() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));

    let unknown = bridge.open_raw("nope", WORKSPACE, "O1");
    assert_eq!(unknown["event"]["type"], "error");
    assert_eq!(unknown["event"]["fatal"], true);

    bridge.send(json!({ "type": "rpc", "id": "O2", "method": "acp.open", "params": {} }));
    let missing = bridge
        .wait_for(|m| is_any_stream(m, "O2"), Duration::from_secs(5))
        .expect("stream event for missing agentId");
    assert_eq!(missing["event"]["type"], "error");
    assert_eq!(missing["event"]["fatal"], true);

    bridge.shutdown();
}

#[test]
fn open_and_relay_both_directions() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", WORKSPACE, "O1");

    let send_resp = bridge.rpc("S1", "acp.send", json!({ "channel": channel, "message": { "hello": "world" } }));
    assert_eq!(send_resp["result"]["ok"], true);

    let echoed = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(5))
        .expect("echoed message event");
    assert_eq!(echoed["event"]["message"], json!({ "hello": "world" }));

    let close_resp = bridge.close(&channel);
    assert_eq!(close_resp["result"]["ok"], true);
    let exit = bridge
        .wait_for(|m| is_stream_event(m, "O1", "exit"), Duration::from_secs(5))
        .expect("exit event after close");
    assert!(exit["event"]["code"].is_number() || exit["event"]["code"].is_null());

    bridge.shutdown();
}

#[test]
fn non_json_stdout_is_dropped_not_forwarded() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", WORKSPACE, "O1");

    bridge.rpc("S0", "acp.send", json!({ "channel": channel, "message": { "__test_cmd": "garbage" } }));
    bridge.rpc("S1", "acp.send", json!({ "channel": channel, "message": { "marker": "after-garbage" } }));

    let event = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(5))
        .expect("message event");
    assert_eq!(event["event"]["message"], json!({ "marker": "after-garbage" }));

    bridge.close(&channel);
    bridge.shutdown();
}

/// An agent writing an invalid UTF-8 line to stdout used to break the whole
/// read loop (the line read errored, the task broke, `reap()` removed the
/// channel while the process was still alive, and no exit event - or
/// further relay - ever happened).
#[test]
fn invalid_utf8_stdout_is_dropped_and_relay_continues() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", WORKSPACE, "O1");

    bridge.rpc("S0", "acp.send", json!({ "channel": channel, "message": { "__test_cmd": "badutf8" } }));
    let after = bridge.rpc("S1", "acp.send", json!({ "channel": channel, "message": { "after": "bad" } }));
    assert_eq!(after["result"]["ok"], true, "send after a bad-UTF-8 line must still succeed");

    let event = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(5))
        .expect("message event after invalid UTF-8 line");
    assert_eq!(event["event"]["message"], json!({ "after": "bad" }));

    let close_resp = bridge.close(&channel);
    assert_eq!(close_resp["result"]["ok"], true, "channel must still be known after a bad-UTF-8 line");
    assert!(bridge
        .wait_for(|m| is_stream_event(m, "O1", "exit"), Duration::from_secs(5))
        .is_some());

    bridge.shutdown();
}

/// Invalid UTF-8 or a flood of stderr output used to stop the stderr drain,
/// which then leaves the agent blocked (or killed by EPIPE) writing to a
/// closed pipe.
#[test]
fn invalid_utf8_and_flooding_stderr_does_not_break_the_relay() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", WORKSPACE, "O1");

    bridge.rpc("S0", "acp.send", json!({ "channel": channel, "message": { "__test_cmd": "stderrbad" } }));
    let flood_resp = bridge.rpc("S1", "acp.send", json!({ "channel": channel, "message": { "__test_cmd": "stderrflood" } }));
    assert_eq!(flood_resp["result"]["ok"], true);

    let event = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(10))
        .expect("flood-done marker after stderr flood");
    assert_eq!(event["event"]["message"], json!({ "flood": "done" }));

    bridge.close(&channel);
    bridge.shutdown();
}

#[test]
fn oversized_stdout_line_is_dropped_with_error_event() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", WORKSPACE, "O1");

    bridge.rpc(
        "B",
        "acp.send",
        json!({ "channel": channel, "message": { "__test_cmd": "big", "size": 900 * 1024 + 1024 } }),
    );
    bridge.rpc("S1", "acp.send", json!({ "channel": channel, "message": { "marker": "after-big" } }));

    let error_event = bridge
        .wait_for(|m| is_stream_event(m, "O1", "error"), Duration::from_secs(5))
        .expect("error event for oversized line");
    assert!(!error_event["event"]["fatal"].as_bool().unwrap_or(false));

    let message_event = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(5))
        .expect("relay continues after the oversized line");
    assert_eq!(message_event["event"]["message"], json!({ "marker": "after-big" }));

    // The frame actually written to stdout must still respect native
    // messaging's 1 MB host-to-browser cap.
    let raw = serde_json::to_vec(&error_event).unwrap();
    assert!(raw.len() <= 1024 * 1024);

    bridge.close(&channel);
    bridge.shutdown();
}

/// Concurrent `acp.send` calls used to be dispatched via `tokio::spawn`, so
/// they raced for the stdin lock and could reach the agent out of order.
#[test]
fn acp_send_preserves_fifo_order() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", WORKSPACE, "O1");

    const N: u64 = 200;
    for i in 0..N {
        bridge.send(json!({
            "type": "rpc", "id": format!("S{}", i), "method": "acp.send",
            "params": { "channel": channel, "message": { "seq": i } },
        }));
    }

    let mut got = Vec::with_capacity(N as usize);
    for _ in 0..N {
        let m = bridge
            .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(10))
            .expect("echoed message event");
        got.push(m["event"]["message"]["seq"].as_u64().unwrap());
    }
    let expected: Vec<u64> = (0..N).collect();
    assert_eq!(got, expected, "acp.send must preserve arrival order end to end");

    bridge.close(&channel);
    bridge.shutdown();
}

#[test]
fn close_kills_the_process() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", WORKSPACE, "O1");

    let close_resp = bridge.close(&channel);
    assert_eq!(close_resp["result"]["ok"], true);
    assert!(bridge
        .wait_for(|m| is_stream_event(m, "O1", "exit"), Duration::from_secs(5))
        .is_some());

    // Channel is gone: a second close is rejected as unknown.
    let second = bridge.rpc("close2", "acp.close", json!({ "channel": channel }));
    assert_eq!(second["error"]["code"], -32602);

    bridge.shutdown();
}

/// A real agent is often launched through a wrapper (e.g. `npx` -> `node`);
/// killing only the direct child leaves descendants alive, holding the
/// stdout pipe open forever, so no exit event ever arrives.
#[test]
fn close_kills_the_whole_process_group_including_grandchildren() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", WORKSPACE, "O1");

    bridge.rpc("S", "acp.send", json!({ "channel": channel, "message": { "__test_cmd": "spawn_grandchild" } }));
    let spawned = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(5))
        .expect("grandchild-spawn echo");
    let grandchild_pid = spawned["event"]["message"]["grandchild_pid"].as_u64().unwrap() as u32;
    assert!(process_alive(grandchild_pid), "grandchild should be alive before close");

    bridge.close(&channel);
    let exit = bridge.wait_for(|m| is_stream_event(m, "O1", "exit"), Duration::from_secs(5));
    assert!(
        exit.is_some(),
        "exit event must arrive even though a grandchild still held stdout open"
    );

    // Give the group signal a brief moment to land, then confirm the
    // grandchild (not just the direct child) is actually gone.
    let deadline = Instant::now() + Duration::from_secs(3);
    while process_alive(grandchild_pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!process_alive(grandchild_pid), "grandchild must be killed along with its parent");

    bridge.shutdown();
}

/// Stdin EOF used to never reach `else => break` in the select loop (one
/// branch was permanently disabled on mismatch, the other never resolved),
/// so the bridge hung forever and needed an external SIGTERM.
#[test]
fn disconnect_terminates_the_bridge_without_external_signal() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let _channel = bridge.open("fake", WORKSPACE, "O1");

    bridge.close_stdin();
    let status = bridge.wait_exit(Duration::from_secs(5));
    assert!(
        status.is_some(),
        "bridge must exit on its own after stdin EOF, without needing SIGTERM"
    );
}

#[test]
fn opening_beyond_the_cap_is_rejected() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));

    let mut channels = Vec::new();
    for i in 0..MAX_LIVE_AGENTS {
        channels.push(bridge.open("fake", WORKSPACE, &format!("O{}", i)));
    }

    let rejected = bridge.open_raw("fake", WORKSPACE, "Ocap");
    assert_eq!(rejected["event"]["type"], "error");
    assert_eq!(rejected["event"]["fatal"], true);
    // A machine-readable code, not just the human-readable message: the
    // extension maps this to ERR_AGENT_BUSY without pattern-matching text.
    assert_eq!(rejected["event"]["code"], "agent_cap");

    bridge.shutdown();
}

/// The cap can also be hit by the second, atomic re-check after the process
/// has already spawned (two concurrent opens racing the first, read-only
/// check) — `kill`s the process it just started and reports the same coded
/// fatal error as the early, pre-spawn rejection above.
#[test]
fn opening_beyond_the_cap_on_the_atomic_recheck_is_coded_too() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));

    let mut channels = Vec::new();
    for i in 0..MAX_LIVE_AGENTS {
        channels.push(bridge.open("fake", WORKSPACE, &format!("O{}", i)));
    }

    // Two opens past the cap in flight at once both reach the atomic
    // recheck path; either can win the read-only pre-check race, but both
    // still ultimately get the coded fatal error.
    let first_id = "OcapA";
    let second_id = "OcapB";
    bridge.send(json!({
        "type": "rpc", "id": first_id, "method": "acp.open",
        "params": { "agentId": "fake", "workspace": WORKSPACE },
    }));
    bridge.send(json!({
        "type": "rpc", "id": second_id, "method": "acp.open",
        "params": { "agentId": "fake", "workspace": WORKSPACE },
    }));

    for id in [first_id, second_id] {
        let rejected = bridge
            .wait_for(|m| is_stream_event(m, id, "error"), Duration::from_secs(5))
            .unwrap_or_else(|| panic!("no error event for {id}"));
        assert_eq!(rejected["event"]["fatal"], true);
        assert_eq!(rejected["event"]["code"], "agent_cap");
    }

    bridge.shutdown();
}

#[test]
fn send_validation_errors() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", WORKSPACE, "O1");

    let non_object = bridge.rpc("V0", "acp.send", json!({ "channel": channel, "message": "not-an-object" }));
    assert_eq!(non_object["error"]["code"], -32602);

    let huge = "x".repeat(4 * 1024 * 1024 + 1024);
    let oversized = bridge.rpc("V1", "acp.send", json!({ "channel": channel, "message": { "data": huge } }));
    assert_eq!(oversized["error"]["code"], -32602);

    let unknown_channel = bridge.rpc("V2", "acp.send", json!({ "channel": "does-not-exist", "message": {} }));
    assert_eq!(unknown_channel["error"]["code"], -32602);

    let missing_message = bridge.rpc("V3", "acp.send", json!({ "channel": channel }));
    assert_eq!(missing_message["error"]["code"], -32602);

    bridge.close(&channel);
    bridge.shutdown();
}

/// `acp.send` used to enqueue onto the channel's stdin queue with an
/// *awaited* `send`, inline in the single native-messaging read loop. An
/// agent that stops draining its stdin fills that queue and never frees a
/// slot, so that await never resolves - stalling the entire loop: pings,
/// other channels, and the very acp.close that could kill the stuck agent
/// all go unanswered, forever.
#[test]
fn acp_send_rejects_when_queue_is_full_without_blocking_the_bridge() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let ch1 = bridge.open("fake", WORKSPACE, "O1");
    let ch2 = bridge.open("fake", WORKSPACE, "O2");

    let stop_resp = bridge.rpc("STOP", "acp.send", json!({ "channel": ch1, "message": { "__test_cmd": "stopreading" } }));
    assert_eq!(stop_resp["result"]["ok"], true);
    let stopped = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(5))
        .expect("stopped ack");
    assert_eq!(stopped["event"]["message"], json!({ "stopped": true }));

    // Each message is well under the per-message size limit, so only the
    // queue being full - never any other validation - can explain a
    // rejection here.
    let pad = "y".repeat(20_000);
    let mut rejected = None;
    for i in 0..400u32 {
        let resp = bridge.rpc(
            &format!("F{}", i),
            "acp.send",
            json!({ "channel": ch1, "message": { "i": i, "pad": pad } }),
        );
        if let Some(error) = resp.get("error") {
            assert_eq!(error["code"], -32602);
            assert!(error["message"].as_str().unwrap().contains("queue full"));
            rejected = Some(i);
            break;
        }
    }
    assert!(
        rejected.is_some(),
        "flooding a channel whose agent never reads stdin must eventually be rejected"
    );

    // The actual regression: the bridge (and every other channel) must
    // stay responsive while that one channel is backed up.
    bridge.send(json!({ "type": "ping" }));
    assert!(
        bridge.wait_for(|m| m["status"] == "pong", Duration::from_secs(5)).is_some(),
        "ping must still answer while one channel's queue is full"
    );

    let other_send = bridge.rpc("S2", "acp.send", json!({ "channel": ch2, "message": { "other": "channel" } }));
    assert_eq!(other_send["result"]["ok"], true);
    assert!(
        bridge
            .wait_for(|m| is_stream_event(m, "O2", "message"), Duration::from_secs(5))
            .is_some(),
        "other channels must still relay while one channel's queue is full"
    );

    let close_resp = bridge.close(&ch1);
    assert_eq!(close_resp["result"]["ok"], true, "acp.close on the stuck channel must still answer");
    assert!(
        bridge
            .wait_for(|m| is_stream_event(m, "O1", "exit"), Duration::from_secs(5))
            .is_some(),
        "the stuck agent must actually be killed, not left running"
    );

    bridge.close(&ch2);
    bridge.shutdown();
}

/// An agent can spawn a background process and then exit normally on its
/// own, with no `acp.close` ever sent. That still has to kill everything
/// the agent's process group holds, not just reap the (already-exited)
/// direct child - otherwise a background process it started outlives it.
#[test]
fn natural_exit_kills_a_backgrounded_process_the_agent_spawned() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", WORKSPACE, "O1");

    let send_resp = bridge.rpc(
        "S",
        "acp.send",
        json!({ "channel": channel, "message": { "__test_cmd": "spawn_orphan_and_exit" } }),
    );
    assert_eq!(send_resp["result"]["ok"], true);

    let spawned = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(5))
        .expect("orphan-spawn echo");
    let orphan_pid = spawned["event"]["message"]["orphan_pid"].as_u64().unwrap() as u32;
    // Not asserted alive here: the agent exits immediately after sending
    // this message, and with the fix, reaping it can kill the orphan
    // before this test even gets to check - which is the point.

    // No acp.close here: the agent exits on its own.
    let exit = bridge
        .wait_for(|m| is_stream_event(m, "O1", "exit"), Duration::from_secs(5))
        .expect("exit event after the agent exits on its own");
    assert_eq!(exit["event"]["code"], 0);

    let deadline = Instant::now() + Duration::from_secs(3);
    while process_alive(orphan_pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
        !process_alive(orphan_pid),
        "a background process the agent started must die with it, even on a natural exit"
    );

    bridge.shutdown();
}

/// Mirrors `acp::INHERITED_ENV` in `src/acp/mod.rs`, for the same reason as
/// `MAX_LIVE_AGENTS` above; keep the two in sync. `LC_*` is matched by
/// prefix, as the bridge does.
const INHERITED_ENV: &[&str] = &[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "LANG",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
];

#[test]
fn agent_gets_only_allowlisted_env_plus_its_config_env() {
    let mut agent = fake_agent("fake");
    agent["env"] = json!({ "FROM_CONFIG": "yes", "LANG": "C" });

    // Variables only the bridge has: terminal/session identifiers, an API key
    // the user didn't put in acp.json, and an arbitrary one.
    let mut bridge = Bridge::spawn_with_env(
        json!([agent]),
        &[
            ("REX_SESSION", "session:leak"),
            ("TMUX", "/tmp/tmux-leak,1,0"),
            ("TERM_PROGRAM", "leak"),
            ("SSH_AUTH_SOCK", "/tmp/leak.sock"),
            ("XDG_RUNTIME_DIR", "/tmp/leak-runtime"),
            ("ANTHROPIC_API_KEY", "sk-leak"),
            ("HARBOR_TEST_BRIDGE_ONLY", "leak"),
            ("LANG", "en_US.UTF-8"),
            ("LC_CTYPE", "en_US.UTF-8"),
            ("TMPDIR", "/tmp/hbr100-tmpdir/"),
        ],
    );
    let channel = bridge.open("fake", WORKSPACE, "O1");
    bridge.rpc("S1", "acp.send", json!({ "channel": channel, "message": { "__test_cmd": "env" } }));
    let reply = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(5))
        .expect("env reply from the agent");
    let env = reply["event"]["message"]["env"]
        .as_object()
        .expect("agent reported its env")
        .clone();

    for key in env.keys() {
        let allowed = key == "FROM_CONFIG"
            || INHERITED_ENV.contains(&key.as_str())
            || key.starts_with("LC_");
        assert!(allowed, "agent saw {} = {:?}, which is not allowlisted", key, env[key]);
    }
    for leaked in [
        "REX_SESSION",
        "TMUX",
        "TERM_PROGRAM",
        "SSH_AUTH_SOCK",
        "XDG_RUNTIME_DIR",
        "ANTHROPIC_API_KEY",
        "HARBOR_TEST_BRIDGE_ONLY",
    ] {
        assert!(!env.contains_key(leaked), "{} reached the agent", leaked);
    }

    // Config env is added, and wins over an inherited value.
    assert_eq!(env["FROM_CONFIG"], "yes");
    assert_eq!(env["LANG"], "C");
    // Allowlisted variables still come through from the bridge.
    assert_eq!(env["HOME"], json!(bridge._home.to_string_lossy()));
    assert_eq!(env["LC_CTYPE"], "en_US.UTF-8");
    assert_eq!(env["TMPDIR"], "/tmp/hbr100-tmpdir/");
    assert!(env.contains_key("PATH"), "agent needs PATH");

    bridge.close(&channel);
    bridge.shutdown();
}

// =============================================================================
// Per-site workspace directories
// =============================================================================

#[test]
fn open_event_reports_cwd_under_the_workspace_hash() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let (channel, cwd) = bridge.open_with_cwd("fake", WORKSPACE, "O1");

    let expected = bridge
        ._home
        .join(".harbor")
        .join("acp")
        .join("workspaces")
        .join(workspace_hash(WORKSPACE))
        .canonicalize()
        .expect("workspace dir must exist after open");
    assert_eq!(Path::new(&cwd), expected, "cwd {} did not match the expected workspace dir", cwd);

    bridge.close(&channel);
    bridge.shutdown();
}

#[test]
fn fake_agent_actually_runs_in_the_reported_cwd() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let (channel, cwd) = bridge.open_with_cwd("fake", WORKSPACE, "O1");

    bridge.rpc("S1", "acp.send", json!({ "channel": channel, "message": { "__test_cmd": "cwd" } }));
    let reply = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(5))
        .expect("cwd reply from the agent");
    let agent_cwd = reply["event"]["message"]["cwd"].as_str().expect("agent reported its cwd");
    assert_eq!(agent_cwd, cwd, "agent's actual working directory must match the open event's cwd");

    bridge.close(&channel);
    bridge.shutdown();
}

#[test]
fn different_workspaces_get_different_dirs_same_workspace_is_stable() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));

    let (ch_a1, cwd_a1) = bridge.open_with_cwd("fake", "https://a.example", "O1");
    bridge.close(&ch_a1);
    bridge.wait_for(|m| is_stream_event(m, "O1", "exit"), Duration::from_secs(5));

    let (ch_b, cwd_b) = bridge.open_with_cwd("fake", "https://b.example", "O2");
    assert_ne!(cwd_a1, cwd_b, "different workspaces must get different working directories");
    bridge.close(&ch_b);
    bridge.wait_for(|m| is_stream_event(m, "O2", "exit"), Duration::from_secs(5));

    // Reopening the first workspace (a fresh agent process, same site) must
    // land in the same directory as before - it must persist, not be wiped.
    let (ch_a2, cwd_a2) = bridge.open_with_cwd("fake", "https://a.example", "O3");
    assert_eq!(cwd_a1, cwd_a2, "the same workspace must get the same directory across opens");

    bridge.close(&ch_a2);
    bridge.shutdown();
}

#[test]
fn malicious_workspace_strings_cannot_escape_the_workspaces_dir() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));

    let malicious = ["../../etc", "a/b", "evil\u{0}name", "../../../../../../root"];
    for (i, workspace) in malicious.iter().enumerate() {
        let req_id = format!("O{}", i);
        let (channel, cwd) = bridge.open_with_cwd("fake", workspace, &req_id);
        let cwd_path = PathBuf::from(&cwd);

        assert!(
            cwd_path.components().any(|c| c.as_os_str() == "workspaces"),
            "cwd {:?} for workspace {:?} must be inside a workspaces/ directory",
            cwd,
            workspace,
        );
        assert!(
            !cwd_path.components().any(|c| c.as_os_str() == ".."),
            "cwd {:?} for workspace {:?} must not contain a literal '..' component",
            cwd,
            workspace,
        );
        assert_eq!(
            cwd_path.file_name().and_then(|n| n.to_str()),
            Some(workspace_hash(workspace).as_str()),
            "cwd {:?} for workspace {:?} must be named after its hash, not the raw string",
            cwd,
            workspace,
        );

        bridge.close(&channel);
        bridge.wait_for(|m| is_stream_event(m, &req_id, "exit"), Duration::from_secs(5));
    }

    bridge.shutdown();
}

#[test]
fn open_rejects_missing_empty_or_oversized_workspace() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));

    let missing = bridge.open_raw_params("M1", json!({ "agentId": "fake" }));
    assert_eq!(missing["event"]["type"], "error");
    assert_eq!(missing["event"]["fatal"], true);

    let empty = bridge.open_raw_params("M2", json!({ "agentId": "fake", "workspace": "" }));
    assert_eq!(empty["event"]["type"], "error");
    assert_eq!(empty["event"]["fatal"], true);

    let huge = "x".repeat(2049);
    let oversized = bridge.open_raw_params("M3", json!({ "agentId": "fake", "workspace": huge }));
    assert_eq!(oversized["event"]["type"], "error");
    assert_eq!(oversized["event"]["fatal"], true);

    let not_a_string = bridge.open_raw_params("M4", json!({ "agentId": "fake", "workspace": 123 }));
    assert_eq!(not_a_string["event"]["type"], "error");
    assert_eq!(not_a_string["event"]["fatal"], true);

    bridge.shutdown();
}

// =============================================================================
// acp.get_agents / acp.save_agents
// =============================================================================

#[test]
fn get_agents_round_trips_save_agents() {
    let mut bridge = Bridge::spawn(json!([]));

    let agents = json!([
        full_agent("alpha", "Alpha", "alpha-cmd", vec!["--flag", "x"], vec![("FOO", "bar")]),
        full_agent("beta", "Beta", "beta-cmd", vec![], vec![]),
    ]);
    let save = bridge.rpc("S", "acp.save_agents", json!({ "agents": agents.clone() }));
    assert_eq!(save["result"]["ok"], true, "save_agents failed: {:?}", save);

    let got = bridge.rpc("G", "acp.get_agents", json!({}));
    assert_eq!(got["result"]["agents"], agents, "get_agents must round-trip save_agents");

    bridge.shutdown();
}

#[test]
fn save_agents_rejects_every_documented_validation_rule() {
    let mut bridge = Bridge::spawn(json!([]));

    let cases: Vec<(&str, Value, &str)> = vec![
        (
            "id_bad_chars",
            json!([{"id": "Bad_ID!", "name": "n", "command": "c", "args": [], "env": {}}]),
            ".id",
        ),
        (
            "id_too_long",
            json!([{"id": "a".repeat(33), "name": "n", "command": "c", "args": [], "env": {}}]),
            ".id",
        ),
        (
            "id_duplicate",
            json!([
                {"id": "dup", "name": "n", "command": "c", "args": [], "env": {}},
                {"id": "dup", "name": "n2", "command": "c2", "args": [], "env": {}},
            ]),
            ".id",
        ),
        (
            "name_empty",
            json!([{"id": "a1", "name": "", "command": "c", "args": [], "env": {}}]),
            ".name",
        ),
        (
            "name_too_long",
            json!([{"id": "a1", "name": "a".repeat(65), "command": "c", "args": [], "env": {}}]),
            ".name",
        ),
        (
            "command_empty",
            json!([{"id": "a1", "name": "n", "command": "", "args": [], "env": {}}]),
            ".command",
        ),
        (
            "command_too_long",
            json!([{"id": "a1", "name": "n", "command": "a".repeat(1025), "args": [], "env": {}}]),
            ".command",
        ),
        (
            "too_many_args",
            json!([{"id": "a1", "name": "n", "command": "c", "args": vec!["x"; 65], "env": {}}]),
            ".args",
        ),
        (
            "arg_too_long",
            json!([{"id": "a1", "name": "n", "command": "c", "args": ["a".repeat(4097)], "env": {}}]),
            ".args",
        ),
        (
            "too_many_env",
            json!([{
                "id": "a1", "name": "n", "command": "c", "args": [],
                "env": (0..65).map(|i| (format!("K{}", i), "v".to_string())).collect::<std::collections::HashMap<_, _>>(),
            }]),
            ".env",
        ),
        (
            "env_bad_key",
            json!([{"id": "a1", "name": "n", "command": "c", "args": [], "env": {"1BAD": "v"}}]),
            ".env",
        ),
        (
            "env_value_too_long",
            json!([{"id": "a1", "name": "n", "command": "c", "args": [], "env": {"K": "a".repeat(4097)}}]),
            ".env",
        ),
        (
            "too_many_agents",
            Value::Array(
                (0..33)
                    .map(|i| json!({"id": format!("a{}", i), "name": "n", "command": "c", "args": [], "env": {}}))
                    .collect(),
            ),
            "agents",
        ),
    ];

    for (label, agents, expected_substring) in cases {
        let resp = bridge.rpc(label, "acp.save_agents", json!({ "agents": agents }));
        let error = resp
            .get("error")
            .unwrap_or_else(|| panic!("case {} should be rejected, got {:?}", label, resp));
        assert_eq!(error["code"], -32602, "case {} wrong error code: {:?}", label, error);
        let message = error["message"].as_str().unwrap_or_default();
        assert!(
            message.contains(expected_substring),
            "case {}: expected message to contain {:?}, got {:?}",
            label,
            expected_substring,
            message
        );
    }

    bridge.shutdown();
}

#[test]
fn save_agents_writes_atomically_with_0600_and_no_leftover_tmp_file() {
    let mut bridge = Bridge::spawn(json!([]));

    let agents = json!([full_agent("solo", "Solo", "solo-cmd", vec![], vec![])]);
    let resp = bridge.rpc("S", "acp.save_agents", json!({ "agents": agents }));
    assert_eq!(resp["result"]["ok"], true, "save_agents failed: {:?}", resp);

    let dir = real_config_dir(&bridge._home);
    let acp_path = dir.join("acp.json");
    assert!(acp_path.exists(), "acp.json missing after save");

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&acp_path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "acp.json must be mode 0600");
    }

    let leftover: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name != "acp.json")
        .collect();
    assert!(leftover.is_empty(), "leftover files in config dir: {:?}", leftover);

    bridge.shutdown();
}

#[test]
fn open_uses_the_newly_saved_config() {
    let mut bridge = Bridge::spawn(json!([fake_agent("old")]));

    // The old id works before any save.
    let channel = bridge.open("old", WORKSPACE, "O0");
    bridge.close(&channel);
    bridge.wait_for(|m| is_stream_event(m, "O0", "exit"), Duration::from_secs(5));

    let save = bridge.rpc("S", "acp.save_agents", json!({ "agents": [fake_agent("new")] }));
    assert_eq!(save["result"]["ok"], true, "save_agents failed: {:?}", save);

    // A later open sees the new config: the new id now works...
    let channel = bridge.open("new", WORKSPACE, "O1");
    bridge.close(&channel);
    bridge.wait_for(|m| is_stream_event(m, "O1", "exit"), Duration::from_secs(5));

    // ... and the old id, no longer present after the full replace, doesn't.
    let gone = bridge.open_raw("old", WORKSPACE, "O2");
    assert_eq!(gone["event"]["type"], "error");
    assert_eq!(gone["event"]["fatal"], true);

    bridge.shutdown();
}

#[test]
fn save_agents_burst_lands_in_arrival_order_with_no_errors() {
    let mut bridge = Bridge::spawn(json!([]));

    // Fire every save before waiting on any response, so the bridge's
    // native-messaging read loop actually receives them back to back - the
    // shape that used to let the generic spawn-per-message dispatch run
    // many `acp::save_agents` calls concurrently, racing each other's
    // temp-file-then-rename sequence, with no guarantee the one that
    // finished last was the one sent last.
    const N: usize = 300;
    for i in 0..N {
        let id = format!("B{}", i);
        let agents = json!([{
            "id": "burst", "name": format!("n{}", i), "command": "c", "args": [], "env": {},
        }]);
        bridge.send(json!({
            "type": "rpc", "id": id, "method": "acp.save_agents", "params": { "agents": agents },
        }));
    }

    for i in 0..N {
        let id = format!("B{}", i);
        let resp = bridge
            .wait_for(|m| is_rpc_response(m, &id), Duration::from_secs(30))
            .unwrap_or_else(|| panic!("no rpc_response for save #{}", i));
        assert_eq!(resp["result"]["ok"], true, "save #{} failed: {:?}", i, resp);
    }

    let got = bridge.rpc("G", "acp.get_agents", json!({}));
    let expected = json!([{
        "id": "burst", "name": format!("n{}", N - 1), "command": "c", "args": [], "env": {},
    }]);
    assert_eq!(
        got["result"]["agents"], expected,
        "the file on disk must equal the last save actually sent, not merely the last one to finish"
    );

    let dir = real_config_dir(&bridge._home);
    let leftover: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|name| name != "acp.json")
        .collect();
    assert!(leftover.is_empty(), "leftover files after a save burst: {:?}", leftover);

    bridge.shutdown();
}

// =============================================================================
// acp.resolve_command
// =============================================================================

#[cfg(unix)]
fn write_executable(path: &Path, contents: &str) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, contents).expect("write executable");
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).expect("chmod");
}

#[test]
fn resolve_command_finds_a_tool_through_a_fake_login_shell() {
    let fake_bin_dir = unique_dir("hbr84-fakebin");
    let tool_name = "harbor-fake-tool";
    let tool_path = fake_bin_dir.join(tool_name);
    write_executable(&tool_path, "#!/bin/sh\necho hi\n");

    // A fake login shell, standing in for a real one customizing `PATH` via
    // a startup file (e.g. `.zprofile`) before running the given command -
    // which is exactly why `acp.resolve_command` uses a login shell rather
    // than the bridge's own `PATH`.
    let shell_dir = unique_dir("hbr84-fakeshell");
    let shell_path = shell_dir.join("login-shell.sh");
    write_executable(
        &shell_path,
        &format!(
            "#!/bin/sh\nexport PATH=\"{}:$PATH\"\nexec /bin/sh \"$@\"\n",
            fake_bin_dir.display()
        ),
    );

    let mut bridge = Bridge::spawn_with_env(json!([]), &[("SHELL", shell_path.to_str().unwrap())]);
    let resp = bridge.rpc("R", "acp.resolve_command", json!({ "name": tool_name }));
    assert_eq!(
        resp["result"]["path"],
        json!(tool_path.to_string_lossy()),
        "unexpected resolve_command result: {:?}",
        resp
    );

    bridge.shutdown();
}

/// Asserts `resp` is a genuine successful `{"path": null}` result, not
/// merely something that happens to index to `Null` - e.g. an
/// `-32601 Unknown method` error response has no `"result"` key at all, and
/// `resp["result"]["path"]` on that is *also* `Value::Null` (serde_json
/// indexes a missing key as `Null`), which would let a method that doesn't
/// exist pass for one that resolves to nothing.
fn assert_resolved_to_null(resp: &Value) {
    assert!(
        resp.get("error").is_none(),
        "expected a successful null result, got an error: {:?}",
        resp
    );
    assert_eq!(resp["result"]["path"], Value::Null, "unexpected result: {:?}", resp);
}

#[test]
fn resolve_command_returns_null_for_a_name_that_is_not_found() {
    let mut bridge = Bridge::spawn(json!([]));
    let resp = bridge.rpc(
        "R",
        "acp.resolve_command",
        json!({ "name": "harbor-definitely-not-a-real-command-xyz" }),
    );
    assert_resolved_to_null(&resp);
    bridge.shutdown();
}

#[test]
fn resolve_command_returns_null_for_a_name_with_a_slash() {
    let mut bridge = Bridge::spawn(json!([]));
    let resp = bridge.rpc("R", "acp.resolve_command", json!({ "name": "a/b" }));
    assert_resolved_to_null(&resp);
    bridge.shutdown();
}

/// Reads a single decimal pid, written by a fake shell script, after
/// waiting briefly for it to show up (the script writes it near the start
/// of its run, well before the bridge's 5s `resolve_command` deadline, but
/// give it a moment rather than assuming the write already landed).
fn read_pid_file(path: &Path) -> u32 {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Ok(contents) = std::fs::read_to_string(path) {
            if let Ok(pid) = contents.trim().parse::<u32>() {
                return pid;
            }
        }
        if Instant::now() >= deadline {
            panic!("pid file {:?} never appeared with a valid pid", path);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn resolve_command_returns_null_on_a_shell_timeout_and_kills_the_backgrounded_job() {
    let shell_dir = unique_dir("hbr84-sleepyshell");
    let pid_file = shell_dir.join("child.pid");
    let shell_path = shell_dir.join("sleepy-shell.sh");
    // The shell itself never answers (so the bridge must give up on its
    // own timeout), and it backgrounds a child before blocking - the same
    // shape as a `.zprofile` line left running, so killing only the direct
    // child (the old behavior) would leave this orphaned and still running
    // long after the bridge gave up on it.
    write_executable(
        &shell_path,
        &format!("#!/bin/sh\nsleep 30 &\necho $! > {}\nwait\n", pid_file.display()),
    );

    let mut bridge = Bridge::spawn_with_env(json!([]), &[("SHELL", shell_path.to_str().unwrap())]);
    let start = Instant::now();
    bridge.send(json!({ "type": "rpc", "id": "R", "method": "acp.resolve_command", "params": { "name": "sh" } }));
    let resp = bridge
        .wait_for(|m| is_rpc_response(m, "R"), Duration::from_secs(8))
        .expect("rpc_response for acp.resolve_command after a shell timeout");
    let elapsed = start.elapsed();

    assert_resolved_to_null(&resp);
    assert!(
        elapsed < Duration::from_secs(8),
        "resolve_command should give up well before the fake shell's 30s sleep, took {:?}",
        elapsed
    );

    let child_pid = read_pid_file(&pid_file);
    assert!(
        !process_alive(child_pid),
        "the backgrounded child (pid {}) must not survive a resolve_command timeout",
        child_pid
    );

    bridge.shutdown();
}

#[test]
fn resolve_command_still_resolves_past_a_backgrounded_holdover_job_and_cleans_it_up() {
    let fake_bin_dir = unique_dir("hbr84-holdover-bin");
    // A real, resolvable command, found through the shell's own `PATH`
    // rather than a bare absolute lookup, so this also exercises the
    // normal success path.
    let tool_name = "harbor-holdover-tool";
    let tool_path = fake_bin_dir.join(tool_name);
    write_executable(&tool_path, "#!/bin/sh\necho hi\n");

    let shell_dir = unique_dir("hbr84-holdovershell");
    let pid_file = shell_dir.join("child.pid");
    let shell_path = shell_dir.join("holdover-shell.sh");
    // Backgrounds a long-running job (standing in for a `.zprofile` line
    // ending in `&`) *before* running the real shell that actually answers
    // `command -v`. The background job inherits the write end of the
    // stdout pipe, so it alone would keep that pipe open - and itself
    // running - long after the real answer has already been printed and
    // the shell has exited.
    write_executable(
        &shell_path,
        &format!(
            "#!/bin/sh\nsleep 30 &\necho $! > {}\nexport PATH=\"{}:$PATH\"\nexec /bin/sh \"$@\"\n",
            pid_file.display(),
            fake_bin_dir.display()
        ),
    );

    let mut bridge = Bridge::spawn_with_env(json!([]), &[("SHELL", shell_path.to_str().unwrap())]);
    let start = Instant::now();
    let resp = bridge.rpc("R", "acp.resolve_command", json!({ "name": tool_name }));
    let elapsed = start.elapsed();

    assert!(resp.get("error").is_none(), "unexpected error: {:?}", resp);
    assert_eq!(
        resp["result"]["path"],
        json!(tool_path.to_string_lossy()),
        "a holdover job in the shell's startup must not turn a real resolution into null: {:?}",
        resp
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "resolving past a holdover job should not wait anywhere near the full deadline, took {:?}",
        elapsed
    );

    let child_pid = read_pid_file(&pid_file);
    assert!(
        !process_alive(child_pid),
        "the holdover job (pid {}) must not survive a successful resolve either",
        child_pid
    );

    bridge.shutdown();
}

#[test]
fn resolve_command_name_is_never_interpolated_into_the_shell_script() {
    let marker_dir = unique_dir("hbr84-pwned-marker");
    let marker_path = marker_dir.join("pwned");
    let malicious_name = format!("x;touch {}", marker_path.display());

    let mut bridge = Bridge::spawn(json!([]));
    let resp = bridge.rpc("R", "acp.resolve_command", json!({ "name": malicious_name }));
    assert_resolved_to_null(&resp);
    assert!(
        !marker_path.exists(),
        "the name must never be interpolated into a shell script"
    );

    bridge.shutdown();
}

#[test]
fn resolve_command_passes_the_name_as_a_separate_argv_entry_not_embedded_in_the_script() {
    // A fake login shell that doesn't try to resolve anything itself - it
    // just records its own argv (mirroring the real invocation: `-l -c
    // '<script>' _ <name>`) to a file, then forwards to a real shell so the
    // call still completes normally. If the name were ever formatted into
    // the `-c` script string instead of passed as a trailing argument
    // (`$1` inside that script), it would show up inside ARG3 here instead
    // of only in ARG5.
    let shell_dir = unique_dir("hbr84-argvshell");
    let argv_dump = shell_dir.join("argv.txt");
    let shell_path = shell_dir.join("argv-shell.sh");
    write_executable(
        &shell_path,
        &format!(
            "#!/bin/sh\nprintf 'ARG1=%s\\nARG2=%s\\nARG3=%s\\nARG4=%s\\nARG5=%s\\n' \"$1\" \"$2\" \"$3\" \"$4\" \"$5\" > {}\nexec /bin/sh \"$@\"\n",
            argv_dump.display()
        ),
    );

    let name = "harbor-argv-probe-tool";
    let mut bridge = Bridge::spawn_with_env(json!([]), &[("SHELL", shell_path.to_str().unwrap())]);
    let resp = bridge.rpc("R", "acp.resolve_command", json!({ "name": name }));
    // Not found (no such tool on PATH) is fine here - the point is what the
    // fake shell actually received, not whether it resolved to anything.
    assert!(resp.get("error").is_none(), "unexpected error: {:?}", resp);

    let dump = std::fs::read_to_string(&argv_dump).expect("argv dump must have been written");
    let line = |prefix: &str| -> String {
        dump.lines()
            .find(|l| l.starts_with(prefix))
            .unwrap_or_else(|| panic!("missing {} in argv dump: {:?}", prefix, dump))
            .to_string()
    };

    assert_eq!(line("ARG1="), "ARG1=-l");
    assert_eq!(line("ARG2="), "ARG2=-c");
    assert_eq!(line("ARG4="), "ARG4=_");
    assert_eq!(
        line("ARG5="),
        format!("ARG5={}", name),
        "the name must arrive as its own argv entry"
    );
    assert!(
        !line("ARG3=").contains(name),
        "the name must never be embedded inside the -c script string: {:?}",
        dump
    );

    bridge.shutdown();
}

/// Catches a validation bypass directly: `/bin/sh` is a real, existing,
/// executable path. If `valid_name`'s rejection of any name containing `/`
/// were ever skipped, `command -v -- "/bin/sh"` would genuinely print
/// `/bin/sh` back (POSIX `command -v` treats an operand containing `/` as
/// a literal path check, not a `PATH` search - verified directly against
/// the system shell, not assumed), so this must return `null` on its own,
/// not because the path happens not to exist.
#[test]
fn resolve_command_returns_null_for_a_real_existing_path_not_just_a_missing_one() {
    let mut bridge = Bridge::spawn(json!([]));
    let resp = bridge.rpc("R", "acp.resolve_command", json!({ "name": "/bin/sh" }));
    assert_resolved_to_null(&resp);
    bridge.shutdown();
}

#[test]
fn resolve_command_returns_null_when_the_shell_prints_a_relative_path() {
    let shell_dir = unique_dir("hbr84-relpathshell");
    let shell_path = shell_dir.join("relpath-shell.sh");
    // Never runs a real resolution - just prints something that looks like
    // a plausible `command -v` answer but isn't absolute.
    write_executable(&shell_path, "#!/bin/sh\necho bin/not-absolute\n");

    let mut bridge = Bridge::spawn_with_env(json!([]), &[("SHELL", shell_path.to_str().unwrap())]);
    let resp = bridge.rpc("R", "acp.resolve_command", json!({ "name": "anything" }));
    assert_resolved_to_null(&resp);
    bridge.shutdown();
}

#[test]
fn resolve_command_returns_null_when_the_shell_prints_a_non_executable_path() {
    let target_dir = unique_dir("hbr84-nonexec-target");
    let target_path = target_dir.join("just-a-data-file");
    std::fs::write(&target_path, b"not a program").expect("write data file");
    // Deliberately no execute bit, unlike `write_executable`.

    let shell_dir = unique_dir("hbr84-nonexecshell");
    let shell_path = shell_dir.join("nonexec-shell.sh");
    write_executable(
        &shell_path,
        &format!("#!/bin/sh\necho {}\n", target_path.display()),
    );

    let mut bridge = Bridge::spawn_with_env(json!([]), &[("SHELL", shell_path.to_str().unwrap())]);
    let resp = bridge.rpc("R", "acp.resolve_command", json!({ "name": "anything" }));
    assert_resolved_to_null(&resp);
    bridge.shutdown();
}
