/**
 * navigator.modelContext / document.modelContext, run against the real
 * injected.ts. Follows the WebMCP draft's registerTool shape
 * (https://webmachinelearning.github.io/webmcp/): async, an `execute`
 * callback, unregistration by aborting the registration's signal, and
 * InvalidStateError for duplicate or invalid names. addTool/removeTool stay
 * as aliases for pages written against Harbor's earlier surface.
 */
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../injected.ts', import.meta.url), 'utf8');
const script = transformSync(source, { loader: 'ts', format: 'iife' }).code;

function page() {
  const window = { addEventListener: vi.fn(), dispatchEvent: vi.fn(), postMessage: vi.fn() };
  const navigator = {};
  const document = { querySelector: () => null, getElementById: () => null };
  runInNewContext(script, {
    window, navigator, document, crypto: webcrypto,
    console: { debug: vi.fn(), warn: vi.fn() },
    CustomEvent: class { constructor(type, options) { this.type = type; this.options = options; } },
    DOMException, AbortController, AbortSignal,
    setTimeout, clearTimeout, Map, Set, Date, Math,
  });
  return { window, navigator, document, mc: navigator.modelContext };
}

const tool = (name, extra = {}) => ({
  name, description: `${name} tool`, inputSchema: { type: 'object' }, execute: vi.fn(async () => `${name} ran`), ...extra,
});

describe('modelContext exposure', () => {
  it('exposes the same object on document and navigator', () => {
    const { document, navigator } = page();
    expect(document.modelContext).toBeDefined();
    expect(document.modelContext).toBe(navigator.modelContext);
  });
});

describe('registerTool', () => {
  it('resolves to undefined and lists the tool', async () => {
    const { mc } = page();
    await expect(mc.registerTool(tool('reading_position'))).resolves.toBeUndefined();
    expect(mc.tools.map(t => t.name)).toEqual(['reading_position']);
  });

  it('runs execute with the input and a signal when the page calls the tool', async () => {
    const { mc, window } = page();
    const t = tool('go_to');
    await mc.registerTool(t);
    await expect(window.agent.tools.call({ tool: 'page/go_to', args: { anchor: 'p3' } })).resolves.toBe('go_to ran');
    expect(t.execute).toHaveBeenCalledTimes(1);
    const [input, options] = t.execute.mock.calls[0];
    expect(input).toEqual({ anchor: 'p3' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('still accepts a handler in place of execute', async () => {
    const { mc, window } = page();
    const handler = vi.fn(() => 'handled');
    await mc.registerTool({ name: 'h', description: 'h tool', handler });
    await expect(window.agent.tools.call({ tool: 'page/h', args: {} })).resolves.toBe('handled');
  });

  it.each([
    ['a duplicate name', async (mc) => { await mc.registerTool(tool('dup')); return mc.registerTool(tool('dup')); }],
    ['an empty name', (mc) => mc.registerTool(tool(''))],
    ['a name with a space', (mc) => mc.registerTool(tool('two words'))],
    ['a name with a slash', (mc) => mc.registerTool(tool('a/b'))],
    ['a name longer than 128', (mc) => mc.registerTool(tool('x'.repeat(129)))],
    ['an empty description', (mc) => mc.registerTool(tool('nodesc', { description: '' }))],
  ])('rejects %s with InvalidStateError', async (_label, run) => {
    const { mc } = page();
    await expect(run(mc)).rejects.toMatchObject({ name: 'InvalidStateError' });
  });

  it('accepts the full name alphabet: letters, digits, _ - .', async () => {
    const { mc } = page();
    await expect(mc.registerTool(tool('Az09_-.'))).resolves.toBeUndefined();
  });

  it('rejects a missing execute with a TypeError', async () => {
    const { mc } = page();
    await expect(mc.registerTool({ name: 'x', description: 'x' })).rejects.toBeInstanceOf(TypeError);
  });

  it('unregisters the tool when its signal aborts', async () => {
    const { mc, window } = page();
    const controller = new AbortController();
    await mc.registerTool(tool('temp'), { signal: controller.signal });
    expect(mc.tools.map(t => t.name)).toEqual(['temp']);
    controller.abort();
    expect(mc.tools).toEqual([]);
    await expect(window.agent.tools.call({ tool: 'page/temp' })).rejects.toBeDefined();
  });

  it('aborting a stale signal leaves a re-registered tool of the same name alone', async () => {
    const { mc } = page();
    const first = new AbortController();
    await mc.registerTool(tool('again'), { signal: first.signal });
    mc.removeTool('again');
    await mc.registerTool(tool('again'));
    first.abort();
    expect(mc.tools.map(t => t.name)).toEqual(['again']);
  });

  it('rejects with the abort reason when the signal is already aborted', async () => {
    const { mc } = page();
    const controller = new AbortController();
    const reason = new Error('gone');
    controller.abort(reason);
    await expect(mc.registerTool(tool('late'), { signal: controller.signal })).rejects.toBe(reason);
    expect(mc.tools).toEqual([]);
  });

  it('rejects a non-empty exposedTo with NotSupportedError', async () => {
    const { mc } = page();
    await expect(mc.registerTool(tool('shared'), { exposedTo: ['https://other.example'] }))
      .rejects.toMatchObject({ name: 'NotSupportedError' });
    expect(mc.tools).toEqual([]);
    await expect(mc.registerTool(tool('mine'), { exposedTo: [] })).resolves.toBeUndefined();
  });
});

describe('addTool / removeTool aliases', () => {
  it('addTool still registers synchronously and removeTool removes', async () => {
    const { mc, window } = page();
    const handler = vi.fn(() => 'old');
    mc.addTool({ name: 'legacy', description: 'old style', handler });
    expect(mc.tools.map(t => t.name)).toEqual(['legacy']);
    await expect(window.agent.tools.call({ tool: 'page/legacy' })).resolves.toBe('old');
    expect(mc.removeTool('legacy')).toBe(true);
    expect(mc.tools).toEqual([]);
  });

  it('a tool added with addTool is a duplicate for registerTool', async () => {
    const { mc } = page();
    mc.addTool({ name: 'both', handler: () => 1 });
    await expect(mc.registerTool(tool('both'))).rejects.toMatchObject({ name: 'InvalidStateError' });
  });
});
