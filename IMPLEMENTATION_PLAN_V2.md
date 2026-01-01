# Harbor Implementation Plan v2: Streamlined MCP Server Installation

## Vision

A Firefox extension that provides a **seamless, reliable environment** for installing and running MCP servers of all types (JavaScript/TypeScript, Python, Go binaries). Focus on:

1. **Curated directory** of handpicked, tested MCP servers
2. **GitHub repository installer** - paste any MCP server repo URL and we'll figure out how to install it
3. **JSON config import** - paste Claude Desktop / Cursor MCP config and we import it
4. **VS Code button detection** - detect "Install in VS Code" buttons on web pages and offer one-click install
5. **Docker isolation** (optional) - run servers in containers to bypass macOS Gatekeeper issues

---

## Key Decisions

### What We're Removing
- Auto-generated directory from GitHub Awesome lists and official registry
- Complex catalog providers/enrichment system
- Trying to scrape/parse arbitrary server listings

### What We're Keeping
- JSON config import for remote HTTP/SSE servers
- Runtime detection (Node.js, Python/uv, Docker)
- Credential/secret management
- MCP client connection via stdio and HTTP
- LLM integration (Ollama, llamafile)
- Chat orchestration

### What We're Adding
- **Curated server list** - handpicked servers we know work
- **GitHub URL resolver** - given a GitHub repo, detect package type and install
- **VS Code button detector** - content script that reads MCP install buttons
- **Docker execution provider** - optional container isolation

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           FIREFOX EXTENSION                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                          SIDEBAR                                       │  │
│  │                                                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  🎯 CURATED SERVERS                                             │  │  │
│  │  │                                                                  │  │  │
│  │  │  📁 Filesystem    [Install]  ← npm: @modelcontextprotocol/...   │  │  │
│  │  │  🐙 GitHub        [Install]  ← Go binary from releases          │  │  │
│  │  │  🧠 Memory        [Install]  ← npm: @modelcontextprotocol/...   │  │  │
│  │  │  🕐 Time          [Install]  ← Python: mcp-server-time          │  │  │
│  │  │  🔍 Brave Search  [Install]  ← npm: @anthropic/...              │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  ➕ ADD SERVER                                                   │  │  │
│  │  │                                                                  │  │  │
│  │  │  • Paste GitHub URL: [github.com/user/repo________] [Install]  │  │  │
│  │  │  • Import JSON Config                                [Import]   │  │  │
│  │  │  • Add Remote Server (HTTP/SSE)                      [Add]      │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  │                                                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐  │  │
│  │  │  📦 MY SERVERS                                                  │  │  │
│  │  │                                                                  │  │  │
│  │  │  ● Filesystem     [Running]  [Stop] [Tools]                     │  │  │
│  │  │  ○ GitHub         [Stopped]  [Start] [Configure]                │  │  │
│  │  └─────────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  CONTENT SCRIPT: VS Code Button Detector                              │  │
│  │                                                                        │  │
│  │  When on a page with <a href="vscode:extension/...">Install</a>       │  │
│  │  → Inject a "Install in Harbor" button next to it                     │  │
│  │  → Read the mcp:// or vscode:// URL scheme data                       │  │
│  │  → Send to background script for installation                          │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                         Native Messaging (JSON)
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           NODE.JS BRIDGE                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  CURATED DIRECTORY                                                     │  │
│  │                                                                        │  │
│  │  Static list of servers with known-good install methods:               │  │
│  │  - Package type (npm, pypi, binary)                                   │  │
│  │  - Package ID or GitHub release URL                                   │  │
│  │  - Required environment variables                                      │  │
│  │  - Docker image (optional alternative)                                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  GITHUB RESOLVER                                                       │  │
│  │                                                                        │  │
│  │  Given: github.com/user/repo                                          │  │
│  │  1. Fetch repo metadata                                               │  │
│  │  2. Check for package.json → npm                                      │  │
│  │  3. Check for pyproject.toml → pypi                                   │  │
│  │  4. Check for go.mod → Go binary (look for releases)                  │  │
│  │  5. Return install instructions                                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  EXECUTION PROVIDERS                                                   │  │
│  │                                                                        │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │  │
│  │  │  NativeExec     │  │  DockerExec     │  │  BinaryExec     │       │  │
│  │  │                 │  │                 │  │                 │       │  │
│  │  │  npx/uvx        │  │  docker run     │  │  ~/.harbor/bin/ │       │  │
│  │  │  Direct spawn   │  │  Container      │  │  Direct binary  │       │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Curated Directory (Core)

