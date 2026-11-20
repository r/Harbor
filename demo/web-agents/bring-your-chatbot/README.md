# Bring Your Own Chatbot (BYOC) Demo

This demo shows "Bring Your Own Chatbot" (BYOC): a site that doesn't want to build its own
chat UI calls `agent.chat.open()`, and the implementer of the Web Agent API — Harbor, in this
browser — opens the chat surface instead. The page writes no chat UI of its own.

## How It Works

1. **The page calls `agent.chat.open({ systemPrompt, style })`** — Clicking the chat button
   runs this one call with a system prompt describing the assistant and style hints (an accent
   color, which side of the screen to open on). The page can also advertise tools with
   `<link rel="mcp-server">`, as this page's `<head>` does.
2. **Harbor asks whether the site may open a chat** — The first `chat.open()` call from this
   origin prompts for the `chat:open` permission. If it's denied, the call rejects and the page
   shows an inline message.
3. **Harbor's chat opens on the page and runs on your own model, or your own agent** —
   Harbor draws the chat panel on the page. Because the page could reach that panel, Harbor
   treats every message in it as the site's prompt. Your first message prompts Harbor to ask,
   once, whether the site may send prompts to your model (`model:prompt`). If you've selected
   an agent in Harbor's sidebar (the **Agent** panel, next to LLM Providers), the chat answers
   from that agent instead — with whatever it can do in your setup, including its tools and
   what it remembers about you — and the permission prompt says so. Either way, replies are
   grounded in the page's visible text (the product grid), not the MCP tools this page
   advertises — Harbor's chat doesn't call those yet.
4. **The site wrote no chat UI** — Every bubble and input box belongs to Harbor, not to Acme
   Shop. A different implementer of the same API — for example a native app hosting this page
   — could show its own chat surface instead, using the same `agent.chat.open()` call.

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

Click "Chat with Acme Shop" and ask questions like:
- "What laptops do you have?"
- "Tell me about the wireless headphones"
- "What do you recommend for home office?"

## Key APIs Used

This page uses exactly one call from the Web Agent API — no chat UI, no permission
request, and no `window.ai` of its own:

```javascript
await window.agent.chat.open({
  systemPrompt: "You are Acme Shop's shopping assistant. Help the person choose from the products on this page, using anything you know about them...",
  style: { accentColor: '#ff9900', position: 'right' },
});
```

Harbor asks for `chat:open` when the chat opens, and for `model:prompt` on the first message
the person sends — the page never calls `agent.requestPermissions()` or `window.ai` itself.

## Graceful Degradation

If `window.agent?.chat?.open` isn't available (no Web Agent API implementer installed), the
demo hides the chat button and shows a banner explaining why.

## Files

```
bring-your-chatbot/
├── index.html              # Demo page (e-commerce mockup, no chat UI of its own)
├── mcp-server/             # Optional MCP server (declared, not called by Harbor's chat yet)
│   ├── http-server.js      # Real MCP server with SSE transport
│   └── package.json
└── README.md               # This file
```

## See Also

- [Web Agent API Documentation](../../../docs/WEB_AGENTS_API.md) — Full API reference
- [Other Demos](../) — More Web Agent API examples
