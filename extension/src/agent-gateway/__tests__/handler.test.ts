import { beforeEach, describe, expect, it } from 'vitest';
import {
  ExtensionAgentGatewayBrowserAdapter,
  agentGatewayBrowserTesting,
  type AgentGatewayBrowserAdapter,
} from '../browser-adapter';
import { handleAgentGatewayRequest } from '../handler';
import { AgentGatewayRegistry } from '../registry';
import {
  GATEWAY_PAGE_READ_SCOPE,
  GATEWAY_TABS_READ_SCOPE,
  type AgentGatewayRequest,
} from '../types';

const CLIENT_ID = 'agent-client-1';
const SESSION_ID = 'gateway-session-1';
const DOCUMENT_ID = 'document-1';
const ORIGIN = 'https://example.com';

function request(
  method: AgentGatewayRequest['method'],
  overrides: Partial<AgentGatewayRequest> = {},
): AgentGatewayRequest {
  return {
    type: 'agent_gateway_request',
    id: 'request-1',
    method,
    client_id: CLIENT_ID,
    session_id: SESSION_ID,
    params: {},
    ...overrides,
  };
}

function configuredRegistry(): AgentGatewayRegistry {
  const registry = new AgentGatewayRegistry();
  registry.setEnabled(true);
  registry.pairClient(CLIENT_ID, 'Test Agent', [
    GATEWAY_TABS_READ_SCOPE,
    GATEWAY_PAGE_READ_SCOPE,
  ]);
  registry.registerSession({
    sessionId: SESSION_ID,
    clientId: CLIENT_ID,
    tabId: 42,
    documentId: DOCUMENT_ID,
    documentFingerprint: 'fingerprint-1',
    origin: ORIGIN,
    scopes: [GATEWAY_TABS_READ_SCOPE, GATEWAY_PAGE_READ_SCOPE],
    allowedOrigins: [ORIGIN],
    createdAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    paused: false,
  });
  return registry;
}

function browserAdapter(): AgentGatewayBrowserAdapter {
  return {
    async listTabs(boundTabId) {
      return {
        tabs: [
          {
            tabId: 42,
            windowId: 7,
            title: 'Example',
            url: 'https://example.com/',
            active: true,
            controllable: boundTabId === 42,
          },
        ],
        truncated: false,
        target: {
          origin: ORIGIN,
          documentFingerprint: 'fingerprint-1',
        },
      };
    },
    async observePage() {
      return {
        url: 'https://example.com/account?access_token=secret-value#private',
        origin: ORIGIN,
        title: 'Account access token: abcdefghijkl',
        readableText: 'Password: swordfish\nBearer abcdefghijklmnop',
        elements: [
          {
            role: 'textbox',
            name: 'Email',
            disabled: false,
          },
        ],
        documentFingerprint: 'fingerprint-1',
        truncated: false,
      };
    },
  };
}

