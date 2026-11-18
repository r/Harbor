# Bring Your Own Chatbot (BYOC) Demo

This demo showcases "Bring Your Own Chatbot" (BYOC) — a pattern where websites can leverage the user's own AI chatbot while providing site-specific context and tools.

## How It Works

1. **Website Declares MCP Server** — The page includes a `<link rel="mcp-server">` element pointing to its MCP server
2. **User Clicks "Chat with AI"** — Website requests permission via `agent.requestPermissions()`
3. **Browser Asks for Permission** — User sees what capabilities the website wants
4. **Your AI Responds** — The embedded chat uses `window.ai.createTextSession()` for responses

## Running the Demo

### 1. Start the demo server

```bash
cd demo
npm run dev
```

This starts the demo server at `http://localhost:8000` (serves demo pages).

### 2. Visit the demo

Open `http://localhost:8000/web-agents/bring-your-chatbot/` with Harbor installed.

### 3. Try it out

Click the chat button in the corner and ask questions like:
- "What laptops do you have?"
- "Tell me about the wireless headphones"
- "What do you recommend for home office?"
- "Add the laptop stand to my cart"

## Key APIs Used

This demo uses **only** the page-facing Web Agent API (`window.ai` / `window.agent`), not any Harbor-specific integration:

```javascript
// Request permission for text generation
const { granted } = await window.agent.requestPermissions({
  scopes: ['model:prompt'],
  reason: 'To help you find products'
});

// Create a text session with context
const session = await window.ai.createTextSession({
  systemPrompt: 'You are a shopping assistant for Acme Shop...'
});

// Get AI responses (streaming)
for await (const token of session.promptStreaming(userMessage)) {
  // Display token
}
```

## Features

- **Embedded Chat UI** — The chat panel is built into the page
- **Streaming Responses** — Tokens appear as they're generated
- **Shopping Context** — The AI knows about products in the catalog
- **Cart Management** — Simple cart functionality

## Graceful Degradation

If the Web Agent API isn't available (Harbor not installed), the demo shows a message directing users to install the extension.

## Files

```
bring-your-chatbot/
├── index.html              # Demo page (e-commerce mockup with embedded chat)
├── mcp-server/             # Optional MCP server (not required for basic demo)
│   ├── http-server.js      # Real MCP server with SSE transport
│   └── package.json
└── README.md               # This file
```

## See Also

- [Web Agent API Documentation](../../../docs/WEB_AGENTS_API.md) — Full API reference
- [Other Demos](../) — More Web Agent API examples
