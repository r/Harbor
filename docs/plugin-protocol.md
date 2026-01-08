# Harbor Plugin Protocol Specification

**Protocol Version:** `harbor-plugin/v1`

This document defines the message protocol for Harbor plugin extensions. Plugins are Firefox extensions that provide tools to Harbor, which aggregates them and exposes them to web applications via the `window.agent` API.

## Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Web Page      │     │   Harbor Hub    │     │ Plugin Extension│
│ (window.agent)  │◄───►│   Extension     │◄───►│ (MCP-like tools)│
└─────────────────┘     └─────────────────┘     └─────────────────┘
                         runtime.onConnect      runtime.sendMessage
                         (content script)       (extension-to-ext)
```

**Key principles:**
- Plugins register with the Hub via `browser.runtime.sendMessage(<HUB_ID>, ...)`
- Plugins do NOT inject into web pages; only Harbor does
- Consent is controlled by the Hub on a per-origin basis
- Tool names are namespaced as `<pluginId>::<toolName>`

> **See it in action:** The [Time Plugin](../plugins/harbor-plugin-time/src/background/index.ts) is a complete working example showing registration, tool calls, and health checks.

## Message Envelope

All protocol messages use a standard envelope format:

```typescript
interface PluginMessageEnvelope {
  /** Namespace identifier: "harbor-plugin" */
  namespace: "harbor-plugin";

  /** Protocol version: "harbor-plugin/v1" */
  protocolVersion: "harbor-plugin/v1";

  /** Message type (see Message Types below) */
  type: PluginMessageType;

  /** Unique request ID for correlation */
  requestId: string;

  /** Unix timestamp (milliseconds) when message was created */
  timestamp: number;

  /** Message payload (type depends on message type) */
  payload: object;
}
```

### Request ID Format

Request IDs should be unique and include:
- A prefix for identification
- A timestamp component
- A random component

Example: `plugin-1704067200000-abc123def`

## Message Types

### Registration Messages

#### PLUGIN_REGISTER

Sent by a plugin to register with the Harbor Hub.

**Direction:** Plugin → Hub

**Payload:**
```typescript
{
  plugin: {
    /** Firefox extension ID (must match browser_specific_settings.gecko.id) */
    extensionId: string;

    /** Human-readable plugin name */
    name: string;

    /** Plugin version (semver) */
    version: string;

    /** Plugin description */
    description?: string;

    /** Plugin author */
    author?: string;

    /** Homepage or documentation URL */
    homepage?: string;

    /** Icon URL or data URI */
    icon?: string;

    /** Tools provided by this plugin */
    tools: PluginToolDefinition[];
  }
}
```

#### PLUGIN_REGISTER_ACK

Sent by the Hub in response to PLUGIN_REGISTER.

**Direction:** Hub → Plugin

**Payload:**
```typescript
{
  /** Whether registration succeeded */
  success: boolean;

  /** Error message if registration failed */
  error?: string;

  /** Assigned namespace prefix (equals extensionId) */
  toolNamespace?: string;
}
```

#### PLUGIN_UNREGISTER

Sent by a plugin when it wants to unregister.

**Direction:** Plugin → Hub

**Payload:**
```typescript
{
  /** Reason for unregistering (optional) */
  reason?: string;
}
```

#### PLUGIN_UNREGISTER_ACK

Sent by the Hub in response to PLUGIN_UNREGISTER.

**Direction:** Hub → Plugin

**Payload:**
```typescript
{
  success: boolean;
}
```

### Tool Operation Messages

#### PLUGIN_TOOLS_LIST

Sent by the Hub to request an updated tool list from a plugin.

**Direction:** Hub → Plugin

**Payload:** `{}` (empty)

#### PLUGIN_TOOLS_LIST_RESULT

Sent by a plugin in response to PLUGIN_TOOLS_LIST.

**Direction:** Plugin → Hub

**Payload:**
```typescript
{
  tools: PluginToolDefinition[];
}
```

#### PLUGIN_TOOL_CALL

Sent by the Hub to invoke a tool on a plugin.

**Direction:** Hub → Plugin

**Payload:**
```typescript
{
  /** Tool name (without namespace prefix) */
  toolName: string;

  /** Arguments for the tool */
  arguments: Record<string, unknown>;

  /** Origin of the calling web page (for plugin's information) */
  callingOrigin?: string;
}
```

#### PLUGIN_TOOL_RESULT

Sent by a plugin when a tool call succeeds.

**Direction:** Plugin → Hub

**Payload:**
```typescript
{
  /** Result data from the tool */
  result: unknown;

  /** Execution time in milliseconds (optional) */
  executionTimeMs?: number;
}
```

#### PLUGIN_TOOL_ERROR

Sent by a plugin when a tool call fails.

**Direction:** Plugin → Hub

**Payload:**
```typescript
{
  /** Error code */
  code: PluginErrorCode;

  /** Human-readable error message */
  message: string;

  /** Additional error details */
  details?: unknown;
}
```

### Health/Keepalive Messages

#### PLUGIN_PING

Sent by the Hub to check if a plugin is healthy.

**Direction:** Hub → Plugin

**Payload:** `{}` (empty)

#### PLUGIN_PONG

Sent by a plugin in response to PLUGIN_PING.

**Direction:** Plugin → Hub

**Payload:**
```typescript
{
  /** Plugin uptime in seconds (optional) */
  uptime?: number;

  /** Whether plugin is healthy */
  healthy: boolean;
}
```

### Hub Notification Messages

#### PLUGIN_DISABLED

Sent by the Hub when it disables a plugin.

**Direction:** Hub → Plugin

**Payload:**
```typescript
{
  /** Reason for disabling */
  reason?: string;
}
```

#### PLUGIN_ENABLED

Sent by the Hub when it re-enables a plugin.

**Direction:** Hub → Plugin

**Payload:** `{}` (empty)

## Tool Definition Format

Tools are defined using the following schema:

```typescript
interface PluginToolDefinition {
  /** Tool name (unique within the plugin, e.g., 'echo') */
  name: string;

