/**
 * A site's own MCP server tools get the same gate as its page tools
 * (docs/PERMISSIONS.md): no grant of their own (not mcp:tools.list or
 * mcp:tools.call, which would also open the person's installed servers), no
 * per-tool allowlist, and a policy check on tool.list per server and
 * tool.call per call, with no prompt. Every check is audited.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

const mocks = vi.hoisted(() => ({ listSiteTools: vi.fn(), callSiteTool: vi.fn() }));
vi.mock('../../mcp/site-servers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp/site-servers')>()),
  listSiteTools: mocks.listSiteTools,
  callSiteTool: mocks.callSiteTool,
}));
vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(async () => ({ granted: true, grantType: 'granted-always' })),
}));

const ORIGIN = 'https://tale.example';
const TAB = 9;
const SERVER = 'site:tale.example:tale';
let core: typeof import('../harbor-core');

beforeEach(async () => {
  resetMockBrowser();
  mocks.listSiteTools.mockReset();
  mocks.callSiteTool.mockReset();
  mocks.listSiteTools.mockReturnValue([
    { serverId: SERVER, name: 'read_tale', description: 'Read up to an anchor', inputSchema: { type: 'object' } },
    { serverId: 'site:tale.example:search', name: 'find', description: 'Find a passage', inputSchema: { type: 'object' } },
  ]);
  mocks.callSiteTool.mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: 'Once upon a time' }] } });
  core = await import('../harbor-core');
});

afterEach(async () => {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
  const { Audit } = await import('../../policy/audit');
  Audit.clear();
});

async function loadRules(rules: Array<Record<string, unknown>>) {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting(rules.map((r) => compileRule({ source: 'user', ...r } as never)));
}

describe('listing a site\'s own tools for agent work', () => {
  it('offers them with no MCP grants or allowlist, and audits each server\'s check', async () => {
    const { hasPermission } = await import('../handlers');
    expect(await hasPermission(ORIGIN, 'mcp:tools.list', TAB)).toBe(false);
    const tools = await core.siteToolsForAgent(ORIGIN, TAB);
    expect(tools.map((t) => `${t.serverId}/${t.name}`)).toEqual([`${SERVER}/read_tale`, 'site:tale.example:search/find']);
    const { Audit } = await import('../../policy/audit');
    expect(Audit.list().filter((r) => r.action === 'tool.list').map((r) => r.resource?.server).sort()).toEqual(['site:tale.example:search', SERVER]);
  });

  it('a rule denying one server leaves the others', async () => {
    await loadRules([{ id: 'x', effect: 'deny', principal: { origin: '*' }, action: 'tool.list', resource: { server: SERVER } }]);
    expect((await core.siteToolsForAgent(ORIGIN, TAB)).map((t) => t.serverId)).toEqual(['site:tale.example:search']);
  });

  it('a rule that asks refuses, with no prompt', async () => {
    const { showPermissionPrompt } = await import('../../policy/permissions');
    await loadRules([{ id: 'x', effect: 'ask', principal: { origin: '*' }, action: 'tool.list', resource: { server: 'site:*' } }]);
    expect(await core.siteToolsForAgent(ORIGIN, TAB)).toEqual([]);
    expect(showPermissionPrompt).not.toHaveBeenCalled();
  });

  it('offers nothing with no tab', async () => {
    expect(await core.siteToolsForAgent(ORIGIN, undefined)).toEqual([]);
  });
});

describe('calling a site\'s own tool for agent work', () => {
  it('calls it with no MCP grants, and audits the call', async () => {
    const result = await core.callSiteToolForAgent({ origin: ORIGIN, tabId: TAB, serverId: SERVER, name: 'read_tale', input: { upTo: 'p4' } });
    expect(mocks.callSiteTool).toHaveBeenCalledWith(ORIGIN, TAB, SERVER, 'read_tale', { upTo: 'p4' }, undefined);
    expect(result).toEqual({ content: [{ type: 'text', text: 'Once upon a time' }] });
    const { Audit } = await import('../../policy/audit');
    expect(Audit.list().find((r) => r.action === 'tool.call')?.resource).toEqual({ server: SERVER, tool: 'read_tale' });
  });

  it('a rule denying tool.call refuses before the server is called', async () => {
    await loadRules([{ id: 'x', effect: 'deny', principal: { origin: '*' }, action: 'tool.call', resource: { server: 'site:*' } }]);
    await expect(core.callSiteToolForAgent({ origin: ORIGIN, tabId: TAB, serverId: SERVER, name: 'read_tale', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_BLOCKED_BY_POLICY' });
    expect(mocks.callSiteTool).not.toHaveBeenCalled();
  });

  it("a server's own failure rejects with ERR_TOOL_FAILED", async () => {
    mocks.callSiteTool.mockResolvedValue({ ok: false, error: 'server exploded' });
    await expect(core.callSiteToolForAgent({ origin: ORIGIN, tabId: TAB, serverId: SERVER, name: 'read_tale', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_TOOL_FAILED', message: 'server exploded' });
  });

  it('refuses a server id that is not a site server', async () => {
    await expect(core.callSiteToolForAgent({ origin: ORIGIN, tabId: TAB, serverId: 'filesystem', name: 'read', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_TOOL_FAILED' });
    expect(mocks.callSiteTool).not.toHaveBeenCalled();
  });
});
