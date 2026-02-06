# Instructions: Add Harbor Testing to This Project (Option 2 — Submodule)

**Use this in the project that depends on the Web Agents API** (`window.ai` / `window.agent`). Feed this file to Cursor (or follow it yourself) so it: (1) adds Harbor as a submodule, (2) generates the test harness, (3) wires this project’s tests to the harness, and (4) updates this project’s docs.

---

## Context

- **This project** = the repo you’re in now (the app that uses `window.ai` / `window.agent`).
- **Harbor** = the repo that provides the test harness (mocks + Playwright E2E). You will add it as a git submodule and run its generator to get a `harbor-test/` folder here.

---

## Step 1: Add Harbor as a submodule

From **this project’s root**:

```bash
git submodule add https://github.com/r/harbor.git harbor
git submodule update --init --recursive
```

Commit the submodule addition (e.g. `.gitmodules` and `harbor`).

---

## Step 2: Generate the test harness into this project

From **this project’s root**:

```bash
node harbor/scripts/generate-test-harness.mjs .
```

This creates **`harbor-test/`** with:

- `mock.js` — mock for `window.ai` / `window.agent` (unit tests)
- `playwright.harbor.config.example.ts` — Playwright config for E2E with extensions
- `fixtures/harbor.ts` — Playwright fixture that loads Harbor extensions
- `example.test.mjs` — example unit test (Vitest)
- `e2e/example.spec.ts` — example E2E spec
- `vitest.config.example.ts`, `web-agents-api.d.ts`, `README.md`

Commit **`harbor-test/`** (and the submodule if not already committed).

---

## Step 3: Wire this project’s tests to the harness

### Unit tests (mock)

- **If this project already has tests** that call `window.ai` or `window.agent`: in the test setup (e.g. `beforeEach` or top of file), add:
  - `import { installWebAgentsMock } from './harbor-test/mock.js';` (adjust path to `harbor-test/` from the test file)
  - `const mock = installWebAgentsMock(globalThis);` (or `window` if in a browser env)
  - `mock.permissions.grantAll();` (or `denyAll()` / `grantScopes([...])` as needed)
  - Set any stubs you need, e.g. `mock.ai.textSessionResponse = '…';`, `mock.agent.runOutput = '…';`
  - In teardown: `mock.uninstall();`
- **If this project has no tests yet:** add a test script that runs the example: e.g. `npx vitest run harbor-test/example.test.mjs`. Ensure Vitest is a devDependency; copy or merge `harbor-test/vitest.config.example.ts` into this project’s Vitest config if needed, and include `harbor-test/**/*.test.mjs` (or equivalent).

### E2E tests (Playwright + Harbor extensions)

- Copy `harbor-test/playwright.harbor.config.example.ts` into this project (e.g. `playwright.config.ts` at root or in `e2e/`). Adjust `testDir` if you keep specs elsewhere (e.g. `./e2e` or `./tests/e2e`).
- In **every E2E spec** that should run with Harbor extensions loaded, import the fixture from the harness instead of `@playwright/test`:
  - `import { test, expect } from '../harbor-test/fixtures/harbor.js';` (adjust path from the spec file to `harbor-test/`).
- Add npm scripts, e.g.:
  - `"test:e2e": "playwright test"`
  - `"test:e2e:headed": "playwright test --headed"`
- Document that for E2E with real extensions, set env and optionally build Harbor:
  - `export HARBOR_EXTENSION_PATH=$(pwd)/harbor/extension/dist-chrome`
  - `export WEB_AGENTS_EXTENSION_PATH=$(pwd)/harbor/web-agents-api/dist-chrome`
  - Optionally: `cd harbor && npm run build && cd ..` (or `npm run build:chrome`).

### TypeScript

- If this project uses TypeScript, add the harness types so `window.ai` and `window.agent` are typed. In `tsconfig.json`: `"types": ["./harbor-test/web-agents-api.d.ts"]` (or a path that resolves to that file). Alternatively add `/// <reference path="./harbor-test/web-agents-api.d.ts" />` in a `.d.ts` file.

---

## Step 4: Update this project’s documentation

- **README (or main dev doc):** Add a short “Testing” section that says:
  - Unit tests use the Harbor test harness (mock) in `harbor-test/`. Run with the project’s test command (e.g. `npm test` or `npx vitest run`).
  - E2E tests use Playwright; run `npm run test:e2e` (or equivalent). To run E2E with real Harbor extensions, init the submodule (`git submodule update --init --recursive`), build Harbor in `harbor/`, and set `HARBOR_EXTENSION_PATH` and `WEB_AGENTS_EXTENSION_PATH` to `harbor/extension/dist-chrome` and `harbor/web-agents-api/dist-chrome`.
  - Harbor is included as a submodule; the harness was generated with `node harbor/scripts/generate-test-harness.mjs .`. To refresh it, run that command again after updating the submodule.
- **Contributing / setup doc (if any):** Mention that new clones (and CI) must run `git submodule update --init --recursive` so the `harbor` and `harbor-test/` contents are present.
- **.gitignore:** Do **not** ignore `harbor-test/` if you committed it (so others get the harness without running the generator).

---

## Step 5: Verify

- Run unit tests: e.g. `npm test` or `npx vitest run harbor-test/example.test.mjs`. They should pass.
- Run E2E (optional): `npx playwright test`. Without the env vars, the fixture still runs but extensions won’t be loaded; with env vars and Harbor built, `window.ai` / `window.agent` should be present in the browser.

---

## Reference

- Full guide (in Harbor repo): [docs/TESTING_YOUR_APP.md](https://github.com/r/harbor/blob/main/docs/TESTING_YOUR_APP.md) — “Using Harbor as a submodule” and the rest of the testing doc.
- Harness template source: Harbor’s `spec/testing/harness-template/`.
- Generator: `node harbor/scripts/generate-test-harness.mjs .` (from this project’s root).
