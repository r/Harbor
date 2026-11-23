/**
 * The content script's page-tool relay, run against the real
 * content-script.ts: a call or cancel the background posts on the page port
 * reaches the page, and the page's answer goes back on that port as
 * `page_tools.result`.
 */
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const bundled = buildSync({
  entryPoints: [new URL('../content-script.ts', import.meta.url).pathname],
  bundle: true, write: false, format: 'iife', platform: 'browser',
}).outputFiles[0].text;

function load() {
  const windowListeners = [];
  const pagePosts = [];
  const portPosts = [];
  const portListeners = [];
  const port = {
    name: 'harbor-page-api',
    postMessage: vi.fn((m) => portPosts.push(m)),
    onMessage: { addListener: (l) => portListeners.push(l) },
    onDisconnect: { addListener: vi.fn() },
  };
  const window = {
    location: { origin: 'https://tale.example' },
    addEventListener: (type, l) => { if (type === 'message') windowListeners.push(l); },
    removeEventListener: vi.fn(),
    postMessage: vi.fn((data) => pagePosts.push(data)),
  };
  const chrome = {
    runtime: {
      connect: vi.fn(() => port),
      sendMessage: vi.fn((_m, cb) => cb?.({})),
      onMessage: { addListener: vi.fn() },
      getURL: (p) => `moz-extension://x/${p}`,
      lastError: undefined,
    },
    storage: { onChanged: { addListener: vi.fn() } },
  };
  const document = {
    documentElement: { setAttribute: vi.fn() },
    head: null,
    createElement: () => ({}),
    getElementById: () => null,
    addEventListener: vi.fn(),
  };
  runInNewContext(bundled, { window, chrome, document, console: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }, setTimeout, clearTimeout, Promise });
  const fromPage = (data) => windowListeners.forEach((l) => l({ source: window, data: { channel: 'harbor_page_api', ...data } }));
  const fromBackground = (m) => portListeners.forEach((l) => l(m));
  return { pagePosts, portPosts, fromPage, fromBackground };
}

describe('content script page-tool relay', () => {
  it("relays a background call to the page and the page's answer back", () => {
    const cs = load();
    // The page's first request opens the port, as a sync would.
    cs.fromPage({ request: { id: 'r1', type: 'page_tools.sync', payload: { tools: [] } } });
    cs.fromBackground({ type: 'page_tools.call', callId: 'c1', name: 'go_to', input: { anchor: 'p3' } });
    expect(cs.pagePosts).toContainEqual({ channel: 'harbor_page_api', pageToolCall: { callId: 'c1', name: 'go_to', input: { anchor: 'p3' } } });

    cs.fromPage({ pageToolResult: { callId: 'c1', ok: true, result: { at: 'p3' } } });
    expect(cs.portPosts).toContainEqual({ type: 'page_tools.result', callId: 'c1', ok: true, result: { at: 'p3' } });
  });

  it('relays a cancel to the page', () => {
    const cs = load();
    cs.fromPage({ request: { id: 'r1', type: 'page_tools.sync', payload: { tools: [] } } });
    cs.fromBackground({ type: 'page_tools.cancel', callId: 'c1' });
    expect(cs.pagePosts).toContainEqual({ channel: 'harbor_page_api', pageToolCancel: { callId: 'c1' } });
  });

  it('forwards only the answer fields, and drops an answer without a callId', () => {
    const cs = load();
    cs.fromPage({ request: { id: 'r1', type: 'page_tools.sync', payload: { tools: [] } } });
    cs.fromPage({ pageToolResult: { ok: true, result: 1 } });
    cs.fromPage({ pageToolResult: { callId: 'c2', ok: false, error: { message: 'x' }, type: 'abort', id: 'r1' } });
    const results = cs.portPosts.filter((m) => m.type === 'page_tools.result');
    expect(results).toEqual([{ type: 'page_tools.result', callId: 'c2', ok: false, error: { message: 'x' } }]);
  });
});
