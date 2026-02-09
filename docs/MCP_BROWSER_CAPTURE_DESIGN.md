# MCP Browser Capture: Message Up the Stack

## Goal

Allow MCP servers (especially JS servers in the native bridge) to request that the browser **open a tab**, load a URL (optionally let the user log in), and return **page content** and/or **login state (cookies)** back to the server. This enables use cases like the Atlantic archive: the server can say “open this URL with the user’s session” and get HTML/cookies instead of doing credentialed `fetch()` from the sandbox.

## Architecture (native bridge → Harbor → Web Agents)

- **JS MCP servers** run in the **native bridge** (QuickJS). They have `fetch()` to allowed hosts and `process.env`; they do **not** have browser APIs.
- **WASM MCP servers** run in the **Harbor extension**. They also have no browser APIs.
- **Web Agents extension** has the permission model (`browser:tabs.create`, `browser:activeTab.read`, etc.) and can open tabs, run scripts in tabs, and get readability content (and, with the right APIs, cookies).

So the flow is: **MCP server → bridge (or Harbor) → Web Agents** to perform the browser action, then **result back down** to the MCP server.

## Design: Host Request / Host Response

### 1. New capability: `MCP.requestHost(method, params)` in the JS sandbox

- In the **bridge** JS sandbox we add a function (e.g. `MCP.requestHost(method, params)` or `globalThis.__requestHost(method, params)`) that the MCP server can call when it needs the host to do something it cannot do (open a tab, read content, get cookies).
- When the server calls it, the **bridge**:
  1. Sends a message **to the extension** (Harbor): **host_request** with `{ id, method, params, context }`.
  2. **Context** must include `origin` and optionally `tabId` so the host can enforce permissions (only origins that have been granted `browser:tabs.create` / `browser:activeTab.read` can use this).
  3. The bridge **blocks** (or suspends) the current tool call until it receives **host_response** with the same `id`.
  4. The bridge returns the result (or error) to the JS server, which continues and can return its own tool result.

So the “message up the stack” is: **bridge → Harbor (native messaging) → Web Agents**. The “response down” is: **Web Agents → Harbor → bridge**.

### 2. Passing request context (origin, tabId)

- Tool calls are initiated by a **session** that has an **origin** (and optionally a **tabId**). That context lives in the **Web Agents** / **Harbor** side when the user or app invokes a tool.
- When Harbor (or Web Agents) invokes the bridge for a tool call, it must pass **context** along so the bridge can attach it to any host_request:
  - For **JS servers**: today the extension sends `js.call` with `{ id, request }`. We extend this to `{ id, request, context?: { origin?, tabId? } }`.
  - For **WASM servers**: tool calls are queued in the bridge and executed by Harbor; context is already on the Harbor side, so when Harbor runs the tool it can pass context if we add a host_request path for WASM later.
- The bridge stores the current request context for the duration of that `js.call`. Any `requestHost` during that call includes that context in the **host_request** so the extension can check permissions for that origin.

### 3. Extension (Harbor) handling of host_request

- The **Harbor extension** receives messages from the bridge over native messaging. Today it only sends **RPC requests** (e.g. `js.call`) and receives **RPC responses**.
- We add handling for a **message from the bridge** that is a **host_request** (the bridge can send such a message at any time; in Chrome native messaging the native app can write to stdout and the extension receives it).
- When Harbor receives **host_request**:
  1. It reads `method`, `params`, and `context.origin` (and `context.tabId` if present).
  2. It does **not** implement browser APIs itself; it forwards to the **Web Agents extension** (which has the permission model and the ability to open tabs and run scripts in them). So Harbor sends a message to Web Agents: e.g. “run host method `browser.capturePage` with these params and this origin”.
  3. Web Agents checks that `origin` has the required permissions (e.g. `browser:tabs.create`, `browser:activeTab.read` or similar). If not, it returns an error.
  4. Web Agents opens a tab (or uses an existing one), loads the URL, optionally waits for user/login, then gets page content (readability or raw HTML) and optionally cookies for that domain, and returns them to Harbor.
  5. Harbor sends **host_response** `{ id, result }` or `{ id, error }` back to the bridge.
- The bridge then unblocks the waiting tool call and returns the result to the JS server.

### 4. Web Agents: host methods

Two host methods are enough for the Atlantic (and similar) use cases:

