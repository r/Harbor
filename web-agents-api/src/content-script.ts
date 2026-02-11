/**
 * Web Agents API - Content Script
 *
 * Bridges messages between:
 * - Injected script (web page context)
 * - Background script (extension context)
 */

import type {
  TransportRequest,
  TransportResponse,
  TransportStreamEvent,
} from './types';

const CHANNEL = 'web_agents_api';

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
    backgroundPort = chrome.runtime.connect({ name: 'web-agent-transport' });

    // Handle messages from background
    backgroundPort.onMessage.addListener((message: TransportResponse | TransportStreamEvent) => {
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
      // Reject all pending requests
      for (const [id, pending] of pendingRequests) {
        pending.sendResponse({
          id,
          ok: false,
          error: { code: 'ERR_INTERNAL', message: 'Background connection lost' },
        });
      }
      pendingRequests.clear();
      
      // End all active streams
      for (const [id, stream] of activeStreams) {
        stream.sendEvent({
          id,
          event: { type: 'error', error: { code: 'ERR_INTERNAL', message: 'Background connection lost' } },
          done: true,
        });
      }
      activeStreams.clear();
    });
  }

  return backgroundPort;
}

// Feature flags type
interface FeatureFlags {
  textGeneration: boolean;
  toolCalling: boolean;
  toolAccess: boolean;
  browserInteraction: boolean;
  browserControl: boolean;
  multiAgent: boolean;
}

const DEFAULT_FLAGS: FeatureFlags = {
  textGeneration: true,
  toolCalling: false,
  toolAccess: true,
  browserInteraction: false,
  browserControl: false,
  multiAgent: false,
};

/**
 * Fetch feature flags from background script.
 */
async function getFeatureFlags(): Promise<FeatureFlags> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'getFeatureFlags' }, (response) => {
      if (chrome.runtime.lastError || !response) {
        // Default to safe mode if we can't get flags
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
  flagsScript.id = 'web-agents-api-flags';
  flagsScript.textContent = JSON.stringify(flags);
  root.appendChild(flagsScript);

  // Then inject the main script
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
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
  document.documentElement?.setAttribute('data-web-agents-content-script', 'true');

  // Wait for Harbor discovery to be available
  const checkHarbor = () => {
    const harborInfo = (window as { __harbor?: { extensionId: string } }).__harbor;
    if (harborInfo?.extensionId) {
      // Harbor found, notify background
      chrome.runtime.sendMessage({ 
        type: 'harbor_discovered', 
        extensionId: harborInfo.extensionId 
      });
    }
  };

  // Check immediately and also listen for discovery event
  checkHarbor();
  window.addEventListener('harbor-discovered', checkHarbor);

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
  const el = document.getElementById('web-agents-api-flags');
  if (el) {
    el.textContent = JSON.stringify(flags);
  }
}

// When user toggles flags in the sidebar, update the page so the injected API sees them without refresh.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes['web-agents-api-flags']) {
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
  
  console.log(`[TRACE ${trace}] Content: Forwarding invocation to page - task: ${message.task}, invocationId: ${invocationId}`);
  
  // Forward to page in the format injected.ts expects
  window.postMessage({
    channel: CHANNEL,
    agentEvent: {
      type: 'invocation',
      invocation: {
        invocationId: message.invocationId,
        from: message.from,
        task: message.task,
        input: message.input,
      },
    },
  }, '*');
  
  sendResponse({ ok: true });
  return true;
});

// Track pending Harbor invocations waiting for page response
const pendingHarborInvocations = new Map<string, (response: unknown) => void>();

// Listen for invocation responses from the page
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.channel !== CHANNEL) return;
  
  // Handle invocation response from page (used by both internal and Harbor invocations)
  if (data.agentInvocationResponse) {
    const { invocationId, success, result, error } = data.agentInvocationResponse;
    const resolver = pendingHarborInvocations.get(invocationId);
    if (resolver) {
      pendingHarborInvocations.delete(invocationId);
      // Format response for Harbor
      resolver({ success, result, error });
    }
  }
});

// Listen for Harbor's forwarded invocations (sent directly to tab)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'harbor.forwardInvocation') {
    return false;
  }
  
  const trace = message.traceId || 'no-trace';
  const { agentId, request } = message;
  const invocationId = `harbor-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  
  console.log(`[TRACE ${trace}] Content: Harbor forward invocation - agentId: ${agentId}, task: ${request?.task}`);
  
  // Store the sendResponse callback for when the page responds
  pendingHarborInvocations.set(invocationId, (response) => {
    console.log(`[TRACE ${trace}] Content: Sending response back to Harbor`);
    sendResponse(response);
  });
  
  // Forward to page
  window.postMessage({
    channel: CHANNEL,
    agentEvent: {
      type: 'invocation',
      invocation: {
        invocationId,
        from: request?.from,
        task: request?.task,
        input: request?.input,
      },
    },
  }, '*');
  
  // Keep channel open for async response
  return true;
});

// Initialize
injectAgentsAPI().catch(console.error);
setupAgentEventForwarding();