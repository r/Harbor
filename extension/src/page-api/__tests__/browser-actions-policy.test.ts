/**
 * Page browser calls (click, fill, navigate, screenshot, tabs, fetch, ...)
 * go through Harbor's PolicyEngine after the site's grant check, the same
 * way page model and tool calls do: each is audited under the calling
 * origin, a deny is enforced before the browser is touched, and a policy
 * rule that asks still prompts. With no rule, the site's grant stands in
 * for Harbor's prompt, so normal use sees no new prompt.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HandlerResponse, RequestContext } from '../handlers/types';

type TransportResponse = Awaited<HandlerResponse>;

const mocks = vi.hoisted(() => ({
  hasPermission: vi.fn(),
  executeScriptInTab: vi.fn(),
}));

vi.mock('../handlers/permission-handlers', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  hasPermission: mocks.hasPermission,
}));
vi.mock('../../browser-compat', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  executeScriptInTab: mocks.executeScriptInTab,
}));
vi.mock('../../llm/bridge-client', () => ({
  bridgeRequest: vi.fn(),
  bridgeStreamRequest: vi.fn(),
  getBridgeConnectionState: vi.fn(() => ({ connected: false, bridgeReady: false, error: undefined })),
  checkBridgeHealth: vi.fn(async () => false),
}));
vi.mock('../../mcp/host', () => ({
  listServersWithStatus: vi.fn(async () => []),
  callTool: vi.fn(),
  startServer: vi.fn(),
  stopServer: vi.fn(),
  listTools: vi.fn(async () => []),
}));
vi.mock('../../llm/native-bridge', () => ({ isNativeBridgeReady: vi.fn(() => false), rpcRequest: vi.fn() }));
vi.mock('../../llm/provider-registry', () => ({
  listAllProviders: vi.fn(async () => []),
  getRuntimeCapabilities: vi.fn(async () => ({})),
}));
vi.mock('../../sessions', () => ({ SessionRegistry: { subscribe: vi.fn() } }));
vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showPermissionPrompt: vi.fn(),
}));

const ORIGIN = 'https://site.example';
const HOST = 'site.example';
const CALLER_TAB = 9;
const SPAWNED_TAB = 42;

const tabs = {
  get: vi.fn(),
  query: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
  update: vi.fn(),
  captureVisibleTab: vi.fn(),
  onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  onRemoved: { addListener: vi.fn() },
};
const fetchMock = vi.fn();

type Policy = typeof import('../../policy/store').Policy;
type Audit = typeof import('../../policy/audit').Audit;
let Audit: Audit;
let Policy: Policy;
let compileRule: typeof import('../../policy/rules').compileRule;
let showPermissionPrompt: ReturnType<typeof vi.fn>;
let browserHandlers: typeof import('../handlers/browser-handlers');
let tabHandlers: typeof import('../handlers/tab-handlers');

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.hasPermission.mockResolvedValue(true);
  mocks.executeScriptInTab.mockResolvedValue({ success: true });
  tabs.get.mockImplementation(async (id: number) => ({
    id, url: `${ORIGIN}/page`, active: true, windowId: 1, status: 'complete',
  }));
  tabs.query.mockResolvedValue([]);
  tabs.create.mockImplementation(async (opts: { url: string }) => ({
    id: SPAWNED_TAB, url: opts.url, title: '', active: false, index: 0, windowId: 1,
  }));
  tabs.remove.mockResolvedValue(undefined);
  tabs.update.mockResolvedValue({});
  tabs.captureVisibleTab.mockResolvedValue('data:image/png;base64,AAAA');
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true, status: 200, statusText: 'OK', url, redirected: false,
    headers: new Headers(), text: async () => 'body',
  }));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', {
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
    tabs,
    runtime: { id: 'harbor@test' },
  });
  // Public IPs only, so fetch's private-network guard lets these through.
  vi.stubGlobal('browser', {
    tabs,
    dns: { resolve: vi.fn(async () => ({ addresses: ['93.184.216.34'], canonicalName: '', isTRR: false })) },
  });

  ({ Audit } = await import('../../policy/audit'));
  ({ Policy } = await import('../../policy/store'));
  ({ compileRule } = await import('../../policy/rules'));
  const engine = await import('../../policy/engine');
  engine.setOriginGrantResolver(() => null);
  engine.setWatchdogResolver(() => ({ status: 'normal' }));
  showPermissionPrompt = vi.mocked((await import('../../policy/permissions')).showPermissionPrompt);
  browserHandlers = await import('../handlers/browser-handlers');
  tabHandlers = await import('../handlers/tab-handlers');
  Audit.clear();
  Policy.__reset();
  tabHandlers.trackSpawnedTab(ORIGIN, SPAWNED_TAB);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const ctx = (type: string, payload: Record<string, unknown> = {}): RequestContext =>
  ({ id: 'r1', type, payload, origin: ORIGIN, tabId: CALLER_TAB }) as RequestContext;

type Handler = (c: RequestContext) => Promise<TransportResponse>;

interface Case {
  name: string;
  run: () => Promise<TransportResponse>;
  action: string;
  host: string;
  /** Whether the call touched the browser (script, tab or network). */
  touched: () => boolean;
}

