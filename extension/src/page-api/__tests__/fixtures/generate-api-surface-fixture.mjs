#!/usr/bin/env node
/**
 * Generator for the API-surface fixtures that
 * extension/src/page-api/__tests__/api-surface.test.ts asserts
 * page-api/injected.ts against. Re-run only when the page-facing contract
 * is intentionally changed (which needs a maintainer decision — see
 * docs/agent-workflow.md's "page-facing API contract"), and review the
 * fixture diff: it is the contract change.
 *
 * Usage: node generate-api-surface-fixture.mjs [path-to-injected.ts]
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadInjectedApiShape, ALL_FLAGS_TRUE, ALL_FLAGS_FALSE } from '../support/api-shape.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = process.argv[2]
  ?? path.join(here, '../../injected.ts');

const allTrue = loadInjectedApiShape(sourcePath, ALL_FLAGS_TRUE, 'harbor-page-api-flags');
const allFalse = loadInjectedApiShape(sourcePath, ALL_FLAGS_FALSE, 'harbor-page-api-flags');

writeFileSync(path.join(here, 'api-surface.all-true.json'), JSON.stringify(allTrue, null, 2) + '\n');
writeFileSync(path.join(here, 'api-surface.all-false.json'), JSON.stringify(allFalse, null, 2) + '\n');

console.log(`Wrote fixtures from ${sourcePath}`);
