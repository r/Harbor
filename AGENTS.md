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
- `whitepaper/` - GitHub Pages site (static HTML, no Jekyll). `index.html`, `landscape.html`, `spec.html`, `build.html` + `styles.css`. See `whitepaper/README.md` for structure and `whitepaper/DESIGN_NOTES.md` for design rationale.
- `docs/POSITIONING.md` - **Source of truth** for how Harbor describes itself externally. Read it before writing decks, blog posts, or website copy. If you change framing on the site, change it here first so the website, the spec, the README, and any decks stay in sync.

## Common Pitfalls

1. **Don't use Chromium for testing** - Use Firefox
2. **Don't forget both extensions** - Most features need both Harbor AND Web Agents API
3. **Check native bridge connection** - Many features require the Rust bridge running

## Agentic Workflow

Agents working on a tracked task follow [docs/agent-workflow.md](docs/agent-workflow.md): **start → orchestrate → finalize → maintainer-approved merge**, plus **pre-close** when ending a session. The skills are in `.agents/skills/` (also available as `.claude/skills/`). Worker roles are in `.agents/roles/`, and their harness bindings are in [docs/harness-agents.md](docs/harness-agents.md).

The repo is public and the tracker (Linear, `HBR-123`) is internal. PRs, commits and docs must stand on their own; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Commit Attribution

Every commit an AI agent writes or substantially helps write ends with a `Co-Authored-By` trailer naming both the model that did the work and the harness that ran it. This applies in any harness (Claude Code, Codex, Pi, Cursor, or another), and to workers that commit under a coordinator's brief.

```text
Co-Authored-By: <model> (<harness>) <model vendor's no-reply address>
```

For example:

```text
Co-Authored-By: Claude Opus 5.5 (Claude Code) <noreply@anthropic.com>
Co-Authored-By: Claude Sonnet 5.5 (Pi) <noreply@anthropic.com>
```

Name the model that actually ran, not the one you asked for. Use the address of the model's vendor, not the harness's. If your harness adds its own trailer, replace it with one in this format rather than adding a second trailer. Older commits use other forms, such as `Cursor <cursoragent@cursor.com>`; leave them as they are. PRs opened by an agent say so at the end of the description, naming the harness.