const scriptRan = () => mocks.executeScriptInTab.mock.calls.length > 0;

const cases = (): Case[] => {
  const b = browserHandlers;
  const t = tabHandlers;
  const call = (h: Handler, type: string, payload?: Record<string, unknown>) => () => h(ctx(type, payload));
  return [
    { name: 'click', run: call(b.handleBrowserClick, 'agent.browser.activeTab.click', { ref: '#go' }), action: 'browser.write.interact', host: HOST, touched: scriptRan },
    { name: 'fill', run: call(b.handleBrowserFill, 'agent.browser.activeTab.fill', { ref: '#q', value: 'x' }), action: 'browser.write.interact', host: HOST, touched: scriptRan },
    { name: 'select', run: call(b.handleBrowserSelect, 'agent.browser.activeTab.select', { ref: '#s', value: 'a' }), action: 'browser.write.interact', host: HOST, touched: scriptRan },
    { name: 'scroll', run: call(b.handleBrowserScroll, 'agent.browser.activeTab.scroll', { direction: 'down' }), action: 'browser.write.interact', host: HOST, touched: scriptRan },
    { name: 'screenshot', run: call(b.handleBrowserScreenshot, 'agent.browser.activeTab.screenshot'), action: 'browser.read.screenshot', host: HOST, touched: () => tabs.captureVisibleTab.mock.calls.length > 0 },
    { name: 'getElements', run: call(b.handleBrowserGetElements, 'agent.browser.activeTab.getElements'), action: 'browser.read.element', host: HOST, touched: scriptRan },
    { name: 'readability', run: call(b.handleBrowserReadability, 'agent.browser.activeTab.readability'), action: 'browser.read.activeTab', host: HOST, touched: scriptRan },
    { name: 'navigate', run: call(b.handleBrowserNavigate, 'agent.browser.navigate', { url: 'https://other.example/x' }), action: 'browser.write.navigate', host: 'other.example', touched: () => tabs.update.mock.calls.length > 0 },
    { name: 'same-origin fetch', run: call(b.handleBrowserFetch, 'agent.browser.fetch', { url: `${ORIGIN}/api` }), action: 'network.egress.same_origin', host: HOST, touched: () => fetchMock.mock.calls.length > 0 },
    { name: 'cross-origin fetch', run: call(b.handleBrowserFetch, 'agent.browser.fetch', { url: 'https://api.other.example/v1' }), action: 'network.egress.cross_origin', host: 'api.other.example', touched: () => fetchMock.mock.calls.length > 0 },
    { name: 'tabs.list', run: call(t.handleTabsList, 'agent.browser.tabs.list'), action: 'browser.read.tabs', host: HOST, touched: () => tabs.query.mock.calls.length > 0 },
    { name: 'tabs.create', run: call(t.handleTabsCreate, 'agent.browser.tabs.create', { url: 'https://other.example/' }), action: 'browser.write.tabsCreate', host: 'other.example', touched: () => tabs.create.mock.calls.length > 0 },
    { name: 'tabs.close', run: call(t.handleTabsClose, 'agent.browser.tabs.close', { tabId: SPAWNED_TAB }), action: 'browser.write.tabsCreate', host: HOST, touched: () => tabs.remove.mock.calls.length > 0 },
    { name: 'spawned readability', run: call(t.handleSpawnedTabReadability, 'agent.browser.tab.readability', { tabId: SPAWNED_TAB }), action: 'browser.write.tabsCreate', host: HOST, touched: scriptRan },
    { name: 'spawned getHtml', run: call(t.handleSpawnedTabGetHtml, 'agent.browser.tab.getHtml', { tabId: SPAWNED_TAB }), action: 'browser.write.tabsCreate', host: HOST, touched: scriptRan },
  ];
};

