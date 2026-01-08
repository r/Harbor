# Harbor Plugins - Quickstart Guide

This guide explains how to run the Harbor Hub with plugin extensions and test the plugin system locally.

## Prerequisites

- Firefox 112 or later
- Node.js 18+
- Harbor extension built and ready to load

## Overview

Harbor supports a plugin architecture where separate Firefox extensions can provide tools that are exposed to web applications via the `window.agent` API. The architecture is:

```
Web Page                Harbor Hub              Plugin Extension
(window.agent)    ←→    (aggregates tools,  ←→  (provides tools,
                         enforces consent)       executes them)
```

## Step 1: Build Harbor Extension

```bash
# From the repo root
cd harbor

# Build the extension
cd extension
npm install
npm run build
```

## Step 2: Build the Example Plugins

```bash
# Build the time plugin
cd plugins/harbor-plugin-time
npm install
npm run build

# Build the decode plugin
cd ../harbor-plugin-decode
npm install
npm run build
```

## Step 3: Load Extensions in Firefox

1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox" in the left sidebar
3. Click "Load Temporary Add-on..."
4. Navigate to `harbor/extension/dist/` and select `manifest.json`
5. Click "Load Temporary Add-on..." again
6. Navigate to `harbor/plugins/harbor-plugin-time/` and select `manifest.json`
7. Optionally load `harbor-plugin-decode` as well

You should now see both "Harbor" and "Harbor Plugin: Time" listed as temporary extensions.

## Step 4: Verify Plugin Registration

1. Open the Firefox Browser Console (Ctrl+Shift+J / Cmd+Shift+J)
2. Look for logs from `[TimePlugin]` showing registration:
   ```
   [TimePlugin] Registering with Harbor Hub...
   [TimePlugin] Registration message sent
   [TimePlugin] Registration successful
   ```

If registration fails:
- Ensure Harbor is loaded first
- Check that both extensions are enabled
- Look for error messages in the console

## Step 5: Test Tool Discovery

1. Open any web page (e.g., `https://example.com`)
2. Open the browser's Developer Console (F12)
3. First, request permission to list tools:

```javascript
// Request permission to list tools
const result = await window.agent.requestPermissions({
  scopes: ['mcp:tools.list', 'mcp:tools.call'],
  reason: 'Testing Harbor plugins'
});
console.log('Permission result:', result);
```

4. A Harbor consent popup will appear. Click "Allow Always" or "Allow Once".

5. Now list available tools:

```javascript
const tools = await window.agent.tools.list();
console.log('Available tools:', tools);

// Filter to see plugin tools
const pluginTools = tools.filter(t => t.name.includes('::'));
console.log('Plugin tools:', pluginTools);
```

You should see:
- `harbor-plugin-time@local::time.now`
- `harbor-plugin-time@local::time.format`

## Step 6: Test Tool Execution

Before calling plugin tools, you need to grant plugin-specific permission:

```javascript
// Call the time.now tool
const timeResult = await window.agent.tools.call(
  'harbor-plugin-time@local::time.now',
  { timezone: 'America/New_York' }
);
console.log('Time result:', timeResult);
// Expected: { formatted: "Wednesday, January 8, 2025 at 10:30:00 AM EST", date: "2025-01-08", ... }

// Call time.format
const formatResult = await window.agent.tools.call(
  'harbor-plugin-time@local::time.format',
  { epochMs: Date.now(), timeZone: 'UTC' }
);
console.log('Format result:', formatResult);
```

## Troubleshooting

### Plugin Not Registering

1. Check the Browser Console for errors from `[TimePlugin]`
2. Ensure Harbor extension is loaded and active
3. Try reloading both extensions

### Tools Not Appearing

1. Verify the plugin status in Harbor sidebar (if available)
2. Check if the plugin is in the allowlist (empty allowlist = all allowed)
3. Restart both extensions

### Permission Denied Errors

1. Call `window.agent.requestPermissions()` first
2. Check that you granted the correct scopes
3. For plugin tools, ensure plugin consent is granted

### Timeouts

1. Plugin tools have a 30-second timeout
2. Check the Browser Console for timeout errors
3. Verify the plugin is responding to pings

## Creating Your Own Plugin

See [`docs/plugins-dev.md`](./plugins-dev.md) for the full development guide and [`docs/plugin-protocol.md`](./plugin-protocol.md) for the protocol specification.

Quick template:

### manifest.json

```json
{
  "manifest_version": 3,
  "name": "My Harbor Plugin",
  "version": "1.0.0",
  "description": "My custom Harbor plugin",
  "permissions": [],
  "background": {
    "scripts": ["dist/background.js"],
    "type": "module"
  },
  "browser_specific_settings": {
    "gecko": {
      "id": "my-plugin@example.com",
      "strict_min_version": "112.0"
    }
  }
}
```

### background.ts

```typescript
const HARBOR_HUB_ID = 'raffi.krikorian.harbor@gmail.com';

// Tool definitions
const tools = [
  {
    name: 'myTool',
    title: 'My Tool',
    description: 'Does something useful',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string' }
      },
      required: ['input']
    }
  }
];

// Register with Harbor on startup
browser.runtime.sendMessage(HARBOR_HUB_ID, {
  namespace: 'harbor-plugin',
  protocolVersion: 'harbor-plugin/v1',
  type: 'PLUGIN_REGISTER',
  requestId: `reg-${Date.now()}`,
  timestamp: Date.now(),
  payload: {
    plugin: {
      extensionId: 'my-plugin@example.com',
      name: 'My Harbor Plugin',
      version: '1.0.0',
      tools: tools
    }
  }
});

// Handle messages from Harbor
browser.runtime.onMessageExternal.addListener((message, sender) => {
  if (sender.id !== HARBOR_HUB_ID) return;

  if (message.type === 'PLUGIN_TOOL_CALL') {
    // Execute the tool and send result back
    const result = executeMyTool(message.payload.toolName, message.payload.arguments);

    browser.runtime.sendMessage(HARBOR_HUB_ID, {
      namespace: 'harbor-plugin',
      protocolVersion: 'harbor-plugin/v1',
      type: 'PLUGIN_TOOL_RESULT',
      requestId: message.requestId,
      timestamp: Date.now(),
      payload: { result }
    });
  }

  if (message.type === 'PLUGIN_PING') {
    browser.runtime.sendMessage(HARBOR_HUB_ID, {
      namespace: 'harbor-plugin',
      protocolVersion: 'harbor-plugin/v1',
      type: 'PLUGIN_PONG',
      requestId: message.requestId,
      timestamp: Date.now(),
      payload: { healthy: true }
    });
  }
});

function executeMyTool(toolName: string, args: Record<string, unknown>) {
  // Your tool implementation here
  return { success: true, data: args.input };
}
```

## Next Steps

- Read the [Plugin Development Guide](./plugins-dev.md) for full details
- Read the [Plugin Protocol Specification](./plugin-protocol.md) for the wire protocol
- Check out the example plugins in `plugins/harbor-plugin-time/` and `plugins/harbor-plugin-decode/`
- Build your own plugin!
