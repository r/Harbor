import { afterEach, describe, expect, it } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import {
  AGENT_BACKEND_STORAGE_KEY,
  parseAgentBackendSetting,
  readAgentBackendSetting,
  writeAgentBackendSetting,
} from '../agent-backend-setting';

afterEach(() => {
  resetMockBrowser();
});

describe('parseAgentBackendSetting', () => {
  it('accepts the one valid shape', () => {
    expect(parseAgentBackendSetting({ type: 'acp', agentId: 'goose' })).toEqual({ type: 'acp', agentId: 'goose' });
  });

  it('rejects anything else', () => {
    expect(parseAgentBackendSetting(null)).toBeNull();
    expect(parseAgentBackendSetting({})).toBeNull();
    expect(parseAgentBackendSetting({ type: 'acp' })).toBeNull();
    expect(parseAgentBackendSetting({ type: 'acp', agentId: '' })).toBeNull();
    expect(parseAgentBackendSetting({ type: 'builtin', agentId: 'goose' })).toBeNull();
    expect(parseAgentBackendSetting('goose')).toBeNull();
  });
});

describe('writeAgentBackendSetting / readAgentBackendSetting', () => {
  it('writes a valid setting and reads it back', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await expect(readAgentBackendSetting()).resolves.toEqual({ type: 'acp', agentId: 'goose' });
  });

  it('clears the setting on null, falling back to the built-in backend', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await writeAgentBackendSetting(null);
    await expect(readAgentBackendSetting()).resolves.toBeNull();
  });

  it('never writes an unvalidated value — the caller must parse first', async () => {
    // @ts-expect-error - exercising the runtime guard against a bad shape
    await expect(writeAgentBackendSetting({ type: 'acp' })).rejects.toThrow();
    await expect(readAgentBackendSetting()).resolves.toBeNull();
  });

  it('uses the documented storage key', async () => {
    await writeAgentBackendSetting({ type: 'acp', agentId: 'codex' });
    const stored = await chrome.storage.local.get(AGENT_BACKEND_STORAGE_KEY);
    expect(stored[AGENT_BACKEND_STORAGE_KEY]).toEqual({ type: 'acp', agentId: 'codex' });
  });
});
