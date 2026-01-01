/**
 * Google OAuth Provider
 * 
 * OAuth 2.0 configuration for Google authentication.
 * Used for MCP servers that need Google API access (Drive, Calendar, etc.).
 */

import { OAuthConfig } from '../types.js';

/**
 * Google OAuth configuration.
 * 
 * Google fully supports PKCE and it's recommended.
 * The client ID should be set via environment variable or configuration.
 */
export const GOOGLE_OAUTH_CONFIG: OAuthConfig = {
  providerId: 'google',
  displayName: 'Google',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientId: process.env.HARBOR_GOOGLE_CLIENT_ID || '',
  scopes: [],
  pkceEnabled: true,
  revocationUrl: 'https://oauth2.googleapis.com/revoke',
};

/**
 * Common Google API scopes and their descriptions.
 */
export const GOOGLE_SCOPES = {
  // Drive
  'https://www.googleapis.com/auth/drive.readonly': 'Read-only access to Google Drive',
  'https://www.googleapis.com/auth/drive.file': 'Access to files created by the app',
  'https://www.googleapis.com/auth/drive': 'Full access to Google Drive',
  
  // Calendar
  'https://www.googleapis.com/auth/calendar.readonly': 'Read-only access to Calendar',
  'https://www.googleapis.com/auth/calendar': 'Full access to Calendar',
  'https://www.googleapis.com/auth/calendar.events': 'Manage calendar events',
  
  // Gmail
  'https://www.googleapis.com/auth/gmail.readonly': 'Read-only access to Gmail',
  'https://www.googleapis.com/auth/gmail.send': 'Send emails',
  'https://www.googleapis.com/auth/gmail.modify': 'Modify emails',
  
  // Sheets
  'https://www.googleapis.com/auth/spreadsheets.readonly': 'Read-only access to Sheets',
  'https://www.googleapis.com/auth/spreadsheets': 'Full access to Sheets',
  
  // User profile
  'https://www.googleapis.com/auth/userinfo.email': 'View email address',
  'https://www.googleapis.com/auth/userinfo.profile': 'View basic profile info',
  'openid': 'OpenID Connect authentication',
} as const;

/**
 * Create a Google OAuth config with custom scopes.
 */
export function createGoogleOAuthConfig(
  clientId: string,
  scopes: string[] = ['https://www.googleapis.com/auth/drive.readonly']
): OAuthConfig {
  return {
    ...GOOGLE_OAUTH_CONFIG,
    clientId,
    scopes,
  };
}

