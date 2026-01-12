/**
 * Message type constants for the native messaging protocol.
 * 
 * All message types between the extension and bridge are defined here.
 * Using constants instead of raw strings prevents typos and enables
 * IDE autocomplete and refactoring support.
 * 
 * Naming convention:
 * - Request messages: domain_action (e.g., 'catalog_get')
 * - Response messages: domain_action_result (e.g., 'catalog_get_result')
 * - Error responses: 'error'
 */

// =============================================================================
// Core / Connection Messages
// =============================================================================

export const MSG_HELLO = 'hello' as const;
export const MSG_PING = 'ping' as const;
export const MSG_PONG = 'pong' as const;
export const MSG_ERROR = 'error' as const;

// =============================================================================
// Server Store Messages (legacy HTTP-based servers)
// =============================================================================

export const MSG_ADD_SERVER = 'add_server' as const;
export const MSG_REMOVE_SERVER = 'remove_server' as const;
export const MSG_LIST_SERVERS = 'list_servers' as const;
export const MSG_CONNECT_SERVER = 'connect_server' as const;
export const MSG_DISCONNECT_SERVER = 'disconnect_server' as const;
export const MSG_LIST_TOOLS = 'list_tools' as const;
export const MSG_LIST_RESOURCES = 'list_resources' as const;
export const MSG_LIST_PROMPTS = 'list_prompts' as const;
export const MSG_CALL_TOOL = 'call_tool' as const;

// =============================================================================
// Catalog Messages
// =============================================================================

export const MSG_CATALOG_GET = 'catalog_get' as const;
export const MSG_CATALOG_REFRESH = 'catalog_refresh' as const;
export const MSG_CATALOG_SEARCH = 'catalog_search' as const;
export const MSG_CATALOG_ENRICH = 'catalog_enrich' as const;
export const MSG_GET_CURATED_SERVERS = 'get_curated_servers' as const;
export const MSG_GET_CURATED_LIST = 'get_curated_list' as const;
export const MSG_INSTALL_CURATED_SERVER = 'install_curated_server' as const;
export const MSG_INSTALL_CURATED = 'install_curated' as const;
export const MSG_INSTALL_GITHUB_REPO = 'install_github_repo' as const;
export const MSG_INSTALL_FROM_GITHUB = 'install_from_github' as const;

// =============================================================================
// Installer Messages
// =============================================================================

export const MSG_CHECK_RUNTIMES = 'check_runtimes' as const;
export const MSG_INSTALL_SERVER = 'install_server' as const;
export const MSG_ADD_REMOTE_SERVER = 'add_remote_server' as const;
export const MSG_IMPORT_CONFIG = 'import_config' as const;
export const MSG_RESOLVE_GITHUB = 'resolve_github' as const;
export const MSG_RESOLVE_SERVER_PACKAGE = 'resolve_server_package' as const;
export const MSG_UNINSTALL_SERVER = 'uninstall_server' as const;
export const MSG_LIST_INSTALLED = 'list_installed' as const;
export const MSG_START_INSTALLED = 'start_installed' as const;
export const MSG_STOP_INSTALLED = 'stop_installed' as const;
export const MSG_SET_SERVER_SECRETS = 'set_server_secrets' as const;
export const MSG_UPDATE_SERVER_ARGS = 'update_server_args' as const;
export const MSG_GET_SERVER_STATUS = 'get_server_status' as const;

// =============================================================================
// Manifest-based Installation Messages
// =============================================================================

export const MSG_INSTALL_FROM_MANIFEST = 'install_from_manifest' as const;
export const MSG_CHECK_MANIFEST_OAUTH = 'check_manifest_oauth' as const;
export const MSG_MANIFEST_OAUTH_START = 'manifest_oauth_start' as const;
export const MSG_MANIFEST_OAUTH_STATUS = 'manifest_oauth_status' as const;
export const MSG_START_MANIFEST_SERVER = 'start_manifest_server' as const;
export const MSG_GET_SERVER_MANIFEST = 'get_server_manifest' as const;
export const MSG_GET_OAUTH_CAPABILITIES = 'get_oauth_capabilities' as const;

