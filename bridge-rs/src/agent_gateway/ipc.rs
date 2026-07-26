use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, Semaphore};

use super::config::{AuthorizationLease, GatewayConfigStore, GatewayError};
use super::opaque_auth;

const MAX_IPC_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_CONCURRENT_IPC_CONNECTIONS: usize = 16;
const AUTHENTICATION_BURST_CAPACITY: f64 = 32.0;
const AUTHENTICATION_REFILL_PER_SECOND: f64 = 4.0;
const AUTHENTICATION_TIMEOUT: Duration = Duration::from_secs(5);
const IPC_CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
// Bounds how long a non-reading client can delay a revoke or disable commit.
const AUTHORIZED_RESPONSE_WRITE_TIMEOUT: Duration = Duration::from_secs(1);
pub const BROWSER_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const IPC_BROWSER_REQUEST_TIMEOUT: Duration = Duration::from_secs(35);
const CLIENT_ID_ENVIRONMENT_VARIABLE: &str = "HARBOR_AGENT_GATEWAY_CLIENT_ID";
const CLIENT_SECRET_ENVIRONMENT_VARIABLE: &str = "HARBOR_AGENT_GATEWAY_SECRET";

pub struct BrowserRequest {
    pub method: String,
    pub client_id: String,
    pub session_id: String,
    pub params: serde_json::Value,
    pub response_tx: oneshot::Sender<Result<serde_json::Value, serde_json::Value>>,
    pub cancellation_rx: oneshot::Receiver<()>,
}

pub type BrowserRequestSender = mpsc::Sender<BrowserRequest>;

struct AuthenticationRateLimiter {
    available_tokens: f64,
    last_refill: std::time::Instant,
}

impl AuthenticationRateLimiter {
    fn new() -> Self {
        Self {
            available_tokens: AUTHENTICATION_BURST_CAPACITY,
            last_refill: std::time::Instant::now(),
        }
    }

    fn try_acquire(&mut self) -> bool {
        let now = std::time::Instant::now();
        let elapsed_seconds = now.duration_since(self.last_refill).as_secs_f64();
        self.available_tokens = (self.available_tokens
            + elapsed_seconds * AUTHENTICATION_REFILL_PER_SECOND)
            .min(AUTHENTICATION_BURST_CAPACITY);
        self.last_refill = now;

        if self.available_tokens < 1.0 {
            return false;
        }

        self.available_tokens -= 1.0;
        true
    }
}

#[derive(Debug, Clone)]
pub(crate) struct GatewayCredentials {
    pub client_id: String,
    pub secret: String,
}

