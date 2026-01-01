/**
 * GitHub OAuth Provider
 * 
 * OAuth 2.0 configuration for GitHub authentication.
 * Used for MCP servers that need GitHub API access.
 */

import { OAuthConfig } from '../types.js';

/**
 * GitHub OAuth configuration.
 * 
 * Note: GitHub doesn't fully support PKCE yet, so we disable it.
 * The client ID should be set via environment variable or configuration.
 */
export const GITHUB_OAUTH_CONFIG: OAuthConfig = {
  providerId: 'github',
  displayName: 'GitHub',
  authorizationUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  clientId: process.env.HARBOR_GITHUB_CLIENT_ID || '',
  scopes: ['repo', 'read:org', 'read:user'],
  pkceEnabled: false, // GitHub's implementation is incomplete
  revocationUrl: undefined, // GitHub doesn't have a revocation endpoint
};

/**
 * Common GitHub scopes and their descriptions.
 */
export const GITHUB_SCOPES = {
  'repo': 'Full access to repositories',
  'read:org': 'Read organization membership',
  'read:user': 'Read user profile data',
  'user:email': 'Access user email addresses',
  'gist': 'Create and manage gists',
  'read:packages': 'Read packages',
  'write:packages': 'Write packages',
  'read:project': 'Read projects',
  'write:project': 'Write projects',
} as const;

/**
 * Create a GitHub OAuth config with custom scopes.
 */
export function createGitHubOAuthConfig(
  clientId: string,
  scopes: string[] = ['repo', 'read:org']
): OAuthConfig {
  return {
    ...GITHUB_OAUTH_CONFIG,
    clientId,
    scopes,
  };
}

