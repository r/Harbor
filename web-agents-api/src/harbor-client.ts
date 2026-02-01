/**
 * Harbor Client
 * 
 * Client for communicating with the Harbor extension.
 * Uses chrome.runtime.sendMessage to call Harbor's extension API.
 * 
 * Safari: Uses HTTP to communicate with harbor-bridge directly,
 * since Safari doesn't support cross-extension messaging.
 */

import { ErrorCodes, type ApiError } from './types';

// =============================================================================
// Configuration
// =============================================================================

// Known Harbor extension IDs (production and development)
const KNOWN_HARBOR_IDS = [
  'harbor@mozilla.org',  // Firefox production ID
  'raffi.krikorian.harbor@gmail.com',  // Firefox AMO signed ID
  // Chrome stable dev ID (generated from key in manifest.chrome.json)
  // All developers loading from the repo will get this same ID
  'ljnciidcajlichemnbohopnlaonhkpgm',
  // Safari extension bundle identifier
  'org.harbor.Extension',
  // Add Chrome Web Store ID here when published (will be different)
];

// Timeout for requests (ms)
const REQUEST_TIMEOUT = 30000;

// Safari HTTP bridge URL
const SAFARI_HTTP_BASE = 'http://127.0.0.1:8766';

// =============================================================================
// State
// =============================================================================

let harborExtensionId: string | null = null;
let connectionState: 'unknown' | 'connected' | 'not-found' = 'unknown';

// =============================================================================
// Types
// =============================================================================

interface HarborRequest {
  type: string;
  payload?: unknown;
  requestId?: string;
}

interface HarborResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface StreamEvent {
  type: 'token' | 'done' | 'error';
  token?: string;
  finish_reason?: string;
  model?: string;
  error?: { code: number; message: string };
}

// =============================================================================
// Discovery
// =============================================================================

/**
 * Discover the Harbor extension by trying known extension IDs.
 * Returns the extension ID if found, null otherwise.
 * 
 * Safari: Uses HTTP to communicate with harbor-bridge directly.
 */
export async function discoverHarbor(): Promise<string | null> {
  console.log('[Web Agents API] Starting Harbor discovery...');
  
  // If already discovered, return cached ID
  if (harborExtensionId && connectionState === 'connected') {
    console.log('[Web Agents API] Using cached Harbor ID:', harborExtensionId);
    return harborExtensionId;
  }

  // Safari: Try HTTP connection to harbor-bridge
  if (isSafari()) {
    console.log('[Web Agents API] Safari detected, trying HTTP connection to bridge...');
    try {
      const response = await fetch(`${SAFARI_HTTP_BASE}/health`, { method: 'GET' });
      if (response.ok) {
        // Bridge is available - consider Harbor "connected" via bridge
        harborExtensionId = 'safari-bridge';
        connectionState = 'connected';
        console.log('[Web Agents API] Safari: Harbor bridge available via HTTP');
        return harborExtensionId;
      }
    } catch (e) {
      console.log('[Web Agents API] Safari HTTP connection failed:', e);
    }
    console.log('[Web Agents API] Safari: Harbor bridge not found');
    connectionState = 'not-found';
    return null;
  }

  // Chrome/Firefox: Try each known ID
  for (const id of KNOWN_HARBOR_IDS) {
    console.log('[Web Agents API] Trying known ID:', id);
    try {
      const response = await sendMessageToExtension(id, { type: 'system.getVersion' });
      console.log('[Web Agents API] Response from', id, ':', response);
      if (response?.ok) {
        harborExtensionId = id;
        connectionState = 'connected';
        console.log('[Web Agents API] Harbor discovered:', id);
        return id;
      }
    } catch (e) {
      console.log('[Web Agents API] Failed to contact', id, ':', e);
      // Extension not found or not responding, try next
    }
  }

  // Try to find Harbor by probing (for development/unpacked extensions)
  // This uses the externally_connectable pattern
  try {
    // In Firefox, we can use the extension ID from the discovery script
    const storageResult = await chrome.storage.local.get('harbor_extension_id');
    console.log('[Web Agents API] Stored Harbor ID:', storageResult.harbor_extension_id);
    if (storageResult.harbor_extension_id) {
      const id = storageResult.harbor_extension_id;
      try {
        const response = await sendMessageToExtension(id, { type: 'system.getVersion' });
        console.log('[Web Agents API] Response from stored ID:', response);
        if (response?.ok) {
          harborExtensionId = id;
          connectionState = 'connected';
          console.log('[Web Agents API] Harbor discovered via storage:', id);
          return id;
        }
      } catch (e) {
        console.log('[Web Agents API] Failed to contact stored ID:', e);
      }
    }
  } catch (e) {
    console.log('[Web Agents API] Storage access failed:', e);
  }

  console.log('[Web Agents API] Harbor not found');
  connectionState = 'not-found';
  return null;
}

