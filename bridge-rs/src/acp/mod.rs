//! Agent Client Protocol (ACP) process relay.
//!
//! The bridge holds NO ACP protocol state here: it is a process manager and
//! framer. It starts a user-configured agent (e.g. `goose acp`) as a
//! long-lived child process and relays newline-delimited JSON-RPC between
//! the agent's stdio and the extension. Message content is never inspected
//! beyond "is this one JSON object".
//!
//! Commands, args and env come only from `acp.json` (see `config.rs`).
//! Messages from the extension can only select an agent by `id`, and can
//! never carry a command to run. Processes are always spawned directly
//! (`tokio::process::Command`), never through a shell.
//!
//! Two things that are easy to get wrong and are deliberate here:
//! - stdout/stderr are read as raw, length-capped bytes (`read_capped_line`),
//!   never with `AsyncBufReadExt::lines()`. A real agent can legitimately
//!   write non-UTF-8 bytes (binary data in a tool result, a stray control
//!   byte); `lines()` turns that into an unrecoverable read error, which
//!   used to tear down the whole relay for one bad line.
//! - Writes to an agent's stdin go through a single-writer, per-channel
//!   FIFO queue (`write_tx`/`write_rx`), fed synchronously (never via
//!   `tokio::spawn`) from the native-messaging read loop. That read loop
//!   processes one incoming extension frame at a time, so enqueuing
//!   in-line is what makes `acp.send` order match arrival order; writing
//!   straight to a shared `Mutex<ChildStdin>` from independently scheduled
//!   tasks does not.

pub mod config;

use std::collections::HashMap;
use std::io;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, Mutex, RwLock};

use crate::rpc::RpcError;
use config::AcpConfig;

/// Maximum number of agent processes the bridge will run at once.
const MAX_LIVE_AGENTS: usize = 8;

/// Maximum serialized size of a single `acp.send` message written to an
/// agent's stdin. Chosen as a generous but bounded limit for ACP payloads
/// (e.g. file contents embedded in a tool call); documented here rather
/// than enforced anywhere else.
const MAX_SEND_BYTES: usize = 4 * 1024 * 1024;

/// Native messaging enforces (on the browser side) a 1 MB cap on a single
/// message written by the host. `write_message` in `native_messaging.rs`
/// does not itself check size today, so we keep a single agent stdout line
/// safely under that cap before it ever reaches the outbound envelope
/// (`{"type":"stream","event":{"type":"message","message": <line>}}`), which
/// adds its own overhead on top of the raw line. Leaving ~100 KB of
/// headroom for that envelope plus JSON escaping.
const MAX_OUTBOUND_LINE_BYTES: usize = 900 * 1024;

/// How much of a stderr line we buffer for logging. Independent of (and much
/// smaller than) `MAX_OUTBOUND_LINE_BYTES`: stderr never goes to the
/// extension, so a flooding or giant stderr line only needs to be bounded
/// enough to log a useful sample, not preserved in full.
const STDERR_LOG_CAP_BYTES: usize = 8 * 1024;

/// How much of a dropped (non-JSON/garbage) line to keep in a log message.
const LOG_TRUNCATE_BYTES: usize = 2000;

/// Depth of each channel's stdin write queue. `acp.send` calls are enqueued
/// here in arrival order and drained by a single writer task per channel,
/// which is what makes relay order match send order (see module docs). Kept
/// small deliberately: an agent that stops reading its stdin (or dies
/// without us noticing yet) must not let the bridge accumulate unbounded
/// queued writes, and `enqueue_send` rejects (never blocks) once this is
/// full. See also `MAX_QUEUED_BYTES_PER_CHANNEL`, which bounds memory for
/// the case of fewer, larger messages that wouldn't fill this slot count.
const WRITE_QUEUE_CAPACITY: usize = 64;

/// Total bytes `enqueue_send` will let sit in one channel's write queue at
/// once, on top of `WRITE_QUEUE_CAPACITY`'s slot limit. Without this,
/// `WRITE_QUEUE_CAPACITY` slots of `MAX_SEND_BYTES` each could queue up to
/// 256 MiB behind one stuck agent.
const MAX_QUEUED_BYTES_PER_CHANNEL: usize = 16 * 1024 * 1024;

