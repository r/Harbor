/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Harbor's mark is the lighthouse in assets/icon.svg. The UI badges inline the
// same shapes (an <img> can't reach extension files from inside a web page),
// so this keeps every copy in step with the icon.
const repo = resolve(__dirname, '../../..');
const read = (path: string) => readFileSync(resolve(repo, path), 'utf8');

const icon = read('extension/assets/icon.svg');
const shapes = icon.match(/<(?:rect|path)\b[^>]*\/>/g) ?? [];

const BADGES = [
  'extension/src/sidebar.html',
  'extension/src/permission-prompt.html',
  'extension/src/directory.html',
  'extension/src/page-chat.ts',
  'extension/demo/chat-poc/index.html',
  'demo/web-agents/chat-poc/index.html',
];

describe('lighthouse mark', () => {
  it('icon.svg is the lighthouse, not the old H', () => {
    expect(shapes.length).toBeGreaterThan(5);
    expect(icon).toContain('#00d230');
    expect(icon).not.toContain('#1a4a6e');
  });

  it.each(BADGES)('%s shows the lighthouse instead of an H badge', (path) => {
    const source = read(path);
    expect(source).not.toMatch(/logo[^"]*">H<\//);
    for (const shape of shapes) expect(source).toContain(shape);
  });
});
