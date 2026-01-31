mod fs;
mod http_server;
mod js;
mod llm;
mod native_messaging;
mod oauth;
mod rpc;

use std::env;

#[tokio::main]
async fn main() {
  // Check if running in native messaging mode (launched by browser extension)
  let native_mode = env::args().any(|arg| arg == "--native-messaging");
  // Check if running in HTTP server mode (for Safari)
  let http_mode = env::args().any(|arg| arg == "--http-server");
  
  // Get HTTP port from args or use default
  let http_port = env::args()
    .skip_while(|arg| arg != "--port")
    .nth(1)
    .and_then(|p| p.parse().ok())
    .unwrap_or(http_server::DEFAULT_PORT);
  
  // Set up logging - in native mode, log to file (stderr is used for protocol in some cases)
  if native_mode {
    let log_path = dirs::cache_dir()
      .unwrap_or_else(|| std::path::PathBuf::from("/tmp"))
      .join("harbor-bridge.log");
    
    if let Ok(file) = std::fs::OpenOptions::new()
      .create(true)
      .append(true)
      .open(&log_path)
    {
      tracing_subscriber::fmt()
        .with_writer(std::sync::Mutex::new(file))
        .with_ansi(false)
        .init();
    }
  } else {
    tracing_subscriber::fmt::init();
  }

  // Load LLM configuration from disk
  match llm::LlmConfig::load() {
    Ok(config) => {
      tracing::info!("Loaded LLM configuration");
      llm::set_config(config);
    }
    Err(e) => {
      tracing::warn!("Failed to load LLM config, using defaults: {}", e);
    }
  }

  // Initialize OAuth module (loads credentials and stored tokens)
  oauth::init().await;

  if http_mode {
    // HTTP server mode for Safari
    tracing::info!("Harbor bridge starting in HTTP server mode on port {}", http_port);
    if let Err(e) = http_server::run_http_server(http_port).await {
      tracing::error!("HTTP server error: {}", e);
    }
  } else {
    // Native messaging mode for Firefox/Chrome
    tracing::info!("Harbor bridge starting (native_mode={})", native_mode);
    native_messaging::run_native_messaging().await;
  }
}