### 1.1 Define Curated Server List

Create a static list of well-tested MCP servers:

```typescript
// src/directory/curated-servers.ts

export interface CuratedServer {
  id: string;
  name: string;
  description: string;
  icon: string;
  
  // Installation method - exactly one of these
  install: 
    | { type: 'npm'; package: string; }
    | { type: 'pypi'; package: string; }
    | { type: 'binary'; github: string; binaryName: string; }
    | { type: 'docker'; image: string; }
  
  // Optional Docker alternative for any server
  dockerAlternative?: {
    image: string;
    args?: string[];
  };
  
  // Required env vars for configuration
  envVars?: Array<{
    name: string;
    description: string;
    required: boolean;
    isSecret: boolean;
  }>;
  
  // Runtime args to pass to the server
  args?: string[];
  
  // Links
  homepage: string;
  repository?: string;
}

export const CURATED_SERVERS: CuratedServer[] = [
  {
    id: 'filesystem',
    name: 'Filesystem',
    description: 'Read, write, and manage local files. Essential for working with documents and code.',
    icon: '📁',
    install: { type: 'npm', package: '@modelcontextprotocol/server-filesystem' },
    envVars: [
      { name: 'ALLOWED_PATHS', description: 'Comma-separated list of allowed directories', required: true, isSecret: false }
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'github-mcp',
    name: 'GitHub',
    description: 'Access repositories, issues, PRs, and more via GitHub API.',
    icon: '🐙',
    install: { type: 'binary', github: 'github/github-mcp-server', binaryName: 'github-mcp-server' },
    dockerAlternative: {
      image: 'ghcr.io/github/github-mcp-server:latest',
    },
    envVars: [
      { name: 'GITHUB_PERSONAL_ACCESS_TOKEN', description: 'GitHub PAT with repo access', required: true, isSecret: true }
    ],
    homepage: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'memory',
    name: 'Memory',
    description: 'Store and retrieve information across conversations using a knowledge graph.',
    icon: '🧠',
    install: { type: 'npm', package: '@modelcontextprotocol/server-memory' },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'time',
    name: 'Time',
    description: 'Get current time, convert timezones, and work with dates.',
    icon: '🕐',
    install: { type: 'pypi', package: 'mcp-server-time' },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time',
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description: 'Search the web using Brave Search API.',
    icon: '🔍',
    install: { type: 'npm', package: '@modelcontextprotocol/server-brave-search' },
    envVars: [
      { name: 'BRAVE_API_KEY', description: 'Brave Search API key', required: true, isSecret: true }
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search',
  },
  {
    id: 'fetch',
    name: 'Fetch',
    description: 'Fetch and read web pages for the LLM.',
    icon: '🌐',
    install: { type: 'npm', package: '@modelcontextprotocol/server-fetch' },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description: 'Browser automation - navigate, screenshot, and interact with web pages.',
    icon: '🎭',
    install: { type: 'npm', package: '@modelcontextprotocol/server-puppeteer' },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer',
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description: 'Query and analyze SQLite databases.',
    icon: '🗃️',
    install: { type: 'npm', package: '@modelcontextprotocol/server-sqlite' },
    envVars: [
      { name: 'DATABASE_PATH', description: 'Path to SQLite database file', required: true, isSecret: false }
    ],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite',
  },
];
```

### 1.2 Simplify Directory UI

Replace the complex directory page with a simple sidebar section:

- **Curated Servers**: Show the static list with install buttons
- **Add Custom**: GitHub URL input, JSON import, Remote server
- **My Servers**: Installed servers with start/stop/configure

### 1.3 Remove Old Catalog System

Files to remove/simplify:
- `bridge-ts/src/catalog/official-registry.ts` - Remove
- `bridge-ts/src/catalog/github-awesome.ts` - Remove  
- `bridge-ts/src/catalog/enrichment.ts` - Remove
- `bridge-ts/src/catalog/provider-registry.ts` - Remove
- `bridge-ts/src/catalog/worker.ts` - Remove
- `bridge-ts/src/catalog/database.ts` - Simplify to just store installed servers
- `bridge-ts/src/catalog/manager.ts` - Replace with simple curated list

---

## Phase 2: GitHub Repository Installer

### 2.1 Enhanced GitHub Resolver

Improve the existing `github-resolver.ts` to:

1. Accept any GitHub URL format:
   - `github.com/user/repo`
   - `https://github.com/user/repo`
   - `git@github.com:user/repo.git`

