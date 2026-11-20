/**
 * A small markdown renderer for chat replies.
 *
 * Page chat draws its panel inside the site's page, so reply text must never
 * be parsed as HTML there. This module parses a safe subset into a plain
 * tree (`parseMarkdown`) and builds it with `createElement`/`createTextNode`
 * only (`renderMarkdown`). Anything outside the subset stays literal text.
 *
 * Subset: paragraphs and line breaks, `#`–`######` headings, `-`/`*`/`+`
 * and `1.` lists, fenced code blocks, `**bold**`/`__bold__`,
 * `*italic*`/`_italic_`, `` `code` ``, and `[text](https://…)` links
 * (http and https only).
 */

export type MdInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; children: MdInline[] }
  | { type: 'em'; children: MdInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MdInline[] };

export type MdBlock =
  | { type: 'p'; lines: MdInline[][] }
  | { type: 'h'; children: MdInline[] }
  | { type: 'ul'; items: MdInline[][] }
  | { type: 'ol'; items: MdInline[][] }
  | { type: 'pre'; text: string };

const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const NUMBERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}```/;

export function parseMarkdown(source: string): MdBlock[] {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', lines: para.map(parseInline) });
    para = [];
  };
  const flushList = () => {
    if (list) blocks.push({ type: list.type, items: list.items.map(parseInline) });
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (FENCE.test(line)) {
      flushPara();
      flushList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      blocks.push({ type: 'pre', text: body.join('\n') });
      continue;
    }

    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: 'h', children: parseInline(heading[1]) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      const type = bullet ? 'ul' : 'ol';
      flushPara();
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((bullet ?? numbered)![1]);
      continue;
    }

    if (list && /^\s+\S/.test(line)) {
      // An indented line continues the last list item.
      list.items[list.items.length - 1] += ` ${line.trim()}`;
      continue;
    }

    flushList();
    para.push(line);
  }
  flushPara();
  flushList();
  return blocks;
}

interface InlineRule {
  re: RegExp;
  build: (m: RegExpExecArray) => MdInline;
}

// Order breaks ties at the same position: code first, so markers inside
// backticks stay literal, then bold before italic.
const INLINE_RULES: InlineRule[] = [
  { re: /`([^`\n]+)`/, build: (m) => ({ type: 'code', text: m[1] }) },
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*/, build: (m) => ({ type: 'strong', children: parseInline(m[1]) }) },
  { re: /__(?=\S)([\s\S]*?\S)__/, build: (m) => ({ type: 'strong', children: parseInline(m[1]) }) },
  {
    re: /\[([^\]\n]+)\]\((https?:\/\/[^\s()]+)\)/,
    build: (m) => ({ type: 'link', href: m[2], children: parseInline(m[1]) }),
  },
  { re: /\*(?=[^\s*])([^*\n]*?[^\s*])\*/, build: (m) => ({ type: 'em', children: parseInline(m[1]) }) },
  { re: /(?<![\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])/, build: (m) => ({ type: 'em', children: parseInline(m[1]) }) },
];

export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  let rest = text;
  while (rest) {
    let best: { index: number; length: number; node: MdInline } | null = null;
    for (const rule of INLINE_RULES) {
      const m = rule.re.exec(rest);
      if (m && (!best || m.index < best.index)) best = { index: m.index, length: m[0].length, node: rule.build(m) };
    }
    if (!best) {
      pushText(out, rest);
      break;
    }
    if (best.index > 0) pushText(out, rest.slice(0, best.index));
    out.push(best.node);
    rest = rest.slice(best.index + best.length);
  }
  return out;
}

function pushText(out: MdInline[], text: string): void {
  const last = out[out.length - 1];
  if (last?.type === 'text') last.text += text;
  else out.push({ type: 'text', text });
}

type DocLike = Pick<Document, 'createElement' | 'createTextNode' | 'createDocumentFragment'>;

/** Builds `source` as DOM nodes. Reply text only ever becomes text nodes. */
export function renderMarkdown(source: string, doc: DocLike = document): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const block of parseMarkdown(source)) frag.appendChild(renderBlock(block, doc));
  return frag;
}

function renderBlock(block: MdBlock, doc: DocLike): Node {
  switch (block.type) {
    case 'p': {
      const p = doc.createElement('p');
      block.lines.forEach((line, i) => {
        if (i > 0) p.appendChild(doc.createElement('br'));
        appendInline(p, line, doc);
      });
      return p;
    }
    case 'h': {
      const h = doc.createElement('h4');
      appendInline(h, block.children, doc);
      return h;
    }
    case 'ul':
    case 'ol': {
      const list = doc.createElement(block.type);
      for (const item of block.items) {
        const li = doc.createElement('li');
        appendInline(li, item, doc);
        list.appendChild(li);
      }
      return list;
    }
    case 'pre': {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.appendChild(doc.createTextNode(block.text));
      pre.appendChild(code);
      return pre;
    }
  }
}

function appendInline(parent: Node, nodes: MdInline[], doc: DocLike): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        parent.appendChild(doc.createTextNode(node.text));
        break;
      case 'code': {
        const code = doc.createElement('code');
        code.appendChild(doc.createTextNode(node.text));
        parent.appendChild(code);
        break;
      }
      case 'strong':
      case 'em': {
        const el = doc.createElement(node.type);
        appendInline(el, node.children, doc);
        parent.appendChild(el);
        break;
      }
      case 'link': {
        const a = doc.createElement('a');
        a.setAttribute('href', node.href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.setAttribute('title', node.href);
        appendInline(a, node.children, doc);
        parent.appendChild(a);
        break;
      }
    }
  }
}