describe('Agent Gateway request handler', () => {
  let registry: AgentGatewayRegistry;

  beforeEach(() => {
    registry = configuredRegistry();
  });

  it('denies requests while the feature is disabled', async () => {
    registry.setEnabled(false);

    const response = await handleAgentGatewayRequest(
      request('agentGateway.tabs.list'),
      { registry, browserAdapter: browserAdapter() },
    );

    expect(response.error?.code).toBe('GATEWAY_DISABLED');
  });

  it('creates a bounded user approval request for a new session', async () => {
    const response = await handleAgentGatewayRequest(
      request('agentGateway.session.start', {
        session_id: null,
        params: {
          requestedScopes: ['page:observe'],
          ttlSeconds: 900,
          reason: 'Review the selected page',
        },
      }),
      { registry, browserAdapter: browserAdapter() },
    );
    const result = response.result as {
      requestId: string;
      status: string;
      requestedScopes: string[];
    };

    expect(response.error).toBeUndefined();
    expect(result.requestId).toMatch(/^request_/);
    expect(result.status).toBe('pending');
    expect(result.requestedScopes).toEqual(['page:observe']);
    expect(registry.getAuthoritySnapshot().sessionRequests).toHaveLength(1);
  });

  it('reports approval state and lets the owning client end its session', async () => {
    const startResponse = await handleAgentGatewayRequest(
      request('agentGateway.session.start', {
        session_id: null,
        params: {
          requestedScopes: ['tabs:list'],
          ttlSeconds: 300,
          reason: 'List the shared tab',
        },
      }),
      { registry, browserAdapter: browserAdapter() },
    );
    const requestId = (startResponse.result as { requestId: string }).requestId;
    registry.approveSessionRequest(CLIENT_ID, requestId, SESSION_ID);

    const statusResponse = await handleAgentGatewayRequest(
      request('agentGateway.session.status', {
        session_id: null,
        params: { requestId },
      }),
      { registry, browserAdapter: browserAdapter() },
    );
    expect(statusResponse.result).toEqual(expect.objectContaining({
      requestId,
      status: 'approved',
      session: expect.objectContaining({ sessionId: SESSION_ID }),
    }));

    const endResponse = await handleAgentGatewayRequest(
      request('agentGateway.session.end'),
      { registry, browserAdapter: browserAdapter() },
    );
    expect(endResponse.result).toEqual({
      sessionId: SESSION_ID,
      status: 'ended',
    });

    const observeResponse = await handleAgentGatewayRequest(
      request('agentGateway.page.observe'),
      { registry, browserAdapter: browserAdapter() },
    );
    expect(observeResponse.error?.code).toBe('SESSION_NOT_FOUND');
  });

  it('turns a tab binding request into explicit user approval', async () => {
    const response = await handleAgentGatewayRequest(
      request('agentGateway.tabs.bind', {
        params: { reason: 'Continue the review in the selected tab' },
      }),
      { registry, browserAdapter: browserAdapter() },
    );
    const result = response.result as {
      requestId: string;
      status: string;
      sessionId: string;
    };

    expect(response.error).toBeUndefined();
    expect(result.status).toBe('pending');
    expect(result.sessionId).toBe(SESSION_ID);
    expect(registry.getSessionRequest(CLIENT_ID, result.requestId)).toEqual(
      expect.objectContaining({
        kind: 'tab-bind',
        sessionId: SESSION_ID,
        status: 'pending',
      }),
    );
  });

  it('does not let a session request exceed paired client scopes', async () => {
    registry.syncPairedClients([{
      clientId: CLIENT_ID,
      displayName: 'Test Agent',
      scopes: [GATEWAY_TABS_READ_SCOPE],
      pairedAt: new Date().toISOString(),
    }]);

    const response = await handleAgentGatewayRequest(
      request('agentGateway.session.start', {
        session_id: null,
        params: {
          requestedScopes: ['page:observe'],
          ttlSeconds: 900,
          reason: 'Read the selected page',
        },
      }),
      { registry, browserAdapter: browserAdapter() },
    );

    expect(response.error?.code).toBe('SCOPE_NOT_GRANTED');
  });

  it('accepts only session lifetimes represented by the approval UI', async () => {
    const response = await handleAgentGatewayRequest(
      request('agentGateway.session.start', {
        session_id: null,
        params: {
          requestedScopes: ['tabs:list'],
          ttlSeconds: 600,
          reason: 'List the selected tab',
        },
      }),
      { registry, browserAdapter: browserAdapter() },
    );

    expect(response.error).toEqual({
      code: 'INVALID_REQUEST',
      message: 'Gateway session lifetime must be one of 300, 900, 3600 seconds',
    });
  });

  it('rejects missing session identity and unexpected parameters', async () => {
    const missingSessionResponse = await handleAgentGatewayRequest(
      request('agentGateway.tabs.list', { session_id: '' }),
      { registry, browserAdapter: browserAdapter() },
    );
    const unexpectedParamsResponse = await handleAgentGatewayRequest(
      request('agentGateway.tabs.list', { params: { tabId: 42 } }),
      { registry, browserAdapter: browserAdapter() },
    );

    expect(missingSessionResponse.error?.code).toBe('INVALID_REQUEST');
    expect(unexpectedParamsResponse.error?.code).toBe('INVALID_REQUEST');
  });

  it('does not accept an unpaired client or a different client session', async () => {
    const unpairedResponse = await handleAgentGatewayRequest(
      request('agentGateway.tabs.list', { client_id: 'unknown-client' }),
      { registry, browserAdapter: browserAdapter() },
    );
    expect(unpairedResponse.error?.code).toBe('CLIENT_NOT_PAIRED');

    registry.pairClient('other-client', 'Other Agent', [GATEWAY_TABS_READ_SCOPE]);
    const mismatchedResponse = await handleAgentGatewayRequest(
      request('agentGateway.tabs.list', { client_id: 'other-client' }),
      { registry, browserAdapter: browserAdapter() },
    );
    expect(mismatchedResponse.error?.code).toBe('SESSION_CLIENT_MISMATCH');
  });

  it('returns only safe tab metadata under the gateway principal', async () => {
    const response = await handleAgentGatewayRequest(
      request('agentGateway.tabs.list'),
      { registry, browserAdapter: browserAdapter() },
    );

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({
      principal: 'agent-gateway:agent-client-1',
      sessionId: SESSION_ID,
      tabs: [
        {
          tabId: 42,
          windowId: 7,
          title: 'Example',
          url: 'https://example.com/',
          active: true,
          controllable: true,
        },
      ],
      truncated: false,
    });
  });

  it('never returns unrelated tabs or bound-tab path and query secrets', async () => {
    const unsafeAdapter = browserAdapter();
    unsafeAdapter.listTabs = async () => ({
      tabs: [
        {
          tabId: 42,
          windowId: 7,
          title: 'Approved',
          url: 'https://example.com/private/path-secret?view=query-secret',
          active: true,
          controllable: true,
        },
        {
          tabId: 99,
          windowId: 7,
          title: 'Unrelated private tab',
          url: 'https://unrelated.example/private?value=secret',
          active: false,
          controllable: false,
        },
      ],
      truncated: false,
      target: {
        origin: ORIGIN,
        documentFingerprint: 'fingerprint-1',
      },
    });

    const response = await handleAgentGatewayRequest(
      request('agentGateway.tabs.list'),
      { registry, browserAdapter: unsafeAdapter },
    );
    const serializedResponse = JSON.stringify(response);

    expect((response.result as { tabs: Array<{ tabId: number; url: string }> }).tabs)
      .toEqual([expect.objectContaining({
        tabId: 42,
        url: 'https://example.com/',
      })]);
    expect(serializedResponse).not.toContain('path-secret');
    expect(serializedResponse).not.toContain('query-secret');
    expect(serializedResponse).not.toContain('unrelated');
  });

  it('enforces the complete tab response byte bound against adapter output', async () => {
    const oversizedAdapter = browserAdapter();
    oversizedAdapter.listTabs = async () => ({
      tabs: Array.from({ length: 100 }, (_, index) => ({
        tabId: index === 0 ? 42 : index + 100,
        windowId: 1,
        title: 't'.repeat(2_000),
        url: `https://example.com/path?view=${'a'.repeat(3_500)}${index}`,
        active: false,
        controllable: false,
      })),
      truncated: false,
      target: {
        origin: ORIGIN,
        documentFingerprint: 'fingerprint-1',
      },
    });

    const response = await handleAgentGatewayRequest(
      request('agentGateway.tabs.list'),
      { registry, browserAdapter: oversizedAdapter },
    );
    const result = response.result as { truncated: boolean; tabs: unknown[] };

    expect(response.error).toBeUndefined();
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength)
      .toBeLessThanOrEqual(registry.getConfiguration().maxTabsResultBytes);
  });

  it('returns a bounded observation without form values or credential-shaped text', async () => {
    const response = await handleAgentGatewayRequest(
      request('agentGateway.page.observe'),
      { registry, browserAdapter: browserAdapter() },
    );
    const result = response.result as {
      url: string;
      title: string;
      readableText: string;
      elements: Array<Record<string, unknown>>;
      documentId: string;
      provenance: { untrusted: boolean };
    };

    expect(response.error).toBeUndefined();
    expect(result.documentId).toBe(DOCUMENT_ID);
    expect(result.url).toBe('https://example.com/');
    expect(result.title).toBe('Account access token: [REDACTED]');
    expect(result.readableText).toBe('Password: [REDACTED]\nBearer [REDACTED]');
    expect(result.elements[0]).not.toHaveProperty('value');
    expect(result.provenance.untrusted).toBe(true);
  });

  it('sanitizes credential-shaped accessible names', async () => {
    const unsafeNameAdapter = browserAdapter();
    unsafeNameAdapter.observePage = async () => ({
      url: 'https://example.com/',
      origin: ORIGIN,
      title: 'Example',
      readableText: '',
      elements: [
        {
          role: 'textbox',
          name: 'Password: exposed-secret',
        },
      ],
      documentFingerprint: 'fingerprint-1',
      truncated: false,
    });

    const response = await handleAgentGatewayRequest(
      request('agentGateway.page.observe'),
      { registry, browserAdapter: unsafeNameAdapter },
    );
    const result = response.result as {
      elements: Array<{ name?: string }>;
    };

    expect(result.elements[0].name).toBe('Password: [REDACTED]');
  });

  it('pauses the session when the bound document changes', async () => {
    const changedDocumentAdapter = browserAdapter();
    changedDocumentAdapter.observePage = async () => ({
      url: 'https://example.com/',
      origin: ORIGIN,
      title: 'Example',
      readableText: '',
      elements: [],
      documentFingerprint: 'fingerprint-2',
      truncated: false,
    });

    const changedResponse = await handleAgentGatewayRequest(
      request('agentGateway.page.observe'),
      { registry, browserAdapter: changedDocumentAdapter },
    );
    const retryResponse = await handleAgentGatewayRequest(
      request('agentGateway.page.observe'),
      { registry, browserAdapter: changedDocumentAdapter },
    );

    expect(changedResponse.error?.code).toBe('TARGET_CHANGED');
    expect(retryResponse.error?.code).toBe('SESSION_PAUSED');
  });

  it('scrubs credentials from URLs and readable content', () => {
    expect(
      agentGatewayBrowserTesting.sanitizeUrl(
        'https://user:pass@example.com/path?token=secret&view=full#fragment',
      ),
    ).toBe('https://example.com/path?token=%5BREDACTED%5D&view=full');
    expect(
      agentGatewayBrowserTesting.minimizePublicUrl(
        'https://example.com/path-secret?view=query-secret',
        4_096,
      ),
    ).toBe('https://example.com/');
    expect(
      agentGatewayBrowserTesting.sanitizeReadableText(
        'api_key=abcdefghijklmnop Bearer secret-token-value',
      ),
    ).toBe('api_key=[REDACTED]');
  });

  it('rejects data after a client is revoked during an awaited read', async () => {
    let resolveTabList!: (value: Awaited<ReturnType<AgentGatewayBrowserAdapter['listTabs']>>) => void;
    const pendingAdapter = browserAdapter();
    pendingAdapter.listTabs = () => new Promise((resolve) => {
      resolveTabList = resolve;
    });
    const pendingResponse = handleAgentGatewayRequest(
      request('agentGateway.tabs.list'),
      { registry, browserAdapter: pendingAdapter },
    );
    await Promise.resolve();

    registry.revokeClient(CLIENT_ID);
    resolveTabList({
      tabs: [{
        tabId: 42,
        windowId: 7,
        title: 'Must not escape',
        url: 'https://example.com/',
        active: true,
        controllable: true,
      }],
      truncated: false,
      target: {
        origin: ORIGIN,
        documentFingerprint: 'fingerprint-1',
      },
    });

    expect((await pendingResponse).error?.code).toBe('CLIENT_REVOKED');
  });

  it('rejects data after the gateway is disabled during an awaited read', async () => {
    let resolveTabList!: (
      value: Awaited<ReturnType<AgentGatewayBrowserAdapter['listTabs']>>,
    ) => void;
    const pendingAdapter = browserAdapter();
    pendingAdapter.listTabs = () => new Promise((resolve) => {
      resolveTabList = resolve;
    });
    const pendingResponse = handleAgentGatewayRequest(
      request('agentGateway.tabs.list'),
      { registry, browserAdapter: pendingAdapter },
    );
    await Promise.resolve();

    registry.setEnabled(false);
    resolveTabList({
      tabs: [{
        tabId: 42,
        windowId: 7,
        title: 'Must not escape',
        url: 'https://example.com/',
        active: true,
        controllable: true,
      }],
      truncated: false,
      target: {
        origin: ORIGIN,
        documentFingerprint: 'fingerprint-1',
      },
    });

    expect((await pendingResponse).error?.code).toBe('GATEWAY_DISABLED');
  });

  it('rejects data after navigation pauses an awaited observation', async () => {
    let resolveObservation!: (
      value: Awaited<ReturnType<AgentGatewayBrowserAdapter['observePage']>>,
    ) => void;
    const pendingAdapter = browserAdapter();
    pendingAdapter.observePage = () => new Promise((resolve) => {
      resolveObservation = resolve;
    });
    const pendingResponse = handleAgentGatewayRequest(
      request('agentGateway.page.observe'),
      { registry, browserAdapter: pendingAdapter },
    );
    await Promise.resolve();

    registry.pauseSessionsForTab(42);
    resolveObservation({
      url: 'https://example.com/',
      origin: ORIGIN,
      title: 'Must not escape',
      readableText: 'Must not escape',
      elements: [],
      documentFingerprint: 'fingerprint-1',
      truncated: false,
    });

    expect((await pendingResponse).error?.code).toBe('SESSION_PAUSED');
  });

  it('limits concurrent in-flight requests per session', async () => {
    const resolvers: Array<
      (value: Awaited<ReturnType<AgentGatewayBrowserAdapter['listTabs']>>) => void
    > = [];
    const pendingAdapter = browserAdapter();
    pendingAdapter.listTabs = () => new Promise((resolve) => {
      resolvers.push(resolve);
    });
    const pendingResponses = Array.from({ length: 4 }, () =>
      handleAgentGatewayRequest(
        request('agentGateway.tabs.list'),
        { registry, browserAdapter: pendingAdapter },
      ),
    );
    await Promise.resolve();

    const rejectedResponse = await handleAgentGatewayRequest(
      request('agentGateway.tabs.list'),
      { registry, browserAdapter: pendingAdapter },
    );
    expect(rejectedResponse.error?.code).toBe('TOO_MANY_REQUESTS');

    for (const resolve of resolvers) {
      resolve({
        tabs: [],
        truncated: false,
        target: {
          origin: ORIGIN,
          documentFingerprint: 'fingerprint-1',
        },
      });
    }
    expect((await Promise.all(pendingResponses)).every((response) => !response.error)).toBe(true);
  });
});

