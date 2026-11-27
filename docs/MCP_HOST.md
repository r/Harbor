# MCP Host Implementation

This document describes the MCP (Model Context Protocol) Execution Environment implementation in Harbor.

> **See Also:**
> - [Developer Guide](./DEVELOPER_GUIDE.md) - Comprehensive API reference
> - [JS AI Provider API](./JS_AI_PROVIDER_API.md) - Web page APIs (`window.ai`, `window.agent`)
> - [LLMS.txt](./LLMS.txt) - AI agent-optimized reference

## Overview

The MCP Host is responsible for:
- Managing MCP server connections
- Discovering and registering tools
- Invoking tools with permission and rate limit enforcement
- Providing provenance tracking
- Streaming events to callers

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Firefox Extension                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   Sidebar    │  │  Background  │  │  Content Scripts │   │
│  │     UI       │  │   Script     │  │  (vscode-detector)│  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘   │
│         │                 │                    │             │
│         └────────────┬────┴────────────────────┘             │
│                      │                                        │
│              Native Messaging                                 │
│                      │                                        │
└──────────────────────┼────────────────────────────────────────┘
                       │
┌──────────────────────┼────────────────────────────────────────┐
│                 Rust Bridge (Native Process)                  │
│                      │                                        │
│  ┌───────────────────┴───────────────────┐                   │
│  │              MCP Host                  │                   │
│  │  ┌─────────────┐  ┌─────────────────┐ │                   │
│  │  │ Permissions │  │  Tool Registry  │ │                   │
│  │  └─────────────┘  └─────────────────┘ │                   │
│  │  ┌─────────────┐  ┌─────────────────┐ │                   │
│  │  │Rate Limiter │  │ Observability   │ │                   │
│  │  └─────────────┘  └─────────────────┘ │                   │
│  └───────────────────┬───────────────────┘                   │
│                      │                                        │
│  ┌───────────────────┴───────────────────┐                   │
│  │         MCP Client Manager             │                   │
│  │  ┌────────────┐  ┌────────────────┐   │                   │
│  │  │ Stdio/     │  │ HTTP/SSE       │   │                   │
│  │  │ Subprocess │  │ Client         │   │                   │
│  │  │ Client     │  │                │   │                   │
│  │  └─────┬──────┘  └───────┬────────┘   │                   │
│  └────────┼─────────────────┼────────────┘                   │
│           │ stdio (isolated)│                                 │
└───────────┼─────────────────┼─────────────────────────────────┘
            │                 │
┌───────────┴───────────┐     │
│    MCP Server         │     │
│  (spawned process)    │     │
│  ┌─────────────────┐  │     │
│  │ MCP Server CLI  │  │     │
│  │   (npx/uvx)     │  │     │
│  └────────┬────────┘  │   ┌─┴───────────┐
│           │ stdio     │   │ Remote MCP  │
└───────────────────────┘   │ (HTTP/SSE)  │
                            └─────────────┘
```

## Components

### 1. Permission System (`host/permissions.ts`)

Implements capability-based permissioning keyed by origin and profile.

#### Permission Scopes

| Scope | Description |
|-------|-------------|
| `mcp:tools.list` | List available tools |
| `mcp:tools.call` | Call/invoke tools |
| `mcp:server.connect` | Connect to servers |
| `browser:activeTab.read` | Read active tab context |

#### Grant Types

| Type | Description |
|------|-------------|
| `ALLOW_ONCE` | Expires after TTL or tab close |
| `ALLOW_ALWAYS` | Persisted across sessions |
| `DENY` | Explicitly denied |

#### API

```typescript
// Grant permission to an origin
await grantPermission(
  origin: string,
  profileId: string,
  scope: PermissionScope,
  grantType: GrantType,
  options?: {
    expiresAt?: number;
    tabId?: number;
    allowedTools?: string[];
  }
);

// Check if permission is granted
const result = checkPermission(origin, profileId, scope);
// Returns: { granted: boolean; grant?: PermissionGrant; error?: ApiError }

// Check if a specific tool is allowed
const result = isToolAllowed(origin, profileId, toolName);
// Returns: { allowed: boolean; error?: ApiError }

