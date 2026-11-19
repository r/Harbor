/**
 * The sidebar-facing handlers for ACP agent configuration and the
 * `harbor_agent_backend` selection: acp_get_agents, acp_save_agents,
 * acp_check_agent, acp_resolve_command, agent_backend_get,
 * agent_backend_set. Every one must refuse a sender that isn't one of
 * Harbor's own extension pages — this matters most for acp_save_agents,
 * which controls what program the bridge runs.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

type Listener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | void;

const listeners: Listener[] = [];

const mocks = vi.hoisted(() => ({
  bridgeRequest: vi.fn(),
  checkAcpAgent: vi.fn(),
}));

vi.mock('../../llm/bridge-client', () => ({ bridgeRequest: mocks.bridgeRequest }));
vi.mock('../acp-agent-check', () => ({
  AGENT_CHECK_WORKSPACE: 'harbor-agent-check',
  checkAcpAgent: mocks.checkAcpAgent,
}));

const EXTENSION_SENDER = { id: 'harbor-test', url: 'chrome-extension://harbor-test/sidebar.html' } as chrome.runtime.MessageSender;
const PAGE_SENDER = { id: 'harbor-test', url: 'https://example.com/page', tab: { id: 1 } } as chrome.runtime.MessageSender;

beforeAll(async () => {
  const chromeGlobal = (globalThis as unknown as { chrome: { runtime: { onMessage: { addListener: (l: Listener) => void } } } }).chrome;
  chromeGlobal.runtime.onMessage.addListener = (l: Listener) => { listeners.push(l); };
  const mod = await import('../acp-agent-handlers');
  mod.registerAcpAgentHandlers();
});

beforeEach(() => {
  resetMockBrowser();
  mocks.bridgeRequest.mockReset();
  mocks.checkAcpAgent.mockReset();
});

async function dispatch(message: Record<string, unknown>, sender: chrome.runtime.MessageSender = EXTENSION_SENDER): Promise<unknown> {
  return new Promise((resolve) => {
    let resolved = false;
    const sendResponse = (response: unknown): void => {
      if (resolved) return;
      resolved = true;
      resolve(response);
    };
    for (const l of listeners) l(message, sender, sendResponse);
  });
}

describe('sender checks (acp_save_agents controls what the bridge runs, so this matters most)', () => {
  const cases: Array<{ type: string; message: Record<string, unknown> }> = [
    { type: 'acp_get_agents', message: { type: 'acp_get_agents' } },
    { type: 'acp_save_agents', message: { type: 'acp_save_agents', agents: [] } },
    { type: 'acp_check_agent', message: { type: 'acp_check_agent', agentId: 'goose', name: 'goose', command: 'goose' } },
    { type: 'acp_resolve_command', message: { type: 'acp_resolve_command', name: 'goose' } },
    { type: 'agent_backend_get', message: { type: 'agent_backend_get' } },
    { type: 'agent_backend_set', message: { type: 'agent_backend_set', setting: null } },
  ];

  for (const { type, message } of cases) {
    it(`${type} refuses a content-script sender`, async () => {
      const response = await dispatch(message, PAGE_SENDER);
      expect(response).toEqual({ ok: false, error: 'Not available to this sender' });
      expect(mocks.bridgeRequest).not.toHaveBeenCalled();
      expect(mocks.checkAcpAgent).not.toHaveBeenCalled();
    });
  }
});

describe('acp_get_agents', () => {
  it('forwards acp.get_agents and returns its agents', async () => {
    mocks.bridgeRequest.mockResolvedValue({ agents: [{ id: 'goose', name: 'goose', command: 'goose', args: ['acp'] }] });
    const response = await dispatch({ type: 'acp_get_agents' });
    expect(mocks.bridgeRequest).toHaveBeenCalledWith('acp.get_agents', {});
    expect(response).toEqual({ ok: true, agents: [{ id: 'goose', name: 'goose', command: 'goose', args: ['acp'] }] });
  });
});

describe('acp_save_agents', () => {
  it('forwards the agent list to acp.save_agents', async () => {
    mocks.bridgeRequest.mockResolvedValue({});
    const agents = [{ id: 'goose', name: 'goose', command: 'goose', args: ['acp'] }];
    const response = await dispatch({ type: 'acp_save_agents', agents });
    expect(mocks.bridgeRequest).toHaveBeenCalledWith('acp.save_agents', { agents });
    expect(response).toEqual({ ok: true });
  });

  it('bubbles up the bridge\'s validation error', async () => {
    mocks.bridgeRequest.mockRejectedValue(Object.assign(new Error('invalid id'), { code: -32602 }));
    const response = await dispatch({ type: 'acp_save_agents', agents: [{ id: 'BAD ID' }] });
    expect(response).toMatchObject({ ok: false });
  });
});

describe('acp_resolve_command', () => {
  it('forwards the bare name and returns the resolved path', async () => {
    mocks.bridgeRequest.mockResolvedValue({ path: '/opt/homebrew/bin/goose' });
    const response = await dispatch({ type: 'acp_resolve_command', name: 'goose' });
    expect(mocks.bridgeRequest).toHaveBeenCalledWith('acp.resolve_command', { name: 'goose' });
    expect(response).toEqual({ ok: true, path: '/opt/homebrew/bin/goose' });
  });
});

describe('acp_check_agent', () => {
  it('runs the check and returns its result', async () => {
    mocks.checkAcpAgent.mockResolvedValue({ ok: true, message: 'Ready (goose v1.0.0)' });
    const response = await dispatch({ type: 'acp_check_agent', agentId: 'goose', name: 'goose', command: 'goose' });
    expect(mocks.checkAcpAgent).toHaveBeenCalledWith('goose', 'goose', 'goose');
    expect(response).toEqual({ ok: true, message: 'Ready (goose v1.0.0)' });
  });

  it('returns a failed check result without throwing', async () => {
    mocks.checkAcpAgent.mockResolvedValue({ ok: false, error: 'Command not found: npx. Set the full path.' });
    const response = await dispatch({ type: 'acp_check_agent', agentId: 'codex', name: 'Codex', command: 'npx' });
    expect(response).toEqual({ ok: false, error: 'Command not found: npx. Set the full path.' });
  });
});

describe('agent_backend_get / agent_backend_set', () => {
  it('reports null when no backend is configured', async () => {
    const response = await dispatch({ type: 'agent_backend_get' });
    expect(response).toEqual({ ok: true, setting: null });
  });

  it('round-trips a valid setting', async () => {
    const setResponse = await dispatch({ type: 'agent_backend_set', setting: { type: 'acp', agentId: 'goose' } });
    expect(setResponse).toEqual({ ok: true });
    const getResponse = await dispatch({ type: 'agent_backend_get' });
    expect(getResponse).toEqual({ ok: true, setting: { type: 'acp', agentId: 'goose' } });
  });

  it('clears the setting back to the built-in backend on null', async () => {
    await dispatch({ type: 'agent_backend_set', setting: { type: 'acp', agentId: 'goose' } });
    await dispatch({ type: 'agent_backend_set', setting: null });
    const getResponse = await dispatch({ type: 'agent_backend_get' });
    expect(getResponse).toEqual({ ok: true, setting: null });
  });

  it('rejects an invalid setting shape and does not write it', async () => {
    const response = await dispatch({ type: 'agent_backend_set', setting: { type: 'acp' } });
    expect(response).toMatchObject({ ok: false });
    const getResponse = await dispatch({ type: 'agent_backend_get' });
    expect(getResponse).toEqual({ ok: true, setting: null });
  });
});
