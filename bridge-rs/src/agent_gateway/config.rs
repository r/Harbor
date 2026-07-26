use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};

use super::opaque_auth;

const CONFIG_FILE_NAME: &str = "agent_gateway.json";
const CONFIG_VERSION: u32 = 2;
static AUTHORIZATION_STATE: OnceLock<Mutex<AuthorizationState>> = OnceLock::new();

#[derive(Default)]
struct AuthorizationState {
    generations: HashMap<PathBuf, u64>,
}

impl AuthorizationState {
    fn generation(&self, path: &Path) -> u64 {
        self.generations.get(path).copied().unwrap_or(0)
    }

    fn advance(&mut self, path: &Path) {
        let generation = self.generations.entry(path.to_path_buf()).or_insert(0);
        *generation = generation.wrapping_add(1);
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct AuthorizationLease {
    generation: u64,
}

#[derive(Debug)]
pub(crate) struct ClientAuthorization {
    pub lease: AuthorizationLease,
    pub registration_record: String,
    pub server_setup: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct GatewayError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl GatewayError {
    pub fn new(code: impl Into<String>, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable,
            data: None,
        }
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }

    pub fn from_browser(error: serde_json::Value) -> Self {
        let browser_code = error
            .get("code")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("TOOL_CALL_FAILED");
        let code = match browser_code {
            "CLIENT_NOT_PAIRED" | "CLIENT_REVOKED" => "GATEWAY_NOT_PAIRED",
            "SCOPE_NOT_GRANTED" | "SESSION_CLIENT_MISMATCH" => "PERMISSION_DENIED",
            "TARGET_UNAVAILABLE" => "TAB_GONE",
            "TARGET_CHANGED" => "DOCUMENT_CHANGED",
            "INTERNAL_ERROR" => "TOOL_CALL_FAILED",
            "INVALID_REQUEST" => "INVALID_PARAMS",
            other => other,
        };
        let message = error
            .get("message")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Browser request failed");
        let retryable = error
            .get("retryable")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);

        Self::new(code, message, retryable).with_data(error)
    }
}

impl From<io::Error> for GatewayError {
    fn from(error: io::Error) -> Self {
        Self::new(
            "GATEWAY_CONFIGURATION_ERROR",
            format!("Gateway configuration error: {error}"),
            false,
        )
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct GatewayConfig {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    opaque_server_setup: String,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    clients: Vec<ClientRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ClientRecord {
    id: String,
    display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    client_version: Option<String>,
    #[serde(default)]
    opaque_registration_record: String,
    created_at: String,
    #[serde(default)]
    revoked: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    revoked_at: Option<String>,
}

impl ClientRecord {
    fn metadata(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id,
            "displayName": self.display_name,
            "clientVersion": self.client_version,
            "createdAt": self.created_at,
            "revoked": self.revoked,
            "revokedAt": self.revoked_at,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct GatewayConfigStore {
    path: PathBuf,
}

impl GatewayConfigStore {
    pub(crate) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub(crate) fn default_store() -> Result<Self, GatewayError> {
        let config_directory = dirs::config_dir().ok_or_else(|| {
            GatewayError::new(
                "GATEWAY_CONFIGURATION_ERROR",
                "Could not determine the user configuration directory",
                false,
            )
        })?;

        Ok(Self::new(
            config_directory.join("harbor").join(CONFIG_FILE_NAME),
        ))
    }

    fn load(&self) -> Result<GatewayConfig, GatewayError> {
        if !self.path.exists() {
            return Ok(new_gateway_config());
        }

        let contents = fs::read_to_string(&self.path)?;
        let config: GatewayConfig = serde_json::from_str(&contents).map_err(|error| {
            GatewayError::new(
                "GATEWAY_CONFIGURATION_ERROR",
                format!("Invalid gateway configuration: {error}"),
                false,
            )
        })?;
        validate_config_version(&config)?;
        Ok(config)
    }

    fn save(&self, config: &GatewayConfig) -> Result<(), GatewayError> {
        let parent = self.path.parent().ok_or_else(|| {
            GatewayError::new(
                "GATEWAY_CONFIGURATION_ERROR",
                "Gateway configuration path has no parent directory",
                false,
            )
        })?;
        create_user_private_directory(parent)?;

        let temporary_path = self.path.with_extension("json.tmp");
        let contents = serde_json::to_vec_pretty(config).map_err(|error| {
            GatewayError::new(
                "GATEWAY_CONFIGURATION_ERROR",
                format!("Could not serialize gateway configuration: {error}"),
                false,
            )
        })?;
        fs::write(&temporary_path, contents)?;
        set_user_private_file_permissions(&temporary_path)?;
        fs::rename(&temporary_path, &self.path)?;
        set_user_private_file_permissions(&self.path)?;
        Ok(())
    }

    pub(crate) fn metadata(&self) -> Result<serde_json::Value, GatewayError> {
        let config = self.load()?;
        let clients: Vec<_> = config.clients.iter().map(ClientRecord::metadata).collect();

        Ok(serde_json::json!({
            "enabled": config.enabled,
            "clients": clients,
        }))
    }

    pub(crate) fn set_enabled(&self, enabled: bool) -> Result<serde_json::Value, GatewayError> {
        let mut authorization = authorization_guard()?;
        let mut config = self.load()?;
        config.enabled = enabled;
        self.save(&config)?;
        authorization.advance(&self.path);
        Ok(serde_json::json!({ "enabled": enabled }))
    }

    pub(crate) fn pair_client(
        &self,
        display_name: &str,
        client_version: Option<&str>,
    ) -> Result<serde_json::Value, GatewayError> {
        let mut authorization = authorization_guard()?;
        let normalized_name = display_name.trim();
        if normalized_name.is_empty() || normalized_name.len() > 128 {
            return Err(GatewayError::new(
                "INVALID_PARAMS",
                "displayName must contain between 1 and 128 characters",
                false,
            ));
        }

        let mut config = self.load()?;
        let client_id = format!("client_{}", random_token(18));
        let password = random_token(32);
        let registration =
            opaque_auth::register_client(&config.opaque_server_setup, &client_id, &password)?;
        let record = ClientRecord {
            id: client_id,
            display_name: normalized_name.to_string(),
            client_version: client_version.map(str::to_string),
            opaque_registration_record: registration.registration_record,
            created_at: Utc::now().to_rfc3339(),
            revoked: false,
            revoked_at: None,
        };
        let client_metadata = record.metadata();
        config.clients.push(record);
        self.save(&config)?;
        authorization.advance(&self.path);

        Ok(serde_json::json!({
            "client": client_metadata,
            "secret": registration.credential,
        }))
    }

    pub(crate) fn revoke_client(&self, client_id: &str) -> Result<serde_json::Value, GatewayError> {
        let mut authorization = authorization_guard()?;
        let mut config = self.load()?;
        let client = config
            .clients
            .iter_mut()
            .find(|client| client.id == client_id)
            .ok_or_else(|| {
                GatewayError::new("GATEWAY_NOT_PAIRED", "Paired client was not found", false)
            })?;

        client.revoked = true;
        client.revoked_at = Some(Utc::now().to_rfc3339());
        self.save(&config)?;
        authorization.advance(&self.path);

        Ok(serde_json::json!({
            "clientId": client_id,
            "revoked": true,
        }))
    }

    pub(crate) fn begin_client_authentication(
        &self,
        client_id: &str,
    ) -> Result<ClientAuthorization, GatewayError> {
        let authorization = authorization_guard()?;
        let config = self.load()?;
        let client = active_client(&config, client_id)?;

        Ok(ClientAuthorization {
            lease: AuthorizationLease {
                generation: authorization.generation(&self.path),
            },
            registration_record: client.opaque_registration_record.clone(),
            server_setup: config.opaque_server_setup.clone(),
        })
    }

    pub(crate) fn verify_client_registration(
        &self,
        client_id: &str,
        registration_record: &str,
    ) -> Result<(), GatewayError> {
        let _authorization = authorization_guard()?;
        self.verify_client_registration_unlocked(client_id, registration_record)
    }

    pub(crate) fn with_authorized_registration_lease<ResultValue>(
        &self,
        client_id: &str,
        registration_record: &str,
        lease: AuthorizationLease,
        release: impl FnOnce() -> Result<ResultValue, GatewayError>,
    ) -> Result<ResultValue, GatewayError> {
        let authorization = authorization_guard()?;
        self.verify_client_registration_unlocked(client_id, registration_record)?;
        if authorization.generation(&self.path) != lease.generation {
            return Err(GatewayError::new(
                "PERMISSION_DENIED",
                "Gateway authorization changed while the request was in flight",
                false,
            ));
        }

        release()
    }

    fn verify_client_registration_unlocked(
        &self,
        client_id: &str,
        supplied_registration_record: &str,
    ) -> Result<(), GatewayError> {
        let config = self.load()?;
        let client = active_client(&config, client_id)?;
        if !constant_time_equal(
            client.opaque_registration_record.as_bytes(),
            supplied_registration_record.as_bytes(),
        ) {
            return Err(GatewayError::new(
                "GATEWAY_NOT_PAIRED",
                "Client is not paired or its credential is invalid",
                false,
            ));
        }

        Ok(())
    }
}

fn new_gateway_config() -> GatewayConfig {
    GatewayConfig {
        version: CONFIG_VERSION,
        opaque_server_setup: opaque_auth::create_server_setup(),
        enabled: false,
        clients: Vec::new(),
    }
}

fn validate_config_version(config: &GatewayConfig) -> Result<(), GatewayError> {
    if config.version != CONFIG_VERSION
        || config.opaque_server_setup.is_empty()
        || config
            .clients
            .iter()
            .any(|client| client.opaque_registration_record.is_empty())
    {
        return Err(GatewayError::new(
            "GATEWAY_CONFIGURATION_MIGRATION_REQUIRED",
            "Legacy gateway credentials are invalid; disable the gateway, remove the old configuration, and pair clients again",
            false,
        ));
    }
    Ok(())
}

fn active_client<'a>(
    config: &'a GatewayConfig,
    client_id: &str,
) -> Result<&'a ClientRecord, GatewayError> {
    if !config.enabled {
        return Err(GatewayError::new(
            "GATEWAY_DISABLED",
            "Harbor Agent Gateway is disabled",
            false,
        ));
    }

    config
        .clients
        .iter()
        .find(|client| client.id == client_id && !client.revoked)
        .ok_or_else(|| {
            GatewayError::new(
                "GATEWAY_NOT_PAIRED",
                "Client is not paired or its credential is invalid",
                false,
            )
        })
}

pub fn handle_native_admin(
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, GatewayError> {
    let store = GatewayConfigStore::default_store()?;
    handle_native_admin_with_store(&store, method, params)
}

fn handle_native_admin_with_store(
    store: &GatewayConfigStore,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, GatewayError> {
    match method {
        "agent_gateway.get_config" => store.metadata(),
        "agent_gateway.set_enabled" => {
            let enabled = params
                .get("enabled")
                .and_then(serde_json::Value::as_bool)
                .ok_or_else(|| {
                    GatewayError::new("INVALID_PARAMS", "enabled must be a boolean", false)
                })?;
            store.set_enabled(enabled)
        }
        "agent_gateway.pair_client" => {
            let display_name = params
                .get("displayName")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    GatewayError::new("INVALID_PARAMS", "displayName must be a string", false)
                })?;
            let client_version = params
                .get("clientVersion")
                .and_then(serde_json::Value::as_str);
            store.pair_client(display_name, client_version)
        }
        "agent_gateway.revoke_client" => {
            let client_id = params
                .get("clientId")
                .and_then(serde_json::Value::as_str)
                .ok_or_else(|| {
                    GatewayError::new("INVALID_PARAMS", "clientId must be a string", false)
                })?;
            store.revoke_client(client_id)
        }
        _ => Err(GatewayError::new(
            "METHOD_NOT_FOUND",
            format!("Unknown agent gateway administrative method: {method}"),
            false,
        )),
    }
}

fn random_token(byte_count: usize) -> String {
    let mut bytes = vec![0_u8; byte_count];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

fn authorization_guard() -> Result<MutexGuard<'static, AuthorizationState>, GatewayError> {
    AUTHORIZATION_STATE
        .get_or_init(|| Mutex::new(AuthorizationState::default()))
        .lock()
        .map_err(|_| {
            GatewayError::new(
                "GATEWAY_CONFIGURATION_ERROR",
                "Gateway authorization state is unavailable",
                false,
            )
        })
}

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }

    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left_byte, right_byte)| {
            difference | (left_byte ^ right_byte)
        })
        == 0
}