/**
 * Get the current Harbor connection state.
 */
export function getHarborState(): { connected: boolean; extensionId: string | null } {
  return {
    connected: connectionState === 'connected',
    extensionId: harborExtensionId,
  };
}

/**
 * Set the Harbor extension ID (called when discovered via content script).
 */
export function setHarborExtensionId(id: string): void {
  harborExtensionId = id;
  connectionState = 'connected';
  // Persist for future sessions
  chrome.storage.local.set({ harbor_extension_id: id }).catch(() => {});
}

// =============================================================================
// Communication
// =============================================================================

/**
 * Detect Safari browser.
 */
function isSafari(): boolean {
  return typeof browser !== 'undefined' && 
         navigator.userAgent.includes('Safari') && 
         !navigator.userAgent.includes('Chrome');
}

/**
 * Send a message to a specific extension.
 * Uses Promise-based API for Firefox compatibility.
 * Safari requires special handling for cross-extension messaging.
 */
async function sendMessageToExtension(
  extensionId: string,
  message: HarborRequest,
): Promise<HarborResponse> {
  console.log('[Web Agents API] sendMessageToExtension:', extensionId, message.type, 'safari:', isSafari());
  
  // Create a timeout promise
  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(`Request timed out after ${REQUEST_TIMEOUT}ms`));
    }, REQUEST_TIMEOUT);
  });

  // Create the message promise
  const messagePromise = new Promise<HarborResponse>((resolve, reject) => {
    try {
      // Safari: Use browser API if available
      if (isSafari() && typeof browser !== 'undefined' && browser.runtime?.sendMessage) {
        console.log('[Web Agents API] Using Safari/browser API for cross-extension message');
        browser.runtime.sendMessage(extensionId, message)
          .then((response: unknown) => {
            console.log('[Web Agents API] Safari sendMessage response:', response);
            resolve(response as HarborResponse);
          })
          .catch((e: unknown) => {
            console.log('[Web Agents API] Safari sendMessage error:', e);
            reject(e);
          });
        return;
      }
      
      // In Firefox, chrome.runtime.sendMessage returns a Promise
      // In Chrome, it uses a callback
      const result = chrome.runtime.sendMessage(extensionId, message, (response) => {
        // This callback is used in Chrome
        if (chrome.runtime.lastError) {
          console.log('[Web Agents API] sendMessage error:', chrome.runtime.lastError.message);
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        console.log('[Web Agents API] sendMessage response (callback):', response);
        resolve(response as HarborResponse);
      });
      
      // In Firefox, sendMessage returns a Promise
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>)
          .then((response) => {
            console.log('[Web Agents API] sendMessage response (promise):', response);
            resolve(response as HarborResponse);
          })
          .catch((e) => {
            console.log('[Web Agents API] sendMessage promise error:', e);
            reject(e);
          });
      }
    } catch (e) {
      console.log('[Web Agents API] sendMessage exception:', e);
      reject(e);
    }
  });

  // Race between message and timeout
  return Promise.race([messagePromise, timeoutPromise]);
}

/**
 * Safari: Send RPC request via HTTP to harbor-bridge.
 */