2. Detect project type:
   - Check `package.json` → npm package
   - Check `pyproject.toml` or `setup.py` → Python package  
   - Check `go.mod` → Go binary
   - Check for MCP-specific config files

3. For Go projects:
   - Parse releases to find the right binary for current platform
   - Download and install to `~/.harbor/bin/`

```typescript
// src/installer/github-resolver.ts

export interface ResolvedPackage {
  type: 'npm' | 'pypi' | 'binary';
  identifier: string;          // Package name or binary URL
  name: string;                // Display name
  description?: string;
  envVars?: EnvVarRequirement[];
  
  // For binaries
  binaryUrl?: string;
  binaryName?: string;
}

export async function resolveGitHubRepo(repoUrl: string): Promise<ResolvedPackage> {
  const { owner, repo } = parseGitHubUrl(repoUrl);
  
  // Check package.json first (most common for MCP servers)
  const packageJson = await fetchFile(owner, repo, 'package.json');
  if (packageJson) {
    return resolveNpmPackage(owner, repo, packageJson);
  }
  
  // Check pyproject.toml
  const pyproject = await fetchFile(owner, repo, 'pyproject.toml');
  if (pyproject) {
    return resolvePythonPackage(owner, repo, pyproject);
  }
  
  // Check go.mod
  const goMod = await fetchFile(owner, repo, 'go.mod');
  if (goMod) {
    return resolveGoBinary(owner, repo);
  }
  
  throw new Error(`Could not detect package type for ${owner}/${repo}`);
}
```

---

## Phase 3: Docker Execution Provider

### 3.1 Why Docker?

On macOS, downloaded binaries trigger Gatekeeper security prompts. Users must:
1. Go to System Settings → Privacy & Security
2. Click "Allow Anyway"
3. Confirm again on next run

Docker containers bypass this because:
- Docker itself is already trusted/signed
- Container images don't trigger Gatekeeper
- Provides consistent execution environment

### 3.2 Docker Execution Provider

```typescript
// src/installer/docker-exec.ts

export interface DockerExecOptions {
  image: string;
  args?: string[];
  env?: Record<string, string>;
  volumes?: Array<{
    host: string;
    container: string;
    mode?: 'ro' | 'rw';
  }>;
}

export class DockerExecProvider {
  /**
   * Check if Docker is available and running.
   */
  async isAvailable(): Promise<boolean> {
    try {
      execSync('docker info', { timeout: 5000, stdio: 'pipe' });
      return true;
    } catch {
      return false;
    }
  }
  
  /**
   * Pull a Docker image if not present.
   */
  async ensureImage(image: string): Promise<void> {
    // Check if image exists locally
    try {
      execSync(`docker image inspect ${image}`, { stdio: 'pipe' });
      return; // Already exists
    } catch {
      // Need to pull
    }
    
    // Pull the image
    await new Promise<void>((resolve, reject) => {
      const pull = spawn('docker', ['pull', image], { stdio: 'inherit' });
      pull.on('exit', code => code === 0 ? resolve() : reject(new Error(`Pull failed: ${code}`)));
    });
  }
  
  /**
   * Run an MCP server in a Docker container.
   * Returns the child process for stdio communication.
   */
  async run(options: DockerExecOptions): Promise<ChildProcess> {
    await this.ensureImage(options.image);
    
    const args = ['run', '-i', '--rm'];
    
    // Add environment variables
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push('-e', `${key}=${value}`);
      }
    }
    
    // Add volume mounts
    if (options.volumes) {
      for (const vol of options.volumes) {
        args.push('-v', `${vol.host}:${vol.container}:${vol.mode || 'rw'}`);
      }
    }
    
    args.push(options.image);
    
    if (options.args) {
      args.push(...options.args);
    }
    
    return spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  }
}
```

### 3.3 Integration with MCP Client

Modify `McpClientManager.connectStdio()` to use Docker when:
1. User has enabled "Use Docker" preference
2. Server has a `dockerAlternative` defined
3. Direct execution failed due to security issues

---

## Phase 4: VS Code Button Detector

### 4.1 How VS Code Install Buttons Work

Many MCP servers have "Install in VS Code" buttons that use URL schemes:
- `vscode:extension/...` - Install VS Code extension
- Some use custom schemes or deep links

We can detect these and offer to install in Harbor instead.

### 4.2 Content Script

