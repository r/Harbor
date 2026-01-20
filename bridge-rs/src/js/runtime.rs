//! QuickJS runtime for executing JS MCP servers.

use super::sandbox::Capabilities;
use crate::native_messaging::{get_console_log_sender, ConsoleLogMessage};
use rquickjs::{Context, Object, Runtime};
use std::collections::HashMap;
use tokio::sync::{mpsc, oneshot};

/// Configuration for starting a JS server
pub struct JsServerConfig {
    pub id: String,
    pub code: String,
    pub env: HashMap<String, String>,
    pub capabilities: Capabilities,
}

/// Handle to a running JS server
pub struct ServerHandle {
    request_tx: mpsc::Sender<ServerRequest>,
    shutdown_tx: Option<oneshot::Sender<()>>,
}

struct ServerRequest {
    payload: serde_json::Value,
    response_tx: oneshot::Sender<Result<serde_json::Value, String>>,
}

/// Represents a running JS MCP server
pub struct JsServer;

impl ServerHandle {
    /// Send an MCP request to the server and wait for response
    pub async fn call(&self, request: serde_json::Value) -> Result<serde_json::Value, String> {
        let (response_tx, response_rx) = oneshot::channel();
        
        self.request_tx
            .send(ServerRequest {
                payload: request,
                response_tx,
            })
            .await
            .map_err(|_| "Server channel closed".to_string())?;

        response_rx
            .await
            .map_err(|_| "Response channel closed".to_string())?
    }

    /// Stop the server
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
    }
}

impl JsServer {
    /// Start a new JS server in a background task
    pub async fn start(config: JsServerConfig) -> Result<ServerHandle, String> {
        let (request_tx, mut request_rx) = mpsc::channel::<ServerRequest>(32);
        let (shutdown_tx, mut shutdown_rx) = oneshot::channel();

        let server_id = config.id.clone();

        // Spawn the JS runtime in a blocking task (QuickJS is not async)
        tokio::task::spawn_blocking(move || {
            let result = Self::run_server(config, &mut request_rx, &mut shutdown_rx);
            if let Err(e) = result {
                tracing::error!("JS server '{}' error: {}", server_id, e);
            }
        });

        Ok(ServerHandle {
            request_tx,
            shutdown_tx: Some(shutdown_tx),
        })
    }

    fn run_server(
        config: JsServerConfig,
        request_rx: &mut mpsc::Receiver<ServerRequest>,
        shutdown_rx: &mut oneshot::Receiver<()>,
    ) -> Result<(), String> {
        // Create QuickJS runtime
        let runtime = Runtime::new().map_err(|e| format!("Failed to create runtime: {}", e))?;
        let context = Context::full(&runtime).map_err(|e| format!("Failed to create context: {}", e))?;

        context.with(|ctx| {
            // Set up the sandbox environment
            Self::setup_sandbox(&ctx, &config.env, &config.capabilities)?;

            // Execute the server code
            ctx.eval::<(), _>(config.code.as_str())
                .map_err(|e| format!("Failed to execute server code: {}", e))?;

            Ok::<(), String>(())
        })?;

        // Run pending jobs to start the async main() function
        // This allows the server to set up __mcp_pendingRead before we send requests
        let mut jobs_executed = 0;
        for _ in 0..1000 {
            if !runtime.is_job_pending() {
                break;
            }
            match runtime.execute_pending_job() {
                Ok(_) => jobs_executed += 1,
                Err(e) => {
                    tracing::warn!("[JS:{}] Startup job error: {:?}", config.id, e);
                    break;
                }
            }
        }
        tracing::info!("[JS:{}] Executed {} startup jobs", config.id, jobs_executed);

        // Check if __mcp_pendingRead is set up
        context.with(|ctx| {
            let has_pending: bool = ctx.eval("!!globalThis.__mcp_pendingRead").unwrap_or(false);
            tracing::info!("[JS:{}] __mcp_pendingRead set up: {}", config.id, has_pending);
            Self::flush_console_logs(&ctx, &config.id);
        });

        // Message processing loop
        let rt = tokio::runtime::Handle::current();
        loop {
            // Check for shutdown signal
            match shutdown_rx.try_recv() {
                Ok(_) | Err(oneshot::error::TryRecvError::Closed) => {
                    tracing::info!("JS server '{}' shutting down", config.id);
                    break;
                }
                Err(oneshot::error::TryRecvError::Empty) => {}
            }

            // Try to receive a request (non-blocking)
            match rt.block_on(async {
                tokio::select! {
                    req = request_rx.recv() => req,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(10)) => None,
                }
            }) {
                Some(request) => {
                    let response = Self::handle_mcp_request_with_jobs(
                        &context, &runtime, request.payload, &config.id
                    );
                    let _ = request.response_tx.send(response);
                }
                None => {
                    // No request, continue loop
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
            }
        }

        Ok(())
    }

