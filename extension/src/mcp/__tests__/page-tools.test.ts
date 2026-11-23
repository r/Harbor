/**
 * The background's registry of tools a page registered with
 * document.modelContext / navigator.modelContext. Handlers stay in the
 * page; the registry holds descriptors per tab, tied to the page's port
 * (its document), and relays calls to that port.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  syncPageTools,
  listPageTools,
  callPageTool,
  resolvePageToolResult,
  forgetPageToolsForConnection,
  forgetPageToolsInTab,
  pageToolServerId,
  __resetPageToolsForTests,
  PAGE_TOOL_LIMITS,
} from '../page-tools';

const ORIGIN = 'https://tale.example';
const TAB = 7;

function fakePort() {
  const posted: Array<Record<string, unknown>> = [];
  return { posted, postMessage: vi.fn((m: Record<string, unknown>) => { posted.push(m); }) };
}

const tool = (name: string, extra: Record<string, unknown> = {}) => ({
  name, description: `${name} tool`, inputSchema: { type: 'object' }, ...extra,
});

beforeEach(() => __resetPageToolsForTests());
afterEach(() => vi.useRealTimers());

describe('syncPageTools validation', () => {
  it('stores a valid list and lists it for the same origin', () => {
    const port = fakePort();
    expect(syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port }, { tools: [tool('go_to')] })).toBe(true);
    expect(listPageTools(TAB, ORIGIN)?.tools.map(t => t.name)).toEqual(['go_to']);
  });

  it('lists nothing for another origin in the same tab', () => {
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port: fakePort() }, { tools: [tool('go_to')] });
    expect(listPageTools(TAB, 'https://evil.example')).toBeNull();
  });

  it('defaults a missing inputSchema to an empty object schema', () => {
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port: fakePort() }, { tools: [{ name: 'x', description: 'x' }] });
    expect(listPageTools(TAB, ORIGIN)?.tools[0].inputSchema).toEqual({ type: 'object' });
  });

  it.each([
    ['a non-object payload', 'nope'],
    ['tools not an array', { tools: {} }],
    ['an invalid name', { tools: [tool('a/b')] }],
    ['an empty description', { tools: [tool('a', { description: '' })] }],
    ['a non-object inputSchema', { tools: [tool('a', { inputSchema: 'x' })] }],
    ['an array inputSchema', { tools: [tool('a', { inputSchema: [] })] }],
    ['a duplicate name', { tools: [tool('a'), tool('a')] }],
    ['too many tools', { tools: Array.from({ length: PAGE_TOOL_LIMITS.maxTools + 1 }, (_, i) => tool(`t${i}`)) }],
    ['a description over the cap', { tools: [tool('a', { description: 'x'.repeat(PAGE_TOOL_LIMITS.maxDescriptionBytes + 1) })] }],
    ['a schema over the cap', { tools: [tool('a', { inputSchema: { type: 'object', d: 'x'.repeat(PAGE_TOOL_LIMITS.maxSchemaBytes) } })] }],
  ])('drops the whole sync for %s and keeps the previous list', (_label, payload) => {
    const port = fakePort();
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port }, { tools: [tool('keep')] });
    expect(syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port }, payload)).toBe(false);
    expect(listPageTools(TAB, ORIGIN)?.tools.map(t => t.name)).toEqual(['keep']);
  });

  it('keeps only name, description and inputSchema', () => {
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port: fakePort() }, { tools: [tool('a', { execute: 'x', extra: 1 })] });
    expect(Object.keys(listPageTools(TAB, ORIGIN)!.tools[0]).sort()).toEqual(['description', 'inputSchema', 'name']);
  });

  it('an empty list clears the tab', () => {
    const port = fakePort();
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port }, { tools: [tool('a')] });
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port }, { tools: [] });
    expect(listPageTools(TAB, ORIGIN)).toBeNull();
  });
});

describe('lifetime', () => {
  it('drops the tab when its page connection disconnects', () => {
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port: fakePort() }, { tools: [tool('a')] });
    forgetPageToolsForConnection(TAB, 1);
    expect(listPageTools(TAB, ORIGIN)).toBeNull();
  });

  it("an old page's late disconnect doesn't drop the new page's tools", () => {
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port: fakePort() }, { tools: [tool('old')] });
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 2, port: fakePort() }, { tools: [tool('new')] });
    forgetPageToolsForConnection(TAB, 1);
    expect(listPageTools(TAB, ORIGIN)?.tools.map(t => t.name)).toEqual(['new']);
  });

  it('a new page gets a new generation', () => {
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port: fakePort() }, { tools: [tool('a')] });
    const g1 = listPageTools(TAB, ORIGIN)!.generation;
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port: fakePort() }, { tools: [tool('a'), tool('b')] });
    expect(listPageTools(TAB, ORIGIN)!.generation).toBe(g1);
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 2, port: fakePort() }, { tools: [tool('a')] });
    expect(listPageTools(TAB, ORIGIN)!.generation).not.toBe(g1);
  });

  it('drops the tab when it closes', () => {
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port: fakePort() }, { tools: [tool('a')] });
    forgetPageToolsInTab(TAB);
    expect(listPageTools(TAB, ORIGIN)).toBeNull();
  });
});

describe('callPageTool', () => {
  function setup() {
    const port = fakePort();
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 1, port }, { tools: [tool('go_to')] });
    const { generation } = listPageTools(TAB, ORIGIN)!;
    return { port, generation };
  }

  it('posts the call to the page and resolves with its result', async () => {
    const { port, generation } = setup();
    const p = callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'go_to', input: { anchor: 'p3' } });
    expect(port.posted).toHaveLength(1);
    const call = port.posted[0] as { type: string; callId: string; name: string; input: unknown };
    expect(call).toMatchObject({ type: 'page_tools.call', name: 'go_to', input: { anchor: 'p3' } });
    expect(resolvePageToolResult(TAB, 1, { callId: call.callId, ok: true, result: { at: 'p3' } })).toBe(true);
    await expect(p).resolves.toEqual({ at: 'p3' });
  });

  it("rejects with ERR_TOOL_FAILED and the page's message when the handler throws", async () => {
    const { port, generation } = setup();
    const p = callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'go_to', input: {} });
    const { callId } = port.posted[0] as { callId: string };
    resolvePageToolResult(TAB, 1, { callId, ok: false, error: { message: 'no such anchor' } });
    await expect(p).rejects.toMatchObject({ code: 'ERR_TOOL_FAILED', message: 'no such anchor' });
  });

  it('truncates a long page error message', async () => {
    const { port, generation } = setup();
    const p = callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'go_to', input: {} });
    const { callId } = port.posted[0] as { callId: string };
    resolvePageToolResult(TAB, 1, { callId, ok: false, error: { message: 'e'.repeat(5000) } });
    const err = await p.catch((e: Error) => e) as Error;
    expect(err.message.length).toBeLessThanOrEqual(PAGE_TOOL_LIMITS.maxErrorChars);
  });

  it('rejects a result over the size cap', async () => {
    const { port, generation } = setup();
    const p = callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'go_to', input: {} });
    const { callId } = port.posted[0] as { callId: string };
    resolvePageToolResult(TAB, 1, { callId, ok: true, result: 'x'.repeat(PAGE_TOOL_LIMITS.maxResultBytes + 1) });
    await expect(p).rejects.toMatchObject({ code: 'ERR_TOOL_FAILED' });
  });

  it('ignores a result from another connection', async () => {
    const { port, generation } = setup();
    const p = callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'go_to', input: {} });
    const { callId } = port.posted[0] as { callId: string };
    expect(resolvePageToolResult(TAB, 2, { callId, ok: true, result: 'forged' })).toBe(false);
    expect(resolvePageToolResult(TAB, 1, { callId, ok: true, result: 'real' })).toBe(true);
    await expect(p).resolves.toBe('real');
  });

  it('fails in-flight calls when the page goes away, and never retries', async () => {
    const { port, generation } = setup();
    const p = callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'go_to', input: {} });
    forgetPageToolsForConnection(TAB, 1);
    await expect(p).rejects.toMatchObject({ code: 'ERR_TOOL_FAILED' });
    expect(port.posted.filter(m => m.type === 'page_tools.call')).toHaveLength(1);
  });

  it('fails in-flight calls when the tab closes', async () => {
    const { generation } = setup();
    const p = callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'go_to', input: {} });
    forgetPageToolsInTab(TAB);
    await expect(p).rejects.toMatchObject({ code: 'ERR_TOOL_FAILED' });
  });

  it('fails a call made against an older page generation', async () => {
    const { generation } = setup();
    syncPageTools({ tabId: TAB, origin: ORIGIN, connection: 2, port: fakePort() }, { tools: [tool('go_to')] });
    await expect(callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'go_to', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_TOOL_FAILED' });
  });

  it('fails a call to a tool the page no longer has', async () => {
    const { generation } = setup();
    await expect(callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'gone', input: {} }))
      .rejects.toMatchObject({ code: 'ERR_TOOL_FAILED' });
  });

  it('times out, and tells the page to abort the call', async () => {
    vi.useFakeTimers();
    const { port, generation } = setup();
    const p = callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'go_to', input: {} });
    const settled = p.catch(e => e);
    vi.advanceTimersByTime(PAGE_TOOL_LIMITS.callTimeoutMs + 1);
    expect(await settled).toMatchObject({ code: 'ERR_TOOL_FAILED' });
    const { callId } = port.posted[0] as { callId: string };
    expect(port.posted).toContainEqual({ type: 'page_tools.cancel', callId });
  });

  it('aborting the caller cancels the call in the page', async () => {
    const { port, generation } = setup();
    const controller = new AbortController();
    const p = callPageTool({ tabId: TAB, origin: ORIGIN, generation, name: 'go_to', input: {}, signal: controller.signal });
    controller.abort();
    await expect(p).rejects.toMatchObject({ code: 'ERR_TOOL_FAILED' });
    const { callId } = port.posted[0] as { callId: string };
    expect(port.posted).toContainEqual({ type: 'page_tools.cancel', callId });
  });
});

describe('pageToolServerId', () => {
  it('names the page by host, keeping a non-default port', () => {
    expect(pageToolServerId('https://tale.example')).toBe('page:tale.example');
    expect(pageToolServerId('http://localhost:8001')).toBe('page:localhost:8001');
  });
});
