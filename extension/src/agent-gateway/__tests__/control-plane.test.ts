import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentGatewayControlPlane,
  isTrustedAgentGatewayUiSender,
  type AgentGatewayControlPlaneDependencies,
} from '../control-plane';
import type { AgentGatewayAuthoritySnapshot } from '../registry';
import type { NativeAgentGatewayConfiguration } from '../approval';
import type { AgentGatewaySession } from '../types';
import { rpcRequest } from '../../llm/native-bridge';

const CLIENT_ID = 'client_1';
const NATIVE_CLIENT = {
  id: CLIENT_ID,
  displayName: 'Research Agent',
  createdAt: '2026-07-25T12:00:00.000Z',
  revoked: false,
};

function authoritySnapshot(
  overrides: Partial<AgentGatewayAuthoritySnapshot> = {},
): AgentGatewayAuthoritySnapshot {
  return {
    configuration: {
      enabled: true,
      defaultSessionTtlSeconds: 900,
      maxSessionTtlSeconds: 3600,
      maxConcurrentCallsPerSession: 4,
      maxTabs: 100,
      maxTabTitleBytes: 512,
      maxTabUrlBytes: 4096,
      maxTabsResultBytes: 131072,
      maxReadableTextBytes: 200000,
      maxElements: 200,
    },
    pairedClients: [{
      clientId: CLIENT_ID,
      displayName: 'Research Agent',
      principal: `agent-gateway:${CLIENT_ID}`,
      scopes: ['gateway:tabs.read', 'gateway:page.read'],
      pairedAt: NATIVE_CLIENT.createdAt,
    }],
    sessions: [],
    ...overrides,
  };
}

function createDependencies(
  initialSnapshot = authoritySnapshot(),
): AgentGatewayControlPlaneDependencies {
  let snapshot = initialSnapshot;
  return {
    nativeAdminRequest: vi.fn(async (method: string) => {
      if (method === 'agent_gateway.pair_client') {
        return {
          client: NATIVE_CLIENT,
          secret: 'harbor_one_time_secret',
        };
      }
      return {
        enabled: true,
        clients: [NATIVE_CLIENT],
      } satisfies NativeAgentGatewayConfiguration;
    }) as AgentGatewayControlPlaneDependencies['nativeAdminRequest'],
    getConnectionState: vi.fn(() => ({
      connected: true,
      bridgeReady: true,
      error: null,
    })),
    getAuthoritySnapshot: vi.fn(async () => snapshot),
    setGatewayEnabled: vi.fn(async (enabled: boolean) => {
      snapshot = {
        ...snapshot,
        configuration: { ...snapshot.configuration, enabled },
      };
    }),
    syncPairedClients: vi.fn(async () => undefined),
    revokePairedClient: vi.fn(async (clientId: string) => {
      snapshot = {
        ...snapshot,
        pairedClients: snapshot.pairedClients.map((client) =>
          client.clientId === clientId
            ? { ...client, revokedAt: '2026-07-25T12:01:00.000Z' }
            : client,
        ),
        sessions: snapshot.sessions.filter(
          (session) => session.clientId !== clientId,
        ),
      };
    }),
    invalidateGatewayAuthority: vi.fn(() => {
      snapshot = {
        ...snapshot,
        configuration: { ...snapshot.configuration, enabled: false },
        sessions: [],
      };
    }),
    invalidatePairedClientAuthority: vi.fn((clientId: string) => {
      snapshot = {
        ...snapshot,
        pairedClients: snapshot.pairedClients.map((client) =>
          client.clientId === clientId
            ? { ...client, revokedAt: '2026-07-25T12:01:00.000Z' }
            : client,
        ),
        sessions: snapshot.sessions.filter(
          (session) => session.clientId !== clientId,
        ),
      };
    }),
    startSession: vi.fn(async () => ({
      sessionId: 'session_1',
      clientId: CLIENT_ID,
      principal: `agent-gateway:${CLIENT_ID}`,
      tabId: 42,
      documentId: 'document_1',
      documentFingerprint: 'fingerprint_1',
      origin: 'https://example.com',
      scopes: ['gateway:page.read'],
      allowedOrigins: ['https://example.com'],
      createdAt: '2026-07-25T12:00:00.000Z',
      expiresAt: '2026-07-25T12:15:00.000Z',
      paused: false,
      snapshotSequence: 0,
    } satisfies AgentGatewaySession)),
    pauseSession: vi.fn(),
    resumeSession: vi.fn(async () => {
      throw new Error('not used');
    }),
    endSession: vi.fn(),
    listTabs: vi.fn(async () => [{
      id: 42,
      index: 0,
      windowId: 1,
      highlighted: true,
      active: true,
      pinned: false,
      incognito: false,
      selected: true,
      discarded: false,
      autoDiscardable: true,
      groupId: -1,
      title: 'Example',
      url: 'https://example.com/path?token=secret',
    } as chrome.tabs.Tab]),
  };
}

