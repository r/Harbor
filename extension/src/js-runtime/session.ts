/**
 * JS MCP Server session management.
 *
 * Uses the native bridge's QuickJS runtime for JS MCP servers.
 * This provides full sandboxing with controlled fetch/fs access.
 * Falls back to in-browser worker for built-in servers when bridge unavailable.
 */

import { browserAPI } from '../browser-compat';
import type { StdioEndpoint } from '../mcp/stdio-transport';
import type { McpServerManifest } from '../wasm/types';
import { bridgeRequest, getBridgeConnectionState } from '../llm/bridge-client';

// Built-in server IDs that have pre-bundled worker files (fallback)
const BUILTIN_WORKER_MAP: Record<string, string> = {
  'echo-js': 'dist/js-runtime/builtin-echo-worker.js',
};

export type JsSession = {
  endpoint: StdioEndpoint;
  close: () => void;
};

/**
 * Load server code from manifest (URL or base64).
 */
async function loadServerCode(manifest: McpServerManifest): Promise<string> {
  if (manifest.scriptBase64) {
    return atob(manifest.scriptBase64);
  }

  if (manifest.scriptUrl) {
    const response = await fetch(manifest.scriptUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch JS server: ${response.status}`);
    }
    return response.text();
  }

  throw new Error('JS server manifest must have scriptUrl or scriptBase64');
}

/**
 * Fetch OAuth tokens for a server if it requires OAuth.
 * Returns the access token or throws if not authenticated.
 */
async function fetchOAuthTokens(manifest: McpServerManifest): Promise<Record<string, string>> {
  if (!manifest.oauth) {
    return {};
  }

  const { provider, scopes, tokenEnvVar, refreshTokenEnvVar } = manifest.oauth;
  
  // Check OAuth status
  const statusResult = await bridgeRequest<{
    authenticated: boolean;
    is_expired?: boolean;
  }>('oauth.status', { server_id: manifest.id });

  if (!statusResult.authenticated) {
    throw new Error(
      `Server "${manifest.name}" requires ${provider} authentication. ` +
      `Please sign in first.`
    );
  }

  if (statusResult.is_expired) {
    console.log('[Harbor] OAuth token expired for', manifest.id, '- refresh should happen automatically');
  }

  // Get the actual tokens
  const tokensResult = await bridgeRequest<{
    has_tokens: boolean;
    access_token?: string;
  }>('oauth.get_tokens', { server_id: manifest.id });

  if (!tokensResult.has_tokens || !tokensResult.access_token) {
    throw new Error(`OAuth tokens not found for server "${manifest.name}"`);
  }

  const oauthEnv: Record<string, string> = {
    [tokenEnvVar]: tokensResult.access_token,
  };

  console.log('[Harbor] Injecting OAuth token into', tokenEnvVar);
  
  return oauthEnv;
}

/**
 * Creates a JS MCP server session using the native bridge.
 * The bridge runs the JS code in QuickJS with sandboxed capabilities.
 */
async function createBridgeSession(manifest: McpServerManifest): Promise<JsSession> {
  // Load the server code
  const code = await loadServerCode(manifest);

  // Build environment variables
  // Note: manifest.secrets is metadata about what secrets are needed, not actual values.
  // Actual secret values come from OAuth tokens or user configuration.
  const env: Record<string, string> = {};

  // Fetch and inject OAuth tokens if required
  if (manifest.oauth) {
    const oauthEnv = await fetchOAuthTokens(manifest);
    Object.assign(env, oauthEnv);
  }

  // Build capabilities from manifest
  const capabilities = {
    network: {
      allowed_hosts: manifest.capabilities?.network?.hosts || [],
    },
    filesystem: {
      read_paths: [] as string[],
      write_paths: [] as string[],
    },
  };

  // Start the server in the bridge
  await bridgeRequest<{ id: string; status: string }>('js.start_server', {
    id: manifest.id,
    code,
    env,
    capabilities,
  });

  console.log('[Harbor] Started JS MCP server via bridge:', manifest.id);

  // Create endpoint that proxies through the bridge
  let handler: ((data: Uint8Array) => void) | null = null;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  const endpoint: StdioEndpoint = {
    async write(data: Uint8Array) {
      const jsonString = decoder.decode(data).trim();
      if (!jsonString) return;

      try {
        const request = JSON.parse(jsonString);
        
        // Call the bridge to forward request to JS server
        const response = await bridgeRequest<unknown>('js.call', {
          id: manifest.id,
          request,
        });

        // Send response back through the endpoint
        const responseData = encoder.encode(JSON.stringify(response) + '\n');
        handler?.(responseData);
      } catch (e) {
        console.error('[Harbor] Bridge JS call error:', e);
        // Send error response
        try {
          const request = JSON.parse(jsonString);
          const errorResponse = {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32000, message: e instanceof Error ? e.message : 'Unknown error' },
          };
          const responseData = encoder.encode(JSON.stringify(errorResponse) + '\n');
          handler?.(responseData);
        } catch {
          // Couldn't parse original request, can't send error response
        }
      }
    },
    onData(nextHandler: (data: Uint8Array) => void) {
      handler = nextHandler;
    },
  };

  return {
    endpoint,
    close: async () => {
      try {
        await bridgeRequest('js.stop_server', { id: manifest.id });
        console.log('[Harbor] Stopped JS MCP server via bridge:', manifest.id);
      } catch (e) {
        console.warn('[Harbor] Failed to stop JS server:', e);
      }
      handler = null;
    },
  };
}

/**
 * Creates a stdio endpoint for communication with a worker.
 */
function createWorkerStdioEndpoint(): {
  endpoint: StdioEndpoint;
  attachWorker: (worker: Worker) => void;
  close: () => void;
} {
  let handler: ((data: Uint8Array) => void) | null = null;
  let worker: Worker | null = null;
  const encoder = new TextEncoder();

  const endpoint: StdioEndpoint = {
    write(data: Uint8Array) {
      const decoder = new TextDecoder();
      const jsonString = decoder.decode(data);
      if (worker) {
        worker.postMessage({ type: 'stdin', data: jsonString });
      }
    },
    onData(nextHandler: (data: Uint8Array) => void) {
      handler = nextHandler;
    },
  };

  const attachWorker = (w: Worker) => {
    worker = w;
    worker.addEventListener('message', (event) => {
      const data = event.data;
      if (!data) return;

      if (data.type === 'stdout') {
        const encoded = encoder.encode(data.data + '\n');
        handler?.(encoded);
      } else if (data.type === 'console') {
        const level = data.level as 'log' | 'warn' | 'error' | 'info' | 'debug';
        const args = data.args || [];
        console[level]?.('[JS MCP]', ...args);
      }
    });
  };

  return {
    endpoint,
    attachWorker,
    close: () => {
      handler = null;
      worker = null;
    },
  };
}

/**
 * Creates a JS MCP server session using a pre-bundled in-browser worker.
 * Used as fallback for built-in servers when bridge is unavailable.
 */
async function createBuiltinWorkerSession(
  manifest: McpServerManifest,
  workerPath: string,
): Promise<JsSession> {
  const workerUrl = browserAPI.runtime.getURL(workerPath);
  const worker = new Worker(workerUrl);

  const { endpoint, attachWorker, close: closeEndpoint } = createWorkerStdioEndpoint();
  attachWorker(worker);

  // Wait for worker to signal ready
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('JS server failed to initialize within timeout'));
    }, 5000);

    const readyHandler = (event: MessageEvent) => {
      if (event.data?.type === 'ready') {
        clearTimeout(timeout);
        worker.removeEventListener('message', readyHandler);
        resolve();
      }
    };

    worker.addEventListener('message', readyHandler);
    worker.addEventListener('error', (e) => {
      clearTimeout(timeout);
      reject(new Error(`Worker error: ${e.message}`));
    });
  });

  // Inject secrets if present
  if (manifest.secrets && Object.keys(manifest.secrets).length > 0) {
    worker.postMessage({ type: 'init-env', env: manifest.secrets });
  }

  console.log('[Harbor] JS MCP server session started (builtin worker):', manifest.id);

  return {
    endpoint,
    close: () => {
      worker.postMessage({ type: 'terminate' });
      setTimeout(() => worker.terminate(), 100);
      closeEndpoint();
      console.log('[Harbor] JS MCP server session closed:', manifest.id);
    },
  };
}

/**
 * Creates a JS MCP server session.
 * 
 * Prefers the native bridge (QuickJS) for full sandboxing support.
 * Falls back to in-browser workers for built-in servers.
 *
 * @param manifest - The server manifest with JS-specific fields
 * @returns A session with stdio endpoint and close function
 */
export async function createJsSession(
  manifest: McpServerManifest,
): Promise<JsSession> {
  // Validate that this is a JS server
  if (manifest.runtime !== 'js') {
    throw new Error(`Expected JS server, got runtime: ${manifest.runtime}`);
  }

  const bridgeState = getBridgeConnectionState();
  const builtinWorkerPath = BUILTIN_WORKER_MAP[manifest.id];

  // Try bridge first for non-builtin servers, or when bridge is connected
  if (bridgeState.connected && (!builtinWorkerPath || manifest.scriptBase64 || manifest.scriptUrl)) {
    try {
      return await createBridgeSession(manifest);
    } catch (e) {
      console.warn('[Harbor] Bridge session failed, trying fallback:', e);
    }
  }

  // Fallback to builtin worker if available
  if (builtinWorkerPath) {
    try {
      return await createBuiltinWorkerSession(manifest, builtinWorkerPath);
    } catch (e) {
      console.warn('[Harbor] Builtin worker failed:', e);
    }
  }

  // Last resort: stub implementation
  console.warn('[Harbor] Using stub implementation for JS server:', manifest.id);
  return createJsStubSession(manifest);
}

/**
 * Creates a stub session for testing without actual server code.
 * Returns an endpoint that echoes tools/list with empty tools.
 */
export function createJsStubSession(manifest: McpServerManifest): JsSession {
  let handler: ((data: Uint8Array) => void) | null = null;
  const encoder = new TextEncoder();

  const endpoint: StdioEndpoint = {
    write(data: Uint8Array) {
      const decoder = new TextDecoder();
      const json = decoder.decode(data);
      try {
        const request = JSON.parse(json.trim());
        let response;

        if (request.method === 'tools/list') {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            result: { tools: manifest.tools || [] },
          };
        } else if (request.method === 'tools/call') {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [
                { type: 'text', text: 'Stub response from JS MCP server' },
              ],
            },
          };
        } else {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Method not found' },
          };
        }

        // Send response back
        const responseData = encoder.encode(JSON.stringify(response) + '\n');
        setTimeout(() => handler?.(responseData), 0);
      } catch (e) {
        console.error('[Harbor] Stub session parse error:', e);
      }
    },
    onData(nextHandler: (data: Uint8Array) => void) {
      handler = nextHandler;
    },
  };

  return {
    endpoint,
    close: () => {
      handler = null;
      console.log('[Harbor] Closing JS stub session:', manifest.id);
    },
  };
}
