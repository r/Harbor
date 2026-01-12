/**
 * MCP Server Manifest
 * 
 * A declarative schema that describes what an MCP server needs so that
 * MCP hosts (like Harbor) can automatically install and configure it.
 * 
 * Design principles:
 * - Declarative: describes what the server SUPPORTS and NEEDS
 * - The host evaluates if it CAN meet those requirements
 * - Minimal required fields, sensible defaults
 */

import { log } from '../native-messaging.js';

// =============================================================================
// Manifest Schema Types
// =============================================================================

/**
 * The root manifest structure.
 */
export interface McpManifest {
  /** JSON Schema URL for validation */
  $schema?: string;
  
  /** Manifest format version (semver) */
  manifestVersion: string;
  
  /** Display name */
  name: string;
  
  /** Brief description */
  description?: string;
  
  /** Repository URL (for linking back) */
  repository?: string;
  
  /** Package installation info */
  package: ManifestPackage;
  
  /** Runtime characteristics */
  runtime?: ManifestRuntime;
  
  /** How to execute the server */
  execution?: ManifestExecution;
  
  /** Non-secret environment variables */
  environment?: ManifestEnvVar[];
  
  /** Secret credentials (API keys, tokens) */
  secrets?: ManifestSecret[];
  
  /** OAuth requirements (if any) */
  oauth?: ManifestOAuth;
}

/**
 * Package installation info.
 * For servers available on multiple registries, list in priority order.
 */
export interface ManifestPackage {
  /** Registry type */
  type: 'npm' | 'pypi' | 'docker' | 'binary' | 'git';
  
  /** Package identifier (for npm/pypi) */
  name?: string;
  
  /** For git: repository URL */
  url?: string;
  
  /** For docker: full image reference */
  image?: string;
  
  /** For binary: download URL pattern (use {os} and {arch} placeholders) */
  binaryUrl?: string;
  
  /** Alternative packages (lower priority) */
  alternatives?: Array<{
    type: 'npm' | 'pypi' | 'docker' | 'binary' | 'git';
    name?: string;
    url?: string;
    image?: string;
    binaryUrl?: string;
  }>;
}

/**
 * Runtime characteristics that affect how Harbor runs the server.
 */
export interface ManifestRuntime {
  /** 
   * Does this package include native/compiled code?
   * If true, Docker may be preferred for cross-platform compatibility.
   * Applies to Node.js native extensions, Python C extensions, etc.
   */
  hasNativeCode?: boolean;
  
  /** Minimum runtime version (e.g., "18.0.0" for Node, "3.10" for Python) */
  minimumVersion?: string;
}

/**
 * Execution preferences.
 */
export interface ManifestExecution {
  /** MCP transport type. Default: "stdio" */
  transport?: 'stdio' | 'http' | 'sse';
  
  /** For http/sse: default port */
  defaultPort?: number;
}

/**
 * Non-secret environment variable.
 */
export interface ManifestEnvVar {
  /** Variable name (e.g., "LOG_LEVEL") */
  name: string;
  
  /** Human-readable description */
  description: string;
  
  /** Whether required to start. Default: false */
  required?: boolean;
  
  /** Value type for UI rendering. Default: "string" */
  type?: 'string' | 'path' | 'url' | 'number' | 'boolean';
  
  /** Default value */
  default?: string;
  
  /** Allowed values (renders as dropdown) */
  choices?: string[];
}

/**
 * Secret credential (API key, token, password).
 * These get special treatment: password fields, secure storage.
 */
export interface ManifestSecret {
  /** Environment variable name (e.g., "OPENAI_API_KEY") */
  name: string;
  
  /** Human-readable description */
  description: string;
  
  /** Whether required to start. Default: true */
  required?: boolean;
  
  /** URL where user can obtain this credential */
  helpUrl?: string;
  
  /** Validation regex pattern */
  pattern?: string;
  
  /** Placeholder text for input */
  placeholder?: string;
}

/**
 * OAuth source types:
 * - "host": The MCP host (Harbor, etc.) handles OAuth and injects tokens
 * - "user": User creates their own OAuth app and provides credentials
 * - "server": The server handles OAuth internally (no host involvement)
 */
export type OAuthSource = 'host' | 'user' | 'server';

/**
 * Host mode OAuth configuration.
 * Used when the MCP host handles OAuth and injects tokens via environment variables.
 */
export interface ManifestOAuthHostMode {
  /** Env var for the access token */
  tokenEnvVar?: string;
  
  /** Env var for the refresh token */
  refreshTokenEnvVar?: string;
  
