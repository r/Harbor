#!/bin/bash
# Harbor Chrome Installer Build Script
# Creates a .pkg installer that includes the native bridge and Chrome extension

set -e

# =============================================================================
# Configuration
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BRIDGE_DIR="$PROJECT_ROOT/bridge-rs"
EXTENSION_DIR="$PROJECT_ROOT/extension"
WEB_AGENTS_DIR="$PROJECT_ROOT/web-agents-api"
INSTALLER_DIR="$SCRIPT_DIR"
CREDENTIALS_FILE="$PROJECT_ROOT/installer/credentials.env"

# Version: use timestamp for dev builds, or explicit VERSION env var
# Format: 0.YYMMDD.HHMM (e.g., 0.260104.1530 for Jan 4, 2026 at 15:30)
if [ -z "$VERSION" ]; then
    VERSION="0.$(date +%y%m%d).$(date +%H%M)"
fi

# Output paths
BUILD_DIR="$INSTALLER_DIR/build"
PAYLOAD_DIR="$INSTALLER_DIR/payload"
OUTPUT_PKG="$BUILD_DIR/Harbor-Chrome-${VERSION}.pkg"

# Component package
COMPONENT_PKG="$BUILD_DIR/harbor-bridge.pkg"

# Architecture detection
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    RUST_TARGET="aarch64-apple-darwin"
    BINARY_SUFFIX="arm64"
else
    RUST_TARGET="x86_64-apple-darwin"
    BINARY_SUFFIX="x64"
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo_step() {
    echo -e "${BLUE}==>${NC} $1"
}

echo_success() {
    echo -e "${GREEN}✓${NC} $1"
}

echo_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

echo_error() {
    echo -e "${RED}✗${NC} $1"
}

# =============================================================================
# Load Credentials
# =============================================================================

load_credentials() {
    if [ -f "$CREDENTIALS_FILE" ]; then
        echo_step "Loading credentials..."
        # Source the credentials file (it's in bash format)
        set -a
        source "$CREDENTIALS_FILE"
        set +a
        echo_success "Credentials loaded"
        
        # Chrome extension ID is optional until published to Web Store
        if [ -n "$CHROME_EXTENSION_ID" ]; then
            echo "  Chrome Extension ID: $CHROME_EXTENSION_ID"
        else
            echo_warn "CHROME_EXTENSION_ID not set (using dev mode)"
            echo "       Extension will need to be loaded manually in developer mode"
        fi
        
        if [ -n "$CHROME_WEB_AGENTS_EXTENSION_ID" ]; then
            echo "  Chrome Web Agents Extension ID: $CHROME_WEB_AGENTS_EXTENSION_ID"
        fi
    else
        echo_warn "No credentials file found at $CREDENTIALS_FILE"
        echo "       Create it from credentials.env.example"
        echo "       Building in dev mode (manual extension loading required)"
    fi
}

# =============================================================================
# Cleanup
# =============================================================================

# Deep clean - removes all build artifacts
clean_all() {
    echo_step "Deep cleaning all build artifacts..."
    
    # Clean installer build directory
    rm -rf "$BUILD_DIR"
    rm -rf "$PAYLOAD_DIR"
    
    # Clean bridge-rs
    rm -rf "$BRIDGE_DIR/target"
    
    # Clean extension
    rm -rf "$EXTENSION_DIR/dist"
    rm -rf "$EXTENSION_DIR/dist-firefox"
    rm -rf "$EXTENSION_DIR/dist-chrome"
    rm -rf "$EXTENSION_DIR/node_modules"
    
    # Clean web-agents-api
    rm -rf "$WEB_AGENTS_DIR/dist"
    rm -rf "$WEB_AGENTS_DIR/dist-firefox"
    rm -rf "$WEB_AGENTS_DIR/dist-chrome"
    rm -rf "$WEB_AGENTS_DIR/node_modules"
    
    echo_success "Deep clean complete"
}

cleanup() {
    echo_step "Cleaning up previous build..."
    rm -rf "$BUILD_DIR"
    rm -rf "$PAYLOAD_DIR"
    mkdir -p "$BUILD_DIR"
    mkdir -p "$PAYLOAD_DIR/Library/Application Support/Harbor"
    echo_success "Clean"
}