struct ChannelHandle {
    /// FIFO queue to this channel's single stdin-writer task. Dropping the
    /// last `Arc<ChannelHandle>` (i.e. removing it from `CHANNELS`) drops
    /// this sender, which ends that task once its queue drains.
    write_tx: mpsc::Sender<Vec<u8>>,
    /// Bytes currently sitting in `write_tx`'s queue, maintained by
    /// `enqueue_send` (adds on accepting a message) and the writer task
    /// (subtracts on dequeuing one), so `enqueue_send` can reject once the
    /// agent is far enough behind without ever awaiting queue capacity. A
    /// separate `Arc` (not folded into the `ChannelHandle` one) so the
    /// writer task can share it without keeping the whole handle - and so
    /// its "drop the channel ends the writer" lifecycle - alive itself.
    queued_bytes: Arc<AtomicUsize>,
    /// Clone of this channel's stream sender, used only to emit a
    /// non-terminal `error` event when `enqueue_send` has to drop a message
    /// for being queue-full. Never awaited on (`try_send`): a full stream
    /// channel must not be able to block `enqueue_send` either.
    event_tx: mpsc::Sender<Value>,
    child: Mutex<Child>,
}

type ChannelMap = Arc<RwLock<HashMap<String, Arc<ChannelHandle>>>>;

static CHANNELS: OnceLock<ChannelMap> = OnceLock::new();
static CHANNEL_COUNTER: AtomicU64 = AtomicU64::new(0);

fn channels() -> ChannelMap {
    CHANNELS
        .get_or_init(|| Arc::new(RwLock::new(HashMap::new())))
        .clone()
}

/// A fresh opaque channel id. Not a security boundary (it never leaves the
/// bridge/extension trust boundary), just unique per open process.
fn new_channel_id() -> String {
    let n = CHANNEL_COUNTER.fetch_add(1, Ordering::Relaxed);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("acp-{:x}-{:x}", now.as_nanos(), n)
}

fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        s.to_string()
    } else {
        format!("{}... [truncated, {} bytes total]", &s[..max], s.len())
    }
}

// =============================================================================
// Raw, length-capped line reading
// =============================================================================

/// One line read from a child's stdout/stderr, bounded to `cap` bytes.
struct CappedLine {
    /// Up to `cap` bytes of the line, excluding the trailing `\n`. Not
    /// necessarily valid UTF-8: the agent's bytes are never assumed to be.
    bytes: Vec<u8>,
    /// True if the real line was longer than `cap`. The remainder (up to
    /// the next `\n`) was read and discarded, never buffered.
    overflowed: bool,
}

/// Reads one newline-delimited line of raw bytes from `reader`. Unlike
/// `AsyncBufReadExt::lines()`, this never fails on invalid UTF-8 - it
/// doesn't look at encoding at all, just bytes and `\n` - and never buffers
/// more than `cap` bytes for a single line no matter how long the agent
/// makes it, so a misbehaving agent can't grow our memory unboundedly.
/// Returns `Ok(None)` only at true EOF with no partial line pending.
async fn read_capped_line<R>(reader: &mut R, cap: usize) -> io::Result<Option<CappedLine>>
where
    R: AsyncBufRead + Unpin,
{
    let mut bytes = Vec::new();
    let mut total = 0usize;
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() {
            // True EOF (the pipe's write end closed). Flush a trailing
            // partial line if the agent exited without a final '\n'.
            return Ok(if total == 0 {
                None
            } else {
                Some(CappedLine {
                    bytes,
                    overflowed: total > cap,
                })
            });
        }

        if let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            total += pos;
            if bytes.len() < cap {
                let take = (cap - bytes.len()).min(pos);
                bytes.extend_from_slice(&buf[..take]);
            }
            reader.consume(pos + 1);
            return Ok(Some(CappedLine {
                bytes,
                overflowed: total > cap,
            }));
        }

        let chunk_len = buf.len();
        total += chunk_len;
        if bytes.len() < cap {
            let take = (cap - bytes.len()).min(chunk_len);
            bytes.extend_from_slice(&buf[..take]);
        }
        reader.consume(chunk_len);
    }
}

// =============================================================================
// RPC handlers (non-streaming)
// =============================================================================

/// `acp.list_agents {}` -> `{agents:[{id,name}]}`. Never leaks command/args/env.
pub async fn list_agents() -> Result<Value, RpcError> {
    list_agents_for(&AcpConfig::load())
}

fn list_agents_for(config: &AcpConfig) -> Result<Value, RpcError> {
    let agents: Vec<Value> = config
        .agents
        .iter()
        .map(|a| json!({ "id": a.id, "name": a.name }))
        .collect();
    Ok(json!({ "agents": agents }))
}

