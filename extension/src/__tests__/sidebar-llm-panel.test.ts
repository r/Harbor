/**
 * The LLM Providers panel's reaction to the Agent panel's selection
 * (sidebar.ts): collapsed-by-default and a one-line note while
 * an ACP agent is selected; today's behavior (expanded, no note) with the
 * built-in model selected.
 */
import { describe, expect, it } from 'vitest';
import { LLM_PANEL_AGENT_NOTE, llmPanelCollapsedForAgent, llmPanelNoteForAgent } from '../sidebar-llm-panel';

describe('llmPanelCollapsedForAgent', () => {
  it('collapses the panel when an agent is selected', () => {
    expect(llmPanelCollapsedForAgent(true)).toBe(true);
  });

  it('leaves the panel expanded when the built-in model is selected — today\'s behavior', () => {
    expect(llmPanelCollapsedForAgent(false)).toBe(false);
  });
});

describe('llmPanelNoteForAgent', () => {
  it('shows the note while an agent is selected', () => {
    expect(llmPanelNoteForAgent(true)).toBe(LLM_PANEL_AGENT_NOTE);
    expect(LLM_PANEL_AGENT_NOTE).toContain('agent.sessions');
    expect(LLM_PANEL_AGENT_NOTE.toLowerCase()).toContain("harbor's own chat");
  });

  it('shows no note with the built-in model selected', () => {
    expect(llmPanelNoteForAgent(false)).toBeNull();
  });
});
