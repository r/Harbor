/**
 * The consent prompt's wording switch: when an ACP agent is selected, the
 * model:prompt / model:tools scopes it covers say which calls actually go
 * to that agent — window.ai text sessions and agent.run — and which don't
 * (agent.sessions and a direct llm.chat still run on Harbor's built-in
 * model; see docs/ACP_BACKEND_DESIGN.md section 2's mapping table). With
 * no agent selected, the built-in wording (SCOPE_DESCRIPTIONS) is
 * untouched.
 */
import { describe, expect, it } from 'vitest';
import { SCOPE_DESCRIPTIONS } from '../permissions';
import { consentScopeDescription } from '../agent-consent-copy';

describe('consentScopeDescription', () => {
  it('returns the built-in wording unchanged when no agent is selected', () => {
    expect(consentScopeDescription('model:prompt', null)).toEqual(SCOPE_DESCRIPTIONS['model:prompt']);
    expect(consentScopeDescription('model:tools', null)).toEqual(SCOPE_DESCRIPTIONS['model:tools']);
  });

  it('returns the built-in wording unchanged for every scope other than model:prompt/model:tools, even with an agent selected', () => {
    expect(consentScopeDescription('mcp:tools.call', 'goose')).toEqual(SCOPE_DESCRIPTIONS['mcp:tools.call']);
    expect(consentScopeDescription('browser:activeTab.read', 'goose')).toEqual(SCOPE_DESCRIPTIONS['browser:activeTab.read']);
  });

  it('names the agent and says requests go to it, via ACP, for model:prompt', () => {
    const info = consentScopeDescription('model:prompt', 'goose');
    expect(info.title).toContain('goose');
    expect(info.title).toContain('via ACP');
    expect(info.title).toContain('your own agent');
  });

  it('names the agent and says requests go to it, via ACP, for model:tools', () => {
    const info = consentScopeDescription('model:tools', 'goose');
    expect(info.title).toContain('goose');
    expect(info.title).toContain('via ACP');
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

  it('keeps the risk tier from the built-in description', () => {
    expect(consentScopeDescription('model:prompt', 'goose').risk).toBe(SCOPE_DESCRIPTIONS['model:prompt'].risk);
    expect(consentScopeDescription('model:tools', 'goose').risk).toBe(SCOPE_DESCRIPTIONS['model:tools'].risk);
  });

  it('uses a different agent\'s name when a different agent is selected', () => {
    expect(consentScopeDescription('model:prompt', 'Claude Code').title).toContain('Claude Code');
    expect(consentScopeDescription('model:prompt', 'Codex').title).toContain('Codex');
  });

  it('gives model:prompt and model:tools the same title and description — both cover the same two calls', () => {
    const prompt = consentScopeDescription('model:prompt', 'goose');
    const tools = consentScopeDescription('model:tools', 'goose');
    expect(prompt.title).toBe(tools.title);
    expect(prompt.description).toBe(tools.description);
    // Risk still comes from each scope's own built-in entry (model:tools
    // is riskier than model:prompt regardless of backend).
    expect(prompt.risk).toBe(SCOPE_DESCRIPTIONS['model:prompt'].risk);
    expect(tools.risk).toBe(SCOPE_DESCRIPTIONS['model:tools'].risk);
  });
});