/// `acp.send {channel, message}`. Validates and enqueues onto the channel's
/// stdin write queue, then returns - it does not wait for the write to
/// actually happen. The native messaging loop calls this directly (never via
/// `tokio::spawn`) exactly once per incoming `acp.send` frame, in arrival
/// order, which is what keeps writes to the agent's stdin in that same
/// order: see the per-channel writer task spawned in `open_stream_with_config`.
///
/// Enqueuing uses `try_send`, never an awaited `send`: this function runs
/// inline in the native-messaging read loop (see its doc comment above), so
/// awaiting a full queue here would stall that loop - and with it pings,
/// other RPCs, other channels, and the very `acp.close` that could kill the
/// stuck agent - until the agent's own stdin drains, which may be never.
/// A full queue (by slot count or by `MAX_QUEUED_BYTES_PER_CHANNEL`) is
/// rejected immediately instead. A write that fails *after* this returns
/// `Ok` is reported as an `error` stream event, not through this call's
/// response.
pub async fn enqueue_send(params: Value) -> Result<Value, RpcError> {
    let channel = params
        .get("channel")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError::invalid_params("channel is required"))?
        .to_string();

    let message = params
        .get("message")
        .cloned()
        .ok_or_else(|| RpcError::invalid_params("message is required"))?;

    if !message.is_object() {
        return Err(RpcError::invalid_params("message must be a JSON object"));
    }

    let mut serialized = serde_json::to_string(&message)
        .map_err(|e| RpcError::internal(format!("failed to serialize message: {}", e)))?;

    if serialized.len() > MAX_SEND_BYTES {
        return Err(RpcError::invalid_params(format!(
            "message exceeds the {} byte limit",
            MAX_SEND_BYTES
        )));
    }
    serialized.push('\n');
    let len = serialized.len();

    let handle = {
        let map = channels();
        let guard = map.read().await;
        guard.get(&channel).cloned()
    }
    .ok_or_else(|| RpcError::invalid_params(format!("unknown channel: {}", channel)))?;

    let queued_now = handle.queued_bytes.fetch_add(len, Ordering::AcqRel) + len;
    if queued_now > MAX_QUEUED_BYTES_PER_CHANNEL {
        handle.queued_bytes.fetch_sub(len, Ordering::AcqRel);
        return Err(queue_full_error(&handle));
    }

    match handle.write_tx.try_send(serialized.into_bytes()) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(mpsc::error::TrySendError::Full(_)) => {
            handle.queued_bytes.fetch_sub(len, Ordering::AcqRel);
            Err(queue_full_error(&handle))
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            handle.queued_bytes.fetch_sub(len, Ordering::AcqRel);
            Err(RpcError::internal("agent is no longer accepting input".to_string()))
        }
    }
}

/// Builds the rejection for a full send queue, and best-effort notifies the
/// stream too (`try_send`, never awaited, for the same reason `enqueue_send`
/// itself never awaits the write queue).
fn queue_full_error(handle: &ChannelHandle) -> RpcError {
    let _ = handle.event_tx.try_send(json!({
        "type": "error",
        "message": "agent input queue full; message dropped",
    }));
    RpcError::invalid_params("agent input queue full")
}

/// `acp.close {channel}` -> kills the agent process (and its whole process
/// group, see `kill`) and ends its stream.
pub async fn close(params: Value) -> Result<Value, RpcError> {
    let channel = params
        .get("channel")
        .and_then(|v| v.as_str())
        .ok_or_else(|| RpcError::invalid_params("channel is required"))?
        .to_string();

    let removed = channels().write().await.remove(&channel);
    match removed {
        Some(handle) => {
            kill(&handle).await;
            Ok(json!({ "ok": true }))
        }
        None => Err(RpcError::invalid_params(format!(
            "unknown channel: {}",
            channel
        ))),
    }
}

