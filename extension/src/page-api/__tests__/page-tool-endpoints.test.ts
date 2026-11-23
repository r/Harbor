/**
 * The extension side of the bridge's page-tools MCP endpoint: opening one for
 * an ACP session (only when the page has tools and policy allows them),
 * answering the bridge's `page_tools.list`/`page_tools.call` host requests
 * against the registry, and closing it. Answers are always MCP results, never
 * thrown errors, so page-supplied error text never reaches native-bridge's
 * failure log.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetMockBrowser } from '../../__tests__/test-setup';

const mocks = vi.hoisted(() => ({ rpcRequest: vi.fn(), listSiteTools: vi.fn(), callSiteTool: vi.fn() }));
vi.mock('../../llm/native-bridge', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../llm/native-bridge')>()),
  rpcRequest: mocks.rpcRequest,
}));
vi.mock('../../mcp/site-servers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../mcp/site-servers')>()),
  listSiteTools: mocks.listSiteTools,
  callSiteTool: mocks.callSiteTool,
}));

const ORIGIN = 'https://tale.example';
const TAB = 9;
let core: typeof import('../harbor-core');
let registry: typeof import('../../mcp/page-tools');
const posted: Array<Record<string, unknown>> = [];
let nextEndpoint = 0;

function syncPage(connection = 1) {
  registry.syncPageTools(
    { tabId: TAB, origin: ORIGIN, connection, port: { postMessage: (m) => { posted.push(m); } } },
    { tools: [{ name: 'go_to', description: 'Scroll to an anchor' }, { name: 'reading_position', description: 'Where the reader is' }] },
  );
}

async function answerNextCall(result: { ok: boolean; result?: unknown; error?: { message: string } }, connection = 1) {
  await vi.waitFor(() => expect(posted.some((m) => m.type === 'page_tools.call')).toBe(true));
  const call = posted.splice(posted.findIndex((m) => m.type === 'page_tools.call'), 1)[0] as { callId: string };
  registry.resolvePageToolResult(TAB, connection, { callId: call.callId, ...result });
}

beforeEach(async () => {
  resetMockBrowser();
  posted.length = 0;
  mocks.rpcRequest.mockReset();
  mocks.rpcRequest.mockImplementation(async (method: string) => {
    if (method === 'page_tools.open') {
      nextEndpoint++;
      return { endpointId: `pt-${nextEndpoint}`, url: `http://127.0.0.1:4555/mcp/token${nextEndpoint}` };
    }
    if (method === 'page_tools.close') return { closed: true };
    throw new Error(`unexpected ${method}`);
  });
  mocks.listSiteTools.mockReset();
  mocks.listSiteTools.mockReturnValue([]);
  mocks.callSiteTool.mockReset();
  core = await import('../harbor-core');
  registry = await import('../../mcp/page-tools');
  registry.__resetPageToolsForTests();
  core.__resetPageToolEndpointsForTests();
});

afterEach(async () => {
  const { Policy } = await import('../../policy/store');
  Policy.__reset();
});

describe('opening an endpoint for an ACP session', () => {
  it('opens none, and never asks the bridge, when the page has no tools', async () => {
    expect(await core.openPageToolEndpointForAcp(ORIGIN, TAB)).toBeNull();
    expect(mocks.rpcRequest).not.toHaveBeenCalled();
  });

  it("returns the page:<host> server to put in session/new", async () => {
    syncPage();
    const endpoint = await core.openPageToolEndpointForAcp(ORIGIN, TAB);
    expect(mocks.rpcRequest).toHaveBeenCalledWith('page_tools.open', {});
    expect(endpoint).toMatchObject({
      serverId: 'page:tale.example', name: 'tale.example', transport: 'streamable-http',
      url: 'http://127.0.0.1:4555/mcp/token1', endpointId: 'pt-1',
    });
  });

  it('opens none when a policy rule denies tool.list for the page', async () => {
    syncPage();
    const { Policy } = await import('../../policy/store');
    const { compileRule } = await import('../../policy/rules');
    Policy.__setForTesting([compileRule({ source: 'user', id: 'x', effect: 'deny', principal: { origin: '*' }, action: 'tool.list', resource: { server: 'page:*' } } as never)]);
    expect(await core.openPageToolEndpointForAcp(ORIGIN, TAB)).toBeNull();
    expect(mocks.rpcRequest).not.toHaveBeenCalled();
  });

  it("refuses a URL from the bridge that isn't loopback http", async () => {
    syncPage();
    mocks.rpcRequest.mockResolvedValueOnce({ endpointId: 'pt-x', url: 'http://evil.example/mcp/t' });
    expect(await core.openPageToolEndpointForAcp(ORIGIN, TAB)).toBeNull();
  });

  it("opens none when the bridge can't open one", async () => {
    syncPage();
    mocks.rpcRequest.mockRejectedValueOnce(new Error('bridge down'));
    expect(await core.openPageToolEndpointForAcp(ORIGIN, TAB)).toBeNull();
  });
});

describe("answering the bridge's host requests", () => {
  it('lists the tab\'s page tools', async () => {
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    const listed = await core.handlePageToolsHostRequest('page_tools.list', { endpointId }) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((t) => t.name)).toEqual(['go_to', 'reading_position']);
  });

  it('lists nothing once the page has reloaded', async () => {
    syncPage(1);
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    syncPage(2);
    expect(await core.handlePageToolsHostRequest('page_tools.list', { endpointId })).toEqual({ tools: [] });
  });

  it('lists nothing for an unknown or closed endpoint', async () => {
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    await core.closePageToolEndpoint(endpointId);
    expect(mocks.rpcRequest).toHaveBeenCalledWith('page_tools.close', { endpointId });
    expect(await core.handlePageToolsHostRequest('page_tools.list', { endpointId })).toEqual({ tools: [] });
    expect(await core.handlePageToolsHostRequest('page_tools.list', { endpointId: 'nope' })).toEqual({ tools: [] });
  });

  it('relays a call and returns text plus structuredContent for an object result', async () => {
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    const result = core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'reading_position', arguments: {} });
    await answerNextCall({ ok: true, result: { anchor: 'p12', chapter: 3 } });
    expect(await result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ anchor: 'p12', chapter: 3 }) }],
      structuredContent: { anchor: 'p12', chapter: 3 },
      _meta: { 'harbor/provenance': { source: 'page-tool', origin: ORIGIN } },
    });
  });

  it('returns a string result as plain text', async () => {
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    const result = core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'go_to', arguments: { anchor: 'p3' } });
    await answerNextCall({ ok: true, result: 'scrolled to p3' });
    expect(await result).toEqual({ content: [{ type: 'text', text: 'scrolled to p3' }], _meta: { 'harbor/provenance': { source: 'page-tool', origin: ORIGIN } } });
  });

  it("returns the handler's error as an isError result, not a thrown error", async () => {
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    const result = core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'go_to', arguments: {} });
    await answerNextCall({ ok: false, error: { message: 'no such anchor' } });
    expect(await result).toEqual({ content: [{ type: 'text', text: 'no such anchor' }], isError: true, _meta: { 'harbor/provenance': { source: 'page-tool', origin: ORIGIN } } });
  });

  it('a call on a closed endpoint is an isError result', async () => {
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    await core.closePageToolEndpoint(endpointId);
    expect(await core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'go_to', arguments: {} }))
      .toMatchObject({ isError: true });
    expect(posted.filter((m) => m.type === 'page_tools.call')).toEqual([]);
  });

  it("holds an agent.run's endpoint to the run's tool budget", async () => {
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB, { maxCalls: 1 }))!;
    const first = core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'go_to', arguments: {} });
    await answerNextCall({ ok: true, result: 'ok' });
    await first;
    const second = await core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'go_to', arguments: {} });
    expect(second).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/budget/i) }] });
    expect(posted.filter((m) => m.type === 'page_tools.call')).toEqual([]);
  });

  it('holds the budget when the agent sends calls in parallel', async () => {
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB, { maxCalls: 1 }))!;
    const both = [
      core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'go_to', arguments: {} }),
      core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'go_to', arguments: {} }),
    ];
    await answerNextCall({ ok: true, result: 'ok' });
    const results = await Promise.all(both);
    expect(results.filter((r) => (r as { isError?: boolean }).isError)).toHaveLength(1);
    expect(posted.filter((m) => m.type === 'page_tools.call')).toEqual([]);
  });

  it('a refused call spends no budget', async () => {
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB, { maxCalls: 1 }))!;
    const { Policy } = await import('../../policy/store');
    const { compileRule } = await import('../../policy/rules');
    Policy.__setForTesting([compileRule({ source: 'user', id: 'x', effect: 'deny', principal: { origin: '*' }, action: 'tool.call', resource: { server: 'page:*', tool: 'reading_position' } } as never)]);
    expect(await core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'reading_position', arguments: {} }))
      .toMatchObject({ isError: true });
    const allowed = core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'go_to', arguments: {} });
    await answerNextCall({ ok: true, result: 'ok' });
    expect(await allowed).toMatchObject({ content: [{ type: 'text', text: 'ok' }] });
  });

  it('passes {} when the agent sends non-object arguments', async () => {
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    const result = core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'go_to', arguments: 'nope' });
    await vi.waitFor(() => expect(posted.some((m) => m.type === 'page_tools.call')).toBe(true));
    expect(posted.find((m) => m.type === 'page_tools.call')).toMatchObject({ input: {} });
    await answerNextCall({ ok: true, result: 'ok' });
    await result;
  });
});

describe("the site's own MCP server tools, through the same endpoint", () => {
  const SITE = [{ serverId: 'site:tale.example:tale', name: 'read_tale', description: 'Read up to an anchor', inputSchema: { type: 'object' } }];

  it('opens an endpoint for a site that has server tools and no page tools', async () => {
    mocks.listSiteTools.mockReturnValue(SITE);
    const endpoint = await core.openPageToolEndpointForAcp(ORIGIN, TAB);
    expect(endpoint).toMatchObject({ name: 'tale.example', transport: 'streamable-http' });
  });

  it('lists page tools by name and site tools as <server>__<tool>', async () => {
    syncPage();
    mocks.listSiteTools.mockReturnValue(SITE);
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    const listed = await core.handlePageToolsHostRequest('page_tools.list', { endpointId }) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((t) => t.name)).toEqual(['go_to', 'reading_position', 'tale__read_tale']);
  });

  it('calls a site tool through Harbor\'s own connection to the server, policy-checked and budgeted', async () => {
    mocks.listSiteTools.mockReturnValue(SITE);
    mocks.callSiteTool.mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: 'Once upon a time' }] } });
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB, { maxCalls: 1 }))!;
    const r = await core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'tale__read_tale', arguments: { upTo: 'p4' } });
    expect(mocks.callSiteTool).toHaveBeenCalledWith(ORIGIN, TAB, 'site:tale.example:tale', 'read_tale', { upTo: 'p4' });
    // The server's own CallToolResult is passed through, not re-wrapped as JSON text.
    expect(r).toEqual({ content: [{ type: 'text', text: 'Once upon a time' }], _meta: { 'harbor/provenance': { source: 'site-server', origin: ORIGIN, server: 'site:tale.example:tale' } } });
    const over = await core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'tale__read_tale', arguments: {} });
    expect(over).toMatchObject({ isError: true });
  });

  it('leaves out a server policy refuses', async () => {
    mocks.listSiteTools.mockReturnValue(SITE);
    const { Policy } = await import('../../policy/store');
    const { compileRule } = await import('../../policy/rules');
    Policy.__setForTesting([compileRule({ source: 'user', id: 'x', effect: 'deny', principal: { origin: '*' }, action: 'tool.list', resource: { server: 'site:*' } } as never)]);
    syncPage();
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    const listed = await core.handlePageToolsHostRequest('page_tools.list', { endpointId }) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((t) => t.name)).toEqual(['go_to', 'reading_position']);
  });
});

describe('names, provenance and audit on the endpoint', () => {
  it('prefixes every description with the host and stamps provenance on every tool', async () => {
    syncPage();
    mocks.listSiteTools.mockReturnValue([{ serverId: 'site:tale.example:tale', name: 'read_tale', description: 'Read', inputSchema: { type: 'object' } }]);
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    const listed = await core.handlePageToolsHostRequest('page_tools.list', { endpointId }) as { tools: Array<{ name: string; description: string; _meta: unknown }> };
    expect(listed.tools.map((t) => t.description)).toEqual(['From tale.example: Scroll to an anchor', 'From tale.example: Where the reader is', 'From tale.example: Read']);
    expect(listed.tools[0]._meta).toEqual({ 'harbor/provenance': { source: 'page-tool', origin: ORIGIN } });
    expect(listed.tools[2]._meta).toEqual({ 'harbor/provenance': { source: 'site-server', origin: ORIGIN, server: 'site:tale.example:tale' } });
  });

  it('gives colliding site tool names distinct names that each call the right tool', async () => {
    mocks.listSiteTools.mockReturnValue([
      { serverId: 'site:tale.example:x', name: '_y', description: 'first', inputSchema: { type: 'object' } },
      { serverId: 'site:tale.example:x_', name: 'y', description: 'second', inputSchema: { type: 'object' } },
    ]);
    mocks.callSiteTool.mockResolvedValue({ ok: true, result: { content: [{ type: 'text', text: 'ok' }] } });
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    const listed = await core.handlePageToolsHostRequest('page_tools.list', { endpointId }) as { tools: Array<{ name: string }> };
    expect(listed.tools.map((t) => t.name)).toEqual(['x___y', 'x___y_2']);
    await core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'x___y_2', arguments: {} });
    expect(mocks.callSiteTool).toHaveBeenLastCalledWith(ORIGIN, TAB, 'site:tale.example:x_', 'y', {});
  });

  it('a site tool call after a listing adds only its own tool.call audit entry', async () => {
    mocks.listSiteTools.mockReturnValue([
      { serverId: 'site:tale.example:a', name: 't', description: 'a', inputSchema: { type: 'object' } },
      { serverId: 'site:tale.example:b', name: 't', description: 'b', inputSchema: { type: 'object' } },
    ]);
    mocks.callSiteTool.mockResolvedValue({ ok: true, result: { content: [] } });
    const { endpointId } = (await core.openPageToolEndpointForAcp(ORIGIN, TAB))!;
    await core.handlePageToolsHostRequest('page_tools.list', { endpointId });
    const { Audit } = await import('../../policy/audit');
    const before = Audit.list().length;
    await core.handlePageToolsHostRequest('page_tools.call', { endpointId, name: 'a__t', arguments: {} });
    const added = Audit.list().slice(before).map((r) => r.action);
    expect(added).toEqual(['tool.call']);
  });
});