# =============================================================================
# Build Chrome Extension
# =============================================================================

build_chrome_extension() {
    echo_step "Building Chrome extension..."
    
    cd "$EXTENSION_DIR"
    
    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        echo "  Installing extension dependencies..."
        npm install
    fi
    
    # Update Chrome manifest version
    echo "  Setting version to $VERSION..."
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" manifest.chrome.json
    
    # Build for Chrome
    npm run build:chrome
    
    # Create Chrome extension folder from dist-chrome
    mkdir -p "$BUILD_DIR/chrome-extension"
    
    # Copy everything from dist-chrome (it already has manifest.json with correct paths)
    cp -r dist-chrome/* "$BUILD_DIR/chrome-extension/"
    
    # Create a zip for Chrome Web Store upload
    cd "$BUILD_DIR/chrome-extension"
    zip -r "$BUILD_DIR/harbor-chrome.zip" . -x "*.map" "**/*.map"
    cd "$EXTENSION_DIR"
    
    echo_success "Chrome extension built:"
    echo "  - Unpacked: $BUILD_DIR/chrome-extension/ (for dev mode)"
    echo "  - ZIP: $BUILD_DIR/harbor-chrome.zip (for Web Store upload)"
    
    if [ -n "$CHROME_EXTENSION_ID" ]; then
        echo "  - Extension ID: $CHROME_EXTENSION_ID (from credentials.env)"
    else
        echo "  - Extension ID: Will be assigned by Chrome on first load"
    fi
}

# =============================================================================
# Build Chrome Web Agents Extension
# =============================================================================

build_chrome_web_agents_extension() {
    echo_step "Building Chrome Web Agents extension..."
    
    cd "$WEB_AGENTS_DIR"
    
    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        echo "  Installing Web Agents dependencies..."
        npm install
    fi
    
    # Update manifest.chrome.json with current version
    echo "  Setting version to $VERSION..."
    if [ -f "manifest.chrome.json" ]; then
        sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" manifest.chrome.json
    fi
    
    # Build for Chrome (uses --chrome flag)
    npm run build:chrome
    
    # Create Chrome Web Agents extension folder
    mkdir -p "$BUILD_DIR/web-agents-chrome"
    
    # Copy from dist-chrome
    if [ -d "dist-chrome" ]; then
        cp -r dist-chrome/* "$BUILD_DIR/web-agents-chrome/"
    else
        echo_warn "dist-chrome not found, Web Agents extension may not work correctly"
    fi
    
    # Create zip for Web Store
    cd "$BUILD_DIR/web-agents-chrome"
    zip -r "$BUILD_DIR/web-agents-chrome.zip" . -x "*.map" "**/*.map"
    cd "$WEB_AGENTS_DIR"
    
    echo_success "Chrome Web Agents extension built"
}

# =============================================================================
# Build Bridge (Rust)
# =============================================================================

build_bridge() {
    echo_step "Building native bridge (Rust)..."
    
    cd "$BRIDGE_DIR"
    
    # Build for the current architecture
    echo "  Compiling Rust for $RUST_TARGET..."
    cargo build --release --target "$RUST_TARGET"
    
    # Copy binary to build dir
    cp "target/$RUST_TARGET/release/harbor-bridge" "$BUILD_DIR/harbor-bridge"
    
    # Copy binary to payload
    cp "$BUILD_DIR/harbor-bridge" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
    
    echo_success "Bridge built: $BUILD_DIR/harbor-bridge"
}

# =============================================================================
# Universal Binary (both arm64 and x64)
# =============================================================================

build_universal() {
    echo_step "Building universal binary (Rust)..."
    
    cd "$BRIDGE_DIR"
    
    # Ensure both Rust targets are installed
    rustup target add aarch64-apple-darwin 2>/dev/null || true
    rustup target add x86_64-apple-darwin 2>/dev/null || true
    
    # Build for arm64
    echo "  Compiling for aarch64-apple-darwin (Apple Silicon)..."
    cargo build --release --target aarch64-apple-darwin
    
    # Build for x64
    echo "  Compiling for x86_64-apple-darwin (Intel)..."
    cargo build --release --target x86_64-apple-darwin
    
    # Create universal binary with lipo
    echo "  Creating universal binary with lipo..."
    lipo -create \
        "target/aarch64-apple-darwin/release/harbor-bridge" \
        "target/x86_64-apple-darwin/release/harbor-bridge" \
        -output "$BUILD_DIR/harbor-bridge"
    
    # Copy to payload
    cp "$BUILD_DIR/harbor-bridge" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
    
    echo_success "Universal binary created: $BUILD_DIR/harbor-bridge"
}