/// Kill an agent and everything it spawned. Real agents are often launched
/// through a wrapper (e.g. `npx` -> `node`); `open_stream_with_config` puts
/// the direct child in its own process group (`process_group(0)`), so
/// everything it forks without changing its own group lands in that same
/// group, and signalling the negative pid reaches all of it. `child.kill()`
/// is still run afterwards as a fallback (and is the only thing that runs on
/// non-unix, where there is no process-group signal).
async fn kill(handle: &ChannelHandle) {
    let mut child = handle.child.lock().await;
    #[cfg(unix)]
    if let Some(pid) = child.id() {
        kill_process_group(pid).await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
}

/// Best-effort: ask the system `kill` utility to signal the whole process
/// group (the negative pid), never a shell, and never with anything
/// extension- or agent-controlled in the command. Neither `std`/`tokio` nor
/// any crate already in this workspace exposes `killpg`/`kill(2)` directly
/// (the `libc` crate does, but isn't a dependency, and isn't worth adding
/// just for this); `/bin/kill` is used by its absolute path rather than
/// resolved through PATH. `child.kill()` in the caller still covers the
/// direct child if this doesn't land (group already gone, `/bin/kill`
/// missing on a non-macOS/Linux unix, etc.) - that failure is logged, not
/// silently swallowed, since it means only the direct child gets killed.
#[cfg(unix)]
async fn kill_process_group(pid: u32) {
    // `Command` inherits the bridge's own stdio by default; without these,
    // a stray message from `kill` (e.g. "No such process" on stderr when
    // the group is already gone) would land on the bridge's real stdout -
    // the native messaging pipe to the extension - or its stderr/log.
    let outcome = Command::new("/bin/kill")
        .arg("-KILL")
        .arg(format!("-{}", pid))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .status()
        .await;
    match outcome {
        Ok(status) if status.success() => {}
        Ok(status) => tracing::error!(
            "acp: /bin/kill -KILL -{} exited with {}; only the direct child will be killed",
            pid,
            status
        ),
        Err(e) => tracing::error!(
            "acp: failed to run /bin/kill -KILL -{}: {}; only the direct child will be killed",
            pid,
            e
        ),
    }
}

/// Kill every agent process the bridge started. Called on extension
/// disconnect and on bridge shutdown: the bridge must never leave an agent
/// process running after it stops relaying for it.
pub async fn shutdown_all() {
    let drained: Vec<Arc<ChannelHandle>> = {
        let map = channels();
        let mut guard = map.write().await;
        guard.drain().map(|(_, handle)| handle).collect()
    };
    for handle in drained {
        kill(&handle).await;
    }
}

// =============================================================================
// Streaming RPC: acp.open
// =============================================================================

/// `acp.open {agentId}`. Streaming method: never sends an `rpc_response`,
/// only `stream` events on the calling request's id. The first event is
/// `{"type":"open","channel":<id>}` carrying the opaque channel used by
/// subsequent `acp.send` / `acp.close` calls. Each agent stdout line becomes
/// `{"type":"message","message":<parsed JSON>}`. A non-JSON or non-UTF-8
/// line is dropped (logged, not forwarded) and reading continues. An
/// oversized line is dropped with `{"type":"error",...}` instead of a
/// `message` event, and reading continues. The stream ends with
/// `{"type":"exit","code":<code or null>}` when the process (and its whole
/// process group) exits, or an `{"type":"error","fatal":true,...}` for
/// failures that never produced a channel (unknown agent, process cap,
/// spawn failure).
pub async fn open_stream(params: Value, event_tx: mpsc::Sender<Value>) {
    open_stream_with_config(params, event_tx, AcpConfig::load()).await
}

async fn open_stream_with_config(params: Value, event_tx: mpsc::Sender<Value>, config: AcpConfig) {
    let agent_id = match params.get("agentId").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            send_fatal(&event_tx, "agentId is required").await;
            return;
        }
    };

    let Some(agent) = config.find(&agent_id).cloned() else {
        send_fatal(&event_tx, &format!("unknown agent: {}", agent_id)).await;
        return;
    };

    {
        let map = channels();
        let count = map.read().await.len();
        if count >= MAX_LIVE_AGENTS {
            send_fatal(
                &event_tx,
                &format!("too many open agents (limit {})", MAX_LIVE_AGENTS),
            )
            .await;
            return;
        }
    }

    let mut command = Command::new(&agent.command);
    command
        .args(&agent.args)
        .envs(&agent.env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // New process group per agent: a real agent spawned through a wrapper
    // (`npx` -> `node`) leaves grandchildren behind a plain `kill()` of the
    // direct child. See `kill_process_group`.
    #[cfg(unix)]
    command.process_group(0);

    let mut child = match command.spawn() {
        Ok(c) => c,
        Err(e) => {
            send_fatal(&event_tx, &format!("failed to start agent: {}", e)).await;
            return;
        }
    };

    let Some(stdin) = child.stdin.take() else {
        send_fatal(&event_tx, "agent process has no stdin").await;
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        send_fatal(&event_tx, "agent process has no stdout").await;
        return;
    };
    let stderr = child.stderr.take();

    let channel = new_channel_id();
    let (write_tx, write_rx) = mpsc::channel::<Vec<u8>>(WRITE_QUEUE_CAPACITY);
    let queued_bytes = Arc::new(AtomicUsize::new(0));
    let handle = Arc::new(ChannelHandle {
        write_tx,
        queued_bytes: queued_bytes.clone(),
        event_tx: event_tx.clone(),
        child: Mutex::new(child),
    });

    // Re-check the cap and insert atomically: two concurrent opens could
    // both pass the read-only check above.
    {
        let map = channels();
        let mut guard = map.write().await;
        if guard.len() >= MAX_LIVE_AGENTS {
            drop(guard);
            kill(&handle).await;
            send_fatal(
                &event_tx,
                &format!("too many open agents (limit {})", MAX_LIVE_AGENTS),
            )
            .await;
            return;
        }
        guard.insert(channel.clone(), handle.clone());
    }

    if event_tx
        .send(json!({ "type": "open", "channel": channel }))
        .await
        .is_err()
    {
        // Extension already gone; still clean up the process we started.
        channels().write().await.remove(&channel);
        kill(&handle).await;
        return;
    }
    // Drop our extra clone now: the map holds the one that keeps the
    // channel (and thus `write_tx`, and thus the writer task below) alive
    // until `close`/`shutdown_all` removes it.
    drop(handle);

    // Single writer task per channel: the only thing that ever touches this
    // stdin handle, draining `write_tx`'s queue strictly in enqueue order.
    let channel_for_writer = channel.clone();
    let event_tx_for_writer = event_tx.clone();
    tokio::spawn(async move {
        let mut stdin: ChildStdin = stdin;
        let mut write_rx = write_rx;
        while let Some(bytes) = write_rx.recv().await {
            // No longer queued, whether or not the write below succeeds:
            // `enqueue_send`'s budget is about what's waiting, not in flight.
            queued_bytes.fetch_sub(bytes.len(), Ordering::AcqRel);
            if let Err(e) = stdin.write_all(&bytes).await {
                tracing::error!(
                    "acp channel '{}' failed to write to agent stdin: {}",
                    channel_for_writer,
                    e
                );
                let _ = event_tx_for_writer
                    .send(json!({
                        "type": "error",
                        "message": format!("failed to write to agent: {}", e),
                    }))
                    .await;
                break;
            }
        }
    });

    if let Some(stderr) = stderr {
        let agent_id_for_log = agent_id.clone();
        let channel_for_stderr = channel.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            loop {
                match read_capped_line(&mut reader, STDERR_LOG_CAP_BYTES).await {
                    Ok(Some(line)) => {
                        // Logging only: never fails on invalid UTF-8, and
                        // never stops draining because of it. A flooding or
                        // oversized stderr line still gets read and
                        // discarded past the cap so the agent's write
                        // doesn't block/EPIPE; we just don't keep it all.
                        let text = String::from_utf8_lossy(&line.bytes);
                        let suffix = if line.overflowed { " [line truncated]" } else { "" };
                        tracing::warn!(
                            "acp agent '{}' (channel '{}') stderr: {}{}",
                            agent_id_for_log,
                            channel_for_stderr,
                            text,
                            suffix
                        );
                    }
                    Ok(None) => break,
                    Err(e) => {
                        tracing::error!(
                            "acp channel '{}' stderr read error: {}",
                            channel_for_stderr,
                            e
                        );
                        break;
                    }
                }
            }
        });
    }

    let channel_for_stdout = channel.clone();
    tokio::spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_capped_line(&mut reader, MAX_OUTBOUND_LINE_BYTES).await {
                Ok(Some(line)) => {
                    if line.bytes.is_empty() && !line.overflowed {
                        continue;
                    }
                    forward_stdout_line(&channel_for_stdout, line, &event_tx).await;
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::error!(
                        "acp channel '{}' stdout read error: {}",
                        channel_for_stdout,
                        e
                    );
                    break;
                }
            }
        }

        let code = reap(&channel_for_stdout).await;
        let _ = event_tx.send(json!({ "type": "exit", "code": code })).await;
    });
}

