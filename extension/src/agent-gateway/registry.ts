import { browserAPI } from '../browser-compat';
import { captureDocumentBinding } from './browser-adapter';
import {
  AGENT_GATEWAY_PRINCIPAL_PREFIX,
  GATEWAY_PAGE_READ_SCOPE,
  GATEWAY_TABS_READ_SCOPE,
  type AgentGatewayConfiguration,
  type AgentGatewayScope,
  type AgentGatewaySession,
  type AgentGatewaySessionRequest,
  type PairedAgentGatewayClient,
} from './types';

const STORAGE_KEY = 'harbor_agent_gateway_v1';
const SESSION_REQUEST_TTL_MS = 5 * 60 * 1000;

const DEFAULT_CONFIGURATION: AgentGatewayConfiguration = {
  enabled: false,
  defaultSessionTtlSeconds: 900,
  maxSessionTtlSeconds: 3600,
  maxConcurrentCallsPerSession: 4,
  maxTabs: 100,
  maxTabTitleBytes: 512,
  maxTabUrlBytes: 4_096,
  maxTabsResultBytes: 131_072,
  maxReadableTextBytes: 200_000,
  maxElements: 200,
};

interface StoredAgentGatewayState {
  configuration: AgentGatewayConfiguration;
  pairedClients: PairedAgentGatewayClient[];
}

export interface PairedClientMetadata {
  clientId: string;
  displayName: string;
  scopes: AgentGatewayScope[];
  pairedAt: string;
  lastAuthenticatedAt?: string;
  revokedAt?: string;
}

export interface StartAgentGatewaySessionInput {
  clientId: string;
  tabId: number;
  origin: string;
  scopes: AgentGatewayScope[];
  allowedOrigins: string[];
  ttlSeconds?: number;
}

export interface AgentGatewayAuthoritySnapshot {
  configuration: AgentGatewayConfiguration;
  pairedClients: PairedAgentGatewayClient[];
  sessions: AgentGatewaySession[];
  sessionRequests: AgentGatewaySessionRequest[];
}

export class AgentGatewayPolicyError extends Error {
  constructor(
    readonly code:
      | 'GATEWAY_DISABLED'
      | 'CLIENT_NOT_PAIRED'
      | 'CLIENT_REVOKED'
      | 'SESSION_NOT_FOUND'
      | 'SESSION_EXPIRED'
      | 'SESSION_PAUSED'
      | 'SESSION_CLIENT_MISMATCH'
      | 'SCOPE_NOT_GRANTED'
      | 'INVALID_REQUEST'
      | 'REQUEST_NOT_FOUND'
      | 'REQUEST_EXPIRED'
      | 'TOO_MANY_REQUESTS',
    message: string,
  ) {
    super(message);
  }
}

export class AgentGatewayRegistry {
  private configuration: AgentGatewayConfiguration = { ...DEFAULT_CONFIGURATION };
  private pairedClients = new Map<string, PairedAgentGatewayClient>();
  private sessions = new Map<string, AgentGatewaySession>();
  private sessionRequests = new Map<string, AgentGatewaySessionRequest>();
  private inFlightCalls = new Map<string, number>();

  getConfiguration(): AgentGatewayConfiguration {
    return { ...this.configuration };
  }

  getAuthoritySnapshot(): AgentGatewayAuthoritySnapshot {
    return {
      configuration: this.getConfiguration(),
      pairedClients: Array.from(this.pairedClients.values()).map((client) => ({
        ...client,
        scopes: [...client.scopes],
      })),
      sessions: Array.from(this.sessions.values()).map(cloneSession),
      sessionRequests: Array.from(this.sessionRequests.values())
        .map(cloneSessionRequest),
    };
  }