```typescript
// extension/src/content-scripts/vscode-detector.ts

interface DetectedInstall {
  type: 'npm' | 'pypi' | 'github';
  identifier: string;
  name: string;
  buttonElement: HTMLElement;
}

function detectVSCodeButtons(): DetectedInstall[] {
  const installs: DetectedInstall[] = [];
  
  // Look for common MCP install button patterns
  const patterns = [
    // GitHub README badges
    'a[href*="vscode:extension"]',
    'a[href*="cursor://"]',
    // MCP-specific install links
    'a[href*="mcp://"]',
    // npm package links that look like install buttons
    'a[href*="npmjs.com/package/@modelcontextprotocol"]',
    'a[href*="npmjs.com/package/mcp-"]',
  ];
  
  for (const pattern of patterns) {
    const elements = document.querySelectorAll(pattern);
    // Parse and collect...
  }
  
  return installs;
}

function injectHarborButtons(installs: DetectedInstall[]): void {
  for (const install of installs) {
    const harborBtn = document.createElement('button');
    harborBtn.className = 'harbor-install-btn';
    harborBtn.textContent = '⚓ Install in Harbor';
    harborBtn.onclick = () => {
      browser.runtime.sendMessage({
        type: 'install_from_page',
        install,
      });
    };
    install.buttonElement.parentElement?.appendChild(harborBtn);
  }
}
```

### 4.3 Styles

Inject minimal CSS to style the Harbor button to match the page context.

---

## Phase 5: Simplified Data Model

### 5.1 InstalledServer (Updated)

```typescript
export interface InstalledServer {
  id: string;
  name: string;
  description?: string;
  
  // How to run this server
  execution:
    | { type: 'npm'; package: string; args?: string[]; }
    | { type: 'pypi'; package: string; args?: string[]; }
    | { type: 'binary'; path: string; args?: string[]; }
    | { type: 'docker'; image: string; args?: string[]; volumes?: Volume[]; }
    | { type: 'http'; url: string; headers?: Record<string, string>; }
    | { type: 'sse'; url: string; headers?: Record<string, string>; }
  
  // Where did this come from?
  source:
    | { type: 'curated'; curatedId: string; }
    | { type: 'github'; repo: string; }
    | { type: 'json-import'; }
    | { type: 'manual'; }
  
  // Required environment variables
  envVars: Array<{
    name: string;
    description?: string;
    required: boolean;
    isSecret: boolean;
  }>;
  
  // When installed/updated
  installedAt: number;
  updatedAt?: number;
  
  // User preferences
  preferDocker?: boolean;
}
```

### 5.2 Storage

Use a simple JSON file instead of SQLite for installed servers:
- `~/.harbor/servers.json` - Installed server configs
- `~/.harbor/credentials.json` - Encrypted credentials
- `~/.harbor/bin/` - Downloaded binaries

---

## Implementation Order

### Week 1: Core Simplification
1. ✅ Create `curated-servers.ts` with static server list
2. Remove old catalog providers (keep database for installed servers only)
3. Update sidebar UI to show curated list
4. Simplify directory.ts to just show curated + custom

### Week 2: GitHub Installer
1. Enhance `github-resolver.ts` for all project types
2. Add UI for pasting GitHub URLs
3. Test with various MCP servers (npm, python, go)

### Week 3: Docker Support
1. Create `docker-exec.ts` provider
2. Add Docker images for curated servers where available
3. Add "Use Docker" toggle in settings
4. Test Docker execution flow

### Week 4: VS Code Detection + Polish
1. Create content script for button detection
2. Style and polish the injected buttons
3. End-to-end testing
4. Documentation

---

## Files to Modify

### Bridge (bridge-ts/src/)

**Remove:**
- `catalog/official-registry.ts`
- `catalog/github-awesome.ts`
- `catalog/enrichment.ts`
- `catalog/provider-registry.ts`
- `catalog/worker.ts`

**Simplify:**
- `catalog/manager.ts` → Just returns curated list + installed
- `catalog/database.ts` → Only stores installed servers

**Add:**
- `directory/curated-servers.ts` - Static server definitions
- `installer/docker-exec.ts` - Docker execution provider

**Modify:**
- `installer/github-resolver.ts` - Enhanced URL parsing
- `mcp/manager.ts` - Docker execution support
- `handlers.ts` - New message types

### Extension (extension/src/)

**Remove:**
- Complex directory page (replace with simple list)

**Add:**
- `content-scripts/vscode-detector.ts` - Button detection
- `content-scripts/vscode-detector.css` - Button styles

