import { browserAPI } from '../browser-compat';
import {
  agentGatewayNativeAdminRequest,
  getConnectionState,
  onConnectionStateChange,
} from '../llm/native-bridge';
import {
  adaptNativeAgentGatewayClients,
  normalizeApprovalScopes,
  toApprovalScope,
  toGatewayScope,
  toRegistryClientMetadata,
  type AgentGatewayApprovalScope,
  type ApprovedAgentGatewayClientMetadata,
  type NativeAgentGatewayConfiguration,
  type NativeAgentGatewayPairing,
} from './approval';
import {
  approveSessionRequest,
  denySessionRequest,
  endSession,
  getAgentGatewayAuthoritySnapshot,
  invalidateGatewayAuthority,
  invalidatePairedClientAuthority,
  pauseSession,
  rebindSession,
  resumeSession,
  revokePairedClient,
  setGatewayEnabled,
  startSession,
  syncPairedClients,
  type AgentGatewayAuthoritySnapshot,
} from './registry';
import { sanitizeUrl } from './browser-adapter';
import type {
  AgentGatewaySession,
  AgentGatewaySessionRequest,
} from './types';

export interface AgentGatewaySelectableTab {
  tabId: number;
  windowId: number;
  title: string;
  origin: string;
  url: string;
  active: boolean;
}

export interface AgentGatewayUiState {
  enabled: boolean;
  clients: ApprovedAgentGatewayClientMetadata[];
  sessions: AgentGatewaySession[];
  sessionRequests: AgentGatewaySessionRequest[];
  tabs: AgentGatewaySelectableTab[];
  bridgeConnected: boolean;
}

export interface AgentGatewayPairResult {
  client: ApprovedAgentGatewayClientMetadata;
  secret: string;
}

export interface AgentGatewayControlPlaneDependencies {
  nativeAdminRequest: typeof agentGatewayNativeAdminRequest;
  getConnectionState: typeof getConnectionState;
  getAuthoritySnapshot: typeof getAgentGatewayAuthoritySnapshot;
  setGatewayEnabled: typeof setGatewayEnabled;
  syncPairedClients: typeof syncPairedClients;
  revokePairedClient: typeof revokePairedClient;
  invalidateGatewayAuthority: typeof invalidateGatewayAuthority;
  invalidatePairedClientAuthority: typeof invalidatePairedClientAuthority;
  startSession: typeof startSession;
  pauseSession: typeof pauseSession;
  rebindSession: typeof rebindSession;
  resumeSession: typeof resumeSession;
  endSession: typeof endSession;
  approveSessionRequest: typeof approveSessionRequest;
  denySessionRequest: typeof denySessionRequest;
  listTabs: () => Promise<chrome.tabs.Tab[]>;
}

const defaultDependencies: AgentGatewayControlPlaneDependencies = {
  nativeAdminRequest: agentGatewayNativeAdminRequest,
  getConnectionState,
  getAuthoritySnapshot: getAgentGatewayAuthoritySnapshot,
  setGatewayEnabled,
  syncPairedClients,
  revokePairedClient,
  invalidateGatewayAuthority,
  invalidatePairedClientAuthority,
  startSession,
  pauseSession,
  rebindSession,
  resumeSession,
  endSession,
  approveSessionRequest,
  denySessionRequest,
  listTabs: () => browserAPI.tabs.query({ currentWindow: true }),
};

export class AgentGatewayControlPlane {
  constructor(
    private readonly dependencies: AgentGatewayControlPlaneDependencies =
      defaultDependencies,
  ) {}

  async refresh(): Promise<AgentGatewayUiState> {
    const bridgeState = this.dependencies.getConnectionState();
    if (!bridgeState.connected || !bridgeState.bridgeReady) {
      throw new Error(bridgeState.error || 'Native bridge is unavailable');
    }

    const [nativeConfiguration, currentAuthority] = await Promise.all([
      this.dependencies.nativeAdminRequest<NativeAgentGatewayConfiguration>(
        'agent_gateway.get_config',
      ),
      this.dependencies.getAuthoritySnapshot(),
    ]);
    const scopeApprovals = new Map<string, AgentGatewayApprovalScope[]>(
      currentAuthority.pairedClients.map((client) => [
        client.clientId,
        client.scopes.map(toApprovalScope),
      ]),
    );
    const clients = adaptNativeAgentGatewayClients(
      nativeConfiguration.clients,
      scopeApprovals,
    );
    await this.dependencies.syncPairedClients(
      clients.map(toRegistryClientMetadata),
    );
    if (currentAuthority.configuration.enabled !== nativeConfiguration.enabled) {
      await this.dependencies.setGatewayEnabled(nativeConfiguration.enabled);
    }
    return this.buildState(clients);
  }

