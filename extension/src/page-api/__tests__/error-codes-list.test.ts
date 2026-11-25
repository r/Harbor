import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ErrorCodes } from '../types';

// `ErrorCodes` is Harbor's one list of the error codes a page can see.
// Every `ERR_*` code the extension's source emits must be on it, so the
// list can't drift from what handlers actually send.

const SRC = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) ? [path] : [];
  });
}

describe('ErrorCodes', () => {
  it('lists every error code the extension emits', () => {
    const listed = new Set<string>(Object.values(ErrorCodes));
    const missing = new Set<string>();
    for (const file of sourceFiles(SRC)) {
      for (const [, code] of readFileSync(file, 'utf8').matchAll(/['"`](ERR_[A-Z_]+)['"`]/g)) {
        if (!listed.has(code)) missing.add(`${code} (${relative(SRC, file)})`);
      }
    }
    expect([...missing].sort()).toEqual([]);
  });
});
