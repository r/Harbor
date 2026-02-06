# Plan: Testing Support for Third-Party Developers

This document outlines a plan to make it easy for developers building on top of Harbor (using `window.ai` and `window.agent`) to test their applications.

---

## Primary Flow: Generate → Import (or Point Cursor Here)

**Goal:** Someone checks out (or references) this repo and can **generate** a test harness they **import** into their project—or point Cursor at Harbor and have the AI pull in what they need—so they can test their Harbor-based code quickly.

**Ways to get the harness:**

1. **Generate into their project**  
   From Harbor’s repo: run a script that copies a ready-made test harness into a directory they choose (e.g. their project root or `tests/harbor/`). The harness includes mocks, Playwright config + fixtures, types, and a small README. They then import from that path (e.g. `import { installWebAgentsMock } from './harbor-test/mock'`).

2. **Point Cursor at this repo**  
   When working in *their* project, they add Harbor as a reference (e.g. `@harbor` or the Harbor repo path). A Cursor rule in Harbor tells the AI: “When the user wants to test their Web Agents API app, use the test harness from Harbor’s `spec/testing/`—either suggest running the generator or copy the relevant files into their project.” The AI can then generate the same harness or wire up mocks/E2E using Harbor’s templates.

**Concrete deliverables:**

- **Generator script** in Harbor (e.g. `scripts/generate-test-harness.mjs`) that copies `spec/testing/harness-template/` into a target directory. Can be run as `node scripts/generate-test-harness.mjs /path/to/their/project` or from their project: `npx --yes harbor-test-init` (if we add a small wrapper or document `git clone + node path/to/generate-test-harness.mjs .`).
- **Harness template** under `spec/testing/harness-template/`: mocks, Playwright config + fixture, optional types, and `README.md` explaining how to run unit and E2E tests and where to point extension paths.
- **Cursor rule** in Harbor (e.g. `.cursor/rules/third-party-testing.mdc`) that describes when and how to use Harbor’s testing assets so that “point Cursor at this repo” gives the AI clear instructions to accelerate the other party’s testing setup.

**Entry points (for humans and for Cursor):**

| Want to… | Look here |
|----------|-----------|
| Generate the test harness into my project | Run `node scripts/generate-test-harness.mjs <target-dir>` from Harbor, or see `spec/testing/README.md` |
| Copy or reference the harness template | `spec/testing/harness-template/` |
| Understand what the harness contains | `spec/testing/harness-template/README.md` |
| Have Cursor set up testing in my app | Point Cursor at Harbor and ask for “Harbor test harness” or “test my Web Agents API app”; see `.cursor/rules/third-party-testing.mdc` |
| Read the full plan | This doc (`docs/THIRD_PARTY_TESTING_PLAN.md`) |

---

## Context

**Who:** Third-party developers whose web apps depend on the Web Agents API (Harbor’s injected `window.ai` and `window.agent`). They do **not** need to clone or build Harbor; they only need the extensions installed.

**Current gap:** Harbor’s own tests (Playwright e2e + unit tests) are tailored to the monorepo. There is no official story for external devs to:

- Run **unit/integration tests** without a real browser or extensions (e.g. in Node or jsdom).
- Run **E2E tests** against their app with Harbor extensions (and optionally the native bridge) in a repeatable way.

**References:** [BUILDING_ON_WEB_AGENTS_API.md](./BUILDING_ON_WEB_AGENTS_API.md), [tests/README.md](../tests/README.md), [spec/examples/](../spec/examples/).

---

## Goals

1. **Unit/integration tests** – Third-party apps can test their logic (permission flow, session handling, tool calls, UI) without launching a browser or installing extensions.
2. **E2E tests** – Third-party apps can run Playwright (or similar) with Harbor + Web Agents API extensions (and optionally the native bridge) so their app is tested in a real environment.
3. **Low friction** – Setup is documented and, where possible, provided as reusable config or a small package so copying from Harbor’s repo is optional.
4. **Stability** – Test utilities and fixtures stay aligned with the Web Agents API surface (permissions, `window.ai`, `window.agent`, error codes).

---

## Plan Overview

| # | Deliverable | Purpose |
|---|-------------|--------|
| 1 | **Mock / test double library** for `window.ai` and `window.agent` | Unit/integration tests in Node or jsdom without real extensions |
| 2 | **TypeScript types package** (optional but recommended) | Typed mocks and app code; single source of truth for API shape |
| 3 | **Reusable E2E harness** (config + fixtures) | Run Playwright with Harbor extensions loaded so 3rd party specs “just work” |
| 4 | **Documentation** | “Testing your Harbor app” guide: mocks, E2E setup, CI, examples |

---

## 1. Mock / Test Double Library

**What:** A small runtime that implements the same interface as `window.ai` and `window.agent` with controllable behavior (stub responses, permission grants, errors).

**Where it could live:**

- **Option A:** New package in the repo, e.g. `packages/harbor-test-utils` or `testing/web-agents-mock`, published (or not) as `@harbor/test-utils` or kept as a reference.
- **Option B:** A single file (or small module) under `spec/` or `docs/` that 3rd parties copy into their project (e.g. `spec/testing/mock-web-agents.js`).

