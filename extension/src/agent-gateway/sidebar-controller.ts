import { browserAPI } from '../browser-compat';
import type {
  AgentGatewayPairResult,
  AgentGatewayUiState,
} from './control-plane';
import type { AgentGatewayApprovalScope } from './approval';

type GatewayUiResponse = {
  ok?: boolean;
  state?: AgentGatewayUiState;
  pairing?: AgentGatewayPairResult;
  error?: string;
};

export type GatewayUiAction =
  | 'refresh'
  | 'enable'
  | 'disable'
  | 'pair'
  | 'start'
  | 'deny'
  | 'pause'
  | 'resume'
  | 'end'
  | 'revoke';

export class GatewayOneTimeSecret {
  private clientId: string | null = null;
  private secret: string | null = null;
  private acknowledged = false;

  reveal(clientId: string, secret: string): void {
    this.clientId = clientId;
    this.secret = secret;
    this.acknowledged = false;
  }

  acknowledge(acknowledged: boolean): void {
    this.acknowledged = this.secret !== null && acknowledged;
  }

  isVisible(): boolean {
    return this.secret !== null;
  }

  canFinish(): boolean {
    return this.secret !== null && this.acknowledged;
  }

  valueForCopy(): string {
    return this.secret ?? '';
  }

  clientIdForCopy(): string {
    return this.clientId ?? '';
  }

  finish(): boolean {
    if (!this.canFinish()) {
      return false;
    }
    this.clear();
    return true;
  }

  clear(): void {
    this.clientId = null;
    this.secret = null;
    this.acknowledged = false;
  }
}

export class GatewayActionGate {
  private activeAction: GatewayUiAction | null = null;

  begin(action: GatewayUiAction): boolean {
    if (this.activeAction) {
      return false;
    }
    this.activeAction = action;
    return true;
  }

  finish(action: GatewayUiAction): void {
    if (this.activeAction === action) {
      this.activeAction = null;
    }
  }

  isBusy(): boolean {
    return this.activeAction !== null;
  }

  currentAction(): GatewayUiAction | null {
    return this.activeAction;
  }
}

export interface GatewayViewModel {
  showLoading: boolean;
  showDisconnected: boolean;
  showDisabled: boolean;
  showEnabled: boolean;
  status: 'Loading' | 'Disconnected' | 'Disabled' | 'Enabled' | 'Paired'
    | 'Active' | 'Paused' | 'Expired';
}

export function gatewayLastAuthenticatedLabel(
  lastAuthenticatedAt: string | undefined,
  now = Date.now(),
): string {
  if (!lastAuthenticatedAt) {
    return 'Not connected yet';
  }
  const authenticatedAt = Date.parse(lastAuthenticatedAt);
  if (!Number.isFinite(authenticatedAt)) {
    return 'Last connection unavailable';
  }
  const elapsedMinutes = Math.max(
    0,
    Math.floor((now - authenticatedAt) / 60_000),
  );
  if (elapsedMinutes === 0) {
    return 'Authenticated just now';
  }
  if (elapsedMinutes < 60) {
    return `Authenticated ${elapsedMinutes} min ago`;
  }
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `Authenticated ${elapsedHours} hr ago`;
  }
  return `Last authenticated ${new Date(authenticatedAt).toLocaleDateString()}`;
}

export interface GatewayActionPresentation {
  status: string | null;
  sessionLabel: string | null;
  revokeLabel: string | null;
}

export function deriveGatewayActionPresentation(
  action: GatewayUiAction | null,
): GatewayActionPresentation {
  switch (action) {
    case 'pause':
      return { status: 'Pausing...', sessionLabel: 'Pausing...', revokeLabel: null };
    case 'resume':
      return { status: 'Resuming...', sessionLabel: 'Resuming...', revokeLabel: null };
    case 'end':
      return { status: 'Ending...', sessionLabel: null, revokeLabel: null };
    case 'revoke':
      return { status: 'Revoking...', sessionLabel: null, revokeLabel: 'Revoking...' };
    case 'refresh':
      return { status: 'Refreshing...', sessionLabel: null, revokeLabel: null };
    case 'enable':
      return { status: 'Enabling...', sessionLabel: null, revokeLabel: null };
    case 'disable':
      return { status: 'Disabling...', sessionLabel: null, revokeLabel: null };
    case 'pair':
      return { status: 'Pairing...', sessionLabel: null, revokeLabel: null };
    case 'start':
      return { status: 'Sharing...', sessionLabel: null, revokeLabel: null };
    case 'deny':
      return { status: 'Denying...', sessionLabel: null, revokeLabel: null };
    default:
      return { status: null, sessionLabel: null, revokeLabel: null };
  }
}

export function defaultGatewayTabId(
  tabs: AgentGatewayUiState['tabs'],
): number | null {
  return tabs.find((tab) => tab.active)?.tabId ?? null;
}

export function gatewayStatusClass(
  status: GatewayViewModel['status'],
  actionPending: boolean,
): 'connected' | 'connecting' | 'disconnected' | 'idle' {
  if (actionPending) {
    return 'connecting';
  }
  if (status === 'Active') {
    return 'connected';
  }
  if (status === 'Disconnected') {
    return 'disconnected';
  }
  if (status === 'Disabled') {
    return 'idle';
  }
  return 'connecting';
}

