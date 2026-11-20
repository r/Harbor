// Page chat replies render a small, safe subset of markdown. The chat panel
// lives in the site's page, so rendering builds DOM nodes and never parses
// reply text as HTML.
import { describe, expect, it } from 'vitest';
import { parseMarkdown, renderMarkdown, type MdBlock } from '../chat-markdown';

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual<MdBlock[]>([
      { type: 'p', lines: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]] },
      { type: 'p', lines: [[{ type: 'text', text: 'three' }]] },
    ]);
  });

  it('parses bold, italic, inline code and http(s) links', () => {
    const [p] = parseMarkdown('A **bold** and *it* and `x<y` and [docs](https://a.example/b).');
    expect(p).toEqual({
      type: 'p',
      lines: [[
        { type: 'text', text: 'A ' },
        { type: 'strong', children: [{ type: 'text', text: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'em', children: [{ type: 'text', text: 'it' }] },
        { type: 'text', text: ' and ' },
        { type: 'code', text: 'x<y' },
        { type: 'text', text: ' and ' },
        { type: 'link', href: 'https://a.example/b', children: [{ type: 'text', text: 'docs' }] },
        { type: 'text', text: '.' },
      ]],
    });
  });

  it('keeps bold that spans punctuation, as agents write it', () => {
    const [p] = parseMarkdown('For **Tom, the Keyboard ($129.99)** to go');
    expect(p).toEqual({
      type: 'p',
      lines: [[
        { type: 'text', text: 'For ' },
        { type: 'strong', children: [{ type: 'text', text: 'Tom, the Keyboard ($129.99)' }] },
        { type: 'text', text: ' to go' },
      ]],
    });
  });

  it('parses bulleted and numbered lists', () => {
    expect(parseMarkdown('Picks:\n- one\n* two\n\n1. first\n2. second')).toEqual<MdBlock[]>([
      { type: 'p', lines: [[{ type: 'text', text: 'Picks:' }]] },
      { type: 'ul', items: [[{ type: 'text', text: 'one' }], [{ type: 'text', text: 'two' }]] },
      { type: 'ol', items: [[{ type: 'text', text: 'first' }], [{ type: 'text', text: 'second' }]] },
    ]);
  });

  it('parses headings as their own block', () => {
    expect(parseMarkdown('## Picks')).toEqual<MdBlock[]>([
      { type: 'h', children: [{ type: 'text', text: 'Picks' }] },
    ]);
  });

  it('keeps fenced code verbatim', () => {
    expect(parseMarkdown('```js\nconst a = **b**;\n<img>\n```')).toEqual<MdBlock[]>([
      { type: 'pre', text: 'const a = **b**;\n<img>' },
    ]);
  });

  it('leaves non-http links and unclosed markers as text', () => {
    const [p] = parseMarkdown('[x](javascript:alert(1)) and **open');
    expect(p).toEqual({
      type: 'p',
      lines: [[{ type: 'text', text: '[x](javascript:alert(1)) and **open' }]],
    });
  });
});

// A minimal document: enough to see what renderMarkdown builds.
interface FakeNode { tag?: string; text?: string; attrs: Record<string, string>; children: FakeNode[] }
function fakeDoc() {
  const el = (tag: string): FakeNode & { setAttribute(k: string, v: string): void; appendChild(c: FakeNode): void } => {
    const n: FakeNode = { tag, attrs: {}, children: [] };
    return Object.assign(n, {
      setAttribute(k: string, v: string) { n.attrs[k] = v; },
      appendChild(c: FakeNode) { n.children.push(c); },
    });
  };
  return {
    createElement: el,
    createTextNode: (text: string): FakeNode => ({ text, attrs: {}, children: [] }),
    createDocumentFragment: () => el('#fragment'),
  };
}
function html(n: FakeNode): string {
  if (n.text !== undefined) return n.text;
  const inner = n.children.map(html).join('');
  if (n.tag === '#fragment') return inner;
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${v}"`).join('');
  return `<${n.tag}${attrs}>${inner}</${n.tag}>`;
}

describe('renderMarkdown', () => {
  it('builds elements and text nodes; markup in a reply stays text', () => {
    const doc = fakeDoc();
    const out = renderMarkdown('Hi <img src=x onerror=alert(1)> **b**', doc as unknown as Document);
    expect(html(out as unknown as FakeNode)).toBe('<p>Hi <img src=x onerror=alert(1)> <strong>b</strong></p>');
    // The "<img ...>" above is a text node, not an element.
    const p = (out as unknown as FakeNode).children[0];
    expect(p.children.filter((c) => c.tag === 'img')).toHaveLength(0);
  });

  it('opens links in a new tab without giving the target page a handle', () => {
    const doc = fakeDoc();
    const out = renderMarkdown('[docs](https://a.example/)', doc as unknown as Document);
    expect(html(out as unknown as FakeNode)).toBe(
      '<p><a href="https://a.example/" target="_blank" rel="noopener noreferrer" title="https://a.example/">docs</a></p>',
    );
  });

  it('renders lists, line breaks and code blocks', () => {
    const doc = fakeDoc();
    const out = renderMarkdown('a\nb\n\n- x\n\n```\n<b>\n```', doc as unknown as Document);
    expect(html(out as unknown as FakeNode)).toBe('<p>a<br></br>b</p><ul><li>x</li></ul><pre><code><b></code></pre>');
  });
});
