import type { McpServerManifest } from '../wasm/types';

// New storage key for unified MCP servers
const STORAGE_KEY = 'harbor_mcp_servers';
// Legacy key for migration
const LEGACY_STORAGE_KEY = 'harbor_wasm_servers';

/**
 * Migrate servers from legacy storage key to new key.
 * Also ensures all servers have a runtime field.
 */
async function migrateIfNeeded(): Promise<void> {
  const result = await chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY]);
  
  // Check if we have data in new key already
  if (result[STORAGE_KEY]) {
    return;
  }
  
  // Check if we have legacy data to migrate
  const legacyServers = result[LEGACY_STORAGE_KEY] as McpServerManifest[] | undefined;
  if (legacyServers && legacyServers.length > 0) {
    // Add runtime: 'wasm' to any servers missing it
    const migratedServers = legacyServers.map((server) => ({
      ...server,
      runtime: server.runtime || 'wasm' as const,
    }));
    
    // Save to new key and remove legacy key
    await chrome.storage.local.set({ [STORAGE_KEY]: migratedServers });
    await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
    
    console.log('[Harbor] Migrated', migratedServers.length, 'servers to new storage format');
  }
}

export async function loadInstalledServers(): Promise<McpServerManifest[]> {
  await migrateIfNeeded();
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const servers = (result[STORAGE_KEY] as McpServerManifest[]) || [];
  console.log('[Harbor] Loaded servers:', servers.length);
  return servers;
}

export async function saveInstalledServers(servers: McpServerManifest[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: servers });
}

export async function addInstalledServer(server: McpServerManifest): Promise<void> {
  const existing = await loadInstalledServers();
  const next = existing.filter((item) => item.id !== server.id);
  next.push(server);
  await saveInstalledServers(next);
}

export async function updateInstalledServer(server: McpServerManifest): Promise<void> {
  await addInstalledServer(server);
}

export async function removeInstalledServer(serverId: string): Promise<void> {
  const existing = await loadInstalledServers();
  const next = existing.filter((item) => item.id !== serverId);
  await saveInstalledServers(next);
}

/**
 * Demo echo server source code.
 * This is a minimal JS MCP server that echoes back input.
 */
const ECHO_SERVER_SOURCE = `
async function main() {
  console.log('Echo JS MCP server starting...');
  
  while (true) {
    const line = await MCP.readLine();
    let request;
    try {
      request = JSON.parse(line);
    } catch (e) {
      console.error('Failed to parse request:', e);
      continue;
    }
    
    let response;
    
    switch (request.method) {
      case 'tools/list':
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echo back the input message',
                inputSchema: {
                  type: 'object',
                  properties: {
                    message: {
                      type: 'string',
                      description: 'The message to echo back'
                    }
                  },
                  required: ['message']
                }
              },
              {
                name: 'reverse',
                description: 'Reverse a string',
                inputSchema: {
                  type: 'object',
                  properties: {
                    text: {
                      type: 'string',
                      description: 'The text to reverse'
                    }
                  },
                  required: ['text']
                }
              }
            ]
          }
        };
        break;
        
      case 'tools/call':
        const toolName = request.params?.name;
        const args = request.params?.arguments || {};
        
        if (toolName === 'echo') {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [
                { type: 'text', text: 'Echo: ' + (args.message || '(empty)') }
              ]
            }
          };
        } else if (toolName === 'reverse') {
          const reversed = (args.text || '').split('').reverse().join('');
          response = {
            jsonrpc: '2.0',
            id: request.id,
            result: {
              content: [
                { type: 'text', text: reversed }
              ]
            }
          };
        } else {
          response = {
            jsonrpc: '2.0',
            id: request.id,
            error: { code: -32601, message: 'Unknown tool: ' + toolName }
          };
        }
        break;
        
      default:
        response = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32601, message: 'Method not found: ' + request.method }
        };
    }
    
    MCP.writeLine(JSON.stringify(response));
  }
}

main().catch(err => console.error('Echo server error:', err));
`;

/**
 * Ensure built-in servers are always installed on startup.
 * If they were deleted, they get re-added. Only one instance of each.
 */
export async function ensureBuiltinServers(): Promise<McpServerManifest[]> {
  const existing = await loadInstalledServers();
  
  const hasTime = existing.some((s) => s.id === 'time-wasm');
  const hasEcho = existing.some((s) => s.id === 'echo-js');
  
  if (hasTime && hasEcho) {
    console.log('[Harbor] Built-in servers already present');
    return existing;
  }
  
  const serversToAdd: McpServerManifest[] = [];
  
  // WASM time server
  if (!hasTime) {
    const timeManifest: McpServerManifest = {
      id: 'time-wasm',
      name: 'Time Server',
      version: '0.1.0',
      runtime: 'wasm',
      entrypoint: 'mcp-time.wasm',
      moduleUrl: chrome.runtime.getURL('assets/mcp-time.wasm'),
      permissions: [],
      tools: [
        {
          name: 'time.now',
          description: 'Get current time from host',
          inputSchema: {
            type: 'object',
            properties: {
              now: { type: 'string' },
            },
            required: ['now'],
          },
        },
      ],
    };
    serversToAdd.push(timeManifest);
  }
  
  // JS echo server
  if (!hasEcho) {
    const echoManifest: McpServerManifest = {
      id: 'echo-js',
      name: 'Echo Server',
      version: '0.1.0',
      runtime: 'js',
      scriptBase64: btoa(ECHO_SERVER_SOURCE),
      permissions: [],
      capabilities: {
        // No network access needed for echo server
      },
      tools: [
        {
          name: 'echo',
          description: 'Echo back the input message',
          inputSchema: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'The message to echo back' },
            },
            required: ['message'],
          },
        },
        {
          name: 'reverse',
          description: 'Reverse a string',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The text to reverse' },
            },
            required: ['text'],
          },
        },
      ],
    };
    serversToAdd.push(echoManifest);
  }
  
  const next = [...existing, ...serversToAdd];
  await saveInstalledServers(next);
  
  console.log('[Harbor] Added built-in servers:', serversToAdd.map(s => s.id).join(', '));
  return next;
}
