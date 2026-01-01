/**
 * Authentication Types
 * 
 * Types for OAuth, API keys, and other credential management.
 */

/**
 * OAuth provider configuration.
 */
export interface OAuthConfig {
  /** Unique identifier for this provider */
  providerId: string;
  
  /** Display name for UI */
  displayName: string;
  
  /** OAuth authorization endpoint */
  authorizationUrl: string;
  
  /** OAuth token endpoint */
  tokenUrl: string;
  
  /** OAuth client ID (can be empty for user-provided) */
  clientId: string;
  
  /** Required OAuth scopes */
  scopes: string[];
  
  /** Whether to use PKCE (Proof Key for Code Exchange) */
  pkceEnabled: boolean;
  
  /** Optional: revocation endpoint */
  revocationUrl?: string;
}

/**
 * OAuth tokens returned from token exchange.
 */
export interface OAuthTokens {
  /** Access token for API calls */
  accessToken: string;
  
  /** Optional refresh token for getting new access tokens */
  refreshToken?: string;
  
  /** When the access token expires (Unix timestamp ms) */
  expiresAt?: number;
  
  /** Token type (usually "Bearer") */
  tokenType: string;
  
  /** Granted scopes (may differ from requested) */
  scope?: string;
}

/**
 * State for an in-progress OAuth flow.
 */
export interface OAuthFlowState {
  /** Random state parameter for CSRF protection */
  state: string;
  
  /** PKCE code verifier (if PKCE enabled) */
  codeVerifier?: string;
  
  /** Provider being used */
  providerId: string;
  
  /** Server this auth is for */
  serverId: string;
  
  /** Credential key this will be stored as */
  credentialKey: string;
  
  /** When this flow was started */
  startedAt: number;
}

/**
 * Result of completing an OAuth flow.
 */
export interface OAuthResult {
  success: boolean;
  tokens?: OAuthTokens;
  error?: string;
}

/**
 * Extended credential requirement with OAuth support.
 */
export interface AuthRequirement {
  /** Unique key for this credential */
  key: string;
  
  /** Display label */
  label: string;
  
  /** Help text for users */
  description?: string;
  
  /** Type of authentication */
  type: 'api_key' | 'password' | 'oauth' | 'header';
  
  /** Environment variable to set when running server */
  envVar?: string;
  
  /** For password type: username env var */
  usernameEnvVar?: string;
  
  /** OAuth-specific configuration */
  oauth?: {
    /** Which OAuth provider to use */
    providerId: string;
    
    /** Custom authorization URL (overrides provider default) */
    authorizationUrl?: string;
    
    /** Custom token URL */
    tokenUrl?: string;
    
    /** Custom client ID */
    clientId?: string;
    
    /** Required scopes for this server */
    scopes: string[];
    
    /** Env var for access token */
    accessTokenEnvVar?: string;
    
    /** Env var for refresh token */
    refreshTokenEnvVar?: string;
  };
  
  /** Is this required to start the server? */
  required: boolean;
  
  /** Regex pattern for validation */
  pattern?: string;
  
  /** Placeholder text for input */
  placeholder?: string;
  
  /** Help URL for getting this credential */
  helpUrl?: string;
}

/**
 * Status of a credential (without the actual value).
 */
export interface CredentialInfo {
  key: string;
  type: 'api_key' | 'password' | 'oauth' | 'header';
  isSet: boolean;
  setAt?: number;
  expiresAt?: number;
  isExpired?: boolean;
  
  /** For OAuth: whether we have a refresh token */
  hasRefreshToken?: boolean;
  
  /** For password: whether username is set */
  hasUsername?: boolean;
}

