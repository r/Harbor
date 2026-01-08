#!/bin/bash
# Install the native messaging host manifest for macOS (TypeScript version)

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE_DIR="$(dirname "$SCRIPT_DIR")"

# Firefox extension ID - must match manifest.json
EXTENSION_ID="raffi.krikorian.harbor@gmail.com"

# Manifest name (must match what the extension connects to)
MANIFEST_NAME="harbor_bridge_host"

# Target directory for Firefox native messaging hosts
MANIFEST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts"

# Path to the bridge executable (node running the compiled JS)
BRIDGE_MAIN="$BRIDGE_DIR/dist/main.js"

# Find node - use full path since Firefox launches with minimal environment
NODE_PATH=$(which node)
if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found in PATH"
  exit 1
fi

# Create a launcher script that runs the bridge with node
LAUNCHER_SCRIPT="$BRIDGE_DIR/harbor-bridge"

echo "Creating launcher script at $LAUNCHER_SCRIPT..."
echo "Using node at: $NODE_PATH"
cat > "$LAUNCHER_SCRIPT" << EOF
#!/bin/bash
exec "$NODE_PATH" "$BRIDGE_MAIN"
EOF
chmod +x "$LAUNCHER_SCRIPT"

echo "Creating manifest directory at $MANIFEST_DIR..."
mkdir -p "$MANIFEST_DIR"

MANIFEST_FILE="$MANIFEST_DIR/${MANIFEST_NAME}.json"

echo "Installing native messaging manifest..."
cat > "$MANIFEST_FILE" << EOF
{
  "name": "$MANIFEST_NAME",
  "description": "Harbor Bridge - MCP Server Manager",
  "path": "$LAUNCHER_SCRIPT",
  "type": "stdio",
  "allowed_extensions": ["$EXTENSION_ID"]
}
EOF

echo ""
echo "✅ Native messaging host manifest installed successfully!"
echo ""
echo "Manifest location: $MANIFEST_FILE"
echo "Bridge executable: $LAUNCHER_SCRIPT"
echo ""
echo "The extension should now be able to communicate with the bridge."
echo "Restart Firefox if it's already running."






