#!/usr/bin/env bash
# ==============================================================================
# Technology Innovision WhatsApp Enterprise API Gateway - Uninstaller
# ==============================================================================

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${YELLOW}================================================================${NC}"
echo -e "${YELLOW} WhatsApp Enterprise API Gateway - Uninstallation Script        ${NC}"
echo -e "${YELLOW}================================================================${NC}"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
    else
        echo -e "${RED}[ERROR] Root privileges or sudo required to uninstall services.${NC}"
        exit 1
    fi
fi

read -p "Are you sure you want to uninstall WhatsApp Gateway services? (y/N): " confirm
if [[ ! "$confirm" =~ ^[yY]$ ]]; then
    echo "Uninstallation cancelled."
    exit 0
fi

echo -e "${YELLOW}Stopping and disabling background services...${NC}"
$SUDO systemctl stop whatsapp-web.service whatsapp-bridge.service 2>/dev/null || true
$SUDO systemctl disable whatsapp-web.service whatsapp-bridge.service 2>/dev/null || true

echo -e "${YELLOW}Removing systemd service units...${NC}"
$SUDO rm -f /etc/systemd/system/whatsapp-web.service
$SUDO rm -f /etc/systemd/system/whatsapp-bridge.service
$SUDO systemctl daemon-reload

echo -e "${YELLOW}Removing CLI helper tool...${NC}"
$SUDO rm -f /usr/local/bin/whatsapp-ctl

echo -e "${GREEN}✓ WhatsApp Gateway services and CLI uninstalled successfully.${NC}"
echo -e "${YELLOW}Note: Project source code and auth_info/ directory were preserved.${NC}"
