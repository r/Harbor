#!/bin/bash
# Harbor Complete Uninstaller
# Removes ALL Harbor components from the system:
#   - Chrome installer installation
#   - Firefox installer installation  
#   - Safari app and extensions
#   - Dev installation (bridge-rs/install.sh)
#   - User data and caches
#
# Usage:
#   ./uninstall-all.sh           # Interactive mode
#   ./uninstall-all.sh --force   # Non-interactive, preserves user data
#   ./uninstall-all.sh --force-all  # Non-interactive, removes everything

set -e

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

# Installation paths
HARBOR_DIR="/Library/Application Support/Harbor"
USER_DATA="$HOME/.harbor"
CLI_LINK="/usr/local/bin/harbor-uninstall"

# Safari paths
SAFARI_APP="/Applications/Harbor.app"

# Firefox paths
FIREFOX_NATIVE_MANIFEST="/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge.json"
FIREFOX_NATIVE_MANIFEST_OLD="/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge_host.json"
FIREFOX_POLICIES="/Library/Application Support/Mozilla/policies/policies.json"

# Chrome/Chromium native messaging paths (system-level)
CHROME_MANIFESTS=(
    "/Library/Application Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json"
    "/Library/Application Support/Google/Chrome/NativeMessagingHosts/harbor_bridge_host.json"
    "/Library/Application Support/Chromium/NativeMessagingHosts/harbor_bridge.json"
    "/Library/Application Support/Chromium/NativeMessagingHosts/harbor_bridge_host.json"
    "/Library/Application Support/Microsoft Edge/NativeMessagingHosts/harbor_bridge.json"
    "/Library/Application Support/Microsoft Edge/NativeMessagingHosts/harbor_bridge_host.json"
    "/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/harbor_bridge.json"
    "/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/harbor_bridge_host.json"
    "/Library/Application Support/Arc/User Data/NativeMessagingHosts/harbor_bridge.json"
    "/Library/Application Support/Arc/User Data/NativeMessagingHosts/harbor_bridge_host.json"
    "/Library/Application Support/Vivaldi/NativeMessagingHosts/harbor_bridge.json"
    "/Library/Application Support/Vivaldi/NativeMessagingHosts/harbor_bridge_host.json"
)

# User-level native messaging paths (from dev install)
get_user_manifests() {
    local user_home="$1"
    echo "$user_home/Library/Application Support/Mozilla/NativeMessagingHosts/harbor_bridge.json"
    echo "$user_home/Library/Application Support/Google/Chrome/NativeMessagingHosts/harbor_bridge.json"
    echo "$user_home/Library/Application Support/Chromium/NativeMessagingHosts/harbor_bridge.json"
    echo "$user_home/Library/Application Support/Microsoft Edge/NativeMessagingHosts/harbor_bridge.json"
    echo "$user_home/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/harbor_bridge.json"
}

# Cache and log paths
CACHE_PATHS=(
    "$HOME/Library/Caches/harbor-bridge.log"
    "$HOME/.cache/harbor-bridge.log"
    "$HOME/Library/Application Support/harbor"
    "$HOME/.config/harbor"
)

# Check if running with sudo
check_sudo() {
    if [ "$EUID" -ne 0 ]; then
        echo -e "${YELLOW}This uninstaller requires administrator privileges.${NC}"
        echo ""
        exec sudo "$0" "$@"
    fi
}

# Get the actual user (not root)
get_actual_user() {
    if [ -n "$SUDO_USER" ]; then
        echo "$SUDO_USER"
    else
        stat -f '%Su' /dev/console 2>/dev/null || echo ""
    fi
}