export function gatewayFocusTargetAfterSessionAction(
  operation: 'pause' | 'resume' | 'end',
  succeeded: boolean,
  previousFocusId: string | null,
): string | null {
  if (!succeeded) {
    return previousFocusId;
  }
  switch (operation) {
    case 'pause':
      return 'gateway-resume-active';
    case 'resume':
      return 'gateway-pause-active';
    case 'end':
      return 'gateway-start-session';
  }
}

export function gatewayFocusTargetAfterTransition(
  transition:
    | 'pair-cancel'
    | 'pair-success'
    | 'pair-finish'
    | 'start-success'
    | 'disable-success',
): string {
  switch (transition) {
    case 'pair-cancel':
    case 'pair-finish':
      return 'gateway-show-pair';
    case 'pair-success':
      return 'gateway-copy-client-id';
    case 'start-success':
      return 'gateway-pause-active';
    case 'disable-success':
      return 'gateway-enable';
  }
}

export function setGatewayControlsDisabled(
  controls: Iterable<{ disabled: boolean }>,
  disabled: boolean,
): void {
  for (const control of controls) {
    control.disabled = disabled;
  }
}

export function canPairGatewayAgent(
  displayName: string,
  scopes: readonly string[],
): boolean {
  return displayName.trim().length > 0 && scopes.length > 0;
}

export function canStartGatewaySession(input: {
  clientId: string;
  tabId: string;
  scopes: readonly string[];
  ttlSeconds: number;
}): boolean {
  return input.clientId.length > 0
    && input.tabId.length > 0
    && input.scopes.length > 0
    && Number.isInteger(input.ttlSeconds)
    && input.ttlSeconds > 0;
}

export function isGatewayRegionBusy(
  loading: boolean,
  action: GatewayUiAction | null,
): boolean {
  return loading || action !== null;
}

export function gatewayCredentialCopyFailureMessage(
  credential: 'client-id' | 'secret',
): string {
  return credential === 'client-id'
    ? 'Could not copy the client ID'
    : 'Could not copy the one-time secret';
}

export function focusGatewayElement(
  documentRoot: Pick<Document, 'getElementById'>,
  id: string,
): boolean {
  const element = documentRoot.getElementById(id) as HTMLElement | null;
  if (!element) {
    return false;
  }
  element.focus();
  return true;
}

export function deriveGatewayView(
  state: AgentGatewayUiState | null,
  loading: boolean,
  now = Date.now(),
): GatewayViewModel {
  if (loading) {
    return {
      showLoading: true,
      showDisconnected: false,
      showDisabled: false,
      showEnabled: false,
      status: 'Loading',
    };
  }
  if (!state?.bridgeConnected) {
    return {
      showLoading: false,
      showDisconnected: true,
      showDisabled: false,
      showEnabled: false,
      status: 'Disconnected',
    };
  }
  if (!state.enabled) {
    return {
      showLoading: false,
      showDisconnected: false,
      showDisabled: true,
      showEnabled: false,
      status: 'Disabled',
    };
  }
  const session = state.sessions[0];
  const status = session
    ? Date.parse(session.expiresAt) <= now
      ? 'Expired'
      : session.paused
        ? 'Paused'
        : 'Active'
    : state.clients.some((client) => !client.revokedAt)
      ? 'Paired'
      : 'Enabled';
  return {
    showLoading: false,
    showDisconnected: false,
    showDisabled: false,
    showEnabled: true,
    status,
  };
}

export function createGatewaySessionActionMessage(
  operation: 'pause' | 'resume' | 'end',
  sessionId: string,
): Record<string, unknown> {
  return {
    type: `agent_gateway.ui.${operation}_session`,
    sessionId,
  };
}

export function createGatewayRevokeMessage(
  clientId: string,
): Record<string, unknown> {
  return {
    type: 'agent_gateway.ui.revoke',
    clientId,
  };
}

export async function runWithGatewayAction<T>(
  gate: GatewayActionGate,
  action: GatewayUiAction,
  operation: () => Promise<T>,
): Promise<T> {
  if (!gate.begin(action)) {
    throw new Error('Another Agent Gateway action is already in progress');
  }
  try {
    return await operation();
  } finally {
    gate.finish(action);
  }
}

let gatewayState: AgentGatewayUiState | null = null;
let isGatewayLoading = true;
let pendingRevokeClientId: string | null = null;
let pollingTimer: ReturnType<typeof setInterval> | null = null;
const pairingSecret = new GatewayOneTimeSecret();
const actionGate = new GatewayActionGate();
let elements: ReturnType<typeof resolveElements>;