| Method | Purpose | Permissions | Params | Result |
|--------|--------|-------------|--------|--------|
| `browser.capturePage` | Open URL (or use existing tab), get content, optionally wait for load/login. | `browser:tabs.create` (to create tab), and ability to read from that tab (e.g. same as spawned-tab readability). | `url`, `waitForLoad?: boolean`, `timeout?: number`, `captureCookies?: boolean` | `{ content: string, title?: string, url?: string, cookies?: string }` |
| `browser.getCookies` | Get cookies for a domain (from an open tab that has that domain, or by opening a tab). | Same as above. | `domain: string`, `openUrl?: string` (if provided, open this URL first so the tab has the domain) | `{ cookies: string }` (e.g. Cookie header value or name=value list) |

- **capturePage**: Web Agents creates a tab (or reuses one) with the given URL, optionally waits for load (and optionally a timeout), runs readability (or `tab.getHtml`) on that tab, and returns content. If `captureCookies` is true, also return cookies for that origin (see below).
- **getCookies**: Either use an existing tab that has the domain, or open `openUrl` (same domain), then read cookies. Reading cookies from a page: we can inject a script to read `document.cookie` (non-httpOnly only), or use `chrome.cookies` API if the extension has the `cookies` permission and the user has consented. For maximum usefulness (e.g. session cookies that are httpOnly), we may need `chrome.cookies` and document that the extension needs the cookies permission for this.

### 5. Permission gating

- Host requests are only honored if the **request context’s origin** has the needed permissions in the Web Agents extension (e.g. `browser:tabs.create` and the capability to read from tabs that origin created).
- If the tool call was not initiated by a page (e.g. user clicked in Harbor sidebar), we may have no origin; then we could either deny host requests or treat “no origin” as a trusted context (sidebar). Design choice: require origin for host_request so that we only allow browser capture when a page with the right permissions initiated the tool call.

### 6. Protocol sketch

**Bridge → Extension (host_request):**

```json
{
  "type": "host_request",
  "id": "uuid",
  "method": "browser.capturePage",
  "params": { "url": "https://...", "captureCookies": true },
  "context": { "origin": "https://margin.example", "tabId": 123 }
}
```

**Extension → Bridge (host_response):**

```json
{
  "type": "host_response",
  "id": "uuid",
  "result": { "content": "...", "cookies": "..." }
}
```

or

```json
{
  "type": "host_response",
  "id": "uuid",
  "error": { "code": "ERR_PERMISSION_DENIED", "message": "..." }
}
```

### 7. JS server usage (Atlantic example)

The Atlantic MCP server could implement `get_article` like this (pseudocode):

```javascript
// Inside tools/call for get_article
async function getArticle(url) {
  // Option A: Use host to open tab and get content (with user's login)
  const res = await MCP.requestHost('browser.capturePage', {
    url,
    waitForLoad: true,
    timeout: 15000,
    captureCookies: false
  });
  if (res.error) throw new Error(res.error.message);
  return parseArticleHtml(res.content);
}
```

So the server does **not** use `fetch()` with a stored cookie; it asks the host to open the URL in a real browser tab (where the user may already be logged in) and return the content. Login state is implicit in the browser’s tab.

### 8. Implementation order

1. **Protocol and extension message handling**
   - Define `host_request` / `host_response` in the native messaging protocol.
   - In the **bridge**: when the JS sandbox calls `requestHost`, send `host_request` and wait for `host_response` (store pending by `id`; when a message with `type: "host_response"` and matching `id` arrives, unblock).
   - In the **Harbor extension**: when receiving a message from the bridge, if `type === 'host_request'`, do not treat it as an RPC response; handle it, then send `host_response` back to the bridge.

2. **Request context**
   - Thread `context: { origin?, tabId? }` from the caller of `callTool` (e.g. Web Agents or Harbor session) into the payload that eventually becomes `js.call` (and, for bridge, into `mcp.call_tool` if we ever add host_request for non-JS). So when the extension sends `js.call` to the bridge, include `context`. Bridge stores it for the duration of that call and attaches it to any `host_request`.

3. **Harbor → Web Agents**
   - Harbor, when it receives `host_request`, sends a message to the **Web Agents extension** (e.g. `agent.host.run` or similar) with `method`, `params`, and `context.origin`. Web Agents checks permissions for that origin, runs `browser.capturePage` or `browser.getCookies`, and returns the result to Harbor. Harbor then sends `host_response` to the bridge.

