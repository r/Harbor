# Harbor Agent Gateway

**Status:** Draft feature specification

**Audience:** Harbor maintainers, browser-extension developers, MCP client authors, and security reviewers

**Last updated:** July 25, 2026

## Summary

Harbor Agent Gateway lets an authorized local agent use browser capabilities that
the user has explicitly exposed through Harbor. The gateway presents a standard
Model Context Protocol server to any compatible coding agent, desktop agent, or
other MCP client. It is not tied to one vendor, model, or agent product.

The gateway can expose three classes of capability:

1. Harbor-managed MCP tools from native, remote, JavaScript, or WASM servers.
2. Page-declared WebMCP tools from the browser tab bound to the agent session.
3. Permission-gated browser context and interaction primitives, including page
   observation, screenshots, element interaction, navigation, and tab control.

The feature preserves Harbor's positioning as a user-controlled browser
capability. Harbor does not become an autonomous agent. It becomes the secure
gateway through which the user's chosen agent can collaborate with the user in
their existing browser.

## Implementation status as of 2026-07-25

The delivered slice is the read-only foundation, not the complete Phase 1
vertical slice described later in this specification.

Implemented:

- Vendor-neutral MCP stdio initialization, tool listing, and tool calls.
- `harbor.gateway.health`.
- Session-bound `harbor.tabs.list` with safe tab metadata.
- `harbor.page.observe` for the document bound by an approved sidebar session.
- Gateway enablement, OPAQUE client pairing, revocation, and tab-bound session
  controls in the Harbor sidebar.
- User-local packaging for `harbor-bridge` and `harbor-agent-gateway`.
- Authenticated local IPC, disabled-by-default behavior, bounded outputs,
  sensitive-data filtering, authorization revalidation, and fail-closed
  configuration migration.

Not yet implemented:

- Session MCP tools, including `harbor.session.start`,
  `harbor.session.status`, and `harbor.session.end`.
- The `harbor.tabs.bind` MCP tool.
- WebMCP tool listing or calling.
- Gateway activity records.
- MCP Streamable HTTP transport.
- Live Firefox end-to-end coverage with both extensions and the installed
  native components.

The current browser read tools therefore require a `sessionId` created through
the Harbor sidebar. The delivery phases below remain the planned feature
sequence and are not rewritten to match this intermediate implementation.

## Proposed design at a glance

- Ship a vendor-neutral MCP server named `harbor-agent-gateway`.
- Require explicit client pairing before exposing any capabilities.
- Use MCP stdio first, with authenticated local IPC to the browser-connected
  native host.
- Reuse the existing native bridge `host_request` and `host_response` path.
- Bind every browser session to an explicit tab, document, origin, and lifetime.
- Keep browser, Harbor MCP, and WebMCP permissions separate and revocable.
- Expose dynamic Harbor MCP and WebMCP catalogs through stable gateway tools.
- Treat page content, page tool metadata, and page tool output as untrusted.
- Confirm mutating, destructive, cross-origin, or externally communicating
  actions according to user policy.
- Keep the gateway disabled by default and land it as reviewable pull requests.

## Motivation

Harbor already connects the main pieces:

- The Harbor extension manages models and MCP servers.
- The Web Agents API extension injects page-facing model, tool, browser, and
  WebMCP APIs.
- The Rust bridge provides native messaging, native MCP execution, model access,
  and a bidirectional `host_request` path back into the browser.
- Browser handlers can read pages, identify elements, capture screenshots,
  interact with controls, create tabs, and navigate.
- Pages can register semantic tools that execute in their own JavaScript context.

What Harbor does not currently provide is a standard MCP endpoint that an
external local agent can connect to. Harbor is an MCP host, but it is not an MCP
server for the browser capabilities it mediates.

That missing direction prevents a coding agent or desktop agent from:

- Sharing the user's current browser tab.
- Discovering semantic tools exposed by the current page.
- Calling a page tool and showing its effect in the user's browser.
- Reading or interacting with a page under Harbor's existing permission model.
- Reusing Harbor-managed MCP tools and credentials without configuring every
  agent separately.

## Product framing

The feature name is **Harbor Agent Gateway**. The component and command name
should be `harbor-agent-gateway`.

The gateway is intentionally agent-neutral:

- It speaks MCP instead of a vendor-specific API.
- It uses client metadata supplied during MCP initialization for display only.
- It does not branch on client brand or model provider.
- Conformance is tested with protocol-level fixtures and multiple independent
  MCP clients.

Recommended description:

> Harbor Agent Gateway connects your chosen local agent to the browser
> capabilities, MCP tools, and page-declared WebMCP tools that you approve.

