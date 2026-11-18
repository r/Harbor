# Testing the Browser Capture (MCP.requestHost) Flow

## What to Test

1. **Bridge**: When a JS MCP server calls `MCP.requestHost(method, params)`, the bridge sends `host_request` to the extension and blocks until `host_response` is received, then returns the result to the server.
2. **Harbor extension**: When it receives `host_request` from the bridge, it handles the request itself and sends `host_response` back. `browser.*` methods run only when the tool call came from Harbor's own pages (the sidebar or the Tool Tester); tool calls a web page starts are refused. `http.get` runs for any caller, without cookies.
3. **Web Agents (older path)**: When it receives `agent.host.run` with `browser.capturePage` or `browser.getCookies`, it limits a page-origin request to that page's own origin, opens a tab (or uses an existing one), and returns content/cookies.

## Test Levels

### 1. Unit / handler tests

- **Web Agents `host-run-handlers.ts`**: Mock `chrome.tabs.create` and `executeScriptInTab`; call `handleHostRun` with `browser.capturePage` and assert the returned shape and permission checks.
- **Harbor `host-request-handlers.ts`**: Mock the capture functions; assert that `browser.*` methods are refused unless the context origin is `harbor-extension`, and that `http.get` omits credentials (see `extension/src/__tests__/host-request-origin.test.ts`).

### 2. Bridge-only test (no browser)

- Run the bridge with native messaging stdio.
- Start a JS server that implements one tool: when called, it calls `MCP.requestHost('browser.capturePage', { url: 'https://example.com' })` and returns the result.
- Send `js.call` with that tool call. The bridge will send `host_request` on stdout.
- **Mock extension**: The test harness reads stdout; when it sees `type: 'host_request'`, it sends back a message with `type: 'host_response'`, same `id`, and a mock `result: { content: '...', title: '...', url: '...' }`.
- Assert the final `rpc_response` for the `js.call` contains the mock result (so the JS server received it and returned it).

This is implemented by extending the bridge test harness (e.g. `tests/e2e/test-mcp-servers.mjs` or a dedicated `test-host-request.mjs`) so that:

- The process that talks to the bridge over stdio handles both RPC responses and `host_request`.
- On `host_request`, it immediately writes a length-prefixed `host_response` message with a mock result.
- Then the bridge’s `js.call` completes and the test asserts on the tool result.

### 3. Full stack (manual or E2E)

- Load Harbor + Web Agents extensions in a browser.
- Install and start a JS MCP server that uses `MCP.requestHost('browser.capturePage', { url })` in one of its tools.
- Call that tool from the Harbor sidebar or Tool Tester. Verify a new tab opens, content is returned, and the tool result contains the expected data.
- Call the same tool from a web page (for example through `agent.tools.call`). Verify the capture is refused with "Browser capture is only allowed from the Harbor sidebar."

## Test server example (for bridge-only test)

Minimal JS server code that uses `MCP.requestHost`:

```javascript
async function main() {
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
            name: 'capture_page',
            description: 'Ask host to open URL and return content',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url']
            }
          }]
        }
      };
    } else if (request.method === 'tools/call') {
      const url = request.params?.arguments?.url || 'https://example.com';
      try {
        const res = await MCP.requestHost('browser.capturePage', { url });
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(res) }]
          }
        };
      } catch (e) {
        response = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: String(e.message) }
        };
      }
    } else {
      response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
    }
    MCP.writeLine(JSON.stringify(response));
  }
}
main().catch(console.error);
```

Use this in a test that:

1. Starts the bridge.
2. Sends `js.start_server` with this code and capabilities that allow no network (or a dummy host).
3. Sends `js.call` with `tools/call` and `arguments: { url: 'https://example.com' }`.
4. When the harness sees `host_request`, replies with `host_response` and a mock `result: { content: 'mock content', title: 'Example', url: 'https://example.com' }`.
5. Asserts the `js.call` rpc_response contains that result in the tool output.

## Running existing MCP tests

```bash
cd harbor/tests/e2e
npm run test:mcp
```

A new test script for the host_request flow can be added alongside this (e.g. `test-host-request.mjs`) that uses the same bridge binary and encoding, and adds the host_request/host_response handling in the stdio loop.