**Modify:**
- `sidebar.ts` - Show curated servers, add GitHub URL input
- `background.ts` - Handle new message types
- `manifest.json` - Add content script permissions

---

## Message Protocol Changes

### New Messages

```
install_curated      { curated_id }           → { server, needsConfig }
install_from_github  { github_url }           → { server, needsConfig }
install_from_page    { type, identifier }     → { server, needsConfig }

get_curated_list     {}                       → { servers[] }
check_docker         {}                       → { available, version }
set_prefer_docker    { server_id, prefer }    → { success }
```

### Removed Messages

```
catalog_get          - Replaced by get_curated_list
catalog_refresh      - No longer needed
catalog_enrich       - Removed
resolve_server_package - Integrated into install flow
```

---

## Phase 6: Authentication & Credentials

### 6.1 Authentication Types

MCP servers require various authentication methods:

| Type | Example | Flow |
|------|---------|------|
| **API Key** | `GITHUB_TOKEN`, `BRAVE_API_KEY` | User enters token directly |
| **OAuth 2.0** | GitHub OAuth App, Google Cloud | Redirect flow with callback |
| **Password** | Database credentials | Username + password pair |
| **Header** | Custom auth headers | Key-value pairs |

### 6.2 Credential Flow Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        CREDENTIAL FLOW                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  1. User installs server that requires auth                             │
│                                                                          │
│  2. Sidebar shows "Needs Configuration" badge                           │
│     └─> Click opens Credential Modal                                    │
│                                                                          │
│  3. For API Keys:                                                        │
│     ┌──────────────────────────────────────────┐                        │
│     │  Configure GitHub Server                  │                        │
│     │                                           │                        │
│     │  GITHUB_PERSONAL_ACCESS_TOKEN *           │                        │
│     │  ┌─────────────────────────────────────┐  │                        │
│     │  │ ghp_xxxxxxxxxxxxxxxxxxxx            │  │                        │
│     │  └─────────────────────────────────────┘  │                        │
│     │  [Get token from GitHub →]                │                        │
│     │                                           │                        │
│     │  [Cancel]              [Save & Start]     │                        │
│     └──────────────────────────────────────────┘                        │
│                                                                          │
│  4. For OAuth:                                                           │
│     ┌──────────────────────────────────────────┐                        │
│     │  Configure Google Drive Server            │                        │
│     │                                           │                        │
│     │  This server uses OAuth for access.       │                        │
│     │                                           │                        │
│     │  [Connect with Google]                    │                        │
│     │                                           │                        │
│     │  Status: Not connected                    │                        │
│     └──────────────────────────────────────────┘                        │
│           │                                                              │
│           ▼                                                              │
│     Opens OAuth popup/redirect                                          │
│           │                                                              │
│           ▼                                                              │
│     Callback URL: http://localhost:8765/oauth/callback                  │
│           │                                                              │
│           ▼                                                              │
│     Store tokens in SecretStore                                         │
│                                                                          │
│  5. Credentials stored encrypted in ~/.harbor/credentials.json          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 6.3 OAuth Provider Interface

```typescript
// src/auth/oauth-provider.ts

export interface OAuthConfig {
  providerId: string;           // 'github', 'google', etc.
  displayName: string;
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  scopes: string[];
  pkceEnabled: boolean;         // Use PKCE for security
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType: string;
  scope?: string;
}

export interface OAuthProvider {
  readonly config: OAuthConfig;
  
  // Start the OAuth flow - returns the authorization URL
  startAuthFlow(): Promise<{ url: string; state: string; codeVerifier?: string }>;
  
  // Handle the callback and exchange code for tokens
  handleCallback(code: string, state: string, codeVerifier?: string): Promise<OAuthTokens>;
  
  // Refresh an expired token
  refreshToken(refreshToken: string): Promise<OAuthTokens>;
  
  // Revoke access
  revokeAccess(accessToken: string): Promise<void>;
}
```

### 6.4 OAuth Callback Server

The bridge runs a lightweight HTTP server to handle OAuth callbacks:

```typescript
// src/auth/oauth-server.ts

import { createServer, IncomingMessage, ServerResponse } from 'node:http';

const OAUTH_PORT = 8765;
const CALLBACK_PATH = '/oauth/callback';

interface PendingOAuth {
  state: string;
  codeVerifier?: string;
  providerId: string;
  serverId: string;
  resolve: (code: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class OAuthCallbackServer {
  private server: ReturnType<typeof createServer> | null = null;
  private pendingFlows: Map<string, PendingOAuth> = new Map();
  
  async start(): Promise<void> {
    if (this.server) return;
    
    this.server = createServer((req, res) => this.handleRequest(req, res));
    
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(OAUTH_PORT, '127.0.0.1', () => {
        log(`[OAuth] Callback server listening on port ${OAUTH_PORT}`);
        resolve();
      });
      this.server!.on('error', reject);
    });
  }
  
  async stop(): Promise<void> {
    if (!this.server) return;
    
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }
  
  registerPendingFlow(flow: Omit<PendingOAuth, 'timeout'>): void {
    // Timeout after 5 minutes
    const timeout = setTimeout(() => {
      this.pendingFlows.delete(flow.state);
      flow.reject(new Error('OAuth flow timed out'));
    }, 5 * 60 * 1000);
    
    this.pendingFlows.set(flow.state, { ...flow, timeout });
  }
  
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url || '/', `http://localhost:${OAUTH_PORT}`);
    
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const error = url.searchParams.get('error');
    
    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body>
            <h1>Authorization Failed</h1>
            <p>${error}</p>
            <p>You can close this window.</p>
            <script>window.close();</script>
          </body>
        </html>
      `);
      
      const pending = this.pendingFlows.get(state || '');
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingFlows.delete(state!);
        pending.reject(new Error(`OAuth error: ${error}`));
      }
      return;
    }
    
    if (!code || !state) {
      res.writeHead(400);
      res.end('Missing code or state');
      return;
    }
    
    const pending = this.pendingFlows.get(state);
    if (!pending) {
      res.writeHead(400);
      res.end('Unknown OAuth state');
      return;
    }
    
    // Success - send nice response
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`
      <html>
        <body style="font-family: system-ui; text-align: center; padding: 50px;">
          <h1>✅ Authorization Successful</h1>
          <p>You can close this window and return to Harbor.</p>
          <script>window.close();</script>
        </body>
      </html>
    `);
    
    // Resolve the pending flow
    clearTimeout(pending.timeout);
    this.pendingFlows.delete(state);
    pending.resolve(code);
  }
}
```

### 6.5 Credential Requirement Types

Extend the server configuration to specify auth requirements:

```typescript
export interface CredentialRequirement {
  // Unique key for this credential
  key: string;
  
  // Display label
  label: string;
  
  // Help text
  description?: string;
  
  // Type of credential
  type: 'api_key' | 'password' | 'oauth' | 'header';
  
  // Environment variable to set (for api_key/password)
  envVar?: string;
  
  // OAuth-specific config
  oauth?: {
    providerId: string;           // 'github', 'google', 'custom'
    authorizationUrl?: string;    // For custom OAuth
    tokenUrl?: string;
    clientId?: string;
    scopes: string[];
    // Which env vars to set from tokens
    accessTokenEnvVar?: string;
    refreshTokenEnvVar?: string;
  };
  
  // Is this required to start the server?
  required: boolean;
  
  // Validation
  pattern?: string;               // Regex for validation
  placeholder?: string;
  
  // Help link
  helpUrl?: string;
}
```

### 6.6 Built-in OAuth Providers

```typescript
// src/auth/providers/github-oauth.ts

export const GITHUB_OAUTH_CONFIG: OAuthConfig = {
  providerId: 'github',
  displayName: 'GitHub',
  authorizationUrl: 'https://github.com/login/oauth/authorize',
  tokenUrl: 'https://github.com/login/oauth/access_token',
  clientId: 'HARBOR_GITHUB_CLIENT_ID',  // Set via env or config
  scopes: ['repo', 'read:org'],
  pkceEnabled: false,  // GitHub doesn't support PKCE yet
};

// src/auth/providers/google-oauth.ts

export const GOOGLE_OAUTH_CONFIG: OAuthConfig = {
  providerId: 'google',
  displayName: 'Google',
  authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  clientId: 'HARBOR_GOOGLE_CLIENT_ID',
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  pkceEnabled: true,
};
```

### 6.7 UI: Credential Modal Enhancements

