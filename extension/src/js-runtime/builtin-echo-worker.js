/**
 * Built-in Echo Server - Pre-bundled worker for Firefox MV3 compatibility.
 * This is the echo server code wrapped with the sandbox preamble.
 */

// ============================================================================
// SANDBOX PREAMBLE (simplified for built-in servers)
// ============================================================================

(function() {
  'use strict';

  // Remove dangerous globals
  delete globalThis.fetch;
  delete globalThis.XMLHttpRequest;
  delete globalThis.WebSocket;
  delete globalThis.importScripts;
  delete self.fetch;
  delete self.XMLHttpRequest;
  delete self.WebSocket;
  delete self.importScripts;

  // MCP stdio interface
  const stdinQueue = [];
  let stdinResolver = null;

  globalThis.MCP = {
    readLine: function() {
      return new Promise((resolve) => {
        if (stdinQueue.length > 0) {
          resolve(stdinQueue.shift());
        } else {
          stdinResolver = resolve;
        }
      });
    },
    writeLine: function(json) {
      self.postMessage({ type: 'stdout', data: json });
    },
  };

  // Process shim
  globalThis.process = {
    env: {},
    nextTick: (cb) => setTimeout(cb, 0),
    platform: 'browser',
    version: 'v0.0.0',
  };

  // Message handler
  self.addEventListener('message', function(event) {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'stdin') {
      if (stdinResolver) {
        stdinResolver(data.data);
        stdinResolver = null;
      } else {
        stdinQueue.push(data.data);
      }
    } else if (data.type === 'init-env') {
      Object.assign(globalThis.process.env, data.env);
    } else if (data.type === 'terminate') {
      self.close();
    }
  });

  // Signal ready
  self.postMessage({ type: 'ready' });
})();

// ============================================================================
// ECHO SERVER CODE
// ============================================================================

async function main() {
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
