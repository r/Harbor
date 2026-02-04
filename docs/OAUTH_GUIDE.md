# OAuth Guide for Harbor

This guide covers how OAuth authentication works in Harbor, how to set it up, and how to integrate it into MCP servers.

## Table of Contents

1. [Overview](#overview)
2. [For End Users](#for-end-users)
3. [For Developers Setting Up Harbor](#for-developers-setting-up-harbor)
4. [For MCP Server Authors](#for-mcp-server-authors)
5. [Troubleshooting](#troubleshooting)
6. [Known Limitations & Open Questions](#known-limitations--open-questions)

---

## Overview

Harbor can handle OAuth flows on behalf of MCP servers, so users don't need to create their own OAuth apps for every service. When an MCP server needs to access an API like Gmail or GitHub, Harbor:

1. Initiates the OAuth authorization flow
2. Opens the provider's login page
3. Handles the callback
4. Securely stores tokens
5. Refreshes tokens automatically when they expire
6. Injects tokens into MCP server environments

### Supported Providers

| Provider | Status | PKCE Support |
|----------|--------|--------------|
| Google   | ✅ Supported | Yes |
| GitHub   | ✅ Supported | No |
| Microsoft | 📋 Planned | - |
| Slack    | 📋 Planned | - |

### How It Works

```
┌────────────┐     ┌────────────┐     ┌──────────────────┐
│  MCP       │     │  Harbor    │     │  OAuth Provider  │
│  Server    │     │  Bridge    │     │  (Google, etc.)  │
└─────┬──────┘     └─────┬──────┘     └────────┬─────────┘
      │                  │                     │
      │  needs token     │                     │
      │─────────────────>│                     │
      │                  │  authorization URL  │
      │                  │────────────────────>│
      │                  │                     │
      │                  │    user authorizes  │
      │                  │<────────────────────│
      │                  │                     │
      │                  │  exchange code      │
      │                  │────────────────────>│
      │                  │                     │
      │                  │  access + refresh   │
      │                  │<────────────────────│
      │                  │                     │
      │   token          │                     │
      │<─────────────────│                     │
      │                  │                     │
```

---

## For End Users

### When Do I Need OAuth?

You need to authorize via OAuth when:
- Installing an MCP server that accesses personal data (Gmail, GitHub repos, etc.)
- The MCP server's manifest includes an `oauth` section

You'll see an authorization prompt in the Harbor sidebar when this is needed.

### How to Authorize

1. Open Harbor sidebar
2. Install or start using an MCP server that needs OAuth
3. Click "Authorize" when prompted
4. Sign in to the provider (Google, GitHub, etc.)
5. Grant the requested permissions
6. You'll be redirected back to Harbor

### Revoking Access

To revoke OAuth access:
1. Open Harbor sidebar → Settings → OAuth
2. Find the provider you want to revoke
3. Click "Revoke"

You can also revoke from the provider's settings:
- **Google**: https://myaccount.google.com/permissions
- **GitHub**: https://github.com/settings/applications

---

## For Developers Setting Up Harbor

If you're building Harbor from source or deploying it, you'll need to configure OAuth credentials.

### Quick Setup

```bash
# 1. Copy the example config
cp config/oauth.env.example config/oauth.env

# 2. Edit with your credentials
# (see provider-specific instructions below)

# 3. Build Harbor - credentials will be baked in
npm run build
```

### Google OAuth Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. Create a new project (or select existing)
3. Configure OAuth consent screen:
   - User type: External
   - App name: Harbor
   - Add scopes as needed (e.g., `gmail.readonly`, `gmail.send`)
4. Create OAuth client:
   - Type: **Desktop app**
   - Name: Harbor Desktop
5. Copy Client ID and Client Secret to `config/oauth.env`:

```bash
HARBOR_GOOGLE_CLIENT_ID="your-client-id.apps.googleusercontent.com"
HARBOR_GOOGLE_CLIENT_SECRET="your-client-secret"
```

**Important:** For production use, submit your app for Google verification to remove the "unverified app" warning.

### GitHub OAuth Setup

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Fill in:
   - Application name: Harbor
   - Homepage URL: `https://github.com/anthropics/harbor`
   - Authorization callback URL: `http://localhost:8765/oauth/callback`
4. Copy Client ID and generate a Client Secret:

```bash
HARBOR_GITHUB_CLIENT_ID="your-client-id"
HARBOR_GITHUB_CLIENT_SECRET="your-client-secret"
```

**Note:** GitHub does not support PKCE, so a client secret is required.

### OAuth Callback Port

Harbor's OAuth callback server runs on port `8765` by default. If this conflicts with something on your system, you can configure a different port:

```bash
HARBOR_OAUTH_CALLBACK_PORT="8765"
```

**Note:** If you change the port, update your OAuth app's callback URL accordingly.

### Runtime Overrides

Users can override baked-in OAuth credentials by creating `~/.harbor/config.env`:

```bash
# Override Google credentials
HARBOR_GOOGLE_CLIENT_ID="user-client-id"
HARBOR_GOOGLE_CLIENT_SECRET="user-secret"
```

---

## For MCP Server Authors

### Adding OAuth to Your MCP Server

If your server needs OAuth, add an `oauth` section to your manifest:

```json
{
  "manifestVersion": "1.0.0",
  "name": "my-gmail-server",
  "version": "1.0.0",
  
  "oauth": {
    "provider": "google",
    "scopes": [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send"
    ],
    "tokenEnvVar": "GMAIL_ACCESS_TOKEN"
  },
  
  "capabilities": {
    "network": {
      "hosts": ["gmail.googleapis.com"]
    }
  }
}
```

### Using OAuth Tokens

Harbor injects the access token as an environment variable:

**JavaScript:**
```javascript
const token = process.env.GMAIL_ACCESS_TOKEN;

const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Rust/WASM:**
```rust
let token = std::env::var("GMAIL_ACCESS_TOKEN")?;
// Use token in HTTP requests
```

### OAuth Manifest Options

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | string | Yes | `"google"`, `"github"`, `"microsoft"`, `"slack"`, or `"custom"` |
| `scopes` | string[] | Yes | OAuth scopes to request |
| `tokenEnvVar` | string | No | Env var name for access token (default: `{PROVIDER}_ACCESS_TOKEN`) |
| `supportedSources` | string[] | No | How tokens can be provided (see below) |

### Token Sources

The `supportedSources` field controls how tokens are provided:

| Value | Meaning |
|-------|---------|
| `"host"` | Harbor handles OAuth and injects tokens (recommended) |
| `"user"` | User must set up their own OAuth app |
| `"server"` | Server handles OAuth itself |

**Example with multiple sources:**
```json
{
  "oauth": {
    "provider": "google",
    "supportedSources": ["host", "user"],
    "preferredSource": "host",
    "scopes": ["..."],
    "hostMode": {
      "tokenEnvVar": "GMAIL_ACCESS_TOKEN"
    },
    "userMode": {
      "clientCredentialsPath": "~/.config/my-server/client-secret.json"
    }
  }
}
```

### Token Refresh

Harbor automatically refreshes tokens when they expire. Your server should handle 401 responses gracefully in case of any timing issues:

```javascript
async function callApi() {
  const token = process.env.GMAIL_ACCESS_TOKEN;
  const response = await fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  
  if (response.status === 401) {
    // Token might be expired, harbor will refresh on next request
    throw new Error('Token expired, please retry');
  }
  
  return response.json();
}
```

---

## Troubleshooting

### "OAuth credentials not configured"

Harbor doesn't have OAuth credentials for this provider.

**Solutions:**
1. Check that `config/oauth.env` exists and has the provider's credentials
2. Rebuild Harbor after adding credentials
3. Or add credentials to `~/.harbor/config.env` at runtime

### "Invalid redirect URI"

The OAuth callback URL doesn't match what's configured in the provider.

**Solutions:**
1. Ensure your OAuth app has `http://localhost:8765/oauth/callback` as a callback URL
2. For GitHub, use `http://localhost:8765/callback`
3. Check that `HARBOR_OAUTH_CALLBACK_PORT` matches the port in your callback URL

### "Port already in use" during OAuth

The OAuth callback port (8765) is being used by another application.

**Solutions:**
1. Close the conflicting application
2. Change the port in `config/oauth.env`:
   ```bash
   HARBOR_OAUTH_CALLBACK_PORT="8766"
   ```
3. Update your OAuth app's callback URL to use the new port
4. Rebuild Harbor

### "Token expired" errors

Usually Harbor refreshes tokens automatically, but sometimes:
- The refresh token itself has expired (user must re-authorize)
- Network issues prevented refresh
- Provider revoked the token

**Solutions:**
1. Try revoking and re-authorizing in Harbor settings
2. Check if the app still has access in the provider's settings

### "Unverified app" warning (Google)

Google shows this warning for OAuth apps that haven't completed verification.

**For development:** Click "Advanced" → "Go to [app name] (unsafe)"

**For production:** Submit your app for Google verification.

---

## Known Limitations & Open Questions

### Current Limitations

1. **Limited Provider Support**: Only Google and GitHub are fully implemented. Microsoft and Slack are documented but not yet functional.

2. **No Custom Providers Yet**: The `"custom"` provider option in the schema is not fully implemented.

3. **Single User Model**: Harbor currently assumes a single user. There's no multi-user token isolation.

4. **WASM Servers**: OAuth is not supported for WASM MCP servers. Use JavaScript servers for OAuth-requiring integrations.

5. **Token Storage**: Tokens are stored in `~/.harbor/oauth_tokens.json` with file permissions set to 600. This may not be sufficient for all security requirements.

---

### ⚠️ Open Questions: User Authentication Model

> **This section documents architectural decisions that need to be made for Harbor's OAuth and authentication approach.**

The current OAuth implementation works for the "Harbor manages tokens for the user" model, but several open questions remain:

#### 1. Who owns the OAuth credentials?

Currently Harbor supports two modes:
- **Host mode**: Harbor's OAuth app credentials are baked into releases
- **User mode**: Users create their own OAuth apps

**Questions:**
- Should Harbor ship with official OAuth credentials for common providers?
- What happens when many users share the same OAuth app (rate limits, abuse)?
- How do we handle provider verification requirements (Google requires verification for sensitive scopes)?

#### 2. Multi-user scenarios

Harbor currently assumes single-user desktop use.

**Questions:**
- How should tokens be isolated in shared environments?
- Should there be per-profile token storage?
- How do web deployments (if any) handle multi-tenancy?

#### 3. Token lifecycle and security

**Questions:**
- Should tokens be encrypted at rest? (Currently plaintext JSON)
- How long should refresh tokens be cached?
- How do we handle refresh token rotation (some providers rotate on each use)?
- Should there be automatic token revocation on uninstall?

#### 4. MCP Server trust model

When an MCP server requests OAuth tokens, we inject them into its environment.

**Questions:**
- Should users approve token sharing per-server?
- Can we scope tokens more narrowly than what the server requests?
- How do we audit which servers accessed which tokens?

#### 5. Alternative approaches to consider

- **Server-side OAuth proxy**: Instead of desktop OAuth flows, route through a server
- **Per-server OAuth apps**: Each MCP server brings its own OAuth credentials
- **WebAuthn/Passkeys**: For Harbor's own authentication (if needed)
- **OAuth 2.1 / GNAP**: Newer standards that may address some issues

---

### Contributing

If you have opinions or expertise on these authentication questions, please:
1. Open an issue on GitHub with the `auth` label
2. Reference this document
3. Share your use case and requirements

We want to get authentication right, and community input is valuable.

---

## See Also

- [MCP Authoring Guide](../mcp-servers/AUTHORING_GUIDE.md) - Full guide to creating MCP servers
- [MCP Manifest Spec](MCP_MANIFEST_SPEC.md) - Complete manifest reference
- [Gmail Example](../mcp-servers/examples/gmail/) - Real-world OAuth integration
- [Configuration README](../config/README.md) - Overview of all configuration files
