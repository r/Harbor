# Plan: Non-OAuth Secrets Storage and Login Flow

## Goal

Enable Harbor to store **user-configured login credentials** (email/password or session cookie) per MCP server, inject them into the server at runtime, and support **browser-based login** so that an MCP server (e.g. Atlantic) can “log in” when the user is not already logged in. End-to-end: user enters credentials once in Harbor → server receives them via `process.env` → server can ask the host to perform login in the browser, then capture the page.

---

## 1. Manifest: Declare Required Secrets

Servers declare which secrets they need so Harbor can show the right form and validate before start.

**Schema addition** (in manifest / `McpServerManifest`):

```ts
// In wasm/types.ts (or shared manifest schema)
/** Declares non-OAuth secrets this server needs. Keys are env var names; value is metadata. */
secrets?: Array<{
  name: string;      // e.g. 'ATLANTIC_EMAIL' → process.env.ATLANTIC_EMAIL
  label: string;    // e.g. 'Atlantic account email'
  type?: 'text' | 'password';
  optional?: boolean;
}>;
```

**Example (Atlantic):**

```json
{
  "id": "atlantic-archive",
  "runtime": "js",
  "secrets": [
    { "name": "ATLANTIC_EMAIL", "label": "Atlantic account email", "type": "text" },
    { "name": "ATLANTIC_PASSWORD", "label": "Password", "type": "password" }
  ]
}
```

Alternative: session-cookie-only server could declare a single secret:

```json
"secrets": [
  { "name": "ATLANTIC_SESSION_COOKIE", "label": "Session cookie (from DevTools after logging in)", "type": "password" }
]
```

**Backward compatibility:** Existing `secrets?: Record<string, string>` in the type is currently “name → value” used by the builtin worker for init-env. We keep that for worker fallback; the **declaration** for user-configured secrets is the array form above. When building `env` for the bridge, we use **stored** values keyed by `name`, not the manifest record.

---

## 2. Harbor: Storage for Secret Values

Secret values must be stored **separately** from the rest of the manifest so we never persist passwords in the same blob as server config (export/backup, logging, etc.).

**Storage key:** e.g. `harbor_server_secrets`.

**Shape:**

```ts
// Key: harbor_server_secrets
// Value:
Record<string, Record<string, string>>
// serverId → { ATLANTIC_EMAIL: "user@example.com", ATLANTIC_PASSWORD: "..." }
```

**APIs (new module or in storage/servers.ts):**

- `getServerSecrets(serverId: string): Promise<Record<string, string>>`
- `setServerSecrets(serverId: string, values: Record<string, string>): Promise<void>`
- `clearServerSecrets(serverId: string): Promise<void>` (on server remove)

**Lifecycle:**

- When a server is **removed**, clear its entry in `harbor_server_secrets`.
- Do **not** log or include secret values in any error payload or debug output.
- Optional later: encrypt at rest (e.g. use a key derived from a user prompt or from extension identity). For v1, storage.local is acceptable if we never sync or export secrets.

---

## 3. Harbor: UI to Set Secrets

Users need a way to enter and edit secrets for a server that declares them.

**Option A – Sidebar, per-server:**  
In the MCP Servers list, when a server has `manifest.secrets` (array), show a “Configure” or “Secrets” control. Clicking it opens a small form (modal or inline): one field per secret (`label`, `type` text/password). Save writes to `harbor_server_secrets` and does not store in the main server manifest.

**Option B – Dedicated “Secrets” or “Server settings” panel:**  
A panel that lists servers with declared secrets and lets the user edit values. Same storage as above.

**Validation (optional):**  
On “Start” server, if `manifest.secrets` has required (non-optional) entries and any is missing in `getServerSecrets(serverId)`, show a toast or prompt: “Configure secrets for this server” and focus the secrets form.

**Recommendation:** Start with Option A (Configure next to each server in the sidebar).

---

## 4. Harbor: Inject Secrets into env When Starting the JS Server

When creating a **bridge** session for a JS server, we already build `env` and send it in `js.start_server`. Today we only add OAuth tokens. We add:

1. **Load stored secrets:**  
   `const stored = await getServerSecrets(manifest.id);`
2. **Merge into env:**  
   `Object.assign(env, stored);` (only for keys that the server declared in `manifest.secrets`, if we want to be strict; or allow any stored key for that server).
3. **Send in bridge request:**  
   `bridgeRequest('js.start_server', { id, code, env, capabilities })` — no change to the wire format; `env` now includes both OAuth and user-configured secrets.

**Bridge / QuickJS:**  
Already receives `env` and injects into the JS runtime as `process.env`. No change needed there.

**Result:** The Atlantic (or any) JS server can read `process.env.ATLANTIC_EMAIL` and `process.env.ATLANTIC_PASSWORD` and use them when calling a host method that performs login.

---

## 5. Host Method: Login Then Capture

To “log in when not logged in,” the host (Web Agents) must perform a login in the browser and then capture the target page. So we need a **new host method** that the MCP server can call via `MCP.requestHost(...)`.

**Proposed method:** `browser.loginThenCapture`

**Params:**

- `loginUrl: string` – e.g. Atlantic login page.
- `credentials: { email?: string; password?: string }` or `{ cookie?: string }` – from the MCP server (which got them from `process.env`).
- `targetUrl: string` – URL to open and capture after successful login (e.g. search or article).
- `waitForLoad?: boolean`, `timeout?: number` – same semantics as `browser.capturePage`.

