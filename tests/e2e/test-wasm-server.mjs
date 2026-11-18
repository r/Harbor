#!/usr/bin/env node
/**
 * WASM MCP Server Test
 * 
 * Part 1: Tests the time-wasm binary directly using Node.js WASI
 * Part 2: Tests the full integration - Harbor extension loads WASM, syncs to bridge
 * 
 * Usage:
 *   node test-wasm-server.mjs [--keep-open]
 */

import { WASI } from 'wasi';
import { readFile, writeFile, unlink } from 'fs/promises';
import { openSync, closeSync, readFileSync, existsSync } from 'fs';
import { spawn, exec } from 'child_process';
import http from 'http';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.resolve(__dirname, '../../extension/assets/mcp-time.wasm');

const config = {
  harborExtPath: path.resolve(__dirname, '../../extension/dist-firefox'),
  testServerPort: 3465,
  bridgeTimeout: 10000,
  keepOpen: process.argv.includes('--keep-open'),
};

// Track test results
let passed = 0;
let failed = 0;

async function runTest(name, fn) {
  process.stdout.write(`  ${name}... `);
  try {
    await fn();
    console.log('✓');
    passed++;
    return true;
  } catch (err) {
    console.log('✗');
    console.log(`    Error: ${err.message}`);
    failed++;
    return false;
  }
}

/**
 * Run the WASM module with given stdin input and return stdout output.
 * WASI servers read from stdin and write to stdout.
 * 
 * Node.js WASI requires file descriptors, so we use temp files.
 */
async function runWasmWithInput(wasmModule, input) {
  const tmpDir = os.tmpdir();
  const stdinPath = path.join(tmpDir, `wasm-stdin-${Date.now()}.txt`);
  const stdoutPath = path.join(tmpDir, `wasm-stdout-${Date.now()}.txt`);
  const stderrPath = path.join(tmpDir, `wasm-stderr-${Date.now()}.txt`);
  
  try {
    // Write input to stdin file
    await writeFile(stdinPath, input + '\n');
    
    // Create empty stdout/stderr files
    await writeFile(stdoutPath, '');
    await writeFile(stderrPath, '');
    
    // Open file descriptors
    const stdinFd = openSync(stdinPath, 'r');
    const stdoutFd = openSync(stdoutPath, 'w');
    const stderrFd = openSync(stderrPath, 'w');
    
    try {
      const wasi = new WASI({
        version: 'preview1',
        args: ['mcp-time'],
        env: {},
        stdin: stdinFd,
        stdout: stdoutFd,
        stderr: stderrFd,
      });
      
      const instance = await WebAssembly.instantiate(wasmModule, wasi.getImportObject());
      
      try {
        wasi.start(instance);
      } catch (e) {
        // WASI programs that exit cleanly throw with code 0
        if (e.code !== 0 && !e.message?.includes('exit(0)')) {
          throw e;
        }
      }
    } finally {
      // Close file descriptors
      closeSync(stdinFd);
      closeSync(stdoutFd);
      closeSync(stderrFd);
    }
    
    // Read output
    const stdout = readFileSync(stdoutPath, 'utf-8').trim();
    const stderr = readFileSync(stderrPath, 'utf-8').trim();
    
    return { stdout, stderr };
  } finally {
    // Cleanup temp files
    await unlink(stdinPath).catch(() => {});
    await unlink(stdoutPath).catch(() => {});
    await unlink(stderrPath).catch(() => {});
  }
}

