/**
 * The sidebar Agent panel's orchestration, pulled out of sidebar.ts so it's
 * testable without a DOM: loading the agent list and the backend
 * selection, pruning a selection that no longer names a real agent,
 * re-reading the list immediately before every save so a save is never
 * based on a stale in-memory copy, and clearing the selection when the
 * selected agent is removed.
 */
import { describe, expect, it, vi } from 'vitest';
import { AgentPanelController, type AgentBackendIO } from '../sidebar-agent-controller';
import type { ConfiguredAgent } from '../sidebar-agents';

const GOOSE: ConfiguredAgent = { id: 'goose', name: 'goose', command: 'goose', args: ['acp'] };
const CODEX: ConfiguredAgent = { id: 'codex', name: 'Codex', command: 'npx', args: ['-y', 'codex-acp'] };

type FakeAgentBackendIO = {
  getAgents: ReturnType<typeof vi.fn>;
  saveAgents: ReturnType<typeof vi.fn>;
  getBackend: ReturnType<typeof vi.fn>;
  setBackend: ReturnType<typeof vi.fn>;
};

function fakeIo(overrides: Partial<FakeAgentBackendIO> = {}): FakeAgentBackendIO & AgentBackendIO {
  return {
    getAgents: overrides.getAgents ?? vi.fn(async () => ({ ok: true, agents: [GOOSE, CODEX] })),
    saveAgents: overrides.saveAgents ?? vi.fn(async () => ({ ok: true })),
    getBackend: overrides.getBackend ?? vi.fn(async () => ({ ok: true, setting: null })),
    setBackend: overrides.setBackend ?? vi.fn(async () => ({ ok: true })),
  };
}

describe('AgentPanelController.load', () => {
  it('reports the agents and the current selection', async () => {
    const io = fakeIo({ getBackend: vi.fn(async () => ({ ok: true, setting: { type: 'acp' as const, agentId: 'goose' } })) });
    const controller = new AgentPanelController(io);
    const result = await controller.load();
    expect(result).toEqual({ ok: true, agents: [GOOSE, CODEX], selection: 'goose' });
    expect(controller.isLoaded).toBe(true);
  });

  it('is not loaded after a failed load, and reports the error', async () => {
    const io = fakeIo({ getAgents: vi.fn(async () => ({ ok: false, error: 'bridge not connected' })) });
    const controller = new AgentPanelController(io);
    const result = await controller.load();
    expect(result).toEqual({ ok: false, error: 'bridge not connected' });
    expect(controller.isLoaded).toBe(false);
  });

  it('clears a stored selection naming an agent that no longer exists, and shows built-in', async () => {
    const io = fakeIo({ getBackend: vi.fn(async () => ({ ok: true, setting: { type: 'acp' as const, agentId: 'ghost' } })) });
    const controller = new AgentPanelController(io);
    const result = await controller.load();
    expect(result).toEqual({ ok: true, agents: [GOOSE, CODEX], selection: null });
    expect(io.setBackend).toHaveBeenCalledWith(null);
  });

  it('a null backend setting (built-in) is left alone', async () => {
    const io = fakeIo();
    const controller = new AgentPanelController(io);
    const result = await controller.load();
    expect(result).toEqual({ ok: true, agents: [GOOSE, CODEX], selection: null });
    expect(io.setBackend).not.toHaveBeenCalled();
  });
});