```typescript
// Extension sidebar - credential modal

interface CredentialModalProps {
  server: InstalledServer;
  requirements: CredentialRequirement[];
}

function renderCredentialModal({ server, requirements }: CredentialModalProps) {
  return `
    <div class="credential-modal">
      <h3>Configure ${server.name}</h3>
      
      ${requirements.map(req => {
        if (req.type === 'api_key') {
          return renderApiKeyField(req);
        } else if (req.type === 'oauth') {
          return renderOAuthField(req);
        } else if (req.type === 'password') {
          return renderPasswordField(req);
        }
      }).join('')}
      
      <div class="modal-footer">
        <button onclick="closeModal()">Cancel</button>
        <button onclick="saveAndStart()">Save & Start</button>
      </div>
    </div>
  `;
}

function renderApiKeyField(req: CredentialRequirement) {
  return `
    <div class="credential-field">
      <label>${req.label} ${req.required ? '*' : ''}</label>
      ${req.description ? `<p class="hint">${req.description}</p>` : ''}
      <div class="input-row">
        <input 
          type="password" 
          id="${req.key}"
          placeholder="${req.placeholder || 'Enter token...'}"
        />
        <button onclick="toggleVisibility('${req.key}')">👁</button>
      </div>
      ${req.helpUrl ? `<a href="${req.helpUrl}" target="_blank">Get token →</a>` : ''}
    </div>
  `;
}

function renderOAuthField(req: CredentialRequirement) {
  const isConnected = checkOAuthStatus(req.key);
  
  return `
    <div class="credential-field oauth-field">
      <label>${req.label}</label>
      ${req.description ? `<p class="hint">${req.description}</p>` : ''}
      
      ${isConnected ? `
        <div class="oauth-connected">
          <span class="status-badge connected">✓ Connected</span>
          <button onclick="disconnectOAuth('${req.key}')">Disconnect</button>
        </div>
      ` : `
        <button class="oauth-connect-btn" onclick="startOAuth('${req.oauth?.providerId}', '${req.key}')">
          Connect with ${req.oauth?.providerId}
        </button>
      `}
    </div>
  `;
}
```

### 6.8 Token Refresh & Expiry Handling

```typescript
// src/auth/token-manager.ts

export class TokenManager {
  private refreshTimers: Map<string, NodeJS.Timeout> = new Map();
  
  /**
   * Schedule automatic token refresh before expiry.
   */
  scheduleRefresh(serverId: string, credential: StoredCredential): void {
    if (!credential.expiresAt || !credential.refreshToken) return;
    
    // Refresh 5 minutes before expiry
    const refreshAt = credential.expiresAt - (5 * 60 * 1000);
    const delay = refreshAt - Date.now();
    
    if (delay <= 0) {
      // Already expired, refresh now
      this.refreshNow(serverId, credential);
      return;
    }
    
    // Clear existing timer
    const existing = this.refreshTimers.get(serverId);
    if (existing) clearTimeout(existing);
    
    // Schedule refresh
    const timer = setTimeout(() => {
      this.refreshNow(serverId, credential);
    }, delay);
    
    this.refreshTimers.set(serverId, timer);
    log(`[TokenManager] Scheduled refresh for ${serverId} in ${Math.round(delay/1000)}s`);
  }
  
  private async refreshNow(serverId: string, credential: StoredCredential): Promise<void> {
    try {
      const provider = getOAuthProvider(credential.type);
      const newTokens = await provider.refreshToken(credential.refreshToken!);
      
      // Update stored credential
      const secretStore = getSecretStore();
      secretStore.updateCredential(serverId, credential.key, {
        value: newTokens.accessToken,
        refreshToken: newTokens.refreshToken,
        expiresAt: newTokens.expiresAt,
      });
      
      log(`[TokenManager] Refreshed token for ${serverId}`);
      
      // Schedule next refresh
      this.scheduleRefresh(serverId, {
        ...credential,
        value: newTokens.accessToken,
        refreshToken: newTokens.refreshToken,
        expiresAt: newTokens.expiresAt,
      });
    } catch (e) {
      log(`[TokenManager] Failed to refresh token for ${serverId}: ${e}`);
      // Notify user that re-auth is needed
      pushStatus('auth', 'token_expired', {
        serverId,
        message: 'OAuth token expired. Please reconnect.',
      });
    }
  }
}
```

### 6.9 Security Considerations

1. **Credential Storage**:
   - Encrypt at rest using system keychain when available
   - Fall back to encrypted JSON file with machine-specific key
   - Never log credential values

2. **OAuth Security**:
   - Use PKCE when supported by provider
   - Validate state parameter to prevent CSRF
   - Short-lived callback server
   - Localhost-only callback URL

3. **Token Handling**:
   - Store refresh tokens securely
   - Implement automatic token refresh
   - Clear tokens on disconnect/uninstall

### 6.10 Message Types