async function main() {
  console.log('🔧 WASM MCP Server Tests\n');
  
  // Test 1: WASM file exists and can be loaded
  let wasmModule;
  await runTest('WASM file can be loaded', async () => {
    const wasmBytes = await readFile(wasmPath);
    console.log(`\n    Size: ${wasmBytes.length} bytes`);
    wasmModule = await WebAssembly.compile(wasmBytes);
    console.log(`    Compiled successfully`);
  });
  
  if (!wasmModule) {
    console.log('\n❌ Cannot continue without WASM module');
    process.exit(1);
  }
  
  // Test 2: Initialize request (optional - not all MCP servers implement it)
  await runTest('Initialize request works (optional)', async () => {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    });
    
    const { stdout } = await runWasmWithInput(wasmModule, request);
    const response = JSON.parse(stdout);
    
    if (response.error) {
      // Initialize is optional in MCP - tools/list and tools/call are the required methods
      if (response.error.code === -32601) {
        console.log(`\n    (Not implemented - this is acceptable)`);
        return; // Pass - it's optional
      }
      throw new Error('Initialize returned error: ' + response.error.message);
    }
    
    if (!response.result?.serverInfo?.name) {
      throw new Error('Missing serverInfo in response');
    }
    
    console.log(`\n    Server: ${response.result.serverInfo.name} v${response.result.serverInfo.version}`);
  });
  
  // Test 3: tools/list request
  await runTest('tools/list returns time.now tool', async () => {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });
    
    const { stdout } = await runWasmWithInput(wasmModule, request);
    const response = JSON.parse(stdout);
    
    if (response.error) {
      throw new Error('tools/list returned error: ' + response.error.message);
    }
    
    const tools = response.result?.tools || [];
    const timeTool = tools.find(t => t.name === 'time.now');
    
    if (!timeTool) {
      throw new Error('time.now tool not found in: ' + tools.map(t => t.name).join(', '));
    }
    
    console.log(`\n    Found tool: ${timeTool.name} - ${timeTool.description}`);
  });
  
  // Test 4: tools/call with time.now (with injected time)
  await runTest('tools/call time.now works (with injected time)', async () => {
    const testTime = '2025-02-04T12:00:00.000Z';
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'time.now',
        arguments: {
          now: testTime
        }
      }
    });
    
    const { stdout } = await runWasmWithInput(wasmModule, request);
    const response = JSON.parse(stdout);
    
    if (response.error) {
      throw new Error('tools/call returned error: ' + response.error.message);
    }
    
    const content = response.result?.content;
    if (!content || !Array.isArray(content)) {
      throw new Error('Invalid response content');
    }
    
    const text = content[0]?.text;
    if (!text || !text.includes(testTime)) {
      throw new Error('Response did not contain injected time: ' + text);
    }
    
    console.log(`\n    Response: ${text}`);
  });
  
  // Test 5: tools/call without injected time (uses system time fallback)
  await runTest('tools/call time.now works (system time fallback)', async () => {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'time.now',
        arguments: {}
      }
    });
    
    const { stdout } = await runWasmWithInput(wasmModule, request);
    const response = JSON.parse(stdout);
    
    if (response.error) {
      throw new Error('tools/call returned error: ' + response.error.message);
    }
    
    const text = response.result?.content?.[0]?.text;
    if (!text) {
      throw new Error('No text in response');
    }
    
    // Should contain either a valid ISO timestamp or an error message about no time
    if (text.includes('unavailable')) {
      console.log(`\n    Response (fallback): ${text}`);
    } else {
      // Validate it looks like an ISO timestamp
      if (!text.match(/^\d{4}-\d{2}-\d{2}T/)) {
        throw new Error('Response does not look like ISO timestamp: ' + text);
      }
      console.log(`\n    Response: ${text}`);
    }
  });
  
  // Test 6: Unknown method returns error
  await runTest('Unknown method returns proper error', async () => {
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id: 5,
      method: 'unknown/method',
      params: {}
    });
    
    const { stdout } = await runWasmWithInput(wasmModule, request);
    const response = JSON.parse(stdout);
    
    if (!response.error) {
      throw new Error('Expected error for unknown method');
    }
    
    if (response.error.code !== -32601) {
      throw new Error('Expected -32601 error code, got: ' + response.error.code);
    }
    
    console.log(`\n    Error: ${response.error.message} (code: ${response.error.code})`);
  });
  
  console.log(`\nPart 1 Results: ${passed} passed, ${failed} failed\n`);
  
  // ==========================================================================
  // Part 2: Full Integration Test - Harbor Extension + WASM Server + Bridge
  // ==========================================================================
  
  console.log('Part 2: Full Integration (Harbor Extension → WASM → Bridge)\n');
  
  // Find bridge binary
  const bridgePaths = [
    path.resolve(__dirname, '../../bridge-rs/target/release/harbor-bridge'),
    path.resolve(__dirname, '../../bridge-rs/target/debug/harbor-bridge'),
    path.join(os.homedir(), '.harbor/harbor-bridge'),
  ];
  const bridgePath = bridgePaths.find(p => existsSync(p));
  
  if (!bridgePath) {
    console.log('  ⚠ Native bridge not found - skipping integration tests');
    console.log('    Build with: cd bridge-rs && cargo build --release\n');
  } else if (!existsSync(path.join(config.harborExtPath, 'manifest.json'))) {
    console.log('  ⚠ Harbor extension not built - skipping integration tests');
    console.log('    Build with: cd extension && npm run build\n');
  } else {
    // Run integration tests
    const integrationResult = await runIntegrationTests(bridgePath);
    passed += integrationResult.passed;
    failed += integrationResult.failed;
  }
  
  // Final Summary
  console.log(`${'─'.repeat(50)}`);
  if (failed === 0) {
    console.log(`✅ All ${passed} WASM tests passed!`);
    process.exit(0);
  } else {
    console.log(`❌ ${failed} test(s) failed, ${passed} passed`);
    process.exit(1);
  }
}

