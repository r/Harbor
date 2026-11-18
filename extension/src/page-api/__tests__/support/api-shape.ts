/// <reference types="node" />
/**
 * Harness for snapshotting the shape of the page-facing API that `injected.ts`
 * (base: web-agents-api/src/injected.ts; copy: extension/src/page-api/injected.ts)
 * registers on `window.ai`, `window.agent` and `navigator.modelContext`.
 *
 * `injected.ts` is a standalone script with no imports, written to run as a
 * plain (non-module) content-script injection. We transform it to a plain
 * IIFE with esbuild and run it in a `vm` context whose globals are minimal
 * stand-ins for `window`/`document`/`navigator`, then read back what got
 * registered. Node runs this file directly (type stripping), so the one-off
 * fixture-generation script can use it as well as the vitest test.
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'esbuild';

/**
 * Resolve `segments` relative to the directory of the module at `moduleUrl`
 * (pass a test file's `import.meta.url`).
 */
export function resolveFromModule(moduleUrl: string, ...segments: string[]): string {
  const dir = path.dirname(fileURLToPath(moduleUrl));
  return path.join(dir, ...segments);
}

/** Read and JSON.parse a fixture relative to a test file's `import.meta.url`. */
export function readJsonFixture(moduleUrl: string, ...segments: string[]): unknown {
  return JSON.parse(readFileSync(resolveFromModule(moduleUrl, ...segments), 'utf-8'));
}

/** A JSON-safe recursive description of a value's shape: keys and kinds, not data. */
export type Shape = string | { [key: string]: Shape };

export function shapeOf(value: unknown, seen: Set<unknown> = new Set()): Shape {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'function') return 'function';
  if (t !== 'object') return t; // string, number, boolean, undefined, symbol, bigint
  if (Array.isArray(value)) {
    return { __array: value.length > 0 ? shapeOf(value[0], seen) : 'empty' };
  }
  if (seen.has(value)) return '__circular__';
  seen.add(value);
  const out: { [key: string]: Shape } = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    out[key] = shapeOf(record[key], seen);
  }
  return out;
}

export interface ApiShape {
  ai: Shape;
  agent: Shape;
  modelContext: Shape;
}

/** What `injected.ts` registered on window.ai / window.agent / navigator.modelContext. */
export interface InjectedApi {
  ai: unknown;
  agent: unknown;
  modelContext: unknown;
}

/**
 * Load `filePath` (a standalone TS content-script, no imports) in a minimal
 * sandbox with `flags` injected at `flagsElementId`, and return the live
 * objects it registered on window.ai / window.agent / navigator.modelContext.
 */
export function loadInjectedApi(
  filePath: string,
  flags: Record<string, boolean>,
  flagsElementId: string,
): InjectedApi {
  const source = readFileSync(filePath, 'utf-8');
  const { code } = transformSync(source, { loader: 'ts', format: 'iife', target: 'es2022' });

  const doc = {
    getElementById(id: string) {
      return id === flagsElementId ? { textContent: JSON.stringify(flags) } : null;
    },
    querySelector() {
      return null;
    },
  };
  const win: Record<string, unknown> = {
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {
      return true;
    },
    postMessage() {},
  };
  const nav: Record<string, unknown> = {};
  const sandbox = {
    window: win,
    document: doc,
    navigator: nav,
    crypto: { randomUUID: () => 'test-uuid' },
    CustomEvent: class CustomEvent {
      type: string;
      detail: unknown;
      constructor(type: string, init?: { detail?: unknown }) {
        this.type = type;
        this.detail = init && init.detail;
      }
    },
    localStorage: undefined,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: filePath });

  return { ai: win.ai, agent: win.agent, modelContext: nav.modelContext };
}

/** The shape of what `loadInjectedApi` returns: keys and kinds, not data. */
export function loadInjectedApiShape(
  filePath: string,
  flags: Record<string, boolean>,
  flagsElementId: string,
): ApiShape {
  const api = loadInjectedApi(filePath, flags, flagsElementId);
  return {
    ai: shapeOf(api.ai),
    agent: shapeOf(api.agent),
    modelContext: shapeOf(api.modelContext),
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
