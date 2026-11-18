#!/usr/bin/env node
/**
 * Generate the Harbor test harness into a target project.
 *
 * Usage:
 *   node scripts/generate-test-harness.mjs [target-dir]
 *
 * If target-dir is omitted, uses current working directory.
 * Creates target-dir/harbor-test/ with mock, Playwright example, types, and README.
 *
 * The target project can then:
 *   - Import the mock: import { installWebAgentsMock } from './harbor-test/mock.js';
 *   - Use the Playwright config and fixtures for E2E with the Harbor extension.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(REPO_ROOT, 'spec', 'testing', 'harness-template');
const OUT_DIR_NAME = 'harbor-test';

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyRecursive(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function main() {
  const targetDir = path.resolve(process.cwd(), process.argv[2] || '.');
  const outDir = path.join(targetDir, OUT_DIR_NAME);

  if (!fs.existsSync(TEMPLATE_DIR)) {
    console.error('Error: Template not found at', TEMPLATE_DIR);
    console.error('Run this script from the Harbor repo (or ensure spec/testing/harness-template exists).');
    process.exit(1);
  }

  if (fs.existsSync(outDir)) {
    console.error('Error: Output directory already exists:', outDir);
    console.error('Remove it first or choose a different target.');
    process.exit(1);
  }

  copyRecursive(TEMPLATE_DIR, outDir);
  console.log('Created Harbor test harness at:', outDir);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Unit tests: import { installWebAgentsMock } from \'./harbor-test/mock.js\';');
  console.log('  2. E2E: copy harbor-test/playwright.harbor.config.example.ts to your Playwright config');
  console.log('     and set HARBOR_EXTENSION_PATH.');
  console.log('  3. See harbor-test/README.md for full instructions.');
}

main();
