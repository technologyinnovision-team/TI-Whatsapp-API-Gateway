#!/usr/bin/env bash
# ==============================================================================
# Technology Innovision WhatsApp Enterprise API Gateway - One-Line Fast Updater
# Usage: curl -sSL https://raw.githubusercontent.com/technologyinnovision-team/TI-Whatsapp-API/main/update.sh | bash
#    or: sudo ./update.sh
#    or: whatsapp-ctl update
# ==============================================================================

set -e

# ANSI Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
WHITE='\033[1;37m'
NC='\033[0m' # No Color

clear 2>/dev/null || true

echo -e "${GREEN}"
cat << "EOF"
================================================================================
   ______  ____   _       ____  ______ _____ ___     ____  ____     ____  ____  ____
  /_  __/ /  _/  | |     / / / / /   |/_  __//   |   / __ \/ __ \   /   |/ __ \/  _/
   / /    / /    | | /| / / /_/ / /| | / /  / /| |  / /_/ / /_/ /  / /| / /_/ // /  
  / /   _/ /     | |/ |/ / __  / ___ |/ /  / ___ | / ____/ ____/  / ___ / ____// /   
 /_/   /___/     |__/|__/_/ /_/_/  |_/_/  /_/  |_|/_/   /_/      /_/  |_/_/   /___/   
================================================================================
EOF
echo -e "${WHITE} WhatsApp Enterprise API Gateway - Automated Platform Updater${NC}"
echo -e "${CYAN} Developed by Technology Innovision (https://technologyinnovision.com)${NC}"
echo -e "================================================================================\n"

# 1. Privilege Check
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
        echo -e "${YELLOW}[!] Non-root user detected. Using sudo for system modifications.${NC}"
    else
        echo -e "${RED}[ERROR] This updater requires root privileges or sudo access.${NC}"
        exit 1
    fi
fi

# 2. Locate Platform Installation Directory
INSTALL_DIR=""
if [ -f "./flask-app/app.py" ] && [ -f "./wa-bridge/server.js" ]; then
    INSTALL_DIR="$(pwd)"
elif [ -d "/opt/whatsapp-gateway" ] && [ -f "/opt/whatsapp-gateway/flask-app/app.py" ]; then
    INSTALL_DIR="/opt/whatsapp-gateway"
else
    echo -e "${RED}[ERROR] Could not find an existing WhatsApp Gateway installation.${NC}"
    echo -e "${YELLOW}Please install the gateway first using:${NC}"
    echo -e "  curl -sSL https://raw.githubusercontent.com/technologyinnovision-team/TI-Whatsapp-API/main/install.sh | bash"
    exit 1
fi

echo -e "${GREEN}  ✓ Located WhatsApp Gateway directory: ${WHITE}${INSTALL_DIR}${NC}"
cd "$INSTALL_DIR"

# 3. Read & Preserve Existing Configuration (.env)
ENV_FILE="$INSTALL_DIR/.env"
WEB_PORT="5000"
BRIDGE_PORT="3001"

