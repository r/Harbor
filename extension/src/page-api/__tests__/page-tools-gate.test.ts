/**
 * The gate on the page's own tools, with the real policy engine and audit
 * log. Page tools need no grant of their own (not mcp:tools.list or
 * mcp:tools.call, which would also open the person's installed MCP
 * servers): the grant that started the agent work covers them. A policy rule
 * can still refuse them, by `tool.list`/`tool.call` on the `page:<host>`
 * server, and every check lands in the audit log. A rule that asks is a
 * refusal: there's no one-off prompt for page tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

vi.mock('../../policy/permissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../policy/permissions')>()),
  showPermissionPrompt: vi.fn(async () => ({ granted: true, grantType: 'granted-always' })),
}));

const ORIGIN = 'https://tale.example';
const TAB = 9;

let core: typeof import('../harbor-core');
let registry: typeof import('../../mcp/page-tools');
const posted: Array<Record<string, unknown>> = [];

beforeEach(async () => {
  resetMockBrowser();
  posted.length = 0;
  core = await import('../harbor-core');
  registry = await import('../../mcp/page-tools');
  registry.__resetPageToolsForTests();
  registry.syncPageTools(
    { tabId: TAB, origin: ORIGIN, connection: 1, port: { postMessage: (m) => { posted.push(m); } } },
    { tools: [{ name: 'go_to', description: 'Scroll to an anchor' }] },
  );
});

afterEach(async () => {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
  const { Audit } = await import('../../policy/audit');
  Audit.clear();
});

async function loadRules(rules: Array<Record<string, unknown>>): Promise<void> {
  const { Policy } = await import('../../policy/store');
  const { compileRule } = await import('../../policy/rules');
  Policy.__setForTesting(rules.map((r) => compileRule({ source: 'user', ...r } as never)));
}

async function auditFor(action: string) {
  const { Audit } = await import('../../policy/audit');
  return Audit.list().filter((r) => r.action === action && r.resource?.server === 'page:tale.example');
}

describe('listing page tools for agent work the page started', () => {
  it('offers them with no MCP grants held, and audits the check', async () => {
    const { hasPermission } = await import('../handlers');
    expect(await hasPermission(ORIGIN, 'mcp:tools.list', TAB)).toBe(false);
    const listing = await core.pageToolsForAgent(ORIGIN, TAB);
    expect(listing?.serverId).toBe('page:tale.example');
    expect(listing?.tools.map((t) => t.name)).toEqual(['go_to']);
    expect(await auditFor('tool.list')).toHaveLength(1);
  });

  it('offers nothing to another origin', async () => {
    expect(await core.pageToolsForAgent('https://evil.example', TAB)).toBeNull();
  });

  it('a rule denying tool.list on page:* withholds them, and the refusal is audited', async () => {
    await loadRules([{ id: 'no-page-tools', effect: 'deny', principal: { origin: '*' }, action: 'tool.list', resource: { server: 'page:*' } }]);
    expect(await core.pageToolsForAgent(ORIGIN, TAB)).toBeNull();
    const records = await auditFor('tool.list');
    expect(records).toHaveLength(1);
    expect(records[0].effect).toBe('deny');
  });

  it('a rule asking about tool.list withholds them without a prompt', async () => {
    const { showPermissionPrompt } = await import('../../policy/permissions');
    await loadRules([{ id: 'ask', effect: 'ask', principal: { origin: '*' }, action: 'tool.list' }]);
    expect(await core.pageToolsForAgent(ORIGIN, TAB)).toBeNull();
    expect(showPermissionPrompt).not.toHaveBeenCalled();
  });

  it("a rule about site servers doesn't touch page tools", async () => {
    await loadRules([{ id: 'no-sites', effect: 'deny', principal: { origin: '*' }, action: 'tool.list', resource: { server: 'site:*' } }]);
    expect(await core.pageToolsForAgent(ORIGIN, TAB)).not.toBeNull();
  });
});

describe('calling a page tool for agent work the page started', () => {
  it('reaches the page with no MCP grants held, and audits the call', async () => {
    const { generation } = (await core.pageToolsForAgent(ORIGIN, TAB))!;
    const result = core.callPageToolForAgent({ origin: ORIGIN, tabId: TAB, generation, name: 'go_to', input: { anchor: 'p3' } });
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'page_tools.call')).toBe(true));
    const { callId } = posted.find((m) => m.type === 'page_tools.call') as { callId: string };
    registry.resolvePageToolResult(TAB, 1, { callId, ok: true, result: 'scrolled' });
    await expect(result).resolves.toBe('scrolled');
    const records = await auditFor('tool.call');
    expect(records).toHaveLength(1);
    expect(records[0].resource?.tool).toBe('go_to');
  });

  it('a rule denying tool.call refuses before the page is asked', async () => {
    const { generation } = (await core.pageToolsForAgent(ORIGIN, TAB))!;
    await loadRules([{ id: 'no-calls', effect: 'deny', principal: { origin: '*' }, action: 'tool.call', resource: { server: 'page:tale.example' } }]);
    await expect(core.callPageToolForAgent({ origin: ORIGIN, tabId: TAB, generation, name: 'go_to', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_BLOCKED_BY_POLICY' });
    expect(posted.filter((m) => m.type === 'page_tools.call')).toEqual([]);
    expect((await auditFor('tool.call'))[0].effect).toBe('deny');
  });

  it("a tool's own readOnlyHint doesn't get it past a rule denying tool.call", async () => {
    registry.syncPageTools(
      { tabId: TAB, origin: ORIGIN, connection: 1, port: { postMessage: (m) => { posted.push(m); } } },
      { tools: [{ name: 'go_to', description: 'Scroll to an anchor', annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }] },
    );
    const { generation } = (await core.pageToolsForAgent(ORIGIN, TAB))!;
    await loadRules([{ id: 'no-calls', effect: 'deny', principal: { origin: '*' }, action: 'tool.call', resource: { server: 'page:tale.example' } }]);
    await expect(core.callPageToolForAgent({ origin: ORIGIN, tabId: TAB, generation, name: 'go_to', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_BLOCKED_BY_POLICY' });
    expect(posted.filter((m) => m.type === 'page_tools.call')).toEqual([]);
  });

  it("a tool's own readOnlyHint doesn't get it past a rule that asks about tool.call", async () => {
    const { showPermissionPrompt } = await import('../../policy/permissions');
    registry.syncPageTools(
      { tabId: TAB, origin: ORIGIN, connection: 1, port: { postMessage: (m) => { posted.push(m); } } },
      { tools: [{ name: 'go_to', description: 'Scroll to an anchor', annotations: { readOnlyHint: true } }] },
    );
    const { generation } = (await core.pageToolsForAgent(ORIGIN, TAB))!;
    vi.mocked(showPermissionPrompt).mockClear();
    vi.mocked(showPermissionPrompt).mockResolvedValueOnce({ granted: false } as never);
    await loadRules([{ id: 'ask-calls', effect: 'ask', principal: { origin: '*' }, action: 'tool.call', resource: { server: 'page:tale.example' } }]);
    await expect(core.callPageToolForAgent({ origin: ORIGIN, tabId: TAB, generation, name: 'go_to', input: {} })).rejects.toBeDefined();
    expect(posted.filter((m) => m.type === 'page_tools.call')).toEqual([]);
  });
});
