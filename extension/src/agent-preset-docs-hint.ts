/**
 * The docs hint shown under the preset buttons (sidebar.ts, sidebar.html's
 * #agent-preset-docs-hint) once a preset is picked: a line of plain text
 * plus a link labelled "<Agent> settings docs" that opens the preset's own
 * docs in a new tab — never a raw URL printed as text (maintainer
 * decision). Built with `createElement`/`textContent` only, the same
 * discipline as `scope-item.ts`'s `buildScopeItem`: nothing here needs to
 * interpret markup, so nothing gets `innerHTML`.
 */
import type { AgentPreset } from './sidebar-agents';

/** Returns a `<span>` holding the hint text and the docs link, ready to replace `#agent-preset-docs-hint`'s children. */
export function buildAgentPresetDocsHint(preset: AgentPreset): HTMLElement {
  const container = document.createElement('span');
  container.appendChild(document.createTextNode(`Give ${preset.name}'s tools their keys in its own settings: `));

  const link = document.createElement('a');
  link.href = preset.docsUrl;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = `${preset.name} settings docs`;
  container.appendChild(link);

  return container;
}
