import { browserAPI } from '../../browser-compat';
import { consumeSourceTabLaunchEnvelope } from '../../chat-launch';
import type {
  CapturedPageContext,
  ChatPermissionScope,
  PermissionDecision,
  PermissionPlan,
  SourceTabLaunchEnvelope,
  SourceTabReference,
} from '../contracts';
import type {
  ChatPermissionPort,
  SourceTabPort,
} from '../services';
import type {
  AgentRunPort,
  TextGenerationPort,
  TextSessionPort,
} from '../features/run/run-types';
import type { ChatTransport } from './chat-transport';

type PermissionGrant =
  | 'granted-once'
  | 'granted-always'
  | 'denied'
  | 'not-granted';

type PermissionStatusResponse = {
  scopes: Partial<Record<ChatPermissionScope, PermissionGrant>>;
};

export type CachedSourceTabPort = SourceTabPort & {
  getResolvedSource(): SourceTabReference | undefined;
};

export function createBrowserSourceTabPort(
  transport: ChatTransport,
): CachedSourceTabPort {
  const resolvedLaunches = new Map<string, SourceTabLaunchEnvelope | null>();

  return {
    async resolveLaunch(launchId) {
      if (resolvedLaunches.has(launchId)) {
        return resolvedLaunches.get(launchId) ?? null;
      }

      const envelope = await consumeSourceTabLaunchEnvelope(
        browserAPI.storage.local,
        launchId,
      );
      resolvedLaunches.set(launchId, envelope);
      return envelope;
    },

    async inspect(source) {
      try {
        const tab = await browserAPI.tabs.get(source.tabId);
        if (
          tab.id === undefined
          || tab.windowId === undefined
          || !tab.url
        ) {
          return null;
        }

        const url = new URL(tab.url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return null;
        }

        return {
          tabId: tab.id,
          windowId: tab.windowId,
          url: url.toString(),
          title: tab.title?.trim() || url.hostname,
          origin: url.origin,
        };
      } catch {
        return null;
      }
    },

    async capture(source) {
      const result = await transport.request<{
        title: string;
        url: string;
        text: string;
      }>(
        'agent.browser.activeTab.readability',
        undefined,
        source,
      );
      return normalizeCapturedPageContext(result);
    },

    getResolvedSource() {
      for (const envelope of resolvedLaunches.values()) {
        if (envelope) {
          return envelope.source;
        }
      }
      return undefined;
    },
  };
}

export function createChatPermissionPort(
  transport: ChatTransport,
  sourceTabPort: CachedSourceTabPort,
): ChatPermissionPort {
  return {
    async list() {
      const chatStatus = await readPermissionStatus(transport);
      const source = sourceTabPort.getResolvedSource();
      const sourceStatus = source
        ? await readPermissionStatus(transport, source)
        : undefined;
      const result: Partial<
        Record<ChatPermissionScope, 'granted' | 'denied'>
      > = {};

      for (const scope of CHAT_PERMISSION_SCOPES) {
        const status = scope === 'browser:activeTab.read'
          ? sourceStatus
          : chatStatus;
        const grant = status?.scopes[scope];
        if (grant === 'granted-always' || grant === 'granted-once') {
          result[scope] = 'granted';
        } else if (grant === 'denied') {
          result[scope] = 'denied';
        }
      }
      return result;
    },

    async request(plan) {
      const chatScopes = plan.scopes.filter(
        scope => scope !== 'browser:activeTab.read',
      );
      const sourceScopes = plan.scopes.filter(
        scope => scope === 'browser:activeTab.read',
      );
      const decisions: PermissionDecision[] = [];

      if (chatScopes.length > 0) {
        decisions.push(await requestPermissionGroup(
          transport,
          {
            ...plan,
            scopes: chatScopes,
          },
        ));
      }

      if (sourceScopes.length > 0) {
        const source = sourceTabPort.getResolvedSource();
        if (!source) {
          return {
            kind: 'unavailable',
            message: 'The source page is no longer available.',
          };
        }
        decisions.push(await requestPermissionGroup(
          transport,
          {
            ...plan,
            scopes: sourceScopes,
            toolAllowlist: [],
          },
          source,
        ));
      }

      return mergePermissionDecisions(plan.scopes, decisions);
    },
  };
}

export function createTransportTextGenerationPort(
  transport: ChatTransport,
): TextGenerationPort {
  return {
    async createTextSession(options = {}) {
      const sessionId = await transport.request<string>(
        'ai.createTextSession',
        options,
      );

      return {
        async *promptStreaming(input: string) {
          const output = await transport.request<string>(
            'session.prompt',
            { sessionId, input },
          );
          yield output;
        },
        destroy() {
          return transport.request<void>(
            'session.destroy',
            { sessionId },
          );
        },
      } satisfies TextSessionPort;
    },
  };
}

