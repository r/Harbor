import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../injected.ts', import.meta.url), 'utf8');
const script = transformSync(source, { loader: 'ts', format: 'iife' }).code;

function page(flags?: string) {
  const window = {
    addEventListener: vi.fn(), dispatchEvent: vi.fn(), postMessage: vi.fn(),
  } as any;
  runInNewContext(script, {
    window, navigator: {}, crypto: webcrypto, console: { debug: vi.fn(), warn: vi.fn() },
    document: {
      querySelector: () => null,
      getElementById: () => flags === undefined ? null : { textContent: flags },
    },
    CustomEvent: class { constructor(public type: string, public options: unknown) {} },
    setTimeout, clearTimeout, Map, Set, Date, Math,
  });
  return window;
}

describe('page-facing Agentic Tool Use exposure', () => {
  it.each([undefined, '{invalid', '{}'])('enables runs with absent or incomplete flags: %s', (flags) => {
    const window = page(flags);
    expect(window.agent.capabilities().features.toolCalling).toBe(true);
    expect(window.agent.capabilities().features.browserControl).toBe(false);
    const run = window.agent.run({ task: 'What time is it?' });
    expect(run[Symbol.asyncIterator]).toBeTypeOf('function');
  });

  it('honors a saved opt-out at the actual page API', () => {
    const window = page('{"toolCalling":false}');
    expect(window.agent.capabilities().features.toolCalling).toBe(false);
    expect(() => window.agent.run({ task: 'What time is it?' })).toThrow(/not enabled/);
    expect(window.postMessage).not.toHaveBeenCalled();
  });
});
