import { describe, expect, it, vi } from 'vitest';
import type { ChatIntent, PermissionDecision } from '../../contracts';
import type { ChatPermissionPort } from '../../services';
import { requestIntentPermissions } from './permission-coordinator';

const ordinaryIntent: ChatIntent = {
  context: { mode: 'off' },
  tools: { mode: 'off' },
};

const sourceIntent: ChatIntent = {
  context: {
    mode: 'source',
    preview: {
      title: 'Article',
      origin: 'https://example.com',
    },
  },
  tools: { mode: 'off' },
};

function createPermissionPort(options: {
  current?: Awaited<ReturnType<ChatPermissionPort['list']>>;
  decision?: PermissionDecision;
} = {}): ChatPermissionPort & {
  list: ReturnType<typeof vi.fn<ChatPermissionPort['list']>>;
  request: ReturnType<typeof vi.fn<ChatPermissionPort['request']>>;
} {
  return {
    list: vi.fn<ChatPermissionPort['list']>().mockResolvedValue(
      options.current ?? {},
    ),
    request: vi.fn<ChatPermissionPort['request']>().mockResolvedValue(
      options.decision ?? {
        kind: 'granted',
        scopes: ['model:prompt'],
      },
    ),
  };
}

describe('permission coordinator', () => {
  it('does not prompt when every ordinary-chat scope is granted', async () => {
    const permissionPort = createPermissionPort({
      current: {
        'model:prompt': 'granted',
      },
    });

    await expect(
      requestIntentPermissions(ordinaryIntent, permissionPort),
    ).resolves.toEqual({
      kind: 'granted',
      scopes: ['model:prompt'],
    });
    expect(permissionPort.request).not.toHaveBeenCalled();
  });

  it('requests only scopes missing at the moment of user intent', async () => {
    const permissionPort = createPermissionPort({
      current: {
        'model:prompt': 'granted',
      },
      decision: {
        kind: 'granted',
        scopes: ['browser:activeTab.read'],
      },
    });

    await expect(
      requestIntentPermissions(sourceIntent, permissionPort),
    ).resolves.toEqual({
      kind: 'granted',
      scopes: [
        'model:prompt',
        'browser:activeTab.read',
      ],
    });
    expect(permissionPort.request).toHaveBeenCalledWith({
      scopes: ['browser:activeTab.read'],
      reason: 'Answer using the approved page',
      toolAllowlist: [],
    });
  });

  it('does not automatically re-prompt an explicitly denied scope', async () => {
    const permissionPort = createPermissionPort({
      current: {
        'model:prompt': 'granted',
        'browser:activeTab.read': 'denied',
      },
    });

    await expect(
      requestIntentPermissions(sourceIntent, permissionPort),
    ).resolves.toEqual({
      kind: 'partial',
      granted: ['model:prompt'],
      denied: ['browser:activeTab.read'],
    });
    expect(permissionPort.request).not.toHaveBeenCalled();
  });

  it('preserves already granted scopes when the user dismisses', async () => {
    const permissionPort = createPermissionPort({
      current: {
        'model:prompt': 'granted',
      },
      decision: {
        kind: 'dismissed',
      },
    });

    await expect(
      requestIntentPermissions(sourceIntent, permissionPort),
    ).resolves.toEqual({
      kind: 'dismissed',
      granted: ['model:prompt'],
    });
  });

  it('verifies a selected tool allowlist even when scopes are granted', async () => {
    const toolIntent: ChatIntent = {
      context: { mode: 'off' },
      tools: {
        mode: 'approved',
        toolNames: ['search/query'],
      },
    };
    const permissionPort = createPermissionPort({
      current: {
        'model:prompt': 'granted',
        'model:tools': 'granted',
        'mcp:tools.list': 'granted',
        'mcp:tools.call': 'granted',
      },
      decision: {
        kind: 'granted',
        scopes: ['mcp:tools.call'],
      },
    });

    await requestIntentPermissions(toolIntent, permissionPort);

    expect(permissionPort.request).toHaveBeenCalledWith({
      scopes: ['mcp:tools.call'],
      reason: 'Answer using the selected tools',
      toolAllowlist: ['search/query'],
    });
  });
});
