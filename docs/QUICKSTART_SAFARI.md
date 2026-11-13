# Safari Setup Guide (Experimental)

Safari support is experimental and requires macOS and Xcode. Firefox is the primary target.

Start with **[the canonical Quickstart](../QUICKSTART.md#build-everything)**: clone, build both extensions with `npm run build:safari`, and build the native bridge. Apple Intelligence can supply the default model on a supported Mac. Safari bundles the bridge in its macOS app, so skip the Firefox native messaging installer.

## Step 4: Open the Xcode Project

The Safari app project is located at `installer/safari/Harbor/`:

```bash
cd installer/safari/Harbor
open Harbor.xcodeproj
```

---

In the Harbor app target, add a **Run Script** build phase after **Copy Bundle Resources** to embed the current native bridge and its Apple Intelligence companion. The Xcode project is maintained outside this checkout. Use this script in the project that builds your app:

```sh
"$SRCROOT/../embed-bridge.sh"
```

## Step 5: Build and Run

In Xcode:

1. Select the **"Harbor"** scheme (top left dropdown)
2. Select **"My Mac"** as the run destination
3. Click the **Play button** (⌘R) to build and run

This will:
- Build the macOS app
- Launch `Harbor.app`
- Register the extensions with Safari

---

## Step 6: Enable the Extensions in Safari

1. Open **Safari**
2. Go to **Safari → Settings** (⌘,)
3. Click the **Extensions** tab
4. Enable **Harbor**
5. Enable **Web Agents API**

### For Unsigned/Development Builds

If you're running a development build (not signed with an Apple Developer certificate):

1. Go to **Safari → Develop** menu
   - If you don't see the Develop menu: Safari → Settings → Advanced → "Show Develop menu in menu bar"
2. Click **"Allow Unsigned Extensions"**
3. You'll need to do this each time Safari restarts

---

## Return to the Quickstart

Continue with **[Verify Your Setup](../QUICKSTART.md#verify-your-setup)** to check the default model, prepare Agentic Tool Use and run the demos. All common setup and troubleshooting live there.