  /** Env var for the client ID (if server needs it for refresh) */
  clientIdEnvVar?: string;
  
  /** Env var for the client secret (if server needs it for refresh) */
  clientSecretEnvVar?: string;
}

/**
 * User mode OAuth configuration.
 * Used when users create their own OAuth app and the server handles the flow.
 */
export interface ManifestOAuthUserMode {
  /** Path where user downloads client_secret.json */
  clientCredentialsPath?: string;
  
  /** Env var name for clientCredentialsPath */
  clientCredentialsEnvVar?: string;
  
  /** Path where server stores tokens after authentication */
  tokenStoragePath?: string;
  
  /** Env var name for tokenStoragePath */
  tokenStorageEnvVar?: string;
}

/**
 * An API that must be enabled (e.g., in Google Cloud Console).
 */
export interface ManifestApi {
  /** Service name (e.g., "gmail.googleapis.com") */
  name: string;
  
  /** Human-readable name (e.g., "Gmail API") */
  displayName: string;
  
  /** Direct link to enable this API */
  enableUrl?: string;
}

/**
 * OAuth requirements.
 * If present, indicates this server needs OAuth authentication.
 * 
 * The manifest declares what the server SUPPORTS (via supportedSources),
 * and the host evaluates which mode to use based on its capabilities.
 */
export interface ManifestOAuth {
  /** OAuth provider */
  provider: 'google' | 'github' | 'microsoft' | 'slack' | 'custom';
  
  /**
   * Which OAuth modes does this server support?
   * List all supported modes - the host will choose based on its capabilities.
   */
  supportedSources: OAuthSource[];
  
  /**
   * Preferred source if the host supports multiple.
   * Defaults to the first item in supportedSources.
   */
  preferredSource?: OAuthSource;
  
  /** Required OAuth scopes */
  scopes: string[];
  
  /** Human-readable description of what access is needed */
  description?: string;
  
  /** 
   * APIs that must be enabled (for providers like Google Cloud).
   * Used to verify host capabilities and guide user setup.
   */
  apis?: ManifestApi[];
  
  /**
   * Configuration for host mode.
   * How the server expects to receive tokens from the host.
   */
  hostMode?: ManifestOAuthHostMode;
  
  /**
   * Configuration for user mode.
   * How the server handles user-provided OAuth credentials.
   */
  userMode?: ManifestOAuthUserMode;
  
  /** For custom providers: OAuth endpoints */
  endpoints?: {
    authorization: string;
    token: string;
  };
}

// =============================================================================
// Host Capability Checking
// =============================================================================

/**
 * Represents what OAuth capabilities a host (like Harbor) has.
 */
export interface HostOAuthCapabilities {
  /** Configured OAuth providers with their details */
  providers: {
    [provider: string]: {
      /** Is this provider configured? */
      configured: boolean;
      /** What scopes does the host's OAuth app have access to? */
      availableScopes: string[];
      /** What APIs are enabled on the host's project? */
      enabledApis: string[];
    };
  };
}

/**
 * Result of checking if a host can satisfy OAuth requirements.
 */
export interface OAuthCapabilityCheck {
  /** Can the host handle this OAuth requirement at all? */
  canHandle: boolean;
  
  /** Which mode should be used? */
  recommendedSource: OAuthSource;
  
  /** If host mode can be used */
  hostModeAvailable: boolean;
  
  /** If user mode is available as fallback */
  userModeAvailable: boolean;
  
  /** Missing scopes if host mode can't be used */
  missingScopes?: string[];
  
  /** Missing APIs if host mode can't be used */
  missingApis?: string[];
  
  /** Human-readable explanation */
  reason?: string;
}

/**
 * Check if a host can satisfy the OAuth requirements from a manifest.
 */
