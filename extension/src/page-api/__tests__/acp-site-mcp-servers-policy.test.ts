/**
 * D2 (HBR-134): a site's registered MCP servers are only ever passed into
 * the person's own ACP agent's `session/new` when the origin holds both
 * `mcp:tools.list` and `mcp:tools.call` (Harbor's own origin-grant store)
 * *and* the policy engine would allow `tool.list`/`tool.call` for that
 * origin with no prompt — a rule that denies or asks either one means
 * `mcpServers: []`, never a prompt from inside the run. The per-tool
 * allowlist still doesn't apply to an ACP agent's own tool use (unchanged
 * maintainer decision).
 *
 * This drives the real port, the real agent router, `agent.mcp.register`
 * (so a real site server is sitting in the registry to offer), the real
 * policy engine/rules/audit log, and the real `acp-connection.ts`
 * capability filtering — through harbor-core.ts kept real via
 * `importOriginal`, as `acp-model-prompt-agent-policy.test.ts` does. Only
 * the ACP bridge (a fake agent) and the permission *prompt* (so a test
 * doesn't hang waiting for a popup nothing answers) are stubbed; the
 * site's own MCP server is a fake one (stub fetch/EventSource), not
 * mocked away.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agent as buildAgentApp, AGENT_METHODS, type StopReason } from '@agentclientprotocol/sdk';
import { resetMockBrowser } from '../../__tests__/test-setup';
import { createFakeAcpBridge } from './support/fake-acp-bridge';
import { installFakeMcpServer } from '../../mcp/__tests__/support/fake-mcp-server';
import { siteServerId } from '../../mcp/site-servers';

const mocks = vi.hoisted(() => ({
  bridge: { current: null as null | ReturnType<typeof import('./support/fake-acp-bridge').createFakeAcpBridge> },
}));

vi.mock('../harbor-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../harbor-core')>()),
  acpOpenStream: (agentId: string, workspace: string) => mocks.bridge.current!.acpOpenStream(agentId, workspace),
  acpSend: (channel: string, message: unknown) => mocks.bridge.current!.acpSend(channel, message),
  acpClose: (channel: string) => mocks.bridge.current!.acpClose(channel),
}));
vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(async () => ({ granted: true, grantType: 'granted-always' })),
}));

const ORIGIN = 'https://shop.example';
const TAB = 9;
const AGENT_ID = 'test-agent';

type Listener = (port: unknown) => void;
let onConnect: Listener;

beforeEach(async () => {
  resetMockBrowser();
  installFakeMcpServer({ tools: [{ name: 'search' }] });
  mocks.bridge.current = createFakeAcpBridge();

  const chromeGlobal = globalThis as unknown as { chrome: Record<string, unknown> };
  chromeGlobal.chrome.runtime = {
    ...(chromeGlobal.chrome.runtime as Record<string, unknown>),
    onConnect: { addListener: (l: Listener) => { onConnect = l; } },
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  chromeGlobal.chrome.tabs = {
    ...(chromeGlobal.chrome.tabs as Record<string, unknown>),
    onRemoved: { addListener: vi.fn() },
    get: vi.fn(async () => { throw new Error('no tab'); }),
  };

  const { initializePageApi } = await import('../background');
  initializePageApi();
  await chrome.storage.local.set({ harbor_agent_backend: { type: 'acp', agentId: AGENT_ID } });

  // background.ts's handleAgentRun checks these before the run starts at
  // all — granted for every test here, since this file is about the
  // tool-grant/policy gate specifically, not this pre-existing check.
  const { grantPermissions } = await import('../../policy/permissions');
  await grantPermissions(ORIGIN, ['model:prompt', 'model:tools'], 'granted-always', TAB);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
  const { Audit } = await import('../../policy/audit');
  Audit.clear();
});

type Posted = { id?: string; ok?: boolean; result?: unknown; error?: { message?: string }; event?: { type: string }; done?: boolean };

function connectPort(senderUrl: string, tabId = TAB) {
  const listeners: Array<(m: unknown) => void> = [];
  const posted: Posted[] = [];
  onConnect({
    name: 'harbor-page-api',
    sender: { url: senderUrl, tab: { id: tabId } },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    postMessage: (m: Posted) => posted.push(m),
  });
  let n = 0;
  const send = (type: string, payload: unknown) => {
    const id = `r${++n}`;
    listeners.forEach((l) => l({ id, type, payload }));
    return id;
  };
  const reply = async (id: string) => {
    await vi.waitFor(() => expect(posted.some((p) => p.id === id)).toBe(true));
    return posted.find((p) => p.id === id)!;
  };
  const waitForRun = async (id: string) => {
    await vi.waitFor(() => expect(posted.some((p) => p.id === id && p.done)).toBe(true));
  };
  return { send, reply, waitForRun };
}

async function registerSiteServer(port: ReturnType<typeof connectPort>): Promise<string> {
  const reply = await port.reply(port.send('agent.mcp.register', { url: `${ORIGIN}/mcp`, name: 'Shop', transport: 'sse' }));
  if (!reply.ok) throw new Error(`registration failed: ${JSON.stringify(reply)}`);
  return siteServerId(ORIGIN, 'Shop');
}

async function grantToolAccess(granted: { list?: boolean; call?: boolean } = { list: true, call: true }): Promise<void> {
  const { grantPermissions } = await import('../../policy/permissions');
  if (granted.list) await grantPermissions(ORIGIN, ['mcp:tools.list'], 'granted-always', TAB);
  if (granted.call) await grantPermissions(ORIGIN, ['mcp:tools.call'], 'granted-always', TAB);
}

async function loadRules(rules: Array<Record<string, unknown>>): Promise<void> {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting(rules.map((r) => compileRule({ source: 'user', ...r } as never)));
}

function registerFakeAgent(onSessionNew: (params: unknown) => void): void {
  const app = buildAgentApp({ name: 'fake-agent' })
    // Declares sse support so a passed-through site server (registered
    // over sse below) isn't itself filtered out by capability — this
    // file is about the grant/policy gate in front of that, not the
    // capability filter acp-connection.test.ts-equivalent coverage
    // already has in acp-backend.test.ts.
    .onRequest(AGENT_METHODS.initialize, async () => ({ protocolVersion: 1, agentCapabilities: { mcpCapabilities: { sse: true, http: true } } }))
    .onRequest(AGENT_METHODS.session_new, async (ctx) => { onSessionNew(ctx.params); return { sessionId: 'sess-1' }; })
    .onRequest(AGENT_METHODS.session_prompt, async (): Promise<{ stopReason: StopReason }> => ({ stopReason: 'end_turn' }));
  mocks.bridge.current!.registerAgent(AGENT_ID, app, {});
}

describe("a site's registered MCP servers reaching the person's ACP agent", () => {
  it('are offered when the origin holds both grants and no rule denies tool.list/tool.call', async () => {
    const port = connectPort(`${ORIGIN}/page`);
    await registerSiteServer(port);
    await grantToolAccess({ list: true, call: true });

    let sessionNewParams: unknown;
    registerFakeAgent((params) => { sessionNewParams = params; });

    const id = port.send('agent.run', { task: 'find headphones' });
    await port.waitForRun(id);

    expect((sessionNewParams as { mcpServers: unknown[] }).mcpServers.length).toBeGreaterThan(0);
  });

  it('are withheld (mcpServers: []) when the origin lacks mcp:tools.call', async () => {
    const port = connectPort(`${ORIGIN}/page`);
    await registerSiteServer(port);
    await grantToolAccess({ list: true, call: false });

    let sessionNewParams: unknown;
    registerFakeAgent((params) => { sessionNewParams = params; });

    const id = port.send('agent.run', { task: 'find headphones' });
    await port.waitForRun(id);

    expect((sessionNewParams as { mcpServers: unknown[] }).mcpServers).toEqual([]);
  });

  it('are withheld when a policy rule denies tool.call, even though both grants are held', async () => {
    const port = connectPort(`${ORIGIN}/page`);
    await registerSiteServer(port);
    await grantToolAccess({ list: true, call: true });
    await loadRules([{ id: 'deny-tool-call', effect: 'deny', principal: { origin: '*' }, action: 'tool.call' }]);

    let sessionNewParams: unknown;
    registerFakeAgent((params) => { sessionNewParams = params; });

    const id = port.send('agent.run', { task: 'find headphones' });
    await port.waitForRun(id);

    expect((sessionNewParams as { mcpServers: unknown[] }).mcpServers).toEqual([]);
  });

  it('are withheld when a policy rule asks for tool.list', async () => {
    const port = connectPort(`${ORIGIN}/page`);
    await registerSiteServer(port);
    await grantToolAccess({ list: true, call: true });
    await loadRules([{ id: 'ask-tool-list', effect: 'ask', principal: { origin: '*' }, action: 'tool.list' }]);

    let sessionNewParams: unknown;
    registerFakeAgent((params) => { sessionNewParams = params; });

    const id = port.send('agent.run', { task: 'find headphones' });
    await port.waitForRun(id);

    // Not asserting showPermissionPrompt here: background.ts's
    // handleAgentRun also fetches mcp.listTools for the *built-in*
    // backend's own tools before a backend is even picked (discarded by
    // this backend — see acp-backend.ts's header comment), and that
    // separate, pre-existing step goes through this same rule and does
    // prompt. The "no prompt from inside the run" requirement is about
    // this file's own check never adding a *second* one — covered
    // directly, isolated from that confound, below.
    expect((sessionNewParams as { mcpServers: unknown[] }).mcpServers).toEqual([]);
  });
});

describe('policyAllowsSiteToolsForAcp itself never prompts', () => {
  it('returns false for a denying or asking rule without ever calling showPermissionPrompt', async () => {
    await loadRules([{ id: 'ask-tool-list', effect: 'ask', principal: { origin: '*' }, action: 'tool.list' }]);

    const { showPermissionPrompt, grantPermissions } = await import('../../policy/permissions');
    await grantPermissions(ORIGIN, ['mcp:tools.list', 'mcp:tools.call'], 'granted-always', TAB);
    vi.mocked(showPermissionPrompt).mockClear();

    const { policyAllowsSiteToolsForAcp } = await import('../harbor-core');
    const allowed = await policyAllowsSiteToolsForAcp(ORIGIN, TAB);

    expect(allowed).toBe(false);
    expect(showPermissionPrompt).not.toHaveBeenCalled();
  });

  it('returns true with no rule in the way', async () => {
    const { grantPermissions } = await import('../../policy/permissions');
    await grantPermissions(ORIGIN, ['mcp:tools.list', 'mcp:tools.call'], 'granted-always', TAB);

    const { policyAllowsSiteToolsForAcp } = await import('../harbor-core');
    expect(await policyAllowsSiteToolsForAcp(ORIGIN, TAB)).toBe(true);
  });
});
