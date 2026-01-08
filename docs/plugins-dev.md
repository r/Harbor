# Harbor Plugin Development Guide

This guide walks through building Harbor plugins with TypeScript, including project setup, tool implementation, testing, and best practices.

## Prerequisites

- Node.js 18+
- Firefox 112+
- Basic TypeScript knowledge

## Project Structure

A typical Harbor plugin has the following structure:

```
plugins/harbor-plugin-myplugin/
├── manifest.json           # Firefox extension manifest
├── package.json            # Node.js package config
├── tsconfig.json           # TypeScript config
├── vitest.config.ts        # Test runner config
├── dist/                   # Built output (generated)
│   └── background.js
└── src/
    ├── errors.ts           # Custom error types
    ├── background/
    │   └── index.ts        # Extension entry point
    └── tools/
        ├── mytool.ts       # Tool definitions and implementations
        └── mytool.test.ts  # Unit tests
```

## Step 1: Initialize Project

Create your plugin directory and initialize:

```bash
mkdir -p plugins/harbor-plugin-myplugin
cd plugins/harbor-plugin-myplugin
npm init -y
```

Install dependencies:

```bash
npm install -D esbuild typescript vitest
```

## Step 2: Configuration Files

### package.json

```json
{
  "name": "harbor-plugin-myplugin",
  "version": "1.0.0",
  "description": "My custom Harbor plugin",
  "type": "module",
  "scripts": {
    "build": "esbuild src/background/index.ts --bundle --outfile=dist/background.js --format=esm --target=firefox112",
    "watch": "esbuild src/background/index.ts --bundle --outfile=dist/background.js --format=esm --target=firefox112 --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "esbuild": "^0.20.0",
    "typescript": "^5.0.0",
    "vitest": "^2.0.0"
  }
}
```

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### vitest.config.ts

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

### manifest.json

```json
{
  "manifest_version": 3,
  "name": "Harbor Plugin: My Plugin",
  "version": "1.0.0",
  "description": "Description of what your plugin does",
  "permissions": [],
  "background": {
    "scripts": ["dist/background.js"],
    "type": "module"
  },
  "browser_specific_settings": {
    "gecko": {
      "id": "harbor-plugin-myplugin@local",
      "strict_min_version": "112.0"
    }
  }
}
```

## Step 3: Error Handling

Create `src/errors.ts` with standard error types:

```typescript
export type ToolErrorCode =
  | 'TOOL_NOT_FOUND'
  | 'INVALID_ARGUMENTS'
  | 'EXECUTION_FAILED'
  | 'INPUT_TOO_LARGE';

export class ToolError extends Error {
  constructor(
    public readonly code: ToolErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function invalidArgument(message: string, details?: unknown): ToolError {
  return new ToolError('INVALID_ARGUMENTS', message, details);
}

export function toolNotFound(toolName: string): ToolError {
  return new ToolError('TOOL_NOT_FOUND', `Unknown tool: ${toolName}`);
}

export function executionFailed(message: string, details?: unknown): ToolError {
  return new ToolError('EXECUTION_FAILED', message, details);
}

export function inputTooLarge(size: number, maxSize: number): ToolError {
  return new ToolError(
    'INPUT_TOO_LARGE',
    `Input size (${size} bytes) exceeds maximum (${maxSize} bytes)`
  );
}
```

## Step 4: Define Tools

Create `src/tools/mytool.ts` with tool definitions and implementations:

```typescript
import { invalidArgument } from '../errors';

// =============================================================================
// Tool Definitions
// =============================================================================

export const MY_TOOL_DEFINITION = {
  name: 'myplugin.do_something',
  title: 'Do Something',
  description: 'Does something useful with the input.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      input: {
        type: 'string' as const,
        description: 'The input to process',
      },
      option: {
        type: 'boolean' as const,
        description: 'An optional flag',
        default: false,
      },
    },
    required: ['input'],
  },
  outputSchema: {
    type: 'object' as const,
    properties: {
      result: { type: 'string' as const, description: 'The processed result' },
    },
    required: ['result'],
  },
};

// =============================================================================
// Tool Implementations
// =============================================================================

export interface MyToolInput {
  input: string;
  option?: boolean;
}

export interface MyToolResult {
  result: string;
}

export function doSomething(input: MyToolInput): MyToolResult {
  // Validate input
  if (typeof input.input !== 'string') {
    throw invalidArgument('input must be a string');
  }

  // Implement your tool logic
  let result = input.input;
  if (input.option) {
    result = result.toUpperCase();
  }

  return { result };
}
```

