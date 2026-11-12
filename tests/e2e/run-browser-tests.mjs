#!/usr/bin/env node
/**
 * E2E Browser Test Runner for Firefox
 * 
 * This script:
 * 1. Starts a local server to serve test pages
 * 2. Launches Firefox with both Harbor and Web Agents API extensions
 * 3. Captures results via HTTP endpoint
 * 4. Exits with appropriate code
 * 
 * Both Firefox builds are installed in a fresh temporary profile.
 * The native bridge must already be registered for full functionality tests.
 * 
 * Usage:
 *   node run-browser-tests.mjs [--timeout=60000] [--keep-open]
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { launchFirefox } from '../../scripts/firefox-runner.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let firefoxSession;
let interrupted = false;
const controller = new AbortController();

// Parse args
const args = process.argv.slice(2);
const getArg = (name, defaultVal) => {
  const arg = args.find(a => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : defaultVal;
};

// Configuration - Firefox is the PRIMARY browser
const config = {
  harborExtPath: path.resolve(__dirname, '../../extension/dist-firefox'),
  webAgentsExtPath: path.resolve(__dirname, '../../web-agents-api/dist-firefox'),
  testServerPort: 3457,
  timeout: parseInt(getArg('timeout', '60000')),
  keepOpen: args.includes('--keep-open'),
};

// MIME types
const mimeTypes = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

// Simple static file server with results endpoint
function createTestServer() {
  return new Promise((resolve, reject) => {
    let testResultsResolver = null;
    const testResultsPromise = new Promise(r => { testResultsResolver = r; });
    
    const server = http.createServer((req, res) => {
      // Handle results POST from test runner
      if (req.method === 'POST' && req.url === '/__test_results__') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const results = JSON.parse(body);
            console.log(`\n[results] Received from browser:`);
            console.log(`  Passed: ${results.passed}/${results.total}`);
            console.log(`  Failed: ${results.failed}`);
            if (results.failures && results.failures.length > 0) {
              console.log(`  Failures:`);
              for (const f of results.failures) {
                console.log(`    - ${f.suite}: ${f.name}`);
                console.log(`      ${f.error}`);
              }
            }
            testResultsResolver(results);
          } catch (e) {
            console.error('[results] Failed to parse:', e);
          }
          res.writeHead(200, { 'Access-Control-Allow-Origin': '*' });
          res.end('ok');
        });
        return;
      }
      
      // Handle CORS preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }
      
      // Parse URL and remove query string
      const urlPath = req.url.split('?')[0];
      let filePath = urlPath === '/' ? '/test-runner.html' : urlPath;
      
      // Try browser-tests directory first
      let fullPath = path.join(__dirname, 'browser-tests', filePath);
      
      // Then try demo directory
      if (!fs.existsSync(fullPath)) {
        fullPath = path.join(__dirname, '../../demo', filePath);
      }
      
      // Then try extension demo
      if (!fs.existsSync(fullPath)) {
        fullPath = path.join(__dirname, '../../extension/demo', filePath);
      }
      
      // Then try extension dist (for demo-bootstrap.js etc)
      if (!fs.existsSync(fullPath)) {
        fullPath = path.join(__dirname, '../../extension/dist', filePath);
      }
      
      if (!fs.existsSync(fullPath)) {
        res.writeHead(404);
        res.end(`Not found: ${filePath}`);
        return;
      }
      
      const ext = path.extname(fullPath);
      const contentType = mimeTypes[ext] || 'application/octet-stream';
      
      fs.readFile(fullPath, (err, content) => {
        if (err) {
          res.writeHead(500);
          res.end('Server error');
          return;
        }
        res.writeHead(200, { 
          'Content-Type': contentType,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(content);
      });
    });
    
    server.listen(config.testServerPort, () => {
      console.log(`[server] Test server on http://localhost:${config.testServerPort}`);
      resolve({ server, testResultsPromise });
    });
    
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`[server] Port ${config.testServerPort} in use, trying next...`);
        config.testServerPort++;
        server.listen(config.testServerPort);
      } else {
        reject(err);
      }
    });
  });
}

// Check if extensions are built
function checkBuilds() {
  const harborManifest = path.join(config.harborExtPath, 'manifest.json');
  const webAgentsManifest = path.join(config.webAgentsExtPath, 'manifest.json');
  
  if (!fs.existsSync(harborManifest)) {
    console.error(`[error] Harbor extension not built at ${config.harborExtPath}`);
    console.error(`        Run: cd extension && npm run build`);
    process.exit(1);
  }
  
  if (!fs.existsSync(webAgentsManifest)) {
    console.error(`[error] Web Agents API extension not built at ${config.webAgentsExtPath}`);
    console.error(`        Run: cd web-agents-api && npm run build`);
    process.exit(1);
  }
  
  console.log('[build] ✓ Harbor extension ready (Firefox)');
  console.log('[build] ✓ Web Agents API extension ready (Firefox)');
}

// The same two-extension launcher used by npm run dev:firefox.
async function runBrowserTests(testUrl, testResultsPromise) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Test timed out after ${config.timeout / 1000}s`);
      controller.abort(error);
      reject(error);
    }, config.timeout);
  });
  try {
    firefoxSession = await Promise.race([
      launchFirefox({ startUrl: testUrl, signal: controller.signal }), deadline,
    ]);
    const results = await Promise.race([
      testResultsPromise,
      firefoxSession.closed.then(() => { throw new Error('Firefox closed before test results arrived'); }),
      deadline,
    ]);
    clearTimeout(timer);
    if (config.keepOpen) {
      console.log('[keep-open] Tests complete. Close Firefox or press Ctrl+C to exit.');
      await firefoxSession.closed;
    }
    return results;
  } finally {
    clearTimeout(timer);
    await firefoxSession?.close();
  }
}

// Main
async function main() {
  console.log('🚢 Harbor E2E Browser Tests (Firefox)\n');
  
  // Check builds
  checkBuilds();
  
  // Start test server
  const { server, testResultsPromise } = await createTestServer();
  
  const testUrl = `http://localhost:${config.testServerPort}/test-runner.html`;
  
  try {
    console.log(`\n[test] Opening: ${testUrl}`);
    if (config.keepOpen) {
      console.log('[test] Keep-open mode: Firefox will stay open for manual testing\n');
    }
    
    const results = await runBrowserTests(testUrl, testResultsPromise);
    
    server.close();
    
    if (interrupted) return;
    if (results.failed === 0) {
      console.log('\n✅ All browser tests passed!');
      process.exitCode = 0;
    } else {
      console.log('\n❌ Some browser tests failed');
      process.exitCode = 1;
    }
  } catch (err) {
    server.close();
    console.error('\n❌ Test error:', err.message);
    if (!interrupted) process.exitCode = 1;
  }
}

// Only close the browser owned by this invocation.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    interrupted = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    controller.abort(new Error(`Interrupted by ${signal}`));
    if (firefoxSession) await firefoxSession.close();
  });
}

main();
