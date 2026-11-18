#!/usr/bin/env node
/**
 * One-off generator for the API-surface fixtures. Run this against the BASE
 * (pre-copy) web-agents-api/src/injected.ts to produce the frozen fixtures
 * that extension/src/page-api/__tests__/api-surface.test.ts asserts the
 * copied injected.ts against. Re-run only if the page-facing contract is
 * intentionally changed (which needs a maintainer decision — see
 * docs/agent-workflow.md's "page-facing API contract").
 *
 * Usage: node generate-api-surface-fixture.mjs <path-to-base-injected.ts>
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInjectedApiShape, ALL_FLAGS_TRUE, ALL_FLAGS_FALSE } from '../support/api-shape.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = process.argv[2]
  ?? path.join(here, '../../../../../web-agents-api/src/injected.ts');

const allTrue = loadInjectedApiShape(sourcePath, ALL_FLAGS_TRUE, 'web-agents-api-flags');
const allFalse = loadInjectedApiShape(sourcePath, ALL_FLAGS_FALSE, 'web-agents-api-flags');

writeFileSync(path.join(here, 'api-surface.all-true.json'), JSON.stringify(allTrue, null, 2) + '\n');
writeFileSync(path.join(here, 'api-surface.all-false.json'), JSON.stringify(allFalse, null, 2) + '\n');

console.log(`Wrote fixtures from ${sourcePath}`);
