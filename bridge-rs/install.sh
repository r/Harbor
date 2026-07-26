#!/bin/bash
# Harbor Native Components Installation Script
# Builds the bridge and agent gateway, then installs the browser manifest

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINARY_NAME="harbor-bridge"
GATEWAY_BINARY_NAME="harbor-agent-gateway"
INSTALL_DIRECTORY="$HOME/.harbor/bin"

FIREFOX_ONLY=false
SKIP_BUILD=false
CHROME_EXTENSION_ID=""

show_usage() {
    echo "Usage: ./install.sh [--firefox-only] [--skip-build] [--chrome-extension-id ID]"
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --firefox-only)
            FIREFOX_ONLY=true
            shift
            ;;
        --skip-build)
            SKIP_BUILD=true
            shift
            ;;
        --chrome-extension-id)
            if [ "$#" -lt 2 ] || [ -z "$2" ]; then
                echo "Error: --chrome-extension-id requires a value." >&2
                show_usage >&2
                exit 1
            fi
            CHROME_EXTENSION_ID="$2"
            shift 2
            ;;
        --help|-h)
            show_usage
            exit 0
            ;;
        *)
            echo "Error: Unknown argument: $1" >&2
            show_usage >&2
            exit 1
            ;;
    esac
done

if [ -n "$CHROME_EXTENSION_ID" ] && [[ ! "$CHROME_EXTENSION_ID" =~ ^[a-p]{32}$ ]]; then
    echo "Error: Chrome extension IDs must contain 32 characters from a through p." >&2
    exit 1
fi

echo "=== Harbor Native Components Installer ==="
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

BUILD_BINARY_PATH="$SCRIPT_DIR/target/release/$BINARY_NAME"
BUILD_GATEWAY_BINARY_PATH="$SCRIPT_DIR/target/release/$GATEWAY_BINARY_NAME"
INSTALLED_BINARY_PATH="$INSTALL_DIRECTORY/$BINARY_NAME"
INSTALLED_GATEWAY_BINARY_PATH="$INSTALL_DIRECTORY/$GATEWAY_BINARY_NAME"
WRAPPER_PATH="$INSTALL_DIRECTORY/harbor-bridge-native"

if [ "$SKIP_BUILD" = false ]; then
    if ! command -v cargo &> /dev/null; then
        echo "Warning: 'cargo' is not installed or not in your PATH." >&2
        echo "Looking in $HOME/.cargo..." >&2
        if [ -f "$HOME/.cargo/.env" ]; then
            source "$HOME/.cargo/.env"
        elif [ -x "$HOME/.cargo/bin/cargo" ]; then
            export PATH="$HOME/.cargo/bin:$PATH"
        fi
    fi

    if ! command -v cargo &> /dev/null; then
        echo "Error: cargo is required to build Harbor native components." >&2
        exit 1
    fi

    echo "Building Harbor native components..."
    cd "$SCRIPT_DIR"
    cargo build --release
    echo "Binaries built in: $SCRIPT_DIR/target/release"
    echo ""
else
    echo "Skipping build (--skip-build)"
    echo ""
fi

if [ ! -x "$BUILD_BINARY_PATH" ]; then
    echo "Error: Binary not found at $BUILD_BINARY_PATH"
    echo "Run without --skip-build to build the binaries first."
    exit 1
fi
if [ ! -x "$BUILD_GATEWAY_BINARY_PATH" ]; then
    echo "Error: Binary not found at $BUILD_GATEWAY_BINARY_PATH"
    echo "Run without --skip-build to build the binaries first."
    exit 1
fi

mkdir -p "$INSTALL_DIRECTORY"
chmod 700 "$INSTALL_DIRECTORY"
install -m 755 "$BUILD_BINARY_PATH" "$INSTALLED_BINARY_PATH"
install -m 755 "$BUILD_GATEWAY_BINARY_PATH" "$INSTALLED_GATEWAY_BINARY_PATH"

cat > "$WRAPPER_PATH" << EOF
#!/bin/bash
exec "$INSTALLED_BINARY_PATH" --native-messaging "\$@"
EOF
chmod +x "$WRAPPER_PATH"

echo "Installed Harbor bridge: $INSTALLED_BINARY_PATH"
echo "Installed Harbor Agent Gateway: $INSTALLED_GATEWAY_BINARY_PATH"
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
    local extension_id="$2"

    if [ -d "$(dirname "$manifest_dir")" ]; then
        echo "Installing native messaging manifest for Chrome..."
        mkdir -p "$manifest_dir"

        if [ -z "$extension_id" ]; then
            echo "Error: Refusing to install a Chrome manifest without an exact extension ID." >&2
            return 1
        fi
        ORIGIN="chrome-extension://${extension_id}/"

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
    else
        echo "Skipping Chrome (not installed)"
    fi
}

# Install for Firefox
install_firefox_manifest "$FIREFOX_MANIFEST_DIR"

# Install for Chrome (unless --firefox-only)
if [ "$FIREFOX_ONLY" = false ]; then
    if [ -n "$CHROME_EXTENSION_ID" ]; then
        install_chrome_manifest "$CHROME_MANIFEST_DIR" "$CHROME_EXTENSION_ID"
    else
        echo "Skipping Chrome native messaging manifest: an exact extension ID is required."
        echo "After loading Harbor in Chrome, rerun:"
        echo "  ./install.sh --chrome-extension-id YOUR_32_CHARACTER_EXTENSION_ID"
    fi
fi

echo ""
echo "=== Installation Complete ==="
echo ""
echo "The harbor-bridge will now start automatically when you open the Harbor extension."
echo "The harbor-agent-gateway remains disabled until you enable and pair it in Harbor."
echo ""
echo "To test manually, run:"
echo "  $INSTALLED_BINARY_PATH"
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
