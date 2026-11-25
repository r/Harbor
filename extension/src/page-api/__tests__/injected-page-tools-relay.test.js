/**
 * The page half of page tools, run against the real injected.ts: the page
 * tells the background its tool list (descriptors only) whenever it changes,
 * flushes that list before starting agent work, and runs a tool's handler
 * when the background relays a call, answering on the same channel.
 */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../injected.ts', import.meta.url), 'utf8');
const script = transformSync(source, { loader: 'ts', format: 'iife' }).code;

function page() {
  const listeners = [];
  const posted = [];
  const window = {
    addEventListener: (type, l) => { if (type === 'message') listeners.push(l); },
    dispatchEvent: vi.fn(),
    postMessage: vi.fn((data) => { posted.push(data); }),
  };
  const navigator = {};
  const document = { querySelector: () => null, getElementById: () => null };
  runInNewContext(script, {
    window, navigator, document, crypto: webcrypto,
    console: { debug: vi.fn(), warn: vi.fn(), log: vi.fn() },
    CustomEvent: class { constructor(type, options) { this.type = type; this.options = options; } },
    DOMException, AbortController, AbortSignal,
    setTimeout, clearTimeout, Map, Set, Date, Math,
  });
  const deliver = (data) => listeners.forEach((l) => l({ source: window, data: { channel: 'harbor_page_api', ...data } }));
  const requests = (type) => posted.filter((m) => m.request?.type === type).map((m) => m.request);
  const results = () => posted.filter((m) => m.pageToolResult).map((m) => m.pageToolResult);
  return { window, navigator, document, mc: navigator.modelContext, posted, deliver, requests, results };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const tool = (name, execute = async () => `${name} ran`) => ({ name, description: `${name} tool`, inputSchema: { type: 'object' }, execute });

describe('page_tools.sync', () => {
  it('sends nothing for a page that registers no tools', async () => {
    const p = page();
    await tick();
    expect(p.requests('page_tools.sync')).toEqual([]);
  });

  it('sends one sync with descriptors only for tools registered together', async () => {
    const p = page();
    await Promise.all([p.mc.registerTool(tool('reading_position')), p.mc.registerTool(tool('go_to'))]);
    await tick();
    const syncs = p.requests('page_tools.sync');
    expect(syncs).toHaveLength(1);
    expect(syncs[0].payload).toEqual({
      tools: [
        { name: 'reading_position', description: 'reading_position tool', inputSchema: { type: 'object' } },
        { name: 'go_to', description: 'go_to tool', inputSchema: { type: 'object' } },
      ],
    });
  });

  it('syncs again on unregister, including down to an empty list', async () => {
    const p = page();
    const controller = new AbortController();
    await p.mc.registerTool(tool('temp'), { signal: controller.signal });
    await tick();
    controller.abort();
    await tick();
    const syncs = p.requests('page_tools.sync');
    expect(syncs.at(-1).payload).toEqual({ tools: [] });
  });

  it('leaves out an addTool tool the agent could not be offered, keeping the rest', async () => {
    const p = page();
    p.mc.addTool({ name: 'bad name', handler: () => 1 });
    p.mc.addTool({ name: 'no_description', handler: () => 1 });
    await tick();
    const names = p.requests('page_tools.sync').at(-1).payload.tools.map((t) => t.name);
    expect(names).toEqual(['no_description']);
    expect(p.requests('page_tools.sync').at(-1).payload.tools[0].description).toBe('no_description');
  });

  it('flushes a pending sync before agent.run is sent', async () => {
    const p = page();
    p.mc.registerTool(tool('go_to')); // not awaited: the sync is still pending
    const run = p.window.agent.run({ task: 'Where am I?' });
    run[Symbol.asyncIterator]().next();
    await tick();
    const order = p.posted.map((m) => m.request?.type).filter(Boolean);
    expect(order.indexOf('page_tools.sync')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('page_tools.sync')).toBeLessThan(order.indexOf('agent.run'));
  });

  it('flushes a pending sync before agent.chat.open is sent', async () => {
    const p = page();
    p.mc.registerTool(tool('go_to'));
    p.window.agent.chat.open({});
    await tick();
    const order = p.posted.map((m) => m.request?.type).filter(Boolean);
    expect(order.indexOf('page_tools.sync')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('page_tools.sync')).toBeLessThan(order.indexOf('agent.chat.open'));
  });
});

describe("a tool's title, outputSchema and annotations", () => {
  const full = () => ({
    ...tool('mark'),
    title: 'Mark a plan',
    outputSchema: { type: 'object', properties: { url: { type: 'string' } } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  });

  it('keeps them on document.modelContext.tools', async () => {
    const p = page();
    await p.mc.registerTool(full());
    const [listed] = p.mc.tools;
    expect(listed.title).toBe('Mark a plan');
    expect(listed.outputSchema).toEqual({ type: 'object', properties: { url: { type: 'string' } } });
    expect(listed.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  it('sends them in page_tools.sync', async () => {
    const p = page();
    await p.mc.registerTool(full());
    await tick();
    expect(p.requests('page_tools.sync').at(-1).payload.tools[0]).toEqual({
      name: 'mark',
      description: 'mark tool',
      inputSchema: { type: 'object' },
      title: 'Mark a plan',
      outputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    });
  });

  it('leaves out ones of the wrong type, and still registers the tool', async () => {
    const p = page();
    await p.mc.registerTool({ ...tool('odd'), title: 5, outputSchema: [], annotations: 'read-only' });
    await tick();
    expect(Object.keys(p.requests('page_tools.sync').at(-1).payload.tools[0]).sort()).toEqual(['description', 'inputSchema', 'name']);
  });
});

describe('page_tools.call from the background', () => {
  it('runs execute with the input and a signal, and answers with the result', async () => {
    const p = page();
    const execute = vi.fn(async (input) => ({ at: input.anchor }));
    await p.mc.registerTool(tool('go_to', execute));
    p.deliver({ pageToolCall: { callId: 'c1', name: 'go_to', input: { anchor: 'p3' } } });
    await tick();
    expect(execute.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(p.results()).toEqual([{ callId: 'c1', ok: true, result: { at: 'p3' } }]);
  });

  it("answers with the handler's error message", async () => {
    const p = page();
    await p.mc.registerTool(tool('go_to', async () => { throw new Error('no such anchor'); }));
    p.deliver({ pageToolCall: { callId: 'c2', name: 'go_to', input: {} } });
    await tick();
    expect(p.results()).toEqual([{ callId: 'c2', ok: false, error: { message: 'no such anchor' } }]);
  });

  it('answers an unknown tool with an error', async () => {
    const p = page();
    p.deliver({ pageToolCall: { callId: 'c3', name: 'gone', input: {} } });
    await tick();
    expect(p.results()[0]).toMatchObject({ callId: 'c3', ok: false });
  });

  it("answers with an error when the result can't be sent", async () => {
    const p = page();
    await p.mc.registerTool(tool('fn', async () => () => 1));
    p.window.postMessage.mockImplementation((data) => {
      if (data.pageToolResult?.ok) throw new DOMException('could not be cloned', 'DataCloneError');
      p.posted.push(data);
    });
    p.deliver({ pageToolCall: { callId: 'c4', name: 'fn', input: {} } });
    await tick();
    expect(p.results()).toEqual([{ callId: 'c4', ok: false, error: { message: "The page tool's result can't be sent" } }]);
  });

  it('page_tools.cancel aborts the signal the handler got', async () => {
    const p = page();
    let seen;
    await p.mc.registerTool(tool('slow', (_input, { signal }) => { seen = signal; return new Promise(() => {}); }));
    p.deliver({ pageToolCall: { callId: 'c5', name: 'slow', input: {} } });
    await tick();
    expect(seen.aborted).toBe(false);
    p.deliver({ pageToolCancel: { callId: 'c5' } });
    expect(seen.aborted).toBe(true);
  });

  it('passes {} when the input is not an object', async () => {
    const p = page();
    const execute = vi.fn(async () => 'ok');
    await p.mc.registerTool(tool('t', execute));
    p.deliver({ pageToolCall: { callId: 'c6', name: 't', input: 'nope' } });
    await tick();
    expect(execute.mock.calls[0][0]).toEqual({});
  });
});
