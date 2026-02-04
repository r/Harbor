#!/bin/bash
# Harbor Firefox Installer Build Script
# Creates a .pkg installer that includes the native bridge and Firefox extensions

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
OUTPUT_PKG="$BUILD_DIR/Harbor-Firefox-${VERSION}.pkg"

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
        
        # Validate required fields
        if [ -z "$EXTENSION_ID" ]; then
            echo_error "EXTENSION_ID not set in credentials.env"
            echo "       This is required for the extension to connect to the native bridge."
            exit 1
        fi
        echo "  Harbor Extension ID: $EXTENSION_ID"
        
        if [ -z "$WEB_AGENTS_EXTENSION_ID" ]; then
            echo_warn "WEB_AGENTS_EXTENSION_ID not set in credentials.env"
            echo "       Web Agents extension will not be built."
        else
            echo "  Web Agents Extension ID: $WEB_AGENTS_EXTENSION_ID"
        fi
    else
        echo_warn "No credentials file found at $CREDENTIALS_FILE"
        echo "       Create it from credentials.env.example for extension signing"
        echo_error "EXTENSION_ID is required - cannot build without credentials.env"
        exit 1
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
# Build Extension (Firefox)
# =============================================================================

build_extension() {
    echo_step "Building Firefox extension..."
    
    cd "$EXTENSION_DIR"
    
    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        echo "  Installing extension dependencies..."
        npm install
    fi
    
    # Update manifest.json with current version and extension ID
    echo "  Setting version to $VERSION..."
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" manifest.json
    
    echo "  Setting extension ID to $EXTENSION_ID..."
    # Update the gecko ID in browser_specific_settings
    sed -i '' "s/\"id\": \"[^\"]*@[^\"]*\"/\"id\": \"$EXTENSION_ID\"/" manifest.json
    
    # Build for Firefox (default)
    TARGET_BROWSER=firefox npm run build
    
    # Create XPI (unsigned) from the dist-firefox folder
    # The build puts manifest.json inside dist-firefox with corrected paths
    echo "  Creating XPI from dist-firefox/..."
    cd dist-firefox
    zip -r "$BUILD_DIR/harbor-unsigned.xpi" . \
        -x "*.map" "**/*.map"
    cd "$EXTENSION_DIR"
    
    echo_success "Firefox extension built: $BUILD_DIR/harbor-unsigned.xpi"
}

# =============================================================================
# Build Chrome Extension
# =============================================================================

build_chrome_extension() {
    echo_step "Building Chrome extension..."
    
    cd "$EXTENSION_DIR"
    
    # Update Chrome manifest version
    echo "  Setting version to $VERSION..."
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" manifest.chrome.json
    
    # Build for Chrome (uses --chrome flag)
    npm run build:chrome
    
    # Create Chrome extension folder from dist-chrome
    # The build already creates a self-contained dist-chrome/ with manifest.json
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
        echo "  - Extension ID: Will be assigned by Chrome Web Store"
        echo "  NOTE: After publishing to Chrome Web Store, add CHROME_EXTENSION_ID"
        echo "        and CHROME_WEBSTORE_URL to credentials.env"
    fi
}

# =============================================================================
# Sign Extension with web-ext
# =============================================================================

sign_extension() {
    if [ -z "$AMO_JWT_ISSUER" ] || [ -z "$AMO_JWT_SECRET" ]; then
        echo_warn "AMO credentials not set, skipping extension signing"
        echo "       The extension will work but show 'managed by organization'"
        cp "$BUILD_DIR/harbor-unsigned.xpi" "$BUILD_DIR/harbor.xpi"
        return 0
    fi
    
    echo_step "Signing extension with Mozilla Add-ons..."
    
    cd "$EXTENSION_DIR"
    
    # Install web-ext if needed
    if ! command -v web-ext &> /dev/null; then
        echo "  Installing web-ext..."
        npm install -g web-ext
    fi
    
    # Sign the extension
    # web-ext signs from dist-firefox which contains the built extension
    # with manifest.json that has correct relative paths
    web-ext sign \
        --api-key="$AMO_JWT_ISSUER" \
        --api-secret="$AMO_JWT_SECRET" \
        --channel=unlisted \
        --artifacts-dir="$BUILD_DIR/signed" \
        --source-dir="$EXTENSION_DIR/dist-firefox" \
        --ignore-files="*.map" --ignore-files="**/*.map" \
        2>&1 || {
            echo_warn "Extension signing failed, using unsigned XPI"
            cp "$BUILD_DIR/harbor-unsigned.xpi" "$BUILD_DIR/harbor.xpi"
            return 0
        }
    
    # Find the signed XPI
    SIGNED_XPI=$(find "$BUILD_DIR/signed" -name "*.xpi" -type f | head -1)
    
    if [ -n "$SIGNED_XPI" ]; then
        cp "$SIGNED_XPI" "$BUILD_DIR/harbor.xpi"
        echo_success "Extension signed: $BUILD_DIR/harbor.xpi"
    else
        echo_warn "Signed XPI not found, using unsigned"
        cp "$BUILD_DIR/harbor-unsigned.xpi" "$BUILD_DIR/harbor.xpi"
    fi
}

