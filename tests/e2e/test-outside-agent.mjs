// Real round trip for HBR-150: the person's own agent, running outside the
// browser, opens a page and calls its tools through Harbor
// (docs/AGENT_REACHES_TABS.md) - without goose, Claude Code or any other
// third-party agent installed. It drives the real `harbor-mcp` binary
// exactly as one of those agents would (stdio, newline-delimited JSON-RPC),
// against a bridge connected to a Firefox instance it launches itself, over
// an isolated `HARBOR_AGENT_SOCKET` so this never touches the person's own
// `~/.harbor/agent.sock`.
//
// `HARBOR_AGENT_SOCKET` is set on *this* process before Firefox is launched
// so Firefox - and whatever the already-registered native-messaging host
// execs to become harbor-bridge - inherits it (web-ext spawns Firefox with
// `env: { ...process.env, ... }`, see node_modules/web-ext/lib/firefox/index.js).
// The same value is passed explicitly to the harbor-mcp child below.
//
// Requires: the Firefox extension built (npm run build from extension/), a
// release or debug harbor-bridge AND harbor-mcp (built from bridge-rs/, e.g.
// `cargo build --release --manifest-path bridge-rs/Cargo.toml`), and the
// native bridge already registered with Firefox so it is the one Firefox's
// native messaging launches. Skips with a clear message if harbor-mcp can't
// be found.
//
// Usage:
//   node test-outside-agent.mjs [--keep-open]
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const socketPath = path.join(os.tmpdir(), `hbr150-${process.pid}.sock`);
// Must be set before launchFirefox below so Firefox (and, transitively, the
// native-messaging bridge it spawns) inherits it - never touch the real
// ~/.harbor/agent.sock from an automated test.
process.env.HARBOR_AGENT_SOCKET = socketPath;

const { launchFirefox } = await import('../../scripts/firefox-runner.mjs');

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);
const webExt = path.dirname(require.resolve('web-ext'));
const load = name => import(pathToFileURL(path.join(webExt, 'lib', name)).href);
const [{ createExtensionRunner }, firefoxApp, { connectWithMaxRetries }, { default: getManifest }] = await Promise.all([
  load('extension-runners/index.js'), load('firefox/index.js'), load('firefox/remote.js'), load('util/manifest.js'),
]);

const keepOpen = process.argv.includes('--keep-open');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function findHarborMcp() {
  const candidates = [
    path.resolve(root, 'bridge-rs/target/release/harbor-mcp'),
    path.resolve(root, 'bridge-rs/target/debug/harbor-mcp'),
    path.join(os.homedir(), '.harbor/harbor-mcp'),
  ];
  return candidates.find(p => fsSync.existsSync(p)) ?? null;
}

const harborMcpPath = findHarborMcp();
if (!harborMcpPath) {
  console.log('SKIP: no harbor-mcp binary found (build it with `cargo build --release --manifest-path bridge-rs/Cargo.toml`).');
  process.exit(0);
}

// --- A throwaway demo server, same shape as test-page-tools-agent.mjs's.
const server = http.createServer(async (request, response) => {
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
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const demoUrl = `http://127.0.0.1:${server.address().port}/web-agents/page-tools/`;

/**
 * One long-lived harbor-mcp child - one agent identity for the whole test,
 * matching how a real MCP client (goose, Claude Code) keeps a single stdio
 * connection open for a session. A page handle is only usable by the
 * agentId that opened it, so re-spawning per call would never see its own
 * pages again.
 */
function openHarborMcpSession(env) {
  const child = spawn(harborMcpPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let buf = '';
  const waiters = new Map();
  let nextId = 1;
  let stderr = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const waiter = waiters.get(msg.id);
      if (waiter) { waiters.delete(msg.id); waiter(msg); }
    }
  });
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  async function send(method, params) {
    const id = nextId++;
    const result = new Promise((resolve) => waiters.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return result;
  }
  async function callTool(name, args) {
    const resp = await send('tools/call', { name, arguments: args });
    return resp.result;
  }
  async function close() {
    child.stdin.end();
    await new Promise((resolve) => child.on('close', resolve));
  }
  return { send, callTool, close, get stderr() { return stderr; } };
}

let session;
let remote;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('Outside-agent e2e test timed out')), 180_000);
let mcpSession;

