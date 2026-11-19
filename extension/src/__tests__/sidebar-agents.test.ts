import { describe, expect, it } from 'vitest';
import {
  AGENT_PRESETS,
  agentFromForm,
  backendSettingForChoice,
  buildCustomAgent,
  buildPresetAgent,
  parseArgsText,
  uniqueAgentId,
  withAgentRemoved,
  withAgentSaved,
  type ConfiguredAgent,
} from '../sidebar-agents';

describe('AGENT_PRESETS', () => {
  it('ships exactly the three documented presets, with no approval modes and no env', () => {
    expect(Object.keys(AGENT_PRESETS).sort()).toEqual(['claude-code', 'codex', 'goose']);
    for (const preset of Object.values(AGENT_PRESETS)) {
      expect(preset).not.toHaveProperty('env');
      expect(preset).not.toHaveProperty('approvalMode');
    }
  });

  it('goose starts with `goose acp`', () => {
    expect(AGENT_PRESETS.goose).toMatchObject({ command: 'goose', args: ['acp'] });
  });

  it('Claude Code and Codex start via npx, pinned to the documented adapter versions', () => {
    expect(AGENT_PRESETS['claude-code']).toMatchObject({
      command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.108.1'],
    });
    expect(AGENT_PRESETS.codex).toMatchObject({
      command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@2.7.0'],
    });
  });

  it('each preset links its own environment docs', () => {
    expect(AGENT_PRESETS.goose.docsUrl).toBe('https://goose-docs.ai/docs/guides/config-files');
    expect(AGENT_PRESETS['claude-code'].docsUrl).toBe('https://docs.anthropic.com/en/docs/claude-code/settings');
    expect(AGENT_PRESETS.codex.docsUrl).toBe('https://github.com/openai/codex/blob/main/docs/config.md');
  });
});

describe('buildPresetAgent: preset -> resolve -> save payload', () => {
  it('uses the resolved absolute path when acp.resolve_command found one', () => {
    const agent = buildPresetAgent('goose', 'goose', '/opt/homebrew/bin/goose');
    expect(agent).toEqual({ id: 'goose', name: 'goose', command: '/opt/homebrew/bin/goose', args: ['acp'] });
  });

  it('keeps the bare preset command when resolve_command found nothing', () => {
    const agent = buildPresetAgent('goose', 'goose', null);
    expect(agent).toEqual({ id: 'goose', name: 'goose', command: 'goose', args: ['acp'] });
  });

  it('sets no approval mode and no env, for every preset', () => {
    for (const preset of ['goose', 'claude-code', 'codex'] as const) {
      const agent = buildPresetAgent(preset, preset, null);
      expect(agent).not.toHaveProperty('env');
      expect(agent).not.toHaveProperty('approvalMode');
    }
  });

  it('never mutates the preset\'s own args array across two builds', () => {
    const a = buildPresetAgent('goose', 'goose', null);
    a.args.push('--danger');
    const b = buildPresetAgent('goose', 'goose', null);
    expect(b.args).toEqual(['acp']);
  });
});

describe('buildCustomAgent', () => {
  it('splits the args textarea one argument per line, dropping blank lines', () => {
    const agent = buildCustomAgent('my-agent', 'My Agent', '/usr/local/bin/my-agent', '--flag\n\n--verbose\n');
    expect(agent).toEqual({ id: 'my-agent', name: 'My Agent', command: '/usr/local/bin/my-agent', args: ['--flag', '--verbose'] });
  });

  it('trims whitespace around each argument', () => {
    const agent = buildCustomAgent('x', 'X', 'x', '  --a  \n  --b  ');
    expect(agent.args).toEqual(['--a', '--b']);
  });

  it('produces an empty args array for an empty textarea', () => {
    expect(buildCustomAgent('x', 'X', 'x', '').args).toEqual([]);
  });
});

