# Harbor test harness (generated)

This folder was generated from the [Harbor](https://github.com/r/harbor) repo so you can test your app that uses the Web Agent API (`window.ai` and `window.agent`).

## Unit / integration tests (mock)

Use the mock when you want to test your logic **without** a real browser or extensions.

**Quick run:** From your project root (with `harbor-test/` present), install Vitest and run the example test:
```bash
npm i -D vitest
cp harbor-test/vitest.config.example.ts vitest.config.ts   # or merge into your config
npx vitest run harbor-test/example.test.mjs harbor-test/example.multi-agent.test.mjs
```

1. In your test setup (e.g. Vitest, Jest, Node), install the mock on `globalThis` or `window`:

```js
import { installWebAgentsMock } from './harbor-test/mock.js';

const mock = installWebAgentsMock(globalThis);
mock.permissions.grantAll();           // the user allows whatever requestPermissions() asks for
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

Like Harbor, `requestPermissions()` grants exactly the scopes it names. `grantAll()` doesn't grant anything up front; it means the user says yes when the page asks. `grantScopes([...])` stands for scopes the site already holds.

Set `mock.ai.textSessionStreamTokens` to the text chunks your app should receive. A `for await` loop over `session.promptStreaming()` yields each nonempty string and ends after the last chunk. Setting `mock.ai.nextError` makes the loop throw an error with the configured `code` and `message`.

See `mock.js` for the full control API (e.g. `mock.agent.toolsList`, `mock.agent.toolCallResult`).

### Multi-agent (`agent.agents`)

The mock supports `agent.agents.register`, `unregister`, `getInfo`, `discover`, `list`, `invoke`, `send`, `onMessage` and `onInvoke`, with Harbor's shapes. `example.multi-agent.test.mjs` walks through a full flow.

```js
mock.permissions.grantAll();
mock.agents.featureEnabled = true;     // Harbor's multiAgent feature is off by default
const summarizer = mock.agents.addAgent(
  { name: 'Summarizer', capabilities: ['summarize'] },
  { onInvoke: async ({ task, input }) => ({ summary: '...' }), onMessage: (m) => {} },
);

await agent.requestPermissions({ scopes: ['agents:register', 'agents:discover', 'agents:invoke'] });
await agent.agents.register({ name: 'Writer' });
const { agents } = await agent.agents.discover({ capabilities: ['summarize'] });
const response = await agent.agents.invoke(agents[0].id, { task: 'summarize', input: { text } });
```

- `mock.agents.addAgent(options, { onInvoke, onMessage })` adds an agent as if another tab on your site registered it.
- `mock.agents.invokePage(fromId, request)` and `mock.agents.sendToPage(fromId, payload)` test your page's own `onInvoke` and `onMessage` handlers.
- `mock.agents.featureEnabled` is `false` by default, like Harbor's `multiAgent` feature, so `agent.agents` calls fail with `ERR_FEATURE_DISABLED` until you set it to `true`. Real users have to turn the feature on in Harbor too.

Each call needs its scope: `agents:register` for `register` and `unregister`, `agents:discover` for `discover`, `agents:invoke` for `invoke`, and `agents:message` for `send`. Calling `invoke` or `send` before `register` fails with `ERR_NOT_REGISTERED`, as in Harbor.

Two differences from Harbor:

- If the page calls without the scope, Harbor shows a permission prompt. The mock can't prompt, so the call fails with `ERR_SCOPE_REQUIRED`. That way a test shows whether your page requests the scope before it uses it.
- The mock leaves out `subscribe`, `unsubscribe`, `broadcast`, `orchestrate.*`, and cross-origin and remote agents.

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
