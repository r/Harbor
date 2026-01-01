/**
 * Authentication Manager
 * 
 * Coordinates OAuth flows, token storage, and credential management.
 * Integrates with the SecretStore for secure credential storage.
 */

import { log, pushStatus } from '../native-messaging.js';
import { getSecretStore, SecretStore } from '../installer/secrets.js';
import { OAuthConfig, OAuthTokens, OAuthFlowState, OAuthResult, AuthRequirement } from './types.js';
import { OAuthProvider } from './oauth-provider.js';
import { getOAuthServer } from './oauth-server.js';
import { GITHUB_OAUTH_CONFIG } from './providers/github.js';
import { GOOGLE_OAUTH_CONFIG } from './providers/google.js';
import { CredentialType, StoredCredential } from '../types.js';

/**
 * Built-in OAuth provider configurations.
 */
const BUILTIN_PROVIDERS: Record<string, OAuthConfig> = {
  github: GITHUB_OAUTH_CONFIG,
  google: GOOGLE_OAUTH_CONFIG,
};

/**
 * Active OAuth flows keyed by state.
 */
const activeFlows: Map<string, OAuthFlowState> = new Map();

/**
 * Token refresh timers keyed by serverId:credentialKey.
 */
const refreshTimers: Map<string, NodeJS.Timeout> = new Map();

/**
 * Get an OAuth provider by ID.
 */
export function getOAuthProvider(providerId: string, customConfig?: Partial<OAuthConfig>): OAuthProvider {
  const baseConfig = BUILTIN_PROVIDERS[providerId];
  
  if (!baseConfig && !customConfig) {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }
  
  const config: OAuthConfig = {
    ...(baseConfig || {
      providerId,
      displayName: providerId,
      authorizationUrl: '',
      tokenUrl: '',
      clientId: '',
      scopes: [],
      pkceEnabled: true,
    }),
    ...customConfig,
  };
  
  return new OAuthProvider(config);
}

/**
 * Start an OAuth flow for a server credential.
 */
export async function startOAuthFlow(
  serverId: string,
  credentialKey: string,
  providerId: string,
  customConfig?: Partial<OAuthConfig>
): Promise<{ authUrl: string; state: string }> {
  const provider = getOAuthProvider(providerId, customConfig);
  
  if (!provider.config.clientId) {
    throw new Error(
      `OAuth client ID not configured for ${providerId}. ` +
      `Set HARBOR_${providerId.toUpperCase()}_CLIENT_ID environment variable.`
    );
  }
  
  // Start the OAuth server
  const server = getOAuthServer();
  await server.start();
  
  // Start the auth flow
  const { authUrl, flow } = await provider.startAuthFlow(serverId, credentialKey);
  
  // Store the flow state
  activeFlows.set(flow.state, flow);
  
  // Register with callback server
  const codePromise = server.registerFlow(flow);
  
  // Handle the callback asynchronously
  handleOAuthCallback(provider, flow, codePromise).catch(err => {
    log(`[AuthManager] OAuth callback handling failed: ${err}`);
    pushStatus('auth', 'oauth_error', {
      serverId,
      credentialKey,
      error: err.message,
    });
  });
  
  return { authUrl, state: flow.state };
}

/**
 * Handle OAuth callback and token exchange.
 */
