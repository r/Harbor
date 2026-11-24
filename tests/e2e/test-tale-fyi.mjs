// Interop check against a real site: tale.fyi, which declares its MCP server
// with <link rel="mcp-server"> and registers page tools through
// document.modelContext. The person's own agent, running outside the browser,
// opens a Tale book through the real `harbor-mcp` binary and uses those tools,
// the same path as test-outside-agent.mjs takes against Harbor's own demo.
//
// It reaches a live third-party site over the network, so it is run by hand
// and stays out of test:all and CI. It never calls Tale's `mark` or `unmark`:
// those publish a permanent plan on tale.fyi.
//
// Requires: the Firefox extension built (npm run build from extension/), a
// release or debug harbor-bridge and harbor-mcp (cargo build --release
// --manifest-path bridge-rs/Cargo.toml), and the native bridge registered with
// Firefox. Skips if harbor-mcp isn't built or tale.fyi can't be reached.
//
// Usage:
//   node test-tale-fyi.mjs [--keep-open] [--url=https://tale.fyi/dracula]
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const socketPath = path.join(os.tmpdir(), `tale-${process.pid}.sock`);
// Set before Firefox launches so the bridge it spawns inherits it; never touch
// the person's own ~/.harbor/agent.sock.
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
const taleUrl = process.argv.find(a => a.startsWith('--url='))?.slice('--url='.length) || 'https://tale.fyi/dracula';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Tale may add tools; these are the ones this test relies on being present.
const EXPECTED_TOOLS = ['reading_position', 'go_to', 'find', 'point_at', 'mark', 'unmark', 'play', 'pause'];