describe('uniqueAgentId', () => {
  const existing: ConfiguredAgent[] = [{ id: 'goose', name: 'goose', command: 'goose', args: [] }];

  it('keeps a slug that is not already used', () => {
    expect(uniqueAgentId(existing, 'codex')).toBe('codex');
  });

  it('appends a numeric suffix when the base id is already taken', () => {
    expect(uniqueAgentId(existing, 'goose')).toBe('goose-2');
  });

  it('matches the bridge\'s own id pattern (lowercase, digits, hyphens, starting with a letter or digit)', () => {
    const id = uniqueAgentId([], 'My Custom Agent!!');
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,31}$/);
  });
});

describe('withAgentSaved / withAgentRemoved: the acp_save_agents payload', () => {
  const goose: ConfiguredAgent = { id: 'goose', name: 'goose', command: 'goose', args: ['acp'] };
  const codex: ConfiguredAgent = { id: 'codex', name: 'Codex', command: 'npx', args: ['-y', 'codex-acp'] };

  it('appends a new agent to the saved list', () => {
    expect(withAgentSaved([goose], codex)).toEqual([goose, codex]);
  });

  it('replaces an existing agent by id, in place, rather than appending a duplicate', () => {
    const edited: ConfiguredAgent = { ...goose, command: '/opt/homebrew/bin/goose' };
    expect(withAgentSaved([goose, codex], edited)).toEqual([edited, codex]);
  });

  it('removes an agent by id, leaving the rest untouched', () => {
    expect(withAgentRemoved([goose, codex], 'goose')).toEqual([codex]);
  });

  it('removing an unknown id is a no-op', () => {
    expect(withAgentRemoved([goose], 'does-not-exist')).toEqual([goose]);
  });
});

describe('parseArgsText', () => {
  it('splits one argument per non-blank line, trimmed', () => {
    expect(parseArgsText('--flag\n\n  --verbose  \n')).toEqual(['--flag', '--verbose']);
  });

  it('is empty for an empty string', () => {
    expect(parseArgsText('')).toEqual([]);
  });
});

describe('agentFromForm: Save uses exactly what the form shows', () => {
  it('builds a brand-new agent (no original) with exactly the given fields, and no env', () => {
    const agent = agentFromForm(null, 'my-agent', 'My Agent', '/usr/local/bin/my-agent', '--flag\n--verbose');
    expect(agent).toEqual({ id: 'my-agent', name: 'My Agent', command: '/usr/local/bin/my-agent', args: ['--flag', '--verbose'] });
  });

  it('a preset\'s resolved command is used as-is — the form field is authoritative, not the preset default', () => {
    // Simulates: the preset pre-filled command to the resolved path, the
    // person then edited it further; Save must reflect exactly that.
    const agent = agentFromForm(null, 'goose', 'goose', '/opt/homebrew/bin/goose --custom-flag-added-by-person', 'acp');
    expect(agent.command).toBe('/opt/homebrew/bin/goose --custom-flag-added-by-person');
  });

  it('editing an existing agent keeps any extra field it carried, like env, untouched', () => {
    const original: ConfiguredAgent = {
      id: 'goose', name: 'goose', command: 'goose', args: ['acp'],
      env: { GOOSE_MODE: 'approve' },
    };
    const edited = agentFromForm(original, 'goose', 'goose (renamed)', '/opt/homebrew/bin/goose', 'acp\n--verbose');
    expect(edited).toEqual({
      id: 'goose', name: 'goose (renamed)', command: '/opt/homebrew/bin/goose', args: ['acp', '--verbose'],
      env: { GOOSE_MODE: 'approve' },
    });
  });

  it('a new agent never carries an env field, even though editing can preserve one', () => {
    const agent = agentFromForm(null, 'x', 'X', 'x', '');
    expect(agent).not.toHaveProperty('env');
  });
});

describe('backendSettingForChoice: selection write/clear', () => {
  it('writes {type: "acp", agentId} for a chosen agent', () => {
    expect(backendSettingForChoice('goose')).toEqual({ type: 'acp', agentId: 'goose' });
  });

  it('clears the setting (null) for "Harbor (built-in model)"', () => {
    expect(backendSettingForChoice(null)).toBeNull();
  });
});