describe('Agent Gateway browser extraction', () => {
  it('rejects a privileged bound tab without returning its title', async () => {
    const originalGet = chrome.tabs.get;
    chrome.tabs.get = async () =>
      tab(5, 'about:config', 'Private internal title');

    try {
      await expect(
        new ExtensionAgentGatewayBrowserAdapter().listTabs(5, {
          maxTabs: 100,
          maxTitleBytes: 512,
          maxUrlBytes: 4_096,
          maxResultBytes: 131_072,
        }),
      ).rejects.toThrow('unavailable or privileged');
    } finally {
      chrome.tabs.get = originalGet;
    }
  });

  it('reads only the bound tab and returns an origin-only URL', async () => {
    const chromeTabs = chrome.tabs as typeof chrome.tabs & {
      query: typeof chrome.tabs.query;
    };
    const chromeWithScripting = chrome as typeof chrome & {
      scripting: typeof chrome.scripting;
    };
    const originalQuery = chromeTabs.query;
    const originalGet = chromeTabs.get;
    const originalScripting = chromeWithScripting.scripting;
    chromeTabs.query = async () => {
      throw new Error('tabs.query must not be used by the gateway data plane');
    };
    chromeTabs.get = async (tabId) => {
      expect(tabId).toBe(5);
      return tab(
        5,
        'https://example.com/path-secret?harmless=query-secret',
        'Visible title that is long',
      );
    };
    chromeWithScripting.scripting = ({
      executeScript: async () => [{
        result: {
          url: 'https://example.com/path-secret?harmless=query-secret',
          origin: ORIGIN,
          documentFingerprint: 'fingerprint-1',
        },
      }],
    } as unknown) as typeof chrome.scripting;

    try {
      const result = await new ExtensionAgentGatewayBrowserAdapter().listTabs(5, {
        maxTabs: 100,
        maxTitleBytes: 12,
        maxUrlBytes: 30,
        maxResultBytes: 500,
      });

      expect(result.tabs).toEqual([expect.objectContaining({
        tabId: 5,
        url: 'https://example.com/',
      })]);
      expect(result.truncated).toBe(true);
      expect(JSON.stringify(result)).not.toContain('path-secret');
      expect(JSON.stringify(result)).not.toContain('query-secret');
    } finally {
      chromeTabs.query = originalQuery;
      chromeTabs.get = originalGet;
      chromeWithScripting.scripting = originalScripting;
    }
  });

  it('removes textarea and contenteditable text from the real extractor', () => {
    const editableBlocks = [
      removableText('Visible article text', false),
      removableText('Textarea default secret', true),
      removableText('Live contenteditable secret', true),
    ];
    const clonedBody = {
      querySelectorAll(selector: string) {
        expect(selector).toContain('textarea');
        expect(selector).toContain('[contenteditable]');
        return editableBlocks.filter((block) => block.editable);
      },
      get innerText() {
        return editableBlocks
          .filter((block) => !block.removed)
          .map((block) => block.text)
          .join('\n');
      },
      textContent: '',
    };
    const candidates = [
      fakeElement('textarea', 'Textarea default secret', {
        placeholder: 'Safe textarea label',
      }),
      fakeElement('div', 'Live contenteditable secret', {
        'aria-label': 'Safe editable label',
        contenteditable: '',
        role: 'textbox',
      }),
    ];
    const originalDocument = globalThis.document;
    const originalWindow = globalThis.window;
    const originalGetComputedStyle = globalThis.getComputedStyle;
    Object.assign(globalThis, {
      document: {
        body: { cloneNode: () => clonedBody },
        title: 'Example',
        querySelectorAll: () => candidates,
        getElementById: () => null,
      },
      window: {
        location: {
          href: 'https://example.com/',
          origin: 'https://example.com',
        },
      },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    });

    try {
      const result = agentGatewayBrowserTesting.extractBoundedPageObservation(
        10_000,
        10,
      );

      expect(result.readableText).toBe('Visible article text');
      expect(result.readableText).not.toContain('secret');
      expect(result.elements.map((element) => element.name)).toEqual([
        'Safe textarea label',
        'Safe editable label',
      ]);
    } finally {
      Object.assign(globalThis, {
        document: originalDocument,
        window: originalWindow,
        getComputedStyle: originalGetComputedStyle,
      });
    }
  });
});

function tab(id: number, url: string, title: string): chrome.tabs.Tab {
  return {
    id,
    index: id,
    windowId: 1,
    highlighted: false,
    active: id === 5,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    groupId: -1,
    url,
    title,
  };
}

function removableText(text: string, editable: boolean) {
  return {
    text,
    editable,
    removed: false,
    remove() {
      this.removed = true;
    },
  };
}

function fakeElement(
  tagName: string,
  textContent: string,
  attributes: Record<string, string>,
) {
  return {
    tagName: tagName.toUpperCase(),
    textContent,
    hidden: false,
    disabled: false,
    checked: false,
    getAttribute(name: string) {
      return attributes[name] ?? null;
    },
    hasAttribute(name: string) {
      return Object.hasOwn(attributes, name);
    },
    cloneNode() {
      return {
        innerText: textContent,
        textContent,
        querySelectorAll: () => [],
      };
    },
  } as unknown as HTMLElement;
}
