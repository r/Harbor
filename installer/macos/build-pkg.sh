#!/bin/bash
# Harbor macOS Installer Build Script
# Creates a .pkg installer that includes the native bridge and Firefox extension

set -e

# =============================================================================
# Configuration
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
BRIDGE_DIR="$PROJECT_ROOT/bridge-ts"
EXTENSION_DIR="$PROJECT_ROOT/extension"
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
OUTPUT_PKG="$BUILD_DIR/Harbor-${VERSION}.pkg"

# Component package
COMPONENT_PKG="$BUILD_DIR/harbor-bridge.pkg"

# Architecture detection
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
    PKG_TARGET="node18-macos-arm64"
    BINARY_SUFFIX="arm64"
else
    PKG_TARGET="node18-macos-x64"
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
        echo "  Extension ID: $EXTENSION_ID"
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

# Deep clean - removes all build artifacts including node_modules
clean_all() {
    echo_step "Deep cleaning all build artifacts..."
    
    # Clean installer build directory
    rm -rf "$BUILD_DIR"
    rm -rf "$PAYLOAD_DIR"
    
    # Clean bridge-ts
    rm -rf "$BRIDGE_DIR/dist"
    rm -rf "$BRIDGE_DIR/node_modules"
    rm -rf "$BRIDGE_DIR/build"
    
    # Clean extension
    rm -rf "$EXTENSION_DIR/dist"
    rm -rf "$EXTENSION_DIR/node_modules"
    
    # Clean any-llm-ts submodule if present
    if [ -d "$BRIDGE_DIR/src/any-llm-ts" ]; then
        rm -rf "$BRIDGE_DIR/src/any-llm-ts/dist"
        rm -rf "$BRIDGE_DIR/src/any-llm-ts/node_modules"
    fi
    
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
    
    # Create XPI (unsigned)
    cd dist
    zip -r "$BUILD_DIR/harbor-unsigned.xpi" . -x "*.map"
    
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
    
    # Build for Chrome
    TARGET_BROWSER=chrome npm run build
    
    # Copy unpacked extension (for dev mode loading)
    mkdir -p "$BUILD_DIR/chrome-extension"
    cp -r dist/* "$BUILD_DIR/chrome-extension/"
    
    # Create a zip for Chrome Web Store upload
    cd dist
    zip -r "$BUILD_DIR/harbor-chrome.zip" . -x "*.map"
    cd ..
    
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
    
    cd "$EXTENSION_DIR/dist"
    
    # Install web-ext if needed
    if ! command -v web-ext &> /dev/null; then
        echo "  Installing web-ext..."
        npm install -g web-ext
    fi
    
    # Sign the extension
    # This creates a signed XPI in web-ext-artifacts/
    web-ext sign \
        --api-key="$AMO_JWT_ISSUER" \
        --api-secret="$AMO_JWT_SECRET" \
        --channel=unlisted \
        --artifacts-dir="$BUILD_DIR/signed" \
        --source-dir="$EXTENSION_DIR/dist" \
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
# Build Bridge (with esbuild + pkg, bundled Node.js)
# =============================================================================

# Node version - MUST be exact same for building AND bundling
# This ensures native modules are 100% compatible
# Use v20.19.6 because that's what pkg has available
BUNDLED_NODE_FULL="20.19.6"
BUNDLED_NODE_MAJOR="20"

setup_build_node() {
    echo_step "Setting up Node.js $BUNDLED_NODE_FULL for building..."
    
    NODE_BUILD_DIR="$BUILD_DIR/node-build"
    mkdir -p "$NODE_BUILD_DIR"
    
    # Determine platform
    if [ "$ARCH" = "arm64" ]; then
        NODE_PLATFORM="darwin-arm64"
    else
        NODE_PLATFORM="darwin-x64"
    fi
    
    NODE_TARBALL="node-v${BUNDLED_NODE_FULL}-${NODE_PLATFORM}.tar.gz"
    NODE_URL="https://nodejs.org/dist/v${BUNDLED_NODE_FULL}/${NODE_TARBALL}"
    NODE_DIR="$NODE_BUILD_DIR/node-v${BUNDLED_NODE_FULL}-${NODE_PLATFORM}"
    
    # Download if not cached
    if [ ! -d "$NODE_DIR" ]; then
        echo "  Downloading Node.js $BUNDLED_NODE_FULL..."
        curl -sL "$NODE_URL" -o "$NODE_BUILD_DIR/$NODE_TARBALL"
        tar -xzf "$NODE_BUILD_DIR/$NODE_TARBALL" -C "$NODE_BUILD_DIR"
        rm "$NODE_BUILD_DIR/$NODE_TARBALL"
    fi
    
    # Set up PATH to use this Node
    export PATH="$NODE_DIR/bin:$PATH"
    export npm_config_nodedir="$NODE_DIR"
    
    echo "  Using Node: $(which node)"
    echo "  Version: $(node --version)"
    echo_success "Build Node.js ready"
}

build_bridge() {
    echo_step "Building native bridge (standalone with bundled Node)..."
    
    # Set up specific Node version for building
    setup_build_node
    
    cd "$BRIDGE_DIR"
    
    # Build the any-llm-ts submodule if needed
    if [ -d "src/any-llm-ts" ] && [ ! -d "src/any-llm-ts/dist" ]; then
        echo "  Building any-llm-ts submodule..."
        cd src/any-llm-ts
        npm install
        npm run build
        cd ../..
    fi
    
    # Clean and reinstall to ensure native modules match build Node version
    echo "  Installing dependencies with Node $BUNDLED_NODE_FULL..."
    rm -rf node_modules/better-sqlite3 2>/dev/null || true
    npm install
    
    # Rebuild native modules explicitly for this Node version
    echo "  Rebuilding native modules for Node $BUNDLED_NODE_FULL..."
    npm rebuild better-sqlite3
    
    # Verify the native module is built for correct version
    echo "  Verifying native module version..."
    node -e "require('better-sqlite3')" && echo "  Native module OK" || {
        echo_error "Native module verification failed"
        exit 1
    }
    
    # Build TypeScript
    echo "  Compiling TypeScript..."
    npm run build
    
    # Bundle with esbuild (fixes ESM issues with pkg)
    echo "  Bundling with esbuild..."
    mkdir -p build
    
    npx esbuild dist/main.js \
        --bundle \
        --platform=node \
        --target=node${BUNDLED_NODE_MAJOR} \
        --format=cjs \
        --outfile=build/bundle.cjs \
        --external:better-sqlite3 2>&1 | grep -v "empty-import-meta" || true
    
    # Create standalone binary with pkg (EXACT same Node version as we built with)
    echo "  Creating standalone binary for $ARCH with bundled Node $BUNDLED_NODE_FULL..."
    
    # pkg expects assets at the same relative path as the original source
    # The bundle was built in bridge-ts/, so assets should be at bridge-ts/node_modules/...
    # We need to create that structure in the build dir
    
    # Create pkg.json for assets config
    # Note: pkg uses major version format (node20) not full version (node20.19.6)
    cat > build/pkg.json << EOF
{
  "pkg": {
    "assets": ["../node_modules/better-sqlite3/build/Release/better_sqlite3.node"]
  }
}
EOF
    
    # IMPORTANT: Pass bundle.cjs directly to pkg, not package.json - the bin field doesn't work properly
    cd build
    npx @yao-pkg/pkg bundle.cjs \
        --config pkg.json \
        --target "node${BUNDLED_NODE_MAJOR}-macos-${BINARY_SUFFIX}" \
        --output "$BUILD_DIR/harbor-bridge" 2>&1 | grep -v "^> Warning" || true
    cd ..
    
    # Copy binary to payload
    cp "$BUILD_DIR/harbor-bridge" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
    
    echo_success "Bridge built: $BUILD_DIR/harbor-bridge (standalone)"
}

# =============================================================================
# Alternative: Bundle without pkg (uses system Node.js)
# =============================================================================

build_bridge_node() {
    echo_step "Building native bridge (Node.js bundle)..."
    
    cd "$BRIDGE_DIR"
    
    # Build the any-llm-ts submodule if needed
    if [ -d "src/any-llm-ts" ] && [ ! -d "src/any-llm-ts/dist" ]; then
        echo "  Building any-llm-ts submodule..."
        cd src/any-llm-ts
        npm install
        npm run build
        cd ../..
    fi
    
    # Install production dependencies
    echo "  Installing dependencies..."
    npm install
    
    # Build TypeScript
    echo "  Compiling TypeScript..."
    npm run build
    
    # Bundle with esbuild (creates single file, only external is better-sqlite3)
    echo "  Bundling with esbuild..."
    mkdir -p build
    npx esbuild dist/main.js \
        --bundle \
        --platform=node \
        --target=node18 \
        --format=cjs \
        --outfile=build/bundle.cjs \
        --external:better-sqlite3 2>&1 | grep -v "empty-import-meta" || true
    
    # Create a distribution bundle
    BUNDLE_DIR="$BUILD_DIR/harbor-bridge-bundle"
    mkdir -p "$BUNDLE_DIR/node_modules"
    
    # Copy the esbuild bundle
    cp build/bundle.cjs "$BUNDLE_DIR/"
    
    # Copy better-sqlite3 and its dependencies
    cp -r node_modules/better-sqlite3 "$BUNDLE_DIR/node_modules/"
    cp -r node_modules/bindings "$BUNDLE_DIR/node_modules/"
    cp -r node_modules/file-uri-to-path "$BUNDLE_DIR/node_modules/"
    
    # Create launcher that uses system Node
    cat > "$BUNDLE_DIR/harbor-bridge" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export NODE_NO_WARNINGS=1
export NODE_PATH="$SCRIPT_DIR/node_modules"
exec node "$SCRIPT_DIR/bundle.cjs" "$@"
EOF
    chmod +x "$BUNDLE_DIR/harbor-bridge"
    
    # Copy to payload
    cp -r "$BUNDLE_DIR"/* "$PAYLOAD_DIR/Library/Application Support/Harbor/"
    
    echo_success "Bridge bundle created"
}

# =============================================================================
# Copy Extensions to Payload
# =============================================================================

copy_extension() {
    echo_step "Copying extensions to payload..."
    
    # Copy Firefox extension
    cp "$BUILD_DIR/harbor.xpi" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
    echo "  ✓ Firefox extension (harbor.xpi)"
    
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
# Universal Binary (both arm64 and x64)
# Note: This requires native modules to be built for both architectures.
# For now, we build for the current architecture only.
# True universal support requires cross-compilation setup.
# =============================================================================

build_universal() {
    echo_warn "Universal binary build is limited - native modules only built for current arch"
    echo "  For true universal support, build on both Intel and Apple Silicon, then combine"
    
    # Set up specific Node version for building
    setup_build_node
    
    cd "$BRIDGE_DIR"
    
    # Build the any-llm-ts submodule if needed
    if [ -d "src/any-llm-ts" ] && [ ! -d "src/any-llm-ts/dist" ]; then
        echo "  Building any-llm-ts submodule..."
        cd src/any-llm-ts
        npm install
        npm run build
        cd ../..
    fi
    
    # Clean and reinstall to ensure native modules match build Node version
    echo "  Installing dependencies with Node $BUNDLED_NODE_FULL..."
    rm -rf node_modules/better-sqlite3 2>/dev/null || true
    npm install
    
    # Rebuild native modules for this Node version
    echo "  Rebuilding native modules for Node $BUNDLED_NODE_FULL..."
    npm rebuild better-sqlite3
    
    # Build TypeScript
    echo "  Compiling TypeScript..."
    npm run build
    
    # Bundle with esbuild
    echo "  Bundling with esbuild..."
    mkdir -p build
    
    npx esbuild dist/main.js \
        --bundle \
        --platform=node \
        --target=node${BUNDLED_NODE_MAJOR} \
        --format=cjs \
        --outfile=build/bundle.cjs \
        --external:better-sqlite3 2>&1 | grep -v "empty-import-meta" || true
    
    # Create pkg.json for the bundle - use EXACT version
    cat > build/pkg.json << EOF
{
  "name": "harbor-bridge",
  "bin": "bundle.cjs",
  "pkg": {
    "assets": [
      "../node_modules/better-sqlite3/build/**/*.node"
    ]
  }
}
EOF
    
    # Build for both architectures
    # NOTE: We do NOT use lipo! pkg binaries have embedded bytecode that lipo corrupts.
    # Instead, we include both binaries and let postinstall choose the right one.
    cd build
    
    # Note: pkg uses major version format (node20) not full version (node20.19.6)
    # IMPORTANT: Pass bundle.cjs directly, not pkg.json - the bin field doesn't work properly
    echo "  Building for arm64 with Node $BUNDLED_NODE_MAJOR..."
    npx @yao-pkg/pkg bundle.cjs \
        --config pkg.json \
        --target "node${BUNDLED_NODE_MAJOR}-macos-arm64" \
        --output "$BUILD_DIR/harbor-bridge-arm64" 2>&1 | grep -v "^> Warning" || true
    
    echo "  Building for x64 with Node $BUNDLED_NODE_MAJOR..."
    npx @yao-pkg/pkg bundle.cjs \
        --config pkg.json \
        --target "node${BUNDLED_NODE_MAJOR}-macos-x64" \
        --output "$BUILD_DIR/harbor-bridge-x64" 2>&1 | grep -v "^> Warning" || true
    
    cd ..
    
    # Copy the native module alongside the binary
    echo "  Copying native modules..."
    mkdir -p "$BUILD_DIR/native"
    
    # Find and copy better-sqlite3 native binding
    NATIVE_BINDING=$(find node_modules/better-sqlite3 -name "*.node" -type f 2>/dev/null | head -1)
    if [ -n "$NATIVE_BINDING" ]; then
        cp "$NATIVE_BINDING" "$BUILD_DIR/native/"
        echo "  Copied: $(basename "$NATIVE_BINDING")"
    fi
    
    # Copy BOTH binaries to payload - postinstall will choose the right one
    echo "  Including both architecture binaries (postinstall will select correct one)..."
    cp "$BUILD_DIR/harbor-bridge-arm64" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
    cp "$BUILD_DIR/harbor-bridge-x64" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
    
    # Copy native modules to payload
    if [ -d "$BUILD_DIR/native" ] && [ "$(ls -A "$BUILD_DIR/native" 2>/dev/null)" ]; then
        cp -r "$BUILD_DIR/native" "$PAYLOAD_DIR/Library/Application Support/Harbor/"
    fi
    
    echo_success "Universal binary created"
}

