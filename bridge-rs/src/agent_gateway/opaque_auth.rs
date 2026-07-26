use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use hmac::{Hmac, Mac};
use opaque_ke::argon2::Argon2;
use opaque_ke::rand::rngs::OsRng;
use opaque_ke::{
    CipherSuite, ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialFinalization, CredentialRequest,
    CredentialResponse, Identifiers, ServerLogin, ServerLoginParameters, ServerRegistration,
    ServerSetup, TripleDh,
};
use sha2::Sha512;

use super::config::GatewayError;

const CREDENTIAL_PREFIX: &str = "harbor_v2_";
const SERVER_IDENTITY: &[u8] = b"harbor-agent-gateway";
const CONFIRMATION_DOMAIN: &[u8] = b"harbor-agent-gateway/opaque-confirmation/v1";

struct GatewayCipherSuite;

impl CipherSuite for GatewayCipherSuite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = TripleDh<opaque_ke::Ristretto255, Sha512>;
    type Ksf = Argon2<'static>;
}

pub(crate) struct RegistrationMaterial {
    pub credential: String,
    pub registration_record: String,
}

pub(crate) struct ClientLoginState {
    state: ClientLogin<GatewayCipherSuite>,
    password: String,
    expected_server_public_key: Vec<u8>,
}

#[derive(Debug)]
pub(crate) struct ClientLoginFinish {
    pub credential_finalization: String,
    pub session_key: Vec<u8>,
}

pub(crate) struct ServerLoginState {
    state: ServerLogin<GatewayCipherSuite>,
    client_id: String,
    context: Vec<u8>,
}

pub(crate) fn create_server_setup() -> String {
    let setup = ServerSetup::<GatewayCipherSuite>::new(&mut OsRng);
    URL_SAFE_NO_PAD.encode(setup.serialize())
}

pub(crate) fn register_client(
    serialized_server_setup: &str,
    client_id: &str,
    password: &str,
) -> Result<RegistrationMaterial, GatewayError> {
    let server_setup = deserialize_server_setup(serialized_server_setup)?;
    let client_start =
        ClientRegistration::<GatewayCipherSuite>::start(&mut OsRng, password.as_bytes())
            .map_err(|_| opaque_configuration_error("Could not start OPAQUE registration"))?;
    let server_start = ServerRegistration::<GatewayCipherSuite>::start(
        &server_setup,
        client_start.message,
        client_id.as_bytes(),
    )
    .map_err(|_| opaque_configuration_error("Could not evaluate OPAQUE registration"))?;
    let client_finish = client_start
        .state
        .finish(
            &mut OsRng,
            password.as_bytes(),
            server_start.message,
            ClientRegistrationFinishParameters::new(identifiers(client_id), None),
        )
        .map_err(|_| opaque_configuration_error("Could not finish OPAQUE registration"))?;
    let server_public_key = URL_SAFE_NO_PAD.encode(client_finish.server_s_pk.serialize());
    let registration_record =
        ServerRegistration::<GatewayCipherSuite>::finish(client_finish.message);

    Ok(RegistrationMaterial {
        credential: format!("{CREDENTIAL_PREFIX}{password}.{server_public_key}"),
        registration_record: URL_SAFE_NO_PAD.encode(registration_record.serialize()),
    })
}

pub(crate) fn start_client_login(
    credential: &str,
) -> Result<(ClientLoginState, String), GatewayError> {
    let (password, expected_server_public_key) = parse_client_credential(credential)?;
    let client_start = ClientLogin::<GatewayCipherSuite>::start(&mut OsRng, password.as_bytes())
        .map_err(|_| authentication_error())?;
    let request = URL_SAFE_NO_PAD.encode(client_start.message.serialize());

    Ok((
        ClientLoginState {
            state: client_start.state,
            password,
            expected_server_public_key,
        },
        request,
    ))
}

pub(crate) fn finish_client_login(
    client_state: ClientLoginState,
    client_id: &str,
    context: &[u8],
    serialized_response: &str,
) -> Result<ClientLoginFinish, GatewayError> {
    let response_bytes = decode_message(serialized_response)?;
    let response = CredentialResponse::<GatewayCipherSuite>::deserialize(&response_bytes)
        .map_err(|_| server_authentication_error())?;
    let finish = client_state
        .state
        .finish(
            &mut OsRng,
            client_state.password.as_bytes(),
            response,
            ClientLoginFinishParameters::new(Some(context), identifiers(client_id), None),
        )
        .map_err(|_| server_authentication_error())?;
    if finish.server_s_pk.serialize().as_slice()
        != client_state.expected_server_public_key.as_slice()
    {
        return Err(server_authentication_error());
    }

    Ok(ClientLoginFinish {
        credential_finalization: URL_SAFE_NO_PAD.encode(finish.message.serialize()),
        session_key: finish.session_key.to_vec(),
    })
}

