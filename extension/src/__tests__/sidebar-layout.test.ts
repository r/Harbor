/**
 * The sidebar's layout: a calm main view with your agent and what sites did,
 * and everything technical behind Settings. Order and placement are checked
 * by where each element's id sits in sidebar.html.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const html = readFileSync(join(__dirname, '..', 'sidebar.html'), 'utf8');
const ts = readFileSync(join(__dirname, '..', 'sidebar.ts'), 'utf8');

const at = (id: string) => {
  const i = html.indexOf(`id="${id}"`);
  expect(i, `#${id} is missing`).toBeGreaterThan(-1);
  return i;
};

/** The opening tag of the element with this id. */
const tag = (id: string) => {
  const i = at(id);
  return html.slice(html.lastIndexOf('<', i), html.indexOf('>', i) + 1);
};

const inOrder = (ids: string[]) => {
  const positions = ids.map(at);
  expect(positions, ids.join(' < ')).toEqual([...positions].sort((a, b) => a - b));
};

describe('sidebar layout', () => {
  it("leaves the name to the browser's own sidebar header", () => {
    // Firefox's sidebar and Chrome's side panel already title it "Harbor".
    expect(html.slice(html.indexOf("<body"))).not.toMatch(/>\s*Harbor\s*</);
  });

  it('has a main view and a settings view', () => {
    inOrder(['main-view', 'settings-view']);
    expect(tag('settings-view')).toMatch(/\shidden[\s>]/);
    expect(tag('main-view')).not.toMatch(/\shidden[\s>]/);
  });

  it('puts your agent first in the main view, then what sites did, then the way to Settings', () => {
    inOrder([
      'main-view', 'bridge-notice', 'welcome-card',
      'sessions-panel', 'activity-panel', 'permissions-panel', 'api-toggles-panel',
      'open-settings', 'settings-view',
    ]);
  });

  it('keeps everything technical behind Settings, with the model under the agent', () => {
    inOrder([
      'settings-view',
      'agent-panel', 'llm-panel', 'servers-panel', 'oauth-panel',
      'developer-panel', 'setup-status-list', 'reload-extension-btn', 'tool-tester-panel',
    ]);
  });

  it('calls the built-in model\'s section "Model", not "LLM Providers"', () => {
    expect(html).not.toContain('LLM Providers');
    expect(html.slice(at('llm-panel'), at('servers-panel'))).toMatch(/>Model</);
  });

  it('opens the directory from the tools section, with no Quick Actions panel', () => {
    expect(html).not.toContain('quick-actions');
    expect(ts).not.toContain('quick-actions');
    const directory = at('open-directory-btn');
    expect(directory).toBeGreaterThan(at('servers-panel'));
    expect(directory).toBeLessThan(at('oauth-panel'));
  });

  it('shows the bridge only when there is trouble', () => {
    expect(tag('bridge-notice')).toMatch(/\shidden[\s>]/);
    expect(ts).toMatch(/bridgeNotice\.hidden = /);
    // The header no longer carries a permanent connection badge.
    expect(html).not.toContain('id="bridge-status-text"');
  });

  it('shows agent sessions only when there are some', () => {
    expect(tag('sessions-panel')).toMatch(/\shidden[\s>]/);
    expect(ts).toMatch(/sessionsPanel\.hidden = /);
  });

  it.each(['activity-body', 'permissions-list', 'api-toggles-body'])('starts %s collapsed', (id) => {
    expect(tag(id)).toMatch(/class="[^"]*\bcollapsed\b/);
  });

  it('draws no box around each panel', () => {
    const rule = html.match(/\n\s*\.panel \{([^}]*)\}/);
    expect(rule, '.panel rule').not.toBeNull();
    expect(rule![1]).not.toMatch(/border(-[a-z]+)?:\s*(?!none|0)/);
    expect(rule![1]).not.toMatch(/box-shadow:\s*(?!none)/);
  });
});
