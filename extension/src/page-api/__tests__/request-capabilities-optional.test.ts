/**
 * `agent.requestCapabilities({ require, optional })`: an optional
 * capability the site hasn't been granted is left out of the session
 * quietly (maintainer decision, 2026-11-23). A required one is always sent,
 * so the background still refuses the session when it isn't granted.
 *
 * Runs the real page-side injected.ts in a VM, with a window whose
 * postMessage answers the page's requests the way Harbor's content script
 * would, and records what the page asked for.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { resolveFromModule } from './support/api-shape';

const INJECTED_PATH = resolveFromModule(import.meta.url, '../injected.ts');
const CHANNEL = 'harbor_page_api';

type Request = { id: string; type: string; payload: Record<string, unknown> };
type Answer = (request: Request) => { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } };

function loadPage(answer: Answer) {
  const { code } = transformSync(readFileSync(INJECTED_PATH, 'utf-8'), { loader: 'ts', format: 'iife', target: 'es2022' });
  const listeners: Array<(event: unknown) => void> = [];
  const requests: Request[] = [];
  let n = 0;
  const win: Record<string, unknown> = {
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (type === 'message') listeners.push(listener);
    },
    removeEventListener() {},
    dispatchEvent() { return true; },
    postMessage(message: { channel?: string; request?: Request }) {
      const request = message?.request;
      if (message?.channel !== CHANNEL || !request) return;
      requests.push(request);
      const reply = answer(request);
      queueMicrotask(() => {
        for (const listener of listeners) {
          listener({ source: win, data: { channel: CHANNEL, response: { id: request.id, ...reply } } });
        }
      });
    },
  };
  const sandbox = {
    window: win,
    document: {
      getElementById: (id: string) => (id === 'harbor-page-api-flags' ? { textContent: '{}' } : null),
      querySelector: () => null,
    },
    navigator: {},
    crypto: { randomUUID: () => `req-${++n}` },
    CustomEvent: class { constructor(public type: string, public detail?: unknown) {} },
    setTimeout, clearTimeout, queueMicrotask, console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: INJECTED_PATH });
  return { agent: win.agent as { requestCapabilities(opts: unknown): Promise<{ sessionId: string }> }, requests };
}

/** Harbor answers: these scopes are held, and session.create succeeds. */
function harborHolding(scopes: Record<string, string>): Answer {
  return (request) => {
    if (request.type === 'agent.permissions.list') {
      return { ok: true, result: { origin: 'https://example.com', scopes, allowedTools: [] } };
    }
    if (request.type === 'agent.sessions.create') {
      return { ok: true, result: { success: true, sessionId: 's1', capabilities: request.payload.capabilities } };
    }
    return { ok: false, error: { code: 'ERR_UNEXPECTED', message: request.type } };
  };
}

const created = (requests: Request[]) =>
  requests.find((r) => r.type === 'agent.sessions.create')?.payload.capabilities as {
    llm?: unknown; tools: string[]; browser: string[];
  };

describe('agent.requestCapabilities with optional capabilities', () => {
  it('leaves out optional capabilities the site has not been granted', async () => {
    const { agent, requests } = loadPage(harborHolding({ 'model:prompt': 'granted-always' }));
    const session = await agent.requestCapabilities({
      require: [{ action: 'model.prompt.local' }],
      optional: [
        { action: 'browser.write.interact' },
        { action: 'tool.call', server: 'github', toolNames: ['create_issue'] },
      ],
    });
    expect(session.sessionId).toBe('s1');
    expect(created(requests)).toEqual({ llm: {}, tools: [], browser: [] });
  });

  it('keeps optional capabilities the site holds, including a one-time grant', async () => {
    const { agent, requests } = loadPage(harborHolding({
      'model:prompt': 'granted-always',
      'browser:activeTab.interact': 'granted-once',
      'mcp:tools.call': 'granted-always',
    }));
    await agent.requestCapabilities({
      require: [{ action: 'model.prompt.local' }],
      optional: [
        { action: 'browser.write.interact' },
        { action: 'tool.call', server: 'github', toolNames: ['create_issue'] },
      ],
    });
    expect(created(requests)).toEqual({ llm: {}, tools: ['github/create_issue'], browser: ['interact'] });
  });

  it('treats a denied or expired scope as not granted', async () => {
    const { agent, requests } = loadPage(harborHolding({
      'model:prompt': 'granted-always',
      'browser:activeTab.read': 'denied',
      'browser:activeTab.screenshot': 'not-granted',
    }));
    await agent.requestCapabilities({
      require: [{ action: 'model.prompt.local' }],
      optional: [{ action: 'browser.read.activeTab' }, { action: 'browser.read.screenshot' }],
    });
    expect(created(requests).browser).toEqual([]);
  });

  it('always sends what is required, so Harbor still refuses an ungranted one', async () => {
    const { agent, requests } = loadPage((request) => {
      if (request.type === 'agent.permissions.list') {
        return { ok: true, result: { origin: 'https://example.com', scopes: {}, allowedTools: [] } };
      }
      return { ok: true, result: { success: false, error: { code: 'ERR_PERMISSION_DENIED', message: 'Permission mcp:tools.call required' } } };
    });
    await expect(agent.requestCapabilities({
      require: [{ action: 'tool.call', server: 'github' }],
      optional: [{ action: 'model.prompt.local' }],
    })).rejects.toMatchObject({ code: 'ERR_PERMISSION_DENIED' });
    expect(created(requests)).toEqual({ tools: ['github/*'], browser: [] });
  });

  it('asks only for screenshot access for a screenshot, which is the one grant a screenshot needs', async () => {
    const { agent, requests } = loadPage(harborHolding({ 'browser:activeTab.screenshot': 'granted-always' }));
    await agent.requestCapabilities({
      require: [{ action: 'browser.read.screenshot' }],
      optional: [{ action: 'browser.read.screenshot' }],
    });
    expect(created(requests).browser).toEqual(['screenshot']);
  });

  it("doesn't look up grants when nothing is optional", async () => {
    const { agent, requests } = loadPage(harborHolding({}));
    await agent.requestCapabilities({ require: [{ action: 'model.prompt.local' }] });
    expect(requests.map((r) => r.type)).toEqual(['agent.sessions.create']);
  });
});