describe('AgentPanelController.saveAgent: re-reads the list before every save', () => {
  it('a failed load followed by a save never sends a list missing the stored agents', async () => {
    const getAgents = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'offline' }) // the initial load fails
      .mockResolvedValueOnce({ ok: true, agents: [GOOSE, CODEX] }); // the save's own fresh re-read succeeds
    const saveAgents = vi.fn(async () => ({ ok: true }));
    const io = fakeIo({ getAgents, saveAgents });
    const controller = new AgentPanelController(io);

    await controller.load(); // fails; controller.isLoaded stays false
    expect(controller.isLoaded).toBe(false);

    const newAgent: ConfiguredAgent = { id: 'new-one', name: 'New', command: 'new', args: [] };
    const result = await controller.saveAgent(newAgent);

    expect(result.ok).toBe(true);
    // The saved payload carries every agent the fresh re-read reported,
    // plus the new one — never just [newAgent].
    expect(saveAgents).toHaveBeenCalledWith([GOOSE, CODEX, newAgent]);
  });

  it('aborts without calling acp_save_agents when the pre-save re-read itself fails', async () => {
    const getAgents = vi.fn().mockResolvedValue({ ok: false, error: 'bridge not connected' });
    const saveAgents = vi.fn(async () => ({ ok: true }));
    const io = fakeIo({ getAgents, saveAgents });
    const controller = new AgentPanelController(io);

    const result = await controller.saveAgent(GOOSE);

    expect(result.ok).toBe(false);
    expect(saveAgents).not.toHaveBeenCalled();
  });

  it('replaces an existing agent by id in the freshly-read list, not the stale in-memory one', async () => {
    const staleGoose = { ...GOOSE, command: 'stale-path' };
    const getAgents = vi.fn()
      .mockResolvedValueOnce({ ok: true, agents: [staleGoose, CODEX] }) // initial load
      .mockResolvedValueOnce({ ok: true, agents: [GOOSE, CODEX] }); // someone else updated it before this save
    const saveAgents = vi.fn(async () => ({ ok: true }));
    const io = fakeIo({ getAgents, saveAgents });
    const controller = new AgentPanelController(io);
    await controller.load();

    const edited = { ...GOOSE, name: 'goose (edited)' };
    await controller.saveAgent(edited);

    expect(saveAgents).toHaveBeenCalledWith([edited, CODEX]);
  });
});

describe('AgentPanelController.removeAgent', () => {
  it('clears the backend selection when the removed agent was selected', async () => {
    const io = fakeIo({ getBackend: vi.fn(async () => ({ ok: true, setting: { type: 'acp' as const, agentId: 'goose' } })) });
    const controller = new AgentPanelController(io);
    await controller.load();

    const result = await controller.removeAgent('goose');

    expect(result).toEqual({ ok: true, agents: [CODEX], selectionCleared: true });
    expect(io.setBackend).toHaveBeenCalledWith(null);
    expect(controller.currentSelection).toBeNull();
  });

  it('leaves the selection alone when a different agent is removed', async () => {
    const io = fakeIo({ getBackend: vi.fn(async () => ({ ok: true, setting: { type: 'acp' as const, agentId: 'goose' } })) });
    const controller = new AgentPanelController(io);
    await controller.load();

    const result = await controller.removeAgent('codex');

    expect(result).toEqual({ ok: true, agents: [GOOSE], selectionCleared: false });
    expect(io.setBackend).not.toHaveBeenCalled();
    expect(controller.currentSelection).toBe('goose');
  });

  it('re-reads the list before removing too, so it is not based on a stale copy', async () => {
    const getAgents = vi.fn()
      .mockResolvedValueOnce({ ok: true, agents: [GOOSE, CODEX] })
      .mockResolvedValueOnce({ ok: true, agents: [GOOSE, CODEX, { id: 'claude-code', name: 'Claude Code', command: 'npx', args: [] }] });
    const saveAgents = vi.fn(async () => ({ ok: true }));
    const io = fakeIo({ getAgents, saveAgents });
    const controller = new AgentPanelController(io);
    await controller.load();

    await controller.removeAgent('codex');

    expect(saveAgents).toHaveBeenCalledWith([GOOSE, { id: 'claude-code', name: 'Claude Code', command: 'npx', args: [] }]);
  });
});

describe('AgentPanelController.selectBackend', () => {
  it('writes the setting and tracks the new selection', async () => {
    const io = fakeIo();
    const controller = new AgentPanelController(io);
    await controller.load();

    const result = await controller.selectBackend('goose');

    expect(result).toEqual({ ok: true });
    expect(io.setBackend).toHaveBeenCalledWith({ type: 'acp', agentId: 'goose' });
    expect(controller.currentSelection).toBe('goose');
  });

  it('clears the selection for the built-in choice (null)', async () => {
    const io = fakeIo({ getBackend: vi.fn(async () => ({ ok: true, setting: { type: 'acp' as const, agentId: 'goose' } })) });
    const controller = new AgentPanelController(io);
    await controller.load();

    const result = await controller.selectBackend(null);

    expect(result).toEqual({ ok: true });
    expect(io.setBackend).toHaveBeenCalledWith(null);
    expect(controller.currentSelection).toBeNull();
  });

  it('does not update the tracked selection when the write fails', async () => {
    const io = fakeIo({ setBackend: vi.fn(async () => ({ ok: false, error: 'storage error' })) });
    const controller = new AgentPanelController(io);
    await controller.load();

    const result = await controller.selectBackend('goose');

    expect(result).toEqual({ ok: false, error: 'storage error' });
    expect(controller.currentSelection).toBeNull();
  });
});
