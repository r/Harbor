/**
 * ai.createTextSession and session.prompt can legitimately take much
 * longer than the generic 30-second request timeout once they're backed
 * by an ACP agent: starting the agent process, and one turn capped at 10
 * minutes in the background (acp-connection.ts's ACP_TURN_TIMEOUT_MS).
 * injected.ts gives these two request types their own, longer timeouts,
 * and — unlike the plain 30-second case — also tells the background to
 * stop waiting, by posting the same `{channel, abort:{id}}` message a
 * broken streaming for-await loop sends, so a page that gives up doesn't
 * leave the agent starting, or a turn running, unobserved.
 *
 * Runs the real injected.ts in a VM, as injected-stream-errors.test.js
 * does, with fake timers so the 2-minute/10.5-minute waits are instant.
 */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../injected.ts', import.meta.url), 'utf8');
const script = transformSync(source, { loader: 'ts', format: 'iife' }).code;
const CHANNEL = 'harbor_page_api';

function page(flags) {
  const listeners = [];
  const window = {
    addEventListener: vi.fn((type, l) => { if (type === 'message') listeners.push(l); }),
    dispatchEvent: vi.fn(),
    postMessage: vi.fn(),
  };
  runInNewContext(script, {
    window, navigator: {}, crypto: webcrypto, console: { debug: vi.fn(), warn: vi.fn(), log: vi.fn() },
    // Feature flags reach the page as JSON in a script element (see
    // injected-flags.test.js); none means the defaults.
    document: { querySelector: () => null, getElementById: () => (flags ? { textContent: JSON.stringify(flags) } : null) },
    CustomEvent: class { constructor(type, options) { this.type = type; this.options = options; } },
    // The real global timer functions — captured here, not read lazily, so
    // that vi.useFakeTimers() (which replaces them on `globalThis`, see
    // beforeEach below) is what the sandboxed script actually gets.
    setTimeout, clearTimeout, Map, Set, Date, Math,
  });
  const deliver = (data) => listeners.forEach((l) => l({ source: window, data: { channel: CHANNEL, ...data } }));
  const lastRequestId = (type) =>
    window.postMessage.mock.calls.map(([m]) => m.request).filter((r) => r?.type === type).at(-1)?.id;
  const abortedIds = () =>
    window.postMessage.mock.calls.map(([m]) => m.abort).filter(Boolean).map((a) => a.id);
  return { window, deliver, lastRequestId, abortedIds };
}

/**
 * Attaches a settlement observer to `promise` exactly once — so its
 * eventual rejection (the request timeout) is always handled, whatever
 * order the test checks `state` in — and returns an object a test can poll
 * without racing another promise against real or VM-crossing timers.
 */
function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then(
    (value) => { state.settled = true; state.value = value; },
    (error) => { state.settled = true; state.error = error; },
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('per-type request timeouts', () => {
  it('gives ai.createTextSession 2 minutes, not the default 30 seconds', async () => {
    const { window } = page();
    const state = track(window.ai.createTextSession());

    await vi.advanceTimersByTimeAsync(119_000);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.settled).toBe(true);
    expect(state.error).toMatchObject({ code: 'ERR_TIMEOUT' });
  });

  it('tells the background to stop when ai.createTextSession times out', async () => {
    const { window, lastRequestId, abortedIds } = page();
    const state = track(window.ai.createTextSession());
    const id = lastRequestId('ai.createTextSession');

    await vi.advanceTimersByTimeAsync(121_000);

    expect(state.settled).toBe(true);
    expect(abortedIds()).toContain(id);
  });

  it('gives session.prompt the 10-minute turn limit plus a margin, not the default 30 seconds', async () => {
    const { window, deliver, lastRequestId } = page();
    const creating = window.ai.createTextSession();
    deliver({ response: { id: lastRequestId('ai.createTextSession'), ok: true, result: 'session-1' } });
    const session = await creating;

    const state = track(session.prompt('Hi'));

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 29_000);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.settled).toBe(true);
    expect(state.error).toMatchObject({ code: 'ERR_TIMEOUT' });
  });

  it("tells the background to stop when session.prompt times out, so a queued turn behind it isn't blocked", async () => {
    const { window, deliver, lastRequestId, abortedIds } = page();
    const creating = window.ai.createTextSession();
    deliver({ response: { id: lastRequestId('ai.createTextSession'), ok: true, result: 'session-1' } });
    const session = await creating;

    const state = track(session.prompt('Hi'));
    const id = lastRequestId('session.prompt');

    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 31_000);

    expect(state.settled).toBe(true);
    expect(abortedIds()).toContain(id);
  });

  it('leaves an unrelated request type (ai.canCreateTextSession) on the default 30-second timeout', async () => {
    const { window } = page();
    const state = track(window.ai.canCreateTextSession());

    await vi.advanceTimersByTimeAsync(29_000);
    expect(state.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.settled).toBe(true);
    expect(state.error).toMatchObject({ code: 'ERR_TIMEOUT' });
  });

  describe('agent.requestPermissions', () => {
    it('survives past the old 30-second default: a person can still be reading the consent prompt then', async () => {
      const { window } = page();
      const state = track(window.agent.requestPermissions({ scopes: ['model:prompt'] }));

      await vi.advanceTimersByTimeAsync(31_000);
      expect(state.settled).toBe(false);
    });

    it('gives it 5 minutes, not the default 30 seconds', async () => {
      const { window } = page();
      const state = track(window.agent.requestPermissions({ scopes: ['model:prompt'] }));

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 - 1_000);
      expect(state.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(state.settled).toBe(true);
      expect(state.error).toMatchObject({ code: 'ERR_TIMEOUT' });
    });

    it('tells the background to stop when it times out, so the prompt stops waiting on this call too', async () => {
      const { window, lastRequestId, abortedIds } = page();
      const state = track(window.agent.requestPermissions({ scopes: ['model:prompt'] }));
      const id = lastRequestId('agent.requestPermissions');

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(state.settled).toBe(true);
      expect(abortedIds()).toContain(id);
    });
  });

  describe('agent.agents.invoke', () => {
    it("waits past 30 seconds, so an invocation's own timeout (up to 5 minutes) can run", async () => {
      const { window } = page({ multiAgent: true });
      const state = track(window.agent.agents.invoke('agent-1', { task: 'summarize', timeout: 60_000 }));

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(state.error).toBeUndefined();
      expect(state.settled).toBe(false);
    });

    it('still gives up, as a backstop behind the background, a margin after the 5-minute cap', async () => {
      const { window, lastRequestId, abortedIds } = page({ multiAgent: true });
      const state = track(window.agent.agents.invoke('agent-1', { task: 'summarize' }));
      // The feature check runs first, so the request goes out a tick later.
      await vi.advanceTimersByTimeAsync(0);
      const id = lastRequestId('agent.agents.invoke');

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 29 * 1000);
      expect(state.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(state.settled).toBe(true);
      expect(state.error).toMatchObject({ code: 'ERR_TIMEOUT' });
      expect(abortedIds()).toContain(id);
    });
  });

  describe('agent.agents.orchestrate.*', () => {
    it('waits past 30 seconds, since each step runs its own invocation', async () => {
      const { window } = page({ multiAgent: true });
      const state = track(window.agent.agents.orchestrate.pipeline({ steps: [{ agentId: 'agent-1', task: 'a' }] }, 'x'));

      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(state.error).toBeUndefined();
      expect(state.settled).toBe(false);
    });
  });
});
