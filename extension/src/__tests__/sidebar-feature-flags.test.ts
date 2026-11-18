import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { resetMockBrowser } from './test-setup';

type Listener = (...args: unknown[]) => unknown;

/**
 * A minimal, generic stand-in for a DOM element. Any property read/write is
 * recorded in a backing map so arbitrary sidebar.ts code (style, dataset,
 * textContent, disabled, innerHTML, ...) can run without a real DOM. A
 * handful of methods (classList, addEventListener, appendChild, ...) are
 * implemented directly so the rest of sidebar.ts's many unrelated panels
 * don't throw on import.
 */
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

/** A minimal fake `document`. Elements are memoized by id, like a real DOM. */
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

const FLAG_IDS = [
  'flag-textGeneration',
  'flag-toolAccess',
  'flag-toolCalling',
  'flag-browserInteraction',
  'flag-browserControl',
  'flag-multiAgent',
] as const;

async function navigateCtx(id: string) {
  return {
    id,
    type: 'agent.browser.navigate',
    payload: { url: 'https://example.com' },
    origin: 'https://test.example',
  };
}

describe('the sidebar exposes the page-api feature flags', () => {
  beforeEach(() => {
    vi.resetModules();
    resetMockBrowser();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Flush pending microtasks (e.g. the sidebar's async flag-loading) without
   * running the sidebar's real setInterval polling loops. */
  async function flushMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('renders all six toggles with their stored values, and saving Browser Control through the sidebar flips the page-api receiver check', async () => {
    const elementsById = installFakeBrowserGlobals();

    // A saved opt-in for toolAccess and an explicit opt-out for toolCalling,
    // so the render assertion below can't pass on defaults alone.
    const { setFeatureFlags, getFeatureFlags } = await import('../page-api/policy/feature-flags');
    await setFeatureFlags({ toolCalling: false });

    const { routeMessage } = await import('../page-api/handlers');

    // Browser Control starts off: the receiver refuses the gated call for
    // that reason specifically.
    const before = await routeMessage(await navigateCtx('before'));
    expect(before.ok).toBe(false);
    expect(before.error?.code).toBe('ERR_FEATURE_DISABLED');

    // Load the sidebar script against the fake DOM. It reads the flags
    // through page-api/policy/feature-flags and renders the six toggles.
    await import('../sidebar');
    await flushMicrotasks();

    const stored = await getFeatureFlags();
    for (const id of FLAG_IDS) {
      expect(elementsById.has(id)).toBe(true);
    }
    const key = (id: string) => id.replace(/^flag-/, '') as keyof typeof stored;
    for (const id of FLAG_IDS) {
      expect((elementsById.get(id) as unknown as { checked: boolean }).checked).toBe(stored[key(id)]);
    }
    // In particular, the earlier saved opt-out made it into the panel.
    expect((elementsById.get('flag-toolCalling') as unknown as { checked: boolean }).checked).toBe(false);

    // Flip Browser Control on through the sidebar's own save path: set the
    // checkbox and fire the same 'change' event the toggle switch fires.
    const browserControlCheckbox = elementsById.get('flag-browserControl') as unknown as {
      checked: boolean;
      __fire: (type: string) => void;
    };
    expect(browserControlCheckbox.checked).toBe(false);
    browserControlCheckbox.checked = true;
    browserControlCheckbox.__fire('change');
    // The listener's save is async; let its promise settle.
    await vi.waitFor(async () => {
      expect((await getFeatureFlags()).browserControl).toBe(true);
    });

    // The same page-api call is no longer refused for that reason.
    const after = await routeMessage(await navigateCtx('after'));
    expect(after.error?.code).not.toBe('ERR_FEATURE_DISABLED');
  });
});