  replacePersistentState(state?: Partial<StoredAgentGatewayState>): void {
    const storedConfiguration = {
      ...DEFAULT_CONFIGURATION,
      ...(state?.configuration ?? {}),
      enabled: state?.configuration?.enabled === true,
    };
    this.configuration = {
      ...storedConfiguration,
      defaultSessionTtlSeconds: boundedInteger(
        storedConfiguration.defaultSessionTtlSeconds,
        1,
        3_600,
        DEFAULT_CONFIGURATION.defaultSessionTtlSeconds,
      ),
      maxSessionTtlSeconds: boundedInteger(
        storedConfiguration.maxSessionTtlSeconds,
        1,
        86_400,
        DEFAULT_CONFIGURATION.maxSessionTtlSeconds,
      ),
      maxConcurrentCallsPerSession: boundedInteger(
        storedConfiguration.maxConcurrentCallsPerSession,
        1,
        16,
        DEFAULT_CONFIGURATION.maxConcurrentCallsPerSession,
      ),
      maxTabs: boundedInteger(
        storedConfiguration.maxTabs,
        1,
        500,
        DEFAULT_CONFIGURATION.maxTabs,
      ),
      maxTabTitleBytes: boundedInteger(
        storedConfiguration.maxTabTitleBytes,
        1,
        2_048,
        DEFAULT_CONFIGURATION.maxTabTitleBytes,
      ),
      maxTabUrlBytes: boundedInteger(
        storedConfiguration.maxTabUrlBytes,
        1,
        16_384,
        DEFAULT_CONFIGURATION.maxTabUrlBytes,
      ),
      maxTabsResultBytes: boundedInteger(
        storedConfiguration.maxTabsResultBytes,
        1_024,
        1_048_576,
        DEFAULT_CONFIGURATION.maxTabsResultBytes,
      ),
      maxReadableTextBytes: boundedInteger(
        storedConfiguration.maxReadableTextBytes,
        1,
        1_048_576,
        DEFAULT_CONFIGURATION.maxReadableTextBytes,
      ),
      maxElements: boundedInteger(
        storedConfiguration.maxElements,
        1,
        500,
        DEFAULT_CONFIGURATION.maxElements,
      ),
    };
    this.pairedClients.clear();
    for (const client of state?.pairedClients ?? []) {
      if (client.principal === principalForClient(client.clientId)) {
        this.pairedClients.set(client.clientId, {
          ...client,
          scopes: client.scopes.filter(isGatewayScope),
        });
      }
    }
  }

  setEnabled(enabled: boolean): void {
    this.configuration = { ...this.configuration, enabled };
    if (!enabled) {
      this.sessions.clear();
      this.sessionRequests.clear();
    }
  }

  beginCall(clientId: string, sessionId: string): () => void {
    const key = `${clientId}\u0000${sessionId}`;
    const currentCalls = this.inFlightCalls.get(key) ?? 0;
    if (currentCalls >= this.configuration.maxConcurrentCallsPerSession) {
      throw new AgentGatewayPolicyError(
        'TOO_MANY_REQUESTS',
        'Agent Gateway session has too many in-flight requests',
      );
    }
    this.inFlightCalls.set(key, currentCalls + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const remainingCalls = (this.inFlightCalls.get(key) ?? 1) - 1;
      if (remainingCalls <= 0) {
        this.inFlightCalls.delete(key);
      } else {
        this.inFlightCalls.set(key, remainingCalls);
      }
    };
  }

  pairClient(
    clientId: string,
    displayName: string,
    scopes: AgentGatewayScope[],
  ): PairedAgentGatewayClient {
    validateClientId(clientId);
    const client: PairedAgentGatewayClient = {
      clientId,
      displayName,
      principal: principalForClient(clientId),
      scopes: [...new Set(scopes.filter(isGatewayScope))],
      pairedAt: new Date().toISOString(),
    };
    this.pairedClients.set(clientId, client);
    return { ...client, scopes: [...client.scopes] };
  }