describe('Agent Gateway control plane', () => {
  let dependencies: AgentGatewayControlPlaneDependencies;
  let controlPlane: AgentGatewayControlPlane;

  beforeEach(() => {
    dependencies = createDependencies();
    controlPlane = new AgentGatewayControlPlane(dependencies);
  });

  it('never passes the one-time pairing secret into extension persistence', async () => {
    const pairing = await controlPlane.pairClient(
      'Research Agent',
      '1.2.0',
      ['page:observe'],
    );

    expect(pairing.secret).toBe('harbor_one_time_secret');
    expect(JSON.stringify(
      vi.mocked(dependencies.syncPairedClients).mock.calls,
    )).not.toContain('harbor_one_time_secret');
    expect(vi.mocked(dependencies.syncPairedClients)).toHaveBeenCalledWith([
      expect.objectContaining({
        clientId: CLIENT_ID,
        scopes: ['gateway:page.read'],
      }),
    ]);
  });

  it('requires an explicit read-only scope before native pairing', async () => {
    await expect(
      controlPlane.pairClient('Research Agent', undefined, []),
    ).rejects.toThrow('Select at least one read-only scope');

    expect(dependencies.nativeAdminRequest).not.toHaveBeenCalled();
  });

  it('preserves local authority when native status refresh fails', async () => {
    vi.mocked(dependencies.nativeAdminRequest).mockRejectedValueOnce(
      new Error('Bridge unavailable'),
    );

    await expect(controlPlane.refresh()).rejects.toThrow('Bridge unavailable');
    expect(dependencies.setGatewayEnabled).not.toHaveBeenCalled();
    expect(dependencies.syncPairedClients).not.toHaveBeenCalled();
  });

  it('does not clear an active session during a matching authority refresh', async () => {
    const activeSession: AgentGatewaySession = {
      sessionId: 'session_1',
      clientId: CLIENT_ID,
      principal: `agent-gateway:${CLIENT_ID}`,
      tabId: 42,
      documentId: 'document_1',
      documentFingerprint: 'fingerprint_1',
      origin: 'https://example.com',
      scopes: ['gateway:page.read'],
      allowedOrigins: ['https://example.com'],
      createdAt: '2026-07-25T12:00:00.000Z',
      expiresAt: '2099-07-25T12:15:00.000Z',
      paused: false,
      snapshotSequence: 0,
    };
    dependencies = createDependencies(authoritySnapshot({
      sessions: [activeSession],
    }));
    controlPlane = new AgentGatewayControlPlane(dependencies);

    const state = await controlPlane.refresh();

    expect(dependencies.setGatewayEnabled).not.toHaveBeenCalled();
    expect(state.sessions).toEqual([activeSession]);
  });

  it('disables local authority only when native authority is disabled', async () => {
    vi.mocked(dependencies.nativeAdminRequest).mockResolvedValueOnce({
      enabled: false,
      clients: [NATIVE_CLIENT],
    });

    await controlPlane.refresh();

    expect(dependencies.setGatewayEnabled).toHaveBeenCalledWith(false);
  });

  it('invalidates extension authority before native revocation verification', async () => {
    const callOrder: string[] = [];
    vi.mocked(dependencies.invalidatePairedClientAuthority)
      .mockImplementationOnce(() => {
        callOrder.push('invalidate-extension');
      });
    vi.mocked(dependencies.nativeAdminRequest)
      .mockImplementationOnce(async () => {
        callOrder.push('revoke-native');
        return { clientId: CLIENT_ID, revoked: true };
      })
      .mockResolvedValueOnce({
        enabled: true,
        clients: [NATIVE_CLIENT],
      });

    await expect(controlPlane.revokeClient(CLIENT_ID))
      .rejects.toThrow('did not verify client revocation');
    expect(callOrder).toEqual(['invalidate-extension', 'revoke-native']);
    expect(dependencies.revokePairedClient).toHaveBeenCalledWith(CLIENT_ID);
    expect(dependencies.invalidatePairedClientAuthority)
      .toHaveBeenCalledWith(CLIENT_ID);
  });

  it('retains fail-closed extension state when native revoke fails', async () => {
    vi.mocked(dependencies.nativeAdminRequest).mockRejectedValueOnce(
      new Error('Native revoke failed'),
    );

    await expect(controlPlane.revokeClient(CLIENT_ID))
      .rejects.toThrow('Native revoke failed');

    expect(dependencies.invalidatePairedClientAuthority)
      .toHaveBeenCalledWith(CLIENT_ID);
    expect(dependencies.revokePairedClient).toHaveBeenCalledWith(CLIENT_ID);
    expect((await dependencies.getAuthoritySnapshot()).sessions).toEqual([]);
  });

  it('invalidates extension sessions before native disable and stays disabled on failure', async () => {
    const callOrder: string[] = [];
    vi.mocked(dependencies.invalidateGatewayAuthority)
      .mockImplementationOnce(() => {
        callOrder.push('invalidate-extension');
      });
    vi.mocked(dependencies.nativeAdminRequest).mockImplementationOnce(
      async () => {
        callOrder.push('disable-native');
        throw new Error('Native disable failed');
      },
    );

    await expect(controlPlane.setEnabled(false))
      .rejects.toThrow('Native disable failed');

    expect(callOrder).toEqual(['invalidate-extension', 'disable-native']);
    expect(dependencies.setGatewayEnabled).toHaveBeenCalledWith(false);
    expect((await dependencies.getAuthoritySnapshot()).configuration.enabled)
      .toBe(false);
  });

  it('starts, pauses, resumes, and ends only an explicitly scoped tab session', async () => {
    await controlPlane.startApprovedSession({
      clientId: CLIENT_ID,
      tabId: 42,
      requestedScopes: ['page:observe'],
      ttlSeconds: 900,
    });
    await controlPlane.pauseApprovedSession('session_1');
    vi.mocked(dependencies.resumeSession).mockResolvedValueOnce(
      authoritySnapshot().sessions[0]!,
    );
    await controlPlane.resumeApprovedSession('session_1');
    await controlPlane.endApprovedSession('session_1');

    expect(dependencies.startSession).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      tabId: 42,
      origin: 'https://example.com',
      scopes: ['gateway:page.read'],
      allowedOrigins: ['https://example.com'],
      ttlSeconds: 900,
    });
    expect(dependencies.pauseSession).toHaveBeenCalledWith('session_1');
    expect(dependencies.resumeSession).toHaveBeenCalledWith('session_1');
    expect(dependencies.endSession).toHaveBeenCalledWith('session_1');
  });

  it('does not accept external pages as gateway administrators', () => {
    expect(isTrustedAgentGatewayUiSender({
      id: 'harbor-test',
      url: 'https://example.com/',
    })).toBe(false);
    expect(isTrustedAgentGatewayUiSender({
      id: 'other-extension',
      url: 'chrome-extension://harbor-test/sidebar.html',
    })).toBe(false);
    expect(isTrustedAgentGatewayUiSender({
      id: 'harbor-test',
      url: 'chrome-extension://harbor-test/sidebar.html',
    })).toBe(true);
  });

  it('blocks gateway administration through the generic bridge RPC path', async () => {
    await expect(
      rpcRequest('agent_gateway.set_enabled', { enabled: true }),
    ).rejects.toThrow('dedicated control plane');
  });
});