export function initializeAgentGatewaySidebar(): void {
  elements = resolveElements();
  elements.refresh.addEventListener('click', () => void refreshGateway(true));
  elements.enable.addEventListener('click', () => void setGatewayEnabled(true));
  elements.showPair.addEventListener('click', showPairForm);
  elements.cancelPair.addEventListener('click', hidePairForm);
  elements.pair.addEventListener('click', () => void pairAgent());
  elements.agentName.addEventListener('input', applyControlAvailability);
  for (const scope of document.querySelectorAll<HTMLInputElement>(
    'input[name="gateway-pair-scope"]',
  )) {
    scope.addEventListener('change', applyControlAvailability);
  }
  elements.copyClientId.addEventListener('click', () => void copyPairingCredential(
    pairingSecret.clientIdForCopy(),
    elements.copyClientId,
    'Copy Client ID',
    gatewayCredentialCopyFailureMessage('client-id'),
  ));
  elements.copySecret.addEventListener('click', () => void copyPairingSecret());
  elements.secretAcknowledged.addEventListener('change', () => {
    pairingSecret.acknowledge(elements.secretAcknowledged.checked);
    applyControlAvailability();
  });
  elements.finishPair.addEventListener('click', finishPairing);
  elements.startSession.addEventListener('click', () => void startSession());
  for (const input of document.querySelectorAll<HTMLInputElement>(
    'input[name="gateway-session-scope"], input[name="gateway-session-ttl"]',
  )) {
    input.addEventListener('change', applyControlAvailability);
  }
  elements.disable.addEventListener('click', () => {
    elements.disableConfirm.hidden = false;
  });
  elements.cancelDisable.addEventListener('click', () => {
    elements.disableConfirm.hidden = true;
  });
  elements.confirmDisable.addEventListener('click', () => void setGatewayEnabled(false));

  void refreshGateway(true);
  pollingTimer = setInterval(() => {
    if (!pairingSecret.isVisible() && !actionGate.isBusy()) {
      void refreshGateway(false);
    }
  }, 5_000);
  window.addEventListener('unload', () => {
    if (pollingTimer) {
      clearInterval(pollingTimer);
    }
    clearOneTimeSecret();
  });
}

async function refreshGateway(synchronizeNative: boolean): Promise<void> {
  if (!actionGate.begin('refresh')) {
    return;
  }
  isGatewayLoading = gatewayState === null;
  setBusy(elements.refresh, true, 'Reading...');
  applyControlAvailability();
  clearError();
  try {
    const response = await sendGatewayUiMessage({
      type: synchronizeNative
        ? 'agent_gateway.ui.refresh'
        : 'agent_gateway.ui.get_state',
    });
    gatewayState = requireGatewayState(response);
  } catch (error) {
    if (gatewayState) {
      gatewayState = { ...gatewayState, bridgeConnected: false };
    }
    showError(error);
  } finally {
    isGatewayLoading = false;
    actionGate.finish('refresh');
    setBusy(elements.refresh, false, 'Refresh');
    renderGateway();
  }
}

async function setGatewayEnabled(enabled: boolean): Promise<void> {
  const action = enabled ? 'enable' : 'disable';
  if (!actionGate.begin(action)) {
    return;
  }
  const button = enabled ? elements.enable : elements.confirmDisable;
  let succeeded = false;
  setBusy(button, true, enabled ? 'Enabling...' : 'Disabling...');
  applyControlAvailability();
  clearError();
  try {
    const response = await sendGatewayUiMessage({
      type: 'agent_gateway.ui.set_enabled',
      enabled,
    });
    gatewayState = requireGatewayState(response);
    elements.disableConfirm.hidden = true;
    succeeded = true;
  } catch (error) {
    showError(error);
  } finally {
    actionGate.finish(action);
    setBusy(button, false, enabled ? 'Enable Agent Gateway' : 'Disable Gateway');
    renderGateway();
    if (succeeded && !enabled) {
      focusElement(gatewayFocusTargetAfterTransition('disable-success'));
    }
  }
}

async function pairAgent(): Promise<void> {
  if (!actionGate.begin('pair')) {
    return;
  }
  const scopes = checkedValues('gateway-pair-scope');
  let succeeded = false;
  setBusy(elements.pair, true, 'Pairing...');
  applyControlAvailability();
  clearError();
  try {
    const response = await sendGatewayUiMessage({
      type: 'agent_gateway.ui.pair',
      displayName: elements.agentName.value,
      clientVersion: elements.agentVersion.value,
      scopes,
    });
    if (!response.pairing?.secret || !response.state) {
      throw new Error('Native bridge returned an incomplete pairing');
    }
    gatewayState = response.state;
    pairingSecret.reveal(
      response.pairing.client.clientId,
      response.pairing.secret,
    );
    elements.clientIdValue.textContent = pairingSecret.clientIdForCopy();
    elements.secretValue.textContent = pairingSecret.valueForCopy();
    elements.secret.hidden = false;
    elements.secretAcknowledged.checked = false;
    elements.pairForm.hidden = true;
    succeeded = true;
  } catch (error) {
    showError(error);
  } finally {
    actionGate.finish('pair');
    setBusy(elements.pair, false, 'Pair Agent');
    renderGateway();
    if (succeeded) {
      focusElement(gatewayFocusTargetAfterTransition('pair-success'));
    }
  }
}

async function copyPairingSecret(): Promise<void> {
  const secret = pairingSecret.valueForCopy();
  if (!secret) {
    return;
  }
  await copyPairingCredential(
    secret,
    elements.copySecret,
    'Copy Secret',
    gatewayCredentialCopyFailureMessage('secret'),
  );
}