  syncPairedClients(clients: PairedClientMetadata[]): void {
    this.pairedClients.clear();
    for (const client of clients) {
      validateClientId(client.clientId);
      this.pairedClients.set(client.clientId, {
        ...client,
        principal: principalForClient(client.clientId),
        scopes: [...new Set(client.scopes.filter(isGatewayScope))],
      });
    }
    for (const [sessionId, session] of this.sessions) {
      const pairedClient = this.pairedClients.get(session.clientId);
      if (!pairedClient || pairedClient.revokedAt) {
        this.sessions.delete(sessionId);
      }
    }
    for (const [requestId, request] of this.sessionRequests) {
      const pairedClient = this.pairedClients.get(request.clientId);
      if (!pairedClient || pairedClient.revokedAt) {
        this.sessionRequests.delete(requestId);
      }
    }
  }

  revokeClient(clientId: string): void {
    const client = this.pairedClients.get(clientId);
    if (!client) {
      return;
    }
    client.revokedAt = new Date().toISOString();
    for (const [sessionId, session] of this.sessions) {
      if (session.clientId === clientId) {
        this.sessions.delete(sessionId);
      }
    }
    for (const [requestId, request] of this.sessionRequests) {
      if (request.clientId === clientId) {
        this.sessionRequests.delete(requestId);
      }
    }
  }

