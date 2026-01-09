# Harbor Installer

Build distributable packages for Harbor.

## macOS (.pkg)

Creates a standard macOS installer package that:

1. **Checks requirements** - Firefox (required) and Docker (recommended)
2. **Installs the native bridge** - Standalone binary with bundled Node.js
3. **Installs the Firefox extension** - Signed XPI opened in Firefox
4. **Sets up native messaging** - So Firefox can communicate with the bridge
5. **Installs uninstaller** - Both GUI app and CLI

### User Dependencies

After installation, users only need:
- **Docker Desktop** - For running MCP servers
- **Firefox** - The browser

No Node.js or other development tools required!

### Quick Start

```bash
cd installer/macos

# First time or after major changes
./build-pkg.sh --clean

# Subsequent builds
./build-pkg.sh
```

**Signing happens automatically** when credentials are configured in `credentials.env`. The build will sign the extension, sign the package, and notarize it if the respective credentials are available.

The output will be at `installer/macos/build/Harbor-<version>.pkg`.

### Credentials Setup (Required)

Before building, you must create `installer/credentials.env`. This file contains your unique extension ID and signing credentials.

**Step 1: Create the file**
```bash
cp installer/credentials.env.example installer/credentials.env
```

**Step 2: Edit `credentials.env`**
```bash
# Firefox Extension ID (REQUIRED)
# This MUST be unique per Mozilla account. Format: name@domain.com
# - Use only: a-z, A-Z, 0-9, -, ., _
# - NO + characters allowed!
# - Example: yourname.harbor@gmail.com
EXTENSION_ID="your.unique.id@example.com"

# Mozilla Add-ons API credentials (REQUIRED for --sign-extension)
# Get these from: https://addons.mozilla.org/developers/addon/api/key/
AMO_JWT_ISSUER="user:12345678:123"
AMO_JWT_SECRET="your-64-character-hex-secret"

# Apple Developer (optional, for pkg signing/notarization)
# DEVELOPER_ID="Developer ID Installer: Your Name (XXXXXXXXXX)"
# APPLE_ID="your@email.com"
# APPLE_TEAM_ID="XXXXXXXXXX"
```

