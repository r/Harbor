/**
 * Harbor Page API - Content Script
 *
 * Bridges messages between:
 * - Injected script (web page context)
 * - Background script (extension context)
 *
 * Runs in-process with the background now (both are Harbor), but the
 * transport is unchanged: everything still goes through postMessage to the
 * page and a runtime.Port to the background, so the page-facing contract
 * doesn't move.
 */

import type {
  TransportRequest,
  TransportResponse,
  TransportStreamEvent,
} from './types';
import { DEFAULT_FLAGS, STORAGE_KEY, type FeatureFlags } from './policy/feature-flag-set';

const CHANNEL = 'harbor_page_api';

type PageToolPortMessage =
  | { type: 'page_tools.call'; callId: string; name: string; input: unknown }
  | { type: 'page_tools.cancel'; callId: string };

type RuntimePort = chrome.runtime.Port;

let backgroundPort: RuntimePort | null = null;

// Track pending requests and active streams
const pendingRequests = new Map<string, {
  sendResponse: (response: TransportResponse) => void;
}>();

const activeStreams = new Map<string, {
  sendEvent: (event: TransportStreamEvent) => void;
}>();

// Track if agent event forwarding is set up
let agentEventForwardingSetup = false;

/**
 * Get or create connection to background script.
 */
function getBackgroundPort(): RuntimePort {
  if (!backgroundPort || !backgroundPort.name) {
    backgroundPort = chrome.runtime.connect({ name: 'harbor-page-api' });

    // Handle messages from background
    backgroundPort.onMessage.addListener((message: TransportResponse | TransportStreamEvent | PageToolPortMessage) => {
      // The person's agent calling one of the page's own tools
      // (document.modelContext), or giving up on a call.
      if ('type' in message && message.type === 'page_tools.call') {
        window.postMessage({
          channel: CHANNEL,
          pageToolCall: { callId: message.callId, name: message.name, input: message.input },
        }, '*');
        return;
      }
      if ('type' in message && message.type === 'page_tools.cancel') {
        window.postMessage({ channel: CHANNEL, pageToolCancel: { callId: message.callId } }, '*');
        return;
      }
      if ('ok' in message) {
        // Regular response
        if (!message.ok && message.error) {
          console.warn('[Web Agents API:ContentScript] Response failed:', message.id, message.error);
        } else {
          console.log('[Web Agents API:ContentScript] Regular response:', message.id, 'ok:', message.ok);
        }
        const pending = pendingRequests.get(message.id);
        if (pending) {
          pendingRequests.delete(message.id);
          pending.sendResponse(message);
        }
      } else if ('event' in message) {
        // Stream event
        const eventType = (message.event as { type?: string })?.type;
        if (eventType !== 'token') {
          console.log('[Web Agents API:ContentScript] Stream event:', message.id, 'type:', eventType, 'done:', message.done);
        }
        const stream = activeStreams.get(message.id);
        if (stream) {
          stream.sendEvent(message);
          if (message.done) {
            console.log('[Web Agents API:ContentScript] Stream complete, removing:', message.id);
            activeStreams.delete(message.id);
          }
        } else {
          console.log('[Web Agents API:ContentScript] No active stream found for:', message.id, 'activeStreams:', Array.from(activeStreams.keys()));
        }
      }
    });

    backgroundPort.onDisconnect.addListener(() => {
      backgroundPort = null;
      failInFlight('Background connection lost');
    });
  }

  return backgroundPort;
}

/** Fail every request and stream still waiting on the port, which has closed. */
function failInFlight(message: string): void {
  for (const [id, pending] of pendingRequests) {
    pending.sendResponse({ id, ok: false, error: { code: 'ERR_INTERNAL', message } });
  }
  pendingRequests.clear();
  for (const [id, stream] of activeStreams) {
    stream.sendEvent({ id, event: { type: 'error', error: { code: 'ERR_INTERNAL', message } }, done: true });
  }
  activeStreams.clear();
}

// A page going into the back/forward cache has left the tab, as far as
// Harbor is concerned, even though Firefox may keep its port open. Closing
// the port here tells Harbor now: it forgets the page's agents, fails
// invocations waiting on it, and counts the next page as the tab's own.
// It also lets Firefox keep the page in the cache at all: with the port
// open, Back reloaded the page. (A port closed from this side gets no
// onDisconnect, so in-flight calls are failed here.)
// Harbor is told why first, so it keeps the page's sessions on the
// person's own agent for when the page comes back.
let portClosedForCache = false;
// Names this document to Harbor across the cache, so the page that comes
// back gets its own sessions and no other page's. Kept in this isolated
// world, out of the page's reach.
const documentToken = crypto.randomUUID();
window.addEventListener('pagehide', (event: PageTransitionEvent) => {
  if (!event.persisted || !backgroundPort) return;
  try { backgroundPort.postMessage({ type: 'page_hidden', token: documentToken }); } catch { /* already closed */ }
  backgroundPort.disconnect();
  backgroundPort = null;
  portClosedForCache = true;
  failInFlight('The page was hidden');
});