# =============================================================================
# Copy Extensions to Payload
# =============================================================================

copy_extension() {
    echo_step "Copying extensions to payload..."
    
    # Copy Chrome extension (unpacked folder for dev mode loading)
    if [ -d "$BUILD_DIR/chrome-extension" ]; then
        cp -r "$BUILD_DIR/chrome-extension" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
        echo "  ✓ Harbor Chrome extension (chrome-extension/)"
    fi
    
    # Copy Chrome Web Agents extension
    if [ -d "$BUILD_DIR/web-agents-chrome" ]; then
        cp -r "$BUILD_DIR/web-agents-chrome" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
        echo "  ✓ Web Agents Chrome extension (web-agents-chrome/)"
    fi
    
    echo_success "Extensions copied"
}

# =============================================================================
# Copy Uninstaller
# =============================================================================

copy_uninstaller() {
    echo_step "Copying uninstaller..."
    
    # Copy uninstall script
    cp "$INSTALLER_DIR/scripts/uninstall.sh" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
    chmod +x "$PAYLOAD_DIR/Library/Application Support/Harbor/uninstall.sh"
    
    # Build uninstaller app from AppleScript
    echo "  Building uninstaller app..."
    UNINSTALLER_APP="$PAYLOAD_DIR/Library/Application Support/Harbor/Uninstall Harbor.app"
    
    osacompile -o "$UNINSTALLER_APP" "$INSTALLER_DIR/resources/uninstall-app.applescript" 2>/dev/null || {
        echo_warn "Could not build uninstaller app (osacompile not available)"
        echo "       CLI uninstaller will still be available"
    }
    
    echo_success "Uninstaller prepared"
}

# =============================================================================
# Create Component Package
# =============================================================================

create_component_pkg() {
    echo_step "Creating component package..."
    
    # Create a temp scripts directory with architecture stamped
    SCRIPTS_TEMP="$BUILD_DIR/scripts"
    mkdir -p "$SCRIPTS_TEMP"
    
    # Copy and stamp preinstall with build architecture
    if [ "$BUILD_UNIVERSAL" = true ]; then
        BUILD_ARCH_MARKER="universal"
    else
        BUILD_ARCH_MARKER="$ARCH"
    fi
    
    sed "s/__BUILD_ARCH__/$BUILD_ARCH_MARKER/g" "$INSTALLER_DIR/scripts/preinstall" > "$SCRIPTS_TEMP/preinstall"
    
    # Stamp postinstall with extension IDs and URLs
    sed -e "s/__CHROME_EXTENSION_ID__/${CHROME_EXTENSION_ID:-}/g" \
        -e "s/__CHROME_WEB_AGENTS_EXTENSION_ID__/${CHROME_WEB_AGENTS_EXTENSION_ID:-}/g" \
        -e "s|__CHROME_WEBSTORE_URL__|${CHROME_WEBSTORE_URL:-}|g" \
        -e "s|__CHROME_WEB_AGENTS_WEBSTORE_URL__|${CHROME_WEB_AGENTS_WEBSTORE_URL:-}|g" \
        "$INSTALLER_DIR/scripts/postinstall" > "$SCRIPTS_TEMP/postinstall"
    
    # Make scripts executable
    chmod +x "$SCRIPTS_TEMP/preinstall"
    chmod +x "$SCRIPTS_TEMP/postinstall"
    
    # Build the component package
    pkgbuild \
        --root "$PAYLOAD_DIR" \
        --scripts "$SCRIPTS_TEMP" \
        --identifier "com.harbor.chrome" \
        --version "$VERSION" \
        --install-location "/" \
        "$COMPONENT_PKG"
    
    echo_success "Component package created: $COMPONENT_PKG"
}

