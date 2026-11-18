#!/usr/bin/env node
/**
 * LLM Integration Test
 * 
 * Tests the full LLM flow:
 * 1. List providers through native bridge
 * 2. List available/configured models
 * 3. Launch Firefox with Harbor extension
 * 4. Test model selection and chat via the extension's window.ai API
 * 
 * Requirements:
 *   - harbor-bridge built and installed
 *   - Ollama (or another local LLM) running
 * 
 * Usage:
 *   node test-llm-integration.mjs [--keep-open]
 */

import { spawn, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = {
  harborExtPath: path.resolve(__dirname, '../../extension/dist-firefox'),
  testServerPort: 3459,
  timeout: 60000, // LLM responses can take time
  keepOpen: process.argv.includes('--keep-open'),
};

// Track processes for cleanup
let childProcesses = [];

// =============================================================================
// Native Bridge Helpers
// =============================================================================

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

// Send RPC to bridge and get response
function bridgeRPC(binaryPath, method, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const bridge = spawn(binaryPath, ['--native-messaging'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    
    const requestId = `test-${Date.now()}`;
    let outputBuffer = Buffer.alloc(0);
    
    const timeout = setTimeout(() => {
      bridge.kill();
      reject(new Error(`Timeout waiting for ${method}`));
    }, timeoutMs);
    
    bridge.stdout.on('data', (data) => {
      outputBuffer = Buffer.concat([outputBuffer, data]);
      
      while (outputBuffer.length >= 4) {
        const result = decodeMessage(outputBuffer);
        if (!result) break;
        
        outputBuffer = outputBuffer.slice(result.bytesConsumed);
        const msg = result.message;
        
        if (msg.type === 'rpc_response' && msg.id === requestId) {
          clearTimeout(timeout);
          bridge.kill();
          
          if (msg.error) {
            reject(new Error(`RPC error: ${msg.error.message}`));
          } else {
            resolve(msg.result);
          }
        }
      }
    });
    
    bridge.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    
    // Wait for bridge to initialize, then send RPC
    setTimeout(() => {
      bridge.stdin.write(encodeMessage({
        type: 'rpc',
        id: requestId,
        method,
        params,
      }));
    }, 300);
  });
}

// =============================================================================
// Firefox Cleanup
// =============================================================================

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

// =============================================================================
// Test Server & Page
// =============================================================================

function createTestServer(models) {
  return new Promise((resolve, reject) => {
    let resultResolver = null;
    const resultPromise = new Promise(r => { resultResolver = r; });
    
    // Generate model options for the dropdown
    const modelOptions = models.map(m => 
      `<option value="${m.id || m.model_id}">${m.id || m.model_id}</option>`
    ).join('\n');
    
    const testPage = `<!DOCTYPE html>
<html>
<head>
  <title>LLM Integration Test</title>
  <style>
    body {
      font-family: -apple-system, sans-serif;
      padding: 40px;
      background: #1a1a2e;
      color: #fff;
      max-width: 800px;
      margin: 0 auto;
    }
    h1 { color: #4fc3f7; margin-bottom: 20px; }
    .section {
      margin: 20px 0;
      padding: 20px;
      background: #252540;
      border-radius: 8px;
    }
    .section h2 { margin-top: 0; font-size: 16px; color: #90caf9; }
    select, button {
      padding: 10px 20px;
      font-size: 14px;
      border-radius: 4px;
      border: 1px solid #444;
      background: #333;
      color: #fff;
      margin-right: 10px;
    }
    button { cursor: pointer; background: #4fc3f7; color: #000; border: none; }
    button:hover { background: #80d8ff; }
    button:disabled { background: #666; cursor: not-allowed; }
    .log { 
      margin-top: 10px;
      padding: 10px;
      background: #1a1a2e;
      border-radius: 4px;
      font-family: monospace;
      font-size: 12px;
      max-height: 200px;
      overflow-y: auto;
      white-space: pre-wrap;
    }
    .status { padding: 10px; border-radius: 4px; margin-top: 10px; }
    .status.pass { background: #1b5e20; }
    .status.fail { background: #b71c1c; }
    .status.waiting { background: #f57c00; }
    #response-preview {
      margin-top: 10px;
      padding: 15px;
      background: #1a1a2e;
      border-radius: 4px;
      min-height: 60px;
    }
  </style>
</head>
<body>
  <h1>🚢 LLM Integration Test</h1>
  
  <div class="section">
    <h2>1. Harbor Extension Status</h2>
    <div class="status waiting" id="harbor-status">Checking...</div>
  </div>
  
  <div class="section">
    <h2>2. Model Selection</h2>
    <select id="model-select">
      <option value="">-- Select a model --</option>
      ${modelOptions}
    </select>
    <button id="test-btn" disabled>Test Selected Model</button>
    <div class="log" id="model-log"></div>
  </div>
  
  <div class="section">
    <h2>3. LLM Response</h2>
    <div id="response-preview">Waiting for test...</div>
    <div class="status waiting" id="test-status">Not started</div>
  </div>
  
  <script>
    const TIMEOUT = 45000;
    const TEST_PROMPT = "Say hello in exactly 5 words.";
    
    function log(msg) {
      console.log('[LLMTest] ' + msg);
      const el = document.getElementById('model-log');
      el.textContent += new Date().toLocaleTimeString() + ' ' + msg + '\\n';
      el.scrollTop = el.scrollHeight;
    }
    
    function setStatus(id, text, status) {
      const el = document.getElementById(id);
      el.textContent = text;
      el.className = 'status ' + status;
    }
    
    function reportResult(passed, message, details = {}) {
      fetch('/__test_result__', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passed, message, ...details })
      }).catch(() => {});
    }
    
    // Check for Harbor's page API (window.agent/window.ai), which Harbor
    // injects itself now — there is no separate discovery object to poll for.
    async function checkHarbor() {
      log('Checking for Harbor\'s page API...');

      if (typeof window.agent !== 'undefined' && typeof window.ai !== 'undefined') {
        log('Harbor detected via window.agent/window.ai');
        return true;
      }

      // Poll briefly in case the content script hasn't injected yet.
      return new Promise((resolve) => {
        const poll = setInterval(() => {
          if (typeof window.agent !== 'undefined' && typeof window.ai !== 'undefined') {
            clearInterval(poll);
            resolve(true);
          }
        }, 200);
        setTimeout(() => {
          clearInterval(poll);
          log('Harbor detection timeout');
          resolve(false);
        }, 5000);
      });
    }

    // Check if window.ai API is available (injected by Harbor itself)
    async function checkAIAPI() {
      log('Checking for AI API...');

      if (typeof window.ai !== 'undefined') {
        log('window.ai API available');
        return { type: 'window.ai', api: window.ai };
      }

      log('window.ai not available');
      return null;
    }
    
    // Test a model by creating a session and sending a prompt
    async function testModel(modelId) {
      log('Testing model: ' + modelId);
      setStatus('test-status', 'Creating session...', 'waiting');
      document.getElementById('response-preview').textContent = 'Creating session...';
      
      try {
        // Create a session (the model selection happens in the extension's config)
        // For now, we test with the default configured model
        log('Creating text session...');
        const session = await window.ai.createTextSession();
        log('Session created: ' + (session.sessionId || 'ok'));
        
        setStatus('test-status', 'Sending prompt...', 'waiting');
        document.getElementById('response-preview').textContent = 'Sending: "' + TEST_PROMPT + '"';
        
        // Send a simple prompt
        log('Sending prompt: ' + TEST_PROMPT);
        const startTime = Date.now();
        
        let response = '';
        for await (const event of session.promptStreaming(TEST_PROMPT)) {
          if (event.type === 'token' && event.token) {
            response += event.token;
            document.getElementById('response-preview').textContent = response;
          } else if (event.type === 'error') {
            throw new Error(event.error?.message || 'Stream error');
          }
        }
        
        const elapsed = Date.now() - startTime;
        log('Response received in ' + elapsed + 'ms: ' + response.slice(0, 100));
        
        // Cleanup
        await session.destroy();
        log('Session destroyed');
        
        // Validate response
        if (!response || response.trim().length === 0) {
          throw new Error('Empty response from LLM');
        }
        
        setStatus('test-status', 'PASSED - Got response in ' + elapsed + 'ms', 'pass');
        document.getElementById('response-preview').textContent = response;
        
        reportResult(true, 'LLM responded successfully', { 
          model: modelId,
          elapsed,
          responseLength: response.length,
          responsePreview: response.slice(0, 200)
        });
        
      } catch (err) {
        log('Error: ' + err.message);
        setStatus('test-status', 'FAILED: ' + err.message, 'fail');
        document.getElementById('response-preview').textContent = 'Error: ' + err.message;
        reportResult(false, err.message, { model: modelId });
      }
    }
    
    // Main test flow
    async function runTest() {
      log('Starting LLM integration test...');
      
      // Step 1: Check Harbor
      const harborOk = await checkHarbor();
      if (!harborOk) {
        setStatus('harbor-status', 'Harbor extension not detected', 'fail');
        reportResult(false, 'Harbor extension not detected');
        return;
      }
      setStatus('harbor-status', 'Harbor extension detected ✓', 'pass');
      
      // Step 2: Check AI API
      const aiApi = await checkAIAPI();
      if (!aiApi) {
        setStatus('harbor-status', 'Harbor detected but window.ai not available', 'fail');
        log('Note: This test requires the Web Agents API extension for window.ai');
        reportResult(false, 'window.ai API not available - need Web Agents API extension');
        return;
      }
      
      // Step 3: Enable model selection
      const select = document.getElementById('model-select');
      const testBtn = document.getElementById('test-btn');
      
      if (select.options.length <= 1) {
        log('No models available in dropdown');
        setStatus('test-status', 'No models to test', 'fail');
        reportResult(false, 'No models available');
        return;
      }
      
      log('Found ' + (select.options.length - 1) + ' models');
      
      // Auto-select first available model and test
      select.selectedIndex = 1; // First real option
      const selectedModel = select.value;
      log('Auto-selected model: ' + selectedModel);
      
      testBtn.disabled = false;
      testBtn.onclick = () => testModel(select.value);
      
      // Auto-run test
      await testModel(selectedModel);
    }
    
    // Start after a brief delay
    setTimeout(runTest, 1500);
  </script>
</body>
</html>`;

    const server = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/__test_result__') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const result = JSON.parse(body);
            resultResolver(result);
          } catch (e) {}
          res.writeHead(200);
          res.end('ok');
        });
        return;
      }
      
      if (req.url === '/' || req.url === '/test.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(testPage);
        return;
      }
      
      res.writeHead(404);
      res.end('Not found');
    });
    
    server.listen(config.testServerPort, () => {
      console.log(`[server] Test page at http://localhost:${config.testServerPort}/`);
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
}

// =============================================================================
// Main Test
// =============================================================================

async function main() {
  console.log('🚢 LLM Integration Test\n');
  
  // Step 1: Find bridge binary
  const binaryPath = findBridgeBinary();
  if (!binaryPath) {
    console.error('❌ Native bridge binary not found');
    console.error('   Run: cd bridge-rs && cargo build --release');
    process.exit(1);
  }
  console.log('[bridge] Found:', binaryPath);
  
  // Step 2: Check for available providers
  console.log('\n[step 1] Checking LLM providers via native bridge...');
  let providers;
  try {
    const result = await bridgeRPC(binaryPath, 'llm.list_providers', {}, 15000);
    providers = result.providers || [];
    console.log(`[bridge] Found ${providers.length} provider(s)`);
    
    const localAvailable = providers.filter(p => p.is_local && p.available);
    if (localAvailable.length > 0) {
      console.log(`[bridge] ✓ Local LLM available: ${localAvailable.map(p => p.name || p.id).join(', ')}`);
    } else {
      console.log('[bridge] ⚠ No local LLM running (Ollama, etc.)');
      console.log('[bridge]   Some tests may fail without a local LLM');
    }
  } catch (err) {
    console.error('[bridge] ✗ Failed to list providers:', err.message);
    process.exit(1);
  }
  
  // Step 3: List available models
  console.log('\n[step 2] Listing available models...');
  let models = [];
  try {
    const result = await bridgeRPC(binaryPath, 'llm.list_models', {}, 20000);
    models = result.models || [];
    console.log(`[bridge] Found ${models.length} model(s)`);
    
    if (models.length > 0) {
      // Show first few
      const shown = models.slice(0, 5);
      for (const m of shown) {
        console.log(`[bridge]   - ${m.id}`);
      }
      if (models.length > 5) {
        console.log(`[bridge]   ... and ${models.length - 5} more`);
      }
    }
  } catch (err) {
    console.error('[bridge] ✗ Failed to list models:', err.message);
  }
  
  // Step 4: Check configured models
  console.log('\n[step 3] Checking configured models...');
  let configuredModels = [];
  try {
    const result = await bridgeRPC(binaryPath, 'llm.list_configured_models', {}, 10000);
    configuredModels = result.models || [];
    console.log(`[bridge] ${configuredModels.length} configured model(s)`);
    
    const defaultModel = configuredModels.find(m => m.is_default);
    if (defaultModel) {
      console.log(`[bridge] Default: ${defaultModel.model_id || defaultModel.name}`);
    }
  } catch (err) {
    console.log('[bridge] No configured models (using auto-detected)');
  }
  
  // Use configured models if available, otherwise fall back to all models
  const modelsForTest = configuredModels.length > 0 ? configuredModels : models;
  
  if (modelsForTest.length === 0) {
    console.log('\n⚠ No models available to test');
    console.log('  Make sure Ollama is running with at least one model pulled');
    console.log('  Or configure a cloud provider in Harbor settings');
    process.exit(0); // Not a failure - just nothing to test
  }
  
  // Step 5: Test via Firefox with extensions
  console.log('\n[step 4] Testing model selection in browser...');
  console.log('[note] This test requires BOTH Harbor AND Web Agents API extensions');
  console.log('[note] The test will use the first available model\n');
  
  // Check if extensions are built
  const harborManifest = path.join(config.harborExtPath, 'manifest.json');
  const webAgentsManifest = path.resolve(__dirname, '../../web-agents-api/dist-firefox/manifest.json');
  
  if (!fs.existsSync(harborManifest)) {
    console.error('❌ Harbor extension not built');
    console.error('   Run: cd extension && npm run build');
    process.exit(1);
  }
  
  if (!fs.existsSync(webAgentsManifest)) {
    console.error('❌ Web Agents API extension not built');
    console.error('   Run: cd web-agents-api && npm run build');
    process.exit(1);
  }
  
  // Create test server with model list
  const { server, resultPromise } = await createTestServer(modelsForTest);
  const testUrl = `http://localhost:${config.testServerPort}/`;
  
  console.log(`[test] Test page: ${testUrl}`);
  
  // Launch Firefox with BOTH extensions
  // Note: web-ext only supports one extension, so we need to use a different approach
  // For now, we'll just test with Harbor and note that window.ai requires Web Agents API
  
  console.log('[firefox] Launching with Harbor extension...');
  console.log('[note] Full window.ai testing requires manually loading Web Agents API extension');
  
  const webExtArgs = [
    'web-ext', 'run',
    '--source-dir', config.harborExtPath,
    '--start-url', testUrl,
    '--no-reload',
  ];
  
  const webExt = spawn('npx', webExtArgs, {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  
  childProcesses.push(webExt);
  
  let extensionLoaded = false;
  
  webExt.stdout.on('data', (data) => {
    const text = data.toString();
    if (text.includes('Installed') && text.includes('temporary add-on')) {
      extensionLoaded = true;
      console.log('[firefox] ✓ Harbor extension loaded');
    }
  });
  
  webExt.stderr.on('data', (data) => {
    const text = data.toString();
    if (text.includes('error') || text.includes('Error')) {
      console.log(`[web-ext] ${text.trim()}`);
    }
  });
  
  async function cleanup() {
    if (webExt.pid) {
      await killProcessTree(webExt.pid);
    }
    await killWebExtFirefox();
    server.close();
  }
  
  // Wait for result
  const timeout = setTimeout(async () => {
    console.log('\n[timeout] Test timed out');
    await cleanup();
    process.exit(1);
  }, config.timeout);
  
  try {
    const result = await resultPromise;
    clearTimeout(timeout);
    
    if (!config.keepOpen) {
      await cleanup();
    } else {
      console.log('\n[keep-open] Firefox stays open for inspection');
      console.log('[keep-open] Press Ctrl+C to exit');
    }
    
    console.log('\n' + '─'.repeat(50));
    if (result.passed) {
      console.log('✅ LLM Integration Test PASSED');
      if (result.responsePreview) {
        console.log(`   Response: "${result.responsePreview.slice(0, 100)}..."`);
      }
      if (result.elapsed) {
        console.log(`   Time: ${result.elapsed}ms`);
      }
      process.exit(0);
    } else {
      console.log('❌ LLM Integration Test FAILED');
      console.log(`   Error: ${result.message}`);
      process.exit(1);
    }
  } catch (err) {
    clearTimeout(timeout);
    await cleanup();
    console.error('\n❌ Test error:', err.message);
    process.exit(1);
  }
}

process.on('SIGINT', async () => {
  console.log('\n[interrupted] Cleaning up...');
  await killWebExtFirefox();
  for (const proc of childProcesses) {
    if (proc.pid) await killProcessTree(proc.pid);
  }
  process.exit(130);
});

main();
