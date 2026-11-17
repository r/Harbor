/**
 * Runtime extension paths must name files the build actually ships.
 *
 * build.mjs writes every bundle and static page to the root of
 * dist-<browser>/ (esbuild `outbase: 'src'`, plus copyFile/cp into
 * `${outDir}/...`). Code that asks for `dist/...` at runtime gets a blank
 * window, a failed script injection or a worker that never loads.
 *
 * This test reads build.mjs to learn what the build emits, then checks
 * every literal path the extension passes to runtime.getURL,
 * scripting.executeScript({ files }) or the built-in worker map.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';

// The extension's tsconfig has no Node types, so type only what's used.
interface NodeFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
  readdirSync(path: string, opts: { withFileTypes: true }): { name: string; isDirectory(): boolean }[];
}
let fs: NodeFs;

const EXTENSION_ROOT = decodeURIComponent(new URL('../..', import.meta.url).pathname).replace(/\/$/, '');
const SRC = `${EXTENSION_ROOT}/src`;
const join = (...parts: string[]): string => parts.join('/');

// Source files that the build never bundles. Their paths can't be loaded,
// so they aren't checked. Kept explicit so a new entry point can't hide here.
const NOT_BUILT = new Set(['agents/content-script.ts']);

interface BuildOutputs {
  files: Set<string>;
  // Directories copied wholesale: output prefix -> source directory.
  dirs: Map<string, string>;
  entrySources: Set<string>;
  // HTML pages copied by build.mjs: output path -> source path.
  pages: Map<string, string>;
}

function readBuildOutputs(): BuildOutputs {
  const build = fs.readFileSync(join(EXTENSION_ROOT, 'build.mjs'), 'utf8');
  const files = new Set<string>();
  const dirs = new Map<string, string>();
  const entrySources = new Set<string>();
  const pages = new Map<string, string>();

  const entries = build.match(/const entryPoints = \[([\s\S]*?)\];/);
  if (!entries) throw new Error('build.mjs: entryPoints not found');
  for (const m of entries[1].matchAll(/'src\/([^']+)\.ts'/g)) {
    entrySources.add(`${m[1]}.ts`);
    files.add(`${m[1]}.js`);
  }

  for (const m of build.matchAll(/copyFile\(\s*'([^']+)',\s*`\$\{outDir\}\/([^`]+)`/g)) {
    files.add(m[2]);
    if (m[2].endsWith('.html')) pages.set(m[2], m[1]);
  }
  for (const m of build.matchAll(/\bcp\(\s*'([^']+)',\s*`\$\{outDir\}\/([^`]+)`/g)) {
    dirs.set(m[2], m[1]);
  }
  return { files, dirs, entrySources, pages };
}

function isShipped(path: string, outputs: BuildOutputs): boolean {
  if (outputs.files.has(path)) return true;
  for (const [prefix, sourceDir] of outputs.dirs) {
    if (path.startsWith(`${prefix}/`)) {
      return fs.existsSync(join(EXTENSION_ROOT, sourceDir, path.slice(prefix.length + 1)));
    }
  }
  return false;
}

// Resolve a page-relative reference ("./a.js", "../b.css") to an output path.
function resolveFromPage(page: string, ref: string): string {
  const parts = page.split('/').slice(0, -1);
  for (const seg of ref.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

// Local scripts and stylesheets a shipped page loads. Remote URLs, data: URIs
// and fragments aren't build outputs, so they're skipped.
function pageReferences(html: string): string[] {
  const refs: string[] = [];
  for (const m of html.matchAll(/<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g)) {
    const ref = m[1].split(/[?#]/)[0];
    if (!ref || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(ref)) continue;
    refs.push(ref);
  }
  return refs;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name;
    const full = join(dir, name);
    if (entry.isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...sourceFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

interface PathUse {
  file: string;
  path: string;
}

// Literal paths only. Dynamic ones (server.wasmUrl and similar) come from
// manifests and are checked where they are installed.
function runtimePathUses(): PathUse[] {
  const uses: PathUse[] = [];
  const patterns = [
    /(?:getURL|getExtensionURL)\(\s*[`'"]([^`'"?$]+)/g,
    /files:\s*\[\s*[`'"]([^`'"]+)[`'"]/g,
  ];
  for (const full of sourceFiles(SRC)) {
    const file = full.slice(SRC.length + 1);
    if (NOT_BUILT.has(file)) continue;
    const text = fs.readFileSync(full, 'utf8');
    for (const re of patterns) {
      for (const m of text.matchAll(re)) uses.push({ file, path: m[1] });
    }
    const workerMap = text.match(/BUILTIN_WORKER_MAP[^=]*=\s*\{([\s\S]*?)\}/);
    if (workerMap) {
      for (const m of workerMap[1].matchAll(/:\s*['"`]([^'"`]+)['"`]/g)) uses.push({ file, path: m[1] });
    }
  }
  return uses;
}

describe('runtime extension paths', () => {
  let outputs: BuildOutputs;
  let uses: PathUse[];

  beforeAll(async () => {
    fs = await vi.importActual<NodeFs>('node:fs');
    outputs = readBuildOutputs();
    uses = runtimePathUses();
  });

  it('finds the paths it is meant to guard', () => {
    const paths = uses.map((u) => u.path.replace(/^dist\//, ''));
    expect(paths).toEqual(
      expect.arrayContaining([
        'permission-prompt.html',
        'page-chat.js',
        'js-runtime/builtin-echo-worker.js',
      ]),
    );
  });

  it('every literal runtime path names a file the build ships', () => {
    const missing = uses
      .filter((u) => !isShipped(u.path, outputs))
      .map((u) => `${u.file}: ${u.path}`);
    expect(missing).toEqual([]);
  });

  it('every shipped HTML page loads only scripts and styles the build ships', () => {
    expect(outputs.pages.size).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const [page, source] of outputs.pages) {
      const html = fs.readFileSync(join(EXTENSION_ROOT, source), 'utf8');
      for (const ref of pageReferences(html)) {
        const path = resolveFromPage(page, ref);
        if (!isShipped(path, outputs)) missing.push(`${page}: ${ref}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('files skipped as not built really are not entry points', () => {
    for (const file of NOT_BUILT) {
      expect(outputs.entrySources.has(file)).toBe(false);
    }
  });
});