# =============================================================================
# Build Web Agents Extension (Firefox)
# =============================================================================

build_web_agents_extension() {
    if [ -z "$WEB_AGENTS_EXTENSION_ID" ]; then
        echo_warn "Skipping Web Agents extension (WEB_AGENTS_EXTENSION_ID not set)"
        return 0
    fi
    
    echo_step "Building Web Agents Firefox extension..."
    
    cd "$WEB_AGENTS_DIR"
    
    # Install dependencies if needed
    if [ ! -d "node_modules" ]; then
        echo "  Installing Web Agents dependencies..."
        npm install
    fi
    
    # Update manifest.json with current version and extension ID
    echo "  Setting version to $VERSION..."
    sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$VERSION\"/" manifest.json
    
    echo "  Setting extension ID to $WEB_AGENTS_EXTENSION_ID..."
    # Update the gecko ID in browser_specific_settings
    sed -i '' "s/\"id\": \"[^\"]*@[^\"]*\"/\"id\": \"$WEB_AGENTS_EXTENSION_ID\"/" manifest.json
    
    # Build for Firefox (default)
    npm run build
    
    # Create XPI (unsigned) from the dist-firefox folder
    echo "  Creating XPI from dist-firefox/..."
    cd dist-firefox
    zip -r "$BUILD_DIR/web-agents-unsigned.xpi" . \
        -x "*.map" "**/*.map"
    cd "$WEB_AGENTS_DIR"
    
    echo_success "Web Agents extension built: $BUILD_DIR/web-agents-unsigned.xpi"
}

# =============================================================================
# Sign Web Agents Extension with web-ext
# =============================================================================

