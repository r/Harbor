/**
 * Harbor's pages follow the system's light or dark setting. There is no
 * in-app theme switch, and no page forces a theme over the system's.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const read = (file: string) => readFileSync(join(SRC, file), 'utf8');

const PAGES = [
  'sidebar.html', 'sidebar.ts',
  'directory.html', 'directory.ts',
  'permission-prompt.html', 'permission-prompt.ts',
  'agent-question.html', 'agent-question.ts',
];

describe('theme', () => {
  it('lets the system choose light or dark', () => {
    expect(read('design-tokens.css')).toMatch(/:root\s*\{\s*color-scheme:\s*light dark;\s*\}/);
  });

  it.each(PAGES)('%s has no theme switch and never overrides the system', (file) => {
    const source = read(file);
    expect(source).not.toMatch(/theme-toggle/);
    expect(source).not.toMatch(/data-theme/);
    expect(source).not.toMatch(/harbor-theme/);
  });
});