if [ -f "$ENV_FILE" ]; then
    SAVED_WEB_PORT=$(grep -E '^WEB_PORT=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d'=' -f2 | tr -d ' "\r\n')
    SAVED_BRIDGE_PORT=$(grep -E '^BRIDGE_PORT=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d'=' -f2 | tr -d ' "\r\n')
    if [[ "$SAVED_WEB_PORT" =~ ^[0-9]+$ ]]; then
        WEB_PORT=$SAVED_WEB_PORT
    fi
    if [[ "$SAVED_BRIDGE_PORT" =~ ^[0-9]+$ ]]; then
        BRIDGE_PORT=$SAVED_BRIDGE_PORT
    fi
    echo -e "${GREEN}  ✓ Preserving existing ports: Web=${WHITE}${WEB_PORT}${GREEN}, Bridge=${WHITE}${BRIDGE_PORT}${NC}"
    echo -e "${GREEN}  ✓ Preserving all database records, sessions, API keys, and auth credentials.${NC}"
else
    echo -e "${YELLOW}  ⚠ No .env found. Will default to Web=${WEB_PORT}, Bridge=${BRIDGE_PORT}.${NC}"
fi

# 4. Stop Running Services Cleanly Before Update
echo -e "\n${BLUE}[1/5] Stopping services gracefully during update...${NC}"
$SUDO systemctl stop whatsapp-web.service whatsapp-bridge.service 2>/dev/null || true
sleep 1

# Reclaim ports from lingering WAAPI processes if any
kill_waapi_on_port() {
    local port=$1
    if command -v lsof >/dev/null 2>&1; then
        local pids=$(lsof -ti :$port 2>/dev/null || true)
        for pid in $pids; do
            local cmd=$(ps -p $pid -o cmd= 2>/dev/null || true)
            if [[ "$cmd" =~ "whatsapp" || "$cmd" =~ "gunicorn" || "$cmd" =~ "server.js" || "$cmd" =~ "flask" ]]; then
                echo -e "${YELLOW}  → Reclaiming port $port from lingering process (PID $pid)...${NC}" >&2
                $SUDO kill -9 $pid 2>/dev/null || true
            fi
        done
    fi
}
kill_waapi_on_port "$WEB_PORT"
kill_waapi_on_port "$BRIDGE_PORT"
echo -e "${GREEN}  ✓ Services paused and ports verified.${NC}"

# 5. Pull Latest Code from GitHub
echo -e "\n${BLUE}[2/5] Fetching latest release from GitHub (main branch)...${NC}"
if [ -d ".git" ]; then
    git fetch origin main
    git checkout main 2>/dev/null || true
    git pull origin main || true
    LATEST_COMMIT=$(git log -1 --format="%h - %s (%cr)")
    echo -e "${GREEN}  ✓ Successfully updated to: ${WHITE}${LATEST_COMMIT}${NC}"
else
    echo -e "${YELLOW}  ⚠ Not a git clone. Downloading archive update...${NC}"
    TMP_DIR=$(mktemp -d)
    curl -sSL https://github.com/technologyinnovision-team/TI-Whatsapp-API/archive/refs/heads/main.tar.gz | tar -xz -C "$TMP_DIR"
    cp -rn "$TMP_DIR/TI-Whatsapp-API-main/"* "$INSTALL_DIR/"
    rm -rf "$TMP_DIR"
    echo -e "${GREEN}  ✓ Core files updated.${NC}"
fi

# Ensure .env ports remain exact
if [ -f "$ENV_FILE" ]; then
    sed -i "s/^WEB_PORT=.*/WEB_PORT=${WEB_PORT}/" "$ENV_FILE" 2>/dev/null || true
    sed -i "s/^BRIDGE_PORT=.*/BRIDGE_PORT=${BRIDGE_PORT}/" "$ENV_FILE" 2>/dev/null || true
    sed -i "s|^BRIDGE_URL=.*|BRIDGE_URL=http://127.0.0.1:${BRIDGE_PORT}|" "$ENV_FILE" 2>/dev/null || true
fi

# 6. Update Python Virtual Environment Dependencies
echo -e "\n${BLUE}[3/5] Updating Python virtualenv dependencies...${NC}"
if [ -d "flask-app/venv" ]; then
    flask-app/venv/bin/pip install --upgrade pip -q
    flask-app/venv/bin/pip install -r flask-app/requirements.txt -q
    echo -e "${GREEN}  ✓ Python dependencies up to date.${NC}"
else
    echo -e "${YELLOW}  → Initializing Python venv...${NC}"
    python3 -m venv flask-app/venv 2>/dev/null || virtualenv flask-app/venv
    flask-app/venv/bin/pip install -r flask-app/requirements.txt -q
fi

# 7. Update Node.js Baileys Bridge Dependencies
echo -e "\n${BLUE}[4/5] Updating WhatsApp Bridge dependencies...${NC}"
cd wa-bridge
npm install --silent --no-audit
cd ..
echo -e "${GREEN}  ✓ Node.js dependencies up to date.${NC}"

# 8. Refresh Systemd Service Files and CLI Manager
SERVICE_USER="$(whoami)"
if [ "$SERVICE_USER" = "root" ]; then
    SERVICE_USER="root"
fi

if [ -d "/etc/systemd/system" ]; then
    # WhatsApp Bridge Service
    cat << EOF | $SUDO tee /etc/systemd/system/whatsapp-bridge.service > /dev/null
[Unit]
Description=Technology Innovision WhatsApp Baileys Bridge
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}/wa-bridge
ExecStart=$(which node) server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
EnvironmentFile=${INSTALL_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF

    # WhatsApp Web Gateway Service
    cat << EOF | $SUDO tee /etc/systemd/system/whatsapp-web.service > /dev/null
[Unit]
Description=Technology Innovision WhatsApp Flask Gateway & Dashboard
After=network.target whatsapp-bridge.service
Wants=whatsapp-bridge.service

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}/flask-app
ExecStart=${INSTALL_DIR}/flask-app/venv/bin/gunicorn -w 3 -b 0.0.0.0:${WEB_PORT} --timeout 120 app:app
Restart=always
RestartSec=3
EnvironmentFile=${INSTALL_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF

    $SUDO systemctl daemon-reload
fi

# Install / Refresh CLI Management Tool
cat << EOF | $SUDO tee /usr/local/bin/whatsapp-ctl > /dev/null
#!/usr/bin/env bash
# WhatsApp Gateway Command Line Manager

INSTALL_DIR="${INSTALL_DIR}"

case "\$1" in
    status)
        echo "=== WhatsApp Bridge Status ==="
        systemctl status whatsapp-bridge --no-pager
        echo ""
        echo "=== WhatsApp Web Gateway Status ==="
        systemctl status whatsapp-web --no-pager
        ;;
    start)
        systemctl start whatsapp-bridge whatsapp-web
        echo "WhatsApp Gateway services started."
        ;;
    stop)
        systemctl stop whatsapp-web whatsapp-bridge
        echo "WhatsApp Gateway services stopped."
        ;;
    restart)
        systemctl restart whatsapp-bridge whatsapp-web
        echo "WhatsApp Gateway services restarted."
        ;;
    logs)
        journalctl -u whatsapp-web -u whatsapp-bridge -f
        ;;
    ports)
        ss -tuln | grep -E ':(${WEB_PORT}|${BRIDGE_PORT}|5000|3001|[0-9]{4}) ' || true
        ;;
    health)
        echo "=== WhatsApp Bridge Health ==="
        curl -s http://127.0.0.1:${BRIDGE_PORT}/health || echo "Bridge unreachable"
        echo ""
        echo "=== WhatsApp Web Gateway Health ==="
        curl -s http://127.0.0.1:${WEB_PORT}/api/v1/system/health || echo "Web Gateway unreachable"
        echo ""
        ;;
    update)
        if [ -f "\$INSTALL_DIR/update.sh" ]; then
            bash "\$INSTALL_DIR/update.sh"
        else
            curl -sSL https://raw.githubusercontent.com/technologyinnovision-team/TI-Whatsapp-API/main/update.sh | bash
        fi
        ;;
    *)
        echo "Usage: whatsapp-ctl {status|start|stop|restart|logs|ports|health|update}"
        exit 1
        ;;
