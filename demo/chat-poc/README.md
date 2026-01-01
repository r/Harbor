# Harbor Chat Demo

A complete example showing how to use the Harbor JS AI Provider APIs (`window.ai` and `window.agent`) in any website.

## Quick Start

1. **Install the Harbor extension** (see main README)

2. **Serve this demo**:
   ```bash
   cd demo/chat-poc
   python3 -m http.server 8000
   ```
   Or use any static file server.

3. **Open in browser**: Navigate to `http://localhost:8000`

4. **Start chatting**: Type a message and press Enter

## API Reference

### `window.ai` - Text Generation

Create text sessions for LLM inference:

```javascript
// Create a session with optional system prompt
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a helpful assistant.',
  temperature: 0.7,  // optional, 0-1
});

// Non-streaming prompt
const response = await session.prompt('What is the capital of France?');
console.log(response);  // "The capital of France is Paris."

// Streaming prompt
for await (const event of session.promptStreaming('Tell me a story')) {
  if (event.type === 'token') {
    process.stdout.write(event.token);
  }
}

// Clean up when done
await session.destroy();
```

### `window.agent` - Agent with Tools

Access MCP tools and run autonomous agents:

```javascript
// List available tools
const tools = await window.agent.tools.list();
console.log(tools);
// [{ name: "memory/store", description: "Store a memory", ... }]

// Call a specific tool
const result = await window.agent.tools.call({
  tool: 'memory/store',
  args: { key: 'greeting', value: 'Hello World' }
});

// Read the active browser tab
const tab = await window.agent.browser.activeTab.readability();
console.log(tab.title, tab.text);

// Run an autonomous agent with tools
for await (const event of window.agent.run({
  task: 'Search for recent news about AI and summarize',
  maxToolCalls: 5,
  requireCitations: true,
})) {
  switch (event.type) {
    case 'status':
      console.log('Status:', event.message);
      break;
    case 'tool_call':
      console.log('Calling tool:', event.tool, event.args);
      break;
    case 'tool_result':
      console.log('Tool result:', event.result);
      break;
    case 'token':
      process.stdout.write(event.token);
      break;
    case 'final':
      console.log('\n\nFinal:', event.output);
      console.log('Citations:', event.citations);
      break;
    case 'error':
      console.error('Error:', event.error);
      break;
  }
}
```

### Permissions

Websites must request permissions before using certain APIs:

```javascript
// Request permissions
const result = await window.agent.requestPermissions({
  scopes: [
    'model:prompt',         // Text generation
    'model:tools',          // LLM with tool calling
    'mcp:tools.list',       // List MCP tools
    'mcp:tools.call',       // Execute MCP tools
    'browser:activeTab.read', // Read active tab content
  ],
  reason: 'This app uses AI to help you with tasks.',
});

if (result.granted) {
  console.log('All permissions granted!');
} else {
  console.log('Permission status:', result.scopes);
}

// Check current permissions
const status = await window.agent.permissions.list();
console.log(status.scopes);
```

## Event Types

### Stream Token Events (`promptStreaming`)

```typescript
type StreamToken =
  | { type: 'token'; token: string }
  | { type: 'done' }
  | { type: 'error'; error: { code: string; message: string } };
```

### Agent Run Events (`agent.run`)

```typescript
type RunEvent =
  | { type: 'status'; message: string }
  | { type: 'tool_call'; tool: string; args: Record<string, unknown> }
  | { type: 'tool_result'; tool: string; result: unknown; error?: { code: string; message: string } }
  | { type: 'token'; token: string }
  | { type: 'final'; output: string; citations?: Array<{ source: string; ref: string; excerpt: string }> }
  | { type: 'error'; error: { code: string; message: string } };
```

## Troubleshooting

**"Extension not found"**
- Install the Harbor extension
- Reload the page after installation
- Check that the extension is enabled in your browser

**"LLM Error"**  
- Make sure Ollama is running: `ollama serve`
- Or start a local LLM via the Harbor sidebar

**"No tools available"**
- Connect MCP servers in the Harbor sidebar
- Start servers before using tools

**Permission denied**
- Click "Connect to Harbor" to request permissions
- Check extension settings if previously denied

## Files

- `index.html` - Demo UI with chat interface
- `app.js` - Example code using window.ai and window.agent APIs
- `README.md` - This documentation

## License

MIT

