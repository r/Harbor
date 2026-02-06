# Testing Your Harbor / Web Agents API App

This guide is for **developers building on the Web Agents API** (`window.ai` and `window.agent`). It describes how to test your app with minimal setup: unit tests with a mock, and E2E tests with real Harbor extensions.

---

## Quick start: generate the test harness

From the **Harbor repo** (clone it if you don’t have it):

```bash
node scripts/generate-test-harness.mjs /path/to/your/project
```

This creates `your-project/harbor-test/` with:

- **mock.js** – drop-in mock for `window.ai` and `window.agent` (unit tests, no browser)
- **Playwright** – example config and fixture that load Harbor + Web Agents API in Chromium
- **Example tests** – one unit test (Vitest) and one E2E spec (Playwright)
- **Types** – `web-agents-api.d.ts` for TypeScript

Then in your project:

```bash
cd /path/to/your/project

# Unit tests (mock)
npm i -D vitest
cp harbor-test/vitest.config.example.ts vitest.config.ts
npx vitest run harbor-test/example.test.mjs

# E2E tests (optional; needs Harbor built and env vars set)
npm i -D @playwright/test
npx playwright install chromium
cp harbor-test/playwright.harbor.config.example.ts playwright.config.ts
export HARBOR_EXTENSION_PATH=/path/to/harbor/extension/dist-chrome
export WEB_AGENTS_EXTENSION_PATH=/path/to/harbor/web-agents-api/dist-chrome
npx playwright test
```

---

## Unit / integration tests (mock)

Use the mock so your code that calls `window.ai` / `window.agent` runs in Node or jsdom without a browser or extensions.

### Setup

1. Ensure the harness is in your project (e.g. `harbor-test/` from the generator).
2. In your test file, install the mock on the global that your code uses (`globalThis` in Node, `window` in jsdom):

```js
import { installWebAgentsMock } from './harbor-test/mock.js';

const mock = installWebAgentsMock(globalThis);
mock.permissions.grantAll();
mock.ai.textSessionResponse = 'Your stubbed reply';
mock.agent.runOutput = 'Agent output';
// run your tests or app code…
mock.uninstall();
```

### Controlling the mock

| What you want | What to do |
|---------------|------------|
| Permissions granted | `mock.permissions.grantAll()` |
| Permissions denied | `mock.permissions.denyAll()` |
| Grant specific scopes | `mock.permissions.grantScopes(['model:prompt', 'mcp:tools.list'])` |
| `session.prompt()` return value | `mock.ai.textSessionResponse = '…'` |
| `session.promptStreaming()` tokens | `mock.ai.textSessionStreamTokens = ['a', 'b', 'c']` |
| Next session error | `mock.ai.nextError = { code: 'ERR_MODEL_FAILED', message: '…' }` |
| `agent.tools.list()` | `mock.agent.toolsList = [{ name: '…', description: '…', … }]` |
| `agent.tools.call()` result | `mock.agent.toolCallResult = { … }` |
| `agent.tools.call()` error | `mock.agent.toolCallError = { code: 'ERR_TOOL_NOT_FOUND', message: '…' }` |
| `agent.run()` final output | `mock.agent.runOutput = '…'` |
| `agent.run()` error | `mock.agent.runError = { code: '…', message: '…' }` |

Error `code` values should match the real API (e.g. `ERR_PERMISSION_DENIED`, `ERR_SCOPE_REQUIRED`, `ERR_MODEL_FAILED`, `ERR_TOOL_NOT_FOUND`, `ERR_TOOL_FAILED`).

### Example (Vitest)

See `harbor-test/example.test.mjs` in the generated harness. Run it with:

```bash
npx vitest run harbor-test/example.test.mjs
```

---

## E2E tests (Playwright + Harbor extensions)

To run E2E tests in a browser where the Harbor and Web Agents API extensions are loaded (so `window.ai` and `window.agent` are real):

### Prerequisites

- **Harbor built** (or use a pre-built artifact):
  - Harbor extension: `extension/dist-chrome` (or `dist-firefox`)
  - Web Agents API extension: `web-agents-api/dist-chrome` (or `dist-firefox`)
- **Playwright** and **Chromium** (extensions are loaded in Chromium via the fixture).

### Setup

1. Copy the example Playwright config from the harness into your project root (or your E2E folder):
   ```bash
   cp harbor-test/playwright.harbor.config.example.ts playwright.config.ts
   ```
2. Set extension paths (e.g. in your shell or `.env`):
   ```bash
   export HARBOR_EXTENSION_PATH=/path/to/harbor/extension/dist-chrome
   export WEB_AGENTS_EXTENSION_PATH=/path/to/harbor/web-agents-api/dist-chrome
   ```
3. In your E2E specs, **import from the harbor fixture** so the browser is launched with extensions:
   ```ts
   import { test, expect } from '../harbor-test/fixtures/harbor.js';
   ```
   (Adjust the path if your spec lives elsewhere; the fixture provides the same `page` / `context` but with extensions loaded.)

4. The example config uses `testDir: './harbor-test/e2e'`. You can change that to your own E2E directory and keep the same fixture import.

### Running E2E

```bash
npx playwright test
```

If the env vars are not set, the fixture still launches Chromium but without extensions; tests that assert on `window.ai` / `window.agent` will see them as undefined.

### Example spec

See `harbor-test/e2e/example.spec.ts` for a minimal spec that checks the page and (when extensions are loaded) the presence of the API.

---

## CI

- **Unit tests:** Run your test runner (e.g. `npx vitest run`) as usual; no browser or Harbor build needed.
- **E2E tests:** In CI, build Harbor (or download artifacts), set `HARBOR_EXTENSION_PATH` and `WEB_AGENTS_EXTENSION_PATH`, then run `npx playwright test`. The fixture uses `headless: true` when `CI` is set.

---

## TypeScript

Reference the generated types so `window.ai` and `window.agent` are typed:

In `tsconfig.json`:

```json
{
  "compilerOptions": {
    "types": ["./harbor-test/web-agents-api.d.ts"]
  }
}
```

Or in a `.d.ts` file: `/// <reference path="./harbor-test/web-agents-api.d.ts" />`.

---

## Where the harness comes from

- **Generator:** `node scripts/generate-test-harness.mjs <target-dir>` (from the Harbor repo).
- **Template:** Harbor’s `spec/testing/harness-template/`.
- **Plan:** [THIRD_PARTY_TESTING_PLAN.md](./THIRD_PARTY_TESTING_PLAN.md).

If you use **Cursor** and add Harbor as a reference, you can ask the AI to set up testing for your Web Agents API app; the rule in Harbor tells it to use this harness (generator or template).