async function copyPairingCredential(
  value: string,
  button: HTMLButtonElement,
  idleLabel: string,
  failureMessage: string,
): Promise<void> {
  if (!value) {
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = 'Copied';
    setTimeout(() => {
      button.textContent = idleLabel;
    }, 1_500);
  } catch {
    showError(new Error(failureMessage));
  }
}

function finishPairing(): void {
  if (!pairingSecret.finish()) {
    return;
  }
  clearOneTimeSecret();
  elements.showPair.hidden = false;
  elements.agentName.value = '';
  elements.agentVersion.value = '';
  for (const checkbox of document.querySelectorAll<HTMLInputElement>(
    'input[name="gateway-pair-scope"]',
  )) {
    checkbox.checked = false;
  }
  renderGateway();
  focusElement(gatewayFocusTargetAfterTransition('pair-finish'));
}

async function startSession(): Promise<void> {
  if (!actionGate.begin('start')) {
    return;
  }
  const clientId = checkedValue('gateway-session-client');
  const tabId = Number(checkedValue('gateway-session-tab'));
  const scopes = checkedValues('gateway-session-scope');
  const ttlSeconds = Number(checkedValue('gateway-session-ttl'));
  const pendingRequest = currentPendingSessionRequest();
  const isTabBinding = pendingRequest?.kind === 'tab-bind';
  let succeeded = false;
  setBusy(elements.startSession, true, isTabBinding ? 'Moving...' : 'Sharing...');
  applyControlAvailability();
  clearError();
  try {
    const response = await sendGatewayUiMessage(isTabBinding
      ? {
          type: 'agent_gateway.ui.approve_tab_binding',
          clientId: pendingRequest.clientId,
          requestId: pendingRequest.requestId,
          tabId,
        }
      : {
          type: 'agent_gateway.ui.start_session',
          clientId,
          tabId,
          scopes,
          ttlSeconds,
          ...(pendingRequest ? { requestId: pendingRequest.requestId } : {}),
        });
    gatewayState = requireGatewayState(response);
    succeeded = true;
  } catch (error) {
    showError(error);
  } finally {
    actionGate.finish('start');
    setBusy(
      elements.startSession,
      false,
      isTabBinding ? 'Move Session to Selected Tab' : 'Share Selected Tab',
    );
    renderGateway();
    if (succeeded) {
      focusElement(gatewayFocusTargetAfterTransition('start-success'));
    }
  }
}

async function denyPendingSessionRequest(
  clientId: string,
  requestId: string,
): Promise<void> {
  if (!actionGate.begin('deny')) {
    return;
  }
  applyControlAvailability();
  clearError();
  try {
    const response = await sendGatewayUiMessage({
      type: 'agent_gateway.ui.deny_session_request',
      clientId,
      requestId,
    });
    gatewayState = requireGatewayState(response);
  } catch (error) {
    showError(error);
  } finally {
    actionGate.finish('deny');
    renderGateway();
    focusElement('gateway-start-session');
  }
}

async function changeSession(
  operation: 'pause' | 'resume' | 'end',
  sessionId: string,
): Promise<void> {
  if (!actionGate.begin(operation)) {
    return;
  }
  const previousFocusId = (document.activeElement as HTMLElement | null)?.id ?? null;
  let succeeded = false;
  renderGateway();
  clearError();
  try {
    const response = await sendGatewayUiMessage(
      createGatewaySessionActionMessage(operation, sessionId),
    );
    gatewayState = requireGatewayState(response);
    succeeded = true;
  } catch (error) {
    showError(error);
  } finally {
    actionGate.finish(operation);
    renderGateway();
    if (succeeded) {
      focusElement(gatewayFocusTargetAfterSessionAction(
        operation,
        true,
        previousFocusId,
      )!);
    } else {
      const focusTarget = gatewayFocusTargetAfterSessionAction(
        operation,
        false,
        previousFocusId,
      );
      if (focusTarget) {
        focusElement(focusTarget);
      }
    }
  }
}

async function revokeClient(clientId: string): Promise<void> {
  if (pendingRevokeClientId !== clientId) {
    pendingRevokeClientId = clientId;
    renderGateway();
    focusRevokeButton(clientId);
    return;
  }
  if (!actionGate.begin('revoke')) {
    return;
  }
  let succeeded = false;
  renderGateway();
  clearError();
  try {
    const response = await sendGatewayUiMessage(
      createGatewayRevokeMessage(clientId),
    );
    gatewayState = requireGatewayState(response);
    pendingRevokeClientId = null;
    succeeded = true;
  } catch (error) {
    showError(error);
  } finally {
    actionGate.finish('revoke');
    renderGateway();
    if (succeeded) {
      elements.showPair.focus();
    } else {
      focusRevokeButton(clientId);
    }
  }
}