export function checkOAuthCapabilities(
  oauth: ManifestOAuth,
  hostCapabilities: HostOAuthCapabilities
): OAuthCapabilityCheck {
  const providerCaps = hostCapabilities.providers[oauth.provider];
  
  // Check if host mode is possible
  let hostModeAvailable = false;
  let missingScopes: string[] = [];
  let missingApis: string[] = [];
  
  if (providerCaps?.configured && oauth.supportedSources.includes('host')) {
    // Check scopes
    missingScopes = oauth.scopes.filter(
      scope => !providerCaps.availableScopes.includes(scope)
    );
    
    // Check APIs
    if (oauth.apis) {
      missingApis = oauth.apis
        .map(api => api.name)
        .filter(apiName => !providerCaps.enabledApis.includes(apiName));
    }
    
    hostModeAvailable = missingScopes.length === 0 && missingApis.length === 0;
  }
  
  // Check if user mode is available
  const userModeAvailable = oauth.supportedSources.includes('user');
  
  // Check if server mode is available
  const serverModeAvailable = oauth.supportedSources.includes('server');
  
  // Determine recommended source
  const preferred = oauth.preferredSource ?? oauth.supportedSources[0];
  let recommendedSource: OAuthSource;
  
  if (preferred === 'host' && hostModeAvailable) {
    recommendedSource = 'host';
  } else if (preferred === 'user' && userModeAvailable) {
    recommendedSource = 'user';
  } else if (preferred === 'server' && serverModeAvailable) {
    recommendedSource = 'server';
  } else if (hostModeAvailable) {
    recommendedSource = 'host';
  } else if (userModeAvailable) {
    recommendedSource = 'user';
  } else if (serverModeAvailable) {
    recommendedSource = 'server';
  } else {
    // No supported source available
    return {
      canHandle: false,
      recommendedSource: oauth.supportedSources[0],
      hostModeAvailable: false,
      userModeAvailable: false,
      missingScopes: missingScopes.length > 0 ? missingScopes : undefined,
      missingApis: missingApis.length > 0 ? missingApis : undefined,
      reason: 'No supported OAuth source is available',
    };
  }
  
  // Build reason
  let reason: string | undefined;
  if (recommendedSource === 'host') {
    reason = 'Host will handle OAuth authentication';
  } else if (recommendedSource === 'user') {
    if (oauth.supportedSources.includes('host') && !hostModeAvailable) {
      const issues: string[] = [];
      if (missingScopes.length > 0) {
        issues.push(`missing scopes: ${missingScopes.join(', ')}`);
      }
      if (missingApis.length > 0) {
        issues.push(`missing APIs: ${missingApis.join(', ')}`);
      }
      reason = `Falling back to user mode (${issues.join('; ')})`;
    } else {
      reason = 'User will create their own OAuth application';
    }
  } else {
    reason = 'Server handles OAuth internally';
  }
  
  return {
    canHandle: true,
    recommendedSource,
    hostModeAvailable,
    userModeAvailable,
    missingScopes: missingScopes.length > 0 ? missingScopes : undefined,
    missingApis: missingApis.length > 0 ? missingApis : undefined,
    reason,
  };
}

// =============================================================================
// Manifest Loader
// =============================================================================

const MANIFEST_FILENAMES = [
  'mcp-manifest.json',
  '.mcp/manifest.json',
];

/**
 * Validation result from manifest parsing.
 */
export interface ManifestValidationResult {
  valid: boolean;
  manifest?: McpManifest;
  errors?: string[];
}

/**
 * Fetch and parse a manifest from a GitHub repository.
 * Tries multiple branches (main, master) if the specified branch fails.
 */
export async function fetchManifestFromGitHub(
  owner: string,
  repo: string,
  branch?: string
): Promise<McpManifest | null> {
  // Branches to try (in order)
  const branchesToTry = branch ? [branch] : ['main', 'master'];
  
  for (const branchName of branchesToTry) {
    log(`[Manifest] Checking ${owner}/${repo} on branch: ${branchName}`);
    
    // Try manifest files
    for (const filename of MANIFEST_FILENAMES) {
      const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branchName}/${filename}`;
      
      try {
        log(`[Manifest] Trying: ${rawUrl}`);
        const response = await fetch(rawUrl);
        
        if (!response.ok) {
          log(`[Manifest] Not found (${response.status}): ${rawUrl}`);
          continue;
        }
        
        const text = await response.text();
        log(`[Manifest] Found file, parsing JSON (${text.length} bytes)...`);
        
        let manifest: McpManifest;
        try {
          manifest = JSON.parse(text) as McpManifest;
        } catch (parseErr) {
          log(`[Manifest] Failed to parse JSON: ${parseErr}`);
          continue;
        }
        
        const result = validateManifest(manifest);
        
        if (result.valid) {
          log(`[Manifest] ✓ Valid manifest found at ${filename} (branch: ${branchName})`);
          log(`[Manifest] Package info: type=${result.manifest!.package.type}, name=${result.manifest!.package.name || 'N/A'}, url=${result.manifest!.package.url || 'N/A'}`);
          return result.manifest!;
        } else {
          log(`[Manifest] ✗ Invalid manifest at ${filename}: ${result.errors?.join(', ')}`);
        }
        
      } catch (e) {
        log(`[Manifest] Network error fetching ${rawUrl}: ${e}`);
        continue;
      }
    }
    
    // Try package.json "mcp" field
    try {
      const pkgUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branchName}/package.json`;
      log(`[Manifest] Trying package.json mcp field: ${pkgUrl}`);
      const response = await fetch(pkgUrl);
      
      if (response.ok) {
        const pkg = await response.json() as { mcp?: McpManifest };
        if (pkg.mcp) {
          log(`[Manifest] Found 'mcp' field in package.json, validating...`);
          const result = validateManifest(pkg.mcp);
          if (result.valid) {
            log(`[Manifest] ✓ Valid manifest in package.json (branch: ${branchName})`);
            return result.manifest!;
          } else {
            log(`[Manifest] ✗ Invalid mcp field in package.json: ${result.errors?.join(', ')}`);
          }
        } else {
          log(`[Manifest] No 'mcp' field in package.json`);
        }
      }
    } catch (e) {
      log(`[Manifest] Error checking package.json: ${e}`);
    }
  }
  
  log(`[Manifest] No manifest found for ${owner}/${repo} (tried branches: ${branchesToTry.join(', ')})`);
  return null;
}

