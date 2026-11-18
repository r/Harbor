# Harbor test harness (generated)

This folder was generated from the [Harbor](https://github.com/r/harbor) repo so you can test your app that uses the Web Agent API (`window.ai` and `window.agent`).

## Unit / integration tests (mock)

Use the mock when you want to test your logic **without** a real browser or extensions.

**Quick run:** From your project root (with `harbor-test/` present), install Vitest and run the example test:
```bash
npm i -D vitest
cp harbor-test/vitest.config.example.ts vitest.config.ts   # or merge into your config
npx vitest run harbor-test/example.test.mjs
```

1. In your test setup (e.g. Vitest, Jest, Node), install the mock on `globalThis` or `window`:

```js
import { installWebAgentsMock } from './harbor-test/mock.js';

const mock = installWebAgentsMock(globalThis);
mock.permissions.grantAll();           // requestPermissions() will resolve with granted: true
mock.ai.textSessionResponse = 'Hi!';   // session.prompt() will return this
mock.agent.runOutput = 'Task done.';   // agent.run() will emit final with this
```

2. Run your app code (or tests) as usual; it will see `window.ai` and `window.agent` with the behavior you configured.

3. To deny permissions or simulate errors:

```js
mock.permissions.denyAll();
// or
mock.permissions.grantScopes(['model:prompt']);
mock.ai.nextError = { code: 'ERR_MODEL_FAILED', message: 'Model unavailable' };
```

See `mock.js` for the full control API (e.g. `mock.agent.toolsList`, `mock.agent.toolCallResult`).

## E2E tests (Playwright + Harbor extension)

To run E2E tests against a **real** browser with the Harbor extension loaded:

1. **Build Harbor** (or use a pre-built artifact). You need:
   - Harbor extension: e.g. `path/to/harbor/extension/dist-firefox` or `dist-chrome`

2. **Install Playwright** in your project if needed:
   ```bash
   npm i -D @playwright/test
   npx playwright install chromium
   ```

3. **Copy and customize** the example config:
   - Copy `playwright.harbor.config.example.ts` to your project (e.g. `playwright.config.ts` or `e2e/playwright.config.ts`).
   - Set `HARBOR_EXTENSION_PATH` (env or in config) to the extension directory above.

4. **In your E2E specs**, import `test` and `expect` from the harbor fixture so the browser launches with the extension:
   ```ts
   import { test, expect } from '../harbor-test/fixtures/harbor.js';
   ```
   (Adjust the path if your spec lives elsewhere.)

5. **Run your E2E tests:**
   ```bash
   npx playwright test
   ```

The included `e2e/example.spec.ts` shows a minimal spec. The config’s `testDir` points at `harbor-test/e2e`; change it if you put specs elsewhere.

## TypeScript

If you use TypeScript, add a reference to the generated types so `window.ai` and `window.agent` are typed:

In your `tsconfig.json` or at the top of a file:

```json
{
  "compilerOptions": {
    "types": ["./harbor-test/web-agents-api.d.ts"]
  }
}
```

Or in a `.d.ts` file: `/// <reference path="./harbor-test/web-agents-api.d.ts" />`.

## Where this came from

Generated from Harbor’s `spec/testing/harness-template/`. To regenerate or see the source, clone [Harbor](https://github.com/r/harbor) and run:

```bash
node scripts/generate-test-harness.mjs /path/to/this/project
```