This extends Harbor's existing "bring your AI" model to "bring your agent"
without changing Harbor into a browser, model provider, or agent product.

## Goals

1. Let any compatible local MCP client connect to Harbor.
2. Let the user and agent share an explicitly selected live browser tab.
3. Expose Harbor-managed MCP tools through a stable, permission-aware facade.
4. Discover and invoke page-declared WebMCP tools in the bound document.
5. Support read, screenshot, interaction, navigation, and tab capabilities
   without granting them implicitly.
6. Preserve Firefox as the primary implementation and test target.
7. Make every request attributable to a paired client, session, tab, document,
   origin, policy decision, and result.
8. Keep page content, tool metadata, and tool output untrusted by default.
9. Reuse Harbor's existing bridge and permission architecture where practical.
10. Keep the proposal separable into reviewable upstream pull requests.

## Non-goals

The first version will not:

- Implement an autonomous browser agent inside Harbor.
- Provide a hosted relay or remote access to the user's browser.
- Expose cookies, authorization headers, model credentials, API keys, or raw
  browser storage to MCP clients.
- Let an MCP client silently attach to whichever tab happens to be active.
- Treat WebMCP annotations or MCP tool annotations as authorization.
- Promise that a page tool behaves as its description claims.
- Bypass existing website authentication, browser protections, or confirmation
  interfaces.
- Replace the page-facing Web Agents API.
- Replace direct MCP server configuration when an agent already has a more
  appropriate direct connection.
- Add a vendor-specific Codex, Claude, Gemini, Copilot, or other agent adapter.
- Enable Streamable HTTP before authentication and Origin validation are
  implemented.

## Standards baseline

This proposal targets:

- MCP protocol revision `2025-11-25` or a compatible negotiated revision.
- MCP stdio as the required initial client transport.
- MCP Streamable HTTP as an optional later transport.
- RFC 9807 OPAQUE for paired-client password-authenticated key exchange.
- The WebMCP Draft Community Group Report dated July 21, 2026.

The current WebMCP draft uses:

```javascript
await document.modelContext.registerTool({
  name: 'get_cart',
  description: 'Return the current cart',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    untrustedContentHint: false,
  },
  execute: async () => getCart(),
});
```

Harbor currently implements an earlier compatibility surface based on
`navigator.modelContext.addTool()`. The gateway must not expose either page API
shape directly. A page-tool adapter must normalize Harbor's current polyfill and
the current WebMCP shape into one internal descriptor.

This lets Harbor migrate its page-facing implementation independently from the
gateway's external MCP contract.

## User experience

### Pairing an agent

The Harbor sidebar gains an **Agent Gateway** section.

The section shows:

- Gateway availability.
- Paired agents by user-assigned name.
- Last connection time.
- Current session count.
- Granted persistent scopes, if any.
- Revoke and rename controls.
- A **Pair agent** action.

Pairing creates a unique client identity and one-time credential. Harbor stores
an RFC 9807 OPAQUE server setup and a per-client OPAQUE registration record in
user-private configuration, not the raw credential. The credential is displayed
once for the MCP client and must not be placed in a process argument, URL query
string, repository file, or log.

OS credential storage is preferred. A fallback file must be readable and
writable only by the current user.

Pairing establishes client identity only. It grants no browser or tool
capability.

### Starting a shared browser session

An MCP client calls `harbor.session.start` with:

- The requested target tab.
- Requested scopes.
- Requested lifetime.
- A user-facing reason.

Harbor displays a prompt containing:

- Paired client name and version.
- Browser profile.
- Target tab title, URL, and origin.
- Requested capabilities.
- Requested session lifetime.
- Whether navigation may cross origins.

The user can approve, deny, reduce the scopes, or shorten the lifetime.

When approved, Harbor shows a persistent indicator while the session is active.
The user can pause or terminate the session at any time.

The target selector supports:

- `user-select`, which opens a Harbor tab picker and is the recommended default.
- `active-tab`, which resolves once when the approval prompt opens.
- `tab-id`, which uses an ID obtained from a previously approved tab listing.

### Sharing a tab

Sessions bind to a tab, not to the browser's continually changing active tab.
Changing focus to another tab does not retarget the agent.

The user or agent must explicitly change the bound tab. A cross-origin change
requires a new policy decision unless the session grant already covers the
destination origin.

### Calling a page tool

The agent:

1. Starts or resumes a tab-bound session.
2. Calls `harbor.webmcp.list_tools`.
3. Selects a tool using its opaque tool ID and catalog revision.
4. Calls `harbor.webmcp.call_tool`.
5. Harbor evaluates policy and requests confirmation when required.
6. The tool executes in the owning page context.
7. The result returns with origin, document, tool, and trust provenance.

