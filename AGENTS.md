# Agent Guidelines for Harbor Development

This file provides guidance for AI coding assistants working on the Harbor codebase.

## Browser Priority

**Firefox is the PRIMARY browser.** All development, testing, and demos should target Firefox first.

- Firefox: Primary target
- Chrome/Chromium: Secondary target  
- Safari: Tertiary target (macOS App Store distribution)

## Extension Architecture

Harbor uses a **two-extension architecture**:

1. **Harbor Extension** (`extension/dist-firefox/`)
   - Background service for LLM providers, MCP servers, native bridge
   - Does NOT inject APIs into web pages directly

2. **Web Agents API Extension** (`web-agents-api/dist-firefox/`)
   - Injects `window.ai` and `window.agent` into web pages
   - Requires Harbor extension to be installed for full functionality

Both extensions must be loaded for demos and tests to work properly.

## Build Commands

```bash
# Build for Firefox (default)
npm run build

# Build for Chrome
npm run build:chrome

# Build for all browsers
npm run build:all
```

## Testing

```bash
# Run unit tests
npm run test:unit

# Run E2E browser tests (Firefox)
cd tests/e2e && npm run test:browser

# Run with browser visible for debugging
cd tests/e2e && npm run test:browser:keep-open
```

## Key Directories

- `extension/` - Harbor core extension
- `web-agents-api/` - Web Agents API extension (page-facing)
- `bridge-rs/` - Native messaging bridge (Rust)
- `demo/` - Demo pages for testing
- `tests/e2e/` - End-to-end browser tests (Harbor's own)
- `spec/testing/` - Test harness for **third-party** apps: run `scripts/generate-test-harness.mjs <target-dir>` to give them mocks + Playwright E2E

## Common Pitfalls

1. **Don't use Chromium for testing** - Use Firefox
2. **Don't forget both extensions** - Most features need both Harbor AND Web Agents API
3. **Check native bridge connection** - Many features require the Rust bridge running
