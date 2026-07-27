import { describe, expect, it, vi } from 'vitest';
import type {
  ChatIntent,
  PermissionDecision,
  SourceTabLaunchEnvelope,
  SourceTabReference,
} from '../../contracts';
import type {
  ChatPermissionPort,
  SourceTabPort,
} from '../../services';
import { createConsentContextCoordinator } from './consent-context-coordinator';

const source: SourceTabReference = {
  tabId: 41,
  windowId: 7,
  url: 'https://example.com/article',
  title: 'Example article',
  origin: 'https://example.com',
};

const envelope: SourceTabLaunchEnvelope = {
  version: 1,
  launchId: 'launch-123',
  source,
  createdAt: 1_000,
  expiresAt: 10_000,
};

const sourceIntent: ChatIntent = {
  context: {
    mode: 'source',
    preview: {
      title: source.title,
      origin: source.origin,
    },
  },
  tools: { mode: 'off' },
};

function createPermissionPort(options: {
  current?: Awaited<ReturnType<ChatPermissionPort['list']>>;
  decision?: PermissionDecision;
} = {}): ChatPermissionPort {
  return {
    list: vi.fn<ChatPermissionPort['list']>().mockResolvedValue(
      options.current ?? {},
    ),
    request: vi.fn<ChatPermissionPort['request']>().mockResolvedValue(
      options.decision ?? {
        kind: 'granted',
        scopes: [
          'model:prompt',
          'browser:activeTab.read',
        ],
      },
    ),
  };
}

function createSourceTabPort(): SourceTabPort {
  return {
    resolveLaunch: vi.fn<SourceTabPort['resolveLaunch']>()
      .mockResolvedValue(envelope),
    inspect: vi.fn<SourceTabPort['inspect']>()
      .mockResolvedValue(source),
    capture: vi.fn<SourceTabPort['capture']>().mockResolvedValue({
      title: source.title,
      url: source.url,
      text: 'Approved content',
      capturedAt: 3_000,
    }),
  };
}

describe('consent context coordinator', () => {
  it('captures source content only after intent permission succeeds', async () => {
    const sourceTabPort = createSourceTabPort();
    const coordinator = createConsentContextCoordinator({
      launchId: 'launch-123',
      permissionPort: createPermissionPort(),
      sourceTabPort,
      now: () => 2_000,
    });

    await expect(coordinator.approveIntent(sourceIntent)).resolves.toEqual({
      kind: 'approved',
      approval: {
        intent: sourceIntent,
        scopes: [
          'model:prompt',
          'browser:activeTab.read',
        ],
        context: {
          title: source.title,
          url: source.url,
          text: 'Approved content',
          capturedAt: 3_000,
        },
      },
    });
    expect(sourceTabPort.capture).toHaveBeenCalledTimes(1);
  });

  it('falls back to ordinary chat after page permission denial', async () => {
    const sourceTabPort = createSourceTabPort();
    const coordinator = createConsentContextCoordinator({
      launchId: 'launch-123',
      permissionPort: createPermissionPort({
        current: {
          'model:prompt': 'granted',
          'browser:activeTab.read': 'denied',
        },
      }),
      sourceTabPort,
      now: () => 2_000,
    });

    await expect(coordinator.approveIntent(sourceIntent)).resolves.toEqual({
      kind: 'fallback',
      approval: {
        intent: {
          context: { mode: 'off' },
          tools: { mode: 'off' },
        },
        scopes: ['model:prompt'],
      },
      omitted: ['context'],
      cause: 'denied',
    });
    expect(sourceTabPort.capture).not.toHaveBeenCalled();
  });

  it('falls back without prompting for page access when the source navigated', async () => {
    const sourceTabPort = createSourceTabPort();
    vi.mocked(sourceTabPort.inspect).mockResolvedValue({
      ...source,
      url: 'https://example.com/other',
    });
    const permissionPort = createPermissionPort({
      decision: {
        kind: 'granted',
        scopes: ['model:prompt'],
      },
    });
    const coordinator = createConsentContextCoordinator({
      launchId: 'launch-123',
      permissionPort,
      sourceTabPort,
      now: () => 2_000,
    });

    await expect(coordinator.approveIntent(sourceIntent)).resolves.toEqual({
      kind: 'fallback',
      approval: {
        intent: {
          context: { mode: 'off' },
          tools: { mode: 'off' },
        },
        scopes: ['model:prompt'],
      },
      omitted: ['context'],
      cause: 'stale',
    });
    expect(permissionPort.request).toHaveBeenCalledWith({
      scopes: ['model:prompt'],
      reason: 'Answer this message with the selected model',
      toolAllowlist: [],
    });
    expect(sourceTabPort.capture).not.toHaveBeenCalled();
  });

  it('keeps dismissal distinct when no model access is already granted', async () => {
    const coordinator = createConsentContextCoordinator({
      launchId: 'launch-123',
      permissionPort: createPermissionPort({
        decision: { kind: 'dismissed' },
      }),
      sourceTabPort: createSourceTabPort(),
      now: () => 2_000,
    });

    await expect(coordinator.approveIntent(sourceIntent)).resolves.toEqual({
      kind: 'dismissed',
    });
  });
});
