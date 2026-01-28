/**
 * Web Agent API - Content Script
 *
 * Bridges messages between:
 * - Injected script (web page context)
 * - Background script (extension context)
 */

import { browserAPI } from '../browser-compat';
import type {
  TransportRequest,
  TransportResponse,
  TransportStreamEvent,
} from './types';

const CHANNEL = 'harbor_web_agent';

type RuntimePort = ReturnType<typeof browserAPI.runtime.connect>;

let backgroundPort: RuntimePort | null = null;

// Track pending requests and active streams
const pendingRequests = new Map<string, {
  sendResponse: (response: TransportResponse) => void;
}>();

const activeStreams = new Map<string, {
  sendEvent: (event: TransportStreamEvent) => void;
}>();

/**
 * Get or create connection to background script.
 */
function getBackgroundPort(): RuntimePort {
  if (!backgroundPort || !backgroundPort.name) {
    backgroundPort = browserAPI.runtime.connect({ name: 'web-agent-transport' });

    // Handle messages from background
    backgroundPort.onMessage.addListener((message: TransportResponse | TransportStreamEvent) => {
      if ('ok' in message) {
        // Regular response
        const pending = pendingRequests.get(message.id);
        if (pending) {
          pendingRequests.delete(message.id);
          pending.sendResponse(message);
        }
      } else if ('event' in message) {
        // Stream event
        const stream = activeStreams.get(message.id);
        if (stream) {
          stream.sendEvent(message);
          if (message.done) {
            activeStreams.delete(message.id);
          }
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

/**
 * Fetch feature flags from background script.
 */
async function getFeatureFlags(): Promise<{
  browserInteraction: boolean;
  screenshots: boolean;
  experimental: boolean;
  browserControl: boolean;
  multiAgent: boolean;
}> {
  return new Promise((resolve) => {
    browserAPI.runtime.sendMessage({ type: 'getFeatureFlags' }, (response) => {
      if (browserAPI.runtime.lastError || !response) {
        // Default to safe mode if we can't get flags
        resolve({
          browserInteraction: false,
          screenshots: false,
          experimental: false,
          browserControl: false,
          multiAgent: false,
        });
      } else {
        resolve(response);
      }
    });
  });
}

/**
 * Inject the Web Agent API script into the page with feature flags.
 */
let injected = false;

function appendInjectedScripts(flags: {
  browserInteraction: boolean;
  screenshots: boolean;
  experimental: boolean;
  browserControl: boolean;
  multiAgent: boolean;
}): boolean {
  if (injected) return true;
  const root = document.head || document.documentElement;
  if (!root) return false;

  const flagsScript = document.createElement('script');
  flagsScript.type = 'application/json';
  flagsScript.id = 'harbor-feature-flags';
  flagsScript.textContent = JSON.stringify(flags);
  root.appendChild(flagsScript);

  const script = document.createElement('script');
  script.src = browserAPI.runtime.getURL('dist/agents/injected.js');
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

async function injectAgentsAPI(): Promise<void> {
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

// Mark content script presence for debugging.
document.documentElement?.setAttribute('data-harbor-content-script', 'true');

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
  const isStreamingRequest = request.type === 'agent.run' || request.type === 'session.promptStreaming';

  const port = getBackgroundPort();

  if (isStreamingRequest) {
    // Set up stream forwarding
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

// Initialize
injectAgentsAPI().catch(console.error);