// =============================================================================
// Docker Messages
// =============================================================================

export const MSG_CHECK_DOCKER = 'check_docker' as const;
export const MSG_RECONNECT_ORPHANED_CONTAINERS = 'reconnect_orphaned_containers' as const;
export const MSG_BUILD_DOCKER_IMAGES = 'build_docker_images' as const;
export const MSG_SET_DOCKER_MODE = 'set_docker_mode' as const;
export const MSG_SHOULD_PREFER_DOCKER = 'should_prefer_docker' as const;

// =============================================================================
// MCP Connection Messages (stdio-based local servers)
// =============================================================================

export const MSG_MCP_CONNECT = 'mcp_connect' as const;
export const MSG_MCP_DISCONNECT = 'mcp_disconnect' as const;
export const MSG_MCP_LIST_CONNECTIONS = 'mcp_list_connections' as const;
export const MSG_MCP_LIST_TOOLS = 'mcp_list_tools' as const;
export const MSG_MCP_LIST_RESOURCES = 'mcp_list_resources' as const;
export const MSG_MCP_LIST_PROMPTS = 'mcp_list_prompts' as const;
export const MSG_MCP_CALL_TOOL = 'mcp_call_tool' as const;
export const MSG_MCP_READ_RESOURCE = 'mcp_read_resource' as const;
export const MSG_MCP_GET_PROMPT = 'mcp_get_prompt' as const;
export const MSG_MCP_GET_LOGS = 'mcp_get_logs' as const;

// =============================================================================
// Credential Messages
// =============================================================================

export const MSG_SET_CREDENTIAL = 'set_credential' as const;
export const MSG_GET_CREDENTIAL_STATUS = 'get_credential_status' as const;
export const MSG_VALIDATE_CREDENTIALS = 'validate_credentials' as const;
export const MSG_DELETE_CREDENTIAL = 'delete_credential' as const;
export const MSG_LIST_CREDENTIALS = 'list_credentials' as const;

// =============================================================================
// OAuth Messages
// =============================================================================

export const MSG_OAUTH_START = 'oauth_start' as const;
export const MSG_OAUTH_CANCEL = 'oauth_cancel' as const;
export const MSG_OAUTH_REVOKE = 'oauth_revoke' as const;
export const MSG_OAUTH_STATUS = 'oauth_status' as const;
export const MSG_LIST_OAUTH_PROVIDERS = 'list_oauth_providers' as const;

// =============================================================================
// Host API Messages (permission-gated tool access)
// =============================================================================

export const MSG_HOST_GRANT_PERMISSION = 'host_grant_permission' as const;
export const MSG_HOST_REVOKE_PERMISSION = 'host_revoke_permission' as const;
export const MSG_HOST_CHECK_PERMISSION = 'host_check_permission' as const;
export const MSG_HOST_GET_PERMISSIONS = 'host_get_permissions' as const;
export const MSG_HOST_EXPIRE_TAB_GRANTS = 'host_expire_tab_grants' as const;
export const MSG_HOST_LIST_TOOLS = 'host_list_tools' as const;
export const MSG_HOST_CALL_TOOL = 'host_call_tool' as const;
export const MSG_HOST_GET_STATS = 'host_get_stats' as const;

// =============================================================================
// LLM Provider Messages
// =============================================================================

export const MSG_LLM_DETECT = 'llm_detect' as const;
export const MSG_LLM_LIST_PROVIDERS = 'llm_list_providers' as const;
export const MSG_LLM_SET_ACTIVE = 'llm_set_active' as const;
export const MSG_LLM_SET_MODEL = 'llm_set_model' as const;
export const MSG_LLM_LIST_MODELS = 'llm_list_models' as const;
export const MSG_LLM_LIST_MODELS_FOR = 'llm_list_models_for' as const;
export const MSG_LLM_CHAT = 'llm_chat' as const;
export const MSG_LLM_GET_ACTIVE = 'llm_get_active' as const;
export const MSG_LLM_SET_API_KEY = 'llm_set_api_key' as const;
export const MSG_LLM_REMOVE_API_KEY = 'llm_remove_api_key' as const;
export const MSG_LLM_GET_SUPPORTED_PROVIDERS = 'llm_get_supported_providers' as const;
export const MSG_LLM_GET_CONFIG = 'llm_get_config' as const;

