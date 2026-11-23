// Real round trip for HBR-148: a page's tools (document.modelContext /
// navigator.modelContext, both registerTool and addTool) reach the
// background's page-tool registry, and the person's agent (here Harbor's
// built-in agent.run, against a locally pulled Ollama model) can call them
// and get the handler's result back.
//
// Drives the real extension in a fresh Firefox profile against the
// existing demo (demo/web-agents/page-tools/), unmodified — the same RDP
// evaluate-and-poll pattern test-getting-started.mjs uses, since Firefox
// extension pages aren't reachable through Playwright's page.evaluate.
//
// Requires: the Firefox extension built (npm run build from extension/),
// the native bridge registered, and a tool-capable model already pulled in
// Ollama (this script never pulls one). Skips with a clear message if no
// local model is available.
//
// Usage:
//   node test-page-tools-agent.mjs [--keep-open]
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

const keepOpen = process.argv.includes('--keep-open');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function checkOllamaHasToolModel() {
  try {
    const res = await fetch('http://127.0.0.1:11434/api/tags');
    if (!res.ok) return false;
    const data = await res.json();
    return Array.isArray(data.models) && data.models.length > 0;
  } catch {
    return false;
  }
}

if (!(await checkOllamaHasToolModel())) {
  console.log('SKIP: no local Ollama model available at 127.0.0.1:11434; this test needs one already pulled (it never pulls one itself).');
  process.exit(0);
}

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
const url = `http://127.0.0.1:${server.address().port}/web-agents/page-tools/`;

let session;
let remote;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('Page tools agent e2e test timed out')), 280_000);

