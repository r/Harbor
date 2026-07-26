import {
  boundUtf8,
  ExtensionAgentGatewayBrowserAdapter,
  minimizePublicUrl,
  sanitizeReadableText,
  sanitizeUrl,
  type AgentGatewayBrowserAdapter,
} from './browser-adapter';
import {
  AgentGatewayPolicyError,
  AgentGatewayRegistry,
  agentGatewayRegistry,
  initializeAgentGateway,
} from './registry';
import {
  GATEWAY_PAGE_READ_SCOPE,
  GATEWAY_TABS_READ_SCOPE,
  type AgentGatewayError,
  type AgentGatewayRequest,
  type AgentGatewayResponse,
  type GatewayPageObservation,
  type SafeTabMetadata,
} from './types';

const defaultBrowserAdapter = new ExtensionAgentGatewayBrowserAdapter();

export async function handleAgentGatewayRequest(
  request: AgentGatewayRequest,
  dependencies: {
    registry?: AgentGatewayRegistry;
    browserAdapter?: AgentGatewayBrowserAdapter;
  } = {},
): Promise<AgentGatewayResponse> {
  const registry = dependencies.registry ?? agentGatewayRegistry;
  const browserAdapter = dependencies.browserAdapter ?? defaultBrowserAdapter;
  const requestId = typeof request?.id === 'string' ? request.id : '';

  try {
    validateRequest(request);
    if (registry === agentGatewayRegistry) {
      await initializeAgentGateway();
    }

    switch (request.method) {
      case 'agentGateway.tabs.list':
        return {
          type: 'agent_gateway_response',
          id: request.id,
          result: await handleTabsList(request, registry, browserAdapter),
        };
      case 'agentGateway.page.observe':
        return {
          type: 'agent_gateway_response',
          id: request.id,
          result: await handlePageObserve(request, registry, browserAdapter),
        };
      default:
        return failure(request.id, 'METHOD_NOT_FOUND', 'Agent Gateway method not found');
    }
  } catch (error) {
    if (error instanceof AgentGatewayPolicyError) {
      return failure(requestId, error.code, error.message);
    }
    const gatewayError = error as { code?: AgentGatewayError['code']; message?: string };
    return failure(
      requestId,
      gatewayError.code ?? 'INTERNAL_ERROR',
      gatewayError.message ?? 'Agent Gateway request failed',
    );
  }
}

async function handleTabsList(
  request: AgentGatewayRequest,
  registry: AgentGatewayRegistry,
  browserAdapter: AgentGatewayBrowserAdapter,
) {
  const initialSession = registry.requireSession(
    request.client_id,
    request.session_id,
    GATEWAY_TABS_READ_SCOPE,
  );
  const releaseCall = registry.beginCall(request.client_id, request.session_id);
  try {
    const configuration = registry.getConfiguration();
    let rawTabList;
    try {
      rawTabList = await browserAdapter.listTabs(initialSession.tabId, {
        maxTabs: configuration.maxTabs,
        maxTitleBytes: configuration.maxTabTitleBytes,
        maxUrlBytes: configuration.maxTabUrlBytes,
        maxResultBytes: configuration.maxTabsResultBytes,
      });
    } catch {
      throw Object.assign(new Error('Browser tabs are unavailable'), {
        code: 'TARGET_UNAVAILABLE',
      });
    }
    revalidateSession(
      registry,
      request,
      GATEWAY_TABS_READ_SCOPE,
      initialSession,
    );
    if (
      rawTabList.target.origin !== initialSession.origin
      || rawTabList.target.documentFingerprint
        !== initialSession.documentFingerprint
    ) {
      registry.pauseSession(initialSession.sessionId);
      throw Object.assign(new Error('Bound tab document changed'), {
        code: 'TARGET_CHANGED',
      });
    }

    const tabs: SafeTabMetadata[] = [];
    let truncated = rawTabList.truncated;
    for (const tab of rawTabList.tabs) {
      if (tab.tabId !== initialSession.tabId) {
        truncated = true;
        continue;
      }
      if (tabs.length >= configuration.maxTabs) {
        truncated = true;
        break;
      }
      const url = minimizePublicUrl(
        sanitizeUrl(tab.url),
        configuration.maxTabUrlBytes,
      );
      if (!url) {
        truncated = true;
        continue;
      }
      const title = boundUtf8(
        sanitizeReadableText(tab.title),
        configuration.maxTabTitleBytes,
      );
      if (
        title !== sanitizeReadableText(tab.title)
        || url !== sanitizeUrl(tab.url)
      ) {
        truncated = true;
      }
      tabs.push({
        tabId: tab.tabId,
        windowId: tab.windowId,
        title,
        url,
        active: tab.active === true,
        controllable:
          tab.tabId === initialSession.tabId && tab.controllable === true,
      });
    }

    const result = {
      principal: initialSession.principal,
      sessionId: initialSession.sessionId,
      tabs,
      truncated,
    };
    while (
      result.tabs.length > 0
      && encodedBytes({
        type: 'agent_gateway_response',
        id: request.id,
        result,
      }) > configuration.maxTabsResultBytes
    ) {
      result.tabs.pop();
      result.truncated = true;
    }
    if (encodedBytes({
      type: 'agent_gateway_response',
      id: request.id,
      result,
    }) > configuration.maxTabsResultBytes) {
      throw Object.assign(new Error('Tab result limit is too small'), {
        code: 'INTERNAL_ERROR',
      });
    }

    revalidateSession(
      registry,
      request,
      GATEWAY_TABS_READ_SCOPE,
      initialSession,
    );
    return result;
  } finally {
    releaseCall();
  }
}