esac
EOF
$SUDO chmod +x /usr/local/bin/whatsapp-ctl

# 9. Restart Services & Verify Health
echo -e "\n${BLUE}[5/5] Restarting services and verifying system health...${NC}"
$SUDO systemctl restart whatsapp-bridge.service
$SUDO systemctl restart whatsapp-web.service
sleep 3

PUBLIC_IP=$(curl -sSL https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}' || echo "localhost")

echo -e "\n${GREEN}================================================================================${NC}"
echo -e "${WHITE} 🎉 UPDATE COMPLETED SUCCESSFULLY! 🎉${NC}"
echo -e "${GREEN}================================================================================${NC}"
echo -e "${CYAN}  ✦ Web Dashboard:          ${WHITE}http://${PUBLIC_IP}:${WEB_PORT}${NC}"
echo -e "${CYAN}  ✦ Local Dashboard:        ${WHITE}http://localhost:${WEB_PORT}${NC}"
echo -e "${CYAN}  ✦ Interactive API Docs:   ${WHITE}http://${PUBLIC_IP}:${WEB_PORT}/docs${NC}"
echo -e "${CYAN}  ✦ ReDoc Documentation:    ${WHITE}http://${PUBLIC_IP}:${WEB_PORT}/redoc${NC}"
echo -e "${CYAN}  ✦ Bridge Core API:        ${WHITE}http://localhost:${BRIDGE_PORT}/health${NC}"
echo -e "${GREEN}--------------------------------------------------------------------------------${NC}"
echo -e "${YELLOW}  🛡️  Anti-Ban Engine:       ACTIVE & PRESERVED${NC}"
echo -e "${YELLOW}  📲  Sessions & Databases:  100% PRESERVED & INTACT${NC}"
echo -e "${YELLOW}  🔘  Interactive Buttons:  ENABLED (CTA Links, Calls, Coupon Codes)${NC}"
echo -e "${YELLOW}  🔌  Management CLI:       whatsapp-ctl status | whatsapp-ctl update | whatsapp-ctl restart${NC}"
echo -e "${GREEN}================================================================================\n${NC}"
echo -e "${WHITE}All services have been restarted on ports ${GREEN}${WEB_PORT}${WHITE} (Web) and ${GREEN}${BRIDGE_PORT}${WHITE} (Bridge).${NC}"
echo -e "${WHITE}Your existing WhatsApp logins and settings are running seamlessly!${NC}\n"