  requestSession(input: {
    clientId: string;
    requestedScopes: AgentGatewayScope[];
    requestedTtlSeconds: number;
    reason: string;
  }): AgentGatewaySessionRequest {
    const client = this.requirePairedClient(input.clientId);
    const requestedScopes = [...new Set(input.requestedScopes.filter(isGatewayScope))];
    if (requestedScopes.length === 0) {
      throw new AgentGatewayPolicyError(
        'SCOPE_NOT_GRANTED',
        'Gateway session request requires at least one approved scope',
      );
    }
    if (requestedScopes.some((scope) => !client.scopes.includes(scope))) {
      throw new AgentGatewayPolicyError(
        'SCOPE_NOT_GRANTED',
        'Gateway session requested a scope not granted to the paired client',
      );
    }
    const supportedTtlSeconds = [300, 900, 3600].filter(
      (ttlSeconds) => ttlSeconds <= this.configuration.maxSessionTtlSeconds,
    );
    if (!supportedTtlSeconds.includes(input.requestedTtlSeconds)) {
      throw new AgentGatewayPolicyError(
        'INVALID_REQUEST',
        `Gateway session lifetime must be one of ${supportedTtlSeconds.join(', ')} seconds`,
      );
    }
    const reason = input.reason.trim();
    if (!reason || reason.length > 256) {
      throw new AgentGatewayPolicyError(
        'INVALID_REQUEST',
        'Gateway session reason must contain between 1 and 256 characters',
      );
    }

    for (const request of this.sessionRequests.values()) {
      if (request.clientId === input.clientId && request.status === 'pending') {
        request.status = 'expired';
      }
    }
    const now = Date.now();
    const request: AgentGatewaySessionRequest = {
      requestId: `request_${crypto.randomUUID()}`,
      kind: 'session-start',
      clientId: input.clientId,
      requestedScopes,
      requestedTtlSeconds: input.requestedTtlSeconds,
      reason,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_REQUEST_TTL_MS).toISOString(),
      status: 'pending',
    };
    this.sessionRequests.set(request.requestId, request);
    return cloneSessionRequest(request);
  }

  requestTabBinding(input: {
    clientId: string;
    sessionId: string;
    reason: string;
  }): AgentGatewaySessionRequest {
    const session = this.getClientSession(input.clientId, input.sessionId);
    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.sessions.delete(session.sessionId);
      throw new AgentGatewayPolicyError(
        'SESSION_EXPIRED',
        'Gateway session has expired',
      );
    }
    const reason = input.reason.trim();
    if (!reason || reason.length > 256) {
      throw new AgentGatewayPolicyError(
        'INVALID_REQUEST',
        'Gateway tab binding reason must contain between 1 and 256 characters',
      );
    }

    for (const request of this.sessionRequests.values()) {
      if (request.clientId === input.clientId && request.status === 'pending') {
        request.status = 'expired';
      }
    }
    const now = Date.now();
    const request: AgentGatewaySessionRequest = {
      requestId: `request_${crypto.randomUUID()}`,
      kind: 'tab-bind',
      clientId: input.clientId,
      requestedScopes: [...session.scopes],
      requestedTtlSeconds: Math.max(
        1,
        Math.ceil((Date.parse(session.expiresAt) - now) / 1000),
      ),
      reason,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_REQUEST_TTL_MS).toISOString(),
      status: 'pending',
      sessionId: session.sessionId,
    };
    this.sessionRequests.set(request.requestId, request);
    return cloneSessionRequest(request);
  }

  getSessionRequest(
    clientId: string,
    requestId: string,
  ): AgentGatewaySessionRequest {
    this.requirePairedClient(clientId);
    const request = this.sessionRequests.get(requestId);
    if (!request || request.clientId !== clientId) {
      throw new AgentGatewayPolicyError(
        'REQUEST_NOT_FOUND',
        'Gateway session request was not found',
      );
    }
    if (request.status === 'pending' && Date.parse(request.expiresAt) <= Date.now()) {
      request.status = 'expired';
    }
    return cloneSessionRequest(request);
  }

  approveSessionRequest(
    clientId: string,
    requestId: string,
    sessionId: string,
  ): AgentGatewaySessionRequest {
    const request = this.getSessionRequest(clientId, requestId);
    if (request.status === 'expired') {
      throw new AgentGatewayPolicyError(
        'REQUEST_EXPIRED',
        'Gateway session request has expired',
      );
    }
    if (request.status !== 'pending') {
      throw new Error('Gateway session request is no longer pending');
    }
    const storedRequest = this.sessionRequests.get(requestId)!;
    storedRequest.status = 'approved';
    storedRequest.sessionId = sessionId;
    return cloneSessionRequest(storedRequest);
  }

  denySessionRequest(
    clientId: string,
    requestId: string,
  ): AgentGatewaySessionRequest {
    const request = this.getSessionRequest(clientId, requestId);
    if (request.status !== 'pending') {
      return request;
    }
    const storedRequest = this.sessionRequests.get(requestId)!;
    storedRequest.status = 'denied';
    return cloneSessionRequest(storedRequest);
  }

  getClientSession(clientId: string, sessionId: string): AgentGatewaySession {
    this.requirePairedClient(clientId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AgentGatewayPolicyError(
        'SESSION_NOT_FOUND',
        'Gateway session not found',
      );
    }
    if (session.clientId !== clientId) {
      throw new AgentGatewayPolicyError(
        'SESSION_CLIENT_MISMATCH',
        'Gateway session belongs to a different client',
      );
    }
    return cloneSession(session);
  }

  endClientSession(clientId: string, sessionId: string): AgentGatewaySession {
    const session = this.getClientSession(clientId, sessionId);
    this.sessions.delete(sessionId);
    return session;
  }

  rebindSession(
    sessionId: string,
    tabId: number,
    origin: string,
    documentId: string,
    documentFingerprint: string,
  ): AgentGatewaySession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AgentGatewayPolicyError(
        'SESSION_NOT_FOUND',
        'Gateway session not found',
      );
    }
    this.requirePairedClient(session.clientId);
    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.sessions.delete(sessionId);
      throw new AgentGatewayPolicyError(
        'SESSION_EXPIRED',
        'Gateway session has expired',
      );
    }
    if (!documentId || !documentFingerprint) {
      throw new AgentGatewayPolicyError(
        'INVALID_REQUEST',
        'Gateway tab binding requires an explicit document binding',
      );
    }
    session.tabId = tabId;
    session.origin = origin;
    session.allowedOrigins = [origin];
    session.documentId = documentId;
    session.documentFingerprint = documentFingerprint;
    session.paused = false;
    session.snapshotSequence = 0;
    return cloneSession(session);
  }

  registerSession(input: Omit<AgentGatewaySession, 'principal' | 'snapshotSequence'>): AgentGatewaySession {
    const client = this.requirePairedClient(input.clientId);
    if (!input.documentId || !input.documentFingerprint) {
      throw new Error('Gateway session requires an explicit document binding');
    }
    if (input.scopes.some((scope) => !client.scopes.includes(scope))) {
      throw new AgentGatewayPolicyError(
        'SCOPE_NOT_GRANTED',
        'Gateway session requested a scope not granted to the paired client',
      );
    }
    const session: AgentGatewaySession = {
      ...input,
      scopes: [...input.scopes],
      allowedOrigins: [...input.allowedOrigins],
      principal: client.principal,
      snapshotSequence: 0,
    };
    this.sessions.set(session.sessionId, session);
    return cloneSession(session);
  }

  endSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  endAllSessions(): void {
    this.sessions.clear();
  }

  pauseSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.paused = true;
    }
  }

  resumeSession(
    sessionId: string,
    documentId: string,
    documentFingerprint: string,
  ): AgentGatewaySession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AgentGatewayPolicyError('SESSION_NOT_FOUND', 'Gateway session not found');
    }
    this.requirePairedClient(session.clientId);
    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.sessions.delete(sessionId);
      throw new AgentGatewayPolicyError('SESSION_EXPIRED', 'Gateway session has expired');
    }
    session.documentId = documentId;
    session.documentFingerprint = documentFingerprint;
    session.paused = false;
    session.snapshotSequence = 0;
    return cloneSession(session);
  }

  pauseSessionsForTab(tabId: number): void {
    for (const session of this.sessions.values()) {
      if (session.tabId === tabId) {
        session.paused = true;
      }
    }
  }

  endSessionsForTab(tabId: number): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.tabId === tabId) {
        this.sessions.delete(sessionId);
      }
    }
  }

  requireSession(
    clientId: string,
    sessionId: string,
    requiredScope: AgentGatewayScope,
  ): AgentGatewaySession {
    const client = this.requirePairedClient(clientId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AgentGatewayPolicyError('SESSION_NOT_FOUND', 'Gateway session not found');
    }
    if (session.clientId !== clientId || session.principal !== client.principal) {
      throw new AgentGatewayPolicyError(
        'SESSION_CLIENT_MISMATCH',
        'Gateway session belongs to a different client',
      );
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      this.sessions.delete(sessionId);
      throw new AgentGatewayPolicyError('SESSION_EXPIRED', 'Gateway session has expired');
    }
    if (session.paused) {
      throw new AgentGatewayPolicyError('SESSION_PAUSED', 'Gateway session is paused');
    }
    if (!client.scopes.includes(requiredScope) || !session.scopes.includes(requiredScope)) {
      throw new AgentGatewayPolicyError(
        'SCOPE_NOT_GRANTED',
        `Gateway scope not granted: ${requiredScope}`,
      );
    }
    return cloneSession(session);
  }

  nextSnapshotRevision(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new AgentGatewayPolicyError('SESSION_NOT_FOUND', 'Gateway session not found');
    }
    session.snapshotSequence += 1;
    return `${session.documentId}:${session.snapshotSequence}:${crypto.randomUUID()}`;
  }

  serializePersistentState(): StoredAgentGatewayState {
    return {
      configuration: { ...this.configuration },
      pairedClients: Array.from(this.pairedClients.values()).map((client) => ({
        ...client,
        scopes: [...client.scopes],
      })),
    };
  }

  private requirePairedClient(clientId: string): PairedAgentGatewayClient {
    if (!this.configuration.enabled) {
      throw new AgentGatewayPolicyError('GATEWAY_DISABLED', 'Agent Gateway is disabled');
    }
    const client = this.pairedClients.get(clientId);
    if (!client) {
      throw new AgentGatewayPolicyError(
        'CLIENT_NOT_PAIRED',
        'Agent Gateway client is not paired',
      );
    }
    if (client.revokedAt) {
      throw new AgentGatewayPolicyError('CLIENT_REVOKED', 'Agent Gateway client was revoked');
    }
    return client;
  }
}

