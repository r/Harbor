# Chrome Setup Guide

This supplement covers Chrome-specific extension loading and native messaging. Start with **[the canonical Quickstart](../QUICKSTART.md#build-everything)**, using `npm run build:chrome`, then follow this page. Firefox remains the primary target.

## Step 4: Load Both Extensions in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **"Developer mode"** (toggle in the top right)

3. **Load Harbor:**
   - Click **"Load unpacked"**
   - Select the `extension/dist-chrome/` folder

4. **Load Web Agents API:**
   - Click **"Load unpacked"** again
   - Select the `web-agents-api/dist-chrome/` folder

Both extensions should appear in your extensions list.

---

## Step 5: Configure Native Messaging

Chrome's native messaging requires an exact extension origin. Harbor's checked-in manifest key gives it the stable ID `ljnciidcajlichemnbohopnlaonhkpgm`; the installer registers this ID automatically, including for unpacked builds.

### Install the Bridge

The bridge was built in the common quickstart. Install its native messaging manifest:

```bash
cd bridge-rs
./install.sh --skip-build
cd ..
```

### Installed Native Messaging Manifest

The installer writes `harbor_bridge.json` in Chrome's user-level native messaging directory:

- **macOS:** `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
- **Linux:** `~/.config/google-chrome/NativeMessagingHosts/`

The installer supports macOS and Linux. It does not configure Windows or other Chromium browsers.

No manual extension ID edits are needed. The generated manifest has this form (the installer fills in your absolute checkout path):

```json
{
  "name": "harbor_bridge",
  "description": "Harbor Bridge - Local LLM and MCP server for Harbor extension",
  "path": "/absolute/path/to/harbor/bridge-rs/target/release/harbor-bridge-native",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://ljnciidcajlichemnbohopnlaonhkpgm/"]
}
```

The executable wrapper launches `harbor-bridge` with `--native-messaging`. Keep the checkout in place, or rerun the installer from its new location after moving it.

If you deliberately replace or remove `extension/manifest.chrome.json`'s key, the extension ID can differ. Such custom builds need a matching explicit origin in their native host manifest; the installer targets the repository's key.

### Restart Chrome

**Completely quit and restart Chrome** for the native messaging changes to take effect. Just closing tabs is not enough.

---

## Return to the Quickstart

Continue with **[Verify Your Setup](../QUICKSTART.md#verify-your-setup)** to add and test a configured default model, prepare Agentic Tool Use and run the demos. All common setup and troubleshooting live there.