// =============================================================================
// LLM Setup Messages (model management)
// =============================================================================

export const MSG_LLM_SETUP_STATUS = 'llm_setup_status' as const;
export const MSG_LLM_DOWNLOAD_MODEL = 'llm_download_model' as const;
export const MSG_LLM_DELETE_MODEL = 'llm_delete_model' as const;
export const MSG_LLM_START_LOCAL = 'llm_start_local' as const;
export const MSG_LLM_STOP_LOCAL = 'llm_stop_local' as const;

// =============================================================================
// Chat Session Messages
// =============================================================================

export const MSG_CHAT_CREATE_SESSION = 'chat_create_session' as const;
export const MSG_CHAT_SEND_MESSAGE = 'chat_send_message' as const;
export const MSG_CHAT_GET_SESSION = 'chat_get_session' as const;
export const MSG_CHAT_LIST_SESSIONS = 'chat_list_sessions' as const;
export const MSG_CHAT_DELETE_SESSION = 'chat_delete_session' as const;
export const MSG_CHAT_UPDATE_SESSION = 'chat_update_session' as const;
export const MSG_CHAT_CLEAR_MESSAGES = 'chat_clear_messages' as const;

// =============================================================================
// Type Union for All Message Types
// =============================================================================

/**
 * Union type of all valid message type strings.
 * Use this for type checking message handlers.
 */
