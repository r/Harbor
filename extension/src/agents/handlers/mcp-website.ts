/**
 * Website MCP Server Registration handlers.
 *
 * `register` connects to the site's declared MCP server and offers its
 * real tools to the person's agent for the registering origin/tab only —
 * see `mcp/site-servers.ts` for the registry and `extension-api.ts`'s
 * `handleMcpListTools`/`handleMcpCallTool` for where those tools surface.
 */

import type { RequestContext, ResponseSender } from './router-types';
import { log, requireAction } from './helpers';
import { browserAPI } from '../../browser-compat';
import { isSiteMcpTransport, registerSiteServer, unregisterSiteServer } from '../../mcp/site-servers';
import { Audit } from '../../policy/audit';
import { LabelSet, type PolicyDecision } from '../../policy/engine';

// =============================================================================
// Auditing the D1 refusal (it never reaches requireAction/the engine)
// =============================================================================

/**
 * D1's same-origin/loopback rule runs before `mcp.server.register`'s own
 * gate — so the person is never asked to allow a registration that was
 * always going to be refused — which means it never reaches
 * `requireAction`/`evaluate()`, the normal path every other gated
 * decision is audited through. It should still land in the audit log
 * (the activity feed and the watchdog both read from there), so this
 * records it by hand, matching `evaluate()`'s own `PolicyDecision` shape
 * (see `policy/engine.ts`) as closely as a decision that never ran
 * through the engine can: `source: 'safetyFloor'` (declared in
 * `DecisionSource` but not assigned by any real tier today) is the
 * closest honest label for "Harbor's own floor, not a rule, a grant or
 * the watchdog". Input errors (missing fields, an unrecognized
 * transport, a malformed URL) aren't audited — they're not a policy
 * decision about an origin, just invalid input.
 */
function auditOriginRuleDenial(ctx: RequestContext, reason: string): void {
  const decision: PolicyDecision = {
    effect: 'deny',
    // Tier 0 is the engine's hard floor, which this is: no rule or grant
    // can allow a cross-origin (or public-to-loopback) registration.
    tier: 0,
    source: 'safetyFloor',
    reason,
    outputLabels: LabelSet.empty(),
    trace: [{ tier: 0, source: 'safetyFloor', outcome: 'deny', reason }],
  };
  Audit.record(
    { origin: ctx.origin, action: 'mcp.server.register', correlationId: ctx.id, tabId: ctx.tabId },
    decision,
  );
}

// =============================================================================
// D1: same-origin (or matching-loopback) registration rule
// =============================================================================

/** Loopback hostnames, in every form a URL's own `.hostname` can take them. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname);
}

/** A server URL's origin, with its scheme mapped for comparison: ws(s) counts as http(s). */
function effectiveServerOrigin(url: URL): string {
  if (url.protocol === 'ws:') return `http://${url.host}`;
  if (url.protocol === 'wss:') return `https://${url.host}`;
  return url.origin;
}

/**
 * Whether a page at `pageOrigin` may register `serverUrl` — a maintainer
 * decision (HBR-134, D1): same-origin only, except a loopback server
 * (localhost/127.0.0.1/::1), which is allowed only when the *page itself*
 * is also loopback (so an ordinary site can't point Harbor at "localhost"
 * and reach whatever's listening on the person's own machine). A
 * same-origin `ws(s)://` URL for `transport: 'websocket'` counts as
 * same-origin via the scheme mapping above.
 */
function isAllowedServerUrl(pageOrigin: URL, serverUrl: URL): boolean {
  if (isLoopbackHost(serverUrl.hostname)) {
    return isLoopbackHost(pageOrigin.hostname);
  }
  return effectiveServerOrigin(serverUrl) === pageOrigin.origin;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * Handle agent.mcp.discover - find MCP servers declared on the current page.
 */
export async function handleMcpDiscover(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const { tabId } = ctx;

  if (!tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab context for discovery' },
    });
    return;
  }

  try {
    // Find the page's <link rel="mcp-server"> and <link rel="mcp">
    // elements. ~= matches one token of a rel list, so
    // rel="alternate mcp-server" counts too; the browser returns each
    // element once even when it carries both tokens.
    const results = await browserAPI.scripting.executeScript({
      target: { tabId },
      func: () => {
        const links = document.querySelectorAll('link[rel~="mcp-server"], link[rel~="mcp"]');
        return Array.from(links).map((link) => ({
          // Resolved against the document (HTMLLinkElement.href), so a
          // relative href reaches agent.mcp.register as the absolute URL it
          // needs. An absent or empty href stays '' rather than becoming
          // the page's own URL.
          url: link.getAttribute('href') ? (link as HTMLLinkElement).href : '',
          name: link.getAttribute('title') || undefined,
          description: link.getAttribute('data-description') || undefined,
          tools: link.getAttribute('data-tools')?.split(',').map(t => t.trim()) || undefined,
          // Streamable HTTP is MCP's current transport; a site can still name sse or websocket.
          transport: link.getAttribute('data-transport') || 'streamable-http',
        }));
      },
    });

    const servers = results?.[0]?.result || [];
    log('MCP discover found servers:', servers.length);

    sender.sendResponse({
      id: ctx.id,
      ok: true,
      result: { servers },
    });
  } catch (err) {
    log('MCP discover error:', err);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: err instanceof Error ? err.message : 'Discovery failed' },
    });
  }
}