  async setEnabled(enabled: boolean): Promise<AgentGatewayUiState> {
    if (enabled) {
      await this.dependencies.nativeAdminRequest(
        'agent_gateway.set_enabled',
        { enabled: true },
      );
      return this.refresh();
    }

    this.dependencies.invalidateGatewayAuthority();
    try {
      await this.dependencies.setGatewayEnabled(false);
      await this.dependencies.nativeAdminRequest(
        'agent_gateway.set_enabled',
        { enabled: false },
      );
      const nativeConfiguration = await this.dependencies
        .nativeAdminRequest<NativeAgentGatewayConfiguration>(
          'agent_gateway.get_config',
        );
      if (nativeConfiguration.enabled) {
        throw new Error('Native bridge did not verify Agent Gateway disable');
      }
      return this.refresh();
    } catch (error) {
      this.dependencies.invalidateGatewayAuthority();
      await this.dependencies.setGatewayEnabled(false).catch(() => undefined);
      throw error;
    }
  }

  async pairClient(
    displayName: string,
    clientVersion: string | undefined,
    requestedScopes: readonly string[],
  ): Promise<AgentGatewayPairResult> {
    const normalizedDisplayName = displayName.trim();
    const scopes = normalizeApprovalScopes(requestedScopes);
    if (!normalizedDisplayName) {
      throw new Error('Agent name is required');
    }
    if (scopes.length === 0) {
      throw new Error('Select at least one read-only scope');
    }

    const pairing = await this.dependencies
      .nativeAdminRequest<NativeAgentGatewayPairing>(
        'agent_gateway.pair_client',
        {
          displayName: normalizedDisplayName,
          scopes,
          ...(clientVersion?.trim()
            ? { clientVersion: clientVersion.trim() }
            : {}),
        },
      );
    const client = adaptNativeAgentGatewayClients(
      [pairing.client],
      new Map([[pairing.client.id, scopes]]),
    )[0];

    try {
      const nativeConfiguration = await this.dependencies
        .nativeAdminRequest<NativeAgentGatewayConfiguration>(
          'agent_gateway.get_config',
        );
      const currentAuthority = await this.dependencies.getAuthoritySnapshot();
      const scopeApprovals = new Map<string, AgentGatewayApprovalScope[]>(
        currentAuthority.pairedClients.map((pairedClient) => [
          pairedClient.clientId,
          pairedClient.scopes.map(toApprovalScope),
        ]),
      );
      scopeApprovals.set(client.clientId, scopes);
      const synchronizedClients = adaptNativeAgentGatewayClients(
        nativeConfiguration.clients,
        scopeApprovals,
      );
      await this.dependencies.syncPairedClients(
        synchronizedClients.map(toRegistryClientMetadata),
      );
    } catch (error) {
      await this.dependencies.nativeAdminRequest(
        'agent_gateway.revoke_client',
        { clientId: client.clientId },
      ).catch(() => undefined);
      await this.dependencies.setGatewayEnabled(false);
      throw error;
    }

    return { client, secret: pairing.secret };
  }

  async revokeClient(clientId: string): Promise<AgentGatewayUiState> {
    this.dependencies.invalidatePairedClientAuthority(clientId);
    try {
      await this.dependencies.revokePairedClient(clientId);
      await this.dependencies.nativeAdminRequest(
        'agent_gateway.revoke_client',
        { clientId },
      );
      const nativeConfiguration = await this.dependencies
        .nativeAdminRequest<NativeAgentGatewayConfiguration>(
          'agent_gateway.get_config',
        );
      const revokedClient = nativeConfiguration.clients.find(
        (client) => client.id === clientId,
      );
      if (!revokedClient?.revoked) {
        throw new Error('Native bridge did not verify client revocation');
      }
      return this.refresh();
    } catch (error) {
      this.dependencies.invalidatePairedClientAuthority(clientId);
      await this.dependencies.revokePairedClient(clientId).catch(() => undefined);
      throw error;
    }
  }

