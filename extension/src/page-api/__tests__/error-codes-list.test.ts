import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErrorCodes } from '../types';

// `ErrorCodes` is Harbor's one list of the error codes a page can see.
// Every `ERR_*` code the extension's source emits must be on it, so the
// list can't drift from what handlers actually send. The docs, the spec and
// the test harness may name only codes on it, and the full table in
// docs/WEB_AGENTS_API.md lists all of them.

const SRC = fileURLToPath(new URL('../../', import.meta.url));
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const LISTED = new Set<string>(Object.values(ErrorCodes));

function files(dir: string, match: RegExp, skipDirs: string[] = []): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return skipDirs.includes(name) ? [] : files(path, match, skipDirs);
    }
    return match.test(name) ? [path] : [];
  });
}

function sourceFiles(): string[] {
  return files(SRC, /\.(ts|js|mjs)$/, ['__tests__']).filter((f) => !/\.(test|spec)\.(ts|js|mjs)$/.test(f));
}

/** Where Harbor describes its error codes to people building on it. */
function docFiles(): string[] {
  return [
    ...files(join(REPO, 'docs'), /\.(md|txt)$/, ['rfds']),
    ...files(join(REPO, 'spec'), /\.(md|js|mjs|ts)$/, ['node_modules']),
    ...files(join(REPO, 'whitepaper'), /\.html$/),
    join(REPO, 'ARCHITECTURE.md'),
    join(REPO, 'README.md'),
  ].filter(existsSync);
}

function unlisted(paths: string[], root: string, pattern: RegExp): string[] {
  const missing = new Set<string>();
  for (const file of paths) {
    for (const [, code] of readFileSync(file, 'utf8').matchAll(pattern)) {
      if (!LISTED.has(code)) missing.add(`${code} (${relative(root, file)})`);
    }
  }
  return [...missing].sort();
}

describe('ErrorCodes', () => {
  it('lists every error code the extension emits', () => {
    expect(unlisted(sourceFiles(), SRC, /['"`](ERR_[A-Z_]+)['"`]/g)).toEqual([]);
  });

  it('has no code the extension never emits', () => {
    const source = sourceFiles()
      .filter((f) => !f.endsWith(join('page-api', 'types.ts')))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const unused = Object.entries(ErrorCodes)
      .filter(([key, code]) => !source.includes(`'${code}'`) && !source.includes(`ErrorCodes.${key}`))
      .map(([, code]) => code);
    expect(unused).toEqual([]);
  });
});

describe('the docs', () => {
  it('name only error codes Harbor has', () => {
    expect(unlisted(docFiles(), REPO, /\b(ERR_[A-Z_]{3,})\b/g)).toEqual([]);
  });

  it("list every code in docs/WEB_AGENTS_API.md's error table", () => {
    const doc = readFileSync(join(REPO, 'docs', 'WEB_AGENTS_API.md'), 'utf8');
    const tabled = new Set([...doc.matchAll(/^\| `(ERR_[A-Z_]+)` \|/gm)].map(([, code]) => code));
    expect([...LISTED].filter((code) => !tabled.has(code)).sort()).toEqual([]);
  });
});
