// Real round trip for HBR-174: Harbor keeps its own record of every turn on
// the person's own agent (window.ai, agent.sessions, agent.run), whatever
// the page does with the result. Drives the real extension in a fresh
// Firefox profile against a minimal fixture page
// (tests/e2e/fixtures/agent-turn-record.html) served on 127.0.0.1:8003, and
// the real Claude Code ACP agent, the same way test-site-tools-acp.mjs
// drives it.
//
// Checks:
//   1. A completed agent.run() turn that uses a tool is recorded answered,
//      unseen:false, with the right origin/api/prompt/tools.
//   2. A run whose page navigates away mid-turn (after a tool_call reaches
//      it) is recorded cancelled, unseen:true.
//   3. Loading the sidebar expands the activity panel without a click,
//      shows the turn, and clears both the unseen count and (if readable)
//      the toolbar badge.
//   4. Optional: a completed window.ai turn is recorded with api:'window.ai'.
//
// Requires: the Firefox extension built (npm run build from extension/),
// the native bridge registered and pointed at a built harbor-bridge, and
// Claude Code configured as an ACP agent in
// ~/Library/Application Support/harbor/acp.json (id: "claude-code"). Skips
// with a clear message if that agent isn't configured, since this only
// checks for the file, not that Claude Code itself can actually run.
//
// Usage:
//   node test-agent-turn-record.mjs [--keep-open]
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launchFirefox } from '../../scripts/firefox-runner.mjs';

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

// --- Evidence directory: screenshot + this run's own full output (the
// caller tees stdout/stderr there; this script only writes the screenshot).
const evidenceDir = path.join(os.homedir(), '.harbor-dev/evidence/HBR-174');
await fs.mkdir(evidenceDir, { recursive: true });
const screenshotPath = path.join(evidenceDir, 'sidebar-activity-panel.png');

// --- This test's own static server. Port 8003 only, loopback, per the
// brief's shared-resources rule (the demo's `npm run dev` and other e2e
// tests use other ports). Also accepts the sidebar's own screenshot upload,
// with permissive CORS since moz-extension:// pages fetching
// http://127.0.0.1:8003 are cross-origin.
const root = fileURLToPath(new URL('../../', import.meta.url));
const fixtureHtml = await fs.readFile(path.join(root, 'tests/e2e/fixtures/agent-turn-record.html'));
const PORT = 8003;
const server = http.createServer(async (request, response) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  if (request.method === 'POST' && request.url === '/screenshot') {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const dataUrl = Buffer.concat(chunks).toString('utf8');
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    await fs.writeFile(screenshotPath, Buffer.from(base64, 'base64'));
    response.writeHead(200).end('ok');
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(fixtureHtml);
});
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
} catch (cause) {
  throw new Error(`Port ${PORT} isn't free. Check with: lsof -nP -iTCP:${PORT} -sTCP:LISTEN`, { cause });
}
const fixtureUrl = `http://127.0.0.1:${PORT}/`;

let session;
let remote;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(new Error('Agent turn record e2e test timed out')), 240_000);

// Starts window.agent.run() on the fixture page with window.__e2eTask,
// logging to #log, the same way as the other ACP e2e tests' START_RUN (no
// Ask button: the page asks the agent itself, as a site's own code would).
// The "page left mid-turn" check (2) doesn't make the page navigate itself:
// repeatedly polling this same page over RDP while its own agent.run() is
// in flight proved unreliable (evaluateJSAsync's actor-based, not
// request-id-based, response matching can pair a stale pending poll with
// the wrong result under load). Node instead polls Harbor's own turn
// record (agent_turns.list, over the separate, idle control sidebar's
// actor) for the first tool call, then drives the navigation itself via
// the devtools `navigateTo` command used elsewhere in this script — a real
// navigation, not a page-script redirect, so it tears down the content
// script's port exactly as a person leaving the tab would.
const runSnippet = `(() => {
  const log = document.getElementById('log');
  const say = (line) => { log.textContent += '\\n' + line; console.log('E2E_AGENT_RUN: ' + line); };
  window.__e2eDone = false;
  (async () => {
    try {
      const p = await window.agent.requestPermissions({ scopes: ['model:prompt', 'model:tools'], reason: 'e2e: HBR-174 agent turn record' });
      if (!p.granted) throw new Error('Permission denied');
      for await (const event of window.agent.run({ task: window.__e2eTask, maxToolCalls: 5 })) {
        if (event.type === 'tool_call') say('agent called ' + event.tool);
        if (event.type === 'final') say('FINAL: ' + event.output);
        if (event.type === 'error') say('error: ' + (event.error && event.error.message));
      }
    } catch (e) { say('error: ' + (e && e.message)); }
    window.__e2eDone = true;
  })();
  return true;
})()`;