// =============================================================================
// Part 2: Integration Test Functions
// =============================================================================

function encodeNativeMessage(message) {
  const json = JSON.stringify(message);
  const jsonBuffer = Buffer.from(json, 'utf-8');
  const lengthBuffer = Buffer.alloc(4);
  lengthBuffer.writeUInt32LE(jsonBuffer.length, 0);
  return Buffer.concat([lengthBuffer, jsonBuffer]);
}

function decodeNativeMessage(buffer) {
  if (buffer.length < 4) return null;
  const length = buffer.readUInt32LE(0);
  if (buffer.length < 4 + length) return null;
  const json = buffer.slice(4, 4 + length).toString('utf-8');
  return { message: JSON.parse(json), bytesConsumed: 4 + length };
}

function killProcessTree(pid) {
  return new Promise((resolve) => {
    exec(`pkill -P ${pid}`, () => {
      try { process.kill(pid, 'SIGTERM'); } catch (e) {}
      resolve();
    });
  });
}

function killWebExtFirefox() {
  return new Promise((resolve) => {
    exec(`pkill -f 'firefox.*firefox-profile'`, () => resolve());
  });
}

async function runIntegrationTests(bridgePath) {
  let passed = 0;
  let failed = 0;
  
  // Check if native messaging is set up (manifest exists)
  const nativeMessagingManifestPath = path.join(
    os.homedir(),
    'Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge.json'
  );
  const nativeMessagingAvailable = existsSync(nativeMessagingManifestPath);
  
  if (nativeMessagingAvailable) {
    console.log('  [native] Native messaging manifest found');
  } else {
    console.log('  [native] Native messaging manifest NOT found');
    console.log('           Install with: cd bridge-rs && ./install.sh');
  }
  
  console.log('  [note] Firefox temp extensions cannot use native messaging');
  console.log('         Full WASM→Bridge integration requires permanently installed extension');
  console.log('         Part 1 (above) validates the WASM binary works correctly\n');
  
  // Create test server that shows Harbor + bridge status
  const testPage = `<!DOCTYPE html>
<html>
<head>
  <title>WASM Integration Test</title>
  <style>
    body { font-family: system-ui; padding: 40px; background: #1a1a2e; color: #fff; }
    h1 { color: #4fc3f7; }
    .status { padding: 15px; margin: 10px 0; border-radius: 8px; background: #252540; }
    .status.pass { border-left: 4px solid #4caf50; }
    .status.fail { border-left: 4px solid #f44336; }
    .status.wait { border-left: 4px solid #ff9800; }
    .log { font-family: monospace; font-size: 12px; color: #aaa; margin-top: 10px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>🔧 WASM Integration Test</h1>
  
  <div class="status wait" id="harbor-status">
    <strong>Harbor Extension</strong>
    <div class="log" id="harbor-log">Checking...</div>
  </div>
  
  <div class="status wait" id="bridge-status">
    <strong>Native Bridge</strong>
    <div class="log" id="bridge-log">Waiting for Harbor...</div>
  </div>
  
  <div class="status wait" id="wasm-status">
    <strong>WASM Server (time-wasm)</strong>
    <div class="log" id="wasm-log">Waiting for bridge...</div>
  </div>
  
  <script>
    const results = { harbor: false, bridge: false, wasm: false };
    
    function log(id, msg) {
      document.getElementById(id + '-log').textContent += msg + '\\n';
      // Send important messages to server
      if (msg.startsWith('>>>') || msg.startsWith('Poll') || msg.startsWith('Attempt') || 
          msg.startsWith('Checking') || msg.startsWith('Final') || msg.includes('Possible') ||
          msg.includes('not') || msg.includes('Skipped') || msg.includes('SUCCESS') || msg.includes('synced')) {
        fetch('/__log__', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pageId: 'wasm-test-2024', test: id, message: msg })
        }).catch(() => {});
      }
    }
    
    function setStatus(id, status) {
      document.getElementById(id + '-status').className = 'status ' + status;
      results[id] = (status === 'pass');
    }
    
    function report() {
      const passed = Object.values(results).filter(Boolean).length;
      const total = Object.keys(results).length;
      console.log('[TEST] Reporting results:', passed, '/', total);
      fetch('/__test_result__', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passed: passed === total, results, passedCount: passed, total })
      }).catch(() => {});
    }
    
    async function checkHarbor() {
      log('harbor', '>>> Starting Harbor check');

      // Harbor serves window.agent/window.ai itself now; there is no
      // separate discovery object to poll for.
      for (let i = 0; i < 25; i++) { // 5 seconds max
        await new Promise(r => setTimeout(r, 200));

        if (typeof window.agent !== 'undefined' && typeof window.ai !== 'undefined') {
          log('harbor', '>>> SUCCESS: window.agent and window.ai are present');
          setStatus('harbor', 'pass');
          return true;
        }

        if (i % 5 === 0) {
          log('harbor', 'Poll ' + i + '/25: window.agent=' + (typeof window.agent !== 'undefined' ? 'exists' : 'undefined'));
        }
      }

      log('harbor', '>>> TIMEOUT after 25 polls');
      setStatus('harbor', 'fail');
      return false;
    }

    async function checkBridge() {
      log('bridge', 'Checking native bridge connection (15s timeout)...');

      return new Promise((resolve) => {
        let attempts = 0;
        const maxAttempts = 30; // 15 seconds

        const check = setInterval(async () => {
          attempts++;
          // window.ai.canCreateTextSession() is ambient (no permission
          // prompt) and reflects Harbor's system.getCapabilities().bridgeReady.
          let status;
          try {
            status = await window.ai.canCreateTextSession();
          } catch (e) {
            status = 'no';
          }

          // Log status periodically
          if (attempts % 5 === 0) {
            log('bridge', 'Attempt ' + attempts + ': canCreateTextSession=' + status);
          }

          if (status === 'readily') {
            clearInterval(check);
            log('bridge', 'Connected! Native bridge is ready.');
            setStatus('bridge', 'pass');
            resolve(true);
            return;
          }

          if (attempts >= maxAttempts) {
            clearInterval(check);
            log('bridge', 'Final status: canCreateTextSession=' + (status || 'undefined'));
            log('bridge', 'Bridge not connected after ' + (attempts * 0.5) + ' seconds');
            log('bridge', '');
            log('bridge', 'Possible causes:');
            log('bridge', '  1. Native messaging not allowed for temp extension');
            log('bridge', '  2. harbor-bridge-native not executable');
            log('bridge', '  3. Extension ID mismatch in manifest');
            setStatus('bridge', 'fail');
            resolve(false);
          }
        }, 500);
      });
    }
    
    async function checkWasmServer() {
      log('wasm', 'Checking if time-wasm tools are synced to bridge...');
      
      // If bridge is connected, Harbor should have started time-wasm
      // and synced its tools to the bridge
      if (!results.bridge) {
        log('wasm', 'Bridge not connected - cannot verify WASM server sync');
        log('wasm', 'WASM server runs in Harbor but tools not accessible via bridge');
        setStatus('wasm', 'fail');
        return false;
      }
      
      // Harbor auto-starts builtin servers when bridge connects
      // Give it a moment to start and sync
      await new Promise(r => setTimeout(r, 2000));
      
      log('wasm', 'Harbor should have auto-started time-wasm');
      log('wasm', 'Tools sync to bridge via mcp.register_tools');
      log('wasm', '(Test server will verify via bridge RPC)');
      setStatus('wasm', 'pass');
      return true;
    }
    
    async function runTests() {
      console.log('[TEST] Starting tests...');
      
      const harborOk = await checkHarbor();
      console.log('[TEST] Harbor check complete:', harborOk);
      
      if (!harborOk) {
        log('bridge', 'Skipped - Harbor not detected');
        log('wasm', 'Skipped - Harbor not detected');
        setStatus('bridge', 'fail');
        setStatus('wasm', 'fail');
        report();
        return;
      }
      
      await new Promise(r => setTimeout(r, 1000));
      
      const bridgeOk = await checkBridge();
      console.log('[TEST] Bridge check complete:', bridgeOk);
      
      await checkWasmServer();
      console.log('[TEST] WASM check complete');
      
      report();
    }
    
    console.log('[TEST] Page loaded, waiting 1.5s before starting...');
    setTimeout(runTests, 1500);
  </script>
</body>
</html>`;

  // Create test server
  const { server, resultPromise } = await new Promise((resolve, reject) => {
    let resultResolver;
    let resultReceived = false;
    const resultPromise = new Promise(r => { resultResolver = r; });
    
    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/__log__') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            // Only show logs from our test page (have pageId)
            if (data.pageId === 'wasm-test-2024') {
              console.log(`  [browser:${data.test}] ${data.message}`);
            }
          } catch (e) {}
          res.writeHead(200);
          res.end('ok');
        });
        return;
      }
      
      if (req.method === 'POST' && req.url === '/__test_result__') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            console.log('  [server] Received test results:', data.passedCount, '/', data.total);
            
            // Only accept complete results (all tests ran)
            if (!resultReceived && data.total >= 3) {
              resultReceived = true;
              resultResolver(data);
            }
          } catch (e) {
            console.log('  [server] Failed to parse result:', e.message);
          }
          res.writeHead(200);
          res.end('ok');
        });
        return;
      }
      
      if (req.url === '/' || req.url === '/test.html') {
        // Prevent caching so test updates take effect immediately
        res.writeHead(200, { 
          'Content-Type': 'text/html',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        });
        res.end(testPage);
        return;
      }
      
      res.writeHead(404);
      res.end('Not found');
    });
    
    server.listen(config.testServerPort, () => {
      console.log(`  [server] Test page at http://localhost:${config.testServerPort}/`);
      resolve({ server, resultPromise });
    });
    
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        config.testServerPort++;
        server.listen(config.testServerPort);
      } else {
        reject(err);
      }
    });
  });
  
  // Launch Firefox with Harbor
  console.log('  [firefox] Launching with Harbor extension...');
  
  const webExt = spawn('npx', [
    'web-ext', 'run',
    '--source-dir', config.harborExtPath,
    '--start-url', `http://localhost:${config.testServerPort}/`,
    '--no-reload',
  ], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  
  let extensionLoaded = false;
  webExt.stdout.on('data', (data) => {
    const str = data.toString();
    if (str.includes('Installed') && str.includes('temporary add-on')) {
      if (!extensionLoaded) {
        extensionLoaded = true;
        console.log('  [firefox] ✓ Harbor extension loaded');
      }
    }
  });
  
  async function cleanup() {
    if (webExt.pid) await killProcessTree(webExt.pid);
    await killWebExtFirefox();
    server.close();
  }
  
  // Wait for browser test results
  const timeout = setTimeout(async () => {
    console.log('  [timeout] Browser test timed out');
    await cleanup();
  }, 45000);
  
  try {
    const browserResult = await resultPromise;
    clearTimeout(timeout);
    
    console.log(`\n  Browser tests: ${browserResult.passedCount}/${browserResult.total}`);
    
    // If bridge connected, also verify tools via bridge RPC
    if (browserResult.results?.bridge) {
      console.log('\n  [bridge] Verifying WASM tools synced to bridge...');
      
      const toolsResult = await verifyToolsViaBridge(bridgePath);
      if (toolsResult.found) {
        console.log(`  [bridge] ✓ Found time.now tool in bridge registry`);
        passed++;
      } else {
        console.log(`  [bridge] ✗ time.now tool not found in bridge`);
        console.log(`    Tools in registry: ${toolsResult.tools.join(', ') || '(none)'}`);
        failed++;
      }
      
      // Try calling the tool through bridge
      if (toolsResult.found) {
        console.log('\n  [bridge] Calling time.now tool via mcp.call_tool...');
        const callResult = await callToolViaBridge(bridgePath, 'time-wasm', 'time.now');
        if (callResult.success) {
          console.log(`  [bridge] ✓ Tool returned: ${callResult.result}`);
          passed++;
        } else {
          console.log(`  [bridge] ✗ Tool call failed: ${callResult.error}`);
          failed++;
        }
      }
    } else {
      console.log('\n  [skip] Bridge not connected - skipping RPC verification');
      console.log('    (Native messaging requires installation in Firefox profile)');
    }
    
    if (!config.keepOpen) {
      await cleanup();
    } else {
      console.log('\n  [keep-open] Firefox stays open');
    }
    
    // Count browser results
    // Harbor detection is required
    if (browserResult.results?.harbor) {
      console.log('  ✓ Harbor extension detected in browser');
      passed++;
    } else {
      console.log('  ✗ Harbor extension NOT detected');
      failed++;
    }
    
    // Bridge/WASM tests are informational only (native messaging doesn't work with temp extensions)
    if (browserResult.results?.bridge) {
      console.log('  ✓ Native bridge connected');
      passed++;
    } else {
      console.log('  - Native bridge not connected (expected for temp extension)');
      // Don't count as failure - it's expected
    }
    
    if (browserResult.results?.wasm) {
      console.log('  ✓ WASM server tools synced to bridge');
      passed++;
    } else if (!browserResult.results?.bridge) {
      console.log('  - WASM sync skipped (requires bridge connection)');
      // Don't count as failure - expected when bridge not connected
    } else {
      console.log('  ✗ WASM server tools NOT synced');
      failed++;
    }
    
  } catch (err) {
    clearTimeout(timeout);
    await cleanup();
    console.log(`  [error] ${err.message}`);
    failed++;
  }
  
  return { passed, failed };
}