The user sees the call in Harbor's activity view and sees any page effect in the
shared browser tab.

## Trust model

The gateway introduces a new principal type:

```text
agent-gateway:<client-id>
```

This principal is distinct from:

- A web origin.
- `harbor-extension`.
- The Web Agents API extension.
- A Harbor-managed MCP server.
- A model provider.

Gateway calls must never impersonate `harbor-extension` or reuse a page origin's
grants. Policy decisions use the paired client principal plus the active gateway
session.

### Trust statements

- A paired client is identified, not fully trusted.
- A local process is not trusted merely because it runs as the same OS user.
- A page is not trusted merely because the user opened it.
- A WebMCP tool description is untrusted content.
- WebMCP and MCP annotations are hints, not grants or verified behavior.
- A tool result cannot authorize another tool call.
- Loopback binding limits exposure but is not authentication.
- Browser extension IDs are routing identifiers, not client authentication.

## Permission model

Gateway permissions are separate from page-origin permissions.

| Scope | Capability |
|---|---|
| `gateway:tabs.read` | List safe tab metadata |
| `gateway:tab.bind` | Bind a session to a selected tab |
| `gateway:page.read` | Read URL, title, readable content, and element metadata |
| `gateway:page.screenshot` | Capture the visible page |
| `gateway:page.interact` | Click, fill, select, and scroll |
| `gateway:page.navigate` | Navigate the bound tab |
| `gateway:tabs.manage` | Create, activate, and close tabs |
| `gateway:mcp.tools.list` | List Harbor-managed MCP tools |
| `gateway:mcp.tools.call` | Call an approved Harbor-managed MCP tool |
| `gateway:webmcp.tools.list` | List page-declared tools |
| `gateway:webmcp.tools.call` | Call a page-declared tool |

Persistent grants should be narrowly scoped by:

- Client ID.
- Browser profile.
- Capability.
- Allowed origins or origin patterns.
- Tool or server allowlist where applicable.
- Maximum session lifetime.
- Expiration time.

### Effect policy

The gateway computes an effect classification independently from tool
annotations:

| Effect | Default policy |
|---|---|
| Read bound page | Session grant |
| Read screenshot | Separate session grant |
| Scroll | Session grant |
| Fill non-sensitive field | Session grant or confirmation |
| Click | Confirmation unless a policy allowlist applies |
| Navigate same origin | Session grant if explicitly requested |
| Navigate cross origin | Confirmation and origin rebind |
| Create or close tab | Confirmation unless explicitly granted |
| Read-only WebMCP tool | Confirmation policy may be relaxed for trusted origins |
| Unknown or mutating WebMCP tool | Confirmation |
| Destructive or externally communicating tool | Confirmation every time by default |

`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and
`untrustedContentHint` can make policy more restrictive. They cannot make an
otherwise unauthorized call permissible.

## Session and target binding

Each approved session contains:

```typescript
interface GatewaySession {
  sessionId: string;
  clientId: string;
  browserInstanceId: string;
  tabId: number;
  documentId: string;
  origin: string;
  scopes: string[];
  allowedOrigins: string[];
  createdAt: string;
  expiresAt: string;
  paused: boolean;
}
```

The browser extension owns the canonical session state.

### Binding rules

1. A session begins with an explicit tab ID selected by the user or client.
2. Every page operation includes the session ID.
3. Every element reference is bound to a document ID and snapshot revision.
4. A full navigation invalidates all previous element references.
5. A cross-origin navigation pauses page access until policy permits the new
   origin.
6. Closing the tab ends the session.
7. Disconnecting the browser marks the session unavailable and fails pending
   operations.
8. Expired sessions cannot be resumed without another policy decision.
9. The default lifetime should be short, with 15 minutes as the initial value.
10. Session renewal is visible and revocable.

## Architecture

### Recommended topology

```text
┌──────────────────────────────────────────────────────────────┐
│ Local MCP client                                            │
│ Coding agent, desktop agent, MCP inspector, or another host │
└──────────────────────────────┬───────────────────────────────┘
                               │ MCP stdio
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ harbor-agent-gateway                                        │
│ MCP facade, auth, schemas, result normalization              │
└──────────────────────────────┬───────────────────────────────┘
                               │ authenticated local IPC
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Browser-connected Harbor native host                         │
│ request routing, session correlation, host_request channel   │
└──────────────────────────────┬───────────────────────────────┘
                               │ native messaging
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Harbor extension                                            │
│ client policy, activity log, confirmation UI                 │
└──────────────────────────────┬───────────────────────────────┘
                               │ extension messaging
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Web Agents API extension                                    │
│ tab binding, page observation, interaction, WebMCP adapter   │
└──────────────────────────────┬───────────────────────────────┘
                               │ isolated-world to page relay
                               ▼
