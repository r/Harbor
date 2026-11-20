/**
 * `buildScopeItem` (permission-prompt.ts's scope rows) must never let an
 * agent name — which the person can set to anything via the sidebar's
 * "Custom" agent form — be interpreted as markup. Uses a minimal fake
 * `document` (this suite's `vitest.config.ts` runs in the `node`
 * environment, with no real DOM), just enough for `createElement`/
 * `className`/`textContent`/`append`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

class FakeElement {
  tag = '';
  attrs: Record<string, string> = {};
  className = '';
  textContent = '';
  children: FakeElement[] = [];
  append(...nodes: FakeElement[]): void {
    this.children.push(...nodes);
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  appendChild(node: FakeElement): FakeElement {
    this.children.push(node);
    return node;
  }
  /** All text this element or its descendants carry, concatenated — mirrors real DOM's textContent getter on a parent. */
  get allText(): string {
    if (this.children.length === 0) return this.textContent;
    return this.children.map((c) => c.allText).join('');
  }
}

let created: FakeElement[] = [];

beforeEach(() => {
  created = [];
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
      const el = new FakeElement();
      el.tag = tag;
      created.push(el);
      return el;
    },
    createElementNS: (_ns: string, tag: string) => {
      const el = new FakeElement();
      el.tag = tag;
      created.push(el);
      return el;
    },
  };
});

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

describe('buildScopeItem', () => {
  it('never sets innerHTML on any element it creates', async () => {
    const { buildScopeItem } = await import('../scope-item');
    buildScopeItem('message-circle', '<b>evil</b>', '<img src=x onerror=alert(1)>', 'low');
    for (const el of created) {
      expect(Object.prototype.hasOwnProperty.call(el, 'innerHTML')).toBe(false);
    }
  });

  it('renders an agent name containing markup literally, as text', async () => {
    const { buildScopeItem } = await import('../scope-item');
    const item = buildScopeItem('message-circle', 'Requests go to <b>x</b>, your own agent', 'desc', 'low') as unknown as FakeElement;

    // The literal string must appear somewhere as textContent — not split
    // into a real <b> element, which this fake document cannot create
    // except through explicit createElement calls (there are none for 'b').
    expect(item.allText).toContain('Requests go to <b>x</b>, your own agent');
    expect(created.some((el) => el.className.includes('scope-title') && el.textContent === 'Requests go to <b>x</b>, your own agent')).toBe(true);
  });

  it('renders the description literally too', async () => {
    const { buildScopeItem } = await import('../scope-item');
    const item = buildScopeItem('message-circle', 'title', 'This site gets <script>x</script> with its tools.', 'low') as unknown as FakeElement;
    expect(item.allText).toContain('This site gets <script>x</script> with its tools.');
  });

  it('draws its icon as SVG nodes, not markup', async () => {
    const { buildScopeItem } = await import('../scope-item');
    buildScopeItem('wrench', 't', 'd');
    const iconSlot = created.find((el) => el.className === 'scope-icon');
    const svg = iconSlot?.children[0];
    expect(svg?.tag).toBe('svg');
    expect(svg?.attrs['aria-hidden']).toBe('true');
    expect(svg?.children.length).toBeGreaterThan(0);
  });

  it('omits the risk badge entirely when no risk is given', async () => {
    const { buildScopeItem } = await import('../scope-item');
    buildScopeItem('message-circle', 't', 'd');
    expect(created.some((el) => el.className.startsWith('risk-badge'))).toBe(false);
  });
});