# =============================================================================
# Create Product Archive (Final .pkg)
# =============================================================================

create_product_pkg() {
    echo_step "Creating product archive..."
    
    # Update version in distribution.xml
    sed "s/version=\"1.0.0\"/version=\"$VERSION\"/g" "$INSTALLER_DIR/distribution.xml" > "$BUILD_DIR/distribution.xml"
    
    # Copy resources to build dir and substitute version
    mkdir -p "$BUILD_DIR/resources"
    cp "$INSTALLER_DIR/resources/"*.html "$BUILD_DIR/resources/" 2>/dev/null || true
    cp "$INSTALLER_DIR/resources/"*.applescript "$BUILD_DIR/resources/" 2>/dev/null || true
    
    # Substitute version in welcome.html
    if [ -f "$BUILD_DIR/resources/welcome.html" ]; then
        sed -i '' "s/__VERSION__/$VERSION/g" "$BUILD_DIR/resources/welcome.html"
    fi
    
    # Build the final installer package with the distribution file
    productbuild \
        --distribution "$BUILD_DIR/distribution.xml" \
        --resources "$BUILD_DIR/resources" \
        --package-path "$BUILD_DIR" \
        "$OUTPUT_PKG"
    
    echo_success "Product archive created: $OUTPUT_PKG"
}

# =============================================================================
# Sign Package (Optional - for distribution)
# =============================================================================

sign_package() {
    if [ -n "$DEVELOPER_ID" ]; then
        echo_step "Signing package..."
        
        SIGNED_PKG="${OUTPUT_PKG%.pkg}-signed.pkg"
        
        productsign \
            --sign "Developer ID Installer: $DEVELOPER_ID" \
            "$OUTPUT_PKG" \
            "$SIGNED_PKG"
        
        # Replace unsigned with signed
        mv "$SIGNED_PKG" "$OUTPUT_PKG"
        
        echo_success "Package signed"
    else
        echo_warn "Skipping package signing (set DEVELOPER_ID in credentials.env)"
    fi
}

# =============================================================================
# Notarize Package (Optional - for distribution outside App Store)
# =============================================================================

notarize_package() {
    if [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ]; then
        echo_step "Notarizing package..."
        
        xcrun notarytool submit "$OUTPUT_PKG" \
            --apple-id "$APPLE_ID" \
            --team-id "$APPLE_TEAM_ID" \
            --password "@keychain:AC_PASSWORD" \
            --wait
        
        # Staple the notarization ticket
        xcrun stapler staple "$OUTPUT_PKG"
        
        echo_success "Package notarized"
    else
        echo_warn "Skipping notarization (set APPLE_ID and APPLE_TEAM_ID in credentials.env)"
    fi
}

# =============================================================================
# Main
# =============================================================================

main() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Harbor Chrome Installer Builder"
    echo "  Version: $VERSION"
    echo "  Architecture: $ARCH"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    
    # Parse arguments
    BUILD_UNIVERSAL=true    # Universal by default
    SIGN_PKG=auto
    NOTARIZE=auto
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --arch-only|--current-arch)
                # Build only for current architecture (faster for dev)
                BUILD_UNIVERSAL=false
                shift
                ;;
            --sign)
                SIGN_PKG=true
                shift
                ;;
            --notarize)
                NOTARIZE=true
                SIGN_PKG=true
                shift
                ;;
            --no-sign)
                # Explicitly disable all signing
                SIGN_PKG=false
                NOTARIZE=false
                shift
                ;;
            --all)
                SIGN_PKG=true
                NOTARIZE=true
                BUILD_UNIVERSAL=true
                shift
                ;;
            --fast)
                # Fast dev build: current arch only, no signing
                BUILD_UNIVERSAL=false
                SIGN_PKG=false
                NOTARIZE=false
                shift
                ;;
            --clean)
                # Deep clean all build artifacts before building
                clean_all
                shift
                ;;
            --clean-only)
                # Just clean, don't build
                clean_all
                exit 0
                ;;
            --help)
                echo "Usage: $0 [options]"
                echo ""
                echo "Options:"
                echo "  --clean           Deep clean all artifacts before building"
                echo "  --clean-only      Clean only, don't build"
                echo "  --fast            Fast dev build (current arch, no signing)"
                echo "  --no-sign         Skip all signing (even if credentials available)"
                echo "  --sign            Force pkg signing (default: auto-detect)"
                echo "  --notarize        Force notarization (default: auto-detect)"
                echo "  --all             Enable all signing options + universal build"
                echo ""
                echo "By default, signing and notarization happen automatically if"
                echo "credentials are configured in installer/credentials.env"
                echo ""
                echo "Examples:"
                echo "  $0                            # Auto-sign if credentials available"
                echo "  $0 --clean                    # Clean + auto-sign"
                echo "  $0 --fast                     # Quick dev build (no signing)"
                echo "  $0 --no-sign                  # Build without any signing"
                echo "  $0 --clean-only               # Just clean, no build"
                echo ""
                echo "Credentials file: installer/credentials.env"
                exit 0
                ;;
            *)
                echo_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done
    
    # Load credentials
    load_credentials
    
    # Resolve "auto" settings based on available credentials
    if [ "$SIGN_PKG" = "auto" ]; then
        if [ -n "$DEVELOPER_ID" ]; then
            SIGN_PKG=true
            echo_step "Auto-detected: Package signing credentials available"
        else
            SIGN_PKG=false
        fi
    fi
    
    if [ "$NOTARIZE" = "auto" ]; then
        if [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] && [ -n "$DEVELOPER_ID" ]; then
            NOTARIZE=true
            echo_step "Auto-detected: Notarization credentials available"
        else
            NOTARIZE=false
        fi
    fi
    
    # Run build steps
    cleanup
    
    # Build Chrome extensions
    build_chrome_extension
    build_chrome_web_agents_extension
    
    if [ "$BUILD_UNIVERSAL" = true ]; then
        build_universal
    else
        build_bridge
    fi
    
    copy_extension
    copy_uninstaller
    create_component_pkg
    create_product_pkg
    
    if [ "$SIGN_PKG" = true ]; then
        sign_package
    fi
    
    if [ "$NOTARIZE" = true ]; then
        notarize_package
    fi
    
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    echo_success "Build complete!"
    echo ""
    echo "  Installer: $OUTPUT_PKG"
    echo "  Size: $(du -h "$OUTPUT_PKG" | cut -f1)"
    if [ "$BUILD_UNIVERSAL" = true ]; then
        echo "  Architecture: Universal (Intel + Apple Silicon)"
    else
        echo "  Architecture: $ARCH only"
    fi
    echo ""
    
    # Signing status summary
    echo "  Signing status:"
    if [ "$SIGN_PKG" = true ]; then
        echo "    ✓ Package: Signed with Developer ID"
    else
        echo "    ○ Package: Unsigned (set DEVELOPER_ID in credentials.env)"
    fi
    if [ "$NOTARIZE" = true ]; then
        echo "    ✓ Notarization: Submitted and stapled"
    else
        echo "    ○ Notarization: Skipped (set APPLE_ID/APPLE_TEAM_ID + keychain password)"
    fi
    echo ""
    
    # Extension installation info
    echo "  Chrome Extension:"
    if [ -n "$CHROME_WEBSTORE_URL" ]; then
        echo "    ✓ Will open Chrome Web Store after install"
    else
        echo "    ○ Dev mode: Manual loading required"
        echo "      Load from: /Library/Application Support/Harbor/chrome-extension"
    fi
    echo ""
    
    echo "To install locally:"
    echo "  sudo installer -pkg \"$OUTPUT_PKG\" -target /"
    echo ""
    echo "Or double-click the .pkg file in Finder."
    echo ""
    if [ "$BUILD_UNIVERSAL" != true ]; then
        echo_warn "Built for $ARCH only. Remove --fast or --arch-only for universal build."
    fi
    if [ "$SIGN_PKG" != true ] || [ "$NOTARIZE" != true ]; then
        echo_warn "Package may trigger Gatekeeper warnings without signing/notarization."
        echo "       Configure Apple Developer credentials in credentials.env for distribution."
    fi
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
}

main "$@"
