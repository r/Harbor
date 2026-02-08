/**
 * Runtime type for MCP servers.
 * - 'wasm': WebAssembly module running in WASI sandbox
 * - 'js': JavaScript running in sandboxed Web Worker
 * - 'remote': Remote server accessed via HTTP/SSE or WebSocket
 */
export type McpServerRuntime = 'wasm' | 'js' | 'remote';

/**
 * Transport type for remote MCP servers.
 */
export type RemoteTransport = 'sse' | 'websocket';

/**
 * Network capability configuration.
 * Defines which hosts the server is allowed to connect to.
 */
export type NetworkCapability = {
  /** Allowed host patterns, e.g., ["api.github.com", "*.googleapis.com", "*"] */
  hosts: string[];
};

/**
 * Capability configuration for MCP servers.
 */
export type McpServerCapabilities = {
  /** Network access configuration */
  network?: NetworkCapability;
};

/**
 * Tool definition for MCP servers.
 */
export type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

/**
 * Declaration of a non-OAuth secret (e.g. login email/password) the server needs.
 * Values are stored separately and injected as process.env[name].
 */
export type SecretDeclaration = {
  name: string;
  label: string;
  type?: 'text' | 'password';
  optional?: boolean;
};

/**
 * OAuth configuration for servers that require API authentication.
 */
export type McpServerOAuth = {
  /** OAuth provider (e.g., "google", "github") */
  provider: 'google' | 'github';
  /** Required OAuth scopes */
  scopes: string[];
  /** Environment variable name for the access token */
  tokenEnvVar: string;
  /** Environment variable name for the refresh token (optional) */
  refreshTokenEnvVar?: string;
};

/**
 * Unified manifest type for both WASM and JS MCP servers.
 */
export type McpServerManifest = {
  id: string;
  name: string;
  version: string;

  /**
   * Runtime type. Defaults to 'wasm' for backward compatibility.
   */
  runtime?: McpServerRuntime;

  // WASM-specific fields
  /** Entry point filename for WASM modules */
  entrypoint?: string;
  /** URL to fetch WASM module from */
  moduleUrl?: string;
  /** URL to fetch WASM module from (alias for moduleUrl) */
  wasmUrl?: string;
  /** Base64-encoded WASM module bytes */
  moduleBytesBase64?: string;
  /** Base64-encoded WASM module bytes (alias for moduleBytesBase64) */
  wasmBase64?: string;

  // JS-specific fields
  /** URL to fetch JS bundle from */
  scriptUrl?: string;
  /** Base64-encoded JS bundle */
  scriptBase64?: string;

  // Remote server fields
  /** URL of the remote MCP server endpoint (for runtime: 'remote') */
  remoteUrl?: string;
  /** Transport type for remote servers: 'sse' (default) or 'websocket' */
  remoteTransport?: RemoteTransport;
  /** Optional authentication header value (e.g., 'Bearer <token>') */
  remoteAuthHeader?: string;

  // Capability configuration
  /** Legacy permissions array (kept for compatibility) */
  permissions: string[];
  /** Structured capability configuration */
  capabilities?: McpServerCapabilities;

  // Environment configuration
  /** Environment variable names to pass through */
  env?: string[];
  /** Declares non-OAuth secrets this server needs (user enters values in Harbor UI) */
  secretsDecl?: SecretDeclaration[];
  /** Secret values to inject as process.env (name -> value); used by built-in workers */
  secrets?: Record<string, string>;

  // OAuth configuration
  /** OAuth requirements for this server */
  oauth?: McpServerOAuth;

  /** Tool definitions exposed by this server */
  tools?: McpToolDefinition[];

  /** Whether this server should auto-start on extension load */
  autostart?: boolean;
};

/**
 * Handle to a registered MCP server.
 */
export type McpServerHandle = {
  id: string;
  manifest: McpServerManifest;
};

// Legacy type aliases for backward compatibility
/** @deprecated Use McpServerManifest instead */
export type WasmServerManifest = McpServerManifest;
/** @deprecated Use McpServerHandle instead */
export type WasmServerHandle = McpServerHandle;
