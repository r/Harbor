// agent.mcp.discover() in real Firefox: which <link> declarations it finds,
// and the transport it reports when a link names none.
//
// The unit test (extension/src/agents/handlers/__tests__/mcp-discover.test.ts)
// fakes querySelectorAll. This runs Harbor's selector against Firefox's own,
// which matches rel tokens and compares rel values without regard to ASCII
// case. Needs no model and no bridge.
//
// Requires: the Firefox extension built (npm run build from extension/).
//
// Usage:
//   node test-mcp-discover.mjs [--keep-open]
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { launchFirefox } from '../../scripts/firefox-runner.mjs';

const require = createRequire(import.meta.url);
const webExt = path.dirname(require.resolve('web-ext'));
const load = name => import(pathToFileURL(path.join(webExt, 'lib', name)).href);
const [{ createExtensionRunner }, firefoxApp, { connectWithMaxRetries }, { default: getManifest }] = await Promise.all([
  load('extension-runners/index.js'), load('firefox/index.js'), load('firefox/remote.js'), load('util/manifest.js'),
]);

const keepOpen = process.argv.includes('--keep-open');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const PAGE = `<!doctype html>
<title>mcp discover e2e</title>
<link rel="mcp-server" href="/a" title="a">
<link rel="mcp" href="/b" title="b" data-transport="sse">
<link rel="alternate mcp-server mcp" href="/c" title="c">
<link rel="MCP" href="/d" title="d">
<link rel="mcp-servers" href="/x" title="x">
<link rel="stylesheet" href="data:text/css," title="y">
<p>discover fixture</p>`;

const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end(PAGE);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

let session;
let remote;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('mcp discover e2e test timed out')), 120_000);

try {
  session = await launchFirefox({ startUrl: `${ORIGIN}/`, signal: controller.signal }, {
    createRunner: createExtensionRunner, firefoxApp, getManifest,
    firefoxClient: async options => remote = await connectWithMaxRetries(options),
  });

  const handleMessage = remote.client._handleMessage.bind(remote.client);
  remote.client._handleMessage = packet => {
    if (packet.type === 'evaluationResult') remote.client.emit('discover-event', packet);
    else handleMessage(packet);
  };

  async function evaluate(actor, text, timeoutMs = 20_000) {
    controller.signal.throwIfAborted();
    let listener;
    let timer;
    const result = new Promise((resolve, reject) => {
      listener = packet => {
        if (packet.from !== actor) return;
        packet.hasException ? reject(new Error(packet.exceptionMessage || 'Page evaluation failed')) : resolve(packet.result);
      };
      remote.client.on('discover-event', listener);
      timer = setTimeout(() => reject(new Error('Page evaluation timed out: ' + text.slice(0, 80))), timeoutMs);
    });
    try {
      await remote.client.request({ to: actor, type: 'evaluateJSAsync', text, disableBreaks: true });
      return await result;
    } finally {
      clearTimeout(timer);
      remote.client.removeListener('discover-event', listener);
    }
  }

  let tab;
  for (let i = 0; i < 50 && !tab; i++) {
    const { tabs } = await remote.client.request('listTabs');
    tab = tabs.find(t => t.url.startsWith(ORIGIN));
    if (!tab) await sleep(200);
  }
  assert.ok(tab, `tab ${ORIGIN} not found`);
  const { frame } = await remote.client.request({ to: tab.actor, type: 'getTarget' });
  const inPage = text => evaluate(frame.consoleActor, text);

  // Harbor injects window.agent after load; wait for it.
  for (let i = 0; i < 50 && (await inPage('typeof window.agent?.mcp?.discover')) !== 'function'; i++) await sleep(200);

  await inPage(`window.agent.mcp.discover().then(v => window.__discover = JSON.stringify(v), e => window.__discover = 'error: ' + e.message); true`);
  let raw = '';
  for (let i = 0; i < 50 && !raw; i++) {
    raw = await inPage('window.__discover || ""');
    if (!raw) await sleep(100);
  }
  assert.ok(raw && !raw.startsWith('error:'), `discover() failed: ${raw}`);
  const servers = JSON.parse(raw);

  assert.deepEqual(
    servers.map(s => [s.name, s.url, s.transport]),
    [
      ['a', `${ORIGIN}/a`, 'streamable-http'],
      ['b', `${ORIGIN}/b`, 'sse'],
      ['c', `${ORIGIN}/c`, 'streamable-http'],
      ['d', `${ORIGIN}/d`, 'streamable-http'],
    ],
  );
  console.log('PASS agent.mcp.discover() in Firefox:', JSON.stringify(servers.map(s => [s.name, s.transport])));
} catch (error) {
  console.error('FAIL', error.stack || error.message);
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (!keepOpen) await session?.close().catch(() => {});
  server.close();
}