```
// OAuth flow
oauth_start        { provider, server_id }    → { auth_url }
oauth_complete     { server_id }              → { success, tokens }
oauth_refresh      { server_id, key }         → { success }
oauth_revoke       { server_id, key }         → { success }

// Credential validation
validate_credential { server_id, key, value } → { valid, error? }
test_connection    { server_id }              → { success, error? }
```

---

## Phase 7: MCP Host Implementation (COMPLETED)

The MCP Host provides the execution environment for managing MCP servers with security, observability, and reliability.

### 7.1 Components Implemented

1. **Permission System** (`host/permissions.ts`)
   - Capability-based permissioning (origin + profile scoped)
   - Grant types: ALLOW_ONCE, ALLOW_ALWAYS, DENY
   - Scopes: tools.list, tools.call, server.connect
   - Tool allowlisting per origin

2. **Tool Registry** (`host/tool-registry.ts`)
   - Namespaced tool names: `serverId/toolName`
   - Registration/unregistration on server connect/disconnect
   - Permission-aware listing and resolution

3. **Rate Limiter** (`host/rate-limiter.ts`)
   - Per-run budgets (max 5 calls default)
   - Per-origin concurrent limits (max 2 default)
   - Tool call timeout (30s default)

4. **Observability** (`host/observability.ts`)
   - Tool call metrics (name, duration, success, error code)
   - Server health tracking
   - Rate limit events
   - No payload content logged

5. **Error Model**
   - Standardized error codes (ERR_PERMISSION_DENIED, etc.)
   - ApiError type with code, message, details

6. **Server Lifecycle**
   - Automatic crash detection
   - Restart with exponential backoff (max 3 attempts)
   - Status callbacks (onCrash, onRestart, onFail)

### 7.2 Host API

```typescript
// List tools (with permission enforcement)
host.listTools(origin) → { tools?: ToolDescriptor[]; error?: ApiError }

// Call tool (with permission + rate limit enforcement)
host.callTool(origin, toolName, args) → ToolResult | ToolError

// Get statistics
host.getStats() → { servers, tools, rateLimits }
```

### 7.3 Documentation

See `docs/MCP_HOST.md` for comprehensive documentation.

---

## Testing Plan

### Manual Testing Checklist

1. **Curated Servers**
   - [ ] Install filesystem server (npm)
   - [ ] Install time server (pypi)
   - [ ] Install GitHub server (binary)
   - [ ] Install memory server (npm)
   
2. **GitHub URL Install**
   - [ ] npm package from GitHub
   - [ ] Python package from GitHub
   - [ ] Go binary from GitHub releases
   
3. **JSON Import**
   - [ ] Claude Desktop config
   - [ ] Cursor config
   - [ ] Invalid JSON handling
   
4. **Docker Execution**
   - [ ] Docker available detection
   - [ ] Pull and run image
   - [ ] Volume mounts work
   - [ ] Env vars passed correctly

5. **VS Code Button Detection**
   - [ ] Detect buttons on MCP server pages
   - [ ] Harbor button appears
   - [ ] Click triggers install

6. **MCP Host - Server Lifecycle**
   - [ ] Starting Host spawns configured servers
   - [ ] Server crash triggers restart up to 3 retries
   - [ ] Server stop cleans up processes

7. **MCP Host - Tool Discovery**
   - [ ] Host can list tools from connected servers
   - [ ] Tool names are namespaced serverId/toolName

8. **MCP Host - Permission Gating**
   - [ ] Without permission, tools.list and tools.call fail
   - [ ] ALLOW_ONCE works and expires (TTL or tab close)
   - [ ] ALLOW_ALWAYS persists across restarts

9. **MCP Host - Tool Call Correctness**
   - [ ] Call known tool succeeds
   - [ ] Unknown tool returns ERR_TOOL_NOT_FOUND
   - [ ] Tool timeout returns ERR_TOOL_TIMEOUT
   - [ ] Server down returns ERR_SERVER_UNAVAILABLE

10. **MCP Host - Rate Limiting**
    - [ ] Concurrent limit enforced (max 2 per origin)
    - [ ] Budget limit enforced (max 5 per run)
    - [ ] Blocked calls return ERR_RATE_LIMITED

---

## Success Metrics

1. **Time to first server running**: < 60 seconds for npm servers
2. **Install success rate**: > 95% for curated servers
3. **GitHub URL success rate**: > 80% (detect package type correctly)
4. **Zero macOS security prompts** when using Docker mode

