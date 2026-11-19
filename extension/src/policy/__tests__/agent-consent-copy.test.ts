/**
 * The consent prompt's wording switch: when an ACP agent is selected, the
 * model:prompt / model:tools scopes it covers say which calls actually go
 * to that agent — window.ai text sessions and agent.run — and which don't
 * (agent.sessions and a direct llm.chat still run on Harbor's built-in
 * model; see docs/ACP_BACKEND_DESIGN.md section 2's mapping table). With
 * no agent selected, the built-in wording (SCOPE_DESCRIPTIONS) is
 * untouched.
 *
 * The wording never names the protocol (maintainer decision):
 * a person reading this prompt doesn't need to know Harbor talks to the
 * agent over ACP.
 */
import { describe, expect, it } from 'vitest';
import { SCOPE_DESCRIPTIONS } from '../permissions';
import { consentScopeDescription, consentScopeRows } from '../agent-consent-copy';

describe('consentScopeDescription', () => {
  it('returns the built-in wording unchanged when no agent is selected', () => {
    expect(consentScopeDescription('model:prompt', null)).toEqual(SCOPE_DESCRIPTIONS['model:prompt']);
    expect(consentScopeDescription('model:tools', null)).toEqual(SCOPE_DESCRIPTIONS['model:tools']);
  });

  it('returns the built-in wording unchanged for every scope other than model:prompt/model:tools, even with an agent selected', () => {
    expect(consentScopeDescription('mcp:tools.call', 'goose')).toEqual(SCOPE_DESCRIPTIONS['mcp:tools.call']);
    expect(consentScopeDescription('browser:activeTab.read', 'goose')).toEqual(SCOPE_DESCRIPTIONS['browser:activeTab.read']);
  });

  it('names the agent and says requests go to it, as the person\'s own agent, for model:prompt', () => {
    const info = consentScopeDescription('model:prompt', 'goose');
    expect(info.title).toContain('goose');
    expect(info.title).toContain('your own agent');
  });

  it('never names the protocol in the title or description, for model:prompt or model:tools', () => {
    for (const scope of ['model:prompt', 'model:tools'] as const) {
      const info = consentScopeDescription(scope, 'goose');
      expect(info.title).not.toMatch(/ACP/i);
      expect(info.description).not.toMatch(/ACP/i);
    }
  });

  it('names which calls actually go to the agent: text prompts and agent runs', () => {
    const info = consentScopeDescription('model:prompt', 'goose');
    expect(info.title.toLowerCase()).toContain('text prompt');
    expect(info.title.toLowerCase()).toContain('agent run');
  });

  it('names the page APIs that reach the agent, and says the rest still uses the built-in model', () => {
    const info = consentScopeDescription('model:prompt', 'goose');
    expect(info.description).toContain('window.ai');
    expect(info.description).toContain('agent.run');
    expect(info.description.toLowerCase()).toContain("harbor's built-in model");
  });

  it('says plainly that the site gets the agent with whatever it can do, including its tools', () => {
    const info = consentScopeDescription('model:prompt', 'goose');
    expect(info.description.toLowerCase()).toContain('goose');
    expect(info.description.toLowerCase()).toContain('tools');
  });

  it('gives model:prompt and model:tools the MEDIUM risk level once an agent is selected — the higher of the two built-in tiers', () => {
    // model:prompt's own built-in risk is 'low', model:tools' is 'medium' —
    // with an agent selected, an agent answering a plain prompt can always
    // reach for its own tools too, so model:prompt rises to match.
    expect(consentScopeDescription('model:prompt', 'goose').risk).toBe('medium');
    expect(consentScopeDescription('model:tools', 'goose').risk).toBe('medium');
    expect(SCOPE_DESCRIPTIONS['model:prompt'].risk).toBe('low'); // unchanged built-in tier
  });

  it('uses a different agent\'s name when a different agent is selected', () => {
    expect(consentScopeDescription('model:prompt', 'Claude Code').title).toContain('Claude Code');
    expect(consentScopeDescription('model:prompt', 'Codex').title).toContain('Codex');
  });

  it('gives model:prompt and model:tools the same title, description and risk — both cover the same two calls', () => {
    const prompt = consentScopeDescription('model:prompt', 'goose');
    const tools = consentScopeDescription('model:tools', 'goose');
    expect(prompt.title).toBe(tools.title);
    expect(prompt.description).toBe(tools.description);
    expect(prompt.risk).toBe(tools.risk);
  });
});

describe('consentScopeRows', () => {
  it('merges model:prompt and model:tools into one row when both are requested and an agent is selected', () => {
    const rows = consentScopeRows(['model:prompt', 'model:tools'], 'goose');
    expect(rows).toEqual([['model:prompt', 'model:tools']]);
  });

  it('does not merge when no agent is selected, even if both scopes are requested', () => {
    const rows = consentScopeRows(['model:prompt', 'model:tools'], null);
    expect(rows).toEqual([['model:prompt'], ['model:tools']]);
  });

  it('does not merge a single-scope request — model:prompt alone stays its own row', () => {
    expect(consentScopeRows(['model:prompt'], 'goose')).toEqual([['model:prompt']]);
    expect(consentScopeRows(['model:tools'], 'goose')).toEqual([['model:tools']]);
  });

  it('leaves every other scope as its own row, merged pair placed at its first occurrence', () => {
    const rows = consentScopeRows(['mcp:tools.call', 'model:prompt', 'model:tools'], 'goose');
    expect(rows).toEqual([['mcp:tools.call'], ['model:prompt', 'model:tools']]);
  });

  it('merges regardless of which of the two scopes the request lists first', () => {
    const rows = consentScopeRows(['model:tools', 'model:prompt'], 'goose');
    expect(rows).toEqual([['model:prompt', 'model:tools']]);
  });
});
