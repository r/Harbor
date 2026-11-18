/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// agent.run has one implementation: handleAgentRun in page-api/background.ts.
// The extension used to ship its own chat window with a second window.agent
// that ran its own loop and treated every permission as granted, so fixes to
// the real loop never reached it. Keep it from coming back.
const ext = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(ext, path), 'utf8');

describe('one agent.run loop', () => {
  it('the extension does not bundle a second window.agent', () => {
    expect(existsSync(resolve(ext, 'src/demo-bootstrap.ts'))).toBe(false);
    expect(existsSync(resolve(ext, 'demo'))).toBe(false);
    expect(read('build.mjs')).not.toContain('demo-bootstrap');
  });

  it.each(['manifest.json', 'manifest.chrome.json', 'manifest.safari.json'])(
    '%s exposes no demo pages or bootstrap script to web pages',
    (manifest) => {
      const source = read(manifest);
      expect(source).not.toContain('demo-bootstrap');
      expect(source).not.toContain('"demo/*"');
    },
  );

  it('the sidebar has no button that opens the bundled chat window', () => {
    expect(read('src/sidebar.html')).not.toContain('open-chat-btn');
    expect(read('src/sidebar.ts')).not.toContain('demo/chat-poc');
  });
});