### Tool Naming Convention

Tools should be namespaced with a prefix matching your plugin:

- `myplugin.action_name` - for a plugin called "myplugin"
- `time.now`, `time.format` - for a time plugin
- `decode.base64_encode`, `decode.json_pretty` - for a decode plugin

## Step 5: Write Tests

Create `src/tools/mytool.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { doSomething, MY_TOOL_DEFINITION } from './mytool';

describe('doSomething', () => {
  it('processes input correctly', () => {
    const result = doSomething({ input: 'hello' });
    expect(result.result).toBe('hello');
  });

  it('applies option when true', () => {
    const result = doSomething({ input: 'hello', option: true });
    expect(result.result).toBe('HELLO');
  });

  it('throws for non-string input', () => {
    expect(() => doSomething({ input: 123 as unknown as string })).toThrow(
      'input must be a string'
    );
  });
});

describe('MY_TOOL_DEFINITION', () => {
  it('has required fields', () => {
    expect(MY_TOOL_DEFINITION.name).toBe('myplugin.do_something');
    expect(MY_TOOL_DEFINITION.inputSchema.required).toContain('input');
  });
});
```

Run tests:

```bash
npm test
```

## Step 6: Background Script

Create `src/background/index.ts`:

```typescript
import {
  doSomething,
  MY_TOOL_DEFINITION,
  MyToolInput,
} from '../tools/mytool';
import { ToolError, toolNotFound } from '../errors';

// =============================================================================
// Constants
// =============================================================================

const HARBOR_HUB_EXTENSION_ID = 'raffi.krikorian.harbor@gmail.com';
const PLUGIN_ID = 'harbor-plugin-myplugin@local';
const PLUGIN_NAME = 'Harbor Plugin: My Plugin';
const PLUGIN_VERSION = '1.0.0';

const PLUGIN_NAMESPACE = 'harbor-plugin';
const PLUGIN_PROTOCOL_VERSION = 'harbor-plugin/v1';

const startupTime = Date.now();

// =============================================================================
// Types
// =============================================================================

interface PluginMessageEnvelope {
  namespace: string;
  protocolVersion: string;
  type: string;
  requestId: string;
  timestamp: number;
  payload: unknown;
}

interface ToolCallPayload {
  toolName: string;
  arguments: Record<string, unknown>;
  callingOrigin?: string;
}

// =============================================================================
// Tool Registry
// =============================================================================

const TOOLS = [MY_TOOL_DEFINITION];

function executeTool(toolName: string, args: Record<string, unknown>): unknown {
  switch (toolName) {
    case 'myplugin.do_something':
      return doSomething(args as MyToolInput);

    default:
      throw toolNotFound(toolName);
  }
}

// =============================================================================
// Message Helpers
// =============================================================================

function generateRequestId(): string {
  return `myplugin-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

function createMessage(
  type: string,
  payload: unknown,
  requestId?: string
): PluginMessageEnvelope {
  return {
    namespace: PLUGIN_NAMESPACE,
    protocolVersion: PLUGIN_PROTOCOL_VERSION,
    type,
    requestId: requestId ?? generateRequestId(),
    timestamp: Date.now(),
    payload,
  };
}

async function sendToHub(message: PluginMessageEnvelope): Promise<void> {
  try {
    await browser.runtime.sendMessage(HARBOR_HUB_EXTENSION_ID, message);
  } catch (err) {
    console.error('[MyPlugin] Failed to send message to Hub:', err);
  }
}

// =============================================================================
// Message Handlers
// =============================================================================

