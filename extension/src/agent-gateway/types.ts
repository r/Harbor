export const AGENT_GATEWAY_PRINCIPAL_PREFIX = 'agent-gateway:';

export const GATEWAY_TABS_READ_SCOPE = 'gateway:tabs.read';
export const GATEWAY_PAGE_READ_SCOPE = 'gateway:page.read';

export type AgentGatewayScope =
  | typeof GATEWAY_TABS_READ_SCOPE
  | typeof GATEWAY_PAGE_READ_SCOPE;

export interface AgentGatewayConfiguration {
  enabled: boolean;
  defaultSessionTtlSeconds: number;
  maxSessionTtlSeconds: number;
  maxConcurrentCallsPerSession: number;
  maxTabs: number;
  maxTabTitleBytes: number;
  maxTabUrlBytes: number;
  maxTabsResultBytes: number;
  maxReadableTextBytes: number;
  maxElements: number;
}

export interface PairedAgentGatewayClient {
  clientId: string;
  displayName: string;
  principal: string;
  scopes: AgentGatewayScope[];
  pairedAt: string;
  revokedAt?: string;
}

export interface AgentGatewaySession {
  sessionId: string;
  clientId: string;
  principal: string;
  tabId: number;
  documentId: string;
  documentFingerprint: string;
  origin: string;
  scopes: AgentGatewayScope[];
  allowedOrigins: string[];
  createdAt: string;
  expiresAt: string;
  paused: boolean;
  snapshotSequence: number;
}

export interface AgentGatewayRequest {
  type: 'agent_gateway_request';
  id: string;
  method: 'agentGateway.tabs.list' | 'agentGateway.page.observe';
  client_id: string;
  session_id: string;
  params: Record<string, unknown>;
}

export interface AgentGatewayError {
  code:
    | 'GATEWAY_DISABLED'
    | 'INVALID_REQUEST'
    | 'CLIENT_NOT_PAIRED'
    | 'CLIENT_REVOKED'
    | 'SESSION_NOT_FOUND'
    | 'SESSION_EXPIRED'
    | 'SESSION_PAUSED'
    | 'SESSION_CLIENT_MISMATCH'
    | 'SCOPE_NOT_GRANTED'
    | 'TOO_MANY_REQUESTS'
    | 'TARGET_UNAVAILABLE'
    | 'TARGET_CHANGED'
    | 'METHOD_NOT_FOUND'
    | 'INTERNAL_ERROR';
  message: string;
}

export interface AgentGatewayResponse {
  type: 'agent_gateway_response';
  id: string;
  result?: unknown;
  error?: AgentGatewayError;
}

export interface SafeTabMetadata {
  tabId: number;
  windowId: number;
  title: string;
  url: string;
  active: boolean;
  controllable: boolean;
}

export interface SafeTabListResult {
  tabs: SafeTabMetadata[];
  truncated: boolean;
  target: {
    origin: string;
    documentFingerprint: string;
  };
}

export interface SafeTabListLimits {
  maxTabs: number;
  maxTitleBytes: number;
  maxUrlBytes: number;
  maxResultBytes: number;
}

export interface GatewayElementMetadata {
  ref: string;
  role?: string;
  name?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface GatewayPageObservation {
  sessionId: string;
  tabId: number;
  documentId: string;
  snapshotRevision: string;
  origin: string;
  url: string;
  title: string;
  readableText: string;
  elements: GatewayElementMetadata[];
  truncated: boolean;
  provenance: {
    source: 'browser';
    tabId: number;
    documentId: string;
    origin: string;
    observedAt: string;
    untrusted: true;
  };
}

export interface RawPageElement {
  role?: string;
  name?: string;
  checked?: boolean;
  disabled?: boolean;
}

export interface RawPageObservation {
  url: string;
  origin: string;
  title: string;
  readableText: string;
  elements: RawPageElement[];
  documentFingerprint: string;
  truncated: boolean;
}