async function handleOAuthCallback(
  provider: OAuthProvider,
  flow: OAuthFlowState,
  codePromise: Promise<string>
): Promise<void> {
  try {
    // Wait for the authorization code
    const code = await codePromise;
    
    // Exchange for tokens
    const tokens = await provider.exchangeCode(code, flow);
    
    // Store the tokens
    await storeOAuthTokens(flow.serverId, flow.credentialKey, tokens);
    
    // Schedule token refresh if we have expiry info
    if (tokens.expiresAt && tokens.refreshToken) {
      scheduleTokenRefresh(
        flow.serverId,
        flow.credentialKey,
        flow.providerId,
        tokens
      );
    }
    
    // Notify success
    pushStatus('auth', 'oauth_success', {
      serverId: flow.serverId,
      credentialKey: flow.credentialKey,
      providerId: flow.providerId,
    });
    
    log(`[AuthManager] OAuth flow completed for ${flow.serverId}:${flow.credentialKey}`);
  } catch (err) {
    log(`[AuthManager] OAuth flow failed: ${err}`);
    pushStatus('auth', 'oauth_error', {
      serverId: flow.serverId,
      credentialKey: flow.credentialKey,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    // Clean up flow state
    activeFlows.delete(flow.state);
  }
}

/**
 * Store OAuth tokens in the secret store.
 */
async function storeOAuthTokens(
  serverId: string,
  credentialKey: string,
  tokens: OAuthTokens
): Promise<void> {
  const secretStore = getSecretStore();
  
  const credential: StoredCredential = {
    key: credentialKey,
    value: tokens.accessToken,
    type: CredentialType.OAUTH,
    setAt: Date.now(),
    expiresAt: tokens.expiresAt,
    refreshToken: tokens.refreshToken,
  };
  
  secretStore.setCredential(serverId, credential);
  
  log(`[AuthManager] Stored OAuth tokens for ${serverId}:${credentialKey}`);
}

/**
 * Schedule automatic token refresh before expiry.
 */
function scheduleTokenRefresh(
  serverId: string,
  credentialKey: string,
  providerId: string,
  tokens: OAuthTokens
): void {
  if (!tokens.expiresAt || !tokens.refreshToken) {
    return;
  }
  
  const key = `${serverId}:${credentialKey}`;
  
  // Clear any existing timer
  const existing = refreshTimers.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  
  // Refresh 5 minutes before expiry
  const refreshAt = tokens.expiresAt - (5 * 60 * 1000);
  const delay = refreshAt - Date.now();
  
  if (delay <= 0) {
    // Already expired or about to, refresh now
    refreshTokenNow(serverId, credentialKey, providerId, tokens.refreshToken);
    return;
  }
  
  log(`[AuthManager] Scheduling token refresh for ${key} in ${Math.round(delay / 1000)}s`);
  
  const timer = setTimeout(() => {
    refreshTokenNow(serverId, credentialKey, providerId, tokens.refreshToken!);
  }, delay);
  
  refreshTimers.set(key, timer);
}

/**
 * Refresh a token immediately.
 */
async function refreshTokenNow(
  serverId: string,
  credentialKey: string,
  providerId: string,
  refreshToken: string
): Promise<void> {
  try {
    log(`[AuthManager] Refreshing token for ${serverId}:${credentialKey}`);
    
    const provider = getOAuthProvider(providerId);
    const newTokens = await provider.refreshToken(refreshToken);
    
    // Store updated tokens
    await storeOAuthTokens(serverId, credentialKey, newTokens);
    
    // Schedule next refresh
    scheduleTokenRefresh(serverId, credentialKey, providerId, newTokens);
    
    pushStatus('auth', 'token_refreshed', {
      serverId,
      credentialKey,
    });
  } catch (err) {
    log(`[AuthManager] Token refresh failed: ${err}`);
    
    pushStatus('auth', 'token_refresh_failed', {
      serverId,
      credentialKey,
      error: err instanceof Error ? err.message : String(err),
      message: 'OAuth token expired. Please reconnect.',
    });
  }
}

/**
 * Cancel an active OAuth flow.
 */
export function cancelOAuthFlow(state: string): void {
  const flow = activeFlows.get(state);
  if (flow) {
    activeFlows.delete(state);
    getOAuthServer().cancelFlow(state);
    log(`[AuthManager] Cancelled OAuth flow (state: ${state.substring(0, 8)}...)`);
  }
}

/**
 * Revoke OAuth access for a server credential.
 */
export async function revokeOAuthAccess(
  serverId: string,
  credentialKey: string
): Promise<void> {
  const secretStore = getSecretStore();
  const credentials = secretStore.getCredentials(serverId);
  const credential = credentials.find(c => c.key === credentialKey);
  
  if (!credential || credential.type !== CredentialType.OAUTH) {
    log(`[AuthManager] No OAuth credential found for ${serverId}:${credentialKey}`);
    return;
  }
  
  // Try to revoke at provider (best effort)
  // We don't have the providerId stored, so we skip revocation
  
  // Clear the refresh timer
  const key = `${serverId}:${credentialKey}`;
  const timer = refreshTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    refreshTimers.delete(key);
  }
  
  // Delete the credential
  secretStore.deleteCredential(serverId, credentialKey);
  
  log(`[AuthManager] Revoked OAuth access for ${serverId}:${credentialKey}`);
}

/**
 * Check if an OAuth credential is expired.
 */
export function isOAuthExpired(serverId: string, credentialKey: string): boolean {
  const secretStore = getSecretStore();
  const credentials = secretStore.getCredentials(serverId);
  const credential = credentials.find(c => c.key === credentialKey);
  
  if (!credential) {
    return true;
  }
  
  if (credential.type !== CredentialType.OAUTH) {
    return false;
  }
  
  return secretStore.isExpired(credential);
}

/**
 * Get the OAuth status for a server credential.
 */
export function getOAuthStatus(serverId: string, credentialKey: string): {
  connected: boolean;
  expiresAt?: number;
  isExpired: boolean;
  hasRefreshToken: boolean;
} {
  const secretStore = getSecretStore();
  const credentials = secretStore.getCredentials(serverId);
  const credential = credentials.find(c => c.key === credentialKey);
  
  if (!credential) {
    return {
      connected: false,
      isExpired: false,
      hasRefreshToken: false,
    };
  }
  
  return {
    connected: true,
    expiresAt: credential.expiresAt,
    isExpired: secretStore.isExpired(credential),
    hasRefreshToken: !!credential.refreshToken,
  };
}

/**
 * Check if we have a valid client ID for a provider.
 */
export function isProviderConfigured(providerId: string): boolean {
  const config = BUILTIN_PROVIDERS[providerId];
  return !!(config?.clientId);
}

/**
 * Get list of configured OAuth providers.
 */
export function getConfiguredProviders(): string[] {
  return Object.entries(BUILTIN_PROVIDERS)
    .filter(([_, config]) => !!config.clientId)
    .map(([id]) => id);
}