function renderGateway(): void {
  const state = gatewayState;
  const bridgeConnected = state?.bridgeConnected === true;
  const enabled = state?.enabled === true;
  const activeSession = state?.sessions[0];
  const sessionExpired = activeSession
    ? Date.parse(activeSession.expiresAt) <= Date.now()
    : false;
  const activeClient = activeSession
    ? state?.clients.find((client) => client.clientId === activeSession.clientId)
    : undefined;
  const activeTab = activeSession
    ? state?.tabs.find((tab) => tab.tabId === activeSession.tabId)
    : undefined;

  const view = deriveGatewayView(state, isGatewayLoading);
  const actionPresentation = deriveGatewayActionPresentation(
    actionGate.currentAction(),
  );
  elements.panel.setAttribute(
    'aria-busy',
    String(isGatewayRegionBusy(isGatewayLoading, actionGate.currentAction())),
  );
  elements.loading.hidden = !view.showLoading;
  elements.disconnected.hidden = !view.showDisconnected;
  elements.disabled.hidden = !view.showDisabled;
  elements.enabled.hidden = !view.showEnabled;

  const status = view.status;
  const statusClass = gatewayStatusClass(
    status,
    actionPresentation.status !== null,
  );
  elements.statusIndicator.className = `status-indicator ${statusClass}`;
  elements.statusText.className = `status-text ${statusClass}`;
  elements.statusText.textContent = actionPresentation.status ?? status;

  renderTrustRail(
    activeClient?.displayName ?? pairedAgentSummary(gatewayState),
    bridgeConnected ? (enabled ? status.toLowerCase() : 'disabled') : 'offline',
    activeTab?.origin ?? activeSession?.origin ?? 'none',
    Boolean(activeSession && !sessionExpired && !activeSession.paused),
    Boolean(
      actionPresentation.status
      || status === 'Loading'
      || status === 'Enabled'
      || status === 'Paired'
      || status === 'Paused'
      || status === 'Expired',
    ),
  );
  if (!gatewayState) {
    applyControlAvailability();
    return;
  }
  renderClients(gatewayState);
  renderSessionApproval(gatewayState, sessionExpired);
  applyControlAvailability();
}

function renderClients(state: AgentGatewayUiState): void {
  const liveClients = state.clients.filter((client) => !client.revokedAt);
  const revoking = actionGate.currentAction() === 'revoke';
  elements.clientList.innerHTML = liveClients.length === 0
    ? '<div class="gateway-empty">No external agents are paired.</div>'
    : liveClients.map((client) => `
      <div class="gateway-choice">
        <span class="gateway-boundary-state connected"></span>
        <span class="gateway-choice-main">
          <span class="gateway-choice-name">${escapeHtml(client.displayName)}</span>
          <span class="gateway-choice-meta">${escapeHtml(client.clientId)} · ${client.scopes.map(escapeHtml).join(', ')}</span>
          <span class="gateway-choice-meta">${escapeHtml(gatewayLastAuthenticatedLabel(client.lastAuthenticatedAt))}</span>
        </span>
        ${pendingRevokeClientId === client.clientId
          ? `<span class="gateway-actions">
              <button
                class="btn btn-secondary btn-sm gateway-cancel-revoke"
                type="button"
                data-client-id="${escapeHtml(client.clientId)}"
              >Cancel</button>
              <button
                class="btn btn-danger btn-sm gateway-revoke-client"
                type="button"
                data-client-id="${escapeHtml(client.clientId)}"
              >${revoking ? 'Revoking...' : 'Confirm revoke'}</button>
            </span>`
          : `<button
              class="btn btn-ghost btn-sm gateway-revoke-client"
              type="button"
              data-client-id="${escapeHtml(client.clientId)}"
            >Revoke</button>`}
      </div>
    `).join('');
  for (const button of elements.clientList.querySelectorAll<HTMLButtonElement>(
    '.gateway-revoke-client',
  )) {
    button.addEventListener('click', () => void revokeClient(button.dataset.clientId ?? ''));
  }
  for (const button of elements.clientList.querySelectorAll<HTMLButtonElement>(
    '.gateway-cancel-revoke',
  )) {
    button.addEventListener('click', () => {
      const clientId = button.dataset.clientId ?? '';
      pendingRevokeClientId = null;
      renderGateway();
      focusRevokeButton(clientId);
    });
  }
}