/**
 * Validate a parsed manifest and return detailed results.
 */
export function validateManifest(manifest: unknown): ManifestValidationResult {
  const errors: string[] = [];
  
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }
  
  const m = manifest as Record<string, unknown>;
  
  // Check required fields
  if (!m.manifestVersion || typeof m.manifestVersion !== 'string') {
    errors.push('Missing or invalid manifestVersion');
  }
  
  if (!m.name || typeof m.name !== 'string') {
    errors.push('Missing or invalid name');
  }
  
  if (!m.package || typeof m.package !== 'object') {
    errors.push('Missing or invalid package');
  } else {
    const pkg = m.package as Record<string, unknown>;
    if (!pkg.type || typeof pkg.type !== 'string') {
      errors.push('package.type is required');
    } else if (!['npm', 'pypi', 'docker', 'binary', 'git'].includes(pkg.type as string)) {
      errors.push(`package.type must be one of: npm, pypi, docker, binary, git`);
    }
    // name is required for npm/pypi, url is required for git
    if (pkg.type === 'git') {
      if (!pkg.url || typeof pkg.url !== 'string') {
        errors.push('package.url is required for git packages');
      }
    } else if (pkg.type !== 'docker' && pkg.type !== 'binary') {
      if (!pkg.name || typeof pkg.name !== 'string') {
        errors.push('package.name is required');
      }
    }
  }
  
  // Validate OAuth if present
  if (m.oauth) {
    const oauth = m.oauth as Record<string, unknown>;
    
    if (!oauth.provider || typeof oauth.provider !== 'string') {
      errors.push('oauth.provider is required');
    }
    
    if (!oauth.supportedSources || !Array.isArray(oauth.supportedSources)) {
      errors.push('oauth.supportedSources must be an array');
    } else {
      const validSources = ['host', 'user', 'server'];
      for (const source of oauth.supportedSources) {
        if (!validSources.includes(source as string)) {
          errors.push(`oauth.supportedSources contains invalid value: ${source}`);
        }
      }
      if (oauth.supportedSources.length === 0) {
        errors.push('oauth.supportedSources must not be empty');
      }
    }
    
    if (!oauth.scopes || !Array.isArray(oauth.scopes)) {
      errors.push('oauth.scopes must be an array');
    }
  }
  
  if (errors.length > 0) {
    return { valid: false, errors };
  }
  
  return { valid: true, manifest: m as unknown as McpManifest };
}

/**
 * Parse manifest from JSON string.
 */
export function parseManifest(jsonString: string): ManifestValidationResult {
  try {
    const parsed = JSON.parse(jsonString);
    return validateManifest(parsed);
  } catch (e) {
    return { 
      valid: false, 
      errors: [`Failed to parse JSON: ${e instanceof Error ? e.message : String(e)}`] 
    };
  }
}

// =============================================================================
// Manifest Utilities
// =============================================================================

/**
 * Determine if Docker should be used based on manifest.
 * 
 * Simple logic: if hasNativeCode is true, Docker is recommended.
 * Harbor will figure out the rest at runtime.
 */
export function getDockerRecommendation(manifest: McpManifest): {
  shouldUseDocker: boolean;
  reason?: string;
} {
  // If has native code, recommend Docker (avoids Gatekeeper issues on macOS)
  if (manifest.runtime?.hasNativeCode) {
    return { 
      shouldUseDocker: true, 
      reason: 'Has native code - Docker ensures compatibility'
    };
  }
  
  // Default: either works, prefer native
  return { 
    shouldUseDocker: false 
  };
}

