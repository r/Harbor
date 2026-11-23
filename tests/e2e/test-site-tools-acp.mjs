// Real round trip for HBR-156: a site's own registered MCP server tools
// (window.agent.mcp.register, not the person's installed servers) reach
// the person's own ACP agent (Claude Code here) through Harbor's bridge
// MCP endpoint, with no mcp:tools.* grant — only the mcp:servers.register
// prompt to add the server, and the usual model:prompt/model:tools prompt
// to let the site use the person's agent at all (docs/PERMISSIONS.md,
// "The site's own tools").
//
// Drives the real extension in a fresh Firefox profile against the
// existing demo/web-agents/page-tools/ page (unmodified) for the task UI,
// and the real Acme Shop MCP server in
// demo/web-agents/bring-your-chatbot/mcp-server/http-server.js for the
// site's tools — the MCP SDK ships that server, per docs/agent-workflow.md's
// "A protocol fake written from the client's side passes the client's
// bugs" pitfall. That server only implements SSE, not streamable-http, so
// this registers with transport: 'sse' to match what it actually speaks;
// Harbor's own bridge endpoint (what the agent sees) is streamable-http
// regardless of the site server's own transport.
//
// The demo page and the MCP server are both loopback (127.0.0.1), so the
// same-origin-or-loopback rule in agents/handlers/mcp-website.ts's
// isAllowedServerUrl allows the registration even though they're on
// different ports.
//
// Requires: the Firefox extension built (npm run build from extension/),
// the native bridge registered and pointed at a built harbor-bridge, and
// Claude Code configured as an ACP agent in
// ~/Library/Application Support/harbor/acp.json (id: "claude-code"). Skips
// with a clear message if that agent isn't configured, since this only
// checks for the file, not that Claude Code itself can actually run.
//
// Usage:
//   node test-site-tools-acp.mjs [--keep-open]
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchFirefox } from '../../scripts/firefox-runner.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const webExt = path.dirname(require.resolve('web-ext'));
const load = name => import(pathToFileURL(path.join(webExt, 'lib', name)).href);
const [{ createExtensionRunner }, firefoxApp, { connectWithMaxRetries }, { default: getManifest }] = await Promise.all([
  load('extension-runners/index.js'), load('firefox/index.js'), load('firefox/remote.js'), load('util/manifest.js'),
]);

const keepOpen = process.argv.includes('--keep-open');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const acpConfigPath = path.join(os.homedir(), 'Library/Application Support/harbor/acp.json');
if (!fsSync.existsSync(acpConfigPath)) {
  console.log(`SKIP: no ACP agent configured at ${acpConfigPath}.`);
  process.exit(0);
}
const acpConfig = JSON.parse(await fs.readFile(acpConfigPath, 'utf8'));
if (!acpConfig.agents?.some(a => a.id === 'claude-code')) {
  console.log('SKIP: no "claude-code" agent configured in acp.json.');
  process.exit(0);
}

// --- The demo's own static server, loopback, never on :8000 (that port is
// the demo's own `npm run dev`, and may be in use by something else).
const demoServer = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const file = path.resolve(root, 'demo', '.' + pathname, pathname.endsWith('/') ? 'index.html' : '');
  if (!file.startsWith(path.join(root, 'demo') + path.sep)) {
    response.writeHead(404).end();
    return;
  }
  try {
    response.setHeader('Content-Type', file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : 'application/javascript');
    response.end(await fs.readFile(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => demoServer.listen(0, '127.0.0.1', resolve));
const demoUrl = `http://127.0.0.1:${demoServer.address().port}/web-agents/page-tools/`;

// --- The real Acme Shop MCP server (SSE transport), loopback, fixed port.
const mcpServerDir = path.resolve(root, 'demo/web-agents/bring-your-chatbot/mcp-server');
let mcpServerLog = '';
const mcpServerProcess = spawn(process.execPath, ['http-server.js'], { cwd: mcpServerDir });
mcpServerProcess.stdout.on('data', d => { mcpServerLog += d.toString(); });
mcpServerProcess.stderr.on('data', d => { mcpServerLog += d.toString(); });
// Give it a moment to bind before Firefox tries to reach it.
await sleep(500);
const mcpServerUrl = 'http://127.0.0.1:3001/mcp';

let session;
let remote;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('Site tools ACP e2e test timed out')), 280_000);