pub(crate) fn start_server_login(
    serialized_server_setup: &str,
    serialized_registration_record: &str,
    client_id: &str,
    context: &[u8],
    serialized_request: &str,
) -> Result<(ServerLoginState, String), GatewayError> {
    let server_setup = deserialize_server_setup(serialized_server_setup)?;
    let record_bytes = decode_configuration(serialized_registration_record)?;
    let registration_record = ServerRegistration::<GatewayCipherSuite>::deserialize(&record_bytes)
        .map_err(|_| opaque_configuration_error("Invalid OPAQUE registration record"))?;
    let request_bytes = decode_message(serialized_request)?;
    let request = CredentialRequest::<GatewayCipherSuite>::deserialize(&request_bytes)
        .map_err(|_| authentication_error())?;
    let parameters = ServerLoginParameters {
        context: Some(context),
        identifiers: identifiers(client_id),
    };
    let server_start = ServerLogin::start(
        &mut OsRng,
        &server_setup,
        Some(registration_record),
        request,
        client_id.as_bytes(),
        parameters,
    )
    .map_err(|_| authentication_error())?;
    let response = URL_SAFE_NO_PAD.encode(server_start.message.serialize());

    Ok((
        ServerLoginState {
            state: server_start.state,
            client_id: client_id.to_string(),
            context: context.to_vec(),
        },
        response,
    ))
}

pub(crate) fn finish_server_login(
    server_state: ServerLoginState,
    serialized_finalization: &str,
) -> Result<Vec<u8>, GatewayError> {
    let finalization_bytes = decode_message(serialized_finalization)?;
    let finalization =
        CredentialFinalization::<GatewayCipherSuite>::deserialize(&finalization_bytes)
            .map_err(|_| authentication_error())?;
    let parameters = ServerLoginParameters {
        context: Some(&server_state.context),
        identifiers: identifiers(&server_state.client_id),
    };
    let finish = server_state
        .state
        .finish(finalization, parameters)
        .map_err(|_| authentication_error())?;

    Ok(finish.session_key.to_vec())
}

pub(crate) fn create_server_confirmation(
    session_key: &[u8],
    client_id: &str,
    browser_instance_id: &str,
) -> String {
    let mut mac = Hmac::<Sha512>::new_from_slice(session_key)
        .expect("OPAQUE session keys satisfy HMAC key requirements");
    mac.update(CONFIRMATION_DOMAIN);
    update_length_prefixed(&mut mac, client_id.as_bytes());
    update_length_prefixed(&mut mac, browser_instance_id.as_bytes());
    URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

pub(crate) fn verify_server_confirmation(
    session_key: &[u8],
    client_id: &str,
    browser_instance_id: &str,
    confirmation: &str,
) -> Result<(), GatewayError> {
    let confirmation_bytes = URL_SAFE_NO_PAD
        .decode(confirmation)
        .map_err(|_| server_authentication_error())?;
    let mut mac = Hmac::<Sha512>::new_from_slice(session_key)
        .expect("OPAQUE session keys satisfy HMAC key requirements");
    mac.update(CONFIRMATION_DOMAIN);
    update_length_prefixed(&mut mac, client_id.as_bytes());
    update_length_prefixed(&mut mac, browser_instance_id.as_bytes());
    mac.verify_slice(&confirmation_bytes)
        .map_err(|_| server_authentication_error())
}

fn deserialize_server_setup(
    serialized_server_setup: &str,
) -> Result<ServerSetup<GatewayCipherSuite>, GatewayError> {
    let setup_bytes = decode_configuration(serialized_server_setup)?;
    ServerSetup::<GatewayCipherSuite>::deserialize(&setup_bytes)
        .map_err(|_| opaque_configuration_error("Invalid OPAQUE server setup"))
}

fn parse_client_credential(credential: &str) -> Result<(String, Vec<u8>), GatewayError> {
    let encoded = credential
        .strip_prefix(CREDENTIAL_PREFIX)
        .ok_or_else(authentication_error)?;
    let (password, server_public_key) = encoded.split_once('.').ok_or_else(authentication_error)?;
    if password.is_empty() {
        return Err(authentication_error());
    }
    let server_public_key = URL_SAFE_NO_PAD
        .decode(server_public_key)
        .map_err(|_| authentication_error())?;
    if server_public_key.is_empty() {
        return Err(authentication_error());
    }
    Ok((password.to_string(), server_public_key))
}

fn identifiers(client_id: &str) -> Identifiers<'_> {
    Identifiers {
        client: Some(client_id.as_bytes()),
        server: Some(SERVER_IDENTITY),
    }
}

fn decode_configuration(value: &str) -> Result<Vec<u8>, GatewayError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| opaque_configuration_error("OPAQUE configuration contains invalid encoding"))
}

fn decode_message(value: &str) -> Result<Vec<u8>, GatewayError> {
    URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| authentication_error())
}

fn update_length_prefixed(mac: &mut Hmac<Sha512>, value: &[u8]) {
    mac.update(&(value.len() as u32).to_be_bytes());
    mac.update(value);
}

fn authentication_error() -> GatewayError {
    GatewayError::new(
        "GATEWAY_NOT_PAIRED",
        "Gateway client authentication failed",
        false,
    )
}

fn server_authentication_error() -> GatewayError {
    GatewayError::new(
        "SERVER_AUTHENTICATION_FAILED",
        "Could not authenticate the browser-connected Harbor host",
        false,
    )
}

fn opaque_configuration_error(message: &str) -> GatewayError {
    GatewayError::new("GATEWAY_CONFIGURATION_ERROR", message, false)
}