function renderSessionApproval(
  state: AgentGatewayUiState,
  sessionExpired: boolean,
): void {
  const session = state.sessions[0];
  const pendingRequest = state.sessionRequests.find(
    (request) =>
      request.status === 'pending'
      && Date.parse(request.expiresAt) > Date.now(),
  );
  const isTabBinding = pendingRequest?.kind === 'tab-bind';
  elements.sessionActive.hidden = !session;
  elements.sessionForm.hidden = Boolean(
    session && !sessionExpired && !isTabBinding,
  );
  if (session) {
    const client = state.clients.find((candidate) => candidate.clientId === session.clientId);
    const tab = state.tabs.find((candidate) => candidate.tabId === session.tabId);
    const status = sessionExpired ? 'Expired' : session.paused ? 'Paused' : 'Active';
    const pendingSessionLabel = deriveGatewayActionPresentation(
      actionGate.currentAction(),
    ).sessionLabel;
    elements.sessionActive.innerHTML = `
      <div class="gateway-session ${status === 'Active' ? '' : 'paused'}">
        <div class="gateway-section-heading">
          <span class="gateway-section-title">${status}</span>
          <span class="gateway-section-meta">${escapeHtml(session.sessionId)}</span>
        </div>
        <div class="gateway-session-line">
          <span class="gateway-session-key">Agent</span>
          <span class="gateway-session-value">${escapeHtml(client?.displayName ?? session.clientId)}</span>
        </div>
        <div class="gateway-session-line">
          <span class="gateway-session-key">Shared tab</span>
          <span class="gateway-session-value">${escapeHtml(tab?.origin ?? session.origin)}</span>
        </div>
        <div class="gateway-session-line">
          <span class="gateway-session-key">Scopes</span>
          <span class="gateway-session-value">${session.scopes.map(scopeLabel).map(escapeHtml).join(', ')}</span>
        </div>
        <div class="gateway-session-line">
          <span class="gateway-session-key">Expires</span>
          <span class="gateway-session-value">${escapeHtml(formatExpiry(session.expiresAt))}</span>
        </div>
        <div class="gateway-actions">
          ${!sessionExpired
            ? `<button class="btn btn-secondary btn-sm" id="gateway-${session.paused ? 'resume' : 'pause'}-active" type="button">${pendingSessionLabel ?? (session.paused ? 'Resume' : 'Pause')}</button>`
            : ''}
          <button class="btn btn-danger btn-sm" id="gateway-end-active" type="button">${actionGate.currentAction() === 'end' ? 'Ending...' : sessionExpired ? 'Clear Expired Session' : 'End Session'}</button>
        </div>
      </div>
    `;
    document.getElementById('gateway-pause-active')?.addEventListener(
      'click',
      () => void changeSession('pause', session.sessionId),
    );
    document.getElementById('gateway-resume-active')?.addEventListener(
      'click',
      () => void changeSession('resume', session.sessionId),
    );
    document.getElementById('gateway-end-active')?.addEventListener(
      'click',
      () => void changeSession('end', session.sessionId),
    );
  } else {
    elements.sessionActive.replaceChildren();
  }

  elements.sessionRequest.hidden = !pendingRequest;
  if (pendingRequest) {
    const requestingClient = state.clients.find(
      (client) => client.clientId === pendingRequest.clientId,
    );
    elements.sessionRequest.innerHTML = `
      <div class="gateway-section-heading">
        <span class="gateway-section-title">${
          isTabBinding ? 'Tab change requested' : 'Tab access requested'
        }</span>
        <span class="gateway-section-meta">${
          isTabBinding
            ? 'same access'
            : escapeHtml(`${Math.ceil(pendingRequest.requestedTtlSeconds / 60)} min`)
        }</span>
      </div>
      <div class="gateway-status-copy">
        <strong>${escapeHtml(
          requestingClient?.displayName ?? pendingRequest.clientId,
        )}</strong> asks to ${escapeHtml(pendingRequest.reason)}
      </div>
      <div class="gateway-status-copy">
        ${pendingRequest.requestedScopes.map(scopeLabel).map(escapeHtml).join(', ')}
      </div>
      <div class="gateway-actions">
        <button class="btn btn-secondary btn-sm" id="gateway-deny-request" type="button">
          Deny
        </button>
      </div>
    `;
    document.getElementById('gateway-deny-request')?.addEventListener(
      'click',
      () => void denyPendingSessionRequest(
        pendingRequest.clientId,
        pendingRequest.requestId,
      ),
    );
  } else {
    elements.sessionRequest.replaceChildren();
  }

  elements.sessionAgentFields.hidden = isTabBinding;
  elements.sessionAccessFields.hidden = isTabBinding;
  elements.sessionTtlFields.hidden = isTabBinding;
  elements.startSession.textContent = isTabBinding
    ? 'Move Session to Selected Tab'
    : 'Share Selected Tab';

  const clients = state.clients.filter((client) => !client.revokedAt);
  elements.sessionClients.innerHTML = clients.length === 0
    ? '<div class="gateway-empty">Pair an external agent before sharing a tab.</div>'
    : clients.map((client, index) => `
      <label class="gateway-choice">
        <input type="radio" name="gateway-session-client" value="${escapeHtml(client.clientId)}" ${
          client.clientId === pendingRequest?.clientId
          || (!pendingRequest && index === 0)
            ? 'checked'
            : ''
        } />
        <span class="gateway-choice-main">
          <span class="gateway-choice-name">${escapeHtml(client.displayName)}</span>
          <span class="gateway-choice-meta">${client.scopes.map(escapeHtml).join(', ')}</span>
        </span>
      </label>
    `).join('');
  for (const radio of elements.sessionClients.querySelectorAll<HTMLInputElement>(
    'input[name="gateway-session-client"]',
  )) {
    radio.addEventListener('change', applyControlAvailability);
  }

  const defaultTabId = defaultGatewayTabId(state.tabs);
  elements.tabList.innerHTML = state.tabs.length === 0
    ? '<div class="gateway-empty">No shareable HTTP(S) tabs are open.</div>'
    : state.tabs.map((tab) => `
      <label class="gateway-choice">
        <input type="radio" name="gateway-session-tab" value="${tab.tabId}" ${tab.tabId === defaultTabId ? 'checked' : ''} />
        <span class="gateway-choice-main">
          <span class="gateway-choice-name">${escapeHtml(tab.title)}</span>
          <span class="gateway-choice-meta">${escapeHtml(tab.origin)} · window ${tab.windowId} · tab ${tab.tabId}</span>
        </span>
      </label>
    `).join('');
  for (const radio of elements.tabList.querySelectorAll<HTMLInputElement>(
    'input[name="gateway-session-tab"]',
  )) {
    radio.addEventListener('change', applyControlAvailability);
  }
  updateSessionScopeAvailability();
  if (pendingRequest) {
    for (const checkbox of document.querySelectorAll<HTMLInputElement>(
      'input[name="gateway-session-scope"]',
    )) {
      checkbox.checked = pendingRequest.requestedScopes
        .map(scopeLabel)
        .includes(checkbox.value);
    }
    const requestedTtl = document.querySelector<HTMLInputElement>(
      `input[name="gateway-session-ttl"][value="${pendingRequest.requestedTtlSeconds}"]`,
    );
    if (requestedTtl) {
      requestedTtl.checked = true;
    }
  }
  elements.startSession.disabled = isTabBinding
    ? defaultTabId === null
    : clients.length === 0 || defaultTabId === null;
}