# Show what will be removed
show_removal_plan() {
    local user_home
    ACTUAL_USER=$(get_actual_user)
    if [ -n "$ACTUAL_USER" ] && [ "$ACTUAL_USER" != "root" ]; then
        user_home=$(eval echo "~$ACTUAL_USER")
    else
        user_home="$HOME"
    fi
    
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  Harbor Complete Uninstaller${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "This will remove ALL Harbor installations from your system."
    echo ""
    echo "The following will be removed:"
    echo ""
    
    # Harbor main directory (Chrome/Firefox installer)
    if [ -d "$HARBOR_DIR" ]; then
        echo -e "  ${GREEN}✓${NC} $HARBOR_DIR"
        echo "      (Native bridge, extensions, uninstaller)"
    fi
    
    # Safari app
    if [ -d "$SAFARI_APP" ]; then
        echo -e "  ${GREEN}✓${NC} $SAFARI_APP"
        echo "      (Safari extension app bundle)"
    fi
    
    # Firefox native messaging
    if [ -f "$FIREFOX_NATIVE_MANIFEST" ]; then
        echo -e "  ${GREEN}✓${NC} $FIREFOX_NATIVE_MANIFEST"
    fi
    if [ -f "$FIREFOX_NATIVE_MANIFEST_OLD" ]; then
        echo -e "  ${GREEN}✓${NC} $FIREFOX_NATIVE_MANIFEST_OLD"
    fi
    
    # Firefox policies
    if [ -f "$FIREFOX_POLICIES" ] && grep -q "harbor" "$FIREFOX_POLICIES" 2>/dev/null; then
        echo -e "  ${GREEN}✓${NC} Harbor entries in Firefox policies"
    fi
    
    # Chrome native messaging (system)
    for MANIFEST in "${CHROME_MANIFESTS[@]}"; do
        if [ -f "$MANIFEST" ]; then
            echo -e "  ${GREEN}✓${NC} $MANIFEST"
        fi
    done
    
    # User-level native messaging
    if [ -n "$user_home" ]; then
        while IFS= read -r manifest; do
            if [ -f "$manifest" ]; then
                echo -e "  ${GREEN}✓${NC} $manifest"
            fi
        done < <(get_user_manifests "$user_home")
    fi
    
    # CLI link
    if [ -L "$CLI_LINK" ] || [ -f "$CLI_LINK" ]; then
        echo -e "  ${GREEN}✓${NC} $CLI_LINK"
    fi
    
    # Uninstaller app
    if [ -d "/Applications/Uninstall Harbor.app" ]; then
        echo -e "  ${GREEN}✓${NC} /Applications/Uninstall Harbor.app"
    fi
    
    # Caches
    for cache in "${CACHE_PATHS[@]}"; do
        # Expand user home
        expanded_cache="${cache/#\$HOME/$user_home}"
        if [ -e "$expanded_cache" ]; then
            echo -e "  ${GREEN}✓${NC} $expanded_cache (cache/config)"
        fi
    done
    
    echo ""
}

# Perform uninstallation
do_uninstall() {
    local remove_user_data=$1
    
    local user_home
    ACTUAL_USER=$(get_actual_user)
    if [ -n "$ACTUAL_USER" ] && [ "$ACTUAL_USER" != "root" ]; then
        user_home=$(eval echo "~$ACTUAL_USER")
    else
        user_home="$HOME"
    fi
    
    echo ""
    echo "Uninstalling Harbor..."
    echo ""
    
    # Remove Harbor main directory (from packaged installers)
    if [ -d "$HARBOR_DIR" ]; then
        echo -n "  Removing Harbor application... "
        rm -rf "$HARBOR_DIR"
        echo -e "${GREEN}done${NC}"
    fi
    
    # Remove Safari app
    if [ -d "$SAFARI_APP" ]; then
        echo -n "  Removing Safari app... "
        rm -rf "$SAFARI_APP"
        echo -e "${GREEN}done${NC}"
    fi
    
    # Remove Firefox native messaging
    if [ -f "$FIREFOX_NATIVE_MANIFEST" ]; then
        echo -n "  Removing Firefox native manifest... "
        rm -f "$FIREFOX_NATIVE_MANIFEST"
        echo -e "${GREEN}done${NC}"
    fi
    if [ -f "$FIREFOX_NATIVE_MANIFEST_OLD" ]; then
        echo -n "  Removing old Firefox native manifest... "
        rm -f "$FIREFOX_NATIVE_MANIFEST_OLD"
        echo -e "${GREEN}done${NC}"
    fi
    
    # Clean Firefox policies
    if [ -f "$FIREFOX_POLICIES" ] && grep -q "harbor" "$FIREFOX_POLICIES" 2>/dev/null; then
        echo -n "  Cleaning Firefox policies... "
        # Check if this is a Harbor-only policy file
        if grep -q '"Extensions"' "$FIREFOX_POLICIES" && ! grep -v "harbor" "$FIREFOX_POLICIES" | grep -q '"Install"'; then
            rm -f "$FIREFOX_POLICIES"
        fi
        echo -e "${GREEN}done${NC}"
    fi
    
    # Remove Chrome/Chromium native messaging (system level)
    for MANIFEST in "${CHROME_MANIFESTS[@]}"; do
        if [ -f "$MANIFEST" ]; then
            BROWSER_NAME=$(echo "$MANIFEST" | sed 's/.*Support\/\([^\/]*\).*/\1/')
            echo -n "  Removing $BROWSER_NAME system manifest... "
            rm -f "$MANIFEST"
            echo -e "${GREEN}done${NC}"
        fi
    done
    
    # Remove user-level native messaging (from dev install)
    if [ -n "$user_home" ]; then
        while IFS= read -r manifest; do
            if [ -f "$manifest" ]; then
                BROWSER_NAME=$(echo "$manifest" | sed 's/.*Support\/\([^\/]*\).*/\1/')
                echo -n "  Removing $BROWSER_NAME user manifest... "
                rm -f "$manifest"
                echo -e "${GREEN}done${NC}"
            fi
        done < <(get_user_manifests "$user_home")
    fi
    
    # Remove CLI link
    if [ -L "$CLI_LINK" ] || [ -f "$CLI_LINK" ]; then
        echo -n "  Removing CLI uninstaller... "
        rm -f "$CLI_LINK"
        echo -e "${GREEN}done${NC}"
    fi
    
    # Remove uninstaller app
    if [ -d "/Applications/Uninstall Harbor.app" ]; then
        echo -n "  Removing uninstaller app... "
        rm -rf "/Applications/Uninstall Harbor.app"
        echo -e "${GREEN}done${NC}"
    fi
    
    # Remove caches and config
    for cache in "${CACHE_PATHS[@]}"; do
        expanded_cache="${cache/#\$HOME/$user_home}"
        if [ -e "$expanded_cache" ]; then
            echo -n "  Removing cache/config: $expanded_cache... "
            rm -rf "$expanded_cache"
            echo -e "${GREEN}done${NC}"
        fi
    done
    
    # Optionally remove user data
    local user_data_path="${USER_DATA/#\$HOME/$user_home}"
    if [ "$remove_user_data" = "1" ]; then
        if [ -d "$user_data_path" ]; then
            echo -n "  Removing user data... "
            rm -rf "$user_data_path"
            echo -e "${GREEN}done${NC}"
        fi
    fi
    
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${GREEN}✓ Harbor has been completely uninstalled!${NC}"
    echo ""
    
    # Manual steps reminder
    echo -e "  ${YELLOW}Manual steps to complete removal:${NC}"
    echo ""
    echo "  Chrome/Chromium browsers:"
    echo "    1. Go to chrome://extensions/"
    echo "    2. Remove the 'Harbor' extension"
    echo ""
    echo "  Firefox:"
    echo "    1. Go to about:addons"
    echo "    2. Remove the 'Harbor' extension"
    echo ""
    echo "  Safari:"
    echo "    Extensions are removed with the app."
    echo "    If needed: Safari → Settings → Extensions → Uncheck Harbor"
    echo ""
    echo -e "  ${YELLOW}If you still have the old separate 'Web Agents API' add-on${NC}"
    echo "  installed (Harbor now serves that API itself), remove it the"
    echo "  same way: chrome://extensions/ or about:addons."
    echo ""
    
    if [ -d "$user_data_path" ]; then
        echo -e "  ${YELLOW}Your user data was preserved at:${NC}"
        echo "    $user_data_path"
        echo ""
        echo "  To remove it manually:"
        echo "    rm -rf \"$user_data_path\""
        echo ""
    fi
    
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
}

# Ask about user data
ask_user_data() {
    local user_home
    ACTUAL_USER=$(get_actual_user)
    if [ -n "$ACTUAL_USER" ] && [ "$ACTUAL_USER" != "root" ]; then
        user_home=$(eval echo "~$ACTUAL_USER")
    else
        user_home="$HOME"
    fi
    
    local user_data_path="${USER_DATA/#\$HOME/$user_home}"
    
    if [ -d "$user_data_path" ]; then
        echo -e "${YELLOW}User data found at: $user_data_path${NC}"
        echo "This includes your settings, installed MCP servers, and chat history."
        echo ""
        
        if [ -t 0 ]; then
            read -p "Do you want to remove user data too? (y/N): " -n 1 -r
            echo ""
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                return 0
            else
                return 1
            fi
        else
            echo "Running non-interactively, preserving user data."
            return 1
        fi
    fi
    return 1
}

# Main
main() {
    check_sudo "$@"
    show_removal_plan
    
    if [ -t 0 ]; then
        read -p "Do you want to continue? (y/N): " -n 1 -r
        echo ""
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            echo "Uninstall cancelled."
            exit 0
        fi
    fi
    
    REMOVE_USER_DATA=0
    if ask_user_data; then
        REMOVE_USER_DATA=1
    fi
    
    do_uninstall $REMOVE_USER_DATA
}

# Handle --force flag for non-interactive uninstall
if [ "$1" = "--force" ]; then
    check_sudo "$@"
    show_removal_plan
    do_uninstall 0
    exit 0
fi

# Handle --force-all flag (removes user data too)
if [ "$1" = "--force-all" ]; then
    check_sudo "$@"
    show_removal_plan
    do_uninstall 1
    exit 0
fi

# Handle --help
if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
    echo "Harbor Complete Uninstaller"
    echo ""
    echo "Removes ALL Harbor components from your system:"
    echo "  - Chrome installer installation"
    echo "  - Firefox installer installation"
    echo "  - Safari app and extensions"
    echo "  - Dev installation (bridge-rs/install.sh)"
    echo "  - Caches and logs"
    echo ""
    echo "Usage:"
    echo "  $0              Interactive mode (asks for confirmation)"
    echo "  $0 --force      Non-interactive, preserves user data (~/.harbor)"
    echo "  $0 --force-all  Non-interactive, removes everything including user data"
    echo "  $0 --help       Show this help"
    echo ""
    exit 0
fi

main "$@"