/**
 * Check if user needs to create their own OAuth app (user mode only).
 */
export function requiresUserOAuthSetup(
  manifest: McpManifest,
  hostCapabilities?: HostOAuthCapabilities
): boolean {
  if (!manifest.oauth) return false;
  
  // If no host capabilities provided, check if user mode is the only option
  if (!hostCapabilities) {
    return manifest.oauth.supportedSources.length === 1 && 
           manifest.oauth.supportedSources[0] === 'user';
  }
  
  // Check what mode we'd actually use
  const check = checkOAuthCapabilities(manifest.oauth, hostCapabilities);
  return check.recommendedSource === 'user';
}

/**
 * Get all required configuration that's missing.
 */
export function getMissingConfig(
  manifest: McpManifest,
  providedEnv: Record<string, string>,
  providedSecrets: Record<string, string>,
  oauthStatus: { hasCredentials: boolean; hasTokens: boolean; mode?: OAuthSource }
): {
  missingEnv: ManifestEnvVar[];
  missingSecrets: ManifestSecret[];
  needsOAuth: boolean;
  oauthMode?: OAuthSource;
  canStart: boolean;
} {
  const missingEnv = (manifest.environment ?? [])
    .filter(e => e.required && !providedEnv[e.name]);
  
  const missingSecrets = (manifest.secrets ?? [])
    .filter(s => (s.required !== false) && !providedSecrets[s.name]);
  
  // Determine OAuth needs based on mode
  let needsOAuth = false;
  if (manifest.oauth) {
    const mode = oauthStatus.mode ?? manifest.oauth.preferredSource ?? manifest.oauth.supportedSources[0];
    
    if (mode === 'host') {
      // Host mode: we need tokens
      needsOAuth = !oauthStatus.hasTokens;
    } else if (mode === 'user') {
      // User mode: we need user's credentials
      needsOAuth = !oauthStatus.hasCredentials;
    }
    // Server mode: server handles it, we don't need anything
  }
  
  return {
    missingEnv,
    missingSecrets,
    needsOAuth,
    oauthMode: manifest.oauth ? (oauthStatus.mode ?? manifest.oauth.supportedSources[0]) : undefined,
    canStart: missingEnv.length === 0 && missingSecrets.length === 0 && !needsOAuth,
  };
}

/**
 * Get environment variables to inject based on OAuth mode.
 */
export function getOAuthEnvVars(
  oauth: ManifestOAuth,
  mode: OAuthSource,
  tokens?: { accessToken: string; refreshToken?: string },
  clientCredentials?: { clientId: string; clientSecret: string }
): Record<string, string> {
  const env: Record<string, string> = {};
  
  if (mode === 'host' && oauth.hostMode && tokens) {
    if (oauth.hostMode.tokenEnvVar) {
      env[oauth.hostMode.tokenEnvVar] = tokens.accessToken;
    }
    if (oauth.hostMode.refreshTokenEnvVar && tokens.refreshToken) {
      env[oauth.hostMode.refreshTokenEnvVar] = tokens.refreshToken;
    }
    if (oauth.hostMode.clientIdEnvVar && clientCredentials) {
      env[oauth.hostMode.clientIdEnvVar] = clientCredentials.clientId;
    }
    if (oauth.hostMode.clientSecretEnvVar && clientCredentials) {
      env[oauth.hostMode.clientSecretEnvVar] = clientCredentials.clientSecret;
    }
  } else if (mode === 'user' && oauth.userMode) {
    // For user mode, set the paths if configured
    if (oauth.userMode.clientCredentialsEnvVar && oauth.userMode.clientCredentialsPath) {
      env[oauth.userMode.clientCredentialsEnvVar] = oauth.userMode.clientCredentialsPath;
    }
    if (oauth.userMode.tokenStorageEnvVar && oauth.userMode.tokenStoragePath) {
      env[oauth.userMode.tokenStorageEnvVar] = oauth.userMode.tokenStoragePath;
    }
  }
  
  return env;
}

/**
 * Convert manifest to the legacy env var format used by InstalledServer.
 */
export function toLegacyEnvVars(
  manifest: McpManifest
): Array<{ name: string; description?: string; isSecret?: boolean }> {
  const result: Array<{ name: string; description?: string; isSecret?: boolean }> = [];
  
  for (const env of manifest.environment ?? []) {
    result.push({
      name: env.name,
      description: env.description,
      isSecret: false,
    });
  }
  
  for (const secret of manifest.secrets ?? []) {
    result.push({
      name: secret.name,
      description: secret.description,
      isSecret: true,
    });
  }
  
  return result;
}
