# JavaScript MCP Server Specification

**Version:** 1.0.0  
**Status:** Draft

## Overview

Harbor supports running JavaScript-based MCP servers in sandboxed Web Workers. This document specifies the interface that JS MCP servers must implement and the sandbox environment they run in.

## Why JS MCP Servers?

- **Lower barrier to entry** — No compilation step, familiar language
- **Faster iteration** — Bundle and deploy JS without build toolchain
- **Ecosystem access** — Leverage npm packages (when bundled)
- **Good enough security** — Web Worker isolation with capability enforcement

## Sandbox Environment

JS MCP servers run inside Web Workers with a security sandbox that:

1. **Removes dangerous globals** — `fetch`, `XMLHttpRequest`, `WebSocket`, `importScripts` are neutered
2. **Provides controlled fetch** — All network requests go through the host for capability enforcement
3. **Enforces capability restrictions** — Only allowed hosts can be accessed
4. **Isolates from extension APIs** — Workers have no access to `chrome.*` APIs

### Security Model

```
┌─────────────────────────────────────────────────────────┐
│  Host (Extension Background)                            │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Capability Enforcer                              │  │
│  │  - Validates fetch requests against allowlist     │  │
│  │  - Injects secrets as environment variables       │  │
│  │  - Routes MCP stdio via postMessage               │  │
│  └───────────────────────┬───────────────────────────┘  │
│                          │ postMessage                  │
│  ┌───────────────────────▼───────────────────────────┐  │
│  │  Web Worker (Sandboxed)                           │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  Sandbox Preamble                           │  │  │
│  │  │  - Replaces fetch with proxied version      │  │  │
│  │  │  - Provides MCP.readLine / MCP.writeLine    │  │  │
│  │  │  - Sets up process.env                      │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  Your MCP Server Code                       │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

---

## Available Globals

### `MCP` — MCP Protocol Interface

The primary interface for MCP communication.

#### `MCP.readLine(): Promise<string>`

Reads the next JSON-RPC request from stdin. Returns a promise that resolves with the raw JSON string.

```javascript
const line = await MCP.readLine();
const request = JSON.parse(line);
```

#### `MCP.writeLine(json: string): void`

Writes a JSON-RPC response to stdout.

```javascript
MCP.writeLine(JSON.stringify(response));
```

### `fetch(url, options)` — Proxied Fetch

A controlled version of `fetch` that routes all requests through the host for capability enforcement.

- Only hosts listed in `manifest.capabilities.network.hosts` are allowed
- Requests to other hosts will reject with a network access error
- Supports standard fetch options: `method`, `headers`, `body`, etc.

```javascript
// Only works if "api.example.com" is in allowed hosts
const response = await fetch('https://api.example.com/data');
const data = await response.json();
```

### `process.env` — Environment Variables

Contains secrets and configuration injected by the host.

```javascript
const apiKey = process.env.API_KEY;
```

### `console` — Logging

Standard console methods that forward to the host.

```javascript
console.log('Starting server...');
console.warn('Deprecation warning');
console.error('Something went wrong:', error);
```

### Standard Globals

These are available without modification:

- `JSON` — JSON parsing/serialization
- `crypto.randomUUID()` — Generate UUIDs
- `TextEncoder` / `TextDecoder` — Text encoding
- `setTimeout` / `setInterval` — Timers
- `Promise` — Async operations
- `Map` / `Set` — Collections
- `URL` — URL parsing

### Removed/Blocked Globals

These are not available:

- `fetch` (original) — Replaced with proxied version
- `XMLHttpRequest` — Removed
- `WebSocket` — Removed
- `importScripts` — Removed
- `chrome.*` — Never available in Workers

---

## Minimal Example

```javascript
async function main() {
  console.log('MCP server starting...');
  
  while (true) {
    const line = await MCP.readLine();
    let request;
    
    try {
      request = JSON.parse(line);
    } catch (e) {
      console.error('Failed to parse request:', e);
      continue;
    }
    
    let response;
    
    switch (request.method) {
      case 'tools/list':
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: [
              {
                name: 'greet',
                description: 'Say hello',
                inputSchema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'Name to greet' }
                  },
                  required: ['name']
                }
              }
            ]
          }
        };
        break;
        
      case 'tools/call':
        const toolName = request.params?.name;
        const args = request.params?.arguments || {};
        
        if (toolName === 'greet') {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [
                { type: 'text', text: `Hello, ${args.name || 'World'}!` }
              ]
            }
          };
        } else {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: `Unknown tool: ${toolName}` }
          };
        }
        break;
        
      default:
        response = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found' }
        };
    }
    
    MCP.writeLine(JSON.stringify(response));
  }
}