async function handleToolCall(
  requestId: string,
  payload: ToolCallPayload
): Promise<void> {
  console.log('[MyPlugin] Tool call:', payload.toolName);
  const startTime = Date.now();

  try {
    const result = executeTool(payload.toolName, payload.arguments);
    const executionTimeMs = Date.now() - startTime;

    await sendToHub(
      createMessage(
        'PLUGIN_TOOL_RESULT',
        { result, executionTimeMs },
        requestId
      )
    );
  } catch (err) {
    const toolError = err instanceof ToolError ? err : new ToolError(
      'EXECUTION_FAILED',
      err instanceof Error ? err.message : String(err)
    );

    await sendToHub(
      createMessage(
        'PLUGIN_TOOL_ERROR',
        {
          code: toolError.code,
          message: toolError.message,
          details: toolError.details,
        },
        requestId
      )
    );
  }
}

async function handlePing(requestId: string): Promise<void> {
  console.log('[MyPlugin] Ping received');

  await sendToHub(
    createMessage(
      'PLUGIN_PONG',
      {
        healthy: true,
        uptime: Math.floor((Date.now() - startupTime) / 1000),
      },
      requestId
    )
  );
}

// =============================================================================
// External Message Listener
// =============================================================================

browser.runtime.onMessageExternal.addListener(
  (message: unknown, sender: browser.Runtime.MessageSender) => {
    if (sender.id !== HARBOR_HUB_EXTENSION_ID) {
      console.warn('[MyPlugin] Ignoring message from unknown sender:', sender.id);
      return;
    }

    const envelope = message as PluginMessageEnvelope;

    if (envelope.namespace !== PLUGIN_NAMESPACE) {
      console.warn('[MyPlugin] Ignoring message with wrong namespace:', envelope.namespace);
      return;
    }

    console.log('[MyPlugin] Received message:', envelope.type);

    switch (envelope.type) {
      case 'PLUGIN_TOOL_CALL':
        handleToolCall(envelope.requestId, envelope.payload as ToolCallPayload);
        break;

      case 'PLUGIN_PING':
        handlePing(envelope.requestId);
        break;

      case 'PLUGIN_REGISTER_ACK': {
        const ack = envelope.payload as { success: boolean; error?: string };
        if (ack.success) {
          console.log('[MyPlugin] Registration successful');
        } else {
          console.error('[MyPlugin] Registration failed:', ack.error);
        }
        break;
      }

      default:
        console.warn('[MyPlugin] Unknown message type:', envelope.type);
    }
  }
);

// =============================================================================
// Registration
// =============================================================================

async function registerWithHub(): Promise<void> {
  console.log('[MyPlugin] Registering with Harbor Hub...');

  const registerMessage = createMessage('PLUGIN_REGISTER', {
    plugin: {
      pluginId: PLUGIN_ID,
      name: PLUGIN_NAME,
      version: PLUGIN_VERSION,
      description: 'Description of your plugin',
      tools: TOOLS,
    },
  });

  try {
    await browser.runtime.sendMessage(HARBOR_HUB_EXTENSION_ID, registerMessage);
    console.log('[MyPlugin] Registration message sent');
  } catch (err) {
    console.error('[MyPlugin] Failed to register with Hub:', err);
    console.log('[MyPlugin] Hub may not be installed. Will retry on Hub startup.');
  }
}

// Register on startup
registerWithHub();

console.log('[MyPlugin] Background script initialized');
```

## Step 7: Build and Test

```bash
# Build the plugin
npm run build

# Run unit tests
npm test
```

## Step 8: Load in Firefox

1. Open Firefox and go to `about:debugging`
2. Click "This Firefox" → "Load Temporary Add-on..."
3. Select your plugin's `manifest.json`
4. Open the Browser Console (Ctrl+Shift+J / Cmd+Shift+J) to see registration logs

## Real-World Examples

### Time Plugin

The `harbor-plugin-time` plugin provides:

- `time.now` - Returns current time in ISO format and epoch milliseconds
- `time.format` - Formats an epoch timestamp with locale/timezone support

```typescript
// time.now - no arguments, returns current time
const result = await window.agent.tools.call('harbor-plugin-time@local::time.now', {});
// { iso: "2025-01-07T22:30:00.000Z", epochMs: 1736288400000 }

