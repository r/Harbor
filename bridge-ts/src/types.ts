/**
 * Shared types for the Harbor bridge.
 */

// =============================================================================
// Server Store Types
// =============================================================================

export enum ServerStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export interface ServerConfig {
  id: string;
  label: string;
  baseUrl: string;
  status: ServerStatus;
  lastError?: string;
  addedAt: number;
  lastConnectedAt?: number;
}

// =============================================================================
// Catalog Types
// =============================================================================

export interface PackageInfo {
  registryType: 'npm' | 'pypi' | 'oci' | 'binary';
  identifier: string;
  // For binary packages - URL to download
  binaryUrl?: string;
  environmentVariables: Array<{
    name: string;
    description?: string;
    isSecret?: boolean;
  }>;
}

export interface CatalogServer {
  id: string;
  name: string;
  source: string;
  endpointUrl: string;
  installableOnly: boolean;
  packages: PackageInfo[];
  description: string;
  homepageUrl: string;
  repositoryUrl: string;
  tags: string[];
  fetchedAt: number;
  isRemoved?: boolean;
  isFeatured?: boolean;
  priorityScore?: number;
  // Popularity data from enrichment
  popularityScore?: number;
  githubStars?: number;
  npmDownloads?: number;
}

export interface ProviderStatus {
  id: string;
  name: string;
  ok: boolean;
  count: number | null;
  error: string | null;
  fetchedAt: number | null;
}

export interface CatalogResult {
  servers: CatalogServer[];
  providerStatus: ProviderStatus[];
  fetchedAt: number;
  isStale?: boolean;
  stats?: {
    total: number;
    remote: number;
    removed: number;
    featured: number;
  };
  changes?: Array<{
    serverId: string;
    type: 'added' | 'updated' | 'removed' | 'restored';
    source: string;
    fieldChanges?: Record<string, unknown>;
  }>;
}

// =============================================================================
// Installer Types
// =============================================================================

export enum RuntimeType {
  NODE = 'node',
  PYTHON = 'python',
  DOCKER = 'docker',
}

export interface Runtime {
  type: RuntimeType;
  available: boolean;
  version: string | null;
  path: string | null;
  runnerCmd: string | null;
  installHint: string | null;
}

export enum ProcessState {
  STARTING = 'starting',
  RUNNING = 'running',
  STOPPING = 'stopping',
  STOPPED = 'stopped',
  CRASHED = 'crashed',
  ERROR = 'error',
}

export interface InstalledServer {
  id: string;
  name: string;
  packageType: string; // 'npm' | 'pypi' | 'binary' | 'http' | 'sse'
  packageId: string;
  autoStart: boolean;
  args: string[];
  requiredEnvVars: Array<{
    name: string;
    description?: string;
    isSecret?: boolean;
  }>;
  installedAt: number;
  catalogSource: string | null;
  homepageUrl: string | null;
  description: string | null;
  // For binary packages
  binaryUrl?: string;
  binaryPath?: string;
  // For remote HTTP/SSE servers
  remoteUrl?: string;
  remoteHeaders?: Record<string, string>;
  // Docker execution settings
  useDocker?: boolean;
  dockerVolumes?: string[];
}

// =============================================================================
// Credential Types
// =============================================================================

/**
 * Type of credential required by an MCP server.
 */
export enum CredentialType {
  /** Single API key or token (e.g., OPENAI_API_KEY) */
  API_KEY = 'api_key',
  /** Username and password pair */
  PASSWORD = 'password',
  /** OAuth 2.0 token (future) */
  OAUTH = 'oauth',
  /** Custom header value */
  HEADER = 'header',
}

/**
 * Describes a credential that an MCP server requires.
 * This comes from the catalog/package metadata.
 */
export interface CredentialRequirement {
  /** Unique key for this credential (used for storage) */
  key: string;
  
  /** Human-readable label for the UI */
  label: string;
  
  /** Description/help text for the user */
  description?: string;
  
  /** Type of credential */
  type: CredentialType;
  
  /** Environment variable name to inject (for API_KEY type) */
  envVar?: string;
  
  /** Environment variable for username (for PASSWORD type) */
  usernameEnvVar?: string;
  