const harborMcpPath = [
  path.resolve(root, 'bridge-rs/target/release/harbor-mcp'),
  path.resolve(root, 'bridge-rs/target/debug/harbor-mcp'),
  path.join(os.homedir(), '.harbor/harbor-mcp'),
].find(p => fsSync.existsSync(p));
if (!harborMcpPath) {
  console.log('SKIP: no harbor-mcp binary found (build it with `cargo build --release --manifest-path bridge-rs/Cargo.toml`).');
  process.exit(0);
}
try {
  const res = await fetch(taleUrl, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
} catch (error) {
  console.log(`SKIP: ${taleUrl} can't be reached (${error.message}).`);
  process.exit(0);
}

/** One long-lived harbor-mcp child: one agent identity for the whole run. */
function openHarborMcpSession(env) {
  const child = spawn(harborMcpPath, [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
  let buf = '';
  let stderr = '';
  let nextId = 1;
  const waiters = new Map();
  child.stdout.on('data', d => {
    buf += d.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      waiters.get(msg.id)?.(msg);
      waiters.delete(msg.id);
    }
  });
  child.stderr.on('data', d => { stderr += d.toString(); });
  const send = (method, params) => {
    const id = nextId++;
    const result = new Promise(resolve => waiters.set(id, resolve));
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return result;
  };
  return {
    send,
    callTool: async (name, args) => (await send('tools/call', { name, arguments: args })).result,
    close: async () => { child.stdin.end(); await new Promise(resolve => child.on('close', resolve)); },
    get stderr() { return stderr; },
  };
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' (' + detail + ')' : ''}`);
}
const text = r => r?.content?.map(c => c.text).join('\n') ?? JSON.stringify(r);

let session;
let remote;
let mcpSession;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('tale.fyi interop test timed out')), 240_000);

try {
  session = await launchFirefox({ startUrl: 'about:blank', signal: controller.signal }, {
    createRunner: createExtensionRunner, firefoxApp, getManifest,
    firefoxClient: async options => remote = await connectWithMaxRetries(options),
  });

  // web-ext's RDP client doesn't classify these packets itself.
  const handleMessage = remote.client._handleMessage.bind(remote.client);
  remote.client._handleMessage = packet => {
    if (['evaluationResult', 'pageError', 'consoleAPICall'].includes(packet.type)) remote.client.emit('tale-event', packet);
    else handleMessage(packet);
  };

  async function evaluate(actor, code, timeoutMs = 20_000) {
    controller.signal.throwIfAborted();
    let listener;
    let timer;
    const result = new Promise((resolve, reject) => {
      listener = packet => {
        if (packet.type !== 'evaluationResult' || packet.from !== actor) return;
        packet.hasException ? reject(new Error(packet.exceptionMessage || 'Page evaluation failed')) : resolve(packet.result);
      };
      remote.client.on('tale-event', listener);
      timer = setTimeout(() => reject(new Error('Page evaluation timed out: ' + code.slice(0, 80))), timeoutMs);
    });
    try {
      await remote.client.request({ to: actor, type: 'evaluateJSAsync', text: code, disableBreaks: true });
      return await result;
    } finally {
      clearTimeout(timer);
      remote.client.removeListener('tale-event', listener);
    }
  }

  const target = async actor => (await remote.client.request({ to: actor, type: 'getTarget' })).frame;

  async function findTab(match, timeoutMs = 15_000) {
    const expires = Date.now() + timeoutMs;
    let lastSeen = [];
    while (Date.now() < expires) {
      const { tabs } = await remote.client.request('listTabs');
      lastSeen = tabs.map(t => t.url);
      const tab = tabs.find(t => match(t.url));
      if (tab) return tab;
      await sleep(200);
    }
    throw new Error('Tab not found among: ' + lastSeen.join(', '));
  }

  // Turn on "Let your agent open and use pages" in the sidebar.
  const { addons } = await remote.client.request('listAddons');
  const harbor = addons.find(a => a.id === 'harbor@krikorian.co');
  if (!harbor) throw new Error('Harbor not found in listAddons');
  const uuid = harbor.manifestURL.match(/moz-extension:\/\/([a-f0-9-]+)\//)[1];
  const sidebarUrl = `moz-extension://${uuid}/sidebar.html`;
  const startFrame = await target((await findTab(() => true)).actor);
  await remote.client.request({ to: startFrame.actor, type: 'navigateTo', url: sidebarUrl });
  await sleep(1500);
  const sidebarFrame = await target((await findTab(u => u === sidebarUrl)).actor);
  await evaluate(sidebarFrame.consoleActor, `(() => {
    const cb = document.getElementById('outside-agents-enabled');
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    return true;
  })()`);
  await sleep(1000);

  mcpSession = openHarborMcpSession({ HARBOR_AGENT_SOCKET: socketPath });
  const init = await mcpSession.send('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'tale-interop-e2e' } });
  check('harbor-mcp initializes', init.result?.serverInfo?.name === 'harbor', init.error ? JSON.stringify(init.error) : '');

  const opened = await mcpSession.callTool('open_page', { url: taleUrl });
  const page = opened?.structuredContent?.page;
  check('open_page opens the Tale book', Boolean(page) && opened.isError !== true, text(opened).slice(0, 160));
  if (!page) throw new Error('No page handle; cannot continue');

  // Tale registers its tools once Harbor's host appears, after hydration.
  let listed;
  let missing = EXPECTED_TOOLS;
  for (let i = 0; i < 20 && missing.length; i++) {
    await sleep(750);
    listed = await mcpSession.callTool('list_page_tools', { page });
    const names = (() => { try { return JSON.parse(text(listed)).map(t => t.name); } catch { return []; } })();
    missing = EXPECTED_TOOLS.filter(n => !names.includes(n));
  }
  check('list_page_tools shows Tale\'s tools', missing.length === 0, missing.length ? 'missing ' + missing.join(', ') : '');
  check('each tool is stamped with tale.fyi provenance',
    (() => { try { const tools = JSON.parse(text(listed)); return tools.length > 0 && tools.every(t => t._meta?.['harbor/provenance']?.origin === new URL(taleUrl).origin); } catch { return false; } })());

  const call = async (tool, input) => {
    const r = await mcpSession.callTool('call_page_tool', { page, tool, input });
    console.log(`  ${tool}(${JSON.stringify(input)}) -> ${r?.isError ? 'ERROR ' : ''}${text(r).slice(0, 240)}`);
    return r;
  };
  const taleTab = await findTab(u => u.startsWith(taleUrl));
  const inTale = async code => evaluate((await target(taleTab.actor)).consoleActor, code);

  const position = await call('reading_position', {});
  check('reading_position returns the open book', position?.isError !== true && /"path"/.test(text(position)));

  const moved = await call('go_to', { anchor: 'chapter-1-p2' });
  await sleep(800);
  const hash = await inTale('location.hash');
  check('go_to moves the reader', moved?.isError !== true && hash === '#chapter-1-p2', `hash ${hash}`);

  const after = await call('reading_position', {});
  check('reading_position reflects the move', /"readingLineAnchor":"chapter-1-p2"/.test(text(after)));

  const found = await call('find', { query: 'Bistritz' });
  check('find returns matching passages', found?.isError !== true && /"matches":\[\{"anchor"/.test(text(found)));

  const pointed = await call('point_at', { anchor: 'chapter-1-p1' });
  const painted = await inTale(`CSS.highlights ? CSS.highlights.has('tale-point-at') : 'no CSS.highlights'`);
  check('point_at paints its highlight', pointed?.isError !== true && painted === true, `highlight ${painted}`);

  const unknown = await call('go_to', { anchor: 'no-such-anchor' });
  check('a bad anchor comes back as a typed result', /"error":"unknown_anchor"/.test(text(unknown)));

  // In a fresh profile narration may not start; any of Tale's typed answers is fine.
  const played = await call('play', {});
  check('play answers', /"playing":true|needs_gesture|narration_unavailable/.test(text(played)));
  const paused = await call('pause', {});
  check('pause answers', /"playing":false/.test(text(paused)));

  // The page side: Harbor's discover() reads Tale's <link rel="mcp-server">.
  await inTale(`window.agent.mcp.discover().then(v => window.__taleDiscover = JSON.stringify(v), e => window.__taleDiscover = 'error: ' + e.message); true`);
  let discovered = '';
  for (let i = 0; i < 50 && !discovered; i++) {
    discovered = await inTale('window.__taleDiscover || ""');
    if (!discovered) await sleep(100);
  }
  const server = (() => { try { return JSON.parse(discovered).find(s => s.url === new URL('/api/mcp', taleUrl).href); } catch { return null; } })();
  check('mcp.discover() finds Tale\'s MCP server', Boolean(server) && server.transport === 'streamable-http', discovered.slice(0, 160));
} catch (error) {
  check('harness', false, error.stack || error.message);
  if (mcpSession) console.log('harbor-mcp stderr:', mcpSession.stderr.slice(-2000));
} finally {
  clearTimeout(deadline);
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed against ${taleUrl}`);
  await mcpSession?.close().catch(() => {});
  if (!keepOpen) await session?.close().catch(() => {});
  await fs.unlink(socketPath).catch(() => {});
  process.exitCode = failed ? 1 : 0;
}