try {
  session = await launchFirefox({ startUrl: demoUrl, signal: controller.signal }, {
    createRunner: createExtensionRunner, firefoxApp, getManifest,
    firefoxClient: async options => remote = await connectWithMaxRetries(options),
  });

  const handleMessage = remote.client._handleMessage.bind(remote.client);
  remote.client._handleMessage = packet => {
    if (['evaluationResult', 'pageError', 'consoleAPICall'].includes(packet.type)) {
      remote.client.emit('outside-agent-event', packet);
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
      remote.client.on('outside-agent-event', listener);
      timer = setTimeout(() => reject(new Error('Page evaluation timed out: ' + text.slice(0, 80))), timeoutMs);
    });
    try {
      await remote.client.request({ to: actor, type: 'evaluateJSAsync', text, disableBreaks: true });
      return await result;
    } finally {
      clearTimeout(timer);
      remote.client.removeListener('outside-agent-event', listener);
    }
  }

  const target = async actor => (await remote.client.request({ to: actor, type: 'getTarget' })).frame;

  // `exact: true` matters once more than one tab's URL shares a prefix (the
  // demo URL is itself a prefix of the "not agent opened" tab's URL below).
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

  // --- Find the extension's internal UUID (listAddons) and open sidebar.html.
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

  assert.equal(await sval('!!document.getElementById("outside-agents-enabled")'), true,
    'sidebar.html must render the "Your agent outside the browser" section');

  // --- Turn the setting on.
  await sval(`
    (() => {
      const cb = document.getElementById('outside-agents-enabled');
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
      return true;
    })()
  `);
  await sleep(1000);
  assert.equal(await sval('document.getElementById("outside-agents-enabled").checked'), true,
    'the setting must read back on');
  console.log('PASS: turned on "Let your agent open and use pages".');

  // --- A tab the agent did NOT open: created directly through the
  // WebExtension API from the sidebar's own privileged page, the same way
  // the person opening a tab themselves would never go through open_page.
  const notAgentsUrl = demoUrl + '?not-agent-opened=1';
  await sval(`
    (async () => {
      await browser.tabs.create({ url: ${JSON.stringify(notAgentsUrl)}, active: false });
      return true;
    })()
  `);
  await findTab(notAgentsUrl); // confirms it actually opened before we assert its absence below.
  console.log('PASS: opened a second tab the agent never asked for (not through open_page).');

  // --- Speak MCP to harbor-mcp over stdio, exactly as goose or Claude Code
  // would: initialize, then open_page, list_page_tools, call_page_tool.
  mcpSession = openHarborMcpSession({ HARBOR_AGENT_SOCKET: socketPath });
  const initResult = await mcpSession.send('initialize', {
    protocolVersion: '2025-06-18',
    clientInfo: { name: 'hbr150-e2e-test' },
  });
  assert.equal(initResult.result?.serverInfo?.name, 'harbor', 'initialize must succeed: ' + JSON.stringify(initResult));

  const openResult = await mcpSession.callTool('open_page', { url: demoUrl });
  assert.ok(openResult && openResult.isError !== true, 'open_page must succeed: ' + JSON.stringify(openResult));
  const page = openResult.structuredContent?.page;
  assert.ok(page, 'open_page must return a page handle: ' + JSON.stringify(openResult));
  await sleep(1500);

  const listToolsResult = await mcpSession.callTool('list_page_tools', { page });
  assert.ok(listToolsResult && listToolsResult.isError !== true, 'list_page_tools must succeed: ' + JSON.stringify(listToolsResult));
  assert.match(listToolsResult.content[0].text, /go_to/, 'the page must offer a go_to tool');
  // A tool's WebMCP title, outputSchema and annotations reach the agent as
  // MCP Tool fields; a tool registered without them gets none.
  const listed = Object.fromEntries((listToolsResult.structuredContent?.tools ?? []).map(t => [t.name, t]));
  assert.equal(listed.reading_position?.title, 'Reading position', 'reading_position must keep its title: ' + JSON.stringify(listed));
  assert.deepEqual(listed.reading_position?.annotations, { readOnlyHint: true }, 'reading_position must keep its annotations');
  assert.deepEqual(listed.go_to?.outputSchema, { type: 'object', properties: { at: { type: 'string' } }, required: ['at'] }, 'go_to must keep its outputSchema');
  assert.deepEqual(listed.go_to?.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, 'go_to must keep its annotations');
  assert.ok(listed.count_words && !('title' in listed.count_words) && !('annotations' in listed.count_words) && !('outputSchema' in listed.count_words),
    'count_words, registered without them, must get none: ' + JSON.stringify(listed.count_words));
  console.log('PASS: list_page_tools carries title, outputSchema and annotations, and adds none to a tool without them.');
  console.log('PASS: harbor__open_page and harbor__list_page_tools reached the page through the real relay.');

  const goToResult = await mcpSession.callTool('call_page_tool', { page, tool: 'go_to', input: { anchor: 'p4' } });
  assert.ok(goToResult && goToResult.isError !== true, 'call_page_tool(go_to) must succeed: ' + JSON.stringify(goToResult));

  // --- The page's own #log shows its handler ran, read through RDP in the
  // tab the agent opened (not the one it didn't).
  const agentTab = await findTab(demoUrl, { exact: true });
  const agentFrame = await target(agentTab.actor);
  const log = await evaluate(agentFrame.consoleActor, 'document.getElementById("log").textContent');
  assert.match(String(log), /page handler ran: go_to\(p4\)/, 'the page handler must have run: ' + log);
  console.log('PASS: the page\'s own #log shows go_to(p4) ran, called from outside the browser.');

  // --- list_pages must include the tab the agent opened, and must NOT
  // include the tab it never asked for.
  const listPagesResult = await mcpSession.callTool('list_pages', {});
  assert.ok(listPagesResult && listPagesResult.isError !== true, 'list_pages must succeed: ' + JSON.stringify(listPagesResult));
  const pages = listPagesResult.structuredContent?.pages ?? [];
  assert.ok(pages.some(p => p.page === page), 'list_pages must include the page the agent opened: ' + JSON.stringify(pages));
  assert.ok(!pages.some(p => p.url === notAgentsUrl), 'list_pages must NOT include a tab the agent never opened or was shared: ' + JSON.stringify(pages));
  console.log('PASS: list_pages includes the agent\'s own page and excludes the tab it never opened.');

  console.log('\nPASS: your agent, running outside the browser, opened a page and called its tools through Harbor end-to-end.');
} finally {
  clearTimeout(deadline);
  await mcpSession?.close().catch(() => {});
  if (!keepOpen) await session?.close().catch(() => {});
  server.close();
  await fs.unlink(socketPath).catch(() => {});
}
