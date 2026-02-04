# Safari Setup Guide (Experimental)

> ⚠️ **Safari support is experimental.** The code is checked into the repository and can be built, but it is not the primary supported platform. Expect rough edges.
>
> For the best experience, we recommend **[Firefox](QUICKSTART_FIREFOX.md)** as the primary browser.

---

## How Safari Is Different

Unlike Firefox and Chrome, Safari extensions must be distributed as part of a native macOS app. This means:

| Aspect | Firefox/Chrome | Safari |
|--------|----------------|--------|
| **Extension format** | Folder of files | Embedded in .app bundle |
| **Native bridge** | Separate install | Bundled in app |
| **Build tool** | npm + cargo | Xcode |
| **Distribution** | Load unpacked | Build and run app |

The Harbor Safari implementation is an Xcode project that:
1. Builds both extensions (Harbor + Web Agents API)
2. Bundles the native bridge inside the app
3. Produces a macOS app that registers the extensions with Safari

---

## Prerequisites

| Tool | Install |
|------|---------|
| **Xcode 14+** | Mac App Store or [developer.apple.com](https://developer.apple.com/xcode/) |
| **Node.js 18+** | [nodejs.org](https://nodejs.org) |
| **Ollama** | [ollama.com](https://ollama.com) or `brew install ollama` |
| **macOS 13+** | Required for Safari 16+ |

---

## Step 1: Clone and Build Extensions

First, build the extension bundles that Xcode will include:

```bash
git clone --recurse-submodules https://github.com/r/Harbor.git
cd harbor

# Build Harbor extension for Safari
cd extension
npm install
npm run build:safari
cd ..

# Build Web Agents API extension for Safari
cd web-agents-api
npm install
npm run build:safari
cd ..
```

---

## Step 2: Build the Native Bridge

```bash
cd bridge-rs
cargo build --release
cd ..
```

The Xcode project will copy this binary into the app bundle.

---

## Step 3: Start Ollama

```bash
ollama serve &
ollama pull llama3.2
```

---

## Step 4: Open the Xcode Project

The Safari app project is located at `installer/safari/Harbor/`:

```bash
cd installer/safari/Harbor
open Harbor.xcodeproj
```

---

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

## Step 7: Verify Installation

1. **Check the Harbor sidebar:**
   - Click the Harbor icon in Safari's toolbar
   - Or: View → Show Sidebar → Harbor

2. **Verify the bridge:**
   - The sidebar should show "Bridge: Connected"
   - Safari bundles the bridge inside the app, so if the app is running, the bridge should work

3. **Verify Ollama:**
   - The sidebar should show "LLM: Ollama"

---

## Step 8: Run the Demos

```bash
cd demo
npm install
npm start
```

Open http://localhost:8000 in Safari.

---

## Project Structure

```
installer/safari/Harbor/
├── Harbor/                    # Main macOS app target
│   ├── Harbor/               # App source
│   │   └── harbor-bridge     # Native bridge (copied during build)
│   └── Harbor Extension/     # Safari extension target (Harbor)
│       └── Resources/        # Built extension files
├── Web Agents Extension/     # Safari extension target (Web Agents API)
│   └── Resources/            # Built extension files
└── Harbor.xcodeproj          # Xcode project
```

---

## Troubleshooting

### Extensions don't appear in Safari Settings

1. Make sure `Harbor.app` is running (check the Dock)
2. Try quitting and reopening Safari
3. Check Console.app for extension loading errors

### "Allow Unsigned Extensions" keeps resetting

This is Safari's security feature. For development builds, you need to enable it each time Safari launches. To avoid this:
- Sign the app with an Apple Developer certificate
- Or keep Safari open during development sessions

### Bridge Disconnected

Unlike Firefox/Chrome, Safari's bridge is bundled in the app. If it's disconnected:

1. Verify `Harbor.app` is running
2. Check that the bridge binary was copied:
   ```bash
   ls installer/safari/Harbor/Harbor/Harbor/harbor-bridge
   ```
3. Rebuild the Xcode project

### Build Errors in Xcode

1. Make sure you built the extensions first (`npm run build:safari`)
2. Clean the Xcode build: Product → Clean Build Folder (⇧⌘K)
3. Check that the extension resources exist in the expected locations

### "window.ai is undefined"

1. Are both extensions enabled in Safari → Settings → Extensions?
2. Refresh the page
3. Check Safari's Web Inspector for errors (Develop → Show Web Inspector)

---

## Limitations

Safari support has some known limitations compared to Firefox/Chrome:

| Feature | Status |
|---------|--------|
| Basic text generation | ✅ Works |
| Tool calling | ✅ Works |
| MCP servers | ⚠️ Partially tested |
| Browser automation | ⚠️ Limited testing |
| Multi-agent | ❌ Not tested |

---

## Development Workflow

For Safari development:

1. **Edit extension code** in `extension/` or `web-agents-api/`
2. **Rebuild** with `npm run build:safari`
3. **Rebuild in Xcode** (⌘B)
4. **Reload extensions** — quit and reopen Safari, or use Extension Builder

Unlike Firefox/Chrome, there's no hot reload for Safari extensions.

---

## Next Steps

| What You Want | Where to Go |
|---------------|-------------|
| Try a simpler setup | [Firefox Setup](QUICKSTART_FIREFOX.md) (recommended) |
| Build apps with the API | [QUICKSTART.md](../QUICKSTART.md#build-your-first-app) |
| Full API reference | [WEB_AGENTS_API.md](WEB_AGENTS_API.md) |
| Understand the architecture | [ARCHITECTURE.md](../ARCHITECTURE.md) |
