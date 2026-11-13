# Changelog

All notable changes to Harbor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Public site redesign** — implemented the design produced in Claude Design. The site is now hand-written static HTML (`whitepaper/index.html`, `whitepaper/landscape.html`, `whitepaper/spec.html`, `whitepaper/build.html`, `whitepaper/styles.css`) with a Fraunces / Instrument Serif + Inter + JetBrains Mono type system, a single rust-clay accent, and a compare-and-contrast comparison table that re-stacks into cards on phones.
- **Internal positioning doc** at `docs/POSITIONING.md` captures the May 2026 landscape, the differentiation table, talking points by audience, and a source list. Source of truth for messaging.
- **Design paper trail** preserved in `whitepaper/DESIGN_NOTES.md`, `whitepaper/CLAUDE_DESIGN_PROMPT.md`, and `whitepaper/design-bundle/`.
- **`whitepaper/README.md`** documents the new site structure.

### Changed

- The public homepage introduces Harbor as a way to bring your own agent to the web, illustrates it with an archive search, directs readers to the Page Summarizer demo and Firefox setup, and links to the landscape essay for the full comparison.

- `README.md` — "Why This Exists" rewritten to reference the May 2026 landscape (Atlas, Comet, Gemini in Chrome, Brave Leo, Firefox AI Window, WebMCP, Chrome Prompt API) and to clarify Harbor's lane.
- `spec/README.md` — "The Problem" extended with a fourth bad option ("just use the user's AI browser") and a paragraph framing the gap left by WebMCP and the Chrome Prompt API.
- `AGENTS.md` — `whitepaper/` description updated to reflect the static-HTML structure and `docs/POSITIONING.md` flagged as the messaging source-of-truth.

### Removed

- The old Jekyll scaffolding under `whitepaper/` (`_config.yml`, `_layouts/`, `Gemfile`, `index.md`, `landscape.md`) — replaced by static HTML. `.nojekyll` added so GitHub Pages serves the files as authored.

## [0.1.0] - 2026-02-04

### Added

- Initial open source release
- **Harbor Extension**: Core infrastructure for browser-based AI
  - LLM provider connections (Ollama, OpenAI, Anthropic)
  - MCP server hosting (JavaScript and WASM)
  - Native messaging bridge (Rust)
  - Chat sidebar UI
  - OAuth flow support
- **Web Agents API Extension**: Page-facing AI capabilities
  - `window.ai` API for text generation
  - `window.agent` API for tools, browser control, and autonomous agents
  - Permission system with user consent prompts
  - Feature flags for advanced capabilities
- **Native Bridge** (Rust): Connects browser to local LLMs and services
- **MCP Server Support**: Host Model Context Protocol servers in the browser
  - JavaScript runtime for MCP servers
  - WASM runtime for compiled MCP servers
  - Built-in echo and time servers
  - Gmail example with OAuth
- **Browser Support**: Firefox (primary), Chrome, Safari (experimental)
- **Documentation**: Comprehensive guides for users and developers
- **Demo Pages**: Interactive examples showcasing the APIs

### Known Limitations

- Streaming abort not fully implemented
- Address bar LLM parsing is placeholder
- Permission granularity is basic (origin-level)
- Safari support is experimental
- Function calling uses response parsing (proper tool calling planned)

[0.1.0]: https://github.com/r/harbor/releases/tag/v0.1.0
