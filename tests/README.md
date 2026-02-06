# Harbor Test Suite

This directory contains the **test infrastructure for Harbor itself** (unit and E2E tests for the extensions, bridge, and demos).

**Testing your own app that uses the Web Agents API?** See [docs/TESTING_YOUR_APP.md](../docs/TESTING_YOUR_APP.md) — generate a test harness with mocks and Playwright from `scripts/generate-test-harness.mjs`.

## Quick Start

```bash
# From the repository root:

# Run all tests (unit + e2e)
npm test

# Run only unit tests
npm run test:unit

# Run only e2e tests
npm run test:e2e

# Run e2e tests with Playwright UI (great for debugging)
npm run test:e2e:ui
```

## Test Structure

```
tests/
├── e2e/                    # End-to-end browser tests (Playwright)
│   ├── fixtures/           # Test fixtures (extension loading, native bridge, etc.)
│   ├── specs/              # Test specifications
│   │   ├── extension-load.spec.ts
│   │   ├── native-bridge.spec.ts
│   │   └── demos/          # Demo page tests
│   └── playwright.config.ts
└── README.md
```

Unit tests live within each package:
- `extension/src/__tests__/` - Harbor extension unit tests
- `web-agents-api/src/__tests__/` - Web Agents API unit tests
- `bridge-ts/src/any-llm-ts/src/__tests__/` - LLM provider unit tests

## Prerequisites

### First-time Setup

```bash
# 1. Install all dependencies
npm run install:deps
cd tests/e2e && npm install

# 2. Install Playwright browsers (Firefox only)
cd tests/e2e && npx playwright install firefox

# 3. Build everything
npm run test:setup
```

This will:
- Build the extension (`extension/dist/`)
- Build the web-agents-api extension (`web-agents-api/dist/`)
- Build the native bridge (`bridge-rs/target/release/harbor-bridge`)
- Install the native messaging manifest

### Native Bridge

The native bridge must be built and the native messaging manifest installed:

```bash
cd bridge-rs
cargo build --release
./install.sh
```

## Running Tests

### Unit Tests

```bash
# TypeScript tests (vitest)
npm run test:unit:ts

# Rust tests
npm run test:unit:rust

# Or run tests for a specific package
cd extension && npm test
cd web-agents-api && npm test
cd bridge-ts/src/any-llm-ts && npm test
```

### E2E Tests

E2E tests use Playwright to automate Firefox with the extensions installed.

```bash
# Run all e2e tests
npm run test:e2e

# Run with Playwright UI (interactive debugging)
npm run test:e2e:ui

# Run in debug mode (step through tests)
npm run test:e2e:debug

# Run specific test file
cd tests/e2e && npx playwright test specs/extension-load.spec.ts

# Run tests matching a pattern
cd tests/e2e && npx playwright test -g "extension loads"
```

### Viewing Test Reports

After running tests, view the HTML report:

```bash
cd tests/e2e && npm run report
```

## Writing Tests

### Unit Tests (Vitest)

```typescript
// extension/src/__tests__/my-module.test.ts
import { describe, it, expect } from 'vitest';
import { myFunction } from '../my-module.js';

describe('myFunction', () => {
  it('should return expected value', () => {
    expect(myFunction('input')).toBe('expected');
  });
});
```

### E2E Tests (Playwright)

```typescript
// tests/e2e/specs/my-feature.spec.ts
import { test, expect } from '../fixtures/index.js';

test.describe('My Feature', () => {
  test('should work correctly', async ({ extensionContext, demoServer }) => {
    const page = await extensionContext.newPage();
    await page.goto(`${demoServer.url}/web-agents/my-demo/`);
    
    // Test assertions
    await expect(page.locator('h1')).toContainText('Expected Title');
  });
});
```

### Available Fixtures

- `extensionContext` - Browser context with both extensions loaded
- `extensionId` - Harbor extension UUID
- `webAgentsId` - Web Agents API extension UUID
- `sidebarPage` - Harbor sidebar page (already open)
- `nativeBridge` - Running native bridge process
- `demoServer` - Local HTTP server serving demo files

## CI/CD

Tests run automatically on GitHub Actions. See `.github/workflows/test.yml`.

## Troubleshooting

### Extension not loading

1. Make sure extensions are built: `npm run build`
2. Check that `extension/dist/manifest.json` exists

### Native bridge errors

1. Make sure bridge is built: `cd bridge-rs && cargo build --release`
2. Make sure manifest is installed: `cd bridge-rs && ./install.sh`
3. Check manifest location: `~/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge.json`

### Tests timing out

- E2E tests have a 60-second timeout by default
- Increase timeout in `playwright.config.ts` if needed
- Use `test.slow()` for individual slow tests

### Firefox profile issues

- Each test run creates a fresh Firefox profile
- Profiles are cleaned up automatically
- If issues persist, manually clear `/tmp/harbor-test-*` directories
