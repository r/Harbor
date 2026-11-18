//! End-to-end tests for the ACP relay, driving the real `harbor-bridge`
//! binary over native-messaging framing exactly as the extension would.
//!
//! These exist because the bugs they guard against (found in HBR-80's
//! verification bounce) only show up in the real dispatch path: the native
//! messaging read loop's stdin-EOF handling, concurrently-spawned message
//! handlers racing for an agent's stdin, and the process *tree* a real
//! agent wrapper (e.g. `npx` -> `node`) creates. A unit test that calls
//! `acp::open_stream_with_config` directly in-process can't observe any of
//! that - only a real subprocess exercising `native_messaging.rs`'s actual
//! loop can. Pure, no-process logic (config parsing, the `list_agents`
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
        let home = unique_dir("hbr80-home");
        write_acp_config(&home, agents);

        let mut child = Command::new(BRIDGE_BIN)
            .arg("--native-messaging")
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

    /// Sends `acp.open` and waits for the first stream event (`"open"` or a
    /// fatal `"error"`) on `req_id`.
    fn open_raw(&mut self, agent_id: &str, req_id: &str) -> Value {
        self.send(json!({
            "type": "rpc", "id": req_id, "method": "acp.open",
            "params": { "agentId": agent_id },
        }));
        self.wait_for(|m| is_any_stream(m, req_id), Duration::from_secs(5))
            .unwrap_or_else(|| panic!("no stream event for acp.open (id {})", req_id))
    }

    /// `open_raw`, asserting success, returning the channel id.
    fn open(&mut self, agent_id: &str, req_id: &str) -> String {
        let event = self.open_raw(agent_id, req_id);
        assert_eq!(event["event"]["type"], "open", "unexpected open event: {:?}", event);
        event["event"]["channel"].as_str().unwrap().to_string()
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

    let unknown = bridge.open_raw("nope", "O1");
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
    let channel = bridge.open("fake", "O1");

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
    let channel = bridge.open("fake", "O1");

    bridge.rpc("S0", "acp.send", json!({ "channel": channel, "message": { "__test_cmd": "garbage" } }));
    bridge.rpc("S1", "acp.send", json!({ "channel": channel, "message": { "marker": "after-garbage" } }));

    let event = bridge
        .wait_for(|m| is_stream_event(m, "O1", "message"), Duration::from_secs(5))
        .expect("message event");
    assert_eq!(event["event"]["message"], json!({ "marker": "after-garbage" }));

    bridge.close(&channel);
    bridge.shutdown();
}

/// Regression test for HBR-80 bounce item 2: an agent writing an invalid
/// UTF-8 line to stdout used to break the whole read loop (the line read
/// errored, the task broke, `reap()` removed the channel while the process
/// was still alive, and no exit event - or further relay - ever happened).
#[test]
fn invalid_utf8_stdout_is_dropped_and_relay_continues() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", "O1");

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

/// Regression test for HBR-80 bounce item 2's stderr half: invalid UTF-8 or
/// a flood of stderr output used to stop the stderr drain, which then
/// leaves the agent blocked (or killed by EPIPE) writing to a closed pipe.
#[test]
fn invalid_utf8_and_flooding_stderr_does_not_break_the_relay() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", "O1");

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
    let channel = bridge.open("fake", "O1");

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

/// Regression test for HBR-80 bounce item 3: concurrent `acp.send` calls
/// used to be dispatched via `tokio::spawn`, so they raced for the stdin
/// lock and could reach the agent out of order.
#[test]
fn acp_send_preserves_fifo_order() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", "O1");

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
    let channel = bridge.open("fake", "O1");

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

/// Regression test for HBR-80 bounce item 5: a real agent is often launched
/// through a wrapper (e.g. `npx` -> `node`); killing only the direct child
/// leaves descendants alive, holding the stdout pipe open forever, so no
/// exit event ever arrives.
#[test]
fn close_kills_the_whole_process_group_including_grandchildren() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", "O1");

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

/// Regression test for HBR-80 bounce item 1: stdin EOF used to never reach
/// `else => break` in the select loop (one branch was permanently disabled
/// on mismatch, the other never resolved), so the bridge hung forever and
/// needed an external SIGTERM.
#[test]
fn disconnect_terminates_the_bridge_without_external_signal() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let _channel = bridge.open("fake", "O1");

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
        channels.push(bridge.open("fake", &format!("O{}", i)));
    }

    let rejected = bridge.open_raw("fake", "Ocap");
    assert_eq!(rejected["event"]["type"], "error");
    assert_eq!(rejected["event"]["fatal"], true);

    bridge.shutdown();
}

#[test]
fn send_validation_errors() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let channel = bridge.open("fake", "O1");

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

/// Regression test for HBR-80 bounce 2 item 1: `acp.send` used to enqueue
/// onto the channel's stdin queue with an *awaited* `send`, inline in the
/// single native-messaging read loop. An agent that stops draining its
/// stdin fills that queue and never frees a slot, so that await never
/// resolves - stalling the entire loop: pings, other channels, and the very
/// acp.close that could kill the stuck agent all go unanswered, forever.
#[test]
fn acp_send_rejects_when_queue_is_full_without_blocking_the_bridge() {
    let mut bridge = Bridge::spawn(json!([fake_agent("fake")]));
    let ch1 = bridge.open("fake", "O1");
    let ch2 = bridge.open("fake", "O2");

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