  /** Human-readable title */
  title: string;

  /** Description of what the tool does */
  description: string;

  /** JSON Schema for input parameters */
  inputSchema: JsonSchema;

  /** JSON Schema for output (optional) */
  outputSchema?: JsonSchema;

  /** UI hints for rendering (optional) */
  uiHints?: {
    /** Icon identifier or URL */
    icon?: string;

    /** Category for grouping */
    category?: string;

    /** Whether this tool may have side effects */
    dangerous?: boolean;

    /** Estimated execution time */
    speed?: "instant" | "fast" | "slow";
  };
}
```

### Input Schema Example

```json
{
  "type": "object",
  "properties": {
    "message": {
      "type": "string",
      "description": "The message to echo back"
    },
    "uppercase": {
      "type": "boolean",
      "description": "Whether to uppercase the message",
      "default": false
    }
  },
  "required": ["message"]
}
```

## Error Codes

| Code | Description |
|------|-------------|
| `TOOL_NOT_FOUND` | The requested tool does not exist |
| `INVALID_ARGUMENTS` | Arguments do not match the input schema |
| `EXECUTION_FAILED` | Tool execution failed |
| `TIMEOUT` | Operation timed out |
| `INTERNAL_ERROR` | Internal plugin error |
| `NOT_REGISTERED` | Plugin is not registered |
| `ALREADY_REGISTERED` | Plugin is already registered |
| `PLUGIN_NOT_ALLOWED` | Plugin is not in the allowlist |
| `PROTOCOL_VERSION_MISMATCH` | Protocol version is not compatible |

## Security Model

### Plugin Allowlist

The Hub maintains an allowlist of trusted plugin extension IDs. By default, the allowlist is empty, which means **all plugins are allowed**. To restrict which plugins can register:

1. Configure the allowlist in Harbor settings
2. Add specific extension IDs to the allowlist
3. Only plugins in the allowlist can successfully register

### Consent Model

Consent is controlled entirely by the Hub, not by plugins:

1. **Per-origin consent:** Each web origin must be granted permission to use plugin tools
2. **Consent options:**
   - Allow once (10-minute TTL, in-memory)
   - Allow always (persistent, stored in browser storage)
   - Deny
3. **Tool-level consent:** Origins can be granted access to specific tools or all tools
4. **Plugin tools are namespaced:** Web pages see tools as `pluginId::toolName`

### Trust Boundaries

```
┌─────────────────────────────────────────────────────────────────┐
│                        Trusted Zone                             │
│  ┌─────────────────┐     ┌─────────────────────────────────┐   │
│  │  Harbor Hub     │     │  Plugin Extension               │   │
│  │  (manages       │◄───►│  (installed by user,            │   │
│  │   consent)      │     │   trusted code execution)       │   │
│  └────────┬────────┘     └─────────────────────────────────┘   │
│           │                                                     │
└───────────┼─────────────────────────────────────────────────────┘
            │ consent gate
            ▼
