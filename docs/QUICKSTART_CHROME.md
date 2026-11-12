# Chrome Setup Guide

This supplement covers Chrome-specific extension loading and native messaging. Start with **[the canonical Quickstart](../QUICKSTART.md#build-everything)**, using `npm run build:chrome`, then follow this page. Firefox remains the primary target.

## Step 4: Load Both Extensions in Chrome

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **"Developer mode"** (toggle in the top right)

3. **Load Harbor:**
   - Click **"Load unpacked"**
   - Select the `extension/dist-chrome/` folder
   - **⚠️ Copy the extension ID** — you'll need it in Step 5

4. **Load Web Agents API:**
   - Click **"Load unpacked"** again
   - Select the `web-agents-api/dist-chrome/` folder

Both extensions should appear in your extensions list.

### Finding Your Extension ID

The extension ID is a 32-character string that looks like:
```
abcdefghijklmnopabcdefghijklmnop
```

You can find it:
- Displayed under the extension name in `chrome://extensions`
- In the URL when you click "Details" on the extension

**Write down the Harbor extension ID** — you need it for native messaging.

---

## Step 5: Configure Native Messaging

This is the critical step that differs from Firefox. Chrome's native messaging requires the exact extension ID.

### Install the Bridge

The bridge was built in the common quickstart. Install its native messaging manifest:

```bash
cd bridge-rs
./install.sh --skip-build
cd ..
```

### Update the Native Messaging Manifest

**macOS:**
```bash
nano ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/harbor_bridge_host.json
```

**Linux:**
```bash
nano ~/.config/google-chrome/NativeMessagingHosts/harbor_bridge_host.json
```

**Windows:**
The manifest is at `%LOCALAPPDATA%\Google\Chrome\User Data\NativeMessagingHosts\harbor_bridge_host.json`

### Edit the Manifest

Find the `allowed_origins` line and replace `YOUR_EXTENSION_ID_HERE` with your actual Harbor extension ID:

```json
{
  "name": "harbor_bridge_host",
  "description": "Harbor Bridge - Local LLM and MCP server for Harbor extension",
  "path": "/Users/you/.harbor/bin/harbor-bridge",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID_HERE/"]
}
```

**Example:** If your extension ID is `abcdefghijklmnopabcdefghijklmnop`:

```json
"allowed_origins": ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"]
```

### Restart Chrome

**Completely quit and restart Chrome** for the native messaging changes to take effect. Just closing tabs is not enough.

---

## Return to the Quickstart

Continue with **[Verify Your Setup](../QUICKSTART.md#verify-your-setup)** to add and test a configured default model, prepare Agentic Tool Use and run the demos. All common setup and troubleshooting live there.
