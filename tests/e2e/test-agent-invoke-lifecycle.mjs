// An invocation waiting on an agent whose tab closes fails at once, instead
// of leaving the caller waiting out its timeout.
//
// Drives the real extension in a fresh Firefox profile, as
// test-agent-answer-provenance.mjs does: two local servers on different
// ports are two origins. "bank" registers an agent that never answers;
// "caller" invokes it with a 2-minute timeout; then the bank's tab moves to
// another site, and, in a second round, a bank tab closes.
// Needs no model and no bridge.
//
// Requires: the Firefox extension built (npm run build from extension/).
//
// Usage:
//   node test-agent-invoke-lifecycle.mjs [--keep-open]
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

const PAGE = '<!doctype html><title>agent invoke lifecycle e2e</title><pre id="log"></pre>';
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
const deadline = setTimeout(() => controller.abort(new Error('Agent invoke lifecycle e2e test timed out')), 200_000);

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

  // Runs one scenario: the bank page at `bankUrl` registers an agent that
  // takes the invocation and never answers, the caller invokes it with a
  // long timeout, then `leave(tabId)` takes the bank's page away. The
  // caller must hear ERR_AGENT_NOT_FOUND within seconds.
  async function scenario(name, bankUrl, leave) {
    const bank = await pageEval(bankUrl);
    await bank(`
      window.__e2e = null;
      window.__invoked = 0;
      (async () => {
        try {
          const p = await window.agent.requestPermissions({
            scopes: ['agents:register', 'agents:crossOrigin'],
            agentOrigins: [${JSON.stringify(CALLER)}],
            reason: 'e2e: register the bank agent',
          });
          if (!p.granted) throw new Error('bank permission denied');
          const me = await window.agent.agents.register({ name: 'Bank', acceptsInvocations: true });
          window.agent.agents.onInvoke(() => { window.__invoked++; return new Promise(() => {}); });
          window.__e2e = { done: true, id: me.id };
        } catch (e) { window.__e2e = { done: true, error: e.message }; }
      })();
      true
    `);
    const bankState = await settle(bank);
    assert.equal(bankState.error, undefined, `${name}: bank setup failed: ` + bankState.error);

    await caller(`
      window.__e2e = null;
      (async () => {
        try {
          if (!window.__registered) {
            const p = await window.agent.requestPermissions({
              scopes: ['agents:register', 'agents:invoke', 'agents:crossOrigin'],
              agentOrigins: [${JSON.stringify(BANK)}],
              reason: 'e2e: call the bank agent',
            });
            if (!p.granted) throw new Error('caller permission denied');
            await window.agent.agents.register({ name: 'Caller' });
            window.__registered = true;
          }
          const answer = await window.agent.agents.invoke(${JSON.stringify(bankState.id)}, { task: 'balance', timeout: 120000 });
          window.__e2e = { done: true, answer };
        } catch (e) {
          window.__e2e = { done: true, error: e.message, code: e.code };
        }
      })();
      true
    `);

    // Wait until the bank's agent has the invocation, granting the caller's
    // prompts meanwhile.
    for (let i = 0; i < 120; i++) {
      if (Number(await bank('String(window.__invoked)')) > 0) break;
      await grantPrompt(250);
    }
    assert.ok(Number(await bank('String(window.__invoked)')) > 0, `${name}: the bank agent never received the invocation`);

    // Match patterns can't name a port, so find the bank's tab by its URL.
    // An evaluation's promise isn't awaited, so the result is polled.
    const leftAt = Date.now();
    await sval(`window.__left = null; (async () => {
      const tabs = await browser.tabs.query({});
      const tab = tabs.find(t => (t.url || '') === ${JSON.stringify(bankUrl)});
      if (!tab) { window.__left = 'no bank tab among ' + tabs.map(t => t.url).join(', '); return; }
      ${leave}
      window.__left = 'left ' + tab.id;
    })(); true`);
    let left = 'null';
    for (let i = 0; i < 40 && left === 'null'; i++) {
      await sleep(100);
      left = await sval('String(window.__left)');
    }
    assert.match(left, /^left /, left);

    const callerState = await settle(caller, 20_000);
    const since = Date.now() - leftAt;
    assert.equal(callerState.error, undefined, `${name}: invoke must resolve, not reject: ` + JSON.stringify(callerState));
    assert.equal(callerState.answer.success, false, `${name}: invoke must fail: ` + JSON.stringify(callerState.answer));
    assert.equal(callerState.answer.error?.code, 'ERR_AGENT_NOT_FOUND', `${name}: unexpected answer: ` + JSON.stringify(callerState.answer));
    assert.ok(since < 10_000, `${name}: the caller must hear within seconds, took ${since} ms`);
    console.log(`PASS: ${name}: the waiting invoke failed with ERR_AGENT_NOT_FOUND in ${since} ms.`);
  }

  const caller = await pageEval(CALLER + '/?caller=1');

  // The bank's tab moves to another site while the caller waits.
  await scenario('navigating away', BANK + '/', 'await browser.tabs.update(tab.id, { url: ' + JSON.stringify(CALLER + '/elsewhere') + ' });');

  // A fresh bank tab, closed while the caller waits.
  await sval(`browser.tabs.create({ url: ${JSON.stringify(BANK + '/?n=2')} }); true`);
  await sleep(1500);
  await scenario('closing the tab', BANK + '/?n=2', 'await browser.tabs.remove(tab.id);');

  assert.deepEqual(pageErrors, [], 'no uncaught page errors: ' + JSON.stringify(pageErrors));
  console.log('PASS: a waiting invoke fails at once when its agent\'s page goes, in Firefox.');
} finally {
  clearTimeout(deadline);
  if (!keepOpen) await session?.close();
  bankServer.close();
  callerServer.close();
}
