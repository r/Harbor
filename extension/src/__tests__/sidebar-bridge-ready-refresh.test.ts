import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from './test-setup';

// checkBridgeStatus() (sidebar.ts) refreshes every panel's data the moment
// the native bridge first reports ready — including the Agent panel
// (loadAgentSettings(), added alongside the sidebar Agent setting) — not
// just once, unconditionally, at module load. This is a mutation-coverage
// gap the round-3 bounce called out by name (S1): nothing previously
// noticed if that one refresh call were removed from the bridge-ready
// Promise.all, because the module-load-time `void loadAgentSettings();`
// (near the bottom of sidebar.ts) already calls it once regardless. This
// proves the *bridge-ready* call is the one actually exercised, by
// counting `acp_get_agents` calls, not just that the panel loads at all.

type Listener = (...args: unknown[]) => unknown;

/** A minimal, generic stand-in for a DOM element — same shape as sidebar-feature-flags.test.ts's own, duplicated here so this file has no cross-file test dependency. */
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
  const { doc } = makeDocument();
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
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  vi.resetModules();
  resetMockBrowser();
  installFakeBrowserGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the sidebar reloads the Agent panel the moment the bridge becomes ready', () => {
  it('calls acp_get_agents again from the bridge-ready refresh, not just once at module load', async () => {
    let acpGetAgentsCalls = 0;
    (globalThis as unknown as { chrome: { runtime: { sendMessage: unknown } } }).chrome.runtime.sendMessage = vi.fn(async (msg: { type: string }) => {
      if (msg.type === 'bridge_check_health') return { connected: true, bridgeReady: true };
      if (msg.type === 'acp_get_agents') { acpGetAgentsCalls++; return { ok: true, agents: [] }; }
      if (msg.type === 'agent_backend_get') return { ok: true, setting: null };
      return { ok: true };
    });

    // sidebar.ts's own module-load-time code: startBridgeStatusPolling()
    // (which calls checkBridgeStatus() once immediately, synchronously
    // triggered, and reports the bridge ready on that very first check —
    // `lastBridgeConnected` starts `false`, so "just became ready" fires
    // right away) and the separate, unconditional `void
    // loadAgentSettings();` near the bottom of the file both run.
    await import('../sidebar');
    await flushMicrotasks();

    // Two distinct call sites both load the Agent panel when the bridge is
    // already ready from the start: the unconditional one, and the
    // bridge-ready refresh. A mutation removing loadAgentSettings() from
    // the bridge-ready Promise.all would drop this to 1.
    expect(acpGetAgentsCalls).toBeGreaterThanOrEqual(2);
  });
});