**Step 3: Get Mozilla API credentials**
1. Sign in to https://addons.mozilla.org
2. Go to Tools → Manage API Keys (or visit https://addons.mozilla.org/developers/addon/api/key/)
3. Generate new credentials
4. Copy the JWT issuer and secret to your `credentials.env`

> **Important**: The `EXTENSION_ID` is stamped into both the extension's `manifest.json` and the native messaging manifest. They must match for the extension to connect to the bridge.

### Build Options

By default, all signing and notarization happens **automatically** when credentials are configured. You only need flags to override this behavior.

```bash
# Standard build (auto-signs if credentials available)
./build-pkg.sh

# Clean build (removes all cached artifacts first)
./build-pkg.sh --clean

# Just clean all artifacts (no build)
./build-pkg.sh --clean-only

# Fast development build (current arch only, no signing)
./build-pkg.sh --fast

# Skip all signing even if credentials are available
./build-pkg.sh --no-sign

# Force all signing options (useful if auto-detect fails)
./build-pkg.sh --all

# Use system Node.js instead of bundling (smaller, requires Node installed)
./build-pkg.sh --node

# Show all options
./build-pkg.sh --help
```

**Common combinations:**
```bash
# Development: clean + fast (no signing, current arch only)
./build-pkg.sh --clean --fast

# Development: clean + auto-sign (default behavior)
./build-pkg.sh --clean

# Production: clean + force all signing
./build-pkg.sh --clean --all
```

### How the Build Works

1. **Downloads Node.js v20.19.6** - Specific version for building native modules
2. **Builds native modules** - `better-sqlite3` compiled for that exact Node version
3. **Bundles with esbuild** - All JavaScript into single CommonJS file
4. **Packages with pkg** - Creates standalone binaries with Node.js v20.19.6 bundled
5. **Signs extension** - Uses Mozilla Add-ons API for trusted installation
6. **Creates .pkg** - Standard macOS installer with pre/post-install scripts

**Universal builds** (default): Both arm64 and x64 binaries are included in the package. The `postinstall` script detects the architecture and installs the correct one. This avoids using `lipo` which corrupts `pkg` binaries.

**Fast builds** (`--fast`): Only builds for the current architecture (faster for development).

### Version Numbers

The build uses timestamp-based versions for development:
- Format: `0.YYMMDD.HHMM` (e.g., `0.260104.1501` = Jan 4, 2026 at 15:01)
- This ensures each build has a unique version for Mozilla Add-ons signing
- For releases, set `VERSION=1.0.0` environment variable

### Testing Locally

```bash
# Install the package
sudo installer -pkg build/Harbor-*.pkg -target /

# Check installation
ls -la "/Library/Application Support/Harbor/"

# Check native messaging manifest
cat "/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge_host.json"

# View installation log
cat /tmp/harbor-install.log

# Test the bridge binary directly
"/Library/Application Support/Harbor/harbor-bridge" </dev/null
```

### Uninstalling

**Option 1: GUI Uninstaller**
- Open "Uninstall Harbor" from `/Applications/` or use Spotlight

**Option 2: CLI (from anywhere)**
```bash
harbor-uninstall
```

**Option 3: Direct script**
```bash
# Interactive (prompts for confirmation)
sudo "/Library/Application Support/Harbor/uninstall.sh"

# Non-interactive, keeps user data
sudo "/Library/Application Support/Harbor/uninstall.sh" --force

# Non-interactive, removes everything including user data
sudo "/Library/Application Support/Harbor/uninstall.sh" --force-all
```

**What gets removed:**
- `/Library/Application Support/Harbor/` (bridge, extension, uninstaller)
- `/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge_host.json`
- `/Applications/Uninstall Harbor.app`
- `/usr/local/bin/harbor-uninstall`

**What is preserved by default:**
- `~/.harbor/` (your settings, databases, logs)
- The Firefox extension (must be removed manually)

**After uninstalling:**
1. Open Firefox
2. Go to `about:addons` (or menu → Add-ons and themes)
3. Find "Harbor" and click Remove

To manually remove user data:
```bash
rm -rf ~/.harbor
```

### Reinstalling During Development

```bash
# Recommended: Clean build + uninstall + fresh install
./build-pkg.sh --clean --sign-extension
harbor-uninstall  # or: sudo "/Library/Application Support/Harbor/uninstall.sh" --force
sudo installer -pkg build/Harbor-*.pkg -target /

# Alternative: Just clear package receipts (skips uninstall)
sudo pkgutil --forget com.harbor.bridge

# Remove user-level native messaging manifest (if exists from dev setup)
rm -f ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/harbor_bridge_host.json

# Then install
sudo installer -pkg build/Harbor-*.pkg -target /
```

**Quick iteration during development:**
```bash
# Fast rebuild (current arch, no signing)
./build-pkg.sh --fast
harbor-uninstall
sudo installer -pkg build/Harbor-*.pkg -target /
```

### What Gets Installed

| Path | Description |
|------|-------------|
| `/Library/Application Support/Harbor/harbor-bridge` | Native bridge binary (standalone, includes Node.js) |
| `/Library/Application Support/Harbor/harbor.xpi` | Firefox extension (signed) |
| `/Library/Application Support/Harbor/uninstall.sh` | CLI uninstaller |
| `/Library/Application Support/Harbor/Uninstall Harbor.app` | GUI uninstaller |
| `/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge_host.json` | Native messaging manifest |
| `/Applications/Uninstall Harbor.app` | Uninstaller app (copied from Harbor dir) |
| `/usr/local/bin/harbor-uninstall` | CLI uninstaller symlink |
| `~/.harbor/` | User data directory (databases, logs, etc.) |

### Requirements for Building

- macOS 12+
- Node.js 18+ (for running build script; the build downloads its own Node for bundling)
- Xcode Command Line Tools (`xcode-select --install`)

For extension signing:
- Mozilla Add-ons API credentials (free)

For pkg signing/notarization:
- Apple Developer ID ($99/year)
- Keychain access configured for notarization

### Troubleshooting

**Extension shows "not verified"**
- Make sure you're using `--sign-extension` flag
- Check that `credentials.env` has valid AMO credentials
- Each version can only be signed once - the build uses timestamps to avoid conflicts

**Bridge won't connect**
- Check `~/.harbor/bridge.log` for errors
- Verify native messaging manifest exists and has correct extension ID:
  ```bash
  cat "/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge_host.json"
  ```
- The `allowed_extensions` array must contain your `EXTENSION_ID` from `credentials.env`
- Make sure Firefox was restarted after installation
- Remove any user-level manifest that might override:
  ```bash
  rm -f ~/Library/Application\ Support/Mozilla/NativeMessagingHosts/harbor_bridge_host.json
  ```

**Permission errors with ~/.harbor**
- The installer should set correct permissions, but if not:
  ```bash
  sudo chown -R $USER:staff ~/.harbor/
  ```

**Build fails or produces corrupted binary**
- Do a clean build: `./build-pkg.sh --clean --sign-extension`
- The `--clean` flag removes all cached artifacts including `node_modules`

**pkg build fails with native module errors**
- The build downloads a specific Node.js version (20.19.6) to ensure ABI compatibility
- Clean everything and rebuild: `./build-pkg.sh --clean --sign-extension`

**Extension ID conflicts**
- If you get "Forbidden" errors when signing, your `EXTENSION_ID` may be registered to another account
- Choose a different unique ID (e.g., `yourname.harbor@yourdomain.com`)
- Remember: No `+` characters allowed in the extension ID!

## Windows (.msi)

Coming soon.

## Linux (.deb, .rpm)

Coming soon.

## Architecture

```
User downloads .pkg
         │
         ▼
    ┌─────────────┐
    │ Pre-install │  Check Firefox installed
    └─────────────┘  Check Docker available
         │           Warn about architecture
         ▼
    ┌─────────────┐
    │   Payload   │  Copy harbor-bridge binary
    └─────────────┘  Copy harbor.xpi extension
         │           Copy uninstaller
         ▼
    ┌─────────────┐
    │ Post-install│  Create native messaging manifest
    └─────────────┘  Set up launcher script
         │           Open XPI in Firefox (triggers install prompt)
         ▼           Install uninstaller app
    User clicks "Add" in Firefox
         │
         ▼
    Extension connects to bridge via native messaging
         │
         ▼
    ✓ Ready to use!
```

## File Structure

```
installer/
├── credentials.env          # Your signing credentials (gitignored)
├── README.md               # This file
└── macos/
    ├── build-pkg.sh        # Main build script
    ├── distribution.xml    # Package distribution settings
    ├── resources/
    │   ├── welcome.html    # Installer welcome screen
    │   ├── license.html    # License agreement
    │   ├── conclusion.html # Post-install instructions
    │   └── uninstall-app.applescript
    ├── scripts/
    │   ├── preinstall      # Pre-installation checks
    │   ├── postinstall     # Post-installation setup
    │   └── uninstall.sh    # Uninstaller script
    └── build/              # Build output (gitignored)
        ├── Harbor-*.pkg    # Final installer
        ├── harbor-bridge   # Standalone binary
        └── harbor.xpi      # Signed extension
```