try {
  session = await launchFirefox({ startUrl: url, signal: controller.signal }, {
    createRunner: createExtensionRunner, firefoxApp, getManifest,
    firefoxClient: async options => remote = await connectWithMaxRetries(options),
  });

  // Route evaluation results and console/page errors through a local emitter,
  // the same way test-getting-started.mjs does, since web-ext's RDP client
  // doesn't classify them on its own.
  const handleMessage = remote.client._handleMessage.bind(remote.client);
  const pageErrors = [];
  remote.client._handleMessage = packet => {
    if (['evaluationResult', 'pageError', 'consoleAPICall'].includes(packet.type)) {
      if (packet.type === 'pageError') pageErrors.push(packet);
      remote.client.emit('page-tools-event', packet);
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
      remote.client.on('page-tools-event', listener);
      timer = setTimeout(() => reject(new Error('Page evaluation timed out: ' + text.slice(0, 80))), timeoutMs);
    });
    try {
      await remote.client.request({ to: actor, type: 'evaluateJSAsync', text, disableBreaks: true });
      return await result;
    } finally {
      clearTimeout(timer);
      remote.client.removeListener('page-tools-event', listener);
    }
  }

  const target = async actor => (await remote.client.request({ to: actor, type: 'getTarget' })).frame;

  async function currentFrame(timeoutMs = 10_000) {
    const expires = Date.now() + timeoutMs;
    let lastSeen = [];
    while (Date.now() < expires) {
      const { tabs } = await remote.client.request('listTabs');
      lastSeen = tabs.map(t => t.url);
      const tab = tabs.find(t => t.url.startsWith(url));
      if (tab) return target(tab.actor);
      await sleep(200);
    }
    throw new Error('Demo tab not found among: ' + lastSeen.join(', '));
  }

  let frame = await currentFrame();
  // The initial page can load before web-ext installs the extension and its
  // content script, exactly as test-getting-started.mjs notes.
  await evaluate(frame.consoleActor, 'setTimeout(() => location.reload(), 0); true');
  await sleep(1000);
  frame = await currentFrame();
  let value = text => evaluate(frame.consoleActor, text);

  assert.equal(await value('document.title'), 'Page Tools — Web Agent API');

  // document.modelContext is defined by an async content-script injection
  // (a feature-flags round trip to the background, then a script fetch),
  // which loses the race against this demo's own synchronous, load-time
  // `document.modelContext ?? navigator.modelContext` check almost every
  // time in this harness — the page decides and logs "needs Harbor" before
  // the API exists. That race is orthogonal to what this test is proving
  // (that a *registered* tool reaches the agent), so wait for the API
  // directly, then run the demo's own registration code ourselves, at a
  // moment we control instead of racing page parse.
  async function waitForModelContext(timeoutMs = 10_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const ready = await value('typeof (document.modelContext || navigator.modelContext) !== "undefined"');
      if (ready === true) return;
      await sleep(200);
    }
    throw new Error('document.modelContext/navigator.modelContext never became available');
  }

  // Copied verbatim from this demo's own <script> (minus the "if (!mc)"
  // guard, since we only call this once the API is confirmed present): the
  // same two document.modelContext.registerTool() calls and the one
  // navigator.modelContext.addTool() alias call, against the same #log and
  // .chapter p elements already in the DOM.
  const REGISTER_DEMO_TOOLS = `
    (async () => {
      const log = document.getElementById('log');
      const say = (line) => { log.textContent += '\\n' + line; };
      const mc = document.modelContext ?? navigator.modelContext;
      const paragraphs = () => Array.from(document.querySelectorAll('.chapter p'));
      function highlight(el) {
        paragraphs().forEach((p) => p.classList.toggle('highlight', p === el));
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      await mc.registerTool({
        name: 'reading_position',
        description: 'Which paragraph the reader is looking at, and the text of every paragraph with its anchor.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          const visible = paragraphs().find((p) => p.getBoundingClientRect().bottom > 0) ?? paragraphs()[0];
          say('page handler ran: reading_position -> ' + visible.id);
          return { current: visible.id, paragraphs: paragraphs().map((p) => ({ anchor: p.id, text: p.textContent })) };
        },
      });
      await mc.registerTool({
        name: 'go_to',
        description: 'Scroll to a paragraph by its anchor (p1 to p5) and highlight it.',
        inputSchema: { type: 'object', properties: { anchor: { type: 'string' } }, required: ['anchor'] },
        execute: async ({ anchor }) => {
          const el = document.getElementById(String(anchor));
          if (!el || !el.matches('.chapter p')) throw new Error('No paragraph with anchor "' + anchor + '"');
          highlight(el);
          say('page handler ran: go_to(' + anchor + ')');
          return { at: anchor };
        },
      });
      mc.addTool({
        name: 'count_words',
        description: 'Count the words in a paragraph, by its anchor.',
        inputSchema: { type: 'object', properties: { anchor: { type: 'string' } }, required: ['anchor'] },
        handler: async ({ anchor }) => {
          const el = document.getElementById(String(anchor));
          if (!el) throw new Error('No paragraph with anchor "' + anchor + '"');
          const words = el.textContent.trim().split(/\\s+/).length;
          say('page handler ran: count_words(' + anchor + ') -> ' + words);
          return words;
        },
      });
      return true;
    })()
  `;

  await waitForModelContext();
  await value(REGISTER_DEMO_TOOLS);

  // The demo registers 3 tools: reading_position and go_to via
  // document.modelContext.registerTool, count_words via the older
  // navigator.modelContext.addTool alias.
  const initialNames = JSON.parse(await value('JSON.stringify(navigator.modelContext.tools.map(t => t.name).sort())'));
  assert.deepEqual(initialNames, ['count_words', 'go_to', 'reading_position'],
    'The demo must have registered its tools with both registerTool and addTool before we proceed');

  // --- Outcome 1a: the background registry receives the tools
  // (page_tools.sync answered ok). Spy on the page/content-script channel
  // for the sync's own acknowledgement, then force a fresh sync by
  // registering one more tool, so we observe a real ack rather than
  // inferring it from a later agent call.
  await value(`
    window.__syncAcks = [];
    window.addEventListener('message', (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (d && d.channel === 'harbor_page_api' && d.response && d.response.result
          && typeof d.response.result.accepted === 'boolean') {
        window.__syncAcks.push(d.response.result.accepted);
      }
    });
    true
  `);
  await value(`
    (async () => {
      await document.modelContext.registerTool({
        name: 'confirm_tools_present',
        description: 'Call this tool with no arguments to confirm the page tools are reachable right now.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => {
          document.getElementById('log').textContent += '\\npage handler ran: confirm_tools_present';
          return { present: true };
        },
      });
      return true;
    })()
  `);
  {
    const expires = Date.now() + 10_000;
    let acked = false;
    while (Date.now() < expires) {
      const acks = JSON.parse(await value('JSON.stringify(window.__syncAcks)'));
      if (acks.includes(true)) { acked = true; break; }
      await sleep(200);
    }
    assert.ok(acked, 'page_tools.sync for the newly-registered tool must be acknowledged (ok:true) by the background registry');
  }

  async function setTask(task) {
    await value(`document.getElementById('task').value = ${JSON.stringify(task)}; true`);
  }

  async function clickRun() {
    await value('document.getElementById("run").click(); true');
  }

  async function grantPermissionIfPrompted(timeoutMs = 15_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const { tabs } = await remote.client.request('listTabs');
      const popup = tabs.find(t => t.url.includes('/permission-prompt.html'));
      if (popup) {
        const prompt = await target(popup.actor);
        await evaluate(prompt.consoleActor, 'document.querySelector("#btn-grant").click(); true');
        return true;
      }
      await sleep(150);
    }
    return false;
  }

  // Waits until the log stops changing for a bit (the run's for-await loop
  // ended, successfully or with an error) rather than matching a specific
  // string that may never appear when we expect the call to fail.
  async function waitForSettledLog(timeoutMs = 90_000) {
    const expires = Date.now() + timeoutMs;
    let last = null;
    let stableSince = null;
    while (Date.now() < expires) {
      const text = await value('document.getElementById("log").textContent');
      if (text === last) {
        if (stableSince === null) stableSince = Date.now();
        else if (Date.now() - stableSince > 2000) return text;
      } else {
        last = text;
        stableSince = null;
      }
      await sleep(400);
    }
    throw new Error('Run did not settle within ' + timeoutMs + 'ms; last log: ' + last);
  }

  // --- Outcome 1b: a call from the agent side runs the page handler and the
  // result comes back. The first run also exercises the permission prompt.
  await setTask('Call the confirm_tools_present tool now, with no arguments, then briefly say you are done.');
  await clickRun();
  const grantedFirstRun = await grantPermissionIfPrompted();
  assert.ok(grantedFirstRun, 'The permission prompt must appear for the first agent.run on this page');
  const afterFirstRun = await waitForSettledLog();
  assert.match(afterFirstRun, /page handler ran: confirm_tools_present/,
    'agent.run must have called the page tool and run its handler: ' + afterFirstRun);
  console.log('PASS: agent.run reached a freshly-registered page tool through the background registry.');

  // --- Lifetime: a same-document pushState and a hash change keep the
  // tools (docs/PAGE_TOOLS_FOR_AGENTS.md). Exercise one of the demo's own
  // (registerTool-sourced) tools, which was never re-registered by any
  // script of ours, to show the *original* sync survived the navigation.
  await value('history.pushState({}, "", location.pathname + "?e2e=1"); true');
  await value('location.hash = "kept"; true');
  await setTask('Call the go_to tool with anchor "p4", then briefly say you are done.');
  await clickRun();
  const afterPushState = await waitForSettledLog();
  assert.match(afterPushState, /page handler ran: go_to\(p4\)/,
    'A same-document pushState + hash change must keep the page tools available to agent.run: ' + afterPushState);
  console.log('PASS: tools registered before a pushState/hash change are still reachable afterward.');

  // --- Lifetime: a reload drops the tools. confirm_tools_present was never
  // re-registered by the demo's own script (only reading_position, go_to,
  // count_words are), so if the background still offered it after reload,
  // that would itself be the bug. The assertion is the handler never runs,
  // which holds regardless of what the model attempts.
  await value('location.reload(); true');
  await sleep(1000);
  frame = await currentFrame();
  value = text => evaluate(frame.consoleActor, text);
  await waitForModelContext();
  // Re-run the demo's own registration for the new document — the same
  // real registerTool/addTool tools, but *not* confirm_tools_present,
  // which this test added only to the old document.
  await value(REGISTER_DEMO_TOOLS);
  const namesAfterReload = JSON.parse(await value('JSON.stringify(navigator.modelContext.tools.map(t => t.name).sort())'));
  assert.deepEqual(namesAfterReload, ['count_words', 'go_to', 'reading_position'],
    'The demo must re-register its own tools on reload');

  await setTask('Call the confirm_tools_present tool now, with no arguments, then briefly say you are done.');
  await clickRun();
  const afterReload = await waitForSettledLog();
  assert.doesNotMatch(afterReload, /page handler ran: confirm_tools_present/,
    'A reload must drop a tool that was registered under the old document, so its handler must not run: ' + afterReload);
  console.log('PASS: a reload dropped the tool registered under the old document.');

  assert.deepEqual(pageErrors, [], 'The page must have no uncaught errors: ' + JSON.stringify(pageErrors));

  console.log('PASS: page tools registered with registerTool and addTool reach the person\'s agent through the background registry, survive a same-document navigation, and are dropped on reload.');
} finally {
  clearTimeout(deadline);
  if (!keepOpen) await session?.close();
  server.close();
}
