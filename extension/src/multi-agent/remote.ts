/**
 * Remote A2A Protocol Client
 * 
 * Enables connection to agents running on external servers.
 * 
 * Protocol: Simple JSON-RPC over HTTP/HTTPS
 * 
 * Endpoints Harbor uses:
 * - GET  /agent-info     - Get agent metadata
 * - GET  /health         - Check if agent is reachable
 *
 * Harbor connects to, lists and pings remote agents. It doesn't invoke or
 * message them: nothing called the invoke and message clients, so they were
 * removed rather than left to ship answers without provenance.
 */

import type {
  AgentId,
  RemoteAgentEndpoint,
  RemoteAgentInfo,
  AgentSummary,
} from './types';

// Connected remote agents
const remoteAgents = new Map<AgentId, RemoteAgentInfo>();

// Remote agent ID counter
let remoteIdCounter = 0;

function generateRemoteId(): AgentId {
  return `remote-${Date.now()}-${++remoteIdCounter}`;
}

/**
 * Connect to a remote agent endpoint.
 */
export async function connectRemoteAgent(
  endpoint: RemoteAgentEndpoint,
  headers?: Record<string, string>,
): Promise<RemoteAgentInfo | null> {
  try {
    // Fetch agent info
    const infoUrl = new URL('/agent-info', endpoint.url).toString();
    const response = await fetch(infoUrl, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        ...getAuthHeaders(endpoint),
        ...headers,
      },
    });

    if (!response.ok) {
      console.warn('[RemoteA2A] Failed to connect to', endpoint.url, response.status);
      return null;
    }

    const info = await response.json() as {
      name: string;
      description?: string;
      capabilities?: string[];
    };

    const id = generateRemoteId();
    const remoteAgent: RemoteAgentInfo = {
      id,
      name: info.name,
      description: info.description,
      capabilities: info.capabilities || [],
      endpoint,
      reachable: true,
      lastPing: Date.now(),
    };

    remoteAgents.set(id, remoteAgent);
    console.log('[RemoteA2A] Connected to remote agent:', id, info.name);

    return remoteAgent;
  } catch (error) {
    console.warn('[RemoteA2A] Connection failed:', error);
    return null;
  }
}

/**
 * Disconnect from a remote agent.
 */
export function disconnectRemoteAgent(agentId: AgentId): boolean {
  return remoteAgents.delete(agentId);
}

/**
 * Get a connected remote agent.
 */
export function getRemoteAgent(agentId: AgentId): RemoteAgentInfo | undefined {
  return remoteAgents.get(agentId);
}

/**
 * List all connected remote agents.
 */
export function listRemoteAgents(): RemoteAgentInfo[] {
  return Array.from(remoteAgents.values());
}

/**
 * Check if a remote agent is reachable.
 */
export async function pingRemoteAgent(agentId: AgentId): Promise<boolean> {
  const agent = remoteAgents.get(agentId);
  if (!agent) return false;

  try {
    const healthUrl = new URL('/health', agent.endpoint.url).toString();
    const response = await fetch(healthUrl, {
      method: 'GET',
      headers: getAuthHeaders(agent.endpoint),
    });

    agent.reachable = response.ok;
    agent.lastPing = Date.now();

    return response.ok;
  } catch {
    agent.reachable = false;
    return false;
  }
}

/**
 * Convert remote agents to AgentSummary format for discovery.
 */
export function getRemoteAgentSummaries(): AgentSummary[] {
  return Array.from(remoteAgents.values())
    .filter(a => a.reachable)
    .map(a => ({
      id: a.id,
      name: a.name,
      description: a.description,
      origin: new URL(a.endpoint.url).origin,
      capabilities: a.capabilities,
      tags: ['remote'],
      acceptsInvocations: true,
      acceptsMessages: true,
      sameOrigin: false,
      isRemote: true,
    }));
}

/**
 * Get auth headers for a remote endpoint.
 */
function getAuthHeaders(endpoint: RemoteAgentEndpoint): Record<string, string> {
  // Auth headers would be configured per-endpoint
  // For now, return empty - in production, this would look up stored credentials
  return {};
}

/**
 * Discover remote agents from a well-known URL.
 * 
 * Some servers may publish a list of available agents at /.well-known/agents
 */
export async function discoverRemoteAgents(
  baseUrl: string,
): Promise<Array<{ name: string; url: string; description?: string }>> {
  try {
    const discoveryUrl = new URL('/.well-known/agents', baseUrl).toString();
    const response = await fetch(discoveryUrl, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as {
      agents?: Array<{ name: string; url: string; description?: string }>;
    };

    return data.agents || [];
  } catch {
    return [];
  }
}