    fn setup_sandbox(
        ctx: &rquickjs::Ctx,
        env: &HashMap<String, String>,
        capabilities: &Capabilities,
    ) -> Result<(), String> {
        let globals = ctx.globals();

        // MCP.writeLine - will be called by JS to send responses
        // We store responses in a global array that Rust will read
        ctx.eval::<(), _>(r#"
            globalThis.__mcp_responses = [];
            globalThis.__mcp_requests = [];
        "#).map_err(|e| e.to_string())?;

        // Create process.env
        let process = Object::new(ctx.clone()).map_err(|e| e.to_string())?;
        let env_obj = Object::new(ctx.clone()).map_err(|e| e.to_string())?;
        
        for (key, value) in env {
            env_obj.set(key.as_str(), value.as_str()).map_err(|e| e.to_string())?;
        }
        
        process.set("env", env_obj).map_err(|e| e.to_string())?;
        process.set("platform", "harbor-bridge").map_err(|e| e.to_string())?;
        globals.set("process", process).map_err(|e| e.to_string())?;

        // Create console object that captures logs
        ctx.eval::<(), _>(r#"
            globalThis.__console_logs = [];
            globalThis.console = {
                log: (...args) => {
                    globalThis.__console_logs.push({ level: 'log', args: args.map(a => String(a)) });
                },
                warn: (...args) => {
                    globalThis.__console_logs.push({ level: 'warn', args: args.map(a => String(a)) });
                },
                error: (...args) => {
                    globalThis.__console_logs.push({ level: 'error', args: args.map(a => String(a)) });
                },
                info: (...args) => {
                    globalThis.__console_logs.push({ level: 'info', args: args.map(a => String(a)) });
                },
                debug: (...args) => {
                    globalThis.__console_logs.push({ level: 'debug', args: args.map(a => String(a)) });
                },
            };
        "#).map_err(|e| e.to_string())?;

        // Create MCP interface
        ctx.eval::<(), _>(r#"
            globalThis.MCP = {
                readLine: function() {
                    return new Promise((resolve) => {
                        globalThis.__mcp_pendingRead = resolve;
                    });
                },
                writeLine: function(json) {
                    globalThis.__mcp_responses.push(json);
                },
            };
        "#).map_err(|e| e.to_string())?;

        // Remove dangerous globals
        ctx.eval::<(), _>(r#"
            delete globalThis.eval;
        "#).map_err(|e| e.to_string())?;

        // Set up fetch if network access is allowed
        if !capabilities.network.allowed_hosts.is_empty() {
            // Fetch will be handled synchronously via Rust callbacks
            // For now, create a placeholder that stores requests
            ctx.eval::<(), _>(r#"
                globalThis.__fetch_requests = [];
                globalThis.__fetch_responses = {};
                globalThis.__fetch_id = 0;
                
                globalThis.fetch = async function(url, options) {
                    const id = ++globalThis.__fetch_id;
                    globalThis.__fetch_requests.push({
                        id: id,
                        url: url,
                        options: options || {}
                    });
                    
                    // Wait for response (will be filled by Rust)
                    return new Promise((resolve, reject) => {
                        const check = () => {
                            const resp = globalThis.__fetch_responses[id];
                            if (resp) {
                                delete globalThis.__fetch_responses[id];
                                if (resp.error) {
                                    reject(new Error(resp.error));
                                } else {
                                    resolve({
                                        ok: resp.status >= 200 && resp.status < 300,
                                        status: resp.status,
                                        statusText: resp.statusText || '',
                                        headers: new Map(Object.entries(resp.headers || {})),
                                        text: async () => resp.body,
                                        json: async () => JSON.parse(resp.body),
                                    });
                                }
                            } else {
                                setTimeout(check, 1);
                            }
                        };
                        check();
                    });
                };
            "#).map_err(|e| e.to_string())?;
        }

        Ok(())
    }

    /// Flush any pending console logs from JS and emit them via tracing + broadcast
    fn flush_console_logs(ctx: &rquickjs::Ctx, server_id: &str) {
        // Get logs as JSON string and parse on Rust side
        let logs_json: Result<String, _> = ctx.eval(r#"
            JSON.stringify(globalThis.__console_logs.splice(0))
        "#);

        if let Ok(json) = logs_json {
            if let Ok(logs) = serde_json::from_str::<Vec<serde_json::Value>>(&json) {
                let console_tx = get_console_log_sender();
                
                for log in logs {
                    let level = log.get("level").and_then(|v| v.as_str()).unwrap_or("log");
                    let args = log.get("args")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter()
                            .filter_map(|v| v.as_str())
                            .collect::<Vec<_>>()
                            .join(" "))
                        .unwrap_or_default();
                    
                    // Log to tracing (file)
                    match level {
                        "error" => tracing::error!("[JS:{}] {}", server_id, args),
                        "warn" => tracing::warn!("[JS:{}] {}", server_id, args),
                        "info" => tracing::info!("[JS:{}] {}", server_id, args),
                        "debug" => tracing::debug!("[JS:{}] {}", server_id, args),
                        _ => tracing::info!("[JS:{}] {}", server_id, args),
                    }
                    
                    // Broadcast to extension via native messaging
                    let _ = console_tx.send(ConsoleLogMessage {
                        server_id: server_id.to_string(),
                        level: level.to_string(),
                        message: args,
                    });
                }
            }
        }
    }

    /// Handle an MCP request, properly separating context access from job execution
    fn handle_mcp_request_with_jobs(
        context: &Context,
        runtime: &Runtime,
        request: serde_json::Value,
        server_id: &str,
    ) -> Result<serde_json::Value, String> {
        tracing::info!("[JS:{}] Handling MCP request", server_id);
        
        let request_json = serde_json::to_string(&request).map_err(|e| e.to_string())?;

        // Step 1: Inject the request (inside context lock)
        context.with(|ctx| {
            let has_pending: bool = ctx.eval("!!globalThis.__mcp_pendingRead").unwrap_or(false);
            tracing::info!("[JS:{}] __mcp_pendingRead before: {}", server_id, has_pending);

            let code = format!(r#"
                const req = '{}';
                if (globalThis.__mcp_pendingRead) {{
                    const resolve = globalThis.__mcp_pendingRead;
                    globalThis.__mcp_pendingRead = null;
                    resolve(req);
                }} else {{
                    globalThis.__mcp_requests.push(req);
                }}
            "#, request_json.replace("'", "\\'").replace("\n", "\\n"));

            ctx.eval::<(), _>(code.as_str())
        }).map_err(|e| format!("Failed to inject request: {}", e))?;
        
        tracing::info!("[JS:{}] Request injected", server_id);

        // Step 2: Run job queue and check for responses (alternating context access and job execution)
        let mut total_jobs = 0;
        for iteration in 0..10000 {
            // Execute pending jobs OUTSIDE context lock
            let jobs_pending = runtime.is_job_pending();
            if iteration == 0 {
                tracing::info!("[JS:{}] Jobs pending after injection: {}", server_id, jobs_pending);
            }
            
            let mut jobs_this_round = 0;
            while runtime.is_job_pending() {
                match runtime.execute_pending_job() {
                    Ok(_) => {
                        jobs_this_round += 1;
                        total_jobs += 1;
                    }
                    Err(e) => {
                        tracing::warn!("[JS:{}] Job execution error: {:?}", server_id, e);
                        break;
                    }
                }
            }
            
            if iteration == 0 {
                tracing::info!("[JS:{}] First iteration: executed {} jobs", server_id, jobs_this_round);
            }
            
            // Check for response INSIDE context lock
            let response_result: Result<Option<String>, String> = context.with(|ctx| {
                let responses: Vec<String> = ctx.eval(r#"
                    const r = globalThis.__mcp_responses.splice(0);
                    r
                "#).map_err(|e| e.to_string())?;

                Self::flush_console_logs(&ctx, server_id);

                if !responses.is_empty() {
                    Ok(Some(responses.into_iter().last().unwrap()))
                } else {
                    Ok(None)
                }
            });

            match response_result {
                Ok(Some(response_str)) => {
                    tracing::info!("[JS:{}] Got response after {} iterations, {} total jobs", server_id, iteration, total_jobs);
                    return serde_json::from_str(&response_str)
                        .map_err(|e| format!("Invalid response JSON: {}", e));
                }
                Ok(None) => {
                    // No response yet, continue
                }
                Err(e) => {
                    return Err(format!("Error checking response: {}", e));
                }
            }

            // Small delay before checking again
            std::thread::sleep(std::time::Duration::from_millis(1));
        }

        // Final state check
        let (has_pending, response_count) = context.with(|ctx| {
            Self::flush_console_logs(&ctx, server_id);
            let has_pending: bool = ctx.eval("!!globalThis.__mcp_pendingRead").unwrap_or(false);
            let response_count: i32 = ctx.eval("globalThis.__mcp_responses.length").unwrap_or(-1);
            (has_pending, response_count)
        });
        
        tracing::error!("[JS:{}] TIMEOUT after {} jobs. __mcp_pendingRead={}, responses={}", 
            server_id, total_jobs, has_pending, response_count);
        
        Err("Timeout waiting for server response".to_string())
    }
}