async function safariHttpRequest<T>(method: string, params: unknown = {}): Promise<T> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  console.log('[Web Agents API:Safari] HTTP RPC:', method);
  
  const response = await fetch(`${SAFARI_HTTP_BASE}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, method, params }),
  });
  
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  
  const data = await response.json();
  if (data?.error) {
    throw new Error(data.error.message || JSON.stringify(data.error));
  }
  
  return (data?.result ?? null) as T;
}

/**
 * Send a request to Harbor.
 * Throws if Harbor is not connected.
 * 
 * Safari: Routes to harbor-bridge via HTTP.
 */
export async function harborRequest<T = unknown>(
  type: string,
  payload?: unknown,
): Promise<T> {
  if (!harborExtensionId || connectionState !== 'connected') {
    // Try to discover Harbor first
    const id = await discoverHarbor();
    if (!id) {
      throw createError(ErrorCodes.HARBOR_NOT_FOUND, 'Harbor extension not found. Please install Harbor.');
    }
  }

  // Safari: Use HTTP to bridge
  if (isSafari()) {
    // Map Web Agents API calls to bridge RPC methods where possible
    // Note: Some features may not be available in Safari (agent control, etc.)
    const methodMap: Record<string, string> = {
      'system.health': 'system.health',
      'system.getVersion': 'system.health', // No version on bridge, use health
      'system.getCapabilities': 'system.health', // Simplified
      'llm.listProviders': 'llm.list_providers',
      'llm.chat': 'llm.chat',
      'mcp.listServers': 'js.list_servers',
      'mcp.listTools': 'mcp.list_tools', // Tools synced from Harbor
      'mcp.callTool': 'mcp.call_tool', // Tool execution via bridge
    };
    
    const bridgeMethod = methodMap[type];
    if (bridgeMethod) {
      // Bridge returns { result: ... }, return just the result to match Chrome/Firefox behavior
      const result = await safariHttpRequest<T>(bridgeMethod, payload);
      return result;
    }
    
    // For unmapped methods, return a "not supported" response
    console.log('[Web Agents API:Safari] Method not supported via bridge:', type);
    return { supported: false } as unknown as T;
  }

  const response = await sendMessageToExtension(harborExtensionId!, { type, payload });

  if (!response.ok) {
    throw createError(ErrorCodes.INTERNAL, response.error || 'Unknown error from Harbor');
  }

  return response.result as T;
}

/**
 * Create a streaming request to Harbor.
 * Uses a port connection for streaming responses.
 */
export function harborStreamRequest(
  type: string,
  payload?: unknown,
): { stream: AsyncIterable<StreamEvent>; cancel: () => void } {
  if (!harborExtensionId || connectionState !== 'connected') {
    throw createError(ErrorCodes.HARBOR_NOT_FOUND, 'Harbor extension not found');
  }

  const requestId = `stream-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const eventQueue: StreamEvent[] = [];
  let resolveWaiting: ((event: StreamEvent | null) => void) | null = null;
  let done = false;
  let error: Error | null = null;
  let port: chrome.runtime.Port | null = null;

  // Create port connection for streaming
  try {
    port = chrome.runtime.connect(harborExtensionId!, { name: 'stream' });
  } catch (e) {
    throw createError(ErrorCodes.HARBOR_NOT_FOUND, 'Failed to connect to Harbor');
  }

  port.onMessage.addListener((message: { type: string; requestId: string; event?: StreamEvent }) => {
    if (message.requestId !== requestId) return;

    if (message.type === 'stream' && message.event) {
      const event = message.event;
      
      if (resolveWaiting) {
        resolveWaiting(event);
        resolveWaiting = null;
      } else {
        eventQueue.push(event);
      }

      if (event.type === 'done' || event.type === 'error') {
        done = true;
        if (event.type === 'error' && event.error) {
          error = new Error(event.error.message);
        }
      }
    }
  });

  port.onDisconnect.addListener(() => {
    done = true;
    if (resolveWaiting) {
      resolveWaiting(null);
      resolveWaiting = null;
    }
  });

  // Send the request
  port.postMessage({ type, payload, requestId });

  // Create async iterable
  const stream: AsyncIterable<StreamEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<StreamEvent>> {
          // Check for queued events
          if (eventQueue.length > 0) {
            const event = eventQueue.shift()!;
            if (event.type === 'done' || event.type === 'error') {
              return { done: true, value: event };
            }
            return { done: false, value: event };
          }

          // Check if done
          if (done) {
            if (error) {
              throw error;
            }
            return { done: true, value: undefined as unknown as StreamEvent };
          }

          // Wait for next event
          const event = await new Promise<StreamEvent | null>((resolve) => {
            resolveWaiting = resolve;
          });

          if (event === null) {
            if (error) {
              throw error;
            }
            return { done: true, value: undefined as unknown as StreamEvent };
          }

          if (event.type === 'done' || event.type === 'error') {
            return { done: true, value: event };
          }

          return { done: false, value: event };
        },
      };
    },
  };

  const cancel = () => {
    done = true;
    if (port) {
      port.disconnect();
      port = null;
    }
  };

  return { stream, cancel };
}

// =============================================================================
// Health Check
// =============================================================================

/**
 * Check if Harbor is healthy and responding.
 */
export async function checkHarborHealth(): Promise<boolean> {
  try {
    const result = await harborRequest<{ healthy: boolean }>('system.health');
    return result.healthy;
  } catch {
    return false;
  }
}

/**
 * Get Harbor capabilities.
 */
export async function getHarborCapabilities(): Promise<{
  bridgeReady: boolean;
  features: {
    llm: boolean;
    mcp: boolean;
    oauth: boolean;
    streaming: boolean;
  };
}> {
  return harborRequest('system.getCapabilities');
}

// =============================================================================
// Helpers
// =============================================================================

function createError(code: string, message: string): ApiError & Error {
  const error = new Error(message) as ApiError & Error;
  error.code = code;
  return error;
}