// time.format - format a specific timestamp
const result = await window.agent.tools.call('harbor-plugin-time@local::time.format', {
  epochMs: 1736288400000,
  locale: 'en-US',
  timezone: 'America/New_York'
});
// { formatted: "1/7/2025, 5:40:00 PM", localeString: "1/7/2025, 5:40:00 PM" }
```

### Decode Plugin

The `harbor-plugin-decode` plugin provides:

- `decode.base64_encode` - Encodes text to base64
- `decode.base64_decode` - Decodes base64 to text
- `decode.json_pretty` - Pretty-prints JSON with configurable indentation
- `decode.jwt_decode_unsafe` - Decodes JWT header and payload (without signature verification)

```typescript
// Base64 encoding
await window.agent.tools.call('harbor-plugin-decode@local::decode.base64_encode', {
  text: 'Hello, World!'
});
// { base64: "SGVsbG8sIFdvcmxkIQ==" }

// JWT decoding (unsafe - no signature verification)
await window.agent.tools.call('harbor-plugin-decode@local::decode.jwt_decode_unsafe', {
  jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig'
});
// { header: { alg: "HS256", typ: "JWT" }, payload: { sub: "1234567890" } }
```

## Best Practices

### Input Validation

Always validate inputs before processing:

```typescript
export function myTool(input: MyInput): MyResult {
  // Type check
  if (typeof input.text !== 'string') {
    throw invalidArgument('text must be a string');
  }

  // Size check (prevent DoS)
  const MAX_SIZE = 1024 * 1024; // 1MB
  const size = new Blob([input.text]).size;
  if (size > MAX_SIZE) {
    throw inputTooLarge(size, MAX_SIZE);
  }

  // Range check
  if (input.indent !== undefined) {
    if (!Number.isFinite(input.indent)) {
      input.indent = 2; // Default
    }
    input.indent = Math.max(0, Math.min(8, input.indent));
  }

  // ... implementation
}
```

### Error Handling

Use the standard error codes:

| Code | When to Use |
|------|-------------|
| `INVALID_ARGUMENTS` | Input fails validation |
| `TOOL_NOT_FOUND` | Unknown tool name |
| `EXECUTION_FAILED` | Runtime error during execution |
| `INPUT_TOO_LARGE` | Input exceeds size limits |

### Testing

Write tests for:

1. **Happy path** - Normal inputs produce expected outputs
2. **Edge cases** - Empty strings, zero values, boundary conditions
3. **Error cases** - Invalid types, malformed inputs, size limits
4. **Round-trip** - Encode/decode pairs work correctly

```typescript
describe('base64', () => {
  it('round-trips correctly', () => {
    const original = 'Hello 👋 世界';
    const encoded = base64Encode({ text: original });
    const decoded = base64Decode({ base64: encoded.base64 });
    expect(decoded.text).toBe(original);
  });
});
```

### Security Considerations

1. **Never trust input** - Validate all arguments
2. **Limit resource usage** - Set size limits, timeouts
3. **No network access** - Plugins run in sandboxed extension context
4. **No file access** - Plugins cannot read/write files
5. **Clear naming** - Use `_unsafe` suffix for tools that bypass security (like JWT decode without verification)

## Debugging

### Browser Console

Open the Browser Console (Ctrl+Shift+J / Cmd+Shift+J) to see:
- Plugin registration logs
- Tool call logs
- Error messages

### Extension Debugging

1. Go to `about:debugging`
2. Click your plugin's "Inspect" button
3. Use the debugger to set breakpoints

### Common Issues

**Plugin not registering:**
- Harbor Hub must be installed first
- Check extension ID matches in manifest.json

**Tool calls failing:**
- Check Browser Console for error details
- Verify tool name matches definition
- Validate argument types match schema

**Build errors:**
- Run `npm install` to install dependencies
- Check tsconfig.json paths are correct

## Related Documentation

- [Plugin Protocol Specification](./plugin-protocol.md) - Full protocol details
- [Plugins Quickstart](./plugins-quickstart.md) - Getting started guide
- [Developer Guide](./DEVELOPER_GUIDE.md) - Harbor extension development
