import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

const mocks = vi.hoisted(() => ({ bridgeRequest: vi.fn() }));
vi.mock('../../llm/bridge-client', () => ({ bridgeRequest: mocks.bridgeRequest }));

import { writeAgentBackendSetting } from '../../page-api/agent-backend-setting';
import { resolveConsentAgentName } from '../agent-consent';

afterEach(() => {
  resetMockBrowser();
  mocks.bridgeRequest.mockReset();
});

describe('resolveConsentAgentName', () => {
  it('returns null when no agent backend is selected', async () => {
    await expect(resolveConsentAgentName()).resolves.toBeNull();
    expect(mocks.bridgeRequest).not.toHaveBeenCalled();
  });

  it('returns the configured agent\'s own display name', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    mocks.bridgeRequest.mockResolvedValue({ agents: [{ id: 'goose', name: 'goose', command: 'goose', args: ['acp'] }] });

    await expect(resolveConsentAgentName()).resolves.toBe('goose');
  });

  it('falls back to the agent id when the bridge has no matching agent', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'ghost' });
    mocks.bridgeRequest.mockResolvedValue({ agents: [] });

    await expect(resolveConsentAgentName()).resolves.toBe('ghost');
  });

  it('falls back to the agent id when the bridge call fails', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    mocks.bridgeRequest.mockRejectedValue(new Error('bridge not connected'));

    await expect(resolveConsentAgentName()).resolves.toBe('goose');
  });
});