/**
 * Handle agent.mcp.register - register a website's MCP server.
 *
 * Every check that can fail on its own (missing fields, no tab context,
 * an unrecognized transport, the same-origin/loopback rule) runs *before*
 * `mcp.server.register`'s own gate, so the person is never asked to allow
 * a registration that was always going to be refused. The policy gate
 * itself still runs before any network connection: only once it's
 * granted does this run the MCP handshake over the requested transport
 * (`mcp/site-servers.ts`).
 */
export async function handleMcpRegister(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const { url, name, description, transport: rawTransport } = ctx.payload as {
    url: string;
    name: string;
    description?: string;
    tools?: string[];
    transport?: unknown;
  };

  if (!url || !name) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'Missing url or name' },
    });
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab context for registration' },
    });
    return;
  }

  // H2: an omitted transport defaults to sse.
  const transport = rawTransport ?? 'sse';

  if (transport === 'stdio') {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'stdio is not supported for a site-registered MCP server' },
    });
    return;
  }
  if (!isSiteMcpTransport(transport)) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: `Unknown MCP transport: ${String(transport)}` },
    });
    return;
  }

  let serverUrl: URL;
  let pageOriginUrl: URL;
  try {
    serverUrl = new URL(url);
    pageOriginUrl = new URL(ctx.origin);
  } catch {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'Invalid MCP server URL' },
    });
    return;
  }

  // D1: same-origin only, except a loopback server registered from a
  // loopback page.
  if (!isAllowedServerUrl(pageOriginUrl, serverUrl)) {
    log('MCP register rejected - server URL not allowed from', ctx.origin);
    const message = 'MCP server must be on the same origin, or localhost/127.0.0.1/::1 registered from a page on the same';
    auditOriginRuleDenial(ctx, message);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_PERMISSION_DENIED', message },
    });
    return;
  }

  // The policy gate: only now does this ask the person, and only once
  // granted does anything below reach the network.
  if (!(await requireAction(ctx, sender, 'mcp.server.register', { promptAsScope: 'mcp:servers.register' }))) {
    return;
  }

  const result = await registerSiteServer({
    origin: ctx.origin,
    tabId: ctx.tabId,
    url,
    name,
    description,
    transport,
    signal: ctx.signal,
  });

  if (!result.ok) {
    log('MCP server registration failed:', result.error);
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: result.aborted ? 'ERR_ABORTED' : 'ERR_INTERNAL', message: result.error },
    });
    return;
  }

  log('MCP server registered:', result.serverId, 'tools:', result.tools);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: {
      success: true,
      serverId: result.serverId,
      tools: result.tools,
    },
  });
}

/**
 * Handle agent.mcp.unregister - unregister a website's MCP server.
 */
export async function handleMcpUnregister(
  ctx: RequestContext,
  sender: ResponseSender,
): Promise<void> {
  const { serverId } = ctx.payload as { serverId: string };

  if (!serverId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'Missing serverId' },
    });
    return;
  }

  if (!ctx.tabId) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: { code: 'ERR_INTERNAL', message: 'No tab context for unregistration' },
    });
    return;
  }

  const result = await unregisterSiteServer(ctx.origin, ctx.tabId, serverId);
  if (!result.ok) {
    sender.sendResponse({
      id: ctx.id,
      ok: false,
      error: {
        code: result.error === 'MCP server not found' ? 'ERR_INTERNAL' : 'ERR_PERMISSION_DENIED',
        message: result.error,
      },
    });
    return;
  }

  log('MCP server unregistered:', serverId);

  sender.sendResponse({
    id: ctx.id,
    ok: true,
    result: { success: true },
  });
}
