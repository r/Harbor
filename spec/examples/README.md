# Web Agent API Examples

Working examples demonstrating the Web Agent API (`window.ai` and `window.agent`).

## Examples

| Example | Description | Permissions Used |
|---------|-------------|------------------|
| [basic-chat.html](./basic-chat.html) | Simple chat interface with streaming | `model:prompt` |
| [agent-with-tools.html](./agent-with-tools.html) | Agent task runner with MCP tools | `model:tools`, `mcp:tools.list`, `mcp:tools.call` |
| [provider-selection.html](./provider-selection.html) | Choose between AI providers | `model:prompt`, `model:list` |
| [page-analyzer.html](./page-analyzer.html) | Analyze current tab content | `model:prompt`, `browser:activeTab.read` |

## Running the Examples

1. **Install an implementation**: Make sure Harbor (or another Web Agent API implementation) is installed
2. **Open an example**: Open any `.html` file in your browser
3. **Grant permissions**: When prompted, grant the required permissions
4. **Interact**: Use the example as described

## Requirements

- A Web Agent API implementation installed (e.g., Harbor)
- At least one AI backend configured (Ollama, OpenAI, etc.)
- For tool examples: At least one MCP server connected

**Testing these examples or your own app?** See [Testing your app](../../docs/TESTING_YOUR_APP.md) — generate a test harness (mock + E2E) from the Harbor repo with `scripts/generate-test-harness.mjs`.

## Using in Your Own Projects

These examples are designed to be copy-paste friendly. Key patterns:

### Check for Web Agent API Availability

```javascript
if (typeof window.agent === 'undefined') {
  console.log('Web Agent API not available');
  return;
}
```

### Request Permissions

```javascript
const result = await window.agent.requestPermissions({
  scopes: ['model:prompt'],
  reason: 'Explain why you need this'
});

if (!result.granted) {
  console.log('Permission denied');
  return;
}
```

### Create a Session

```javascript
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a helpful assistant.'
});

// Non-streaming
const response = await session.prompt('Hello');

// Streaming — yields plain string chunks (Chrome Prompt API compatible).
for await (const chunk of session.promptStreaming('Hello')) {
  process.stdout.write(chunk);
}

// Clean up
session.destroy();
```

### Run an Agent Task

`agent.run()` yields **typed events**, and requires the `toolCalling` feature flag in Harbor's sidebar.

```javascript
for await (const event of window.agent.run({
  task: 'Find information about...',
  maxToolCalls: 5
})) {
  switch (event.type) {
    case 'thinking':    console.log('thinking:', event.content); break;
    case 'tool_call':   console.log('calling:', event.tool, event.args); break;
    case 'tool_result': console.log('result:', event.tool, event.result); break;
    case 'final':       console.log('done:', event.output); break;
    case 'error':       console.error('error:', event.error); break;
  }
}
```

## License

These examples are part of the Web Agent API specification and are available under the same license.

---

**Author**: Raffi Krikorian