function validateClientId(clientId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(clientId)) {
    throw new Error('Agent Gateway client ID is invalid');
  }
}

function isGatewayScope(scope: string): scope is AgentGatewayScope {
  return scope === GATEWAY_TABS_READ_SCOPE || scope === GATEWAY_PAGE_READ_SCOPE;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function principalForClient(clientId: string): string {
  return `${AGENT_GATEWAY_PRINCIPAL_PREFIX}${clientId}`;
}

function cloneSession(session: AgentGatewaySession): AgentGatewaySession {
  return {
    ...session,
    scopes: [...session.scopes],
    allowedOrigins: [...session.allowedOrigins],
  };
}

function cloneSessionRequest(
  request: AgentGatewaySessionRequest,
): AgentGatewaySessionRequest {
  return {
    ...request,
    requestedScopes: [...request.requestedScopes],
  };
}

export const agentGatewayRegistry = new AgentGatewayRegistry();

let initializationPromise: Promise<void> | null = null;
let targetLifecycleInitialized = false;

export function initializeAgentGateway(): Promise<void> {
  initializeTargetLifecycle();
  if (!initializationPromise) {
    initializationPromise = browserAPI.storage.local
      .get(STORAGE_KEY)
      .then((stored) => {
        agentGatewayRegistry.replacePersistentState(
          stored[STORAGE_KEY] as Partial<StoredAgentGatewayState> | undefined,
        );
        return import('./control-plane');
      })
      .then(({ initializeAgentGatewayControlPlane }) => {
        initializeAgentGatewayControlPlane();
      })
      .catch((error) => {
        console.warn('[Harbor:AgentGateway] Failed to load configuration:', error);
        agentGatewayRegistry.replacePersistentState();
      });
  }
  return initializationPromise;
}

function initializeTargetLifecycle(): void {
  if (targetLifecycleInitialized) {
    return;
  }
  targetLifecycleInitialized = true;
  browserAPI.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url || changeInfo.status === 'loading') {
      agentGatewayRegistry.pauseSessionsForTab(tabId);
    }
  });
  browserAPI.tabs.onRemoved.addListener((tabId) => {
    agentGatewayRegistry.endSessionsForTab(tabId);
  });
}

