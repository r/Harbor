/**
 * `isModelPromptGrantedForAgent` is acp-text-session.ts's defence in
 * depth: a text session's own `agentId` is fixed at creation, so its
 * per-turn grant check must judge the grant against *that* backend, not
 * a live read of whatever's currently selected (which a long-lived
 * session can outlive). The primary fix for the same bug is destroying
 * every live session on a switch (page-api/background.ts); this is the
 * backstop if one somehow survives that.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { isModelPromptGrantedForAgent } from '../harbor-core';
import { writeAgentBackendSetting } from '../agent-backend-setting';

const ORIGIN = 'https://example.test';

afterEach(() => {
  resetMockBrowser();
});

describe('isModelPromptGrantedForAgent', () => {
  it('is false with no grant at all', async () => {
    await expect(isModelPromptGrantedForAgent(ORIGIN, 'goose')).resolves.toBe(false);
  });

  it('is true once model:prompt is granted under that agent\'s own backend', async () => {
    const { grantPermissions } = await import('../../policy/permissions');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');

    await expect(isModelPromptGrantedForAgent(ORIGIN, 'goose')).resolves.toBe(true);
  });

  it('stays true for that agent even after the live selection moves to a different one', async () => {
    const { grantPermissions } = await import('../../policy/permissions');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');

    // The live selection moves on — a session still bound to goose must
    // not be judged against codex.
    await writeAgentBackendSetting({ type: 'acp', agentId: 'codex' });

    await expect(isModelPromptGrantedForAgent(ORIGIN, 'goose')).resolves.toBe(true);
    await expect(isModelPromptGrantedForAgent(ORIGIN, 'codex')).resolves.toBe(false);
  });

  it('is false once a deny is recorded, regardless of which agent is asked about', async () => {
    const { grantPermissions, denyPermissions } = await import('../../policy/permissions');
    await writeAgentBackendSetting({ type: 'acp', agentId: 'goose' });
    await grantPermissions(ORIGIN, ['model:prompt'], 'granted-always');
    await denyPermissions(ORIGIN, ['model:prompt']);

    await expect(isModelPromptGrantedForAgent(ORIGIN, 'goose')).resolves.toBe(false);
  });
});
