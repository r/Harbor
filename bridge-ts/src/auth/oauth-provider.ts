/**
 * OAuth Provider
 * 
 * Base class for OAuth 2.0 authentication providers.
 * Handles authorization URL generation, token exchange, and refresh.
 */

import { randomBytes, createHash } from 'node:crypto';
import { log } from '../native-messaging.js';
import { OAuthConfig, OAuthTokens, OAuthFlowState } from './types.js';
import { getOAuthServer } from './oauth-server.js';

/**
 * Generate a random state parameter for CSRF protection.
 */
function generateState(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Generate PKCE code verifier and challenge.
 */
function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * OAuth 2.0 provider implementation.
 */
export class OAuthProvider {
  constructor(public readonly config: OAuthConfig) {}

  /**
   * Start the OAuth authorization flow.
   * Returns the URL to redirect the user to and the flow state.
   */
  async startAuthFlow(serverId: string, credentialKey: string): Promise<{
    authUrl: string;
    flow: OAuthFlowState;
  }> {
    const server = getOAuthServer();
    await server.start();

    const state = generateState();
    const callbackUrl = server.getCallbackUrl();

    // Build authorization URL
    const url = new URL(this.config.authorizationUrl);
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', state);

    if (this.config.scopes.length > 0) {
      url.searchParams.set('scope', this.config.scopes.join(' '));
    }

    let codeVerifier: string | undefined;

    // Add PKCE if enabled
    if (this.config.pkceEnabled) {
      const pkce = generatePKCE();
      codeVerifier = pkce.codeVerifier;
      url.searchParams.set('code_challenge', pkce.codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
    }

    const flow: OAuthFlowState = {
      state,
      codeVerifier,
      providerId: this.config.providerId,
      serverId,
      credentialKey,
      startedAt: Date.now(),
    };

    log(`[OAuth] Started auth flow for ${this.config.providerId} (server: ${serverId})`);

    return {
      authUrl: url.toString(),
      flow,
    };
  }

  /**
   * Exchange authorization code for tokens.
   */
  async exchangeCode(
    code: string,
    flow: OAuthFlowState
  ): Promise<OAuthTokens> {
    const server = getOAuthServer();
    const callbackUrl = server.getCallbackUrl();

    const body = new URLSearchParams({
      client_id: this.config.clientId,
      code,
      redirect_uri: callbackUrl,
      grant_type: 'authorization_code',
    });

    // Add PKCE verifier if we used it
    if (flow.codeVerifier) {
      body.set('code_verifier', flow.codeVerifier);
    }

    log(`[OAuth] Exchanging code for tokens (provider: ${this.config.providerId})`);

    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`[OAuth] Token exchange failed: ${response.status} ${errorText}`);
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    const tokens: OAuthTokens = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type || 'Bearer',
      scope: data.scope,
    };

    // Calculate expiry time
    if (data.expires_in) {
      tokens.expiresAt = Date.now() + (data.expires_in * 1000);
    }

    log(`[OAuth] Token exchange successful (has refresh: ${!!tokens.refreshToken})`);

    return tokens;
  }

  /**
   * Refresh an expired access token.
   */
  async refreshToken(refreshToken: string): Promise<OAuthTokens> {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });

    log(`[OAuth] Refreshing token (provider: ${this.config.providerId})`);

    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text();
      log(`[OAuth] Token refresh failed: ${response.status} ${errorText}`);
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      token_type?: string;
      scope?: string;
    };

    const tokens: OAuthTokens = {
      accessToken: data.access_token,
      // Some providers return a new refresh token, some don't
      refreshToken: data.refresh_token || refreshToken,
      tokenType: data.token_type || 'Bearer',
      scope: data.scope,
    };

    if (data.expires_in) {
      tokens.expiresAt = Date.now() + (data.expires_in * 1000);
    }

    log(`[OAuth] Token refresh successful`);

    return tokens;
  }

  /**
   * Revoke access (if provider supports it).
   */
  async revokeAccess(accessToken: string): Promise<void> {
    if (!this.config.revocationUrl) {
      log(`[OAuth] Provider ${this.config.providerId} doesn't support revocation`);
      return;
    }

    const body = new URLSearchParams({
      token: accessToken,
    });

    log(`[OAuth] Revoking access (provider: ${this.config.providerId})`);

    try {
      await fetch(this.config.revocationUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
      });
      log(`[OAuth] Access revoked`);
    } catch (e) {
      log(`[OAuth] Revocation failed: ${e}`);
      // Don't throw - revocation failure shouldn't block other actions
    }
  }
}