export async function persistAgentGatewayState(): Promise<void> {
  await browserAPI.storage.local.set({
    [STORAGE_KEY]: agentGatewayRegistry.serializePersistentState(),
  });
}

export async function setGatewayEnabled(enabled: boolean): Promise<void> {
  if (!enabled) {
    agentGatewayRegistry.setEnabled(false);
  }
  await initializeAgentGateway();
  agentGatewayRegistry.setEnabled(enabled);
  await persistAgentGatewayState();
}

export async function syncPairedClients(clients: PairedClientMetadata[]): Promise<void> {
  await initializeAgentGateway();
  agentGatewayRegistry.syncPairedClients(clients);
  await persistAgentGatewayState();
}

export async function revokePairedClient(clientId: string): Promise<void> {
  agentGatewayRegistry.revokeClient(clientId);
  await initializeAgentGateway();
  agentGatewayRegistry.revokeClient(clientId);
  await persistAgentGatewayState();
}

export function invalidateGatewayAuthority(): void {
  agentGatewayRegistry.setEnabled(false);
}

export function invalidatePairedClientAuthority(clientId: string): void {
  agentGatewayRegistry.revokeClient(clientId);
}

export async function startSession(
  input: StartAgentGatewaySessionInput,
): Promise<AgentGatewaySession> {
  await initializeAgentGateway();
  const configuration = agentGatewayRegistry.getConfiguration();
  const ttlSeconds = Math.min(
    input.ttlSeconds ?? configuration.defaultSessionTtlSeconds,
    configuration.maxSessionTtlSeconds,
  );
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('Agent Gateway session TTL must be positive');
  }
  if (!Number.isInteger(input.tabId) || input.tabId < 0) {
    throw new Error('Agent Gateway session tab ID is invalid');
  }
  const origin = new URL(input.origin).origin;
  if (origin !== input.origin || !input.allowedOrigins.includes(origin)) {
    throw new Error('Agent Gateway session origin must be explicitly allowed');
  }
  const documentBinding = await captureDocumentBinding(input.tabId);
  if (documentBinding.origin !== origin) {
    throw new Error('Selected tab no longer matches the approved origin');
  }
  const now = Date.now();
  agentGatewayRegistry.endAllSessions();
  return agentGatewayRegistry.registerSession({
    sessionId: crypto.randomUUID(),
    clientId: input.clientId,
    tabId: input.tabId,
    documentId: crypto.randomUUID(),
    documentFingerprint: documentBinding.documentFingerprint,
    origin,
    scopes: input.scopes,
    allowedOrigins: input.allowedOrigins,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    paused: false,
  });
}