// Handlers load per test (fresh module graph), so name cases statically.
const CASE_NAMES = [
  'click', 'fill', 'select', 'scroll', 'screenshot', 'getElements', 'readability', 'navigate',
  'same-origin fetch', 'cross-origin fetch', 'tabs.list', 'tabs.create', 'tabs.close',
  'spawned readability', 'spawned getHtml',
];
const caseNamed = (name: string) => cases().find((c) => c.name === name)!;

const loadRules = (rules: Array<Record<string, unknown>>) =>
  Policy.__setForTesting(rules.map((r) => compileRule({ source: 'user', ...r } as never)));

describe('page browser calls are audited under the calling origin', () => {
  it.each(CASE_NAMES)('%s: audited with its typed action, no Harbor prompt', async (name) => {
    const c = caseNamed(name);
    const res = await c.run();
    expect(res.ok, `${c.name}: ${JSON.stringify(res)}`).toBe(true);
    expect(c.touched(), c.name).toBe(true);
    const records = Audit.query({ origin: ORIGIN });
    expect(records, c.name).toHaveLength(1);
    expect(records[0], c.name).toMatchObject({ action: c.action, resource: { host: c.host } });
    expect(records[0].effect, c.name).not.toBe('deny');
    expect(showPermissionPrompt, c.name).not.toHaveBeenCalled();
  });
});

describe('policy decisions are enforced before the browser is touched', () => {
  it.each(CASE_NAMES)('%s: a deny rule refuses the call', async (name) => {
    const c = caseNamed(name);
    loadRules([{ id: 'no', effect: 'deny', principal: { origin: '*' }, action: c.action }]);
    const res = await c.run();
    expect(res.ok, c.name).toBe(false);
    expect(c.touched(), c.name).toBe(false);
    const [record] = Audit.query({ origin: ORIGIN });
    expect(record, c.name).toMatchObject({ action: c.action, effect: 'deny' });
  });

  it('an ask rule prompts, and a dismissed prompt refuses the click', async () => {
    loadRules([{ id: 'confirm', effect: 'ask', principal: { origin: '*' }, action: 'browser.write.interact' }]);
    showPermissionPrompt.mockResolvedValueOnce({ granted: false });
    const res = await browserHandlers.handleBrowserClick(ctx('agent.browser.activeTab.click', { ref: '#go' }));
    expect(res.ok).toBe(false);
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(scriptRan()).toBe(false);
  });

  it('a watchdog restriction prompts even with the grant', async () => {
    const engine = await import('../../policy/engine');
    engine.setWatchdogResolver(() => ({ status: 'restricted' }) as never);
    showPermissionPrompt.mockResolvedValueOnce({ granted: false });
    const res = await browserHandlers.handleBrowserNavigate(ctx('agent.browser.navigate', { url: 'https://x.example/' }));
    expect(res.ok).toBe(false);
    expect(showPermissionPrompt).toHaveBeenCalledTimes(1);
    expect(tabs.update).not.toHaveBeenCalled();
  });

  it('a host-scoped deny rule blocks fetch to that host only', async () => {
    loadRules([{ id: 'no-tracker', effect: 'deny', principal: { origin: '*' }, action: 'network.egress.cross_origin', resource: { host: 'tracker.example' } }]);
    const blocked = await browserHandlers.handleBrowserFetch(ctx('agent.browser.fetch', { url: 'https://tracker.example/p' }));
    const allowed = await browserHandlers.handleBrowserFetch(ctx('agent.browser.fetch', { url: 'https://api.other.example/' }));
    expect(blocked.ok).toBe(false);
    expect(allowed.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('what stays outside the audit', () => {
  it('a call the site has no grant for is refused without reaching the engine', async () => {
    mocks.hasPermission.mockResolvedValue(false);
    const res = await browserHandlers.handleBrowserClick(ctx('agent.browser.activeTab.click', { ref: '#go' }));
    expect(res.ok).toBe(false);
    expect(Audit.query({ origin: ORIGIN })).toHaveLength(0);
  });

  it('waitForLoad is not audited', async () => {
    const res = await tabHandlers.handleSpawnedTabWaitForLoad(ctx('agent.browser.tab.waitForLoad', { tabId: SPAWNED_TAB }));
    expect(res.ok).toBe(true);
    expect(Audit.query({ origin: ORIGIN })).toHaveLength(0);
  });
});
