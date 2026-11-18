/**
 * Harness for snapshotting the shape of the page-facing API that `injected.ts`
 * (base: web-agents-api/src/injected.ts; copy: extension/src/page-api/injected.ts)
 * registers on `window.ai`, `window.agent` and `navigator.modelContext`.
 *
 * `injected.ts` is a standalone script with no imports, written to run as a
 * plain (non-module) content-script injection. We transform it to a plain
 * IIFE with esbuild and run it in a `vm` context whose globals are minimal
 * stand-ins for `window`/`document`/`navigator`, then read back what got
 * registered. This is plain JS (not TypeScript) so it can run unmodified from
 * a one-off fixture-generation script as well as from a vitest test.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

/**
 * Resolve `segments` relative to the directory of the module at `moduleUrl`
 * (pass a test file's `import.meta.url`). Kept here, in plain JS, so
 * extension/'s tsc run (which has no @types/node) never needs to type-check
 * `node:path` / `node:url` from a `.ts` test file.
 */
export function resolveFromModule(moduleUrl, ...segments) {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  return path.join(dir, ...segments);
}

/** Read and JSON.parse a fixture relative to a test file's `import.meta.url`. */
export function readJsonFixture(moduleUrl, ...segments) {
  return JSON.parse(readFileSync(resolveFromModule(moduleUrl, ...segments), 'utf-8'));
}

/** A JSON-safe recursive description of a value's shape: keys and kinds, not data. */
export function shapeOf(value, seen = new Set()) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'function') return 'function';
  if (t !== 'object') return t; // string, number, boolean, undefined, symbol, bigint
  if (Array.isArray(value)) {
    return { __array: value.length > 0 ? shapeOf(value[0], seen) : 'empty' };
  }
  if (seen.has(value)) return '__circular__';
  seen.add(value);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = shapeOf(value[key], seen);
  }
  return out;
}

/**
 * Load `filePath` (a standalone TS content-script, no imports) in a minimal
 * sandbox with `flags` injected at `flagsElementId`, and return the shape of
 * whatever it registered on window.ai / window.agent / navigator.modelContext.
 */
export function loadInjectedApiShape(filePath, flags, flagsElementId) {
  const source = readFileSync(filePath, 'utf-8');
  const { code } = transformSync(source, { loader: 'ts', format: 'iife', target: 'es2022' });

  const doc = {
    getElementById(id) {
      return id === flagsElementId ? { textContent: JSON.stringify(flags) } : null;
    },
    querySelector() {
      return null;
    },
  };
  const win = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    postMessage() {},
  };
  const nav = {};
  const sandbox = {
    window: win,
    document: doc,
    navigator: nav,
    crypto: { randomUUID: () => 'test-uuid' },
    CustomEvent: class CustomEvent {
      constructor(type, init) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    localStorage: undefined,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: filePath });

  return {
    ai: shapeOf(win.ai),
    agent: shapeOf(win.agent),
    modelContext: shapeOf(nav.modelContext),
  };
}

export const ALL_FLAGS_TRUE = {
  textGeneration: true,
  toolCalling: true,
  toolAccess: true,
  browserInteraction: true,
  browserControl: true,
  multiAgent: true,
};

export const ALL_FLAGS_FALSE = {
  textGeneration: false,
  toolCalling: false,
  toolAccess: false,
  browserInteraction: false,
  browserControl: false,
  multiAgent: false,
};
