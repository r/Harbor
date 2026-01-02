# Harbor Architecture

This document describes the architecture of Harbor, a Firefox extension for managing MCP (Model Context Protocol) servers.

## Overview

Harbor provides:
- **Curated directory** of recommended MCP servers
- **GitHub repository installer** - paste any MCP server repo URL
- **JSON config import** - import Claude Desktop / Cursor MCP configs
- **Docker isolation** (optional) - run servers in containers
- **JS AI Provider API** - expose `window.ai` and `window.agent` to web pages

## System Architecture

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
│  │  │  🐙 GitHub        [Install]  ← npm or Docker                    │  │  │
│  │  │  🧠 Memory        [Install]  ← npm: @modelcontextprotocol/...   │  │  │
│  │  │  🕐 Time          [Install]  ← Python: mcp-server-time          │  │  │
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
│  │  CONTENT SCRIPT: Provider Injection                                   │  │
│  │                                                                        │  │
│  │  Injects window.ai and window.agent APIs into web pages              │  │
│  │  Handles permission requests and message routing                      │  │
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
│  │  MCP HOST                                                              │  │
│  │                                                                        │  │
│  │  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐       │  │
│  │  │  Permissions    │  │  Tool Registry  │  │  Rate Limiter   │       │  │
│  │  │                 │  │                 │  │                 │       │  │
│  │  │  Per-origin     │  │  Namespaced     │  │  Concurrent +   │       │  │
│  │  │  capability     │  │  serverId/tool  │  │  budget limits  │       │  │
│  │  └─────────────────┘  └─────────────────┘  └─────────────────┘       │  │
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
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │  CHAT ORCHESTRATION                                                    │  │
│  │                                                                        │  │
│  │  Agent loop: LLM → Tool calls → Results → LLM → Response              │  │
│  │  Tool router: Intelligent tool selection based on task                │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
         │                              │
         │ stdio (JSON-RPC)             │ HTTP (OpenAI-compatible)
         ▼                              ▼
┌─────────────────┐            ┌─────────────────┐
│  MCP Server     │            │  LLM Provider   │
│  (local/Docker) │            │  (Ollama, etc.) │
└─────────────────┘            └─────────────────┘
```

## Core Components

### Extension

| Component | Purpose |
|-----------|---------|
| `background.ts` | Native messaging, server management, permission prompts |
| `sidebar.ts` | Main UI - server list, chat, settings |
| `provider/*.ts` | JS AI Provider injection and message routing |

### Bridge

| Component | Purpose |
|-----------|---------|
| `host/` | MCP execution environment with permissions, rate limiting |
| `mcp/` | MCP protocol client (stdio transport) |
| `installer/` | Server installation and lifecycle |
| `llm/` | LLM provider abstraction (Ollama, llamafile) |
| `chat/` | Chat orchestration and session management |
| `auth/` | OAuth and credential management |

## Permission System

Permissions are scoped per-origin with capability-based grants.

### Scopes

| Scope | Description |
|-------|-------------|
| `model:prompt` | Basic text generation |
| `model:tools` | AI with tool calling |
| `mcp:tools.list` | List available tools |
| `mcp:tools.call` | Execute tools |
| `browser:activeTab.read` | Read active tab content |

### Grant Types

| Type | Behavior |
|------|----------|
| `ALLOW_ONCE` | Expires after TTL or tab close |
| `ALLOW_ALWAYS` | Persisted across sessions |
| `DENY` | Explicitly denied |

## Tool Registry

Tools are namespaced as `{serverId}/{toolName}` for clarity and collision avoidance.

Example: `filesystem/read_file`, `github/search_issues`

## Rate Limiting

| Limit | Default | Purpose |
|-------|---------|---------|
| Max calls per run | 5 | Prevent runaway agent loops |
| Max concurrent per origin | 2 | Fair resource sharing |
| Default timeout | 30s | Prevent hanging calls |

## Server Lifecycle

1. **Installing**: Package being downloaded/built
2. **Stopped**: Installed but not running
3. **Starting**: Process spawning
4. **Running**: Connected and operational
5. **Crashed**: Exited unexpectedly (auto-restart up to 3 times)

## Data Storage

All data stored in `~/.harbor/`:

| File | Purpose |
|------|---------|
| `harbor.db` | Server configurations (SQLite) |
| `installed_servers.json` | Installed server configs |
| `secrets/credentials.json` | API keys (restricted permissions) |
| `sessions/*.json` | Chat session history |

## Credential Management

### Types

| Type | Example | Storage |
|------|---------|---------|
| API Key | `GITHUB_TOKEN`, `BRAVE_API_KEY` | Encrypted JSON |
| OAuth | Google, GitHub OAuth | Tokens with refresh |
| Password | Database credentials | Encrypted JSON |

### OAuth Flow

1. User clicks "Connect with GitHub"
2. Bridge starts local callback server (port 8765)
3. Browser opens OAuth authorization URL
4. User authorizes, redirected to `localhost:8765/oauth/callback`
5. Bridge exchanges code for tokens
6. Tokens stored and auto-refreshed

## Error Codes

| Code | Description |
|------|-------------|
| `ERR_PERMISSION_DENIED` | Caller lacks required permission |
| `ERR_SCOPE_REQUIRED` | Permission scope required but not granted |
| `ERR_SERVER_UNAVAILABLE` | MCP server is not available |
| `ERR_TOOL_NOT_FOUND` | Requested tool does not exist |
| `ERR_TOOL_NOT_ALLOWED` | Tool not in allowlist |
| `ERR_TOOL_TIMEOUT` | Tool invocation timed out |
| `ERR_TOOL_FAILED` | Tool invocation failed |
| `ERR_RATE_LIMITED` | Rate limit exceeded |
| `ERR_BUDGET_EXCEEDED` | Budget exceeded for run |

## Security Model

1. **Origin Isolation**: Permissions scoped to origin
2. **No Payload Logging**: Tool args/results never logged
3. **Rate Limiting**: Prevents abuse
4. **Tool Allowlisting**: Origins can be restricted to specific tools
5. **Tab-Scoped Grants**: ALLOW_ONCE grants can be tied to a tab
6. **PKCE for OAuth**: When supported by provider