// Back from the cache: a new port at once, so Harbor counts this page as
// the tab's own again and keeps its sessions, and the page script registers
// its agents, subscriptions, page tools and MCP servers again.
window.addEventListener('pageshow', (event: PageTransitionEvent) => {
  if (!event.persisted) return;
  if (portClosedForCache) {
    portClosedForCache = false;
    getBackgroundPort().postMessage({ type: 'page_shown', token: documentToken });
  }
  window.postMessage({ channel: CHANNEL, pageRestored: true }, '*');
});

/**
 * Fetch feature flags from background script.
 */
async function getFeatureFlags(): Promise<FeatureFlags> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getFeatureFlags' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        // Use the default capabilities if we can't get flags
        resolve(DEFAULT_FLAGS);
      } else {
        resolve(response as FeatureFlags);
      }
    });
  });
}

let injected = false;

function appendInjectedScripts(flags: FeatureFlags): boolean {
  if (injected) return true;
  const root = document.head || document.documentElement;
  if (!root) return false;

  // First, inject the feature flags as a JSON element
  const flagsScript = document.createElement('script');
  flagsScript.type = 'application/json';
  flagsScript.id = 'harbor-page-api-flags';
  flagsScript.textContent = JSON.stringify(flags);
  root.appendChild(flagsScript);

  // Then inject the main script
  const script = document.createElement('script');
  // Harbor's build keeps page-api/ as a subdirectory under dist/, unlike
  // the old extension's flat dist/injected.js.
  script.src = chrome.runtime.getURL('page-api/injected.js');
  script.async = false;
  script.onload = () => {
    script.remove();
  };
  script.onerror = () => {
    script.remove();
  };
  root.appendChild(script);
  injected = true;
  return true;
}

/**
 * Inject the Web Agents API script into the page with feature flags.
 */
async function injectAgentsAPI(): Promise<void> {
  // Mark content script presence for debugging.
  document.documentElement?.setAttribute('data-harbor-page-api-content-script', 'true');

  // Get feature flags from background
  const flags = await getFeatureFlags();

  if (appendInjectedScripts(flags)) return;

  const retry = () => {
    if (appendInjectedScripts(flags)) {
      document.removeEventListener('readystatechange', retry);
      window.removeEventListener('DOMContentLoaded', retry);
    }
  };

  document.addEventListener('readystatechange', retry);
  window.addEventListener('DOMContentLoaded', retry);
}

/** Update the flags JSON element in the page so the injected script sees new flags without refresh. */
async function updatePageFlags(): Promise<void> {
  const flags = await getFeatureFlags();
  const el = document.getElementById('harbor-page-api-flags');
  if (el) {
    el.textContent = JSON.stringify(flags);
  }
}

// When user toggles flags in the sidebar, update the page so the injected API sees them without refresh.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[STORAGE_KEY]) {
    updatePageFlags();
  }
});

/**
 * Listen for messages from the page.
 */
window.addEventListener('message', async (event: MessageEvent) => {
  if (event.source !== window) return;

  const data = event.data as {
    channel?: string;
    request?: TransportRequest;
    abort?: { id: string };
  };

  if (data?.channel !== CHANNEL) return;

  // Handle abort signal
  if (data.abort) {
    const port = getBackgroundPort();
    port.postMessage({ type: 'abort', id: data.abort.id });
    activeStreams.delete(data.abort.id);
    return;
  }

  if (!data.request) return;

  const request = data.request;
  // Only this script says a page is going into or back from the cache.
  const requestType: string = request.type;
  if (requestType === 'page_hidden' || requestType === 'page_shown') {
    window.postMessage({
      channel: CHANNEL,
      response: { id: request.id, ok: false, error: { code: 'ERR_INVALID_REQUEST', message: 'Unknown request type' } },
    }, '*');
    return;
  }
  const isStreamingRequest = request.type === 'session.promptStreaming' || request.type === 'agent.run';

  const port = getBackgroundPort();

  if (isStreamingRequest) {
    // Set up stream forwarding
    console.log('[Web Agents API:ContentScript] Setting up stream forwarding for:', request.id, 'type:', request.type);
    activeStreams.set(request.id, {
      sendEvent: (streamEvent) => {
        window.postMessage({ channel: CHANNEL, streamEvent }, '*');
      },
    });
  } else {
    // Set up response forwarding
    pendingRequests.set(request.id, {
      sendResponse: (response) => {
        window.postMessage({ channel: CHANNEL, response }, '*');
      },
    });
  }

  // Forward to background with origin
  port.postMessage({
    ...request,
    origin: window.location.origin,
  });
});