fn create_user_private_directory(path: &Path) -> Result<(), GatewayError> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_user_private_file_permissions(path: &Path) -> Result<(), GatewayError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_store() -> (PathBuf, GatewayConfigStore) {
        let directory =
            std::env::temp_dir().join(format!("harbor-gateway-test-{}", random_token(12)));
        let store = GatewayConfigStore::new(directory.join(CONFIG_FILE_NAME));
        (directory, store)
    }

    #[test]
    fn gateway_is_disabled_and_has_no_clients_by_default() {
        let (_directory, store) = test_store();

        assert_eq!(
            store.metadata().unwrap(),
            serde_json::json!({ "enabled": false, "clients": [] })
        );
        let error = store.begin_client_authentication("unknown").unwrap_err();
        assert_eq!(error.code, "GATEWAY_DISABLED");
    }

    #[test]
    fn pairing_returns_secret_once_and_persists_only_an_opaque_record() {
        let (directory, store) = test_store();
        store.set_enabled(true).unwrap();

        let pairing = store
            .pair_client("Test Agent", Some("1.0.0"))
            .expect("pairing should succeed");
        let client_id = pairing["client"]["id"].as_str().unwrap();
        let secret = pairing["secret"].as_str().unwrap();
        let authorization = store.begin_client_authentication(client_id).unwrap();

        let persisted = fs::read_to_string(&store.path).unwrap();
        assert!(!persisted.contains(secret));
        assert!(!persisted.contains("secret_verifier"));
        assert!(persisted.contains("\"version\": 2"));
        assert!(!authorization.registration_record.is_empty());

        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn revoked_client_is_rejected_immediately() {
        let (directory, store) = test_store();
        store.set_enabled(true).unwrap();
        let pairing = store.pair_client("Test Agent", None).unwrap();
        let client_id = pairing["client"]["id"].as_str().unwrap();
        store.revoke_client(client_id).unwrap();

        let error = store.begin_client_authentication(client_id).unwrap_err();
        assert_eq!(error.code, "GATEWAY_NOT_PAIRED");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn legacy_hash_records_fail_closed_and_require_repairing() {
        let (directory, store) = test_store();
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            &store.path,
            serde_json::to_vec(&serde_json::json!({
                "enabled": true,
                "clients": [{
                    "id": "legacy-client",
                    "display_name": "Legacy",
                    "secret_verifier": "legacy-hash",
                    "created_at": "2026-01-01T00:00:00Z",
                    "revoked": false
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        let error = store.metadata().unwrap_err();

        assert_eq!(error.code, "GATEWAY_CONFIGURATION_MIGRATION_REQUIRED");
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn malformed_admin_params_fail_without_mutating_configuration() {
        let (directory, store) = test_store();

        let error = handle_native_admin_with_store(
            &store,
            "agent_gateway.set_enabled",
            serde_json::json!({ "enabled": "yes" }),
        )
        .unwrap_err();

        assert_eq!(error.code, "INVALID_PARAMS");
        assert!(!store.metadata().unwrap()["enabled"].as_bool().unwrap());
        if directory.exists() {
            fs::remove_dir_all(directory).unwrap();
        }
    }

    #[test]
    fn browser_policy_errors_are_normalized_to_gateway_codes() {
        let error = GatewayError::from_browser(serde_json::json!({
            "code": "SCOPE_NOT_GRANTED",
            "message": "page read is not granted",
        }));

        assert_eq!(error.code, "PERMISSION_DENIED");
        assert_eq!(
            error.data.unwrap()["code"],
            serde_json::json!("SCOPE_NOT_GRANTED")
        );
    }

    #[cfg(unix)]
    #[test]
    fn fallback_configuration_is_user_private() {
        use std::os::unix::fs::PermissionsExt;

        let (directory, store) = test_store();
        store.set_enabled(true).unwrap();

        let directory_mode = fs::metadata(&directory).unwrap().permissions().mode() & 0o777;
        let file_mode = fs::metadata(&store.path).unwrap().permissions().mode() & 0o777;

        assert_eq!(directory_mode, 0o700);
        assert_eq!(file_mode, 0o600);
        fs::remove_dir_all(directory).unwrap();
    }
}
