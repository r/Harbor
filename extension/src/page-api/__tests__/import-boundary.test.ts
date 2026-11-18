/**
 * page-api/ is meant to stay swappable: a later unit can replace the agent
 * side (background-router.ts, extension-api.ts, ...) without touching the
 * page-facing contract. So production code under page-api/ may reach "the
 * rest of Harbor" only through harbor-core.ts (the one seam), a
 * `browser-compat` module, or a type-only import (erased at build time, so
 * it creates no runtime coupling). Everything else must stay inside
 * page-api/.
 */
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- plain JS helper; see support/import-boundary.mjs for why.
import { findImportBoundaryViolations } from './support/import-boundary.mjs';

describe('page-api only reaches the rest of Harbor through harbor-core, browser-compat, or types', () => {
  it('has no other value imports leaving page-api/', () => {
    const { files, violations } = findImportBoundaryViolations(import.meta.url);
    expect(files.length).toBeGreaterThan(0); // sanity: the copy has actually landed
    expect(violations).toEqual([]);
  });
});
