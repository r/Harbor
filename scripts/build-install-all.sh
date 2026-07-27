#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CHROME_MANIFEST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json"

show_usage() {
    echo "Usage: ./scripts/build-install-all.sh [--chrome-extension-id ID] [--firefox-only]"
}

read_existing_chrome_extension_id() {
    local manifest_path="$1"
    local manifest_line

    if [ ! -f "$manifest_path" ]; then
        return
    fi

    while IFS= read -r manifest_line; do
        if [[ "$manifest_line" =~ chrome-extension://([a-p]{32})/ ]]; then
            echo "${BASH_REMATCH[1]}"
            return
        fi
    done < "$manifest_path"
}

CHROME_EXTENSION_ID=""
FIREFOX_ONLY=false

while [ "$#" -gt 0 ]; do
    case "$1" in
        --chrome-extension-id)
            if [ "$#" -lt 2 ] || [ -z "$2" ]; then
                echo "Error: --chrome-extension-id requires a value." >&2
                show_usage >&2
                exit 1
            fi
            CHROME_EXTENSION_ID="$2"
            shift 2
            ;;
        --firefox-only)
            FIREFOX_ONLY=true
            shift
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

if [ -z "$CHROME_EXTENSION_ID" ] && [ "$FIREFOX_ONLY" = false ]; then
    CHROME_EXTENSION_ID="$(read_existing_chrome_extension_id "$CHROME_MANIFEST")"
fi

if [ -z "$CHROME_EXTENSION_ID" ] && [ "$FIREFOX_ONLY" = false ]; then
    echo "Error: Could not determine the Chrome extension ID." >&2
    echo "Pass --chrome-extension-id ID or use --firefox-only." >&2
    exit 1
fi

echo "Building Harbor and Web Agents API extensions for all browsers..."
cd "$PROJECT_ROOT"
npm run build:all

BRIDGE_INSTALL_ARGS=()
if [ "$FIREFOX_ONLY" = true ]; then
    BRIDGE_INSTALL_ARGS+=(--firefox-only)
elif [ -n "$CHROME_EXTENSION_ID" ]; then
    BRIDGE_INSTALL_ARGS+=(--chrome-extension-id "$CHROME_EXTENSION_ID")
fi

echo ""
echo "Building and installing the Harbor native bridge..."
"$PROJECT_ROOT/bridge-rs/install.sh" "${BRIDGE_INSTALL_ARGS[@]}"

echo ""
echo "Build and installation complete."
echo "Reload both Harbor extensions in each browser before testing."
