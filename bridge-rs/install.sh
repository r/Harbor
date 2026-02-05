#!/bin/bash
# Harbor Bridge Installation Script
# Builds the bridge binary and installs the native messaging manifest

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY_NAME="harbor-bridge"

# Parse arguments
FIREFOX_ONLY=false
SKIP_BUILD=false
for arg in "$@"; do
    case $arg in
        --firefox-only)
            FIREFOX_ONLY=true
            ;;
        --skip-build)
            SKIP_BUILD=true
            ;;
    esac
done

echo "=== Harbor Bridge Installer ==="
echo ""

# Detect OS
OS="$(uname -s)"
case "$OS" in
    Darwin)
        FIREFOX_MANIFEST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"
        CHROME_MANIFEST_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
        ;;
    Linux)
        FIREFOX_MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
        CHROME_MANIFEST_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
        ;;
    *)
        echo "Error: Unsupported OS: $OS"
        exit 1
        ;;
esac

# Build the release binary (unless --skip-build)
BINARY_PATH="$SCRIPT_DIR/target/release/$BINARY_NAME"

if [ "$SKIP_BUILD" = false ]; then
    echo "Building harbor-bridge..."
    cd "$SCRIPT_DIR"
    cargo build --release
    echo "Binary built: $BINARY_PATH"
    echo ""
else
    echo "Skipping build (--skip-build)"
    if [ ! -f "$BINARY_PATH" ]; then
        echo "Error: Binary not found at $BINARY_PATH"
        echo "Run without --skip-build to build the binary first."
        exit 1
    fi
    echo ""
fi

# Create wrapper script that passes --native-messaging flag
WRAPPER_PATH="$SCRIPT_DIR/target/release/harbor-bridge-native"
cat > "$WRAPPER_PATH" << EOF
#!/bin/bash
exec "$BINARY_PATH" --native-messaging "\$@"
EOF
chmod +x "$WRAPPER_PATH"

echo "Created wrapper script: $WRAPPER_PATH"
echo ""

# Function to install manifest for Firefox
install_firefox_manifest() {
    local manifest_dir="$1"
    
    if [ -d "$(dirname "$manifest_dir")" ]; then
        echo "Installing native messaging manifest for Firefox..."
        mkdir -p "$manifest_dir"
        
        # Firefox uses allowed_extensions
        cat > "$manifest_dir/harbor_bridge.json" << EOF
{
  "name": "harbor_bridge",
  "description": "Harbor Bridge - Local LLM and MCP server for Harbor extension",
  "path": "$WRAPPER_PATH",
  "type": "stdio",
  "allowed_extensions": ["harbor@krikorian.co"]
}
EOF
        echo "  Manifest installed: $manifest_dir/harbor_bridge.json"
    else
        echo "Skipping Firefox (not installed)"
    fi
}

# Function to install manifest for Chrome
install_chrome_manifest() {
    local manifest_dir="$1"
    local extension_id="${2:-}"  # Optional: specify extension ID
    
    if [ -d "$(dirname "$manifest_dir")" ]; then
        echo "Installing native messaging manifest for Chrome..."
        mkdir -p "$manifest_dir"
        
        # Chrome uses allowed_origins with chrome-extension:// URLs
        # Use * to allow any extension, or specify the extension ID
        if [ -n "$extension_id" ]; then
            ORIGIN="chrome-extension://${extension_id}/"
        else
            # When extension is loaded unpacked, the ID changes
            # Use a placeholder that can be updated after loading
            ORIGIN="chrome-extension://*/"
        fi
        
        cat > "$manifest_dir/harbor_bridge.json" << EOF
{
  "name": "harbor_bridge",
  "description": "Harbor Bridge - Local LLM and MCP server for Harbor extension",
  "path": "$WRAPPER_PATH",
  "type": "stdio",
  "allowed_origins": ["$ORIGIN"]
}
EOF
        echo "  Manifest installed: $manifest_dir/harbor_bridge.json"
        if [ -z "$extension_id" ]; then
            echo ""
            echo "  NOTE: Chrome requires a specific extension ID in allowed_origins."
            echo "  After loading the extension in Chrome, get its ID from chrome://extensions"
            echo "  and update the manifest file at:"
            echo "    $manifest_dir/harbor_bridge.json"
            echo "  Replace the 'allowed_origins' with:"
            echo '    "allowed_origins": ["chrome-extension://YOUR_EXTENSION_ID/"]'
        fi
    else
        echo "Skipping Chrome (not installed)"
    fi
}

# Install for Firefox
install_firefox_manifest "$FIREFOX_MANIFEST_DIR"

# Install for Chrome (unless --firefox-only)
if [ "$FIREFOX_ONLY" = false ]; then
    install_chrome_manifest "$CHROME_MANIFEST_DIR"
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "The harbor-bridge will now start automatically when you open the Harbor extension."
echo ""
echo "To test manually, run:"
echo "  $BINARY_PATH"
echo ""
echo "Log file location:"
if [ "$OS" = "Darwin" ]; then
    echo "  ~/Library/Caches/harbor-bridge.log"
else
    echo "  ~/.cache/harbor-bridge.log"
fi

# Only show Safari instructions if not --firefox-only
if [ "$FIREFOX_ONLY" = false ]; then
    echo ""
    echo "=== Safari ==="
    echo ""
    echo "Safari requires a different setup - the extension must be bundled in a macOS app."
    echo "To build Harbor for Safari with native messaging support:"
    echo ""
    echo "  cd ../installer/safari"
    echo "  ./build.sh"
    echo ""
    echo "This will create an Xcode project (if needed), build harbor-bridge, and"
    echo "package everything into Harbor.app. See installer/safari/README.md for details."
fi