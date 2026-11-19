/**
 * The docs hint shown after picking an agent preset (sidebar.ts) must be a
 * real link labelled "<Agent> settings docs", not the raw URL printed as
 * text, and built without `innerHTML` — the same discipline as
 * `scope-item.ts`'s `buildScopeItem` (see scope-item.test.ts). Uses a
 * minimal fake `document` (this suite's `vitest.config.ts` runs in the
 * `node` environment, with no real DOM).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentPreset } from '../sidebar-agents';

class FakeElement {
  tagName: string;
  className = '';
  textContent = '';
  href = '';
  target = '';
  rel = '';
  children: FakeElement[] = [];
  constructor(tagName: string) { this.tagName = tagName; }
  appendChild(node: FakeElement): FakeElement { this.children.push(node); return node; }
  get allText(): string {
    if (this.children.length === 0) return this.textContent;
    return [this.textContent, ...this.children.map((c) => c.allText)].join('');
  }
}

class FakeTextNode {
  constructor(public textContent: string) {}
  get allText(): string {
    return this.textContent;
  }
}

let created: FakeElement[] = [];

beforeEach(() => {
  created = [];
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
      const el = new FakeElement(tag);
      created.push(el);
      return el;
    },
    createTextNode: (text: string) => new FakeTextNode(text),
  };
});

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

const PRESET: AgentPreset = {
  name: 'goose',
  command: 'goose',
  args: ['acp'],
  docsUrl: 'https://goose-docs.ai/docs/guides/config-files',
};

describe('buildAgentPresetDocsHint', () => {
  it('never sets innerHTML on any element it creates', async () => {
    const { buildAgentPresetDocsHint } = await import('../agent-preset-docs-hint');
    buildAgentPresetDocsHint(PRESET);
    for (const el of created) {
      expect(Object.prototype.hasOwnProperty.call(el, 'innerHTML')).toBe(false);
    }
  });

  it('builds a link labelled "<Agent> settings docs", not the raw URL as text', async () => {
    const { buildAgentPresetDocsHint } = await import('../agent-preset-docs-hint');
    const hint = buildAgentPresetDocsHint(PRESET) as unknown as FakeElement;

    const link = created.find((el) => el.tagName === 'a');
    expect(link).toBeDefined();
    expect(link!.textContent).toBe('goose settings docs');
    expect(link!.href).toBe(PRESET.docsUrl);
    expect(hint.allText).not.toContain(PRESET.docsUrl);
  });

  it('opens the link in a new tab, safely (rel=noopener noreferrer)', async () => {
    const { buildAgentPresetDocsHint } = await import('../agent-preset-docs-hint');
    buildAgentPresetDocsHint(PRESET);

    const link = created.find((el) => el.tagName === 'a')!;
    expect(link.target).toBe('_blank');
    expect(link.rel).toBe('noopener noreferrer');
  });

  it('names the preset in both the lead-in text and the link label', async () => {
    const { buildAgentPresetDocsHint } = await import('../agent-preset-docs-hint');
    const codex: AgentPreset = { name: 'Codex', command: 'npx', args: [], docsUrl: 'https://example.test/codex' };
    const hint = buildAgentPresetDocsHint(codex) as unknown as FakeElement;

    expect(hint.allText).toContain('Codex');
    const link = created.find((el) => el.tagName === 'a')!;
    expect(link.textContent).toBe('Codex settings docs');
  });
});