export function endSession(sessionId: string): void {
  agentGatewayRegistry.endSession(sessionId);
}

export function approveSessionRequest(
  clientId: string,
  requestId: string,
  sessionId: string,
): void {
  agentGatewayRegistry.approveSessionRequest(clientId, requestId, sessionId);
}

export function denySessionRequest(
  clientId: string,
  requestId: string,
): void {
  agentGatewayRegistry.denySessionRequest(clientId, requestId);
}

export async function rebindSession(
  sessionId: string,
  tabId: number,
  origin: string,
): Promise<AgentGatewaySession> {
  await initializeAgentGateway();
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new AgentGatewayPolicyError(
      'INVALID_REQUEST',
      'Agent Gateway session tab ID is invalid',
    );
  }
  const normalizedOrigin = new URL(origin).origin;
  if (normalizedOrigin !== origin) {
    throw new AgentGatewayPolicyError(
      'INVALID_REQUEST',
      'Agent Gateway session origin is invalid',
    );
  }
  const documentBinding = await captureDocumentBinding(tabId);
  if (documentBinding.origin !== normalizedOrigin) {
    throw new Error('Selected tab no longer matches the approved origin');
  }
  return agentGatewayRegistry.rebindSession(
    sessionId,
    tabId,
    normalizedOrigin,
    crypto.randomUUID(),
    documentBinding.documentFingerprint,
  );
}

export function pauseSession(sessionId: string): void {
  agentGatewayRegistry.pauseSession(sessionId);
}

export async function resumeSession(sessionId: string): Promise<AgentGatewaySession> {
  await initializeAgentGateway();
  const session = agentGatewayRegistry
    .getAuthoritySnapshot()
    .sessions
    .find((candidate) => candidate.sessionId === sessionId);
  if (!session) {
    throw new AgentGatewayPolicyError('SESSION_NOT_FOUND', 'Gateway session not found');
  }
  const documentBinding = await captureDocumentBinding(session.tabId);
  if (documentBinding.origin !== session.origin) {
    agentGatewayRegistry.pauseSession(sessionId);
    throw new Error('Selected tab no longer matches the approved origin');
  }
  return agentGatewayRegistry.resumeSession(
    sessionId,
    crypto.randomUUID(),
    documentBinding.documentFingerprint,
  );
}

export async function getAgentGatewayAuthoritySnapshot(): Promise<AgentGatewayAuthoritySnapshot> {
  await initializeAgentGateway();
  return agentGatewayRegistry.getAuthoritySnapshot();
}

export const agentGatewayTesting = {
  DEFAULT_CONFIGURATION,
  STORAGE_KEY,
  resetInitialization(): void {
    initializationPromise = null;
    targetLifecycleInitialized = false;
    agentGatewayRegistry.replacePersistentState();
  },
};