export type MessageType =
  // Core
  | typeof MSG_HELLO
  | typeof MSG_PING
  | typeof MSG_PONG
  | typeof MSG_ERROR
  // Server Store
  | typeof MSG_ADD_SERVER
  | typeof MSG_REMOVE_SERVER
  | typeof MSG_LIST_SERVERS
  | typeof MSG_CONNECT_SERVER
  | typeof MSG_DISCONNECT_SERVER
  | typeof MSG_LIST_TOOLS
  | typeof MSG_LIST_RESOURCES
  | typeof MSG_LIST_PROMPTS
  | typeof MSG_CALL_TOOL
  // Catalog
  | typeof MSG_CATALOG_GET
  | typeof MSG_CATALOG_REFRESH
  | typeof MSG_CATALOG_SEARCH
  | typeof MSG_CATALOG_ENRICH
  | typeof MSG_GET_CURATED_SERVERS
  | typeof MSG_GET_CURATED_LIST
  | typeof MSG_INSTALL_CURATED_SERVER
  | typeof MSG_INSTALL_CURATED
  | typeof MSG_INSTALL_GITHUB_REPO
  | typeof MSG_INSTALL_FROM_GITHUB
  // Installer
  | typeof MSG_CHECK_RUNTIMES
  | typeof MSG_INSTALL_SERVER
  | typeof MSG_ADD_REMOTE_SERVER
  | typeof MSG_IMPORT_CONFIG
  | typeof MSG_RESOLVE_GITHUB
  | typeof MSG_RESOLVE_SERVER_PACKAGE
  | typeof MSG_UNINSTALL_SERVER
  | typeof MSG_LIST_INSTALLED
  | typeof MSG_START_INSTALLED
  | typeof MSG_STOP_INSTALLED
  | typeof MSG_SET_SERVER_SECRETS
  | typeof MSG_UPDATE_SERVER_ARGS
  | typeof MSG_GET_SERVER_STATUS
  // Manifest
  | typeof MSG_INSTALL_FROM_MANIFEST
  | typeof MSG_CHECK_MANIFEST_OAUTH
  | typeof MSG_MANIFEST_OAUTH_START
  | typeof MSG_MANIFEST_OAUTH_STATUS
  | typeof MSG_START_MANIFEST_SERVER
  | typeof MSG_GET_SERVER_MANIFEST
  | typeof MSG_GET_OAUTH_CAPABILITIES
  // Docker
  | typeof MSG_CHECK_DOCKER
  | typeof MSG_RECONNECT_ORPHANED_CONTAINERS
  | typeof MSG_BUILD_DOCKER_IMAGES
  | typeof MSG_SET_DOCKER_MODE
  | typeof MSG_SHOULD_PREFER_DOCKER
  // MCP
  | typeof MSG_MCP_CONNECT
  | typeof MSG_MCP_DISCONNECT
  | typeof MSG_MCP_LIST_CONNECTIONS
  | typeof MSG_MCP_LIST_TOOLS
  | typeof MSG_MCP_LIST_RESOURCES
  | typeof MSG_MCP_LIST_PROMPTS
  | typeof MSG_MCP_CALL_TOOL
  | typeof MSG_MCP_READ_RESOURCE
  | typeof MSG_MCP_GET_PROMPT
  | typeof MSG_MCP_GET_LOGS
  // Credentials
  | typeof MSG_SET_CREDENTIAL
  | typeof MSG_GET_CREDENTIAL_STATUS
  | typeof MSG_VALIDATE_CREDENTIALS
  | typeof MSG_DELETE_CREDENTIAL
  | typeof MSG_LIST_CREDENTIALS
  // OAuth
  | typeof MSG_OAUTH_START
  | typeof MSG_OAUTH_CANCEL
  | typeof MSG_OAUTH_REVOKE
  | typeof MSG_OAUTH_STATUS
  | typeof MSG_LIST_OAUTH_PROVIDERS
  // Host
  | typeof MSG_HOST_GRANT_PERMISSION
  | typeof MSG_HOST_REVOKE_PERMISSION
  | typeof MSG_HOST_CHECK_PERMISSION
  | typeof MSG_HOST_GET_PERMISSIONS
  | typeof MSG_HOST_EXPIRE_TAB_GRANTS
  | typeof MSG_HOST_LIST_TOOLS
  | typeof MSG_HOST_CALL_TOOL
  | typeof MSG_HOST_GET_STATS
  // LLM
  | typeof MSG_LLM_DETECT
  | typeof MSG_LLM_LIST_PROVIDERS
  | typeof MSG_LLM_SET_ACTIVE
  | typeof MSG_LLM_SET_MODEL
  | typeof MSG_LLM_LIST_MODELS
  | typeof MSG_LLM_LIST_MODELS_FOR
  | typeof MSG_LLM_CHAT
  | typeof MSG_LLM_GET_ACTIVE
  | typeof MSG_LLM_SET_API_KEY
  | typeof MSG_LLM_REMOVE_API_KEY
  | typeof MSG_LLM_GET_SUPPORTED_PROVIDERS
  | typeof MSG_LLM_GET_CONFIG
  // LLM Setup
  | typeof MSG_LLM_SETUP_STATUS
  | typeof MSG_LLM_DOWNLOAD_MODEL
  | typeof MSG_LLM_DELETE_MODEL
  | typeof MSG_LLM_START_LOCAL
  | typeof MSG_LLM_STOP_LOCAL
  // Chat
  | typeof MSG_CHAT_CREATE_SESSION
  | typeof MSG_CHAT_SEND_MESSAGE
  | typeof MSG_CHAT_GET_SESSION
  | typeof MSG_CHAT_LIST_SESSIONS
  | typeof MSG_CHAT_DELETE_SESSION
  | typeof MSG_CHAT_UPDATE_SESSION
  | typeof MSG_CHAT_CLEAR_MESSAGES;

/**
 * Helper to create a result message type from a request type.
 * e.g., 'catalog_get' -> 'catalog_get_result'
 */
export function resultType(requestType: string): string {
  return `${requestType}_result`;
}

