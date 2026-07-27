#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .init();

    if let Err(error) = harbor_bridge::agent_gateway::run_mcp_stdio().await {
        tracing::error!("Harbor Agent Gateway stopped: {}", error.message);
        std::process::exit(1);
    }
}