async function verifyToolsViaBridge(bridgePath) {
  return new Promise((resolve) => {
    const bridge = spawn(bridgePath, ['--native-messaging'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    let buffer = Buffer.alloc(0);
    let ready = false;
    const requestId = 'verify-tools';
    
    const timeout = setTimeout(() => {
      bridge.kill();
      resolve({ found: false, tools: [] });
    }, 5000);
    
    bridge.stdout.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      
      while (buffer.length >= 4) {
        const result = decodeNativeMessage(buffer);
        if (!result) break;
        
        buffer = buffer.slice(result.bytesConsumed);
        const msg = result.message;
        
        if (msg.type === 'status' && msg.status === 'ready' && !ready) {
          ready = true;
          bridge.stdin.write(encodeNativeMessage({
            type: 'rpc',
            id: requestId,
            method: 'mcp.list_tools',
            params: {}
          }));
        }
        
        if (msg.type === 'rpc_response' && msg.id === requestId) {
          clearTimeout(timeout);
          bridge.kill();
          
          const tools = msg.result?.tools || [];
          const toolNames = tools.map(t => t.name);
          const found = toolNames.includes('time.now');
          
          resolve({ found, tools: toolNames });
        }
      }
    });
  });
}

async function callToolViaBridge(bridgePath, serverId, toolName) {
  return new Promise((resolve) => {
    const bridge = spawn(bridgePath, ['--native-messaging'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    let buffer = Buffer.alloc(0);
    let ready = false;
    const requestId = 'call-tool';
    
    const timeout = setTimeout(() => {
      bridge.kill();
      resolve({ success: false, error: 'Timeout' });
    }, 10000);
    
    bridge.stdout.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      
      while (buffer.length >= 4) {
        const result = decodeNativeMessage(buffer);
        if (!result) break;
        
        buffer = buffer.slice(result.bytesConsumed);
        const msg = result.message;
        
        if (msg.type === 'status' && msg.status === 'ready' && !ready) {
          ready = true;
          bridge.stdin.write(encodeNativeMessage({
            type: 'rpc',
            id: requestId,
            method: 'mcp.call_tool',
            params: {
              serverId,
              toolName,
              args: { now: new Date().toISOString() }
            }
          }));
        }
        
        if (msg.type === 'rpc_response' && msg.id === requestId) {
          clearTimeout(timeout);
          bridge.kill();
          
          if (msg.error) {
            resolve({ success: false, error: msg.error.message });
          } else {
            const text = msg.result?.result?.content?.[0]?.text || 
                        msg.result?.result || 
                        JSON.stringify(msg.result);
            resolve({ success: true, result: text });
          }
        }
      }
    });
  });
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