export function createTransportAgentRunPort(
  transport: ChatTransport,
): AgentRunPort {
  return {
    run(options) {
      const {
        signal,
        ...payload
      } = options;
      return transport.stream(
        'agent.run',
        payload,
        undefined,
        signal,
      );
    },
  };
}

export async function listConnectedToolNames(): Promise<string[]> {
  const response = await browserAPI.runtime.sendMessage({
    type: 'sidebar_get_servers',
  }) as {
    ok?: boolean;
    error?: string;
    servers?: Array<{
      id?: string;
      running?: boolean;
      tools?: Array<{ name?: string }>;
    }>;
  };
  if (response.ok !== true || !Array.isArray(response.servers)) {
    throw new Error(response.error || 'Tool discovery failed');
  }

  const toolNames = new Set<string>();
  for (const server of response.servers) {
    if (!server.running || !server.id || !Array.isArray(server.tools)) {
      continue;
    }
    for (const tool of server.tools) {
      if (tool.name) {
        toolNames.add(`${server.id}/${tool.name}`);
      }
    }
  }
  return Array.from(toolNames);
}

const CHAT_PERMISSION_SCOPES: ChatPermissionScope[] = [
  'model:prompt',
  'model:tools',
  'mcp:tools.list',
  'mcp:tools.call',
  'browser:activeTab.read',
];

async function readPermissionStatus(
  transport: ChatTransport,
  source?: SourceTabReference,
): Promise<PermissionStatusResponse> {
  return transport.request(
    'agent.permissions.list',
    undefined,
    source,
  );
}

async function requestPermissionGroup(
  transport: ChatTransport,
  plan: PermissionPlan,
  source?: SourceTabReference,
): Promise<PermissionDecision> {
  let response: PermissionStatusResponse & { granted: boolean };
  try {
    response = await transport.request(
      'agent.requestPermissions',
      {
        scopes: plan.scopes,
        reason: plan.reason,
        tools: plan.toolAllowlist.length > 0
          ? plan.toolAllowlist
          : undefined,
      },
      source,
    );
  } catch (error) {
    return {
      kind: 'unavailable',
      message: error instanceof Error
        ? error.message
        : 'Harbor could not request access.',
    };
  }

  const granted = plan.scopes.filter(scope =>
    response.scopes[scope] === 'granted-always'
    || response.scopes[scope] === 'granted-once'
  );
  const denied = plan.scopes.filter(
    scope => response.scopes[scope] === 'denied',
  );
  const unresolved = plan.scopes.filter(
    scope => !granted.includes(scope) && !denied.includes(scope),
  );

  if (granted.length === plan.scopes.length && response.granted) {
    return { kind: 'granted', scopes: granted };
  }
  if (denied.length === plan.scopes.length) {
    return { kind: 'denied', scopes: denied };
  }
  if (granted.length > 0) {
    return {
      kind: 'partial',
      granted,
      denied: [...denied, ...unresolved],
    };
  }
  if (denied.length > 0) {
    return { kind: 'denied', scopes: denied };
  }
  return { kind: 'dismissed' };
}

function mergePermissionDecisions(
  requestedScopes: ChatPermissionScope[],
  decisions: PermissionDecision[],
): PermissionDecision {
  const unavailable = decisions.find(
    decision => decision.kind === 'unavailable',
  );
  if (unavailable?.kind === 'unavailable') {
    return unavailable;
  }

  const granted = new Set<ChatPermissionScope>();
  const denied = new Set<ChatPermissionScope>();
  let dismissed = false;

  for (const decision of decisions) {
    if (decision.kind === 'granted') {
      decision.scopes.forEach(scope => granted.add(scope));
    } else if (decision.kind === 'partial') {
      decision.granted.forEach(scope => granted.add(scope));
      decision.denied.forEach(scope => denied.add(scope));
    } else if (decision.kind === 'denied') {
      decision.scopes.forEach(scope => denied.add(scope));
    } else if (decision.kind === 'dismissed') {
      dismissed = true;
    }
  }

  const orderedGranted = requestedScopes.filter(scope => granted.has(scope));
  const orderedDenied = requestedScopes.filter(
    scope => denied.has(scope) || (dismissed && !granted.has(scope)),
  );
  if (orderedGranted.length === requestedScopes.length) {
    return { kind: 'granted', scopes: orderedGranted };
  }
  if (orderedGranted.length > 0) {
    return {
      kind: 'partial',
      granted: orderedGranted,
      denied: orderedDenied,
    };
  }
  if (orderedDenied.length > 0) {
    return { kind: 'denied', scopes: orderedDenied };
  }
  return { kind: 'dismissed' };
}

function normalizeCapturedPageContext(
  result: {
    title: string;
    url: string;
    text: string;
  },
): CapturedPageContext {
  return {
    title: result.title,
    url: result.url,
    text: result.text,
    capturedAt: Date.now(),
  };
}