main().catch(err => console.error('Server error:', err));
```

---

## API Server Example (with Network Access)

```javascript
async function main() {
  const API_KEY = process.env.WEATHER_API_KEY;
  
  while (true) {
    const line = await MCP.readLine();
    const request = JSON.parse(line);
    
    let response;
    
    if (request.method === 'tools/list') {
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [{
            name: 'weather.get',
            description: 'Get weather for a city',
            inputSchema: {
              type: 'object',
              properties: {
                city: { type: 'string' }
              },
              required: ['city']
            }
          }]
        }
      };
    } else if (request.method === 'tools/call' && request.params?.name === 'weather.get') {
      try {
        const city = request.params.arguments.city;
        const res = await fetch(
          `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${API_KEY}`
        );
        const data = await res.json();
        
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{
              type: 'text',
              text: `Weather in ${city}: ${data.weather[0].description}, ${Math.round(data.main.temp - 273.15)}°C`
            }]
          }
        };
      } catch (err) {
        response = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: err.message }
        };
      }
    } else {
      response = {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32601, message: 'Method not found' }
      };
    }
    
    MCP.writeLine(JSON.stringify(response));
  }
}

main();
```

---

## Manifest Configuration

JS MCP servers are configured via the manifest:

```json
{
  "id": "weather-js",
  "name": "Weather Server",
  "version": "1.0.0",
  "runtime": "js",
  
  "scriptUrl": "https://example.com/weather-server.js",
  
  "capabilities": {
    "network": {
      "hosts": ["api.openweathermap.org"]
    }
  },
  
  "secrets": {
    "WEATHER_API_KEY": "your-api-key-here"
  },
  
  "tools": [
    {
      "name": "weather.get",
      "description": "Get weather for a city",
      "inputSchema": {
        "type": "object",
        "properties": {
          "city": { "type": "string" }
        },
        "required": ["city"]
      }
    }
  ]
}
```

### Manifest Fields for JS Servers

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `runtime` | `"js"` | **Yes** | Must be `"js"` for JS servers |
| `scriptUrl` | string | One of | URL to fetch JS bundle from |
| `scriptBase64` | string | these | Base64-encoded JS bundle |
| `capabilities.network.hosts` | string[] | No | Allowed network hosts |
| `secrets` | object | No | Key-value pairs injected as `process.env` |

### Network Host Patterns

- `"api.example.com"` — Exact match
- `"*.example.com"` — Wildcard subdomain (matches `a.example.com`, `b.c.example.com`)
- `"*"` — Any host (requires explicit user approval)

---

## Bundling Recommendations

Since `importScripts` is disabled and npm packages can't be loaded directly, you need to bundle your server code:

### Using esbuild

```bash
esbuild src/server.js --bundle --format=iife --outfile=dist/server.js
```

### Using rollup

```bash
rollup src/server.js --file dist/server.js --format=iife
```

### Using webpack

```javascript
// webpack.config.js
module.exports = {
  entry: './src/server.js',
  output: {
    filename: 'server.js',
    iife: true
  },
  target: 'webworker'
};
```

---

## Debugging

### Console Output

All `console.log`, `console.warn`, `console.error` calls are forwarded to the browser's developer console with a `[JS MCP]` prefix.

### Common Errors

**"Network access denied"**
- Check that the host is in `capabilities.network.hosts`
- Ensure the URL is well-formed

**"JS server failed to initialize within timeout"**
- Check for syntax errors in your code
- Ensure the main loop starts immediately

**"Failed to parse request"**
- Ensure you're parsing the line as JSON correctly
- Check that `MCP.readLine()` returns a string

---

## Comparison: JS vs WASM Servers

| Aspect | JS Server | WASM Server |
|--------|-----------|-------------|
| Language | JavaScript | Rust, Go, C/C++ |
| Sandbox | Web Worker | WASI |
| Security | Good (capability-based) | Excellent (memory-safe) |
| Performance | Good | Excellent |
| Development | Fast iteration | Compile step |
| Ecosystem | npm (bundled) | Cargo, etc. |
| Best for | Quick prototypes, API wrappers | Production, security-critical |

---

## Future Enhancements

- **SES/Lockdown** — Additional hardening via Secure ECMAScript
- **Resource limits** — CPU time and memory limits
- **Hot reload** — Update server code without restart
- **TypeScript support** — Direct TS execution via bundler integration
