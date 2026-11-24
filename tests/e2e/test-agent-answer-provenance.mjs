// Real round trip: an agent on one site answers a page on another, and the
// answer says which site's agent sent it (`provenance`), set by Harbor from
// its own registry rather than by the answering page.
//
// Drives the real extension in a fresh Firefox profile. Two local servers on
// different ports are two origins: "bank" registers an agent, "caller"
// invokes and messages it. The test turns on Multi-Agent from the sidebar
// and clicks Harbor's permission prompts, using the same RDP
// evaluate-and-poll pattern as test-page-tools-agent.mjs. Needs no model and
// no bridge.
//
// Requires: the Firefox extension built (npm run build from extension/).
//
// Usage:
//   node test-agent-answer-provenance.mjs [--keep-open]
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

const PAGE = '<!doctype html><title>agent provenance e2e</title><pre id="log"></pre>';
async function serve() {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(PAGE);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}
const bankServer = await serve();
const callerServer = await serve();
const BANK = `http://127.0.0.1:${bankServer.address().port}`;
const CALLER = `http://127.0.0.1:${callerServer.address().port}`;

let session;
let remote;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('Agent provenance e2e test timed out')), 200_000);

try {
  session = await launchFirefox({ startUrl: `${CALLER}/`, signal: controller.signal }, {
    createRunner: createExtensionRunner, firefoxApp, getManifest,
    firefoxClient: async options => remote = await connectWithMaxRetries(options),
  });

  const handleMessage = remote.client._handleMessage.bind(remote.client);
  const pageErrors = [];
  remote.client._handleMessage = packet => {
    if (['evaluationResult', 'pageError', 'consoleAPICall'].includes(packet.type)) {
      if (packet.type === 'pageError') pageErrors.push(packet);
      remote.client.emit('provenance-event', packet);
    } else handleMessage(packet);
  };

  async function evaluate(actor, text, timeoutMs = 20_000) {
    controller.signal.throwIfAborted();
    let listener;
    let timer;
    const result = new Promise((resolve, reject) => {
      listener = packet => {
        if (packet.type !== 'evaluationResult' || packet.from !== actor) return;
        packet.hasException ? reject(new Error(packet.exceptionMessage || 'Page evaluation failed')) : resolve(packet.result);
      };
      remote.client.on('provenance-event', listener);
      timer = setTimeout(() => reject(new Error('Page evaluation timed out: ' + text.slice(0, 80))), timeoutMs);
    });
    try {
      await remote.client.request({ to: actor, type: 'evaluateJSAsync', text, disableBreaks: true });
      return await result;
    } finally {
      clearTimeout(timer);
      remote.client.removeListener('provenance-event', listener);
    }
  }

  const target = async actor => (await remote.client.request({ to: actor, type: 'getTarget' })).frame;

  async function findTab(prefix, timeoutMs = 10_000) {
    const expires = Date.now() + timeoutMs;
    let lastSeen = [];
    while (Date.now() < expires) {
      const { tabs } = await remote.client.request('listTabs');
      lastSeen = tabs.map(t => t.url);
      const tab = tabs.find(t => t.url.startsWith(prefix));
      if (tab) return tab;
      await sleep(200);
    }
    throw new Error(`Tab ${prefix} not found among: ${lastSeen.join(', ')}`);
  }

  async function pageEval(prefix) {
    const frame = await target((await findTab(prefix)).actor);
    return text => evaluate(frame.consoleActor, text);
  }

  async function grantPrompt(timeoutMs = 15_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const { tabs } = await remote.client.request('listTabs');
      const popup = tabs.find(t => t.url.includes('/permission-prompt.html'));
      if (popup) {
        const prompt = await target(popup.actor);
        // Click on a timer: the prompt window closes on click, and an
        // evaluation still running in it would never answer.
        await evaluate(prompt.consoleActor,
          '(() => { const b = document.querySelector("#btn-grant"); if (!b) return false; setTimeout(() => b.click(), 0); return true; })()',
          5_000).catch(() => false);
        await sleep(500);
        return true;
      }
      await sleep(150);
    }
    return false;
  }

  // Waits for a window.__e2e value the page sets when its async work ends,
  // granting any Harbor prompt that opens meanwhile.
  async function settle(value, timeoutMs = 30_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const raw = await value('JSON.stringify(window.__e2e ?? null)');
      const state = JSON.parse(raw);
      if (state?.done) return state;
      await grantPrompt(500);
    }
    throw new Error('Page work did not finish; last state: ' + (await value('JSON.stringify(window.__e2e ?? null)')));
  }

  // --- Turn on Multi-Agent (off by default) from the sidebar, the way the
  // person would, then open the two sites in fresh tabs.
  const { addons } = await remote.client.request('listAddons');
  const harbor = addons.find(a => a.id === 'harbor@krikorian.co');
  assert.ok(harbor, 'harbor extension not found in listAddons');
  const uuid = (harbor.manifestURL || '').match(/moz-extension:\/\/([a-f0-9-]+)\//)?.[1];
  assert.ok(uuid, 'no moz-extension UUID in ' + harbor.manifestURL);
  const sidebarUrl = `moz-extension://${uuid}/sidebar.html`;
  const startFrame = await target((await findTab(CALLER)).actor);
  await remote.client.request({ to: startFrame.actor, type: 'navigateTo', url: sidebarUrl });
  await sleep(1500);
  const sval = await pageEval(sidebarUrl);
  await sval(`
    (() => {
      const cb = document.getElementById('flag-multiAgent');
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
      return true;
    })()
  `);
  await sleep(800);
  await sval(`(async () => {
    await browser.tabs.create({ url: ${JSON.stringify(BANK + '/')} });
    await browser.tabs.create({ url: ${JSON.stringify(CALLER + '/?caller=1')} });
    return true;
  })()`);
  await sleep(1500);

  // --- The bank's page registers an agent that answers invocations and
  // records the messages it receives.
  const bank = await pageEval(BANK);
  await bank(`
    window.__e2e = null;
    window.__received = [];
    (async () => {
      try {
        const p = await window.agent.requestPermissions({
          scopes: ['agents:register', 'agents:message', 'agents:crossOrigin'],
          agentOrigins: [${JSON.stringify(CALLER)}],
          reason: 'e2e: register the bank agent',
        });
        if (!p.granted) throw new Error('bank permission denied');
        const me = await window.agent.agents.register({ name: 'Bank', acceptsInvocations: true, acceptsMessages: true });
        window.agent.agents.onInvoke(async () => ({ balance: 12 }));
        window.agent.agents.onMessage((m) => window.__received.push(m));
        window.__e2e = { done: true, id: me.id };
      } catch (e) { window.__e2e = { done: true, error: e.message }; }
    })();
    true
  `);
  const bankState = await settle(bank);
  assert.equal(bankState.error, undefined, 'bank setup failed: ' + bankState.error);
  console.log('PASS: the bank site registered an agent.');

  // --- The caller invokes it, then the bank messages the caller.
  const caller = await pageEval(CALLER + '/?caller=1');
  await caller(`
    window.__e2e = null;
    window.__received = [];
    (async () => {
      try {
        const p = await window.agent.requestPermissions({
          scopes: ['agents:register', 'agents:invoke', 'agents:message', 'agents:crossOrigin'],
          agentOrigins: [${JSON.stringify(BANK)}],
          reason: 'e2e: call the bank agent',
        });
        if (!p.granted) throw new Error('caller permission denied');
        const me = await window.agent.agents.register({ name: 'Caller', acceptsMessages: true });
        window.agent.agents.onMessage((m) => window.__received.push(m));
        const answer = await window.agent.agents.invoke(${JSON.stringify(bankState.id)}, { task: 'balance' });
        window.__e2e = { done: true, id: me.id, answer };
      } catch (e) { window.__e2e = { done: true, error: e.message }; }
    })();
    true
  `);
  const callerState = await settle(caller);
  assert.equal(callerState.error, undefined, 'caller failed: ' + callerState.error);
  assert.equal(callerState.answer.success, true, 'invoke must succeed: ' + JSON.stringify(callerState.answer));
  assert.deepEqual(callerState.answer.result, { balance: 12 });
  assert.deepEqual(callerState.answer.provenance, { source: 'agent', origin: BANK, agentId: bankState.id },
    'the invoke answer must name the bank agent\'s site: ' + JSON.stringify(callerState.answer));
  console.log('PASS: the invoke answer carries the bank site\'s provenance.');

  await bank(`window.agent.agents.send(${JSON.stringify(callerState.id)}, { hi: 1 }).then(r => { window.__sent = r; }); true`);
  let received = [];
  for (let i = 0; i < 40 && received.length === 0; i++) {
    await grantPrompt(250);
    received = JSON.parse(await caller('JSON.stringify(window.__received)'));
  }
  assert.equal(received.length, 1, 'the caller must receive the bank\'s message');
  assert.deepEqual(received[0].provenance, { source: 'agent', origin: BANK, agentId: bankState.id },
    'the message must name the bank agent\'s site: ' + JSON.stringify(received[0]));
  console.log('PASS: a message from the bank\'s agent carries the bank site\'s provenance.');

  assert.deepEqual(pageErrors, [], 'no uncaught page errors: ' + JSON.stringify(pageErrors));
  console.log('PASS: agent answers carry Harbor-set provenance in Firefox.');
} finally {
  clearTimeout(deadline);
  if (!keepOpen) await session?.close();
  bankServer.close();
  callerServer.close();
}
