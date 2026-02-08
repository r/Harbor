#!/usr/bin/env node
/**
 * Test MCP.requestHost (browser capture) flow with the native bridge.
 *
 * 1. Start the bridge.
 * 2. Start a JS server that has a tool calling MCP.requestHost('browser.capturePage', { url }).
 * 3. Call that tool via js.call. The bridge sends host_request to stdout.
 * 4. Harness replies with host_response (mock result).
 * 5. Assert the js.call rpc_response contains the mock result.
 *
 * Run: node test-host-request.mjs
 * Requires: bridge built (cd bridge-rs && cargo build --release)
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function findBridgeBinary() {
  const possiblePaths = [
    path.resolve(__dirname, '../../bridge-rs/target/release/harbor-bridge'),
    path.resolve(__dirname, '../../bridge-rs/target/debug/harbor-bridge'),
    path.join(os.homedir(), '.harbor/harbor-bridge'),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function encodeMessage(message) {
  const json = JSON.stringify(message);
  const jsonBuffer = Buffer.from(json, 'utf-8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(jsonBuffer.length, 0);
  return Buffer.concat([lengthBuffer, jsonBuffer]);
}

function decodeMessage(buffer) {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32LE(0);
  if (buffer.length < 4 + length) return null;
  const json = buffer.slice(4, 4 + length).toString('utf-8');
  return { message: JSON.parse(json), bytesConsumed: 4 + length };
}

// JS server that has one tool: capture_page. It calls MCP.requestHost('browser.capturePage', { url }).
const SERVER_CODE = `
async function main() {
  while (true) {
    const line = await MCP.readLine();
    const request = JSON.parse(line);
    let response;
    if (request.method === 'tools/list') {
      response = {
        jsonrpc: '2.0',
        id: request.id,
        result: {
          tools: [{
            name: 'capture_page',
            description: 'Ask host to open URL and return content',
            inputSchema: {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url']
            }
          }]
        }
      };
    } else if (request.method === 'tools/call') {
      const url = (request.params && request.params.arguments && request.params.arguments.url) || 'https://example.com';
      try {
        const res = await MCP.requestHost('browser.capturePage', { url: url });
        response = {
          jsonrpc: '2.0',
          id: request.id,
          result: { content: [{ type: 'text', text: JSON.stringify(res) }] }
        };
      } catch (e) {
        response = {
          jsonrpc: '2.0',
          id: request.id,
          error: { code: -32000, message: String(e && e.message || e) }
        };
      }
    } else {
      response = { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
    }
    MCP.writeLine(JSON.stringify(response));
  }
}
main().catch(function(e) { console.error(e); });
`;

async function run() {
  const binaryPath = findBridgeBinary();
  if (!binaryPath) {
    console.error('Bridge binary not found. Run: cd bridge-rs && cargo build --release');
    process.exit(1);
  }

  const bridge = spawn(binaryPath, ['--native-messaging'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let outputBuffer = Buffer.alloc(0);
  let ready = false;
  let rpcResolve = null;
  let rpcReject = null;
  let rpcId = null;

  bridge.stdout.on('data', (data) => {
    outputBuffer = Buffer.concat([outputBuffer, data]);
    while (outputBuffer.length >= 4) {
      const result = decodeMessage(outputBuffer);
      if (!result) break;
      outputBuffer = outputBuffer.slice(result.bytesConsumed);
      const msg = result.message;

      if (msg.type === 'status' && msg.status === 'ready') {
        ready = true;
        continue;
      }
      if (msg.type === 'status') continue;

      // Bridge asked us (mock extension) to run a host method; reply with mock result.
      if (msg.type === 'host_request' && msg.id) {
        const mockResult = {
          content: 'mock page content',
          title: 'Mock Title',
          url: (msg.params && msg.params.url) || 'https://example.com',
        };
        bridge.stdin.write(
          encodeMessage({ type: 'host_response', id: msg.id, result: mockResult })
        );
        continue;
      }

      if (msg.type === 'rpc_response' && msg.id === rpcId && rpcResolve) {
        if (msg.error) {
          rpcReject(new Error(msg.error.message));
        } else {
          rpcResolve(msg.result);
        }
        rpcResolve = null;
        rpcReject = null;
        rpcId = null;
      }
    }
  });

  bridge.stderr.on('data', (d) => process.stderr.write(d));

  // Wait for ready
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('Bridge did not become ready')), 5000);
    const check = () => {
      if (ready) {
        clearTimeout(t);
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });

  // Start JS server
  const startResult = await new Promise((resolve, reject) => {
    rpcId = 'start-' + Date.now();
    rpcResolve = resolve;
    rpcReject = reject;
    bridge.stdin.write(
      encodeMessage({
        type: 'rpc',
        id: rpcId,
        method: 'js.start_server',
        params: {
          id: 'host-request-test',
          code: SERVER_CODE,
          env: {},
          capabilities: { network: { allowed_hosts: [] }, filesystem: { read_paths: [], write_paths: [] } },
        },
      })
    );
  }).then((r) => r, (e) => {
    throw e;
  });

  if (!startResult || !startResult.status) {
    throw new Error('Failed to start JS server: ' + JSON.stringify(startResult));
  }

  // Call the capture_page tool (this will trigger host_request inside the bridge)
  rpcId = 'call-' + Date.now();
  const callResult = await new Promise((resolve, reject) => {
    rpcResolve = resolve;
    rpcReject = reject;
    bridge.stdin.write(
      encodeMessage({
        type: 'rpc',
        id: rpcId,
        method: 'js.call',
        params: {
          id: 'host-request-test',
          request: {
            jsonrpc: '2.0',
            id: 'tool-call-1',
            method: 'tools/call',
            params: { name: 'capture_page', arguments: { url: 'https://example.com' } },
          },
          context: { origin: 'https://test.example' },
        },
      })
    );
  });

  bridge.kill();

  // callResult is the raw MCP response from the JS server. We need to find the text content.
  const content = callResult?.result?.content;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Expected result.content array, got: ' + JSON.stringify(callResult));
  }
  const text = content[0]?.text;
  if (!text) {
    throw new Error('Expected result.content[0].text, got: ' + JSON.stringify(callResult));
  }
  const parsed = JSON.parse(text);
  if (parsed.content !== 'mock page content' || parsed.title !== 'Mock Title') {
    throw new Error('Expected mock result in tool output, got: ' + text);
  }

  console.log('OK host_request flow: bridge sent host_request, we replied with host_response, tool returned mock result.');
}

run().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