function updateSessionScopeAvailability(): void {
  const clientId = checkedValue('gateway-session-client');
  const client = gatewayState?.clients.find((candidate) => candidate.clientId === clientId);
  for (const checkbox of document.querySelectorAll<HTMLInputElement>(
    'input[name="gateway-session-scope"]',
  )) {
    const allowed = client?.scopes.includes(
      checkbox.value as AgentGatewayApprovalScope,
    ) === true;
    checkbox.disabled = !allowed;
    if (!allowed) {
      checkbox.checked = false;
    }
  }
}

function renderTrustRail(
  agent: string,
  harbor: string,
  tab: string,
  active: boolean,
  pending: boolean,
): void {
  setBoundary(elements.railAgent, agent, active ? 'connected' : pending ? 'pending' : '');
  setBoundary(
    elements.railHarbor,
    harbor,
    active ? 'connected' : pending ? 'pending' : harbor === 'offline' ? 'failed' : '',
  );
  setBoundary(elements.railTab, tab, active ? 'connected' : pending ? 'pending' : '');
}

function setBoundary(
  element: HTMLElement,
  value: string,
  stateClass: '' | 'connected' | 'pending' | 'failed',
): void {
  element.replaceChildren();
  const dot = document.createElement('span');
  dot.className = `gateway-boundary-state ${stateClass}`.trim();
  element.append(dot, document.createTextNode(value));
  element.title = value;
}

function pairedAgentSummary(state: AgentGatewayUiState | null): string {
  const pairedCount = state?.clients.filter((client) => !client.revokedAt).length ?? 0;
  return pairedCount > 0 ? `${pairedCount} paired` : 'none';
}

function currentPendingSessionRequest() {
  return gatewayState?.sessionRequests.find(
    (request) =>
      request.status === 'pending'
      && Date.parse(request.expiresAt) > Date.now(),
  );
}

function focusElement(id: string): void {
  focusGatewayElement(document, id);
}

function focusRevokeButton(clientId: string): void {
  for (const button of elements.clientList.querySelectorAll<HTMLButtonElement>(
    '.gateway-revoke-client',
  )) {
    if (button.dataset.clientId === clientId) {
      button.focus();
      return;
    }
  }
}

function showPairForm(): void {
  elements.pairForm.hidden = false;
  elements.showPair.hidden = true;
  elements.agentName.focus();
}

function hidePairForm(): void {
  elements.pairForm.hidden = true;
  elements.showPair.hidden = false;
  focusElement(gatewayFocusTargetAfterTransition('pair-cancel'));
}

function clearOneTimeSecret(): void {
  pairingSecret.clear();
  elements.clientIdValue.textContent = '';
  elements.secretValue.textContent = '';
  elements.secret.hidden = true;
  elements.secretAcknowledged.checked = false;
  applyControlAvailability();
}

function checkedValues(name: string): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(
    `input[name="${name}"]:checked`,
  )).map((input) => input.value);
}

function checkedValue(name: string): string {
  return document.querySelector<HTMLInputElement>(
    `input[name="${name}"]:checked`,
  )?.value ?? '';
}

async function sendGatewayUiMessage(
  message: Record<string, unknown>,
): Promise<GatewayUiResponse> {
  const response = await browserAPI.runtime.sendMessage(message) as GatewayUiResponse;
  if (!response?.ok) {
    throw new Error(response?.error || 'Agent Gateway request failed');
  }
  return response;
}

function requireGatewayState(response: GatewayUiResponse): AgentGatewayUiState {
  if (!response.state) {
    throw new Error('Agent Gateway returned no authority state');
  }
  return response.state;
}

function setBusy(
  button: HTMLButtonElement,
  busy: boolean,
  label: string,
): void {
  button.disabled = busy;
  button.textContent = label;
}