┌──────────────────────────────────────────────────────────────┐
│ Bound page                                                  │
│ DOM, accessibility data, and page-declared WebMCP tools      │
└──────────────────────────────────────────────────────────────┘
```

### Why local IPC is required

The MCP stdio process is launched by the agent client. The native messaging
process is launched by the browser. They are separate processes with different
lifecycles.

The initial implementation should connect them with authenticated local IPC:

- Unix domain sockets on macOS and Linux.
- Named pipes on Windows when Windows support is added.
- One browser instance registry containing opaque instance IDs and socket
  locations.

The IPC endpoint must be user-private, reject unauthenticated clients, apply
message-size limits, and remove stale registrations.

### Streamable HTTP

Streamable HTTP is optional after stdio and local IPC are stable.

If implemented:

- Use `127.0.0.1`, never `0.0.0.0`, by default.
- Use a distinctive Harbor port following the existing 8766 convention. The
  proposed default is 8767.
- Expose one MCP endpoint such as `/mcp`.
- Validate every `Origin` header and return HTTP 403 for invalid origins.
- Require authentication for every connection.
- Bind tokens to the gateway resource and paired client.
- Do not reuse the current permissive Safari RPC CORS policy.
- Remain disabled until explicitly enabled by the user.

Port choice is collision avoidance, not a security control.

### Existing paths to reuse

The implementation should reuse:

- `bridge-rs/src/native_messaging.rs` request correlation.
- The existing bridge-to-extension `host_request` and `host_response` channel.
- Harbor's extension activity and permission systems.
- Web Agents API browser handlers where their principal and target assumptions
  are compatible.
- Existing page observation and element-reference logic.
- Existing MCP server registry and invocation paths.

The gateway must add a dedicated route rather than sending gateway calls through
the current `harbor-extension` sentinel path.

### Paths not suitable as authentication

The implementation must not treat any of these as proof of agent identity:

- `externally_connectable`.
- A browser extension ID.
- A localhost source address.
- The presence of the native messaging manifest.
- An MCP client-supplied display name.

## MCP server contract

The gateway advertises the MCP `tools` capability with `listChanged: true`.

The built-in gateway tools remain deterministic for a given protocol version.
Harbor-managed and WebMCP tool catalogs are returned through explicit catalog
tools in the first version. This avoids injecting arbitrary page-provided tool
descriptions directly into every MCP client's base tool list.

Dynamic projection of trusted tools into `tools/list` may be added later as an
opt-in feature.

### Session tools

#### `harbor.session.start`

Starts a permission-gated browser session.

Input:

```json
{
  "target": {
    "kind": "user-select"
  },
  "requestedScopes": [
    "gateway:page.read",
    "gateway:webmcp.tools.list"
  ],
  "ttlSeconds": 900,
  "reason": "Collaborate on the page currently open"
}
```

Output includes the approved session, resolved target, granted scopes, and
expiration.

#### `harbor.session.status`

Returns the current target, origin, document revision, grants, pending approval,
pause state, and expiration.

#### `harbor.session.end`

Ends the session and invalidates its outstanding references and approvals.

### Tab tools

#### `harbor.tabs.list`

Returns tab ID, window ID, title, URL, active state, and controllability. It must
redact URLs or titles when policy does not permit them.

This tool may run before a browser session only after a one-time
`gateway:tabs.read` approval. Its result does not grant access to any listed tab.

#### `harbor.tabs.bind`

Moves an approved session to another tab through an explicit policy decision.

#### `harbor.tabs.create`

Creates a tab under `gateway:tabs.manage`. The result includes whether the tab
became the session target.

#### `harbor.tabs.close`

Closes an explicitly identified tab. Closing the bound tab ends the session.

### Page tools

#### `harbor.page.observe`

Returns a bounded observation:

```typescript
interface PageObservation {
  sessionId: string;
  tabId: number;
  documentId: string;
  snapshotRevision: string;
  origin: string;
  url: string;
  title: string;
  readableText?: string;
  elements?: Array<{
    ref: string;
    role?: string;
    name?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
  }>;
  truncated: boolean;
}
```

The default result excludes raw HTML, scripts, cookies, local storage, hidden
fields, and password values.

#### `harbor.page.screenshot`

Returns an MCP image content block plus tab, document, viewport, and timestamp
metadata.

#### `harbor.page.interact`

Supports one action per call:

- `click`
- `fill`
- `select`
- `scroll`

Element actions require `documentId`, `snapshotRevision`, and `ref`. Stale
references fail instead of being re-resolved against a different document.

#### `harbor.page.navigate`

Navigates the bound tab after policy evaluation. The result includes old and new
origins, whether the document changed, and whether the session remains active.

### Harbor-managed MCP tools

#### `harbor.mcp.list_tools`

Lists tools from Harbor-managed native, remote, JavaScript, and WASM servers.

Each descriptor includes:

- Opaque tool ID.
- Server ID and display name.
- Tool name, title, description, and schemas.
- MCP annotations.
- Harbor trust state.
- Catalog revision.
- Availability.

#### `harbor.mcp.call_tool`

Requires the session ID, opaque tool ID, catalog revision, arguments, and an
optional idempotency key.

The gateway rechecks:

- Client permission.
- Server availability.
- Tool allowlist.
- Tool catalog revision.
- Input schema.
- Effect policy.
- Confirmation state.

### WebMCP tools

#### `harbor.webmcp.list_tools`

Lists normalized page tools from the bound document and eligible descendants.

Each descriptor includes:

```typescript
interface GatewayWebMcpTool {
  toolId: string;
  name: string;
  title?: string;
  description: string;
  inputSchema: object;
  annotations: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  provenance: {
    origin: string;
    frameId: string;
    documentId: string;
  };
  catalogRevision: string;
}
```

Tool descriptions and schemas are returned as untrusted page content.

#### `harbor.webmcp.call_tool`

Requires:

- Session ID.
- Opaque tool ID.
- Catalog revision.
- Document ID.
- Arguments.
- Optional idempotency key.

The call fails if the page navigated, the tool was unregistered, the schema
changed, the frame disappeared, or the session no longer covers the origin.

The result includes:

- Structured or text content.
- Tool and page provenance.
- Declared annotations.
- Harbor's computed effect class.
- Whether output must be treated as untrusted.
- Page URL and document revision after execution.

### Approval tools

#### `harbor.approvals.status`

Returns the state of an approval receipt when a client cannot keep a tool call
open while the user decides.

An approval receipt is bound to the exact client, session, tool, arguments,
document, origin, effect, and expiration. Changing any bound value invalidates
the receipt.

## WebMCP compatibility layer

The page-tool adapter has one internal interface:

```typescript
interface NormalizedPageTool {
  toolId: string;
  name: string;
  title?: string;
  description: string;
  inputSchema: object;
  annotations: {
    readOnlyHint?: boolean;
    untrustedContentHint?: boolean;
  };
  execute(args: Record<string, unknown>): Promise<unknown>;
}
```

Adapters may source tools from:

1. Current WebMCP `document.modelContext`.
2. Harbor's legacy `navigator.modelContext` polyfill.
3. Declarative WebMCP when supported.

The gateway must not expose duplicate tools when multiple compatibility surfaces
represent the same registration.

Tool registration changes trigger an internal catalog revision update. Clients
discover the new revision on the next list call. A future trusted-tool projection
can also emit MCP `notifications/tools/list_changed`.

## Result provenance and untrusted content

Every page observation, WebMCP result, and browser-derived tool result must carry
provenance outside the content supplied to the model:

```typescript
interface GatewayProvenance {
  source: 'browser' | 'webmcp' | 'harbor-mcp';
  browserInstanceId?: string;
  tabId?: number;
  documentId?: string;
  origin?: string;
  serverId?: string;
  toolId?: string;
  observedAt: string;
  untrusted: boolean;
}
```

The gateway must never concatenate trust labels into page-controlled text and
then rely on the model to preserve them.

WebMCP `untrustedContentHint: true` always marks the result untrusted. A false or
missing hint does not make page output trusted.

## Confirmation protocol

For a call requiring confirmation:

1. Harbor creates an approval receipt.
2. The sidebar shows the client, target, action, arguments, expected effect, and
   origin.
3. The user approves or denies.
4. The pending call resumes when the client supports the wait.
5. Otherwise the gateway returns a structured `CONFIRMATION_REQUIRED` result
   containing the receipt ID.
6. The client polls `harbor.approvals.status` and retries with the approved
   receipt.

Receipts are one-time by default and expire quickly.

The UI must distinguish:

- Reading page content.
- Sending data to a page tool.
- Modifying page state.
- Navigating or changing tabs.
- Calling a tool that communicates with external systems.
- Destructive or difficult-to-reverse effects.

## Error model

Gateway failures use MCP tool execution errors with machine-readable structured
content. Protocol errors are reserved for malformed MCP messages.

Required codes:

| Code | Meaning |
|---|---|
| `GATEWAY_NOT_PAIRED` | Client identity is not paired |
| `BROWSER_DISCONNECTED` | Browser-side Harbor connection is unavailable |
| `SESSION_NOT_FOUND` | Session does not exist |
| `SESSION_EXPIRED` | Session lifetime ended |
| `SESSION_PAUSED` | User paused the session |
| `TAB_GONE` | Bound tab closed |
| `DOCUMENT_CHANGED` | Document or snapshot revision is stale |
| `ORIGIN_CHANGED` | Target moved outside the granted origin |
| `PERMISSION_DENIED` | Required gateway scope is absent |
| `CONFIRMATION_REQUIRED` | User confirmation is pending |
| `CONFIRMATION_DENIED` | User denied the action |
| `TOOL_GONE` | MCP or WebMCP tool is no longer registered |
| `TOOL_SCHEMA_CHANGED` | Catalog revision or schema changed |
| `TOOL_CALL_FAILED` | Tool execution failed |
| `UNSUPPORTED_PAGE` | Browser restrictions prevent page access |
| `RATE_LIMITED` | Client or session budget was exceeded |
| `OUTPUT_TOO_LARGE` | Result exceeded configured limits |

Errors include `retryable`, `sessionId`, and relevant current revision fields
when safe.

## Security requirements

### Local client impersonation

Risk: another local process connects to the gateway.

Requirements:

- Authenticate every IPC and HTTP connection.
- Use per-client secrets with rotation and revocation.
- Restrict IPC filesystem permissions to the current user.
- Never accept the OS username as sufficient identity.
- Rate limit authentication attempts.
- Avoid secrets in process arguments and logs.

### DNS rebinding and browser-origin attacks

Risk: a malicious website accesses a loopback MCP endpoint.

Requirements for Streamable HTTP:

- Validate `Origin`.
- Reject unknown origins with HTTP 403.
- Bind only to loopback by default.
- Require authentication.
- Disable permissive CORS.
- Test DNS rebinding and cross-site request scenarios.

### Tab confusion

Risk: the user changes tabs and the agent acts on the wrong page.

Requirements:

- Bind sessions to tab and document IDs.
- Never infer a new target from focus changes.
- Show the bound tab in Harbor.
- Invalidate stale element references.
- Pause on unapproved origin changes.

### Prompt injection

Risk: page content, tool descriptions, schemas, or results manipulate the agent.

Requirements:

- Mark browser and WebMCP content untrusted.
- Keep provenance outside page-controlled content.
- Do not auto-project page tools into the base MCP tool list in the first
  version.
- Limit output size and nesting.
- Require confirmation based on computed effects.
- Never treat tool output as a permission grant.
- Keep unrelated client context out of page tool arguments.

### Tool misrepresentation

Risk: a tool mutates state despite claiming to be read-only.

Requirements:

- Treat annotations as hints.
- Default unknown WebMCP calls to mutating and open-world.
- Let the user override trust for a specific origin and tool.
- Record before and after URL and document state.
- Keep an activity receipt for every call.

### Secret exposure

Risk: the gateway exposes credentials or sensitive browser state.

Requirements:

- Do not expose cookies, headers, extension storage, provider keys, or tokens.
- Redact password and hidden field values.
- Reject attempts to read browser-internal and extension pages unless an
  explicit future design permits them.
- Do not log page bodies or screenshots by default.
- Apply result-size and screenshot-size limits.

### Resource exhaustion

Requirements:

- Bound concurrent calls per client and session.
- Apply timeouts and cancellation.
- Bound text, schema, image, and structured result sizes.
- Reject excessive tool counts and schema depth.
- Clean up calls when a tab, document, session, or client disappears.

## Activity and observability

Every gateway action writes an operator-readable activity record containing:

- Timestamp and duration.
- Client ID and display name.
- Session ID.
- Browser instance and tab ID.
- Origin and document ID.
- Capability and tool identity.
- Redacted argument summary.
- Declared annotations.
- Computed effect class.
- Policy decision and confirmation receipt.
- Outcome and error code.
- Before and after URL when navigation occurred.

Page bodies, screenshots, credentials, and full sensitive arguments are excluded
by default.

The Harbor sidebar provides:

- Connected-client indicator.
- Active-session indicator.
- Pause and terminate controls.
- Pending confirmation queue.
- Recent activity.
- Grant inspection and revocation.

## Browser support

### Firefox

Firefox is the primary implementation and acceptance target.

The first complete vertical slice must work with both Harbor Firefox extensions
loaded and the Rust bridge installed. Firefox-specific native messaging and
extension lifecycle behavior must be tested before Chrome parity is claimed.

### Chrome

Chrome is the secondary target. The gateway must preserve the installed Harbor
extension identity and must not depend on wildcard `externally_connectable`
access for authentication.

### Safari

Safari is a later target. Its existing HTTP bridge can inform the design, but its
current permissive RPC and CORS behavior is not suitable for the gateway
endpoint without the security work specified above.

## Configuration

Proposed configuration:

```json
{
  "agent_gateway": {
    "enabled": false,
    "stdio": true,
    "streamable_http": {
      "enabled": false,
      "host": "127.0.0.1",
      "port": 8767
    },
    "default_session_ttl_seconds": 900,
    "max_session_ttl_seconds": 3600,
    "max_concurrent_calls_per_session": 4,
    "max_text_result_bytes": 1048576,
    "max_image_result_bytes": 5242880
  }
}
```

The default is disabled until the user enables and pairs a client.

## Delivery phases

### Phase 0: Contract and threat model

- Finalize MCP tool names and schemas.
- Add shared gateway protocol types.
- Add fixtures for paired client, session, tab, and WebMCP catalogs.
- Document principal separation and threat cases.
- Add a demo page with read-only and mutating WebMCP tools.

### Phase 1: Read-only Firefox vertical slice

- Implement MCP stdio facade.
- Implement authenticated local IPC.
- Register one browser instance.
- Add pairing and revocation UI.
- Add session start, status, and end.
- Add tab list and bind.
- Add page observation.
- Add WebMCP tool listing.
- Add activity records.

### Phase 2: Page tool execution

- Add WebMCP call routing into the bound page.
- Add catalog and document revision enforcement.
- Add confirmation receipts.
- Add structured result provenance.
- Add output limits and cancellation.

### Phase 3: Browser interaction

- Add screenshots.
- Add click, fill, select, and scroll.
- Add navigation and tab management.
- Add stale-reference and cross-origin enforcement.
- Add visible active-session indicator.

### Phase 4: Harbor MCP aggregation

- Add Harbor-managed MCP catalog listing.
- Add Harbor-managed tool calls.
- Add server and tool allowlists.
- Add idempotency keys and effect policy.

### Phase 5: Additional clients and transports

- Validate multiple unrelated MCP clients.
- Add Chrome parity.
- Add multi-profile browser instance selection.
- Add authenticated Streamable HTTP.
- Add optional trusted-tool projection with `tools/list_changed`.
- Evaluate Safari support.

## Upstream pull request strategy

The feature should be reviewable as a series instead of one architectural
rewrite:

1. **Protocol types and security model**
   - No behavior changes.
   - Gateway principal, sessions, schemas, and error types.

2. **Native IPC and MCP stdio facade**
   - Read-only health and browser-instance discovery.
   - Authentication and lifecycle tests.

3. **Sidebar pairing and session UI**
   - Pair, revoke, approve, pause, and terminate.

4. **Read-only browser observation**
   - Firefox vertical slice with strict tab binding.

5. **WebMCP adapter and listing**
   - Current WebMCP compatibility plus Harbor legacy adapter.

6. **WebMCP execution and confirmations**
   - Document revision, provenance, and untrusted-output handling.

7. **Browser interaction**
   - Screenshots, elements, interaction, navigation, and cross-origin policy.

8. **Harbor MCP aggregation**
   - Existing Harbor-managed tool listing and invocation.

9. **Optional Streamable HTTP**
   - Only after authentication, Origin validation, and rebinding tests pass.

Each pull request must preserve existing page-facing APIs and keep the gateway
disabled by default.

## Testing strategy

### Unit tests

- Client authentication and revocation.
- Session expiry, pause, and renewal.
- Scope reduction.
- Origin matching.
- Document and snapshot revision invalidation.
- Tool catalog revision invalidation.
- Schema validation.
- Effect classification.
- Approval receipt binding and expiry.
- Result-size and concurrency limits.
- Provenance serialization.

### Integration tests

- MCP stdio initialization and deterministic `tools/list`.
- Browser instance registration over local IPC.
- Native host request and response correlation.
- Browser disconnect during a call.
- User denial and timeout.
- WebMCP tool registration, removal, and schema change.
- Harbor MCP server unavailable during a call.
- Cancellation propagation.

### Browser end-to-end tests

Firefox tests load both extensions and verify:

1. An MCP client pairs with Harbor.
2. The client requests a read-only session.
3. The user approves the selected tab.
4. The client reads the page.
5. The client lists a page-declared read-only tool.
6. The client calls the tool and receives provenance.
7. A mutating tool requires confirmation.
8. Navigation invalidates old element and tool references.
9. A cross-origin navigation pauses the session.
10. Revoking the client terminates access immediately.

Chrome repeats the vertical slice after Firefox passes.

### Security tests

- Unauthenticated local process.
- Replayed pairing secret.
- Malicious `Origin` header.
- DNS rebinding against Streamable HTTP.
- Malicious tool description.
- Prompt injection in tool output.
- Tool claiming read-only while changing location.
- Oversized schema and result.
- Excessive tool count.
- Stale tab, document, element, tool, and approval identifiers.
- Attempted cookie, password, header, and extension-page access.
- Client attempts to impersonate a page origin or `harbor-extension`.

## Acceptance criteria

The first feature-complete release is accepted when:

1. A generic MCP client can connect over stdio without vendor-specific code.
2. Harbor displays the paired client and can revoke it.
3. The user can approve a Firefox tab-bound session with reduced scopes.
4. The client can read the bound page but cannot silently follow focus to
   another tab.
5. The client can list and call a WebMCP tool in the bound document.
6. The WebMCP result includes origin and document provenance.
7. Mutating or unknown page tools require confirmation by default.
8. The client can take a screenshot and perform approved element interactions.
9. Navigation invalidates stale references and rechecks origin policy.
10. The client can list and call an allowlisted Harbor-managed MCP tool.
11. No gateway API exposes cookies, credentials, or browser storage.
12. Every action appears in Harbor's activity view.
13. Revocation blocks new calls and cancels pending calls.
14. Firefox end-to-end tests pass before Chrome parity is claimed.
15. Streamable HTTP, if enabled, passes authentication, Origin, and DNS
    rebinding tests.
16. Existing Harbor and Web Agents API behavior remains compatible.

## Open questions

1. Should the first implementation run the MCP facade as a new binary or as a
   mode of `harbor-bridge`?
2. Should multiple browser profiles use one local broker or separate sockets
   selected by a discovery registry?
3. When should trusted Harbor MCP tools be projected directly into MCP
   `tools/list`?
4. Should trusted WebMCP tools ever be projected directly, or should page tools
   always remain behind the explicit catalog and call facade?
5. How should Harbor migrate from `navigator.modelContext.addTool()` to current
   `document.modelContext.registerTool()` while preserving compatibility?
6. Which browser-generated document identifier is stable enough across Firefox
   and Chrome?
7. Should screenshots and element observations share one coordinate-space
   revision before screenshot-driven interaction ships?
8. Which interactions can safely receive session-level approval instead of
   per-call confirmation?
9. How should long-running WebMCP calls map to MCP tasks when client support is
   widespread enough?
10. Should the gateway expose MCP resources for page observations, or keep all
    observations tool-based in the first version?

## Alternatives considered

### Connect agents directly through extension messaging

Rejected as the primary design. Native desktop agents are not browser
extensions, extension IDs are not authentication, and Firefox and Chrome expose
different cross-extension behavior.

### Expose the current Safari RPC endpoint as MCP

Rejected without substantial changes. The endpoint is not MCP Streamable HTTP,
uses permissive CORS, lacks paired-client authentication, and does not provide
the required browser session principal.

### Let agents connect directly to each Harbor-managed MCP server

Useful in some cases, but incomplete. It duplicates configuration and
credentials, omits WebMCP page tools, and cannot share Harbor's browser session
or permission boundary.

### Project every page tool directly into `tools/list`

Deferred. It creates tool-list churn on navigation, naming collisions, stale
tool definitions, and automatic exposure of malicious page-provided
descriptions. The explicit catalog and call tools provide a safer first
boundary.

### Use browser remote debugging

Rejected as the Harbor architecture. It bypasses Harbor's permission model,
does not expose WebMCP semantics cleanly, may target the wrong browser profile,
and changes the threat model from scoped browser capability to broad debugging
authority.

## References

- [Harbor positioning](../POSITIONING.md)
- [Harbor architecture](../../ARCHITECTURE.md)
- [Agentic browser roadmap](../AGENTIC_BROWSER_ROADMAP.md)
- [Web Agents API reference](../WEB_AGENTS_API.md)
- [WebMCP Draft Community Group Report](https://webmachinelearning.github.io/webmcp/)
- [MCP architecture](https://modelcontextprotocol.io/docs/learn/architecture)
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP security best practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)