async function handlePageObserve(
  request: AgentGatewayRequest,
  registry: AgentGatewayRegistry,
  browserAdapter: AgentGatewayBrowserAdapter,
): Promise<GatewayPageObservation> {
  const initialSession = registry.requireSession(
    request.client_id,
    request.session_id,
    GATEWAY_PAGE_READ_SCOPE,
  );
  const releaseCall = registry.beginCall(request.client_id, request.session_id);
  const configuration = registry.getConfiguration();
  try {
    let rawObservation;
    try {
      rawObservation = await browserAdapter.observePage(
        initialSession.tabId,
        configuration.maxReadableTextBytes,
        configuration.maxElements,
      );
    } catch {
      throw Object.assign(new Error('Bound page is unavailable'), {
        code: 'TARGET_UNAVAILABLE',
      });
    }
    const currentSession = revalidateSession(
      registry,
      request,
      GATEWAY_PAGE_READ_SCOPE,
      initialSession,
    );

    let observedOrigin: string;
    try {
      observedOrigin = new URL(rawObservation.url).origin;
    } catch {
      registry.pauseSession(currentSession.sessionId);
      throw Object.assign(new Error('Bound page returned an invalid URL'), {
        code: 'TARGET_CHANGED',
      });
    }
    if (
      rawObservation.origin !== currentSession.origin
      || observedOrigin !== currentSession.origin
      || !currentSession.allowedOrigins.includes(observedOrigin)
    ) {
      registry.pauseSession(currentSession.sessionId);
      throw Object.assign(new Error('Bound tab navigated outside the approved origin'), {
        code: 'TARGET_CHANGED',
      });
    }
    if (
      currentSession.documentFingerprint
      && rawObservation.documentFingerprint !== currentSession.documentFingerprint
    ) {
      registry.pauseSession(currentSession.sessionId);
      throw Object.assign(new Error('Bound document changed'), {
        code: 'TARGET_CHANGED',
      });
    }
    const sanitizedReadableText = boundUtf8(
      sanitizeReadableText(rawObservation.readableText),
      configuration.maxReadableTextBytes,
    );
    const elements = rawObservation.elements
      .slice(0, configuration.maxElements)
      .map((element) => ({
        ref: crypto.randomUUID(),
        ...(element.role
          ? { role: boundUtf8(sanitizeReadableText(element.role), 50) }
          : {}),
        ...(element.name
          ? {
              name: boundUtf8(
                sanitizeReadableText(element.name),
                200,
              ),
            }
          : {}),
        ...(typeof element.checked === 'boolean'
          ? { checked: element.checked }
          : {}),
        ...(typeof element.disabled === 'boolean'
          ? { disabled: element.disabled }
          : {}),
      }));
    const snapshotRevision = registry.nextSnapshotRevision(currentSession.sessionId);
    const observedAt = new Date().toISOString();
    const result: GatewayPageObservation = {
      sessionId: currentSession.sessionId,
      tabId: currentSession.tabId,
      documentId: currentSession.documentId,
      snapshotRevision,
      origin: observedOrigin,
      url: minimizePublicUrl(
        sanitizeUrl(rawObservation.url),
        configuration.maxTabUrlBytes,
      ),
      title: boundUtf8(
        sanitizeReadableText(rawObservation.title),
        configuration.maxTabTitleBytes,
      ),
      readableText: sanitizedReadableText,
      elements,
      truncated:
        rawObservation.truncated
        || rawObservation.elements.length > configuration.maxElements
        || sanitizedReadableText !== sanitizeReadableText(rawObservation.readableText),
      provenance: {
        source: 'browser',
        tabId: currentSession.tabId,
        documentId: currentSession.documentId,
        origin: observedOrigin,
        observedAt,
        untrusted: true,
      },
    };
    revalidateSession(
      registry,
      request,
      GATEWAY_PAGE_READ_SCOPE,
      currentSession,
    );
    return result;
  } finally {
    releaseCall();
  }
}

function revalidateSession(
  registry: AgentGatewayRegistry,
  request: AgentGatewayRequest,
  scope: typeof GATEWAY_TABS_READ_SCOPE | typeof GATEWAY_PAGE_READ_SCOPE,
  expectedSession: ReturnType<AgentGatewayRegistry['requireSession']>,
) {
  const currentSession = registry.requireSession(
    request.client_id,
    request.session_id,
    scope,
  );
  if (
    currentSession.tabId !== expectedSession.tabId
    || currentSession.documentId !== expectedSession.documentId
    || currentSession.origin !== expectedSession.origin
    || currentSession.documentFingerprint !== expectedSession.documentFingerprint
  ) {
    registry.pauseSession(currentSession.sessionId);
    throw Object.assign(new Error('Gateway session target changed'), {
      code: 'TARGET_CHANGED',
    });
  }
  return currentSession;
}

function encodedBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function validateRequest(request: AgentGatewayRequest): void {
  if (
    !request
    || request.type !== 'agent_gateway_request'
    || typeof request.id !== 'string'
    || !request.id
    || request.id.length > 128
    || typeof request.method !== 'string'
    || typeof request.client_id !== 'string'
    || !request.client_id
    || request.client_id.length > 128
    || typeof request.session_id !== 'string'
    || !request.session_id
    || request.session_id.length > 128
    || !request.params
    || typeof request.params !== 'object'
    || Array.isArray(request.params)
    || Object.keys(request.params).length > 0
  ) {
    throw Object.assign(new Error('Agent Gateway request is malformed'), {
      code: 'INVALID_REQUEST',
    });
  }
}

function failure(
  id: string,
  code: AgentGatewayError['code'],
  message: string,
): AgentGatewayResponse {
  return {
    type: 'agent_gateway_response',
    id,
    error: { code, message },
  };
}