sign_web_agents_extension() {
    if [ -z "$WEB_AGENTS_EXTENSION_ID" ]; then
        return 0
    fi
    
    if [ -z "$AMO_JWT_ISSUER" ] || [ -z "$AMO_JWT_SECRET" ]; then
        echo_warn "AMO credentials not set, skipping Web Agents extension signing"
        cp "$BUILD_DIR/web-agents-unsigned.xpi" "$BUILD_DIR/web-agents.xpi"
        return 0
    fi
    
    echo_step "Signing Web Agents extension with Mozilla Add-ons..."
    
    cd "$WEB_AGENTS_DIR"
    
    # Clear previous signed artifacts for this extension
    rm -rf "$BUILD_DIR/signed-web-agents"
    
    # Sign the extension
    web-ext sign \
        --api-key="$AMO_JWT_ISSUER" \
        --api-secret="$AMO_JWT_SECRET" \
        --channel=unlisted \
        --artifacts-dir="$BUILD_DIR/signed-web-agents" \
        --source-dir="$WEB_AGENTS_DIR/dist-firefox" \
        --ignore-files="*.map" --ignore-files="**/*.map" \
        2>&1 || {
            echo_warn "Web Agents extension signing failed, using unsigned XPI"
            cp "$BUILD_DIR/web-agents-unsigned.xpi" "$BUILD_DIR/web-agents.xpi"
            return 0
        }
    
    # Find the signed XPI
    SIGNED_XPI=$(find "$BUILD_DIR/signed-web-agents" -name "*.xpi" -type f | head -1)
    
    if [ -n "$SIGNED_XPI" ]; then
        cp "$SIGNED_XPI" "$BUILD_DIR/web-agents.xpi"
        echo_success "Web Agents extension signed: $BUILD_DIR/web-agents.xpi"
    else
        echo_warn "Signed XPI not found, using unsigned"
        cp "$BUILD_DIR/web-agents-unsigned.xpi" "$BUILD_DIR/web-agents.xpi"
    fi
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
# Copy Extensions to Payload
# =============================================================================

copy_extension() {
    echo_step "Copying extensions to payload..."
    
    # Copy Harbor Firefox extension
    cp "$BUILD_DIR/harbor.xpi" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
    echo "  ✓ Harbor Firefox extension (harbor.xpi)"
    
    # Copy Web Agents Firefox extension (if built)
    if [ -f "$BUILD_DIR/web-agents.xpi" ]; then
        cp "$BUILD_DIR/web-agents.xpi" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
        echo "  ✓ Web Agents Firefox extension (web-agents.xpi)"
    fi
    
    # Copy Chrome extension (unpacked folder for dev mode loading)
    if [ -d "$BUILD_DIR/chrome-extension" ]; then
        cp -r "$BUILD_DIR/chrome-extension" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
        echo "  ✓ Chrome extension (chrome-extension/) - for dev mode"
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
# Sign Binaries (for notarization)
# =============================================================================

sign_binaries() {
    # Get the Developer ID Application identity
    local APP_SIGN_IDENTITY=""
    if [ -n "$DEVELOPER_ID_APPLICATION" ]; then
        APP_SIGN_IDENTITY="$DEVELOPER_ID_APPLICATION"
    else
        # Try to find it automatically
        APP_SIGN_IDENTITY=$(security find-identity -v | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)"/\1/')
    fi
    
    if [ -z "$APP_SIGN_IDENTITY" ]; then
        echo_warn "No Developer ID Application certificate found - binaries will be unsigned"
        echo "       Notarization will fail without signed binaries"
        return 0
    fi
    
    echo_step "Signing binaries for notarization..."
    echo "  Using: $APP_SIGN_IDENTITY"
    
    # Sign harbor-bridge binary with hardened runtime
    local BRIDGE_PATH="$PAYLOAD_DIR/Library/Application Support/Harbor/harbor-bridge"
    if [ -f "$BRIDGE_PATH" ]; then
        echo "  Signing harbor-bridge..."
        codesign --force --options runtime --timestamp \
            --sign "$APP_SIGN_IDENTITY" \
            "$BRIDGE_PATH"
        echo "    ✓ harbor-bridge signed"
    fi
    
    # Sign Uninstall Harbor.app with hardened runtime
    local UNINSTALLER_APP="$PAYLOAD_DIR/Library/Application Support/Harbor/Uninstall Harbor.app"
    if [ -d "$UNINSTALLER_APP" ]; then
        echo "  Signing Uninstall Harbor.app..."
        codesign --force --deep --options runtime --timestamp \
            --sign "$APP_SIGN_IDENTITY" \
            "$UNINSTALLER_APP"
        echo "    ✓ Uninstall Harbor.app signed"
    fi
    
    echo_success "Binaries signed"
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
    sed -e "s/__EXTENSION_ID__/$EXTENSION_ID/g" \
        -e "s/__WEB_AGENTS_EXTENSION_ID__/${WEB_AGENTS_EXTENSION_ID:-}/g" \
        -e "s/__CHROME_EXTENSION_ID__/${CHROME_EXTENSION_ID:-}/g" \
        -e "s|__CHROME_WEBSTORE_URL__|${CHROME_WEBSTORE_URL:-}|g" \
        "$INSTALLER_DIR/scripts/postinstall" > "$SCRIPTS_TEMP/postinstall"
    
    # Make scripts executable
    chmod +x "$SCRIPTS_TEMP/preinstall"
    chmod +x "$SCRIPTS_TEMP/postinstall"
    
    # Build the component package
    pkgbuild \
        --root "$PAYLOAD_DIR" \
        --scripts "$SCRIPTS_TEMP" \
        --identifier "com.harbor.bridge" \
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
    # Support both DEVELOPER_ID_INSTALLER (full identity) and DEVELOPER_ID (name only)
    local SIGN_IDENTITY=""
    if [ -n "$DEVELOPER_ID_INSTALLER" ]; then
        SIGN_IDENTITY="$DEVELOPER_ID_INSTALLER"
    elif [ -n "$DEVELOPER_ID" ]; then
        SIGN_IDENTITY="Developer ID Installer: $DEVELOPER_ID"
    fi
    
    if [ -n "$SIGN_IDENTITY" ]; then
        echo_step "Signing package..."
        
        SIGNED_PKG="${OUTPUT_PKG%.pkg}-signed.pkg"
        
        productsign \
            --sign "$SIGN_IDENTITY" \
            "$OUTPUT_PKG" \
            "$SIGNED_PKG"
        
        # Replace unsigned with signed
        mv "$SIGNED_PKG" "$OUTPUT_PKG"
        
        echo_success "Package signed with: $SIGN_IDENTITY"
    else
        echo_warn "Skipping package signing (set DEVELOPER_ID_INSTALLER in credentials.env)"
    fi
}

# =============================================================================
# Notarize Package (Optional - for distribution outside App Store)
# =============================================================================

notarize_package() {
    echo_step "Notarizing package..."
    
    # Use keychain profile (set up via: xcrun notarytool store-credentials "AC_PASSWORD")
    xcrun notarytool submit "$OUTPUT_PKG" \
        --keychain-profile "AC_PASSWORD" \
        --wait
    
    # Staple the notarization ticket
    xcrun stapler staple "$OUTPUT_PKG"
    
    echo_success "Package notarized"
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
# Main
# =============================================================================

main() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Harbor Firefox Installer Builder"
    echo "  Version: $VERSION"
    echo "  Architecture: $ARCH"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    
    # Parse arguments
    BUILD_UNIVERSAL=true    # Universal by default
    # Auto-detect: sign if credentials are available (can be overridden)
    SIGN_EXT=auto
    SIGN_PKG=auto
    NOTARIZE=auto
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --arch-only|--current-arch)
                # Build only for current architecture (faster for dev)
                BUILD_UNIVERSAL=false
                shift
                ;;
            --sign-extension)
                SIGN_EXT=true
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
                SIGN_EXT=false
                SIGN_PKG=false
                NOTARIZE=false
                shift
                ;;
            --all)
                SIGN_EXT=true
                SIGN_PKG=true
                NOTARIZE=true
                BUILD_UNIVERSAL=true
                shift
                ;;
            --fast)
                # Fast dev build: current arch only, no signing
                BUILD_UNIVERSAL=false
                SIGN_EXT=false
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
                echo "  --sign-extension  Force extension signing (default: auto-detect)"
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
    if [ "$SIGN_EXT" = "auto" ]; then
        if [ -n "$AMO_JWT_ISSUER" ] && [ -n "$AMO_JWT_SECRET" ]; then
            SIGN_EXT=true
            echo_step "Auto-detected: Extension signing credentials available"
        else
            SIGN_EXT=false
        fi
    fi
    
    if [ "$SIGN_PKG" = "auto" ]; then
        if [ -n "$DEVELOPER_ID_INSTALLER" ] || [ -n "$DEVELOPER_ID" ]; then
            SIGN_PKG=true
            echo_step "Auto-detected: Package signing credentials available"
        else
            SIGN_PKG=false
        fi
    fi
    
    if [ "$NOTARIZE" = "auto" ]; then
        # Check if keychain profile exists by testing it
        if xcrun notarytool history --keychain-profile "AC_PASSWORD" &>/dev/null; then
            NOTARIZE=true
            echo_step "Auto-detected: Notarization keychain profile available"
        else
            NOTARIZE=false
            echo_warn "Notarization keychain profile 'AC_PASSWORD' not found"
            echo "       Set up with: xcrun notarytool store-credentials \"AC_PASSWORD\""
        fi
    fi
    
    # Run build steps
    cleanup
    
    # Build Harbor Firefox extension
    build_extension
    if [ "$SIGN_EXT" = true ]; then
        sign_extension
    else
        cp "$BUILD_DIR/harbor-unsigned.xpi" "$BUILD_DIR/harbor.xpi"
    fi
    
    # Build Web Agents Firefox extension
    build_web_agents_extension
    if [ "$SIGN_EXT" = true ]; then
        sign_web_agents_extension
    elif [ -f "$BUILD_DIR/web-agents-unsigned.xpi" ]; then
        cp "$BUILD_DIR/web-agents-unsigned.xpi" "$BUILD_DIR/web-agents.xpi"
    fi
    
    # Build Chrome extension
    build_chrome_extension
    
    if [ "$BUILD_UNIVERSAL" = true ]; then
        build_universal
    else
        build_bridge
    fi
    
    copy_extension
    copy_uninstaller
    
    # Sign binaries if we're going to notarize
    if [ "$SIGN_PKG" = true ]; then
        sign_binaries
    fi
    
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
    if [ "$SIGN_EXT" = true ]; then
        echo "    ✓ Harbor Extension: Signed with Mozilla Add-ons"
        if [ -n "$WEB_AGENTS_EXTENSION_ID" ]; then
            echo "    ✓ Web Agents Extension: Signed with Mozilla Add-ons"
        fi
    else
        echo "    ○ Extensions: Unsigned (set AMO_JWT_ISSUER/AMO_JWT_SECRET)"
    fi
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