  async startApprovedSession(input: {
    clientId: string;
    tabId: number;
    requestedScopes: readonly string[];
    ttlSeconds: number;
    requestId?: string;
  }): Promise<AgentGatewayUiState> {
    const state = await this.getLocalState();
    if (!state.enabled) {
      throw new Error('Enable Agent Gateway before starting a session');
    }
    const client = state.clients.find(
      (candidate) => candidate.clientId === input.clientId && !candidate.revokedAt,
    );
    if (!client) {
      throw new Error('Select a paired external agent');
    }
    const scopes = normalizeApprovalScopes(input.requestedScopes);
    if (scopes.length === 0) {
      throw new Error('Select at least one read-only scope');
    }
    if (scopes.some((scope) => !client.scopes.includes(scope))) {
      throw new Error('Session scope was not approved for this external agent');
    }
    const tab = state.tabs.find((candidate) => candidate.tabId === input.tabId);
    if (!tab) {
      throw new Error('Select a controllable HTTP(S) tab');
    }

    const pendingRequest = input.requestId
      ? state.sessionRequests.find(
          (request) =>
            request.requestId === input.requestId
            && request.clientId === input.clientId
            && request.status === 'pending',
        )
      : undefined;
    if (input.requestId && !pendingRequest) {
      throw new Error('External agent session request is no longer pending');
    }
    if (
      pendingRequest
      && (
        scopes.some((scope) => !pendingRequest.requestedScopes.includes(
          toGatewayScope(scope),
        ))
        || input.ttlSeconds > pendingRequest.requestedTtlSeconds
      )
    ) {
      throw new Error('Approved session must not exceed the external agent request');
    }

    const session = await this.dependencies.startSession({
      clientId: client.clientId,
      tabId: tab.tabId,
      origin: tab.origin,
      scopes: scopes.map(toGatewayScope),
      allowedOrigins: [tab.origin],
      ttlSeconds: input.ttlSeconds,
    });
    if (pendingRequest) {
      this.dependencies.approveSessionRequest(
        client.clientId,
        pendingRequest.requestId,
        session.sessionId,
      );
    }
    return this.getLocalState();
  }

  async denyPendingSessionRequest(
    clientId: string,
    requestId: string,
  ): Promise<AgentGatewayUiState> {
    this.dependencies.denySessionRequest(clientId, requestId);
    return this.getLocalState();
  }

  async approveTabBinding(input: {
    clientId: string;
    requestId: string;
    tabId: number;
  }): Promise<AgentGatewayUiState> {
    const state = await this.getLocalState();
    const request = state.sessionRequests.find(
      (candidate) =>
        candidate.requestId === input.requestId
        && candidate.clientId === input.clientId
        && candidate.kind === 'tab-bind'
        && candidate.status === 'pending',
    );
    if (!request?.sessionId) {
      throw new Error('External agent tab request is no longer pending');
    }
    const session = state.sessions.find(
      (candidate) =>
        candidate.sessionId === request.sessionId
        && candidate.clientId === input.clientId,
    );
    if (!session) {
      throw new Error('External agent session is no longer active');
    }
    const tab = state.tabs.find((candidate) => candidate.tabId === input.tabId);
    if (!tab) {
      throw new Error('Select a controllable HTTP(S) tab');
    }

    await this.dependencies.rebindSession(session.sessionId, tab.tabId, tab.origin);
    this.dependencies.approveSessionRequest(
      input.clientId,
      request.requestId,
      session.sessionId,
    );
    return this.getLocalState();
  }

  async pauseApprovedSession(sessionId: string): Promise<AgentGatewayUiState> {
    this.dependencies.pauseSession(sessionId);
    return this.getLocalState();
  }

  async resumeApprovedSession(sessionId: string): Promise<AgentGatewayUiState> {
    await this.dependencies.resumeSession(sessionId);
    return this.getLocalState();
  }

  async endApprovedSession(sessionId: string): Promise<AgentGatewayUiState> {
    this.dependencies.endSession(sessionId);
    return this.getLocalState();
  }

  async getLocalState(): Promise<AgentGatewayUiState> {
    const authority = await this.dependencies.getAuthoritySnapshot();
    const clients = authority.pairedClients.map((client) => ({
      clientId: client.clientId,
      displayName: client.displayName,
      pairedAt: client.pairedAt,
      ...(client.lastAuthenticatedAt
        ? { lastAuthenticatedAt: client.lastAuthenticatedAt }
        : {}),
      scopes: client.scopes.map(toApprovalScope),
      ...(client.revokedAt ? { revokedAt: client.revokedAt } : {}),
    }));
    return this.buildState(clients, authority);
  }

  private async buildState(
    clients: ApprovedAgentGatewayClientMetadata[],
    suppliedAuthority?: AgentGatewayAuthoritySnapshot,
  ): Promise<AgentGatewayUiState> {
    const [authority, tabs] = await Promise.all([
      suppliedAuthority
        ? Promise.resolve(suppliedAuthority)
        : this.dependencies.getAuthoritySnapshot(),
      this.dependencies.listTabs(),
    ]);
    return {
      enabled: authority.configuration.enabled,
      clients,
      sessions: authority.sessions,
      sessionRequests: authority.sessionRequests,
      tabs: tabs.flatMap(toSelectableTab),
      bridgeConnected: this.dependencies.getConnectionState().bridgeReady,
    };
  }
}

