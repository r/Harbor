# Web Agents API Extension

**Injects `window.ai` and `window.agent` APIs into web pages.**

This extension is the second half of Harbor. While the main Harbor extension provides the backend (native bridge, MCP servers, chat sidebar), this extension injects JavaScript APIs into every web page, enabling websites to use AI capabilities.

---

## What It Does

When this extension is active, every web page gets access to:

```javascript
window.ai      // Text generation (Chrome Prompt API compatible)
window.agent   // Tools, permissions, browser access, sessions
```

The extension:
1. **Injects a content script** into every page
2. **Exposes the Web Agents API** via `window.ai` and `window.agent`
3. **Communicates with Harbor** to fulfill API requests
4. **Enforces permissions** — websites must request and receive user consent; the grants live in Harbor, which this extension asks before every call

---

## Relationship to Harbor

```
┌─────────────────────────────────────────────────────────────┐
│                        WEB PAGE                              │
│                                                             │
│   Your code:                                                │
│   const session = await window.ai.createTextSession();      │
│   const response = await session.prompt("Hello!");          │
│                                                             │
└───────────────────────────────┬─────────────────────────────┘
                                │ postMessage
                                ▼
┌───────────────────────────────────────────────────────────────┐
│              WEB AGENTS API EXTENSION (this one)              │
│                                                               │
│   • Injects window.ai and window.agent                       │
│   • Validates API calls                                       │
│   • Routes requests to Harbor                                │
│   • Returns responses to the page                            │
└───────────────────────────────┬───────────────────────────────┘
                                │ extension messaging
                                ▼
┌───────────────────────────────────────────────────────────────┐
│                    HARBOR EXTENSION                           │
│                                                               │
│   • MCP server management                                    │
│   • Native bridge connection                                 │
│   • Permission enforcement                                   │
│   • LLM routing                                              │
└───────────────────────────────────────────────────────────────┘
```

**Both extensions must be installed** for web pages to use the API. Without this extension, web pages have no `window.ai` or `window.agent`.

---

## Building

### Firefox (default)

```bash
npm install
npm run build
```

Output: `dist-firefox/`

### Chrome

```bash
npm run build:chrome
```

Output: `dist-chrome/`

### Safari

```bash
npm run build:safari
```

Output: `dist-safari/`

### All Platforms

```bash
npm run build:all
```

---

## Development

### Watch Mode

Automatically rebuilds when files change:

```bash
npm run dev           # Firefox
npm run dev:chrome    # Chrome
npm run dev:safari    # Safari
```

After rebuilding, reload the extension in your browser:
- Firefox: `about:debugging` → Reload
- Chrome: `chrome://extensions` → Reload icon

---

## Loading the Extension

### Firefox

1. Go to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on..."
3. Select `dist-firefox/manifest.json`

### Chrome

1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `dist-chrome/` folder

### Safari

The Safari version is built into the Harbor.app Xcode project. See the Safari setup guide.

---

## Project Structure

```
web-agents-api/
├── src/
│   ├── injected.ts          # APIs injected into page context
│   ├── content-script.ts    # Bridge between page and extension
│   ├── background.ts        # Service worker / background script
│   ├── sidebar.ts           # Sidebar UI (if any)
│   ├── harbor-client.ts     # Communication with Harbor extension
│   └── types.ts             # TypeScript definitions
├── assets/                  # Icons and static assets
├── manifest.json           # Firefox manifest
├── manifest.chrome.json    # Chrome manifest
├── manifest.safari.json    # Safari manifest
├── build.mjs               # Build script
└── package.json
```

---

## How It Works

### API Injection

The extension uses a content script that injects code into the page's context:

1. `content-script.ts` runs in the content script context
2. It injects `injected.ts` into the page's main world
3. `injected.ts` creates `window.ai` and `window.agent`
4. API calls are serialized and sent via `postMessage`
5. The content script forwards them to Harbor
6. Responses flow back the same way

### Permission Flow

When a page calls `window.agent.requestPermissions()`:

1. The request is forwarded to Harbor
2. Harbor opens its permission prompt window
3. User approves or denies, and Harbor stores the answer
4. Result is returned to the page

Harbor holds the only copy of each site's grants. This extension asks Harbor before every call, so revoking a site in Harbor's sidebar takes effect immediately. If Harbor isn't available, nothing is granted.

---

## API Reference

For complete API documentation, see:

- **[Web Agents API Reference](../docs/WEB_AGENTS_API.md)** — Full API with examples
- **[JS API Reference](../docs/JS_AI_PROVIDER_API.md)** — Detailed method signatures
- **[LLMS.txt](../docs/LLMS.txt)** — AI-optimized compact reference

### Quick Examples

**Text Generation:**
```javascript
const session = await window.ai.createTextSession();
const response = await session.prompt("What is JavaScript?");
session.destroy();
```

**Tool Calling:**
```javascript
await window.agent.requestPermissions({
  scopes: ['mcp:tools.list', 'mcp:tools.call']
});
const tools = await window.agent.tools.list();
const result = await window.agent.tools.call({
  tool: 'time-wasm/time.now',
  args: {}
});
```

**Autonomous Agent:**
```javascript
for await (const event of window.agent.run({ task: 'What time is it?' })) {
  if (event.type === 'final') console.log(event.output);
}
```

---

## Feature Flags

Some capabilities are gated by feature flags that users control in the Harbor sidebar:

| Flag | Default | What It Enables |
|------|---------|-----------------|
| `textGeneration` | ✅ On | `window.ai.*` |
| `toolAccess` | ✅ On | `agent.tools.list()`, `agent.tools.call()` |
| `toolCalling` | ❌ Off | `agent.run()` |
| `browserInteraction` | ❌ Off | `agent.browser.activeTab.*` |
| `browserControl` | ❌ Off | `agent.browser.navigate()`, `agent.browser.tabs.*` |
| `multiAgent` | ❌ Off | `agent.agents.*` |

---

## Troubleshooting

### "window.ai is undefined"

- Is the Web Agents API extension loaded? Check `about:debugging` (Firefox) or `chrome://extensions` (Chrome)
- Refresh the page after loading the extension
- Check the browser console for errors

### "ERR_HARBOR_NOT_FOUND"

- Is the Harbor extension also loaded?
- Both extensions need to be active

### API calls hang or timeout

- Is the Harbor extension's sidebar showing "Bridge: Connected"?
- Is Ollama running? (`ollama serve`)

---

## See Also

- [Main Quickstart](../QUICKSTART.md) — Full setup guide
- [Firefox Setup](../docs/QUICKSTART_FIREFOX.md)
- [Chrome Setup](../docs/QUICKSTART_CHROME.md)
- [Web Agents API Reference](../docs/WEB_AGENTS_API.md)
