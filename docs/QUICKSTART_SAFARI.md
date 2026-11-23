# Safari Setup Guide (Experimental)

Harbor's Safari build shows that the Web Agent API runs on WebKit, alongside Firefox (Gecko) and Chrome (Blink). It's for loading locally on your own Mac. It isn't distributed through the App Store, and it isn't signed with a developer account. Firefox is the primary target.

You need macOS, Xcode and Safari. Start with **[the canonical Quickstart](../QUICKSTART.md#build-everything)** to clone the repo, install the extension's dependencies and build the native bridge. Skip the Firefox native messaging installer: Safari reaches the bridge over HTTP instead.

## Step 4: Build the Safari App

Safari loads web extensions only from inside a macOS app. From the repository root, run:

```bash
installer/safari/build.sh
```

The script:

1. builds the extension with `npm run build:safari`;
2. wraps `extension/dist-safari/` in an Xcode project with Apple's `safari-web-extension-converter`;
3. builds the app with ad-hoc signing, so no Apple developer account is needed.

Everything it generates goes in `installer/safari/build/`, which git ignores. The app ends up at `installer/safari/build/DerivedData/Build/Products/Debug/Harbor.app`. Rerun the script after any extension change.

## Step 5: Load the Extension in Safari

1. **Allow unsigned extensions.** Turn on **Safari → Settings → Advanced → Show features for web developers**. Then turn on **Safari → Develop → Developer Settings… → Allow Unsigned Extensions**. Safari turns this off again when it quits, so repeat it after each restart.
2. **Open the app once.** Run `installer/safari/build.sh --open`, or open `Harbor.app` from the path above. Opening it registers the extension with Safari. You can quit the app afterward.
3. **Enable the extension.** In **Safari → Settings → Extensions**, turn on **Harbor**. Allow it on all websites (or on the sites you'll test), so it can add the page API to them.

## Step 6: Run the Bridge in HTTP Mode

Safari can't use native messaging, so the extension talks to the bridge at `http://127.0.0.1:8766`. Nothing starts the bridge for you. Run it in a terminal and leave it running:

```bash
bridge-rs/target/release/harbor-bridge --http-server
```

The sidebar shows the bridge as connected within a few seconds.

## What Works and What Doesn't

Safari gets the same extension as Firefox and Chrome, including the page API (`window.ai`, `window.agent`, `document.modelContext`) and Harbor's permission prompts. These parts differ:

- **No streaming.** The HTTP bridge returns a whole response at once, so streamed calls arrive as a single chunk.
- **No DNS check.** A public host name that points at a local address isn't caught, as in Chrome.
- **Bridge not bundled.** The app doesn't start or embed the bridge; you run it yourself (step 6).

## Return to the Quickstart

Continue with **[Verify Your Setup](../QUICKSTART.md#verify-your-setup)** to check the default model and run the demos. All common setup and troubleshooting live there.