4. **Web Agents handlers**
   - Implement `browser.capturePage`: create tab (or use existing), navigate, optionally wait, run readability/getHtml, optionally read cookies, return `{ content, title, url, cookies? }`.
   - Implement `browser.getCookies`: ensure a tab with the domain (open URL if needed), then read cookies (document.cookie or chrome.cookies), return `{ cookies }`.

5. **Bridge JS sandbox**
   - Add `MCP.requestHost(method, params)` (or equivalent). Implementation: when the JS calls it, the Rust side must send `host_request` and wait for `host_response`. This requires the bridge to support an async “wait for host response” in the middle of handling one `js.call`. Details depend on how the bridge runs the JS (single-threaded event loop vs async). If the JS runtime is single-threaded and synchronous, we may need to “pause” the current RPC and handle the incoming `host_response` when it arrives, then resume the JS with the result.

### 9. Host methods: JS vs WASM

Host methods (e.g. `browser.capturePage`, `browser.getCookies`, `http.get`) are **runtime-agnostic**: the same handler in `host-request-handlers.ts` runs regardless of who sent the request. So **http.get** (and any other host method) can conceptually be called from either a **JS** or a **WASM** MCP server.

- **JS servers** (run in the bridge’s QuickJS): they have `MCP.requestHost(method, params)`. When they call it, the bridge sends `host_request` to the extension and blocks until `host_response`. So JS servers can call `http.get` today.
- **WASM servers** (run in the Harbor extension via WASI): they do not currently have a way to issue host requests. The WASM runtime does not expose a `requestHost`-style import. To allow WASM servers to use `http.get` (or other host methods), the extension’s WASM session would need to expose a host import that the WASM module can call; the extension would then call `handleHostRequest` with the same `method`/`params` and return the result. The same `handleHostRequest` and `http.get` implementation would serve both.

### 10. Implemented so far

- **Protocol:** `host_request` / `host_response`; `agent.host.run` in shared protocol.
- **Harbor extension:** In `native-bridge.ts`, on `type: 'host_request'` we call `handleHostRequest()` and send `host_response`. See `handlers/host-request-handlers.ts`. Handlers: `browser.capturePage`, `browser.getCookies`, `browser.loginThenCapture`, `browser.ensureLogin`, **`http.get`** (GET https URL, returns `{ status, statusText, body }`; used by e.g. Flickr MCP when the bridge has no `fetch`).
- **Web Agents:** No longer in the loop for MCP host_request; Harbor handles it locally (see §11).

**Bridge (Rust):** JS sandbox has `MCP.requestHost(method, params)`. Bridge sends `host_request` and waits for `host_response`; `js.call` accepts optional `context` and attaches it to `host_request`. See `bridge-rs/src/native_messaging.rs` and `bridge-rs/src/js/runtime.rs`. WASM servers do not go through the bridge for tool execution (Harbor polls and runs them); WASM host-request path not implemented.

### 11. Harbor-owned browser capture (no Web Agents dependency)

**Rationale:** MCP servers are Harbor's domain; host_request (open tab, capture, login) exists only to serve those servers. Relying on Web Agents for this path is architecturally awkward. Centralizing browser capture (and future login flows) in Harbor keeps the stack simple: **bridge → Harbor** only. Harbor already has the needed permissions (`tabs`, `scripting`, `cookies`, `host_permissions`).

**Target flow:** Bridge → Harbor (local capture) → bridge. Harbor's background handles `host_request` itself: open tab, wait for load, run `scripting.executeScript` to read content/cookies, send `host_response`. Allowed context for MCP-initiated calls: `origin: 'harbor-extension'`. Future: `browser.loginThenCapture` can also live in Harbor. Web Agents remains for the **page-facing API** (`window.ai`, etc.); it is not in the loop for MCP host_request.

### 12. Summary

- **Yes, we can send a message up the stack:** the MCP server (in the bridge) calls `MCP.requestHost(...)`, the bridge sends **host_request** to the Harbor extension, Harbor forwards to the Web Agents extension (when browser control and interaction are enabled and the request context’s origin has permission), Web Agents opens/drives the browser and returns content/cookies, and the result comes back down as **host_response** to the bridge and then to the MCP server.
- **Login state** is obtained by either (a) capturing cookies after the user has logged in in the opened tab (`captureCookies` or `browser.getCookies`), or (b) using the fact that the tab is already logged in and we only return content (no explicit cookie string). Both are supported by the above design.
