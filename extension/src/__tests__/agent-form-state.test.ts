/**
 * The Agent panel's Add/Edit form tracks which agent (if any) it's
 * currently editing — Save needs this to decide whether to update that
 * agent in place or add a new one. Pulled out of sidebar.ts so the one
 * transition that was buggy there is testable without a DOM: pressing
 * Check on a brand-new agent saves it (there's no way to start an
 * unconfigured agent otherwise), and the form must then treat it as the
 * agent it's editing — otherwise a later Save generates a fresh id and
 * adds a duplicate instead of updating the one Check just created.
 */
import { describe, expect, it } from 'vitest';
import { AgentFormState } from '../agent-form-state';
import type { ConfiguredAgent } from '../sidebar-agents';

describe('AgentFormState', () => {
  it('a brand-new form (no editingOriginal) gets a fresh id', () => {
    const state = new AgentFormState();
    expect(state.editingOriginal).toBeNull();
    expect(state.idFor([], 'goose')).toBe('goose');
  });

  it('reset(agent) starts editing an existing agent — its own id is kept', () => {
    const state = new AgentFormState();
    const existing: ConfiguredAgent = { id: 'codex', name: 'Codex', command: 'npx', args: [] };
    state.reset(existing);
    expect(state.editingOriginal).toEqual(existing);
    expect(state.idFor([existing], 'Codex, renamed')).toBe('codex');
  });

  it('reset() with no argument clears back to "adding a new agent"', () => {
    const state = new AgentFormState();
    state.reset({ id: 'codex', name: 'Codex', command: 'npx', args: [] });
    state.reset();
    expect(state.editingOriginal).toBeNull();
  });

  // The bug this guards against: Check saves a brand-new agent (acp.open
  // only starts an already-configured one), but the form kept treating it
  // as "adding new" — so pressing Save right after Check generated a
  // second, different id for the same fields and added a duplicate agent
  // instead of updating the one Check just saved.
  describe('trackSaved: Check-then-Save does not duplicate the agent', () => {
    it('after trackSaved, idFor reuses the saved agent\'s own id rather than generating a new one', () => {
      const state = new AgentFormState();
      const id = state.idFor([], 'goose'); // what Check's own save used
      const saved: ConfiguredAgent = { id, name: 'goose', command: '/opt/homebrew/bin/goose', args: ['acp'] };

      state.trackSaved(saved);

      // Save, pressed next, must compute the *same* id — not a fresh one
      // (uniqueAgentId would mint "goose-2" here, since "goose" is now
      // already taken in the list Save re-reads).
      expect(state.idFor([saved], 'goose')).toBe(id);
      expect(state.editingOriginal).toEqual(saved);
    });

    it('a later edit through trackSaved keeps pointing Save at the same agent, not a new one each time', () => {
      const state = new AgentFormState();
      const first = { id: 'goose', name: 'goose', command: 'goose', args: ['acp'] };
      state.trackSaved(first);
      const edited = { ...first, command: '/usr/local/bin/goose' };
      state.trackSaved(edited);
      expect(state.idFor([edited], 'goose')).toBe('goose');
      expect(state.editingOriginal).toEqual(edited);
    });
  });
});