async fn forward_stdout_line(channel: &str, line: CappedLine, event_tx: &mpsc::Sender<Value>) {
    if line.overflowed {
        tracing::error!(
            "acp channel '{}' dropped oversized stdout line (> {} bytes)",
            channel,
            MAX_OUTBOUND_LINE_BYTES
        );
        let _ = event_tx
            .send(json!({
                "type": "error",
                "message": "agent output exceeded the outbound message size limit and was dropped",
            }))
            .await;
        return;
    }

    let text = match std::str::from_utf8(&line.bytes) {
        Ok(s) => s,
        Err(_) => {
            tracing::warn!(
                "acp channel '{}' dropped non-UTF-8 stdout line ({} bytes)",
                channel,
                line.bytes.len()
            );
            return;
        }
    };

    let parsed: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => {
            tracing::warn!(
                "acp channel '{}' dropped non-JSON stdout line: {}",
                channel,
                truncate(text, LOG_TRUNCATE_BYTES)
            );
            return;
        }
    };

    if !parsed.is_object() {
        tracing::warn!(
            "acp channel '{}' dropped non-object JSON stdout line: {}",
            channel,
            truncate(text, LOG_TRUNCATE_BYTES)
        );
        return;
    }

    let event = json!({ "type": "message", "message": parsed });
    // Belt-and-suspenders: the raw line was already capped, but the
    // wrapped envelope adds a little overhead, so re-check the actual
    // outbound size before sending.
    let size = serde_json::to_vec(&event).map(|v| v.len()).unwrap_or(usize::MAX);
    if size > MAX_OUTBOUND_LINE_BYTES {
        tracing::error!(
            "acp channel '{}' dropped oversized stdout line ({} bytes > {} limit)",
            channel,
            size,
            MAX_OUTBOUND_LINE_BYTES
        );
        let _ = event_tx
            .send(json!({
                "type": "error",
                "message": "agent output exceeded the outbound message size limit and was dropped",
            }))
            .await;
        return;
    }

    let _ = event_tx.send(event).await;
}