// Expire all tab-scoped grants when tab closes
expireTabGrants(tabId: number);
```

### 2. Tool Registry (`host/tool-registry.ts`)

Maintains a registry of tools from all connected MCP servers with namespacing.

#### Namespacing Format

Tools are namespaced as: `{serverId}/{toolName}`

Example: `filesystem/read_file`, `github/search_issues`

#### API

```typescript
// Register tools from a server
const tools = registerServerTools(
  serverId: string,
  serverLabel: string,
  tools: Array<{ name: string; description?: string; inputSchema?: object }>
);

// Unregister tools when server disconnects
unregisterServerTools(serverId: string);

// List tools with permission enforcement
const result = listTools(origin, profileId, options);
// Returns: { tools?: ToolDescriptor[]; error?: ApiError }

// Resolve a tool for invocation
const result = resolveTool(origin, profileId, toolName);
// Returns: { tool?: ToolDescriptor; error?: ApiError }
```

### 3. Rate Limiter (`host/rate-limiter.ts`)

Enforces rate limits and budgets for tool calls.

#### Default Limits

| Limit | Default | Description |
|-------|---------|-------------|
| `maxCallsPerRun` | 5 | Max tool calls per run/session |
| `maxConcurrentPerOrigin` | 2 | Max concurrent calls per origin |
| `defaultTimeoutMs` | 30000 | Default timeout per tool call |

#### API

```typescript
// Create a new run with budget
const budget = createRun(origin, maxCalls?);

// Acquire a call slot (blocks if limits exceeded)
const { acquired, release, error } = acquireCallSlot(origin, runId?);
if (acquired) {
  try {
    // ... make tool call ...
  } finally {
    release(); // Release the slot
  }
}

// End a run
const finalBudget = endRun(runId);
```

### 4. Observability (`host/observability.ts`)

Provides logging and metrics without exposing payload content.

#### Metrics Recorded

- **Tool Calls**: name, serverId, origin, duration, success/failure, error code
- **Server Health**: serverId, state, restart count
- **Rate Limits**: origin, scope, limit type, blocked status
- **Permissions**: origin, scope, action, result

#### API

```typescript
// Record a tool call metric
recordToolCall({
  toolName: string;
  serverId: string;
  origin: string;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  timestamp: number;
});

// Get aggregated statistics
const stats = getToolCallStats();
// Returns: {
//   totalCalls, successfulCalls, failedCalls, avgDurationMs,
//   callsByTool, callsByOrigin
// }

// Enable debug mode (logs more detail)
setDebugMode(true);
```

### 5. MCP Host (`host/host.ts`)

Main entry point that coordinates all components.

#### API

```typescript
const host = getMcpHost();

// Sync tools from all connected servers
await host.syncTools();

// List tools (with permission enforcement)
const { tools, error } = host.listTools(origin, options);

// Call a tool (with permission and rate limit enforcement)
const result = await host.callTool(origin, toolName, args, options);
// Returns: ToolResult | ToolError

// Get statistics
const stats = host.getStats();
```

## Error Codes

See [WEB_AGENTS_API.md#error-handling](WEB_AGENTS_API.md#error-handling) for the full list.

| Code | Description |
|------|-------------|
| `ERR_PERMISSION_DENIED` | Caller lacks required permission, or a required scope was missing and they declined |
| `ERR_TOOL_NOT_FOUND` | Requested tool does not exist |
| `ERR_TOOL_NOT_ALLOWED` | Tool is not in the allowlist |
| `ERR_TOOL_FAILED` | Tool invocation failed — including a down server, a protocol error, or a timeout |
| `ERR_INTERNAL` | Internal host error |
| `ERR_BUDGET_EXCEEDED` | Budget exceeded for run |

## Server Lifecycle

The MCP Client Manager handles server lifecycle with automatic crash recovery:

1. **Starting**: Server process spawning
2. **Running**: Server is connected and operational
3. **Crashed**: Server exited unexpectedly
4. **Restarting**: Attempting automatic restart

### Automatic Restart

- Max restart attempts: 3
- Exponential backoff: 2s × attempt number
- Callbacks provided for crash, restart, and failure events

```typescript
mcpManager.setOnServerCrash((serverId, attempt, maxAttempts) => {
  console.log(`Server ${serverId} crashed, restart attempt ${attempt}/${maxAttempts}`);
});

mcpManager.setOnServerRestarted((serverId) => {
  console.log(`Server ${serverId} restarted successfully`);
});

