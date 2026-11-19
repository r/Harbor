/**
 * permission-prompt.ts is the actual popup script: it reads the `agent`
 * URL param (permissions.ts's `showPermissionPrompt` sets it from
 * `resolveConsentAgentName()`) and feeds it to
 * `consentScopeDescription` to decide the model:prompt/model:tools
 * wording. `agent-consent-copy.test.ts` already proves
 * `consentScopeDescription` itself does the right thing given an agent
 * name — this proves the *popup script* actually passes the URL's real
 * agent name through, rather than, say, a mutant that always passes
 * `null` (which would silently fall back to the built-in wording on
 * every real ACP-backed prompt, and nothing that calls
 * `consentScopeDescription` directly would ever notice).
 *
 * Runs in vitest's `node` environment (no real DOM) — builds just enough
 * of a fake `document`/`window` for this script's top-level code to run
 * end to end, the way scope-item.test.ts does for `buildScopeItem` alone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeElement {
  id = '';
  className = '';
  textContent = '';
  innerHTML = '';
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  checked = false;
  type = '';
  htmlFor = '';
  children: FakeElement[] = [];
  append(...nodes: FakeElement[]): void { this.children.push(...nodes); }
  appendChild(node: FakeElement): FakeElement { this.children.push(node); return node; }
  addEventListener(): void { /* no-op: this test never clicks a button */ }
  get allText(): string {
    if (this.children.length === 0) return this.textContent;
    return [this.textContent, ...this.children.map((c) => c.allText)].join('');
  }
}

function makeFakeDom(search: string) {
  const byId = new Map<string, FakeElement>();
  for (const id of [
    'origin', 'session-context', 'session-name', 'session-badges',
    'reason-container', 'reason', 'scopes-list', 'tools-section',
    'tools-list', 'btn-deny', 'btn-grant', 'grant-once',
  ]) {
    byId.set(id, new FakeElement());
  }

  (globalThis as unknown as { document: unknown }).document = {
    documentElement: { setAttribute: () => {} },
    getElementById: (id: string) => byId.get(id) ?? null,
    createElement: () => new FakeElement(),
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
  it('names the agent and "via ACP" in the scopes list when the URL names one', async () => {
    const byId = makeFakeDom('?origin=https://example.test&scopes=model:prompt&agent=goose');
    await import('../permission-prompt');

    const scopesList = byId.get('scopes-list')!;
    expect(scopesList.allText).toContain('goose');
    expect(scopesList.allText).toContain('via ACP');
  });

  it('falls back to the plain built-in wording when the URL carries no agent param', async () => {
    const byId = makeFakeDom('?origin=https://example.test&scopes=model:prompt');
    await import('../permission-prompt');

    const scopesList = byId.get('scopes-list')!;
    expect(scopesList.allText).not.toContain('via ACP');
  });
});
