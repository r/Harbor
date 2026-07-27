import { describe, expect, it, vi } from 'vitest';
import {
  GatewayActionGate,
  GatewayOneTimeSecret,
  canPairGatewayAgent,
  canStartGatewaySession,
  createGatewayRevokeMessage,
  createGatewaySessionActionMessage,
  defaultGatewayTabId,
  deriveGatewayView,
  deriveGatewayActionPresentation,
  focusGatewayElement,
  gatewayCredentialCopyFailureMessage,
  gatewayLastAuthenticatedLabel,
  gatewayFocusTargetAfterSessionAction,
  gatewayFocusTargetAfterTransition,
  gatewayStatusClass,
  isGatewayRegionBusy,
  runWithGatewayAction,
  setGatewayControlsDisabled,
} from '../sidebar-controller';
import type { AgentGatewayUiState } from '../control-plane';
import type { AgentGatewaySession } from '../types';

function gatewayState(
  overrides: Partial<AgentGatewayUiState> = {},
): AgentGatewayUiState {
  return {
    enabled: false,
    bridgeConnected: true,
    clients: [],
    sessions: [],
    sessionRequests: [],
    tabs: [],
    ...overrides,
  };
}

describe('Agent Gateway sidebar controller', () => {
  it('shows the pairing secret once and clears it only after acknowledgement', () => {
    const secret = new GatewayOneTimeSecret();

    secret.reveal('client_1', 'harbor_one_time_secret');
    expect(secret.isVisible()).toBe(true);
    expect(secret.clientIdForCopy()).toBe('client_1');
    expect(secret.valueForCopy()).toBe('harbor_one_time_secret');
    expect(secret.finish()).toBe(false);

    secret.acknowledge(true);
    expect(secret.canFinish()).toBe(true);
    expect(secret.finish()).toBe(true);
    expect(secret.isVisible()).toBe(false);
    expect(secret.clientIdForCopy()).toBe('');
    expect(secret.valueForCopy()).toBe('');
    expect(JSON.stringify(gatewayState())).not.toContain('harbor_one_time_secret');
  });

  it('keeps loading, disconnected, disabled, and enabled views exclusive', () => {
    const views = [
      deriveGatewayView(null, true),
      deriveGatewayView(null, false),
      deriveGatewayView(gatewayState(), false),
      deriveGatewayView(gatewayState({ enabled: true }), false),
    ];

    expect(views.map((view) => [
      view.showLoading,
      view.showDisconnected,
      view.showDisabled,
      view.showEnabled,
    ])).toEqual([
      [true, false, false, false],
      [false, true, false, false],
      [false, false, true, false],
      [false, false, false, true],
    ]);
    for (const view of views) {
      expect([
        view.showLoading,
        view.showDisconnected,
        view.showDisabled,
        view.showEnabled,
      ].filter(Boolean)).toHaveLength(1);
    }
  });

  it('restores action availability after a rejected operation', async () => {
    const gate = new GatewayActionGate();
    const operation = runWithGatewayAction(
      gate,
      'pause',
      async () => {
        expect(gate.isBusy()).toBe(true);
        expect(gate.begin('revoke')).toBe(false);
        throw new Error('Native bridge failed');
      },
    );

    await expect(operation).rejects.toThrow('Native bridge failed');
    expect(gate.isBusy()).toBe(false);
    expect(gate.currentAction()).toBeNull();
    expect(gate.begin('revoke')).toBe(true);
  });

  it('routes pause, resume, end, and revoke to distinct authority operations', () => {
    expect(createGatewaySessionActionMessage('pause', 'session_1')).toEqual({
      type: 'agent_gateway.ui.pause_session',
      sessionId: 'session_1',
    });
    expect(createGatewaySessionActionMessage('resume', 'session_1')).toEqual({
      type: 'agent_gateway.ui.resume_session',
      sessionId: 'session_1',
    });
    expect(createGatewaySessionActionMessage('end', 'session_1')).toEqual({
      type: 'agent_gateway.ui.end_session',
      sessionId: 'session_1',
    });
    expect(createGatewayRevokeMessage('client_1')).toEqual({
      type: 'agent_gateway.ui.revoke',
      clientId: 'client_1',
    });
  });

  it('uses healthy and pending status colors without treating them as errors', () => {
    expect(gatewayStatusClass('Active', false)).toBe('connected');
    expect(gatewayStatusClass('Enabled', false)).toBe('connecting');
    expect(gatewayStatusClass('Paired', false)).toBe('connecting');
    expect(gatewayStatusClass('Disabled', false)).toBe('idle');
    expect(gatewayStatusClass('Disconnected', false)).toBe('disconnected');
    expect(gatewayStatusClass('Active', true)).toBe('connecting');
  });

  it('selects exactly one active target and keeps duplicate tabs unambiguous', () => {
    const tabs: AgentGatewayUiState['tabs'] = [
      {
        tabId: 11,
        windowId: 7,
        title: 'Example',
        origin: 'https://example.com',
        url: 'https://example.com/a',
        active: true,
      },
      {
        tabId: 12,
        windowId: 7,
        title: 'Example',
        origin: 'https://example.com',
        url: 'https://example.com/b',
        active: false,
      },
      {
        tabId: 21,
        windowId: 8,
        title: 'Example',
        origin: 'https://example.com',
        url: 'https://example.com/c',
        active: true,
      },
    ];

    expect(defaultGatewayTabId(tabs)).toBe(11);
  });

  it('provides concrete pending labels and deterministic focus restoration', () => {
    expect(deriveGatewayActionPresentation('pause')).toEqual({
      status: 'Pausing...',
      sessionLabel: 'Pausing...',
      revokeLabel: null,
    });
    expect(deriveGatewayActionPresentation('resume').sessionLabel).toBe('Resuming...');
    expect(deriveGatewayActionPresentation('end').status).toBe('Ending...');
    expect(deriveGatewayActionPresentation('revoke').revokeLabel).toBe('Revoking...');

    expect(gatewayFocusTargetAfterSessionAction(
      'pause',
      true,
      'gateway-pause-active',
    )).toBe('gateway-resume-active');
    expect(gatewayFocusTargetAfterSessionAction(
      'resume',
      true,
      'gateway-resume-active',
    )).toBe('gateway-pause-active');
    expect(gatewayFocusTargetAfterSessionAction(
      'end',
      true,
      'gateway-end-active',
    )).toBe('gateway-start-session');
    expect(gatewayFocusTargetAfterSessionAction(
      'pause',
      false,
      'gateway-pause-active',
    )).toBe('gateway-pause-active');
    expect(gatewayFocusTargetAfterTransition('pair-cancel')).toBe(
      'gateway-show-pair',
    );
    expect(gatewayFocusTargetAfterTransition('pair-success')).toBe(
      'gateway-copy-client-id',
    );
    expect(gatewayFocusTargetAfterTransition('pair-finish')).toBe(
      'gateway-show-pair',
    );
    expect(gatewayFocusTargetAfterTransition('start-success')).toBe(
      'gateway-pause-active',
    );
    expect(gatewayFocusTargetAfterTransition('disable-success')).toBe(
      'gateway-enable',
    );

    const focus = vi.fn();
    const documentRoot = {
      getElementById: vi.fn(() => ({ focus })),
    } as unknown as Pick<Document, 'getElementById'>;
    expect(focusGatewayElement(
      documentRoot,
      'gateway-resume-active',
    )).toBe(true);
    expect(documentRoot.getElementById).toHaveBeenCalledWith(
      'gateway-resume-active',
    );
    expect(focus).toHaveBeenCalledOnce();
  });

  it('applies and restores disabled state across action controls', () => {
    const pauseButton = { disabled: false };
    const endButton = { disabled: false };
    const revokeButton = { disabled: false };
    const controls = [pauseButton, endButton, revokeButton];

    setGatewayControlsDisabled(controls, true);
    expect(controls.every((control) => control.disabled)).toBe(true);

    setGatewayControlsDisabled(controls, false);
    expect(controls.every((control) => !control.disabled)).toBe(true);
  });

  it('gates pairing and session approval on complete valid input', () => {
    expect(canPairGatewayAgent('', ['tabs:list'])).toBe(false);
    expect(canPairGatewayAgent('   ', ['tabs:list'])).toBe(false);
    expect(canPairGatewayAgent('Research Agent', [])).toBe(false);
    expect(canPairGatewayAgent('Research Agent', ['tabs:list'])).toBe(true);

    expect(canStartGatewaySession({
      clientId: 'client_1',
      tabId: '42',
      scopes: ['page:observe'],
      ttlSeconds: 900,
    })).toBe(true);
    expect(canStartGatewaySession({
      clientId: 'client_1',
      tabId: '42',
      scopes: [],
      ttlSeconds: 900,
    })).toBe(false);
    expect(canStartGatewaySession({
      clientId: 'client_1',
      tabId: '',
      scopes: ['page:observe'],
      ttlSeconds: 900,
    })).toBe(false);
    expect(canStartGatewaySession({
      clientId: 'client_1',
      tabId: '42',
      scopes: ['page:observe'],
      ttlSeconds: Number.NaN,
    })).toBe(false);
  });

  it('announces busy state while loading or running an action', () => {
    expect(isGatewayRegionBusy(true, null)).toBe(true);
    expect(isGatewayRegionBusy(false, 'pair')).toBe(true);
    expect(isGatewayRegionBusy(false, null)).toBe(false);
  });

  it('reports which one-time credential could not be copied', () => {
    expect(gatewayCredentialCopyFailureMessage('client-id')).toBe(
      'Could not copy the client ID',
    );
    expect(gatewayCredentialCopyFailureMessage('secret')).toBe(
      'Could not copy the one-time secret',
    );
  });

  it('distinguishes pairing from an authenticated client connection', () => {
    const now = Date.parse('2026-07-26T12:10:00.000Z');

    expect(gatewayLastAuthenticatedLabel(undefined, now)).toBe(
      'Not connected yet',
    );
    expect(gatewayLastAuthenticatedLabel(
      '2026-07-26T12:09:30.000Z',
      now,
    )).toBe('Authenticated just now');
    expect(gatewayLastAuthenticatedLabel(
      '2026-07-26T12:05:00.000Z',
      now,
    )).toBe('Authenticated 5 min ago');
  });

  it('derives active, paused, and expired session status independently', () => {
    const baseSession: AgentGatewaySession = {
      sessionId: 'session_1',
      clientId: 'client_1',
      principal: 'agent-gateway:client_1',
      tabId: 42,
      documentId: 'document_1',
      documentFingerprint: 'fingerprint_1',
      origin: 'https://example.com',
      scopes: ['gateway:page.read'],
      allowedOrigins: ['https://example.com'],
      createdAt: '2026-07-25T12:00:00.000Z',
      expiresAt: '2026-07-25T13:00:00.000Z',
      paused: false,
      snapshotSequence: 0,
    };

    expect(deriveGatewayView(
      gatewayState({ enabled: true, sessions: [baseSession] }),
      false,
      Date.parse('2026-07-25T12:30:00.000Z'),
    ).status).toBe('Active');
    expect(deriveGatewayView(
      gatewayState({
        enabled: true,
        sessions: [{ ...baseSession, paused: true }],
      }),
      false,
      Date.parse('2026-07-25T12:30:00.000Z'),
    ).status).toBe('Paused');
    expect(deriveGatewayView(
      gatewayState({ enabled: true, sessions: [baseSession] }),
      false,
      Date.parse('2026-07-25T13:00:00.000Z'),
    ).status).toBe('Expired');
  });
});
