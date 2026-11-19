/**
 * Check-then-Save must not duplicate a brand-new custom agent
 * (agent-form-state.ts, round 3). `agent-form-state.test.ts` already
 * proves `AgentFormState.trackSaved` itself does the right thing in
 * isolation; this drives sidebar.ts's own wiring end to end — the Add
 * Agent form, a real Check-button click, then a real Save-button click —
 * so a mutation that simply *removes* sidebar.ts's own
 * `agentFormState.trackSaved(agent)` call (round-4 bounce, item 6) would
 * still be caught, even though the class's own logic is untouched by it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from './test-setup';

type Listener = (...args: unknown[]) => unknown;

/** Same generic fake element as sidebar-feature-flags.test.ts's own. */
function makeElement(): HTMLElement {
  const store = new Map<string, unknown>();
  const listeners = new Map<string, Listener[]>();
  const classes = new Set<string>();
  const base: Record<string, unknown> = {
    addEventListener(type: string, cb: Listener) {
      (listeners.get(type) ?? (listeners.set(type, []), listeners.get(type)!)).push(cb);
    },
    removeEventListener() {},
    dispatchEvent() { return true; },
    __fire(type: string, evt: unknown = {}) {
      (listeners.get(type) ?? []).forEach((cb) => cb(evt));
    },
    classList: {
      add: (...names: string[]) => names.forEach((n) => classes.add(n)),
      remove: (...names: string[]) => names.forEach((n) => classes.delete(n)),
      toggle: (name: string, force?: boolean) => {
        const next = force === undefined ? !classes.has(name) : force;
        if (next) classes.add(name); else classes.delete(name);
        return next;
      },
      contains: (name: string) => classes.has(name),
    },
    style: {},
    dataset: {},
    children: [] as unknown[],
    appendChild(child: unknown) { (base.children as unknown[]).push(child); return child; },
    append(...nodes: unknown[]) { (base.children as unknown[]).push(...nodes); },
    remove() {},
    focus() {},
    click() {},
    setAttribute(name: string, value: string) { store.set(`attr:${name}`, value); },
    getAttribute(name: string) { return store.get(`attr:${name}`) ?? null; },
    querySelector() { return null; },
    querySelectorAll() { return [] as unknown[]; },
    closest() { return null; },
  };
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop in target) return Reflect.get(target, prop, receiver);
      return store.get(prop as string);
    },
    set(target, prop, value) {
      store.set(prop as string, value);
      return true;
    },
  }) as unknown as HTMLElement;
}

function makeDocument() {
  const elementsById = new Map<string, HTMLElement>();
  function getElementById(id: string): HTMLElement {
    if (!elementsById.has(id)) elementsById.set(id, makeElement());
    return elementsById.get(id)!;
  }
  const doc = makeElement() as unknown as Record<string, unknown>;
  doc.getElementById = getElementById;
  doc.createElement = () => makeElement();
  doc.body = makeElement();
  doc.documentElement = makeElement();
  doc.visibilityState = 'visible';
  return { doc, elementsById };
}

function installFakeBrowserGlobals() {
  const { doc, elementsById } = makeDocument();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false, addEventListener: () => {} }) });
  vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Test)', clipboard: { writeText: async () => {} } });
  vi.stubGlobal('confirm', () => true);
  const storageMap = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storageMap.get(k) ?? null,
    setItem: (k: string, v: string) => storageMap.set(k, v),
    removeItem: (k: string) => storageMap.delete(k),
  });
  return elementsById;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('sidebar.ts: Check-then-Save does not duplicate a brand-new agent', () => {
  beforeEach(() => {
    vi.resetModules();
    resetMockBrowser();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a Save after a successful Check updates the same agent in place, not a second one', async () => {
    const elementsById = installFakeBrowserGlobals();

    let savedAgents: Array<{ id: string; name: string; command: string }> = [];
    const saveCalls: Array<Array<{ id: string; name: string; command: string }>> = [];
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage =
      vi.fn(async (msg: { type: string; agents?: Array<{ id: string; name: string; command: string }> }) => {
        if (msg.type === 'bridge_check_health') return { connected: true, bridgeReady: true };
        if (msg.type === 'acp_get_agents') return { ok: true, agents: savedAgents };
        if (msg.type === 'agent_backend_get') return { ok: true, setting: null };
        if (msg.type === 'acp_save_agents') {
          savedAgents = msg.agents ?? [];
          saveCalls.push(savedAgents);
          return { ok: true };
        }
        if (msg.type === 'acp_check_agent') return { ok: true, message: 'Ready (test-agent)' };
        return { ok: true };
      });

    await import('../sidebar');
    await flushMicrotasks();

    // Open the Add Agent form and fill in a brand-new custom agent.
    (elementsById.get('add-agent-btn') as unknown as { __fire: (t: string) => void }).__fire('click');
    (elementsById.get('agent-form-name') as unknown as { value: string }).value = 'My Agent';
    (elementsById.get('agent-form-command') as unknown as { value: string }).value = 'my-agent';

    // Check: saves the brand-new agent, then (if trackSaved runs) edits it
    // in place from here on.
    (elementsById.get('agent-form-check') as unknown as { __fire: (t: string) => void }).__fire('click');
    await flushMicrotasks();

    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toHaveLength(1);
    const firstSavedId = saveCalls[0][0].id;

    // Save again, on the same still-open form, with nothing else changed —
    // exactly what a person clicking Save right after a successful Check
    // would do.
    (elementsById.get('agent-form-save') as unknown as { __fire: (t: string) => void }).__fire('click');
    await flushMicrotasks();

    expect(saveCalls).toHaveLength(2);
    // The defect this guards against: without trackSaved, agentFormState
    // still thinks nothing is being edited, so this second save generates
    // a *new* id and the saved list ends up with two agents for what the
    // person did once.
    expect(saveCalls[1]).toHaveLength(1);
    expect(saveCalls[1][0].id).toBe(firstSavedId);
  });
});
