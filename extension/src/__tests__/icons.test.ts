/**
 * Harbor's UI draws icons with Lucide through src/icons.ts. Emoji render
 * differently on every platform and clash with the brand, so the
 * user-facing sources must not use them, or text glyphs, as icons.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICONS, icon, isIconName } from '../icons';

const SRC = join(__dirname, '..');

// Every file that renders UI a person sees.
const UI_FILES = [
  'sidebar.html', 'sidebar.ts', 'sidebar-models.ts', 'sidebar-agents.ts', 'sidebar-agent-controller.ts',
  'directory.html', 'directory.ts',
  'permission-prompt.html', 'permission-prompt.ts', 'scope-item.ts',
  'agent-question.html', 'agent-question.ts',
  'page-chat.ts',
];

// Emoji, plus the arrows, stars, checks, crosses and triangles used as icons.
const ICON_GLYPH = /\p{Extended_Pictographic}|[←-⇿⌀-⏿■-◿☀-➿⬀-⯿]|&#(9[0-9]{3}|1[0-2][0-9]{3}|12[0-9]{4});/u;

describe('icons', () => {
  it('renders a decorative SVG that inherits the text color', () => {
    const svg = icon('check');
    expect(svg).toMatch(/^<svg class="icon"/);
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('aria-hidden="true"');
    expect(svg).toContain('width="16"');
  });

  it('labels an icon for assistive tech when asked', () => {
    const svg = icon('x', { size: 20, label: 'Remove "goose"' });
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label="Remove &quot;goose&quot;"');
    expect(svg).not.toContain('aria-hidden');
    expect(svg).toContain('width="20"');
  });

  it('knows only the icons it bundles', () => {
    expect(isIconName('sun')).toBe(true);
    expect(isIconName('toString')).toBe(false);
    expect(isIconName('dolphin')).toBe(false);
    for (const node of Object.values(ICONS)) expect(node.length).toBeGreaterThan(0);
  });

  it.each(UI_FILES)('%s uses no emoji or glyph icons', (file) => {
    const offending = readFileSync(join(SRC, file), 'utf8')
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter(({ text }) => !/^(\/\/|\*|\/\*)/.test(text) && ICON_GLYPH.test(text));
    expect(offending).toEqual([]);
  });
});