**Capabilities:**

- **`window.agent.requestPermissions({ scopes, reason })`** – Resolve with `{ granted: true/false, scopes }`; allow tests to configure “always grant” or “deny.”
- **`window.agent.permissions.list()`** – Return configurable scopes/grants.
- **`window.ai.createTextSession(options)`** – Return a session object with:
  - `prompt(text)` → Promise with configurable string or error.
  - `promptStreaming(text)` → AsyncIterable of `{ type, token? }` (configurable chunks).
  - `destroy()` → no-op.
- **`window.agent.tools.list()`** – Return configurable list of tools.
- **`window.agent.tools.call({ tool, args })`** – Return configurable result or throw with `code` (e.g. `ERR_TOOL_NOT_FOUND`).
- **`window.agent.run({ task, ... })`** – AsyncIterable of events: `status`, `tool_call`, `tool_result`, `token`, `final`, `error` (configurable).
- **Error shape** – Objects with `code` and `message` matching real API (`ERR_PERMISSION_DENIED`, `ERR_SCOPE_REQUIRED`, etc.).

**Usage pattern (in 3rd party app):**

```javascript
// In test setup (Node or jsdom)
import { installWebAgentsMock } from '@harbor/test-utils'; // or local copy

const mock = installWebAgentsMock(globalThis);
mock.permissions.grantAll();
mock.ai.textSessionResponse = 'Mocked reply';
mock.agent.runOutput = 'Task done';

// Now app code that uses window.ai / window.agent runs against mocks
```

**Out of scope for v1:** Full fidelity for every API (e.g. browser tabs, BYOC, multi-agent). Focus on the most common paths: permissions, text session, tools list/call, `agent.run`.

---

## 2. TypeScript Types Package (Optional)

**What:** A `.d.ts` (or small TS package) that describes `window.ai` and `window.agent` so that:

- Third-party apps can use typed `window.ai` / `window.agent` in their code.
- The mock library can implement the same interface and stay in sync.

**Where:** Could be:

- A `types` or `web-agents-api-types` package in the repo (e.g. `packages/web-agents-api-types`), publishable as `@harbor/web-agents-api-types` or similar.
- Or a single `web-agents-api.d.ts` in the spec or docs for copy-paste.

**Contents:** Extract the types already described in [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md) / [BUILDING_ON_WEB_AGENTS_API.md](./BUILDING_ON_WEB_AGENTS_API.md) into a single place: `TextSession`, `PermissionScope`, `PermissionGrantResult`, `RunEvent`, `ApiError`, etc., plus `Window` augmentation for `ai` and `agent`.

**Benefit:** One source of truth for the API shape; mocks and docs can reference it. Not strictly required for the mock library (could use inline types), but recommended for maintainability and 3rd party DX.

---

## 3. Reusable E2E Harness (Playwright + Extensions)

**What:** A way for 3rd party projects to run Playwright E2E tests in a Firefox (or Chrome) environment where:

- Harbor extension is loaded.
- Web Agents API extension is loaded.
- Optional: native bridge is running (for full LLM/MCP behavior).

**Challenges (from current Harbor e2e):**

- Firefox: Loading unpacked extensions requires a profile with the extension installed; Playwright doesn’t drive `about:debugging`, so Harbor uses `web-ext run` to launch Firefox with the extension, which doesn’t yield a Playwright `BrowserContext` for that same instance.
- Two extensions must be loaded (Harbor + Web Agents API); paths and IDs must be correct.
- Native bridge: 3rd party may want to skip it for “API presence” tests and enable it for “full stack” tests.

**Possible approaches:**

**Option A – Documented “copy fixtures” approach**

- Document in Harbor how to run Playwright with two extensions (e.g. Chrome with `launchOptions.args` and `--load-extension=path1,path2`, or Firefox with a pre-built profile).
- Publish a minimal “starter” Playwright config + fixture file (e.g. in `spec/testing/` or `docs/testing/`) that 3rd parties copy into their repo. They point `extensionPath` / `webAgentsPath` to their local Harbor build or to a pre-built artifact (e.g. from a GitHub release).

**Option B – NPM package with Playwright fixtures**

- New package, e.g. `@harbor/playwright` or `harbor-e2e-harness`, that:
  - Depends on `@playwright/test`.
  - Exports fixtures: e.g. `harborPage` (page with extensions loaded), `demoServer` (optional), `nativeBridge` (optional).
  - Expects env vars or config for paths to Harbor and Web Agents API build outputs (or downloads them from a release).
- 3rd party: `npm i -D @harbor/playwright`, extend the base config, and use the fixtures in their specs.

**Option C – Script that builds and runs**

- A small script (e.g. `npx harbor-e2e` or a script in the repo) that: builds Harbor + Web Agents API (or uses pre-built), installs native bridge if requested, then runs the consumer’s Playwright project with the right env/paths. Reduces config burden but adds a custom entry point.

