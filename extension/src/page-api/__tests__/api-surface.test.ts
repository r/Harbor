/**
 * API-surface parity test.
 *
 * The page-facing contract (window.ai, window.agent, navigator.modelContext)
 * must not change shape when the Web Agents API's injected.ts is copied into
 * Harbor as page-api/injected.ts. The fixtures in __tests__/fixtures/ are
 * frozen from the BASE web-agents-api/src/injected.ts (see
 * generate-api-surface-fixture.mjs); this test asserts the copy produces the
 * identical shape, with all feature flags on and all off.
 *
 * It fails until extension/src/page-api/injected.ts exists and registers the
 * same surface under the renamed flags element id ('harbor-page-api-flags').
 */
import { describe, expect, it } from 'vitest';
// Plain JS harness (shared with the fixture generator script): extension/
// has no @types/node, so file/path handling lives here instead of needing
// node:fs/path/url typed from a .ts test.
// @ts-expect-error -- no .d.ts for this .mjs module.
import { loadInjectedApiShape, ALL_FLAGS_TRUE, ALL_FLAGS_FALSE, resolveFromModule, readJsonFixture } from './support/api-shape.mjs';

const INJECTED_PATH = resolveFromModule(import.meta.url, '../injected.ts');
const FLAGS_ELEMENT_ID = 'harbor-page-api-flags';

const allTrueFixture = readJsonFixture(import.meta.url, 'fixtures/api-surface.all-true.json');
const allFalseFixture = readJsonFixture(import.meta.url, 'fixtures/api-surface.all-false.json');

describe('page-api/injected.ts matches the base Web Agents API surface', () => {
  it('with every feature flag on', () => {
    const shape = loadInjectedApiShape(INJECTED_PATH, ALL_FLAGS_TRUE, FLAGS_ELEMENT_ID);
    expect(shape).toEqual(allTrueFixture);
  });

  it('with every feature flag off', () => {
    const shape = loadInjectedApiShape(INJECTED_PATH, ALL_FLAGS_FALSE, FLAGS_ELEMENT_ID);
    expect(shape).toEqual(allFalseFixture);
  });
});