function toSelectableTab(tab: chrome.tabs.Tab): AgentGatewaySelectableTab[] {
  if (tab.id === undefined) {
    return [];
  }
  const url = sanitizeUrl(tab.url);
  if (!url) {
    return [];
  }
  return [{
    tabId: tab.id,
    windowId: tab.windowId,
    title: tab.title?.trim() || new URL(url).hostname,
    origin: new URL(url).origin,
    url,
    active: tab.active === true,
  }];
}

const controlPlane = new AgentGatewayControlPlane();
let runtimeHandlersInitialized = false;
let synchronizationInFlight: Promise<unknown> | null = null;

export function initializeAgentGatewayControlPlane(): void {
  if (runtimeHandlersInitialized) {
    return;
  }
  runtimeHandlersInitialized = true;
  browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedAgentGatewayUiSender(sender)) {
      return false;
    }
    const operation = handleAgentGatewayUiMessage(
      controlPlane,
      message as Record<string, unknown>,
    );
    if (!operation) {
      return false;
    }
    operation
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  });

  onConnectionStateChange((state) => {
    if (!state.bridgeReady || synchronizationInFlight) {
      return;
    }
    synchronizationInFlight = controlPlane
      .refresh()
      .catch(() => undefined)
      .finally(() => {
        synchronizationInFlight = null;
      });
  });
}

function handleAgentGatewayUiMessage(
  controller: AgentGatewayControlPlane,
  message: Record<string, unknown>,
): Promise<Record<string, unknown>> | null {
  switch (message.type) {
    case 'agent_gateway.ui.refresh':
      return controller.refresh().then((state) => ({ state }));
    case 'agent_gateway.ui.get_state':
      return controller.getLocalState().then((state) => ({ state }));
    case 'agent_gateway.ui.set_enabled':
      return controller.setEnabled(message.enabled === true)
        .then((state) => ({ state }));
    case 'agent_gateway.ui.pair':
      return controller.pairClient(
        typeof message.displayName === 'string' ? message.displayName : '',
        typeof message.clientVersion === 'string' ? message.clientVersion : undefined,
        Array.isArray(message.scopes) ? message.scopes : [],
      ).then(async (pairing) => ({
        pairing,
        state: await controller.getLocalState(),
      }));
    case 'agent_gateway.ui.revoke':
      return controller.revokeClient(String(message.clientId ?? ''))
        .then((state) => ({ state }));
    case 'agent_gateway.ui.start_session':
      return controller.startApprovedSession({
        clientId: String(message.clientId ?? ''),
        tabId: Number(message.tabId),
        requestedScopes: Array.isArray(message.scopes) ? message.scopes : [],
        ttlSeconds: Number(message.ttlSeconds),
        ...(typeof message.requestId === 'string'
          ? { requestId: message.requestId }
          : {}),
      }).then((state) => ({ state }));
    case 'agent_gateway.ui.deny_session_request':
      return controller.denyPendingSessionRequest(
        String(message.clientId ?? ''),
        String(message.requestId ?? ''),
      ).then((state) => ({ state }));
    case 'agent_gateway.ui.approve_tab_binding':
      return controller.approveTabBinding({
        clientId: String(message.clientId ?? ''),
        requestId: String(message.requestId ?? ''),
        tabId: Number(message.tabId),
      }).then((state) => ({ state }));
    case 'agent_gateway.ui.pause_session':
      return controller.pauseApprovedSession(String(message.sessionId ?? ''))
        .then((state) => ({ state }));
    case 'agent_gateway.ui.resume_session':
      return controller.resumeApprovedSession(String(message.sessionId ?? ''))
        .then((state) => ({ state }));
    case 'agent_gateway.ui.end_session':
      return controller.endApprovedSession(String(message.sessionId ?? ''))
        .then((state) => ({ state }));
    default:
      return null;
  }
}

export function isTrustedAgentGatewayUiSender(
  sender: Pick<chrome.runtime.MessageSender, 'id' | 'url'>,
): boolean {
  return sender.id === browserAPI.runtime.id
    && sender.url === browserAPI.runtime.getURL('sidebar.html');
}

export const agentGatewayControlPlaneTesting = {
  handleAgentGatewayUiMessage,
  toSelectableTab,
};