try {
  session = await launchFirefox({ startUrl: demoUrl, signal: controller.signal }, {
    createRunner: createExtensionRunner, firefoxApp, getManifest,
    firefoxClient: async options => remote = await connectWithMaxRetries(options),
  });

  const consoleMessages = [];
  const handleMessage = remote.client._handleMessage.bind(remote.client);
  remote.client._handleMessage = packet => {
    if (['evaluationResult', 'pageError', 'consoleAPICall'].includes(packet.type)) {
      if (packet.type === 'consoleAPICall' || packet.type === 'pageError') {
        try {
          consoleMessages.push(JSON.stringify(packet));
        } catch {
          // best-effort capture only
        }
      }
      remote.client.emit('site-tools-event', packet);
    } else handleMessage(packet);
  };

  async function evaluate(actor, text, timeoutMs = 20_000) {
    controller.signal.throwIfAborted();
    let listener, timer;
    const result = new Promise((resolve, reject) => {
      listener = packet => {
        if (packet.type !== 'evaluationResult' || packet.from !== actor) return;
        packet.hasException ? reject(new Error(packet.exceptionMessage || 'Page evaluation failed')) : resolve(packet.result);
      };
      remote.client.on('site-tools-event', listener);
      timer = setTimeout(() => reject(new Error('Page evaluation timed out: ' + text.slice(0, 80))), timeoutMs);
    });
    try {
      await remote.client.request({ to: actor, type: 'evaluateJSAsync', text, disableBreaks: true });
      return await result;
    } finally {
      clearTimeout(timer);
      remote.client.removeListener('site-tools-event', listener);
    }
  }

  const target = async actor => (await remote.client.request({ to: actor, type: 'getTarget' })).frame;

  async function findTab(url, { timeoutMs = 15_000, exact = false } = {}) {
    const expires = Date.now() + timeoutMs;
    let lastSeen = [];
    while (Date.now() < expires) {
      const { tabs } = await remote.client.request('listTabs');
      lastSeen = tabs.map(t => t.url);
      const tab = tabs.find(t => (exact ? t.url === url : t.url.startsWith(url)));
      if (tab) return tab;
      await sleep(200);
    }
    throw new Error(`Tab matching ${url} (exact=${exact}) not found among: ${lastSeen.join(', ')}`);
  }

  // --- Find the extension's internal UUID, then turn the start tab into
  // the sidebar (privileged: can open a second, ordinary tab for the demo
  // page the same way test-outside-agent.mjs does).
  const { addons } = await remote.client.request('listAddons');
  const harbor = addons.find(a => a.id === 'harbor@krikorian.co');
  assert.ok(harbor, 'harbor extension not found in listAddons: ' + JSON.stringify(addons.map(a => a.id)));
  const match = (harbor.manifestURL || '').match(/moz-extension:\/\/([a-f0-9-]+)\//);
  assert.ok(match, 'could not find a moz-extension UUID in: ' + harbor.manifestURL);
  const sidebarUrl = `moz-extension://${match[1]}/sidebar.html`;

  const startTab = await findTab(demoUrl);
  const startFrame = await target(startTab.actor);
  await remote.client.request({ to: startFrame.actor, type: 'navigateTo', url: sidebarUrl });
  await sleep(1500);
  const sidebarTab = await findTab(sidebarUrl);
  const sidebarFrame = await target(sidebarTab.actor);
  const sval = text => evaluate(sidebarFrame.consoleActor, text);

  // --- Open the demo page in its own tab from the sidebar's privileged
  // context (an ordinary page can't call browser.tabs.create itself).
  await sval(`
    (async () => {
      await browser.tabs.create({ url: ${JSON.stringify(demoUrl)}, active: true });
      return true;
    })()
  `);
  const demoTab = await findTab(demoUrl, { exact: true });
  const demoFrame = await target(demoTab.actor);
  const dval = text => evaluate(demoFrame.consoleActor, text);

  // --- Select Claude Code as the agent backend, in Settings -> Your agent.
  await sval(`document.getElementById('open-settings').click(); true`);
  await sleep(300);
  await sval(`
    (() => {
      const select = document.getElementById('agent-backend-select');
      const opt = Array.from(select.options).find(o => o.value === 'claude-code');
      if (!opt) throw new Error('claude-code not in agent-backend-select: ' + Array.from(select.options).map(o => o.value).join(','));
      select.value = 'claude-code';
      select.dispatchEvent(new Event('change'));
      return true;
    })()
  `);

  async function waitForAgentReady(timeoutMs = 30_000) {
    const expires = Date.now() + timeoutMs;
    let last = '';
    while (Date.now() < expires) {
      last = String(await sval(`document.getElementById('agent-check-status').textContent`));
      if (/^Ready/.test(last)) return last;
      await sleep(300);
    }
    throw new Error('Claude Code never reported Ready; last status: ' + last);
  }
  const readyStatus = await waitForAgentReady();
  console.log(`PASS: selected Claude Code as the agent backend (${readyStatus}).`);

  // --- Wait for Harbor's page API to be ready on the demo tab (its own
  // page tools register on agent-ready, same wait as test-page-tools-agent.mjs).
  async function waitForDemoTools(timeoutMs = 15_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const count = await dval('(document.modelContext || navigator.modelContext)?.tools?.length ?? 0');
      if (count >= 3) return;
      await sleep(200);
    }
    throw new Error('The demo never registered its own page tools (agent-ready never fired)');
  }
  await waitForDemoTools();

  async function grantPermissionIfPrompted(timeoutMs = 15_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const { tabs } = await remote.client.request('listTabs');
      const popup = tabs.find(t => t.url.includes('/permission-prompt.html'));
      if (popup) {
        const prompt = await target(popup.actor);
        const text = await evaluate(prompt.consoleActor, 'document.body.textContent').catch(() => '(unreadable)');
        console.log('Granting permission prompt:', JSON.stringify(String(text).replace(/\s+/g, ' ').trim().slice(0, 200)));
        await evaluate(prompt.consoleActor, 'document.querySelector("#btn-grant").click(); true');
        return true;
      }
      await sleep(150);
    }
    return false;
  }

  /** Grants every permission prompt that appears within `windowMs` of the last one, not just the first. */
  async function grantAllPrompts(windowMs = 8_000) {
    let grantedAny = false;
    while (await grantPermissionIfPrompted(windowMs)) {
      grantedAny = true;
      await sleep(200);
    }
    return grantedAny;
  }

  // --- Register the site's own MCP server. No mcp:tools.* scope is ever
  // requested here or below - only mcp:servers.register, via the
  // mcp.server.register typed action's promptAsScope.
  await dval(`
    window.__mcpRegisterResult = null;
    window.agent.mcp.register({ url: ${JSON.stringify(mcpServerUrl)}, name: 'Shop', transport: 'sse' })
      .then(r => { window.__mcpRegisterResult = { ok: true, result: r }; })
      .catch(e => { window.__mcpRegisterResult = { ok: false, error: e.message }; });
    true
  `);
  const grantedRegister = await grantAllPrompts();
  assert.ok(grantedRegister, 'The mcp:servers.register permission prompt must appear for agent.mcp.register');
  console.log('PASS: granted mcp:servers.register for the site\'s own MCP server (no mcp:tools.* scope requested).');

  let registerResult = null;
  {
    const expires = Date.now() + 30_000;
    while (Date.now() < expires) {
      const raw = await dval('window.__mcpRegisterResult ? JSON.stringify(window.__mcpRegisterResult) : null');
      if (raw) { registerResult = JSON.parse(raw); break; }
      await sleep(200);
    }
  }
  if (!registerResult?.ok) {
    console.log('mcp-server process log so far:\n' + mcpServerLog);
    console.log('captured console/page-error messages:\n' + consoleMessages.join('\n'));
  }
  assert.ok(registerResult?.ok, 'agent.mcp.register must succeed: ' + JSON.stringify(registerResult));
  assert.ok(registerResult.result?.tools?.includes('search_products'),
    'The registered server must offer search_products: ' + JSON.stringify(registerResult));
  console.log('PASS: window.agent.mcp.register registered the Acme Shop server and its tools: ' + JSON.stringify(registerResult.result.tools));

  // --- Run a task that needs the site's own search_products tool, through
  // the demo page's own agent.run() button (its ensurePermission() requests
  // only model:prompt/model:tools - still no mcp:tools.* grant anywhere in
  // this test).
  async function setTask(task) {
    await dval(`document.getElementById('task').value = ${JSON.stringify(task)}; true`);
  }
  async function clickRun() {
    await dval('document.getElementById("run").click(); true');
  }
  async function waitForSettledLog(timeoutMs = 120_000) {
    const expires = Date.now() + timeoutMs;
    let last = null;
    let stableSince = null;
    while (Date.now() < expires) {
      const text = await dval('document.getElementById("log").textContent');
      if (text === last) {
        if (stableSince === null) stableSince = Date.now();
        else if (Date.now() - stableSince > 3000) return text;
      } else {
        last = text;
        stableSince = null;
      }
      await sleep(400);
    }
    throw new Error('Run did not settle within ' + timeoutMs + 'ms; last log: ' + last);
  }

  await setTask('Use your tools to search the shop for "headphones" and tell me the exact price and whether it is in stock. Do not guess; call the search tool.');
  await clickRun();
  const grantedRun = await grantAllPrompts();
  assert.ok(grantedRun, 'The model:prompt/model:tools permission prompt must appear for agent.run on Claude Code');
  const afterRun = await waitForSettledLog();
  console.log('--- run log ---\n' + afterRun + '\n---------------');

  assert.match(afterRun, /agent called/i, 'The run must report at least one tool call: ' + afterRun);
  assert.match(afterRun, /search_products|149\.99|Wireless Headphones Pro/i,
    'The run must show evidence of calling the site\'s own search_products tool or its result: ' + afterRun);
  console.log('PASS: Claude Code called the site\'s own registered MCP server tool through Harbor, with no mcp:tools.* grant.');

  // --- The site server's own URL must never reach the agent directly: it's
  // never in the Firefox console (which would include session/new's own
  // params if Harbor ever logged or forwarded them), and never in the
  // bridge's log.
  const consoleText = consoleMessages.join('\n');
  assert.doesNotMatch(consoleText, new RegExp(mcpServerUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'The site MCP server URL must never appear in the Firefox console');
  console.log('PASS: the site server URL never appeared in the Firefox console.');

  console.log('\nPASS: a site\'s own registered MCP server tools reached the person\'s real ACP agent (Claude Code) through Harbor\'s bridge endpoint end-to-end, with no mcp:tools.* grant.');
} finally {
  clearTimeout(deadline);
  if (!keepOpen) await session?.close().catch(() => {});
  demoServer.close();
  mcpServerProcess.kill();
}
