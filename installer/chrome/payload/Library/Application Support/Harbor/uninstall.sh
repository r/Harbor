#!/bin/bash
# Harbor Chrome Uninstaller
# Removes Harbor bridge, extension, and optionally user data

set -e

# Installation paths
HARBOR_DIR="/Library/Application Support/Harbor"
USER_DATA="$HOME/.harbor"
CLI_LINK="/usr/local/bin/harbor-uninstall"

# Native messaging paths for all Chromium browsers
CHROME_MANIFEST="/Library/Application Support/Google/Chrome/NativeMessagingHosts/harbor_bridge_host.json"
CHROMIUM_MANIFEST="/Library/Application Support/Chromium/NativeMessagingHosts/harbor_bridge_host.json"
EDGE_MANIFEST="/Library/Application Support/Microsoft Edge/NativeMessagingHosts/harbor_bridge_host.json"
BRAVE_MANIFEST="/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/harbor_bridge_host.json"
ARC_MANIFEST="/Library/Application Support/Arc/User Data/NativeMessagingHosts/harbor_bridge_host.json"
VIVALDI_MANIFEST="/Library/Application Support/Vivaldi/NativeMessagingHosts/harbor_bridge_host.json"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# Check if running with sudo
check_sudo() {
    if [ "$EUID" -ne 0 ]; then
        echo -e "${YELLOW}This uninstaller requires administrator privileges.${NC}"
        echo ""
        exec sudo "$0" "$@"
    fi
}

# Show what will be removed
show_removal_plan() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  Harbor Chrome Uninstaller${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo "The following will be removed:"
    echo ""
    
    if [ -d "$HARBOR_DIR" ]; then
        echo -e "  ${GREEN}✓${NC} $HARBOR_DIR"
        echo "      (Harbor bridge and extensions)"
    fi
    
    # Check all native messaging manifests
    for MANIFEST in "$CHROME_MANIFEST" "$CHROMIUM_MANIFEST" "$EDGE_MANIFEST" "$BRAVE_MANIFEST" "$ARC_MANIFEST" "$VIVALDI_MANIFEST"; do
        if [ -f "$MANIFEST" ]; then
            echo -e "  ${GREEN}✓${NC} $MANIFEST"
        fi
    done
    
    if [ -L "$CLI_LINK" ] || [ -f "$CLI_LINK" ]; then
        echo -e "  ${GREEN}✓${NC} $CLI_LINK"
        echo "      (CLI uninstaller link)"
    fi
    
    if [ -d "/Applications/Uninstall Harbor.app" ]; then
        echo -e "  ${GREEN}✓${NC} /Applications/Uninstall Harbor.app"
    fi
    
    echo ""
}

# Ask about user data
ask_user_data() {
    if [ -d "$USER_DATA" ]; then
        echo -e "${YELLOW}User data found at: $USER_DATA${NC}"
        echo "This includes your settings, installed servers, and chat history."
        echo ""
        
        # Check if running interactively
        if [ -t 0 ]; then
            read -p "Do you want to remove user data too? (y/N): " -n 1 -r
            echo ""
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                return 0  # Yes, remove
            else
                return 1  # No, keep
            fi
        else
            echo "Running non-interactively, preserving user data."
            return 1
        fi
    fi
    return 1  # No user data exists
}

# Perform uninstallation
do_uninstall() {
    local remove_user_data=$1
    
    echo ""
    echo "Uninstalling Harbor..."
    echo ""
    
    # Remove Harbor directory
    if [ -d "$HARBOR_DIR" ]; then
        echo -n "  Removing Harbor application... "
        rm -rf "$HARBOR_DIR"
        echo -e "${GREEN}done${NC}"
    fi
    
    # Remove all native messaging manifests
    for MANIFEST in "$CHROME_MANIFEST" "$CHROMIUM_MANIFEST" "$EDGE_MANIFEST" "$BRAVE_MANIFEST" "$ARC_MANIFEST" "$VIVALDI_MANIFEST"; do
        if [ -f "$MANIFEST" ]; then
            BROWSER_NAME=$(echo "$MANIFEST" | sed 's/.*Support\/\([^\/]*\).*/\1/')
            echo -n "  Removing $BROWSER_NAME native manifest... "
            rm -f "$MANIFEST"
            echo -e "${GREEN}done${NC}"
        fi
    done
    
    # Also remove user-level manifests
    ACTUAL_USER="${SUDO_USER:-}"
    if [ -z "$ACTUAL_USER" ]; then
        ACTUAL_USER=$(stat -f '%Su' /dev/console 2>/dev/null || echo "")
    fi
    
    if [ -n "$ACTUAL_USER" ] && [ "$ACTUAL_USER" != "root" ]; then
        USER_HOME=$(eval echo "~$ACTUAL_USER")
        
        USER_MANIFESTS=(
            "$USER_HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/harbor_bridge_host.json"
            "$USER_HOME/Library/Application Support/Chromium/NativeMessagingHosts/harbor_bridge_host.json"
            "$USER_HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/harbor_bridge_host.json"
            "$USER_HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/harbor_bridge_host.json"
        )
        
        for MANIFEST in "${USER_MANIFESTS[@]}"; do
            if [ -f "$MANIFEST" ]; then
                rm -f "$MANIFEST"
            fi
        done
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
    
    # Optionally remove user data
    if [ "$remove_user_data" = "1" ] && [ -d "$USER_DATA" ]; then
        echo -n "  Removing user data... "
        rm -rf "$USER_DATA"
        echo -e "${GREEN}done${NC}"
    fi
    
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${GREEN}✓ Harbor has been uninstalled successfully!${NC}"
    echo ""
    echo -e "  ${YELLOW}To complete the removal, remove the extension from Chrome:${NC}"
    echo "  1. Open Chrome"
    echo "  2. Go to chrome://extensions/"
    echo "  3. Find 'Harbor' and click Remove"
    echo ""
    
    if [ -d "$USER_DATA" ]; then
        echo -e "  ${YELLOW}Your user data was preserved at:${NC}"
        echo "  $USER_DATA"
        echo ""
        echo "  To remove it manually:"
        echo "  rm -rf \"$USER_DATA\""
        echo ""
    fi
    
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
}

# Main
main() {
    check_sudo "$@"
    show_removal_plan
    
    # Check if running interactively
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
    do_uninstall 0
    exit 0
fi

# Handle --force-all flag (removes user data too)
if [ "$1" = "--force-all" ]; then
    check_sudo "$@"
    do_uninstall 1
    exit 0
fi

main "$@"
