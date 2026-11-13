# AAF invoice with Harbor

The AAF billing form and embedded widget use the visitor’s Harbor-selected AI. The page asks for `model:prompt`, then supplies only `systemPrompt` to `window.ai.createTextSession()`. Each generation destroys its session in `finally`, so a new request follows the current Harbor configuration.

## Run in Firefox

1. Build Harbor with `npm run build`. Load **both** `extension/dist-firefox/` and `web-agents-api/dist-firefox/` as temporary Firefox add-ons. Build and register the native bridge using the repository Quickstart, and verify **Bridge: Connected** in Harbor.
2. Configure a provider and model in Harbor. From `demo/`, run `npm install` and `npm start`.
3. Open `http://localhost:8000/web-agents/aaf-invoice/`. Ask the embedded assistant “Create an invoice for alice@example.com for 120 EUR” and approve model access for this origin.
4. Check the actual form contains `alice@example.com`, `120`, and `EUR`. The local draft count must stay unchanged while the form awaits review. Press **Save draft** and verify exactly one new draft. Inspect `localStorage['billing-app-invoices']` for the draft’s email, amount, currency, and `status: 'draft'`.
5. Switch to a second configured provider **in Harbor**, keeping the same URL and page configuration. Send the request again. Record the provider/model in Harbor’s own settings and request logs for each run. For the hosted-provider run, stop local Ollama first and confirm the request still succeeds. The page creates a fresh session for every generation.

Drafts use AAF’s sample storage key `billing-app-invoices` and remain local to the demo origin. Reload to repeat with a clean form while keeping existing drafts.

## Unavailable and denied permission

Open the page in Firefox without the Web Agents API add-on, or deny the model permission prompt. Send a request. The assistant shows the unavailable/denied state and leaves the current form and draft count intact. Restore the add-on or allow this origin in Web Agents API and send the request again.

## Pinned upstream source

AAF revision [`12d68a3ed71051e01d1625c8d0cc08039cef838c`](https://github.com/mozilla-ai/aaf/tree/12d68a3ed71051e01d1625c8d0cc08039cef838c) supplies the annotated invoice form, invoice manifest action, `ChatUI`, `WidgetPlanner`, prompt/parser, semantic discovery, manifest validation/coercion, schema enrichment, and local draft store. `aaf.bundle.js` is generated vendor code. The upstream MIT license is in `LICENSE.aaf`. Bundled dependency licenses are in `THIRD_PARTY_LICENSES.txt`.

The adapter mounts `ChatUI` into the page, removes its model selector, and supplies a Harbor text-generation backend. The demo manifest contains the invoice action, marks unknown arguments invalid, and uses the current page route. Model plans fill validated fields and await the form’s manual submit button. The widget’s stock backend detection and direct Ollama fallback are excluded from the bundle. AAF’s CLI and other samples are independent.

To rebuild the checked-in bundle, install dependencies in a local AAF checkout containing the pinned revision, then run from Harbor’s root

```sh
node demo/web-agents/aaf-invoice/rebuild.mjs ~/Code/aaf
```

The rebuild reads the pinned revision through `git archive` and resolves its workspace packages from that archive. Dependencies come from the supplied checkout’s installed `node_modules`. Serve the checked-in files directly through Harbor’s demo server or GitHub Pages.