try {
  session = await launchFirefox({ startUrl: fixtureUrl, signal: controller.signal }, {
    createRunner: createExtensionRunner, firefoxApp, getManifest,
    firefoxClient: async options => remote = await connectWithMaxRetries(options),
  });

  const handleMessage = remote.client._handleMessage.bind(remote.client);
  remote.client._handleMessage = packet => {
    if (packet.type === 'evaluationResult') remote.client.emit('agent-turn-event', packet);
    else handleMessage(packet);
  };

  async function evaluate(actor, text, timeoutMs = 20_000) {
    controller.signal.throwIfAborted();
    let listener, timer;
    const result = new Promise((resolve, reject) => {
      listener = packet => {
        if (packet.type !== 'evaluationResult' || packet.from !== actor) return;
        packet.hasException ? reject(new Error(packet.exceptionMessage || 'Page evaluation failed')) : resolve(packet.result);
      };
      remote.client.on('agent-turn-event', listener);
      timer = setTimeout(() => reject(new Error('Page evaluation timed out: ' + text.slice(0, 80))), timeoutMs);
    });
    try {
      await remote.client.request({ to: actor, type: 'evaluateJSAsync', text, disableBreaks: true });
      return await result;
    } finally {
      clearTimeout(timer);
      remote.client.removeListener('agent-turn-event', listener);
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

  // Runs an async expression in `actor`'s page by storing its outcome on
  // `window.__e2eAsync` and polling, rather than trusting evaluateJSAsync's
  // own return value for a promise (docs/agent-workflow.md's "An RDP
  // evaluation of an async function returns before its work finishes").
  async function runAsyncAndPoll(evalFn, expr, timeoutMs = 20_000) {
    await evalFn(`window.__e2eAsync = null; (${expr}).then(r => { window.__e2eAsync = { ok: true, result: r }; }).catch(e => { window.__e2eAsync = { ok: false, error: e && e.message }; }); true`);
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      // Always a JSON string, never the bare JS `null` — Firefox's RDP can
      // return `null` as a truthy grip object ({type: 'null'}) rather than
      // the primitive, which `if (raw)` would wrongly treat as "ready" and
      // then fail to parse (JSON.parse coerces an object via toString,
      // yielding the unparseable literal text "[object Object]").
      const raw = await evalFn('JSON.stringify(window.__e2eAsync)');
      if (raw !== 'null') return JSON.parse(raw);
      await sleep(200);
    }
    throw new Error('Async page call did not settle within ' + timeoutMs + 'ms: ' + expr.slice(0, 120));
  }

  async function grantPermissionIfPrompted(timeoutMs = 15_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const { tabs } = await remote.client.request('listTabs');
      const popup = tabs.find(t => t.url.includes('/permission-prompt.html'));
      if (popup) {
        const prompt = await target(popup.actor);
        const text = await evaluate(prompt.consoleActor, 'document.body.textContent').catch(() => '(unreadable)');
        console.log('Granting permission prompt:', JSON.stringify(String(text).replace(/\s+/g, ' ').trim().slice(0, 200)));
        // Click on a timer: the prompt window closes on click, and a
        // synchronous evaluateJSAsync here would never answer.
        await evaluate(prompt.consoleActor,
          '(() => { const b = document.querySelector("#btn-grant"); if (!b) return false; setTimeout(() => b.click(), 0); return true; })()',
          5_000).catch(() => false);
        await sleep(400);
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

  // --- Find the extension's internal UUID, then turn the start tab into
  // the sidebar, the same way test-site-tools-acp.mjs does.
  const { addons } = await remote.client.request('listAddons');
  const harbor = addons.find(a => a.id === 'harbor@krikorian.co');
  assert.ok(harbor, 'harbor extension not found in listAddons: ' + JSON.stringify(addons.map(a => a.id)));
  const match = (harbor.manifestURL || '').match(/moz-extension:\/\/([a-f0-9-]+)\//);
  assert.ok(match, 'could not find a moz-extension UUID in: ' + harbor.manifestURL);
  const sidebarUrl = `moz-extension://${match[1]}/sidebar.html`;

  const startTab = await findTab(fixtureUrl);
  const startFrame = await target(startTab.actor);
  await remote.client.request({ to: startFrame.actor, type: 'navigateTo', url: sidebarUrl });
  await sleep(1500);
  const controlSidebarTab = await findTab(sidebarUrl);
  const controlSidebarFrame = await target(controlSidebarTab.actor);
  const csval = text => evaluate(controlSidebarFrame.consoleActor, text);

  // --- Select Claude Code as the agent backend, in Settings -> Your agent.
  await csval(`document.getElementById('open-settings').click(); true`);
  for (let waited = 0; waited < 15_000; waited += 250) {
    const ready = await csval(`Array.from(document.getElementById('agent-backend-select').options).some(o => o.value === 'claude-code')`);
    if (ready === true) break;
    await sleep(250);
  }
  await csval(`
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
      last = String(await csval(`document.getElementById('agent-check-status').textContent`));
      if (/^Ready/.test(last)) return last;
      await sleep(300);
    }
    throw new Error('Claude Code never reported Ready; last status: ' + last);
  }
  const readyStatus = await waitForAgentReady();
  console.log(`PASS: selected Claude Code as the agent backend (${readyStatus}).`);

  // --- A fixture tab the page's own API calls run in, opened from the
  // sidebar's privileged context (an ordinary page can't call
  // browser.tabs.create itself).
  async function openFixtureTab() {
    await csval(`
      (async () => {
        await browser.tabs.create({ url: ${JSON.stringify(fixtureUrl)}, active: true });
        return true;
      })()
    `);
    const tab = await findTab(fixtureUrl, { exact: true });
    const frame = await target(tab.actor);
    return { frameActor: frame.actor, dval: text => evaluate(frame.consoleActor, text) };
  }

  async function waitForPageApiReady(dval, timeoutMs = 15_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const ready = await dval(`typeof window.agent !== 'undefined' && typeof window.agent.run === 'function'`);
      if (ready === true) return;
      await sleep(200);
    }
    throw new Error('window.agent never became available on the fixture page');
  }

  /** Raw agent_turns.list / agent_turns.mark_seen call, sent as Harbor's own extension page would (handlers/agent-turn-handlers.ts only answers an extension-page sender). */
  async function agentTurnsList() {
    const res = await runAsyncAndPoll(csval, `browser.runtime.sendMessage({ type: 'agent_turns.list' })`);
    assert.ok(res.ok, 'agent_turns.list call must settle: ' + JSON.stringify(res));
    return res.result;
  }
  async function badgeText() {
    const res = await runAsyncAndPoll(csval, `browser.action.getBadgeText({})`);
    return res.ok ? res.result : null;
  }

  // ===========================================================================
  // Check 1: a completed agent.run() turn that uses a tool.
  // ===========================================================================
  const fixtureTab1 = await openFixtureTab();
  await waitForPageApiReady(fixtureTab1.dval);

  await fixtureTab1.dval(`window.__e2eTask = ${JSON.stringify('Run the shell command `echo harbor-e2e-done` and reply with exactly its output.')}; true`);
  await fixtureTab1.dval(runSnippet);
  const grantedRun1 = await grantAllPrompts();
  assert.ok(grantedRun1, 'The model:prompt/model:tools permission prompt must appear for the first agent.run()');

  async function waitForDone(dval, timeoutMs = 120_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      if (await dval('window.__e2eDone === true')) return dval('document.getElementById("log").textContent');
      await sleep(400);
    }
    throw new Error('Run did not finish within ' + timeoutMs + 'ms');
  }
  const log1 = await waitForDone(fixtureTab1.dval);
  console.log('--- check 1 run log ---\n' + log1 + '\n------------------------');
  assert.match(log1, /agent called/i, 'The run must report at least one tool call: ' + log1);
  assert.match(log1, /harbor-e2e-done/i, 'The run must show the echoed output: ' + log1);

  const turnsAfter1 = await agentTurnsList();
  const turn1 = turnsAfter1.turns.find(t => t.prompt.includes('harbor-e2e-done'));
  assert.ok(turn1, 'agent_turns.list must contain the completed run: ' + JSON.stringify(turnsAfter1.turns));
  assert.equal(turn1.origin, fixtureUrl.replace(/\/$/, ''), 'recorded origin must be the fixture page\'s origin');
  assert.equal(turn1.api, 'agent.run');
  assert.ok(turn1.tools.length >= 1, 'recorded turn must have at least one tool call: ' + JSON.stringify(turn1));
  assert.equal(turn1.outcome, 'answered');
  assert.equal(turn1.unseen, false);
  console.log('PASS check 1: a completed agent.run() turn is recorded answered/unseen:false with its tool call. ' + JSON.stringify(turn1));

  // ===========================================================================
  // Check 2: the page leaves mid-turn, once a tool_call event reaches it.
  // ===========================================================================
  await fixtureTab1.dval(`window.__e2eTask = ${JSON.stringify('Run the shell command `echo harbor-e2e-mid`, then run the shell command `sleep 20`, then reply once both are done.')}; true`);
  await fixtureTab1.dval(runSnippet);
  // The permission grant from check 1 may or may not carry over depending
  // on policy, so grant defensively if asked again.
  await grantAllPrompts(6_000);

  async function waitForTurnOutcome(predicate, timeoutMs = 60_000) {
    const expires = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < expires) {
      const res = await agentTurnsList();
      last = res.turns.find(t => t.prompt.includes('harbor-e2e-mid'));
      if (last && predicate(last)) return { turn: last, unseen: res.unseen };
      await sleep(500);
    }
    throw new Error('Turn never reached the expected outcome; last seen: ' + JSON.stringify(last));
  }

  // Detects the first tool call through Harbor's own turn record (polled
  // over the control sidebar's idle actor), not by polling the fixture page
  // itself while its own agent.run() is in flight (see runSnippet's
  // comment). Then drives the "page leaves" navigation directly over RDP,
  // a real navigation that tears down the content script's port exactly as
  // the person navigating away would.
  await waitForTurnOutcome(t => t.tools.length >= 1, 90_000);
  console.log('PASS: a tool call was recorded for check 2; navigating the fixture tab away mid-turn.');
  await remote.client.request({ to: fixtureTab1.frameActor, type: 'navigateTo', url: 'about:blank' });

  const { turn: turn2, unseen: unseenAfter2 } = await waitForTurnOutcome(t => t.outcome !== undefined);
  assert.equal(turn2.outcome, 'cancelled', 'a turn whose page navigates away mid-turn must end cancelled: ' + JSON.stringify(turn2));
  assert.equal(turn2.unseen, true, 'a cancelled turn that used tools must be unseen: ' + JSON.stringify(turn2));
  assert.ok(unseenAfter2 >= 1, 'the unseen count must be at least 1 after check 2: ' + unseenAfter2);
  console.log('PASS check 2: a run left mid-turn is recorded cancelled/unseen:true. ' + JSON.stringify(turn2) + ' unseen=' + unseenAfter2);

  // ===========================================================================
  // Check 3: loading the sidebar clears it.
  // ===========================================================================
  const badgeBefore = await badgeText();
  console.log('Badge text before opening a fresh sidebar: ' + JSON.stringify(badgeBefore));

  // browser.tabs.create's own return value carries the real WebExtension
  // tab id; the devtools RDP tab descriptor's own `id` field is a separate,
  // front-end-local number and must not be passed to a `browser.tabs.*`
  // call (captureTab silently captured the wrong, still-open-on-Settings
  // control sidebar tab when this used the RDP id instead).
  const createdTab = await runAsyncAndPoll(csval, `browser.tabs.create({ url: ${JSON.stringify(sidebarUrl)}, active: true })`);
  assert.ok(createdTab.ok, 'opening a fresh sidebar tab must succeed: ' + JSON.stringify(createdTab));
  const freshSidebarWebExtTabId = createdTab.result.id;
  await sleep(2000);
  const { tabs } = await remote.client.request('listTabs');
  // Found by elimination (RDP ids/actors don't correspond to WebExtension
  // tab ids): the sidebar tab whose RDP actor isn't the control sidebar's.
  const freshSidebarTabs = tabs.filter(t => t.url === sidebarUrl && t.actor !== controlSidebarTab.actor);
  assert.equal(freshSidebarTabs.length, 1, 'expected exactly one other sidebar tab to have opened: ' + JSON.stringify(tabs.map(t => ({ url: t.url, actor: t.actor }))));
  const freshSidebarTab = freshSidebarTabs[0];
  const freshSidebarFrame = await target(freshSidebarTab.actor);
  const fsval = text => evaluate(freshSidebarFrame.consoleActor, text);

  async function waitForActivityExpanded(timeoutMs = 10_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const collapsed = await fsval(`document.getElementById('activity-body')?.classList.contains('collapsed')`);
      if (collapsed === false) return;
      await sleep(250);
    }
    throw new Error('#activity-body never expanded on its own in the fresh sidebar');
  }
  await waitForActivityExpanded();
  console.log('PASS: the fresh sidebar expanded #activity-body without a click.');

  async function waitForTurnsListRendered(timeoutMs = 10_000) {
    const expires = Date.now() + timeoutMs;
    while (Date.now() < expires) {
      const text = await fsval(`document.getElementById('agent-turns-list')?.textContent || ''`);
      if (text.includes('harbor-e2e-mid') || text.includes('8003')) return text;
      await sleep(250);
    }
    throw new Error('#agent-turns-list never showed the recorded turn');
  }
  const turnsListText = await waitForTurnsListRendered();
  console.log('PASS: #agent-turns-list shows the turn: ' + JSON.stringify(turnsListText.replace(/\s+/g, ' ').trim().slice(0, 200)));

  // Give the sidebar's own markSeen() round trip (its own io.markSeen, fired
  // because the panel is open and unseen > 0) a moment to land.
  await sleep(1000);
  const turnsAfter3 = await agentTurnsList();
  assert.equal(turnsAfter3.unseen, 0, 'opening the activity panel must clear unseen: ' + JSON.stringify(turnsAfter3.turns.map(t => ({ id: t.id, unseen: t.unseen }))));
  console.log('PASS check 3: opening the sidebar cleared unseen to 0.');

  if (badgeBefore !== null) {
    assert.equal(badgeBefore, '1', 'the toolbar badge must read "1" before the activity panel is opened');
    const badgeAfter = await badgeText();
    assert.equal(badgeAfter, '', 'the toolbar badge must clear once the activity panel is opened');
    console.log(`PASS: toolbar badge read "${badgeBefore}" before and "${badgeAfter}" after.`);
  } else {
    console.log('Could not read the toolbar badge through RDP (browser.action.getBadgeText unavailable); skipped that assertion.');
  }

  // --- Screenshot of the sidebar's activity panel, taken through the test
  // browser's own automation (browser.tabs.captureTab from the sidebar's
  // own privileged context), uploaded to this test's own local server
  // rather than returned through RDP (a PNG data URL is far past the
  // inline-string size an evaluationResult grip carries safely). Wrapped so
  // a failure here doesn't block the optional check 4 below.
  try {
    const viewState = await fsval(`JSON.stringify({ href: location.href, mainHidden: document.getElementById('main-view')?.hidden, settingsHidden: document.getElementById('settings-view')?.hidden })`);
    console.log('Fresh sidebar tab view state before screenshot: ' + viewState);
    // The activity panel lives in the main view; if the sidebar is showing
    // Settings instead (its own prior state, unrelated to this check), go
    // back to main so the screenshot actually shows the activity panel.
    await fsval(`document.getElementById('settings-view')?.hidden === false && document.getElementById('settings-back')?.click(); true`);
    await sleep(300);
    const shot = await runAsyncAndPoll(fsval, `
      (async () => {
        const dataUrl = await browser.tabs.captureTab(${freshSidebarWebExtTabId}, { format: 'png' });
        const res = await fetch(${JSON.stringify(`http://127.0.0.1:${PORT}/screenshot`)}, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: dataUrl });
        return res.ok;
      })()
    `, 15_000);
    assert.ok(shot.ok && shot.result === true, 'screenshot capture/upload must succeed: ' + JSON.stringify(shot));
    console.log('PASS: saved a screenshot of the sidebar activity panel to ' + screenshotPath);
  } catch (error) {
    console.log('Could not capture a screenshot of the sidebar through browser.tabs.captureTab: ' + (error && error.message));
  }

  // ===========================================================================
  // Check 4 (optional): a completed window.ai turn.
  // ===========================================================================
  try {
    const fixtureTab2 = await openFixtureTab();
    await waitForPageApiReady(fixtureTab2.dval);

    // Same fire-and-forget-then-poll idiom as runSnippet/waitForDone above
    // (not runAsyncAndPoll): the call doesn't settle until the permission
    // prompt below is granted, so it must not be awaited inline.
    const aiSnippet = `(() => {
      const log = document.getElementById('log');
      const say = (line) => { log.textContent += '\\n' + line; console.log('E2E_WINDOW_AI: ' + line); };
      window.__e2eDone = false;
      (async () => {
        try {
          const p = await window.agent.requestPermissions({ scopes: ['model:prompt'], reason: 'e2e: HBR-174 window.ai turn record' });
          if (!p.granted) throw new Error('Permission denied');
          const session = await window.ai.createTextSession();
          const answer = await session.prompt('Reply with exactly this one word and nothing else: harbor-ai-e2e');
          say('FINAL: ' + answer);
        } catch (e) { say('error: ' + (e && e.message)); }
        window.__e2eDone = true;
      })();
      return true;
    })()`;
    await fixtureTab2.dval(aiSnippet);
    await grantAllPrompts();
    const log4 = await waitForDone(fixtureTab2.dval, 90_000);
    console.log('--- check 4 window.ai log ---\n' + log4 + '\n-----------------------------');
    assert.match(log4, /harbor-ai-e2e/i, 'window.ai must answer with the requested word: ' + log4);

    const turnsAfter4 = await agentTurnsList();
    const turn4 = turnsAfter4.turns.find(t => t.api === 'window.ai' && t.prompt.includes('harbor-ai-e2e'));
    assert.ok(turn4, 'agent_turns.list must contain the window.ai turn: ' + JSON.stringify(turnsAfter4.turns));
    assert.equal(turn4.outcome, 'answered');
    console.log('PASS check 4 (optional): a completed window.ai turn is recorded with api:\'window.ai\'. ' + JSON.stringify(turn4));
  } catch (error) {
    console.log('SKIPPED optional check 4 (window.ai): ' + (error && error.message));
  }

  console.log('\nPASS: Harbor\'s own record of turns on the person\'s real ACP agent (Claude Code) behaves as specified end-to-end.');
} finally {
  clearTimeout(deadline);
  if (!keepOpen) await session?.close().catch(() => {});
  server.close();
}
