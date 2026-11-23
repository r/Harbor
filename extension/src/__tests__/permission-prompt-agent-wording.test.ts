import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeElement {
  id = '';
  className = '';
  textContent = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  hidden = false;
  checked = false;
  type = '';
  htmlFor = '';
  children: FakeElement[] = [];
  setAttribute(): void {}
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  appendChild(node: FakeElement): FakeElement { this.children.push(node); return node; }
  listeners = new Map<string, () => void>();
  addEventListener(event: string, callback: () => void): void { this.listeners.set(event, callback); }
  get allText(): string {
    if (this.children.length === 0) return this.textContent;
    return [this.textContent, ...this.children.map((c) => c.allText)].join('');
  }
}

function makeFakeDom(search: string) {
  const byId = new Map<string, FakeElement>();
  for (const id of [
    'heading', 'agent-warning', 'scopes-heading', 'reason-label', 'session-context', 'session-name', 'session-badges',
    'reason-container', 'reason', 'scopes-list', 'tools-section',
    'tools-list', 'btn-deny', 'btn-grant', 'btn-always',
  ]) {
    byId.set(id, new FakeElement());
  }

  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { setAttribute: () => {} },
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => new FakeElement(),
    createElementNS: () => new FakeElement(),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  (globalThis as unknown as { window: unknown }).window = {
    location: { search },
    matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    addEventListener: () => {},
  };
  (globalThis as unknown as { localStorage: unknown }).localStorage = { getItem: () => null };

  return byId;
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
  delete (globalThis as unknown as { window?: unknown }).window;
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage;
  vi.resetModules();
});

describe('permission-prompt.ts renders the agent-aware wording for model:prompt/model:tools', () => {
  it('attributes the reason to the site and describes the actual agent access separately', async () => {
    const byId = makeFakeDom('?origin=https://tale.fyi&scopes=model:prompt&agent=goose&reason=Summarize+this+chapter');
    await import('../permission-prompt');

    expect(byId.get('heading')!.textContent).toBe('Let tale.fyi send requests to goose?');
    expect(byId.get('reason-label')!.textContent).toBe('Stated reason from tale.fyi');
    expect(byId.get('reason')!.textContent).toBe('Summarize this chapter');
    expect(byId.get('agent-warning')!.textContent).toContain('its tools and what it remembers about you');
    expect(byId.get('btn-always')!.textContent).toBe('Allow tale.fyi to use goose without asking');
  });

  it.each([
    ['btn-deny', { granted: false, explicitDeny: true }],
    ['btn-grant', { granted: true, grantType: 'granted-once' }],
    ['btn-always', { granted: true, grantType: 'granted-always' }],
  ] as const)('dispatches the choice printed on %s', async (button, response) => {
    const byId = makeFakeDom('?origin=http://example.test:8080&scopes=model:prompt&agent=goose&backendTag=goose');
    const sendMessage = vi.fn();
    vi.stubGlobal('browser', { runtime: { sendMessage } });
    try {
      await import('../permission-prompt');
      expect(byId.get('heading')!.textContent).toContain('http://example.test:8080');
      expect(sendMessage).not.toHaveBeenCalled();
      byId.get(button)!.listeners.get('click')!();
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'permission_prompt_response',
        response: { ...response, backendTag: 'goose' },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to the plain built-in wording when the URL carries no agent param', async () => {
    const byId = makeFakeDom('?origin=https://example.test&scopes=model:prompt');
    await import('../permission-prompt');

    const scopesList = byId.get('scopes-list')!;
    expect(scopesList.allText).not.toMatch(/ACP/i);
  });
});

describe('permission-prompt.ts merges model:prompt and model:tools into one row when an agent is selected', () => {
  it('shows the agent warning once for a request naming both model scopes', async () => {
    const byId = makeFakeDom('?origin=https://example.test&scopes=model:prompt,model:tools&agent=goose');
    await import('../permission-prompt');

    const scopesList = byId.get('scopes-list')!;
    expect(scopesList.hidden).toBe(true);
    expect(byId.get('agent-warning')!.textContent).toContain('goose');
  });

  it('renders two rows for the same request with no agent selected', async () => {
    const byId = makeFakeDom('?origin=https://example.test&scopes=model:prompt,model:tools');
    await import('../permission-prompt');

    const scopesList = byId.get('scopes-list')!;
    expect(scopesList.children).toHaveLength(2);
  });

  it('renders two rows when only one of the two is requested, even with an agent selected', async () => {
    const byId = makeFakeDom('?origin=https://example.test&scopes=model:prompt,mcp:tools.call&agent=goose');
    await import('../permission-prompt');

    const scopesList = byId.get('scopes-list')!;
    expect(scopesList.children).toHaveLength(2);
  });
});