┌─────────────────────────────────────────────────────────────────┐
│                       Untrusted Zone                            │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  Web Page (any origin)                                   │   │
│  │  Uses window.agent.tools.list() / tools.call()           │   │
│  └─────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Versioning Rules

### Protocol Version String

Format: `harbor-plugin/v<major>`

Example: `harbor-plugin/v1`

### Compatibility Rules

1. **Minor changes** (backward compatible):
   - Adding optional fields to payloads
   - Adding new message types
   - Adding new error codes

2. **Major changes** (breaking):
   - Removing or renaming fields
   - Changing field types
   - Changing message type names
   - Changing the envelope structure

3. **Version negotiation:**
   - Plugins should check the Hub's protocol version on registration
   - The Hub rejects plugins with incompatible protocol versions
   - For v1, only exact match is accepted

## Timeouts

| Operation | Default Timeout |
|-----------|-----------------|
| Registration | 5,000 ms |
| Tool call | 30,000 ms |
| Ping | 2,000 ms |
| Heartbeat interval | 60,000 ms |

## Message Flow Examples

### Plugin Registration

```
Plugin                          Hub
  │                              │
  │  PLUGIN_REGISTER             │
  │─────────────────────────────>│
  │                              │ Validate extension ID
  │                              │ Check allowlist
  │                              │ Store in registry
  │  PLUGIN_REGISTER_ACK         │
  │<─────────────────────────────│
  │                              │
```

### Tool Call

```
Web Page                 Hub                    Plugin
  │                       │                       │
  │ tools.call(           │                       │
  │  "plugin::echo",      │                       │
  │  {message: "hi"})     │                       │
  │──────────────────────>│                       │
  │                       │ Check consent         │
  │                       │ Parse namespace       │
  │                       │                       │
  │                       │ PLUGIN_TOOL_CALL      │
  │                       │──────────────────────>│
  │                       │                       │ Execute tool
  │                       │ PLUGIN_TOOL_RESULT    │
  │                       │<──────────────────────│
  │                       │                       │
  │ {success: true,       │                       │
  │  result: "hi"}        │                       │
  │<──────────────────────│                       │
```

### Heartbeat

```
Hub                             Plugin
  │                              │
  │  PLUGIN_PING                 │
  │─────────────────────────────>│
  │                              │ Check health
  │  PLUGIN_PONG                 │
  │<─────────────────────────────│
  │                              │
  │ Update lastSeen timestamp    │
  │                              │
```

## Implementation Notes

### For Plugin Developers

> **Reference implementations:** See [harbor-plugin-time](../plugins/harbor-plugin-time/) and [harbor-plugin-decode](../plugins/harbor-plugin-decode/) for complete working examples.

1. **Extension ID:** Your plugin must have a stable extension ID set in `manifest.json`:
   ```json
   {
     "browser_specific_settings": {
       "gecko": {
         "id": "your-plugin@example.com"
       }
     }
   }
   ```

2. **Registration:** Register on startup by sending PLUGIN_REGISTER to the Harbor Hub ID

3. **Message Handling:** Listen for external messages from the Hub:
   ```typescript
   browser.runtime.onMessageExternal.addListener((message, sender) => {
     if (sender.id === HARBOR_HUB_ID) {
       // Handle message
     }
   });
   ```

4. **Respond promptly:** Always respond to PLUGIN_PING with PLUGIN_PONG

### For Harbor Hub

1. **Listen for external messages:**
   ```typescript
   browser.runtime.onMessageExternal.addListener(handleExternalMessage);
   ```

2. **Maintain correlation:** Use requestId to correlate requests with responses

3. **Handle timeouts:** Set timeouts for all outgoing requests

4. **Heartbeat:** Periodically ping plugins to check health

## Harbor Hub Extension ID

The Harbor Hub extension ID is:
```
raffi.krikorian.harbor@gmail.com
```

Plugins should send their registration messages to this ID.