function applyControlAvailability(): void {
  elements.panel.setAttribute(
    'aria-busy',
    String(isGatewayRegionBusy(isGatewayLoading, actionGate.currentAction())),
  );
  const controls = document.querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    '#agent-gateway-panel input, #agent-gateway-panel button',
  );
  setGatewayControlsDisabled(controls, actionGate.isBusy());
  if (actionGate.isBusy()) {
    return;
  }

  if (pairingSecret.isVisible()) {
    setGatewayControlsDisabled(controls, true);
    elements.copyClientId.disabled = false;
    elements.copySecret.disabled = false;
    elements.secretAcknowledged.disabled = false;
    elements.finishPair.disabled = !pairingSecret.canFinish();
    return;
  }

  elements.finishPair.disabled = true;
  updateSessionScopeAvailability();
  elements.pair.disabled = !canPairGatewayAgent(
    elements.agentName.value,
    checkedValues('gateway-pair-scope'),
  );
  elements.startSession.disabled = !canStartGatewaySession({
    clientId: checkedValue('gateway-session-client'),
    tabId: checkedValue('gateway-session-tab'),
    scopes: checkedValues('gateway-session-scope'),
    ttlSeconds: Number(checkedValue('gateway-session-ttl')),
  }) && currentPendingSessionRequest()?.kind !== 'tab-bind';
  if (currentPendingSessionRequest()?.kind === 'tab-bind') {
    elements.startSession.disabled = !checkedValue('gateway-session-tab');
  }
}

function showError(error: unknown): void {
  elements.error.textContent = error instanceof Error ? error.message : String(error);
  elements.error.hidden = false;
}

function clearError(): void {
  elements.error.textContent = '';
  elements.error.hidden = true;
}

function formatExpiry(expiresAt: string): string {
  const expiry = Date.parse(expiresAt);
  if (expiry <= Date.now()) {
    return `expired ${new Date(expiry).toLocaleTimeString()}`;
  }
  return `${new Date(expiry).toLocaleTimeString()} (${Math.ceil((expiry - Date.now()) / 60_000)} min)`;
}

function scopeLabel(scope: string): string {
  if (scope === 'gateway:tabs.read') {
    return 'tabs:list';
  }
  if (scope === 'gateway:page.read') {
    return 'page:observe';
  }
  return scope;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing Agent Gateway element: ${id}`);
  }
  return element as T;
}

function resolveElements() {
  return {
    panel: requireElement<HTMLDivElement>('agent-gateway-panel'),
    statusIndicator: requireElement<HTMLDivElement>('gateway-status-indicator'),
    statusText: requireElement<HTMLSpanElement>('gateway-status-text'),
    refresh: requireElement<HTMLButtonElement>('gateway-refresh'),
    error: requireElement<HTMLDivElement>('gateway-error'),
    loading: requireElement<HTMLDivElement>('gateway-loading'),
    disconnected: requireElement<HTMLDivElement>('gateway-disconnected'),
    disabled: requireElement<HTMLDivElement>('gateway-disabled'),
    enabled: requireElement<HTMLDivElement>('gateway-enabled'),
    enable: requireElement<HTMLButtonElement>('gateway-enable'),
    clientList: requireElement<HTMLDivElement>('gateway-client-list'),
    showPair: requireElement<HTMLButtonElement>('gateway-show-pair'),
    pairForm: requireElement<HTMLDivElement>('gateway-pair-form'),
    agentName: requireElement<HTMLInputElement>('gateway-agent-name'),
    agentVersion: requireElement<HTMLInputElement>('gateway-agent-version'),
    cancelPair: requireElement<HTMLButtonElement>('gateway-cancel-pair'),
    pair: requireElement<HTMLButtonElement>('gateway-pair'),
    secret: requireElement<HTMLDivElement>('gateway-secret'),
    clientIdValue: requireElement<HTMLElement>('gateway-client-id-value'),
    secretValue: requireElement<HTMLElement>('gateway-secret-value'),
    copyClientId: requireElement<HTMLButtonElement>('gateway-copy-client-id'),
    copySecret: requireElement<HTMLButtonElement>('gateway-copy-secret'),
    secretAcknowledged: requireElement<HTMLInputElement>('gateway-secret-acknowledged'),
    finishPair: requireElement<HTMLButtonElement>('gateway-finish-pair'),
    sessionClients: requireElement<HTMLDivElement>('gateway-session-clients'),
    sessionAgentFields: requireElement<HTMLDivElement>('gateway-session-agent-fields'),
    sessionAccessFields: requireElement<HTMLDivElement>('gateway-session-access-fields'),
    sessionTtlFields: requireElement<HTMLDivElement>('gateway-session-ttl-fields'),
    tabList: requireElement<HTMLDivElement>('gateway-tab-list'),
    sessionActive: requireElement<HTMLDivElement>('gateway-session-active'),
    sessionRequest: requireElement<HTMLDivElement>('gateway-session-request'),
    sessionForm: requireElement<HTMLDivElement>('gateway-session-form'),
    startSession: requireElement<HTMLButtonElement>('gateway-start-session'),
    disable: requireElement<HTMLButtonElement>('gateway-disable'),
    disableConfirm: requireElement<HTMLDivElement>('gateway-disable-confirm'),
    cancelDisable: requireElement<HTMLButtonElement>('gateway-cancel-disable'),
    confirmDisable: requireElement<HTMLButtonElement>('gateway-confirm-disable'),
    railAgent: requireElement<HTMLSpanElement>('gateway-rail-agent'),
    railHarbor: requireElement<HTMLSpanElement>('gateway-rail-harbor'),
    railTab: requireElement<HTMLSpanElement>('gateway-rail-tab'),
  };
}

function escapeHtml(value: string): string {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
