import {
  GATEWAY_PAGE_READ_SCOPE,
  GATEWAY_TABS_READ_SCOPE,
  type AgentGatewayScope,
} from './types';
import type { PairedClientMetadata } from './registry';

export const AGENT_GATEWAY_APPROVAL_SCOPES = [
  'tabs:list',
  'page:observe',
] as const;

export type AgentGatewayApprovalScope =
  typeof AGENT_GATEWAY_APPROVAL_SCOPES[number];

export interface NativeAgentGatewayClientMetadata {
  id: string;
  displayName: string;
  clientVersion?: string | null;
  createdAt: string;
  scopes?: string[];
  lastAuthenticatedAt?: string | null;
  revoked: boolean;
  revokedAt?: string | null;
}

export interface NativeAgentGatewayConfiguration {
  enabled: boolean;
  clients: NativeAgentGatewayClientMetadata[];
}

export interface ApprovedAgentGatewayClientMetadata {
  clientId: string;
  displayName: string;
  clientVersion?: string;
  pairedAt: string;
  lastAuthenticatedAt?: string;
  scopes: AgentGatewayApprovalScope[];
  revokedAt?: string;
}

export interface NativeAgentGatewayPairing {
  client: NativeAgentGatewayClientMetadata;
  secret: string;
}

export function adaptNativeAgentGatewayClients(
  nativeClients: NativeAgentGatewayClientMetadata[],
  scopeApprovals: ReadonlyMap<string, readonly AgentGatewayApprovalScope[]>,
): ApprovedAgentGatewayClientMetadata[] {
  return nativeClients.map((client) => {
    const nativeScopes = normalizeApprovalScopes(client.scopes ?? []);
    const approvedScopes = nativeScopes.length > 0
      ? nativeScopes
      : scopeApprovals.get(client.id) ?? [];
    return {
      clientId: client.id,
      displayName: client.displayName,
      ...(client.clientVersion ? { clientVersion: client.clientVersion } : {}),
      pairedAt: client.createdAt,
      ...(client.lastAuthenticatedAt
        ? { lastAuthenticatedAt: client.lastAuthenticatedAt }
        : {}),
      scopes: normalizeApprovalScopes(approvedScopes),
      ...(client.revoked
        ? { revokedAt: client.revokedAt ?? client.createdAt }
        : {}),
    };
  });
}

export function toRegistryClientMetadata(
  client: ApprovedAgentGatewayClientMetadata,
): PairedClientMetadata {
  return {
    clientId: client.clientId,
    displayName: client.displayName,
    pairedAt: client.pairedAt,
    ...(client.lastAuthenticatedAt
      ? { lastAuthenticatedAt: client.lastAuthenticatedAt }
      : {}),
    scopes: client.scopes.map(toGatewayScope),
    ...(client.revokedAt ? { revokedAt: client.revokedAt } : {}),
  };
}

export function toGatewayScope(scope: AgentGatewayApprovalScope): AgentGatewayScope {
  switch (scope) {
    case 'tabs:list':
      return GATEWAY_TABS_READ_SCOPE;
    case 'page:observe':
      return GATEWAY_PAGE_READ_SCOPE;
  }
}

export function toApprovalScope(
  scope: AgentGatewayScope,
): AgentGatewayApprovalScope {
  switch (scope) {
    case GATEWAY_TABS_READ_SCOPE:
      return 'tabs:list';
    case GATEWAY_PAGE_READ_SCOPE:
      return 'page:observe';
  }
}

export function normalizeApprovalScopes(
  scopes: readonly string[],
): AgentGatewayApprovalScope[] {
  const approved = new Set<AgentGatewayApprovalScope>();
  for (const scope of scopes) {
    if (scope === 'tabs:list' || scope === 'page:observe') {
      approved.add(scope);
    }
  }
  return AGENT_GATEWAY_APPROVAL_SCOPES.filter((scope) => approved.has(scope));
}