/// Remove the channel (if still present) and wait for its process to exit,
/// returning the exit code. If the channel was already removed (e.g. by an
/// explicit `acp.close` that already killed and waited on it), there is
/// nothing left to reap. Called once the agent's stdout has closed - which
/// can mean `acp.close` already killed it, but can equally mean the agent
/// exited entirely on its own. Either way, anything still alive in its
/// process group (e.g. a background process the agent started before
/// exiting) must die with it, the same as an explicit `acp.close` would
/// kill it - a natural exit is not a reason to leave that running.
async fn reap(channel: &str) -> Option<i32> {
    let removed = channels().write().await.remove(channel);
    match removed {
        Some(handle) => {
            let mut child = handle.child.lock().await;
            #[cfg(unix)]
            if let Some(pid) = child.id() {
                kill_process_group(pid).await;
            }
            let _ = child.kill().await;
            match child.wait().await {
                Ok(status) => status.code(),
                Err(_) => None,
            }
        }
        None => None,
    }
}

async fn send_fatal(event_tx: &mpsc::Sender<Value>, message: &str) {
    let _ = event_tx
        .send(json!({ "type": "error", "fatal": true, "message": message }))
        .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use config::AgentConfig;

    // Process-management/relay behavior (open/send/close/cap/disconnect/
    // non-UTF-8/oversized/FIFO order/process groups) is covered by the
    // integration tests in `tests/acp_relay.rs`, which drive the real
    // `harbor-bridge` binary end to end. That's what actually exercises the
    // native-messaging dispatch this module depends on; a unit-test harness
    // that calls `open_stream_with_config` directly can't observe that
    // path. What's left here is the pure, no-process transform that's safe
    // and fast to unit test in-process.

    #[test]
    fn list_agents_hides_commands_and_env() {
        let config = AcpConfig {
            agents: vec![AgentConfig {
                id: "goose".to_string(),
                name: "Goose".to_string(),
                command: "goose".to_string(),
                args: vec!["acp".to_string()],
                env: HashMap::from([("SECRET".to_string(), "x".to_string())]),
            }],
        };

        let result = list_agents_for(&config).unwrap();
        assert_eq!(result, json!({ "agents": [{ "id": "goose", "name": "Goose" }] }));

        let serialized = serde_json::to_string(&result).unwrap();
        assert!(!serialized.contains("goose\",\"args\""));
        assert!(!serialized.contains("SECRET"));
        assert!(!serialized.contains("command"));
    }
}
