/**
 * JS MCP Server session management.
 *
 * For Firefox MV3 compatibility, uses pre-bundled worker files for built-in servers.
 * Dynamic JS servers are not fully supported in Firefox MV3 due to CSP restrictions.
 */

import type { StdioEndpoint } from '../mcp/stdio-transport';
import type { McpServerManifest } from '../wasm/types';

// Built-in server IDs that have pre-bundled worker files
const BUILTIN_WORKER_MAP: Record<string, string> = {
  'echo-js': 'dist/js-runtime/builtin-echo-worker.js',
};

export type JsSession = {
  endpoint: StdioEndpoint;
  close: () => void;
};

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
 * Creates a JS MCP server session.
 * 
 * For built-in servers (like echo-js), uses pre-bundled worker files.
 * For custom servers, falls back to stub implementation in Firefox MV3
 * (dynamic JS workers are not supported due to CSP restrictions).
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

  // Check if this is a built-in server with a pre-bundled worker
  const builtinWorkerPath = BUILTIN_WORKER_MAP[manifest.id];
  
  if (builtinWorkerPath) {
    // Use pre-bundled worker file
    const workerUrl = chrome.runtime.getURL(builtinWorkerPath);
    const worker = new Worker(workerUrl);

    const { endpoint, attachWorker, close: closeEndpoint } =
      createWorkerStdioEndpoint();
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

  // For non-builtin servers, use stub implementation
  // (Firefox MV3 doesn't support dynamic JS workers due to CSP)
  console.warn('[Harbor] Using stub implementation for non-builtin JS server:', manifest.id);
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
