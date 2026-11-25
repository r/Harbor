# Harbor Test Suite

This directory contains the **test infrastructure for Harbor itself** (unit and E2E tests for the extension, bridge, and demos).

**Testing your own app that uses the Web Agent API?** See [docs/TESTING_YOUR_APP.md](../docs/TESTING_YOUR_APP.md) — generate a test harness with mocks and Playwright from `scripts/generate-test-harness.mjs`.

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

## Fresh-install Getting Started checklist

After `npm run build`, run from the repository root:

```bash
node tests/e2e/test-getting-started.mjs
```

This launches Firefox with Harbor in a temporary profile and runs all five checklist steps, including the normal localhost permission prompt, time-tool discovery, a real model tool call, and the displayed response. It starts its own demo server on a free loopback port and closes its browser afterward. It does not seed extension settings or configure a model. The native bridge must already be registered and a default model must be available; ready Apple Intelligence works without a saved model. An unavailable model fails the test rather than being skipped.

## MCP server links in Firefox

After `npm run build` in `extension/`, run from `tests/e2e`:

```bash
node test-mcp-discover.mjs
```

It serves a page with several `<link>` declarations on a free loopback port and checks which ones `window.agent.mcp.discover()` reports in Firefox: `rel="mcp-server"` and `rel="mcp"` as tokens of a rel list, matched without regard to case, and `streamable-http` when a link names no `data-transport`. It needs no model and no bridge.

## Real-site check: tale.fyi

tale.fyi supports Harbor: it declares its MCP server with `<link rel="mcp-server">` and registers page tools through `document.modelContext`. To check that Harbor still works with it, run from `tests/e2e`:

```bash
npm run test:tale
```

The person's agent, running outside the browser, opens a Tale book through the real `harbor-mcp` binary and uses Tale's tools: it reads the reading position, moves the reader, finds a passage, points at a paragraph, and plays and pauses. It also checks that `window.agent.mcp.discover()` finds Tale's server. It never calls `mark` or `unmark`, because those publish to tale.fyi.

It needs the network and a live third-party site, so it is run by hand and is not part of `test:all` or CI. It needs the extension built, `harbor-mcp` built (`cargo build --release --manifest-path bridge-rs/Cargo.toml`) and the native bridge registered. It skips if `harbor-mcp` is missing or tale.fyi can't be reached. Pass `--url=<another Tale book>` to try a different book.

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
- `extension/src/__tests__/` - Harbor extension unit tests, including `extension/src/page-api/__tests__/` for the page API
- `bridge-rs/` - Rust bridge unit tests (run with Cargo)

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
# TypeScript tests (Vitest in the extension package)
npm run test:unit:ts

# Rust tests
npm run test:unit:rust

# Or run tests for a specific package from the repository root
npm test --prefix extension
cargo test --manifest-path bridge-rs/Cargo.toml
```

### E2E Tests

E2E tests use Playwright to automate Firefox with the extension installed.

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

- `extensionContext` - Browser context with Harbor loaded
- `extensionId` - Harbor extension UUID
- `sidebarPage` - Harbor sidebar page (already open)
- `nativeBridge` - Running native bridge process
- `demoServer` - Local HTTP server serving demo files

## CI/CD

Tests run automatically on GitHub Actions. See `.github/workflows/test.yml`.

## Troubleshooting

### Extension not loading

1. Make sure the extension is built: `npm run build`
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