  /** Environment variable for password (for PASSWORD type) */
  passwordEnvVar?: string;
  
  /** Whether this credential is required or optional */
  required: boolean;
  
  /** Validation pattern (regex) */
  pattern?: string;
  
  /** Placeholder text for the input field */
  placeholder?: string;
  
  /** URL to documentation for obtaining this credential */
  helpUrl?: string;
}

/**
 * A credential stored in the secret store.
 */
export interface StoredCredential {
  /** The credential key (matches CredentialRequirement.key) */
  key: string;
  
  /** The credential value (encrypted at rest) */
  value: string;
  
  /** Type of credential */
  type: CredentialType;
  
  /** Username for PASSWORD type credentials */
  username?: string;
  
  /** When this credential was set */
  setAt: number;
  
  /** When this credential expires (for OAuth tokens) */
  expiresAt?: number;
  
  /** OAuth refresh token (for OAuth type) */
  refreshToken?: string;
}

/**
 * Status of credentials for a server.
 */
export interface CredentialStatus {
  /** Server ID */
  serverId: string;
  
  /** Whether all required credentials are set */
  isComplete: boolean;
  
  /** List of credentials that are set */
  configured: Array<{
    key: string;
    type: CredentialType;
    setAt: number;
    isExpired?: boolean;
  }>;
  
  /** List of required credentials that are missing */
  missing: Array<{
    key: string;
    label: string;
    type: CredentialType;
    required: boolean;
  }>;
  
  /** List of credentials that have expired (OAuth) */
  expired: Array<{
    key: string;
    type: CredentialType;
    expiresAt: number;
  }>;
}

// =============================================================================
// MCP Types
// =============================================================================

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export interface McpConnectionResult {
  success: boolean;
  message: string;
  serverInfo?: {
    name?: string;
    version?: string;
    protocolVersion?: string;
  };
}

export interface McpToolResult {
  success: boolean;
  content?: unknown;
  error?: string;
}

// =============================================================================
// Curated Server Types
// =============================================================================

/**
 * A curated MCP server that we recommend and provide easy installation for.
 */
export interface CuratedServer {
  /** Unique ID for this server (e.g., 'curated-filesystem') */
  id: string;
  
  /** Display name */
  name: string;
  
  /** Brief description of what the server does */
  description: string;
  
  /** Emoji or icon for display */
  icon?: string;
  
  /** Package type for installation */
  packageType: 'npm' | 'pypi' | 'github' | 'binary' | 'oci';
  
  /** Package identifier (npm package, pypi package, owner/repo, etc.) */
  packageId: string;
  
  /** Tags for categorization */
  tags?: string[];
  
  /** URL to documentation or homepage */
  homepageUrl?: string;
  
  /** Whether this server requires native messaging bridge */
  requiresNative?: boolean;
  
  /** Whether the server requires configuration/credentials */
  requiresConfig?: boolean;
  
  /** Hint about what configuration is needed */
  configHint?: string;
}

// =============================================================================
// Execution Provider Types
// =============================================================================

/**
 * Represents a running server process.
 */
export interface ServerProcess {
  serverId: string;
  packageType: string;
  packageId: string;
  state: ProcessState;
  pid: number | null;
  startedAt: number | null;
  stoppedAt: number | null;
  exitCode: number | null;
  errorMessage: string | null;
  recentLogs: string[];
}

/**
 * Interface for execution providers (native, Docker, etc.).
 */
export interface ExecutionProvider {
  readonly id: string;
  readonly name: string;
  
  /** Check if this provider is available on the system */
  isAvailable(): Promise<boolean>;
  
  /** Start a server and return process info */
  start(
    serverId: string,
    imageName: string,
    command: string,
    args: string[],
    env: Record<string, string>,
    onOutput?: (stream: 'stdout' | 'stderr', line: string) => void
  ): Promise<ServerProcess>;
  
  /** Stop a running server */
  stop(serverId: string): Promise<boolean>;
}

// =============================================================================
// Message Types
// =============================================================================

export interface Message {
  type: string;
  request_id?: string;
  [key: string]: unknown;
}

export interface ErrorResponse {
  type: 'error';
  request_id: string;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ResultResponse {
  type: string;
  request_id: string;
  [key: string]: unknown;
}




