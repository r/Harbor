# Bring Your Own Chatbot (BYOC) Demo

This demo showcases "Bring Your Own Chatbot" (BYOC) — a pattern where websites can leverage the user's own AI chatbot while providing site-specific context and tools.

## How It Works

1. **Website Declares MCP Server** — The page includes a `<link rel="mcp-server">` element pointing to its MCP server
2. **User Clicks "Chat with AI"** — Website calls `agent.mcp.register()` and `agent.chat.open()`
3. **Browser Asks for Permission** — User sees what tools the website wants to provide
4. **Your Chatbot Opens** — Your personal AI assistant opens with access to the website's tools

## Running the Demo

### 1. Start the demo servers

```bash
cd demo
npm run dev
```

This starts:
- **Demo server** at `http://localhost:8000` (serves demo pages)
- **MCP server** at `http://localhost:3001` (Acme Shop tools)

### 2. Visit the demo

Open `http://localhost:8000/bring-your-chatbot/` in Firefox with Harbor installed.

### 3. Try it out

Click the chat button in the corner and ask questions like:
- "What laptops do you have?"
- "Search for headphones"
- "Add wireless headphones to my cart"

## The MCP Server

The demo includes a real MCP server (`mcp-server/http-server.js`) that provides:

| Tool | Description |
|------|-------------|
| `search_products` | Search the product catalog |
| `get_product_details` | Get details about a product |
| `add_to_cart` | Add items to cart |
| `get_cart` | View cart contents |

## Key APIs Used

```javascript
// Discover link-declared MCP servers
const servers = await window.agent.mcp.discover();

// Register website's MCP server
const result = await window.agent.mcp.register({
  url: 'http://localhost:3001/mcp',
  name: 'Acme Shop',
  tools: ['search_products', 'add_to_cart', 'get_cart'],
});

// Open the browser's chat UI
await window.agent.chat.open({
  systemPrompt: 'You are a shopping assistant...',
  style: { accentColor: '#ff9900' },
});
```

## Graceful Degradation

If the Web Agent API isn't available (no Harbor extension), the demo shows a fallback message. Websites should always provide alternative help options.

## Files

```
bring-your-chatbot/
├── index.html              # Demo page (e-commerce mockup)
├── mcp-server/
│   ├── http-server.js      # Real MCP server with SSE transport
│   └── package.json
└── README.md               # This file
```

## See Also

- [Web Agent API Reference](../../docs/JS_AI_PROVIDER_API.md) — Full API documentation
- [Architecture](../../ARCHITECTURE.md) — How Harbor implements BYOC
