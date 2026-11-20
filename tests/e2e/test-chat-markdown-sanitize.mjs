#!/usr/bin/env node
/**
 * Page chat renders replies with marked and sanitizes them with DOMPurify
 * (extension/src/chat-markdown.ts). DOMPurify needs a real DOM, so this test
 * bundles that module, loads it into a page in headless Firefox, renders
 * hostile replies, and checks that nothing executes and that only safe
 * markup survives.
 *
 * Usage: node test-chat-markdown-sanitize.mjs   (FIREFOX=/path/to/firefox to override)
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.resolve(here, '../../extension');
const esbuild = createRequire(path.join(extension, 'package.json'))('esbuild');
const firefox = process.env.FIREFOX
  ?? (process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : 'firefox');

const bundle = (await esbuild.build({
  entryPoints: [path.join(extension, 'src/chat-markdown.ts')],
  bundle: true, format: 'iife', globalName: 'MD', write: false, logLevel: 'error',
})).outputFiles[0].text;

const server = http.createServer((req, res) => {
  if (req.url === '/md.js') { res.setHeader('content-type', 'text/javascript'); return res.end(bundle); }
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end('<!doctype html><meta charset=utf-8><body><script src="/md.js"></script>'); }
  res.statusCode = 404; res.end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pagePort = server.address().port;
const bidiPort = 9300 + Math.floor(Math.random() * 600);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-md-'));
const ff = spawn(firefox, ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${bidiPort}`], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n    ${detail}`}`);
  if (!ok) failures++;
}

try {
  let ws;
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      ws = await new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${bidiPort}/session`); w.onopen = () => res(w); w.onerror = rej; });
    } catch { await sleep(500); }
  }
  if (!ws) throw new Error('Firefox did not start');
  let id = 0; const pending = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, (m) => (m.type === 'error' ? rej(new Error(`${method}: ${m.message}`)) : res(m.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  await send('session.new', { capabilities: {} });
  const { context } = await send('browsingContext.create', { type: 'tab' });
  await send('browsingContext.navigate', { context, url: `http://127.0.0.1:${pagePort}/`, wait: 'complete' });
  const render = async (md) => (await send('script.evaluate', {
    expression: `(() => { const d = document.createElement('div'); d.appendChild(MD.renderMarkdown(${JSON.stringify(md)})); document.body.appendChild(d); return d.innerHTML; })()`,
    target: { context }, awaitPromise: false,
  })).result.value;

  const basic = await render('For **Tom**, the [keyboard](https://shop.example/k).\n\n- one\n- two');
  check('formatting renders', basic.includes('<strong>Tom</strong>') && basic.includes('<li>one</li>'), basic);
  check('links open in a new tab with noopener', basic.includes('href="https://shop.example/k" target="_blank" rel="noopener noreferrer"'), basic);

  const raw = await render('<img src=x onerror="window.pwned=1"> <script>window.pwned=2</script> <b>x</b>');
  check('raw HTML shows as text', !/<img|<script|<b>/.test(raw) && raw.includes('&lt;img'), raw);

  for (const md of ['[a](javascript:window.pwned=3)', '[a](data:text/html,hi)', '<javascript:window.pwned=5>', '[a](/relative)']) {
    const html = await render(md);
    check(`non-http(s) link loses its href: ${md}`, !/href=/.test(html), html);
  }

  const attr = await render('[x](https://a.example/ "t\\" onmouseover=\\"window.pwned=4")');
  check('a link title cannot add attributes', !/onmouseover=/.test(attr.replace(/title="[^"]*"/, '')), attr);

  const pwned = (await send('script.evaluate', { expression: 'String(window.pwned)', target: { context }, awaitPromise: false })).result.value;
  check('nothing executed', pwned === 'undefined', `window.pwned = ${pwned}`);
} catch (err) {
  console.error(err.message);
  failures++;
} finally {
  ff.kill();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} failed` : '\nAll passed');
process.exit(failures ? 1 : 0);