**Behavior (Web Agents):**

1. Check permission for `origin` (same as `browser.capturePage`).
2. Create a tab, navigate to `loginUrl`.
3. Wait for load (or a short delay).
4. Run an injected script to find email/password fields (e.g. by common selectors or `input[type="email"]`, `input[type="password"]`), fill them, find submit button, click.
5. Wait for navigation (e.g. URL change or timeout).
6. Navigate to `targetUrl` (or reuse the same tab if already there).
7. Wait for load, then run the same content-extraction script as `browser.capturePage` and return `{ title, url, content }`.

**Fragility:** Login forms vary by site. Atlantic (and others) may use different selectors, 2FA, or captchas. So:

- **v1:** Implement for a single known site (e.g. Atlantic) with a small, documented selector map; return a clear error if the form is not found or submit fails.
- **Later:** Allow the manifest (or the host method params) to pass optional selector hints (e.g. `emailSelector`, `passwordSelector`, `submitSelector`) so other sites can be supported without changing code.

**Alternative: cookie-only flow**

- **Method:** `browser.setCookiesThenCapture`  
  Params: `domain: string`, `cookies: string` (e.g. `name=value; name2=value2`), `targetUrl: string`, plus usual capture options.
- **Behavior:** Use Chrome’s `cookies.set` (or equivalent) to set cookies for `domain`, then open `targetUrl` and capture. No form fill.
- **Use case:** User logs in once manually, copies session cookie from DevTools; we store it as a secret; the server passes it to `setCookiesThenCapture` before each capture. No password in storage, but no automated login either.

We can implement **loginThenCapture** first (for Atlantic) and add **setCookiesThenCapture** later if we want a cookie-only path.

---

## 6. Atlantic Server: End-to-End Flow

1. **User** adds Atlantic server (e.g. from `atlantic-archive-dist.json`). Manifest declares `secrets: [ ATLANTIC_EMAIL, ATLANTIC_PASSWORD ]`.
2. **User** clicks “Configure” for Atlantic in the sidebar and enters email + password. Harbor saves them to `harbor_server_secrets['atlantic-archive']`.
3. **User** starts the Atlantic server. Harbor loads stored secrets, merges into `env`, and calls `js.start_server` with that `env`. Bridge injects into `process.env`.
4. **User** (or an app) calls the `search_atlantic` tool. The Atlantic server:
   - Optionally calls `MCP.requestHost('browser.capturePage', { url: searchUrl })` first. If the result looks like a login/paywall page (e.g. title or content contains “Sign in” or “Subscribe”), then:
   - Calls `MCP.requestHost('browser.loginThenCapture', { loginUrl: 'https://www.theatlantic.com/login/', credentials: { email: process.env.ATLANTIC_EMAIL, password: process.env.ATLANTIC_PASSWORD }, targetUrl: searchUrl })`.
   - Returns the parsed search results as today.
5. **Web Agents** performs the login flow, then captures the target URL and returns content to the bridge → Atlantic server → tool result.

**Fallback:** If credentials are missing (`!process.env.ATLANTIC_EMAIL`), the Atlantic server skips login and only does `browser.capturePage` (current behavior; works when the user is already logged in).

---

## 7. Security and Constraints

- **Secrets in motion:** They go Harbor storage → extension background → bridge (in `js.start_server` env) → JS server `process.env`. They may be sent again in `host_request.params.credentials` from the bridge to Harbor to Web Agents. All of this is in-process or extension messaging; we do not send secrets to a remote backend.
- **Secrets at rest:** Stored in `storage.local` under a dedicated key. Optional future: encrypt with a key tied to the extension or user.
- **Logging:** Never log or include secret values in console, errors, or analytics.
- **Export/backup:** If we ever export server config, exclude the secrets blob or export it separately with explicit user action.
- **Permissions:** Only origins that are allowed to use `browser.capturePage` (or a new “login then capture” permission) can trigger `browser.loginThenCapture`; same permission model as today for host requests.

---

## 8. Implementation Order

| Step | Component | Task |
|------|-----------|------|
| 1 | Manifest / types | Add `secrets?: Array<{ name, label, type?, optional? }>` to manifest type and document it. |
| 2 | Harbor storage | Add `harbor_server_secrets` storage, `getServerSecrets`, `setServerSecrets`, `clearServerSecrets`; clear on server remove. |
| 3 | Harbor JS session | In `createBridgeSession`, load stored secrets for `manifest.id` and merge into `env` before `js.start_server`. |
| 4 | Harbor sidebar | Add “Configure” / “Secrets” UI for servers with `manifest.secrets`; load/save via the new storage APIs. |
| 5 | Web Agents | Implement `browser.loginThenCapture` (and optionally `browser.setCookiesThenCapture`); add to host-run-handlers and permission check. |
| 6 | Atlantic server | Update to optionally call `loginThenCapture` when credentials are present and capture suggests a login page; keep current behavior when credentials are absent. |

---

## 9. Summary

- **Harbor** gains a **per-server secrets store** and **UI** to set them, and **injects** those secrets into the bridge’s `env` when starting a JS server so the server can read them via `process.env`.
- **Web Agents** gains a **host method** (`browser.loginThenCapture`) that performs a form-based login in the browser and then captures a target URL, so the MCP server can “manage” login when the user has stored credentials.
- The **Atlantic** (or any) server can then use stored email/password to log in automatically when the user is not already logged in, while still working with “existing session only” when no secrets are configured.
