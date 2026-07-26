mod config;
mod ipc;
mod mcp;
mod opaque_auth;

pub use config::{handle_native_admin, GatewayError};
pub use ipc::{
    create_browser_instance_id, create_browser_request_id, run_native_ipc_server, BrowserRequest,
    BrowserRequestSender, BROWSER_RESPONSE_TIMEOUT,
};
pub use mcp::run_mcp_stdio;