# =============================================================================
# Main
# =============================================================================

main() {
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  Harbor macOS Installer Builder"
    echo "  Version: $VERSION"
    echo "  Architecture: $ARCH"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    
    # Parse arguments
    # Default to standalone binary with bundled Node
    USE_PKG=true
    BUILD_UNIVERSAL=true    # Universal by default
    # Auto-detect: sign if credentials are available (can be overridden)
    SIGN_EXT=auto
    SIGN_PKG=auto
    NOTARIZE=auto
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --node)
                # Use system Node.js (smaller but requires Node installed)
                USE_PKG=false
                shift
                ;;
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
                echo "  --node            Use system Node.js instead of bundling"
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
    
    # Build Firefox extension
    build_extension
    if [ "$SIGN_EXT" = true ]; then
        sign_extension
    else
        cp "$BUILD_DIR/harbor-unsigned.xpi" "$BUILD_DIR/harbor.xpi"
    fi
    
    # Build Chrome extension
    build_chrome_extension
    
    if [ "$USE_PKG" = true ]; then
        if [ "$BUILD_UNIVERSAL" = true ]; then
            build_universal
        else
            build_bridge
        fi
    else
        build_bridge_node
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
    if [ "$SIGN_EXT" = true ]; then
        echo "    ✓ Extension: Signed with Mozilla Add-ons"
    else
        echo "    ○ Extension: Unsigned (set AMO_JWT_ISSUER/AMO_JWT_SECRET)"
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