mcpManager.setOnServerFailed((serverId, error) => {
  console.log(`Server ${serverId} failed permanently: ${error}`);
});
```

## Process Isolation

MCP servers run third-party code from npm, PyPI, or GitHub. Harbor provides optional process isolation to protect the main bridge from buggy or malicious servers.

### Why Isolate?

Without isolation, a problematic server could:
- Crash the entire bridge process
- Cause memory leaks that affect all servers
- Potentially access data from other server connections

### How It Works

When process isolation is enabled:

1. **Spawned Processes**: Each MCP server runs as a spawned child process
2. **Stdio Communication**: Main bridge communicates with servers via stdio (stdin/stdout)
3. **Crash Isolation**: If a server crashes, only that server is affected; the bridge survives

### Enabling Isolation

```bash
# Enable via environment variable
export HARBOR_MCP_ISOLATION=1
```

### Server Management

Each MCP server process is managed via stdio:

| Component | Description |
|-----------|-------------|
| Server process | Spawned via `npx`, `uvx`, or direct binary |
| Communication | JSON-RPC over stdio (stdin/stdout) |
| Lifecycle | Managed by the Rust bridge |

### Isolation Modes

| Mode | Description | Use Case |
|------|-------------|----------|
| **Direct** (default) | Server runs as child process of bridge | Development, trusted servers |
| **Docker** | Server runs in Docker container | Maximum isolation |

### Performance Considerations

Process isolation adds some overhead:
- **Startup**: ~50-100ms for process spawn
- **Communication**: stdio adds ~1-5ms per message

For most use cases, this overhead is negligible compared to tool execution time.

## Message Protocol

The Host exposes handlers via the native messaging bridge:

### Permission Handlers

| Message Type | Description |
|--------------|-------------|
| `host_grant_permission` | Grant a permission |
| `host_revoke_permission` | Revoke a permission |
| `host_check_permission` | Check if permission granted |
| `host_get_permissions` | Get all permissions for origin |
| `host_expire_tab_grants` | Expire tab-scoped grants |

### Tool Handlers

| Message Type | Description |
|--------------|-------------|
| `host_list_tools` | List available tools |
| `host_call_tool` | Call a tool |
| `host_get_stats` | Get host statistics |

## Security Considerations

1. **Origin Isolation**: Permissions are scoped to origin + profile
2. **No Payload Logging**: Tool args/results are never logged
3. **Rate Limiting**: Prevents abuse by limiting concurrent and total calls
4. **Tool Allowlisting**: Origins can be restricted to specific tools
5. **Tab-Scoped Grants**: ALLOW_ONCE grants can be tied to a tab

## Usage Example

```typescript
import { getMcpHost, grantPermission, GrantType, PermissionScope } from './host/index.js';

const host = getMcpHost();
const origin = 'https://example.com';

// Grant permission to list and call tools
await grantPermission(origin, 'default', PermissionScope.TOOLS_LIST, GrantType.ALLOW_ALWAYS);
await grantPermission(origin, 'default', PermissionScope.TOOLS_CALL, GrantType.ALLOW_ALWAYS, {
  allowedTools: ['filesystem/read_file', 'github/search_issues']
});

// List available tools
const { tools, error } = host.listTools(origin);
if (tools) {
  console.log('Available tools:', tools.map(t => t.name));
}

// Call a tool
const result = await host.callTool(origin, 'filesystem/read_file', {
  path: '/tmp/test.txt'
});

if (result.ok) {
  console.log('Result:', result.result);
  console.log('Provenance:', result.provenance);
} else {
  console.error('Error:', result.error.code, result.error.message);
}
```

## Testing

The implementation supports the following acceptance tests:

### Server Lifecycle
- ✅ Starting Host spawns configured servers
- ✅ Server crash triggers restart up to N retries
- ✅ Server stop cleans up processes

### Tool Discovery
- ✅ Host can list tools from a test server
- ✅ Tool names are namespaced serverId/toolName

### Permission Gating
- ✅ Without permission, tools.list and tools.call fail
- ✅ ALLOW_ONCE works and expires
- ✅ ALLOW_ALWAYS persists across restarts

### Tool Call Correctness
- ✅ Call known tool succeeds
- ✅ Unknown tool returns ERR_TOOL_NOT_FOUND
- ✅ Tool timeout returns ERR_TOOL_FAILED
- ✅ Server down returns ERR_TOOL_FAILED