/**
 * Set up forwarding of agent events from background to the page.
 * This enables the multi-agent messaging system.
 */
function setupAgentEventForwarding() {
  if (agentEventForwardingSetup) return;
  agentEventForwardingSetup = true;

  // Listen for agent events from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'agentEvent') {
      // Forward to the page
      window.postMessage({
        channel: CHANNEL,
        agentEvent: message.event,
      }, '*');
    }
    return false;
  });
}

// The page's answer to a page-tool call goes back on the page port, which
// is the only connection the background accepts it from. Only the answer's
// own fields are forwarded.
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;
  const data = event.data as {
    channel?: string;
    pageToolResult?: { callId?: unknown; ok?: unknown; result?: unknown; error?: { message?: unknown } };
  };
  if (data?.channel !== CHANNEL || !data.pageToolResult) return;
  const { callId, ok, result, error } = data.pageToolResult;
  if (typeof callId !== 'string') return;
  getBackgroundPort().postMessage(ok === true
    ? { type: 'page_tools.result', callId, ok: true, result }
    : { type: 'page_tools.result', callId, ok: false, error: { message: typeof error?.message === 'string' ? error.message : 'Page tool failed' } });
});

// Listen for agent invocation responses from the page
window.addEventListener('message', (event: MessageEvent) => {
  if (event.source !== window) return;

  const data = event.data as {
    channel?: string;
    agentInvocationResponse?: {
      invocationId: string;
      success: boolean;
      result?: unknown;
      error?: { code: string; message: string };
    };
  };

  if (data?.channel !== CHANNEL || !data.agentInvocationResponse) return;

  // Forward to background
  chrome.runtime.sendMessage({
    type: 'agentInvocationResponse',
    response: data.agentInvocationResponse,
  });
});

// Track processed invocations to prevent duplicates
const processedInvocations = new Set<string>();

// Listen for invocation requests from background and forward to page
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // The caller stopped waiting: the page's handler is told through its
  // request's signal.
  if (message?.type === 'agentInvocationCancel' && typeof message.invocationId === 'string') {
    window.postMessage({
      channel: CHANNEL,
      agentEvent: { type: 'invocationCancel', invocationId: message.invocationId },
    }, '*');
    return false;
  }
  if (message?.type !== 'agentInvocation') {
    return false;
  }
  
  const trace = message.traceId || 'no-trace';
  
  // Deduplicate - only process each invocation once
  const invocationId = message.invocationId;
  if (processedInvocations.has(invocationId)) {
    console.log(`[TRACE ${trace}] Content: DUPLICATE invocation, skipping: ${invocationId}`);
    sendResponse({ ok: true, duplicate: true });
    return true;
  }
  processedInvocations.add(invocationId);
  
  // Clean up old invocations after 60 seconds
  setTimeout(() => processedInvocations.delete(invocationId), 60000);
  
  // Post into the page only if it's on the agent's site. Harbor checks the
  // tab before sending, but a navigation can commit between that check and
  // this delivery; here, in the isolated world, the check reads the document
  // the invocation actually reached, so another site never sees the task.
  if (!message.agentOrigin || message.agentOrigin !== window.location.origin) {
    console.log(`[TRACE ${trace}] Content: invocation for another site's agent, refusing: ${invocationId}`);
    chrome.runtime.sendMessage({
      type: 'agentInvocationResponse',
      response: {
        invocationId,
        success: false,
        error: { code: 'ERR_AGENT_NOT_FOUND', message: "The agent's page is gone" },
      },
    });
    sendResponse({ ok: true });
    return true;
  }

  console.log(`[TRACE ${trace}] Content: Forwarding invocation to page - invocationId: ${invocationId}`);
  
  // Forward to page in the format injected.ts expects
  window.postMessage({
    channel: CHANNEL,
    agentEvent: {
      type: 'invocation',
      invocation: {
        invocationId: message.invocationId,
        agentId: message.agentId,
        from: message.from,
        task: message.task,
        input: message.input,
      },
    },
  }, '*');
  
  sendResponse({ ok: true });
  return true;
});

// Note: there is no listener here for `harbor.forwardInvocation`. That type
// is sent background-to-background (runtime.sendMessage(extensionId, ...)
// from agents/handlers/multi-agent.ts to a *separate* extension's
// background), never to a content script — the receiving background turns
// it into the `agentInvocation` message the listener above handles. A
// content-script listener for it was dead code even before Harbor folded
// the page API in (the original Web Agents API's content-script.ts never
// received it either), so it's removed here rather than carried forward.

// Initialize
injectAgentsAPI().catch(console.error);
setupAgentEventForwarding();