**Recommendation:** Start with **Option A** (documented config + copyable fixtures) to avoid publishing/maintenance overhead; add **Option B** if demand justifies it. Option A should explicitly cover:

- **Chrome:** Loading two unpacked extensions via `launchOptions.args` and a stable way to get extension IDs (e.g. from manifest or a fixed dev build).
- **Firefox:** Either a persistent profile with both extensions pre-installed (and instructions to create it once), or the existing `web-ext run` approach with a note that the “browser under test” is the one launched by web-ext (and how to point tests at a test page served locally).

**Deliverables:**

- `docs/TESTING_YOUR_APP.md` (or a section in DEVELOPER_GUIDE) with:
  - Playwright config snippet for Chrome (and, if feasible, Firefox) with two extensions.
  - Optional: link or copy of a minimal fixture file that provides a “page with Harbor + Web Agents API” and optional demo server.
- Optional: `spec/testing/playwright.harbor.config.example.ts` and `spec/testing/fixtures/harbor.ts` in the repo for copy-paste.

---

## 4. Documentation

**New or updated docs:**

- **“Testing your Harbor app”** (e.g. `docs/TESTING_YOUR_APP.md` or a section in [DEVELOPER_GUIDE.md](./DEVELOPER_GUIDE.md)):
  - **Unit/integration tests:** How to use the mock library; where to get it (package or copy); example with a small “chat” or “tool call” flow.
  - **E2E tests:** Prerequisites (Node, Playwright, Firefox/Chrome); how to get extension paths (build Harbor vs download); step-by-step Playwright config; how to handle permissions in tests (e.g. pre-grant via extension storage or accept dialogs); link to example fixtures if provided.
  - **CI:** Running unit tests in CI; running E2E in CI (e.g. build extensions, install native messaging host, run Playwright); note on Firefox vs Chrome for CI.
- **BUILDING_ON_WEB_AGENTS_API.md:** Add a short “Testing” section that links to the testing guide and mentions mocks + E2E option.

**Optional:** A minimal example repo or a `demo/testing-example/` in Harbor that shows a tiny app using `window.ai`/`window.agent` with both mock-based tests and one E2E spec using the harness.

---

## Implementation Order

1. **Mock library (1)** – Implement and document; can live in-repo as `testing/web-agents-mock` or `packages/harbor-test-utils` (no publish required for first version; 3rd parties can copy or use via file dependency).
2. **Documentation (4)** – Add “Testing your Harbor app” and link from BUILDING_ON_WEB_AGENTS_API; document mock usage and E2E approach (even if E2E is “copy this config” for now).
3. **E2E harness (3)** – Provide example Playwright config + fixture for Chrome (and Firefox if straightforward); document in the testing guide.
4. **TypeScript types (2)** – Extract types to a single module or package so mocks and docs stay consistent; can be done in parallel or right after the mock API is stable.

---

## Success Criteria

- A developer building a site that uses only `window.agent.requestPermissions`, `window.ai.createTextSession`, and `session.prompt` can:
  - Write a unit test that mocks the API and asserts their UI/logic without a browser.
  - Run an E2E test that loads their page in a browser with Harbor + Web Agents API extensions and asserts that the real API is present (e.g. `expect(await page.evaluate(() => window.ai != null)).toBe(true)` and optionally a short happy path).
- The steps to do both are documented in one place (“Testing your Harbor app”) and, where possible, backed by copy-paste or npm-installable artifacts.
- **Generate → Import:** They can run one command (or have Cursor do it) to get a test harness into their project and start testing with minimal setup.
- **Cursor at Harbor:** Pointing Cursor at this repo gives the AI clear instructions so it can suggest the generator, copy the harness, or wire mocks/E2E from Harbor’s `spec/testing/` into the user’s project.

---

## Open Questions

- **Publishing:** Should the mock library and/or types be published to npm under a `@harbor/*` scope, or stay copy-paste / git submodule / file dependency only?
- **Firefox E2E:** Is “create a profile once with both extensions, then reuse it in Playwright” acceptable for 3rd parties, or do we need a fully automated “no manual steps” flow for Firefox?
- **Native bridge in E2E:** Should the harness optionally start/stop the native bridge, or assume it’s already installed and running (or not needed)?
- **Versioning:** How to keep the mock and types in sync with the real API (e.g. same repo, shared types, or a compatibility matrix in docs)?

---

## Summary

| Deliverable | Effort (rough) | Outcome |
|-------------|----------------|--------|
| Mock library | Small (1–2 days) | 3rd parties can unit test without browser/extensions |
| Types package | Small (0.5–1 day) | Consistent, typed API surface for app + mocks |
| E2E harness (docs + example) | Small–medium (1–2 days) | 3rd parties can run E2E with real Harbor in a documented way |
| Testing doc | Small (0.5 day) | Single place to learn “how to test my Harbor app” |

Overall, this plan focuses on **mocks for unit/integration tests** and **documented, reusable E2E setup** so that 3rd party developers can test their Harbor-based apps with minimal friction and without deep knowledge of Harbor’s internals.
