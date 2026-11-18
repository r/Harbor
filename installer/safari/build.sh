#!/bin/bash
# Build Harbor as a Safari app that loads locally.
#
# Builds the Safari extension, wraps it in a macOS app with Apple's converter,
# and builds the app with ad-hoc signing. No Apple developer account is needed.
# Everything is generated under installer/safari/build/, which is gitignored.
#
# The app only registers the extension with Safari. It doesn't start the
# bridge: run `harbor-bridge --http-server` yourself (see docs/QUICKSTART_SAFARI.md).
#
# Usage: installer/safari/build.sh [--open]
#   --open   Open the built app once, which registers the extension with Safari.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
APP_NAME="Harbor"
APP_ID="org.harbor.Harbor"
EXTENSION_ID="$APP_ID.Extension"

OPEN_APP=false
for arg in "$@"; do
    case "$arg" in
        --open) OPEN_APP=true ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

if [ "$(uname)" != "Darwin" ]; then
    echo "Safari builds need macOS." >&2
    exit 1
fi
if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
    echo "safari-web-extension-converter not found. Install Xcode and run: sudo xcode-select -s /Applications/Xcode.app" >&2
    exit 1
fi

echo "==> Building the Safari extension"
npm run build:safari --prefix "$REPO_ROOT/extension"

echo "==> Generating the Xcode project"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
xcrun safari-web-extension-converter "$REPO_ROOT/extension/dist-safari" \
    --project-location "$BUILD_DIR" \
    --app-name "$APP_NAME" \
    --bundle-identifier "$APP_ID" \
    --macos-only \
    --copy-resources \
    --no-open \
    --no-prompt \
    --force

PROJECT_DIR="$BUILD_DIR/$APP_NAME"
PROJECT="$PROJECT_DIR/$APP_NAME.xcodeproj"

# Xcode refuses to embed an extension whose bundle ID isn't prefixed by the
# app's. The converter keeps them aligned only when the bundle ID's last part
# matches the app name, as APP_ID does here. Check rather than trust it.
echo "==> Checking bundle identifiers"
IDS="$(grep -rhoE 'PRODUCT_BUNDLE_IDENTIFIER"?[[:space:]]*[=:][[:space:]]*"?[A-Za-z0-9.-]+' "$PROJECT" | grep -oE '[A-Za-z0-9.-]+$' | sort -u || true)"
if [ "$IDS" != "$(printf '%s\n%s' "$APP_ID" "$EXTENSION_ID")" ]; then
    echo "The generated project has unexpected bundle IDs (want $APP_ID and $EXTENSION_ID):" >&2
    echo "$IDS" >&2
    exit 1
fi

echo "==> Building the app (ad-hoc signed)"
xcodebuild \
    -project "$PROJECT" \
    -scheme "$APP_NAME" \
    -configuration Debug \
    -derivedDataPath "$BUILD_DIR/DerivedData" \
    -destination "platform=macOS" \
    CODE_SIGN_IDENTITY=- \
    CODE_SIGN_STYLE=Manual \
    DEVELOPMENT_TEAM= \
    -quiet \
    build

APP_PATH="$BUILD_DIR/DerivedData/Build/Products/Debug/$APP_NAME.app"
if [ ! -d "$APP_PATH/Contents/PlugIns/$APP_NAME Extension.appex" ]; then
    echo "Build finished but the extension isn't embedded in $APP_PATH." >&2
    exit 1
fi

echo ""
echo "Built: $APP_PATH"
echo ""
echo "Next (see docs/QUICKSTART_SAFARI.md):"
echo "  1. Safari > Develop > Developer Settings > Allow Unsigned Extensions"
echo "  2. open \"$APP_PATH\"   (once, to register the extension)"
echo "  3. Safari > Settings > Extensions > enable Harbor, and allow it on all websites"
echo "  4. Run the bridge: harbor-bridge --http-server"

if [ "$OPEN_APP" = true ]; then
    open "$APP_PATH"
fi
