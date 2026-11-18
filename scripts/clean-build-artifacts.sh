#!/bin/bash
# Clean all build artifacts from the Harbor repository
# Run this before building fresh installers

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "═══════════════════════════════════════════════════════════════"
echo "  Harbor Build Artifact Cleaner"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# Installer build directories
echo "Cleaning installer build artifacts..."

rm -rf "$PROJECT_ROOT/installer/chrome/build"
rm -rf "$PROJECT_ROOT/installer/chrome/payload"
echo "  ✓ Chrome installer build/"

rm -rf "$PROJECT_ROOT/installer/firefox/build"
rm -rf "$PROJECT_ROOT/installer/firefox/payload"
echo "  ✓ Firefox installer build/"

rm -rf "$PROJECT_ROOT/installer/safari/build"
echo "  ✓ Safari installer build/"

# Extension build directories
echo ""
echo "Cleaning extension build artifacts..."

rm -rf "$PROJECT_ROOT/extension/dist"
rm -rf "$PROJECT_ROOT/extension/dist-chrome"
rm -rf "$PROJECT_ROOT/extension/dist-firefox"
rm -rf "$PROJECT_ROOT/extension/dist-safari"
rm -rf "$PROJECT_ROOT/extension/bundled"
echo "  ✓ Harbor extension dist/"

# Rust build directory (optional - takes time to rebuild)
if [ "$1" = "--all" ] || [ "$1" = "--rust" ]; then
    echo ""
    echo "Cleaning Rust build artifacts..."
    rm -rf "$PROJECT_ROOT/bridge-rs/target"
    echo "  ✓ bridge-rs/target/"
fi

# Node modules (optional - takes time to reinstall)
if [ "$1" = "--all" ] || [ "$1" = "--node" ]; then
    echo ""
    echo "Cleaning node_modules..."
    rm -rf "$PROJECT_ROOT/extension/node_modules"
    rm -rf "$PROJECT_ROOT/demo/node_modules"
    echo "  ✓ node_modules/"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  ✓ Clean complete!"
echo ""
echo "Options:"
echo "  --rust   Also clean Rust target/ directory"
echo "  --node   Also clean node_modules/"
echo "  --all    Clean everything (Rust + node_modules)"
echo "═══════════════════════════════════════════════════════════════"