impl GatewayCredentials {
    pub(crate) fn from_environment() -> Result<Self, GatewayError> {
        let client_id = std::env::var(CLIENT_ID_ENVIRONMENT_VARIABLE).map_err(|_| {
            GatewayError::new(
                "GATEWAY_NOT_PAIRED",
                format!("{CLIENT_ID_ENVIRONMENT_VARIABLE} is not configured"),
                false,
            )
        })?;
        let secret = std::env::var(CLIENT_SECRET_ENVIRONMENT_VARIABLE).map_err(|_| {
            GatewayError::new(
                "GATEWAY_NOT_PAIRED",
                format!("{CLIENT_SECRET_ENVIRONMENT_VARIABLE} is not configured"),
                false,
            )
        })?;

        if client_id.trim().is_empty() || secret.is_empty() {
            return Err(GatewayError::new(
                "GATEWAY_NOT_PAIRED",
                "Gateway client credentials are empty",
                false,
            ));
        }

        Ok(Self { client_id, secret })
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum IpcMessage {
    ClientHello {
        client_id: String,
        credential_request: String,
    },
    ServerChallenge {
        browser_instance_id: String,
        credential_response: String,
    },
    ClientProof {
        credential_finalization: String,
    },
    Authenticated {
        browser_instance_id: String,
        server_confirmation: String,
    },
    Request {
        id: String,
        method: String,
        session_id: Option<String>,
        #[serde(default)]
        params: serde_json::Value,
    },
    Response {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<serde_json::Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<GatewayError>,
    },
    Error {
        error: GatewayError,
    },
}

struct AuthenticatedClient {
    client_id: String,
    registration_record: String,
    authorization_lease: AuthorizationLease,
    server_confirmation: String,
}

pub fn create_browser_instance_id() -> String {
    let mut bytes = [0_u8; 18];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("browser_{}", URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn default_socket_path() -> Result<PathBuf, GatewayError> {
    let config_directory = dirs::config_dir().ok_or_else(|| {
        GatewayError::new(
            "GATEWAY_CONFIGURATION_ERROR",
            "Could not determine the user configuration directory",
            false,
        )
    })?;
    Ok(config_directory.join("harbor").join("agent-gateway.sock"))
}

#[cfg(unix)]
pub async fn run_native_ipc_server(
    browser_request_tx: BrowserRequestSender,
    browser_instance_id: String,
    browser_connected: Arc<AtomicBool>,
) -> Result<(), GatewayError> {
    use std::os::unix::fs::PermissionsExt;
    use tokio::net::UnixListener;

    let socket_path = default_socket_path()?;
    prepare_socket_directory(&socket_path)?;
    remove_stale_socket(&socket_path)?;

    let listener = UnixListener::bind(&socket_path)?;
    let _socket_cleanup = SocketCleanup::new(socket_path.clone());
    std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))?;
    let connection_permits = create_connection_admission();
    let authentication_rate_limiter = Arc::new(Mutex::new(AuthenticationRateLimiter::new()));
    tracing::info!("Harbor Agent Gateway IPC is listening for authenticated local clients");

    loop {
        let connection_permit = connection_permits
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| {
                GatewayError::new(
                    "BROWSER_DISCONNECTED",
                    "Gateway IPC connection admission is closed",
                    true,
                )
            })?;
        let (stream, _) = listener.accept().await?;
        let client_request_tx = browser_request_tx.clone();
        let client_browser_instance_id = browser_instance_id.clone();
        let client_authentication_rate_limiter = authentication_rate_limiter.clone();
        let client_browser_connected = browser_connected.clone();
        tokio::spawn(async move {
            let _connection_permit = connection_permit;
            if let Err(error) = handle_ipc_connection(
                stream,
                client_request_tx,
                client_browser_instance_id,
                client_authentication_rate_limiter,
                client_browser_connected,
            )
            .await
            {
                tracing::warn!("Agent gateway IPC connection ended: {}", error.message);
            }
        });
    }
}

fn create_connection_admission() -> std::sync::Arc<Semaphore> {
    std::sync::Arc::new(Semaphore::new(MAX_CONCURRENT_IPC_CONNECTIONS))
}

#[cfg(not(unix))]
pub async fn run_native_ipc_server(
    _browser_request_tx: BrowserRequestSender,
    _browser_instance_id: String,
    _browser_connected: Arc<AtomicBool>,
) -> Result<(), GatewayError> {
    Err(GatewayError::new(
        "GATEWAY_UNSUPPORTED",
        "Harbor Agent Gateway IPC is currently supported on macOS and Linux",
        false,
    ))
}

#[cfg(unix)]
async fn handle_ipc_connection(
    mut stream: tokio::net::UnixStream,
    browser_request_tx: BrowserRequestSender,
    browser_instance_id: String,
    authentication_rate_limiter: Arc<Mutex<AuthenticationRateLimiter>>,
    browser_connected: Arc<AtomicBool>,
) -> Result<(), GatewayError> {
    let (client_id, credential_request) =
        read_client_hello_with_timeout(&mut stream, AUTHENTICATION_TIMEOUT).await?;
    let authentication_allowed = authentication_rate_limiter
        .lock()
        .map_err(|_| {
            GatewayError::new(
                "RATE_LIMITED",
                "Gateway authentication limiter is unavailable",
                true,
            )
        })?
        .try_acquire();
    if !authentication_allowed {
        let error = GatewayError::new(
            "RATE_LIMITED",
            "Gateway authentication attempt rate exceeded",
            true,
        );
        write_framed_message(
            &mut stream,
            &IpcMessage::Error {
                error: error.clone(),
            },
        )
        .await?;
        return Err(error);
    }
    ensure_browser_connected(&browser_connected)?;

    let store = GatewayConfigStore::default_store()?;
    let authenticated_client = match complete_server_authentication(
        &mut stream,
        &store,
        client_id,
        credential_request,
        &browser_instance_id,
    )
    .await
    {
        Ok(authenticated_client) => authenticated_client,
        Err(error) => {
            write_framed_message(
                &mut stream,
                &IpcMessage::Error {
                    error: error.clone(),
                },
            )
            .await?;
            return Err(error);
        }
    };
    let AuthenticatedClient {
        client_id,
        registration_record,
        authorization_lease,
        server_confirmation,
    } = authenticated_client;
    write_framed_message(
        &mut stream,
        &IpcMessage::Authenticated {
            browser_instance_id: browser_instance_id.clone(),
            server_confirmation,
        },
    )
    .await?;

    let message: IpcMessage = match read_framed_message(&mut stream).await {
        Ok(message) => message,
        Err(error) if error.code == "IPC_CLOSED" => return Ok(()),
        Err(error) => return Err(error),
    };

    let (id, method, session_id, params) = match message {
        IpcMessage::Request {
            id,
            method,
            session_id,
            params,
        } => (id, method, session_id, params),
        _ => {
            let error = GatewayError::new(
                "INVALID_REQUEST",
                "Expected an IPC request after authentication",
                false,
            );
            write_framed_message(
                &mut stream,
                &IpcMessage::Error {
                    error: error.clone(),
                },
            )
            .await?;
            return Err(error);
        }
    };

    let outcome = if let Err(error) = ensure_browser_connected(&browser_connected) {
        Err(error)
    } else if let Err(error) = store.verify_client_registration(&client_id, &registration_record) {
        Err(error)
    } else if method == "gateway.health" {
        Ok(serde_json::json!({
            "status": "ok",
            "enabled": true,
            "authenticated": true,
            "browserConnected": true,
            "browserInstanceId": browser_instance_id,
        }))
    } else {
        let browser_call = forward_browser_request(
            &browser_request_tx,
            method,
            client_id.clone(),
            session_id,
            params,
        );
        tokio::pin!(browser_call);
        tokio::select! {
            outcome = &mut browser_call => outcome,
            disconnect = stream.read_u8() => {
                return match disconnect {
                    Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => Ok(()),
                    Err(error) => Err(error.into()),
                    Ok(_) => Err(GatewayError::new(
                        "INVALID_REQUEST",
                        "Only one request is permitted per authenticated IPC connection",
                        false,
                    )),
                };
            }
        }
    };
    match outcome {
        Ok(result) => {
            let standard_stream = stream.into_std()?;
            standard_stream.set_nonblocking(false)?;
            tokio::task::spawn_blocking(move || {
                write_authorized_success_response(
                    standard_stream,
                    store,
                    client_id,
                    registration_record,
                    authorization_lease,
                    browser_connected,
                    id,
                    result,
                )
            })
            .await
            .map_err(|_| {
                GatewayError::new(
                    "TOOL_CALL_FAILED",
                    "Gateway response release task failed",
                    true,
                )
            })?
        }
        Err(error) => {
            let response = IpcMessage::Response {
                id,
                result: None,
                error: Some(error),
            };
            write_framed_message(&mut stream, &response).await
        }
    }
}

async fn read_client_hello_with_timeout<Reader>(
    reader: &mut Reader,
    timeout_duration: Duration,
) -> Result<(String, String), GatewayError>
where
    Reader: AsyncRead + Unpin,
{
    let client_hello = tokio::time::timeout(
        timeout_duration,
        read_framed_message::<_, IpcMessage>(reader),
    )
    .await
    .map_err(|_| {
        GatewayError::new("RATE_LIMITED", "Gateway IPC authentication timed out", true)
    })??;

    match client_hello {
        IpcMessage::ClientHello {
            client_id,
            credential_request,
        } => Ok((client_id, credential_request)),
        _ => Err(GatewayError::new(
            "GATEWAY_NOT_PAIRED",
            "The first IPC message must be a client authentication hello",
            false,
        )),
    }
}

async fn complete_server_authentication<Stream>(
    stream: &mut Stream,
    store: &GatewayConfigStore,
    client_id: String,
    credential_request: String,
    browser_instance_id: &str,
) -> Result<AuthenticatedClient, GatewayError>
where
    Stream: AsyncRead + AsyncWrite + Unpin,
{
    let client_authorization = store.begin_client_authentication(&client_id)?;
    let (server_state, credential_response) = opaque_auth::start_server_login(
        &client_authorization.server_setup,
        &client_authorization.registration_record,
        &client_id,
        browser_instance_id.as_bytes(),
        &credential_request,
    )?;
    write_framed_message(
        stream,
        &IpcMessage::ServerChallenge {
            browser_instance_id: browser_instance_id.to_string(),
            credential_response,
        },
    )
    .await?;

    let client_proof_message = tokio::time::timeout(
        AUTHENTICATION_TIMEOUT,
        read_framed_message::<_, IpcMessage>(stream),
    )
    .await
    .map_err(|_| {
        GatewayError::new("GATEWAY_NOT_PAIRED", "Gateway client proof timed out", true)
    })??;
    let credential_finalization = match client_proof_message {
        IpcMessage::ClientProof {
            credential_finalization,
        } => credential_finalization,
        _ => {
            return Err(GatewayError::new(
                "GATEWAY_NOT_PAIRED",
                "Expected a client authentication proof",
                false,
            ))
        }
    };
    let session_key = opaque_auth::finish_server_login(server_state, &credential_finalization)?;
    store.verify_client_registration(&client_id, &client_authorization.registration_record)?;
    let server_confirmation =
        opaque_auth::create_server_confirmation(&session_key, &client_id, browser_instance_id);

    Ok(AuthenticatedClient {
        client_id,
        registration_record: client_authorization.registration_record,
        authorization_lease: client_authorization.lease,
        server_confirmation,
    })
}

async fn forward_browser_request(
    browser_request_tx: &BrowserRequestSender,
    method: String,
    client_id: String,
    session_id: Option<String>,
    params: serde_json::Value,
) -> Result<serde_json::Value, GatewayError> {
    if method != "agentGateway.tabs.list" && method != "agentGateway.page.observe" {
        return Err(GatewayError::new(
            "METHOD_NOT_FOUND",
            format!("Unsupported browser gateway method: {method}"),
            false,
        ));
    }

    let session_id = session_id
        .filter(|session_id| !session_id.trim().is_empty())
        .ok_or_else(|| {
            GatewayError::new(
                "INVALID_PARAMS",
                "sessionId is required for browser gateway calls",
                false,
            )
        })?;
    let (response_tx, response_rx) = oneshot::channel();
    let (_cancellation_tx, cancellation_rx) = oneshot::channel();
    browser_request_tx
        .send(BrowserRequest {
            method,
            client_id,
            session_id,
            params,
            response_tx,
            cancellation_rx,
        })
        .await
        .map_err(|_| {
            GatewayError::new(
                "BROWSER_DISCONNECTED",
                "The browser-connected Harbor host is unavailable",
                true,
            )
        })?;

    let browser_outcome = tokio::time::timeout(IPC_BROWSER_REQUEST_TIMEOUT, response_rx)
        .await
        .map_err(|_| {
            GatewayError::new(
                "BROWSER_DISCONNECTED",
                "Timed out waiting for the Harbor extension",
                true,
            )
        })?
        .map_err(|_| {
            GatewayError::new(
                "BROWSER_DISCONNECTED",
                "The Harbor extension dropped the pending request",
                true,
            )
        })?;

    browser_outcome.map_err(GatewayError::from_browser)
}

#[cfg(unix)]
fn write_authorized_success_response(
    stream: std::os::unix::net::UnixStream,
    store: GatewayConfigStore,
    client_id: String,
    registration_record: String,
    authorization_lease: AuthorizationLease,
    browser_connected: Arc<AtomicBool>,
    request_id: String,
    result: serde_json::Value,
) -> Result<(), GatewayError> {
    write_authorized_success_response_with_hook(
        stream,
        store,
        client_id,
        registration_record,
        authorization_lease,
        browser_connected,
        request_id,
        result,
        || {},
    )
}

#[cfg(unix)]
fn write_authorized_success_response_with_hook<ReleaseHook>(
    mut stream: std::os::unix::net::UnixStream,
    store: GatewayConfigStore,
    client_id: String,
    registration_record: String,
    authorization_lease: AuthorizationLease,
    browser_connected: Arc<AtomicBool>,
    request_id: String,
    result: serde_json::Value,
    release_hook: ReleaseHook,
) -> Result<(), GatewayError>
where
    ReleaseHook: FnOnce(),
{
    let success_response = IpcMessage::Response {
        id: request_id.clone(),
        result: Some(result),
        error: None,
    };
    let success_bytes = serialize_framed_message(&success_response)?;
    stream.set_write_timeout(Some(AUTHORIZED_RESPONSE_WRITE_TIMEOUT))?;
    let release_result = store.with_authorized_registration_lease(
        &client_id,
        &registration_record,
        authorization_lease,
        || {
            release_hook();
            ensure_browser_connected(&browser_connected)?;
            write_serialized_framed_message_blocking(&mut stream, &success_bytes)
        },
    );

    match release_result {
        Ok(()) => Ok(()),
        Err(error) if is_release_denial(&error) => write_framed_message_blocking(
            &mut stream,
            &IpcMessage::Response {
                id: request_id,
                result: None,
                error: Some(error),
            },
        ),
        Err(error) => Err(error),
    }
}

fn is_release_denial(error: &GatewayError) -> bool {
    matches!(
        error.code.as_str(),
        "BROWSER_DISCONNECTED" | "GATEWAY_DISABLED" | "GATEWAY_NOT_PAIRED" | "PERMISSION_DENIED"
    )
}

fn ensure_browser_connected(browser_connected: &AtomicBool) -> Result<(), GatewayError> {
    if browser_connected.load(Ordering::SeqCst) {
        return Ok(());
    }

    Err(GatewayError::new(
        "BROWSER_DISCONNECTED",
        "The browser-connected Harbor host is unavailable",
        true,
    ))
}

#[cfg(unix)]
pub(crate) async fn call_native_host(
    credentials: &GatewayCredentials,
    method: &str,
    session_id: Option<&str>,
    params: serde_json::Value,
) -> Result<serde_json::Value, GatewayError> {
    use tokio::net::UnixStream;

    let socket_path = default_socket_path()?;
    let mut stream = tokio::time::timeout(IPC_CONNECT_TIMEOUT, UnixStream::connect(socket_path))
        .await
        .map_err(|_| {
            GatewayError::new(
                "BROWSER_DISCONNECTED",
                "Timed out connecting to the browser-connected Harbor host",
                true,
            )
        })?
        .map_err(|_| {
            GatewayError::new(
                "BROWSER_DISCONNECTED",
                "The browser-connected Harbor host is unavailable",
                true,
            )
        })?;

    authenticate_native_host(&mut stream, credentials).await?;

    let request_id = random_request_id();
    let native_response = tokio::time::timeout(IPC_BROWSER_REQUEST_TIMEOUT, async {
        write_framed_message(
            &mut stream,
            &IpcMessage::Request {
                id: request_id.clone(),
                method: method.to_string(),
                session_id: session_id.map(str::to_string),
                params,
            },
        )
        .await?;
        read_framed_message::<_, IpcMessage>(&mut stream).await
    })
    .await
    .map_err(|_| {
        GatewayError::new(
            "BROWSER_DISCONNECTED",
            "Timed out waiting for the browser-connected Harbor host",
            true,
        )
    })??;

    match native_response {
        IpcMessage::Response { id, result, error } if id == request_id => {
            if let Some(error) = error {
                Err(error)
            } else {
                Ok(result.unwrap_or(serde_json::Value::Null))
            }
        }
        IpcMessage::Error { error } => Err(error),
        _ => Err(GatewayError::new(
            "INVALID_RESPONSE",
            "Native host returned an invalid gateway response",
            false,
        )),
    }
}

async fn authenticate_native_host<Stream>(
    stream: &mut Stream,
    credentials: &GatewayCredentials,
) -> Result<String, GatewayError>
where
    Stream: AsyncRead + AsyncWrite + Unpin,
{
    let (client_state, credential_request) = opaque_auth::start_client_login(&credentials.secret)?;
    write_framed_message(
        stream,
        &IpcMessage::ClientHello {
            client_id: credentials.client_id.clone(),
            credential_request,
        },
    )
    .await?;

    let challenge = read_authentication_message(stream).await?;
    let (browser_instance_id, credential_response) = match challenge {
        IpcMessage::ServerChallenge {
            browser_instance_id,
            credential_response,
        } => (browser_instance_id, credential_response),
        IpcMessage::Error { error } => return Err(error),
        _ => return Err(server_authentication_error()),
    };
    let client_finish = opaque_auth::finish_client_login(
        client_state,
        &credentials.client_id,
        browser_instance_id.as_bytes(),
        &credential_response,
    )?;

    write_framed_message(
        stream,
        &IpcMessage::ClientProof {
            credential_finalization: client_finish.credential_finalization,
        },
    )
    .await?;

    match read_authentication_message(stream).await? {
        IpcMessage::Authenticated {
            browser_instance_id: authenticated_browser_instance_id,
            server_confirmation,
        } if authenticated_browser_instance_id == browser_instance_id => {
            opaque_auth::verify_server_confirmation(
                &client_finish.session_key,
                &credentials.client_id,
                &browser_instance_id,
                &server_confirmation,
            )?;
            Ok(browser_instance_id)
        }
        IpcMessage::Error { error } => Err(error),
        _ => Err(server_authentication_error()),
    }
}

async fn read_authentication_message<Stream>(
    stream: &mut Stream,
) -> Result<IpcMessage, GatewayError>
where
    Stream: AsyncRead + Unpin,
{
    tokio::time::timeout(
        AUTHENTICATION_TIMEOUT,
        read_framed_message::<_, IpcMessage>(stream),
    )
    .await
    .map_err(|_| {
        GatewayError::new(
            "BROWSER_DISCONNECTED",
            "Timed out authenticating the browser-connected Harbor host",
            true,
        )
    })?
}

#[cfg(not(unix))]
pub(crate) async fn call_native_host(
    _credentials: &GatewayCredentials,
    _method: &str,
    _session_id: Option<&str>,
    _params: serde_json::Value,
) -> Result<serde_json::Value, GatewayError> {
    Err(GatewayError::new(
        "GATEWAY_UNSUPPORTED",
        "Harbor Agent Gateway IPC is currently supported on macOS and Linux",
        false,
    ))
}

async fn read_framed_message<Reader, Message>(reader: &mut Reader) -> Result<Message, GatewayError>
where
    Reader: AsyncRead + Unpin,
    Message: DeserializeOwned,
{
    let mut length_bytes = [0_u8; 4];
    match reader.read_exact(&mut length_bytes).await {
        Ok(_) => {}
        Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => {
            return Err(GatewayError::new(
                "IPC_CLOSED",
                "Gateway IPC connection closed",
                true,
            ))
        }
        Err(error) => return Err(error.into()),
    }
    let length = u32::from_le_bytes(length_bytes) as usize;
    if length == 0 || length > MAX_IPC_MESSAGE_BYTES {
        return Err(GatewayError::new(
            "OUTPUT_TOO_LARGE",
            format!(
                "Gateway IPC message length must be between 1 and {MAX_IPC_MESSAGE_BYTES} bytes"
            ),
            false,
        ));
    }

    let mut message_bytes = vec![0_u8; length];
    reader.read_exact(&mut message_bytes).await?;
    serde_json::from_slice(&message_bytes).map_err(|error| {
        GatewayError::new(
            "INVALID_REQUEST",
            format!("Invalid gateway IPC JSON: {error}"),
            false,
        )
    })
}

async fn write_framed_message<Writer, Message>(
    writer: &mut Writer,
    message: &Message,
) -> Result<(), GatewayError>
where
    Writer: AsyncWrite + Unpin,
    Message: Serialize,
{
    let message_bytes = serde_json::to_vec(message).map_err(|error| {
        GatewayError::new(
            "INVALID_RESPONSE",
            format!("Could not serialize gateway IPC message: {error}"),
            false,
        )
    })?;
    if message_bytes.len() > MAX_IPC_MESSAGE_BYTES {
        return Err(GatewayError::new(
            "OUTPUT_TOO_LARGE",
            "Gateway IPC message exceeded the configured size limit",
            false,
        ));
    }

    writer
        .write_all(&(message_bytes.len() as u32).to_le_bytes())
        .await?;
    writer.write_all(&message_bytes).await?;
    writer.flush().await?;
    Ok(())
}

fn serialize_framed_message<Message>(message: &Message) -> Result<Vec<u8>, GatewayError>
where
    Message: Serialize,
{
    let message_bytes = serde_json::to_vec(message).map_err(|error| {
        GatewayError::new(
            "INVALID_RESPONSE",
            format!("Could not serialize gateway IPC message: {error}"),
            false,
        )
    })?;
    if message_bytes.len() > MAX_IPC_MESSAGE_BYTES {
        return Err(GatewayError::new(
            "OUTPUT_TOO_LARGE",
            "Gateway IPC message exceeded the configured size limit",
            false,
        ));
    }

    Ok(message_bytes)
}

#[cfg(unix)]
fn write_framed_message_blocking<Writer, Message>(
    writer: &mut Writer,
    message: &Message,
) -> Result<(), GatewayError>
where
    Writer: std::io::Write,
    Message: Serialize,
{
    let message_bytes = serialize_framed_message(message)?;
    write_serialized_framed_message_blocking(writer, &message_bytes)
}

#[cfg(unix)]
fn write_serialized_framed_message_blocking(
    writer: &mut impl std::io::Write,
    message_bytes: &[u8],
) -> Result<(), GatewayError> {
    std::io::Write::write_all(writer, &(message_bytes.len() as u32).to_le_bytes())?;
    std::io::Write::write_all(writer, message_bytes)?;
    std::io::Write::flush(writer)?;
    Ok(())
}

fn prepare_socket_directory(socket_path: &Path) -> Result<(), GatewayError> {
    let directory = socket_path.parent().ok_or_else(|| {
        GatewayError::new(
            "GATEWAY_CONFIGURATION_ERROR",
            "Gateway socket path has no parent directory",
            false,
        )
    })?;
    std::fs::create_dir_all(directory)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn remove_stale_socket(socket_path: &Path) -> Result<(), GatewayError> {
    if !socket_path.exists() {
        return Ok(());
    }

    #[cfg(unix)]
    if std::os::unix::net::UnixStream::connect(socket_path).is_ok() {
        return Err(GatewayError::new(
            "GATEWAY_SOCKET_OCCUPIED",
            "Gateway socket path is occupied by an unverified listener",
            true,
        ));
    }

    std::fs::remove_file(socket_path)?;
    Ok(())
}

struct SocketCleanup {
    path: PathBuf,
}

impl SocketCleanup {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }
}

impl Drop for SocketCleanup {
    fn drop(&mut self) {
        if let Err(error) = std::fs::remove_file(&self.path) {
            if error.kind() != io::ErrorKind::NotFound {
                tracing::warn!("Could not remove Harbor Agent Gateway IPC socket");
            }
        }
    }
}

fn random_request_id() -> String {
    let mut bytes = [0_u8; 18];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("request_{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn server_authentication_error() -> GatewayError {
    GatewayError::new(
        "SERVER_AUTHENTICATION_FAILED",
        "Could not authenticate the browser-connected Harbor host",
        false,
    )
}

pub fn create_browser_request_id() -> String {
    let mut bytes = [0_u8; 18];
    rand::thread_rng().fill_bytes(&mut bytes);
    format!("bridge_request_{}", URL_SAFE_NO_PAD.encode(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn framed_messages_round_trip() {
        let (mut client, mut server) = tokio::io::duplex(4096);
        let expected = IpcMessage::Request {
            id: "request-1".to_string(),
            method: "agentGateway.tabs.list".to_string(),
            session_id: Some("session-1".to_string()),
            params: serde_json::json!({}),
        };

        let writer = tokio::spawn(async move {
            write_framed_message(&mut client, &expected).await.unwrap();
        });
        let actual: IpcMessage = read_framed_message(&mut server).await.unwrap();
        writer.await.unwrap();

        match actual {
            IpcMessage::Request {
                id,
                method,
                session_id,
                ..
            } => {
                assert_eq!(id, "request-1");
                assert_eq!(method, "agentGateway.tabs.list");
                assert_eq!(session_id.as_deref(), Some("session-1"));
            }
            _ => panic!("unexpected IPC message"),
        }
    }

    #[tokio::test]
    async fn oversized_frames_are_rejected_before_allocating_the_body() {
        let (mut client, mut server) = tokio::io::duplex(16);
        client
            .write_all(&((MAX_IPC_MESSAGE_BYTES + 1) as u32).to_le_bytes())
            .await
            .unwrap();

        let error = read_framed_message::<_, IpcMessage>(&mut server)
            .await
            .unwrap_err();

        assert_eq!(error.code, "OUTPUT_TOO_LARGE");
    }

    #[tokio::test]
    async fn silent_connection_times_out_before_authentication() {
        let (_silent_client, mut server) = tokio::io::duplex(16);

        let error = read_client_hello_with_timeout(&mut server, Duration::from_millis(5))
            .await
            .unwrap_err();

        assert_eq!(error.code, "RATE_LIMITED");
    }

    #[tokio::test]
    async fn fake_server_cannot_learn_reusable_client_credentials() {
        let (directory, _store, credentials, authorization) = paired_test_client();
        let stolen_registration_record = authorization.registration_record;
        let (mut client_stream, mut fake_server_stream) = tokio::io::duplex(4096);
        let fake_server = tokio::spawn(async move {
            let hello: IpcMessage = read_framed_message(&mut fake_server_stream).await.unwrap();
            let serialized_hello = serde_json::to_string(&hello).unwrap();
            write_framed_message(
                &mut fake_server_stream,
                &IpcMessage::ServerChallenge {
                    browser_instance_id: "browser-impostor".to_string(),
                    credential_response: URL_SAFE_NO_PAD.encode([0_u8; 32]),
                },
            )
            .await
            .unwrap();
            let next_message = tokio::time::timeout(
                Duration::from_millis(50),
                read_framed_message::<_, IpcMessage>(&mut fake_server_stream),
            )
            .await;
            (serialized_hello, next_message)
        });

        let error = authenticate_native_host(&mut client_stream, &credentials)
            .await
            .unwrap_err();
        let (serialized_hello, next_message) = fake_server.await.unwrap();

        assert_eq!(error.code, "SERVER_AUTHENTICATION_FAILED");
        assert!(!serialized_hello.contains(&credentials.secret));
        assert!(!serialized_hello.contains(&stolen_registration_record));
        assert!(next_message.is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn legitimate_mutual_authentication_passes() {
        let directory =
            std::env::temp_dir().join(format!("harbor-gateway-ipc-test-{}", random_request_id()));
        let store = GatewayConfigStore::new(directory.join("agent_gateway.json"));
        store.set_enabled(true).unwrap();
        let pairing = store.pair_client("Test Agent", None).unwrap();
        let credentials = GatewayCredentials {
            client_id: pairing["client"]["id"].as_str().unwrap().to_string(),
            secret: pairing["secret"].as_str().unwrap().to_string(),
        };
        let (mut client_stream, mut server_stream) = tokio::io::duplex(4096);
        let server_store = store.clone();
        let server = tokio::spawn(async move {
            let (client_id, client_nonce) =
                read_client_hello_with_timeout(&mut server_stream, Duration::from_secs(1))
                    .await
                    .unwrap();
            let authenticated_client = complete_server_authentication(
                &mut server_stream,
                &server_store,
                client_id,
                client_nonce,
                "browser-legitimate",
            )
            .await
            .unwrap();
            write_framed_message(
                &mut server_stream,
                &IpcMessage::Authenticated {
                    browser_instance_id: "browser-legitimate".to_string(),
                    server_confirmation: authenticated_client.server_confirmation.clone(),
                },
            )
            .await
            .unwrap();
            authenticated_client
        });

        let browser_instance_id = authenticate_native_host(&mut client_stream, &credentials)
            .await
            .unwrap();
        let authenticated_client = server.await.unwrap();

        assert_eq!(browser_instance_id, "browser-legitimate");
        assert_eq!(authenticated_client.client_id, credentials.client_id);
        assert!(!authenticated_client.registration_record.is_empty());
        assert_ne!(authenticated_client.registration_record, credentials.secret);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn wrong_secret_cannot_finish_opaque_login() {
        let (directory, _store, credentials, authorization) = paired_test_client();
        let (_, server_public_key) = credentials.secret.rsplit_once('.').unwrap();
        let wrong_credential = format!("harbor_v2_wrong-password.{server_public_key}");
        let (client_state, credential_request) =
            opaque_auth::start_client_login(&wrong_credential).unwrap();
        let (_server_state, credential_response) = opaque_auth::start_server_login(
            &authorization.server_setup,
            &authorization.registration_record,
            &credentials.client_id,
            b"browser-test",
            &credential_request,
        )
        .unwrap();

        let error = opaque_auth::finish_client_login(
            client_state,
            &credentials.client_id,
            b"browser-test",
            &credential_response,
        )
        .unwrap_err();

        assert_eq!(error.code, "SERVER_AUTHENTICATION_FAILED");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn captured_client_proof_cannot_be_replayed_for_a_new_exchange() {
        let (directory, _store, credentials, authorization) = paired_test_client();
        let (first_client_state, first_request) =
            opaque_auth::start_client_login(&credentials.secret).unwrap();
        let (first_server_state, first_response) = opaque_auth::start_server_login(
            &authorization.server_setup,
            &authorization.registration_record,
            &credentials.client_id,
            b"browser-first",
            &first_request,
        )
        .unwrap();
        let first_client_finish = opaque_auth::finish_client_login(
            first_client_state,
            &credentials.client_id,
            b"browser-first",
            &first_response,
        )
        .unwrap();
        opaque_auth::finish_server_login(
            first_server_state,
            &first_client_finish.credential_finalization,
        )
        .unwrap();
        let (_second_client_state, second_request) =
            opaque_auth::start_client_login(&credentials.secret).unwrap();
        let (second_server_state, _second_response) = opaque_auth::start_server_login(
            &authorization.server_setup,
            &authorization.registration_record,
            &credentials.client_id,
            b"browser-second",
            &second_request,
        )
        .unwrap();

        let error = opaque_auth::finish_server_login(
            second_server_state,
            &first_client_finish.credential_finalization,
        )
        .unwrap_err();

        assert_eq!(error.code, "GATEWAY_NOT_PAIRED");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stolen_registration_record_cannot_construct_an_accepted_client_proof() {
        let (directory, _store, credentials, authorization) = paired_test_client();
        let (_, server_public_key) = credentials.secret.rsplit_once('.').unwrap();
        let attacker_credential =
            format!("harbor_v2_attacker-does-not-know-password.{server_public_key}");
        let (attacker_state, request) =
            opaque_auth::start_client_login(&attacker_credential).unwrap();
        let (server_state, response) = opaque_auth::start_server_login(
            &authorization.server_setup,
            &authorization.registration_record,
            &credentials.client_id,
            b"browser-stolen-record",
            &request,
        )
        .unwrap();

        let client_error = opaque_auth::finish_client_login(
            attacker_state,
            &credentials.client_id,
            b"browser-stolen-record",
            &response,
        )
        .unwrap_err();
        let server_error =
            opaque_auth::finish_server_login(server_state, &URL_SAFE_NO_PAD.encode([0_u8; 64]))
                .unwrap_err();

        assert_eq!(client_error.code, "SERVER_AUTHENTICATION_FAILED");
        assert_eq!(server_error.code, "GATEWAY_NOT_PAIRED");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn connection_admission_is_bounded() {
        let admission = create_connection_admission();
        let mut permits = Vec::new();
        for _ in 0..MAX_CONCURRENT_IPC_CONNECTIONS {
            permits.push(admission.clone().try_acquire_owned().unwrap());
        }

        assert!(admission.clone().try_acquire_owned().is_err());
        permits.pop();
        assert!(admission.try_acquire_owned().is_ok());
    }

    #[test]
    fn authentication_attempts_are_token_bucket_limited() {
        let mut limiter = AuthenticationRateLimiter::new();
        for _ in 0..AUTHENTICATION_BURST_CAPACITY as usize {
            assert!(limiter.try_acquire());
        }

        assert!(!limiter.try_acquire());
    }

    #[tokio::test]
    async fn browser_methods_require_a_session() {
        let (request_tx, _request_rx) = mpsc::channel(1);

        let error = forward_browser_request(
            &request_tx,
            "agentGateway.tabs.list".to_string(),
            "client-1".to_string(),
            None,
            serde_json::json!({}),
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, "INVALID_PARAMS");
    }

    #[tokio::test]
    async fn only_declared_browser_methods_are_forwarded() {
        let (request_tx, _request_rx) = mpsc::channel(1);

        let error = forward_browser_request(
            &request_tx,
            "system.health".to_string(),
            "client-1".to_string(),
            Some("session-1".to_string()),
            serde_json::json!({}),
        )
        .await
        .unwrap_err();

        assert_eq!(error.code, "METHOD_NOT_FOUND");
    }

    #[test]
    fn bridge_correlation_ids_do_not_reuse_client_request_ids() {
        let first = create_browser_request_id();
        let second = create_browser_request_id();

        assert!(first.starts_with("bridge_request_"));
        assert!(second.starts_with("bridge_request_"));
        assert_ne!(first, second);
    }

    #[test]
    #[cfg(unix)]
    fn committed_revocation_wins_race_between_recheck_and_socket_write() {
        let directory =
            std::env::temp_dir().join(format!("harbor-gateway-ipc-test-{}", random_request_id()));
        let store = GatewayConfigStore::new(directory.join("agent_gateway.json"));
        store.set_enabled(true).unwrap();
        let pairing = store.pair_client("Test Agent", None).unwrap();
        let client_id = pairing["client"]["id"].as_str().unwrap().to_string();
        let authorization = store.begin_client_authentication(&client_id).unwrap();
        let authorization_lease = authorization.lease;
        let registration_record = authorization.registration_record;
        store
            .verify_client_registration(&client_id, &registration_record)
            .unwrap();

        let admin_store = store.clone();
        let admin_client_id = client_id.clone();
        std::thread::spawn(move || admin_store.revoke_client(&admin_client_id).unwrap())
            .join()
            .unwrap();

        let (server_stream, mut client_stream) = std::os::unix::net::UnixStream::pair().unwrap();
        write_authorized_success_response(
            server_stream,
            store,
            client_id,
            registration_record,
            authorization_lease,
            Arc::new(AtomicBool::new(true)),
            "request-1".to_string(),
            serde_json::json!({ "sensitive": "page result" }),
        )
        .unwrap();

        let response = read_framed_message_blocking(&mut client_stream);
        assert_response_blocks_sensitive_result(response, "GATEWAY_NOT_PAIRED");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn committed_disable_wins_race_between_recheck_and_socket_write() {
        let directory =
            std::env::temp_dir().join(format!("harbor-gateway-ipc-test-{}", random_request_id()));
        let store = GatewayConfigStore::new(directory.join("agent_gateway.json"));
        store.set_enabled(true).unwrap();
        let pairing = store.pair_client("Test Agent", None).unwrap();
        let client_id = pairing["client"]["id"].as_str().unwrap().to_string();
        let authorization = store.begin_client_authentication(&client_id).unwrap();
        let authorization_lease = authorization.lease;
        let registration_record = authorization.registration_record;
        store
            .verify_client_registration(&client_id, &registration_record)
            .unwrap();

        let admin_store = store.clone();
        std::thread::spawn(move || admin_store.set_enabled(false).unwrap())
            .join()
            .unwrap();

        let (server_stream, mut client_stream) = std::os::unix::net::UnixStream::pair().unwrap();
        write_authorized_success_response(
            server_stream,
            store,
            client_id,
            registration_record,
            authorization_lease,
            Arc::new(AtomicBool::new(true)),
            "request-1".to_string(),
            serde_json::json!({ "sensitive": "page result" }),
        )
        .unwrap();

        let response = read_framed_message_blocking(&mut client_stream);
        assert_response_blocks_sensitive_result(response, "GATEWAY_DISABLED");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn successful_results_are_blocked_after_browser_disconnect() {
        let directory =
            std::env::temp_dir().join(format!("harbor-gateway-ipc-test-{}", random_request_id()));
        let store = GatewayConfigStore::new(directory.join("agent_gateway.json"));
        store.set_enabled(true).unwrap();
        let pairing = store.pair_client("Test Agent", None).unwrap();
        let client_id = pairing["client"]["id"].as_str().unwrap().to_string();
        let authorization = store.begin_client_authentication(&client_id).unwrap();
        let authorization_lease = authorization.lease;
        let registration_record = authorization.registration_record;
        let (server_stream, mut client_stream) = std::os::unix::net::UnixStream::pair().unwrap();

        write_authorized_success_response(
            server_stream,
            store,
            client_id,
            registration_record,
            authorization_lease,
            Arc::new(AtomicBool::new(false)),
            "request-1".to_string(),
            serde_json::json!({ "browserConnected": true }),
        )
        .unwrap();

        let response = read_framed_message_blocking(&mut client_stream);
        assert_response_blocks_sensitive_result(response, "BROWSER_DISCONNECTED");
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    #[cfg(unix)]
    fn non_reading_client_cannot_indefinitely_block_admin_mutation() {
        let directory =
            std::env::temp_dir().join(format!("harbor-gateway-ipc-test-{}", random_request_id()));
        let store = GatewayConfigStore::new(directory.join("agent_gateway.json"));
        store.set_enabled(true).unwrap();
        let pairing = store.pair_client("Test Agent", None).unwrap();
        let client_id = pairing["client"]["id"].as_str().unwrap().to_string();
        let authorization = store.begin_client_authentication(&client_id).unwrap();
        let authorization_lease = authorization.lease;
        let registration_record = authorization.registration_record;
        let (mut server_stream, _non_reading_client) =
            std::os::unix::net::UnixStream::pair().unwrap();
        fill_socket_send_buffer(&mut server_stream);
        let (release_started_tx, release_started_rx) = std::sync::mpsc::channel();
        let release_store = store.clone();

        let release_thread = std::thread::spawn(move || {
            write_authorized_success_response_with_hook(
                server_stream,
                release_store,
                client_id,
                registration_record,
                authorization_lease,
                Arc::new(AtomicBool::new(true)),
                "request-1".to_string(),
                serde_json::json!({ "sensitive": "page result" }),
                move || {
                    let _ = release_started_tx.send(());
                },
            )
        });
        release_started_rx
            .recv_timeout(Duration::from_secs(10))
            .unwrap();

        let mutation_started = std::time::Instant::now();
        store.set_enabled(false).unwrap();
        let mutation_duration = mutation_started.elapsed();

        assert!(mutation_duration >= AUTHORIZED_RESPONSE_WRITE_TIMEOUT / 2);
        assert!(mutation_duration < AUTHORIZED_RESPONSE_WRITE_TIMEOUT + Duration::from_secs(1));
        assert!(release_thread.join().unwrap().is_err());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn active_gateway_socket_is_never_unlinked() {
        let directory = PathBuf::from("/tmp").join(format!("hgw-{}", random_request_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let socket_path = directory.join("agent-gateway.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket_path).unwrap();

        let error = remove_stale_socket(&socket_path).unwrap_err();

        assert_eq!(error.code, "GATEWAY_SOCKET_OCCUPIED");
        assert!(error.message.contains("unverified listener"));
        assert!(socket_path.exists());
        drop(listener);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn socket_cleanup_removes_the_owned_endpoint() {
        let directory = PathBuf::from("/tmp").join(format!("hgw-{}", random_request_id()));
        std::fs::create_dir_all(&directory).unwrap();
        let socket_path = directory.join("agent-gateway.sock");
        std::fs::write(&socket_path, b"test socket placeholder").unwrap();

        drop(SocketCleanup::new(socket_path.clone()));

        assert!(!socket_path.exists());
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    fn read_framed_message_blocking(reader: &mut impl std::io::Read) -> IpcMessage {
        let mut length_bytes = [0_u8; 4];
        std::io::Read::read_exact(reader, &mut length_bytes).unwrap();
        let mut message_bytes = vec![0_u8; u32::from_le_bytes(length_bytes) as usize];
        std::io::Read::read_exact(reader, &mut message_bytes).unwrap();
        serde_json::from_slice(&message_bytes).unwrap()
    }

    fn assert_response_blocks_sensitive_result(response: IpcMessage, expected_code: &str) {
        match response {
            IpcMessage::Response { result, error, .. } => {
                assert!(result.is_none());
                assert_eq!(error.unwrap().code, expected_code);
            }
            _ => panic!("unexpected IPC message"),
        }
    }

    fn paired_test_client() -> (
        PathBuf,
        GatewayConfigStore,
        GatewayCredentials,
        super::super::config::ClientAuthorization,
    ) {
        let directory =
            std::env::temp_dir().join(format!("harbor-gateway-ipc-test-{}", random_request_id()));
        let store = GatewayConfigStore::new(directory.join("agent_gateway.json"));
        store.set_enabled(true).unwrap();
        let pairing = store.pair_client("Test Agent", None).unwrap();
        let credentials = GatewayCredentials {
            client_id: pairing["client"]["id"].as_str().unwrap().to_string(),
            secret: pairing["secret"].as_str().unwrap().to_string(),
        };
        let authorization = store
            .begin_client_authentication(&credentials.client_id)
            .unwrap();
        (directory, store, credentials, authorization)
    }

    #[cfg(unix)]
    fn fill_socket_send_buffer(stream: &mut std::os::unix::net::UnixStream) {
        stream.set_nonblocking(true).unwrap();
        let filler = [0_u8; 8192];
        loop {
            match std::io::Write::write(stream, &filler) {
                Ok(_) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                Err(error) => panic!("could not fill test socket send buffer: {error}"),
            }
        }
        stream.set_nonblocking(false).unwrap();
    }
}
