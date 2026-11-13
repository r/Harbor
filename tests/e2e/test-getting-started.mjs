// Full checklist smoke test in a fresh Firefox profile with both real extensions.
// Requires built Firefox extensions, a registered bridge and an available default
// model. Never seeds browser storage or changes model/server configuration.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
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
const url = `http://127.0.0.1:${server.address().port}/web-agents/getting-started/`;
let session;
let remote;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('Checklist verification timed out')), 180_000);
const errors = [];
try {
  session = await launchFirefox({ startUrl: url, signal: controller.signal }, {
    createRunner: createExtensionRunner, firefoxApp, getManifest,
    firefoxClient: async options => remote = await connectWithMaxRetries(options),
  });
  // web-ext's small RDP client handles installation, but doesn't classify console
  // events. Route these test-only events before its generic response handling.
  const handleMessage = remote.client._handleMessage.bind(remote.client);
  remote.client._handleMessage = packet => {
    if (['evaluationResult', 'pageError', 'consoleAPICall'].includes(packet.type)) {
      if (packet.type === 'pageError' || packet.message?.level === 'error') errors.push(packet);
      remote.client.emit('checklist-event', packet);
    } else handleMessage(packet);
  };
  async function evaluate(actor, text) {
    controller.signal.throwIfAborted();
    let listener;
    let timer;
    const result = new Promise((resolve, reject) => {
      listener = packet => {
        if (packet.type !== 'evaluationResult' || packet.from !== actor) return;
        packet.hasException ? reject(new Error(packet.exceptionMessage || 'Page evaluation failed')) : resolve(packet.result);
      };
      remote.client.on('checklist-event', listener);
      timer = setTimeout(() => reject(new Error('Page evaluation timed out')), 10_000);
    });
    try {
      await remote.client.request({ to: actor, type: 'evaluateJSAsync', text, disableBreaks: true });
      return await result;
    } finally {
      clearTimeout(timer);
      remote.client.removeListener('checklist-event', listener);
    }
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const { tabs } = await remote.client.request('listTabs');
  const descriptor = tabs.find(tab => tab.url === url).actor;
  const target = async actor => (await remote.client.request({ to: actor, type: 'getTarget' })).frame;
  let frame = await target(descriptor);
  // The initial page can load before web-ext installs the second extension.
  await evaluate(frame.consoleActor, 'setTimeout(() => location.reload(), 0); true');
  await sleep(1000);
  frame = await target(descriptor);
  const value = text => evaluate(frame.consoleActor, text);
  assert.equal(await value('document.title'), 'Getting Started — Web Agent API');
  await remote.client.request({ to: frame.consoleActor, type: 'startListeners', listeners: ['PageError', 'ConsoleAPI'] });
  for (let step = 0; step < 5; step++) {
    await value('document.querySelector("#next-btn").click(); true');
    const expires = Date.now() + 120_000;
    let accepted = false;
    while (true) {
      controller.signal.throwIfAborted();
      if (step === 1 && !accepted) {
        const { tabs } = await remote.client.request('listTabs');
        const popup = tabs.find(tab => tab.url.includes('/permission-prompt.html'));
        if (popup) {
          const prompt = await target(popup.actor);
          await evaluate(prompt.consoleActor, 'document.querySelector("#btn-grant").click(); true');
          accepted = true;
        }
      }
      const state = JSON.parse(await value(`JSON.stringify({
        state: document.querySelector('[data-step="${step}"]').className,
        output: document.querySelector('[data-step="${step}"] .step-output')?.textContent
      })`));
      assert.ok(!state.state.includes('error'), `Step ${step + 1}: ${state.output}`);
      if (state.state.includes('completed')) {
        assert.ok(state.output, `Step ${step + 1} must produce output`);
        if (step === 2) assert.match(state.output, /time\.now/);
        console.log(`Step ${step + 1}: ${state.output}`);
        break;
      }
      assert.ok(Date.now() < expires, `Step ${step + 1} timed out`);
      await sleep(200);
    }
  }
  const calls = JSON.parse(await value('JSON.stringify(window._webAgentDemoToolCalls)'));
  assert.ok(calls.includes('time-wasm/time.now'), 'The model must actually call the time tool');
  assert.deepEqual(errors, [], 'The checklist must have no page or console errors');
  console.log('PASS: all five steps completed with the real time tool, without sidebar setup.');
} finally {
  clearTimeout(deadline);
  await session?.close();
  server.close();
}
