#!/usr/bin/env bash
# ==============================================================================
# Technology Innovision WhatsApp Enterprise API Gateway - One-Line Installer
# Supports: Ubuntu, Debian, CentOS, AlmaLinux, Rocky, Fedora, Arch, Alpine
# Usage: curl -sSL https://raw.githubusercontent.com/technologyinnovision-team/TI-Whatsapp-API/main/install.sh | bash
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
echo -e "${WHITE} Enterprise Multi-Tenant WhatsApp API Gateway with Anti-Ban Protection Engine${NC}"
echo -e "${CYAN} Developed by Technology Innovision (https://technologyinnovision.com)${NC}"
echo -e "================================================================================\n"

# 1. Privilege Check
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
        SUDO="sudo"
        echo -e "${YELLOW}[!] Non-root user detected. Using sudo for system modifications.${NC}"
    else
        echo -e "${RED}[ERROR] This installer requires root privileges or sudo access. Please run as root or install sudo.${NC}"
        exit 1
    fi
fi

# 2. Distro Detection
echo -e "${BLUE}[1/7] Detecting Linux Distribution & Hardware...${NC}"
OS="unknown"
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$ID
elif [ -f /etc/debian_version ]; then
    OS="debian"
elif [ -f /etc/redhat-release ]; then
    OS="rhel"
fi
echo -e "${GREEN}  ✓ Detected OS: ${OS} (${PRETTY_NAME:-Linux}) on $(uname -m)${NC}"

# 3. Port Conflict Detection & Resolution
echo -e "${BLUE}[2/7] Checking Port Management & Allocations...${NC}"

is_port_busy() {
    local port=$1
    if command -v lsof >/dev/null 2>&1; then
        lsof -i :$port >/dev/null 2>&1
    elif command -v ss >/dev/null 2>&1; then
        ss -tuln | grep -q ":$port "
    elif command -v netstat >/dev/null 2>&1; then
        netstat -tuln | grep -q ":$port "
    else
        # Fallback to bash tcp connection probe
        (echo >/dev/tcp/127.0.0.1/$port) >/dev/null 2>&1
    fi
}

find_free_port() {
    local candidate=$1
    while is_port_busy $candidate; do
        echo -e "${YELLOW}  ⚠ Port $candidate is in use, checking next port...${NC}"
        candidate=$((candidate + 1))
    done
    echo $candidate
}

DEFAULT_WEB_PORT=5000
DEFAULT_BRIDGE_PORT=3001

TARGET_WEB_PORT=$(find_free_port $DEFAULT_WEB_PORT)
TARGET_BRIDGE_PORT=$(find_free_port $DEFAULT_BRIDGE_PORT)

# Ensure ports don't collide with each other
if [ "$TARGET_WEB_PORT" -eq "$TARGET_BRIDGE_PORT" ]; then
    TARGET_BRIDGE_PORT=$(find_free_port $((TARGET_WEB_PORT + 1)))
fi

echo -e "${GREEN}  ✓ Web Gateway Assigned Port: ${WHITE}${TARGET_WEB_PORT}${NC}"
echo -e "${GREEN}  ✓ WhatsApp Bridge Assigned Port: ${WHITE}${TARGET_BRIDGE_PORT}${NC}"

# 4. Dependency Installation
echo -e "${BLUE}[3/7] Installing System Dependencies (Node.js 20+, Python 3, Build Tools)...${NC}"

case "$OS" in
    ubuntu|debian|raspbian)
        $SUDO apt-get update -y -q
        $SUDO apt-get install -y -q curl git python3 python3-pip python3-venv build-essential lsof
        # Install Node.js 20.x if not present or < 20
        NODE_VER=$(node -v 2>/dev/null | cut -d'.' -f1 | tr -d 'v' || echo "0")
        if [ "$NODE_VER" -lt 20 ]; then
            echo -e "${CYAN}  → Installing Node.js 20 LTS repository...${NC}"
            curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash -
            $SUDO apt-get install -y -q nodejs
        fi
        ;;
    centos|rhel|almalinux|rocky)
        $SUDO yum install -y -q epel-release || true
        $SUDO yum install -y -q curl git python3 python3-pip gcc-c++ make lsof
        NODE_VER=$(node -v 2>/dev/null | cut -d'.' -f1 | tr -d 'v' || echo "0")
        if [ "$NODE_VER" -lt 20 ]; then
            curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
            $SUDO yum install -y -q nodejs
        fi
        ;;
    fedora)
        $SUDO dnf install -y -q curl git python3 python3-pip gcc-c++ make lsof nodejs
        ;;
    arch|manjaro)
        $SUDO pacman -Sy --noconfirm git curl python python-pip nodejs npm base-devel lsof
        ;;
    alpine)
        $SUDO apk add --no-cache git curl python3 py3-pip nodejs npm build-base lsof
        ;;
    *)
        echo -e "${YELLOW}  ⚠ Unrecognized distro. Ensure Python 3.10+, pip, and Node.js 20+ are installed.${NC}"
        ;;
esac

echo -e "${GREEN}  ✓ Node.js version: $(node -v)${NC}"
echo -e "${GREEN}  ✓ NPM version: $(npm -v)${NC}"
echo -e "${GREEN}  ✓ Python version: $(python3 --version)${NC}"

# 5. Project Directory & Source Code
echo -e "${BLUE}[4/7] Configuring Platform Directory & Environment...${NC}"

INSTALL_DIR="$(pwd)"
# If install.sh was run via curl outside of the repo, clone or setup
if [ ! -f "$INSTALL_DIR/flask-app/app.py" ]; then
    INSTALL_DIR="/opt/whatsapp-gateway"
    echo -e "${CYAN}  → Cloning repository to $INSTALL_DIR...${NC}"
    $SUDO mkdir -p "$INSTALL_DIR"
    $SUDO chown -R "$(id -u):$(id -g)" "$INSTALL_DIR" 2>/dev/null || true
    if [ -d "$INSTALL_DIR/.git" ]; then
        cd "$INSTALL_DIR"
        git pull origin main || true
    else
        git clone https://github.com/technologyinnovision-team/TI-Whatsapp-API.git "$INSTALL_DIR"
        cd "$INSTALL_DIR"
    fi
else
    cd "$INSTALL_DIR"
fi

# Setup .env
if [ ! -f ".env" ]; then
    echo -e "${CYAN}  → Generating cryptographically secure .env configuration...${NC}"
    SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))" 2>/dev/null || openssl rand -hex 32)
    WEBHOOK_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(20))" 2>/dev/null || openssl rand -hex 20)

    cat << EOF > .env
# ==============================================================================
# TECHNOLOGY INNOVISION WHATSAPP API GATEWAY CONFIGURATION
# ==============================================================================

WEB_PORT=${TARGET_WEB_PORT}
BRIDGE_PORT=${TARGET_BRIDGE_PORT}
BRIDGE_URL=http://127.0.0.1:${TARGET_BRIDGE_PORT}

SECRET_KEY=${SECRET_KEY}
WEBHOOK_SECRET=${WEBHOOK_SECRET}

# Database: SQLite for zero-config out-of-the-box run
DATABASE_URL=sqlite:///whatsapp_gateway.db

DEFAULT_MIN_DELAY_MS=4000
DEFAULT_MAX_DELAY_MS=9000
DEFAULT_DAILY_QUOTA=300
DEFAULT_MODE=standard

GLOBAL_WEBHOOK_URL=
EOF
else
    # Update ports in existing .env if needed
    sed -i "s/^WEB_PORT=.*/WEB_PORT=${TARGET_WEB_PORT}/" .env 2>/dev/null || true
    sed -i "s/^BRIDGE_PORT=.*/BRIDGE_PORT=${TARGET_BRIDGE_PORT}/" .env 2>/dev/null || true
    sed -i "s|^BRIDGE_URL=.*|BRIDGE_URL=http://127.0.0.1:${TARGET_BRIDGE_PORT}|" .env 2>/dev/null || true
fi

# Ensure auth_info directory exists with proper permissions
mkdir -p wa-bridge/auth_info
chmod -R 755 wa-bridge/auth_info

# 6. Build & Dependency Setup
echo -e "${BLUE}[5/7] Building Python Virtual Environment & Node.js Bridge...${NC}"

# Setup Python venv
if [ ! -d "flask-app/venv" ]; then
    python3 -m venv flask-app/venv 2>/dev/null || python3 -m virtualenv flask-app/venv 2>/dev/null || {
        # Fallback if venv package is quirky
        python3 -m pip install --user --break-system-packages virtualenv 2>/dev/null || true
        ~/.local/bin/virtualenv flask-app/venv
    }
fi

flask-app/venv/bin/pip install --upgrade pip -q
flask-app/venv/bin/pip install -r flask-app/requirements.txt -q
echo -e "${GREEN}  ✓ Python virtualenv and requirements installed successfully.${NC}"

# Setup Node.js Bridge dependencies
cd wa-bridge
npm install --silent --no-audit
cd ..
echo -e "${GREEN}  ✓ WhatsApp Bridge dependencies installed successfully.${NC}"

# 7. Systemd Services & CLI Helper Setup
echo -e "${BLUE}[6/7] Installing Systemd Services & CLI Tool...${NC}"

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
ExecStart=${INSTALL_DIR}/flask-app/venv/bin/gunicorn -w 3 -b 0.0.0.0:${TARGET_WEB_PORT} --timeout 120 app:app
Restart=always
RestartSec=3
EnvironmentFile=${INSTALL_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF

    $SUDO systemctl daemon-reload
    $SUDO systemctl enable whatsapp-bridge.service >/dev/null 2>&1 || true
    $SUDO systemctl enable whatsapp-web.service >/dev/null 2>&1 || true
    $SUDO systemctl restart whatsapp-bridge.service
    $SUDO systemctl restart whatsapp-web.service
    echo -e "${GREEN}  ✓ Systemd background services enabled and started.${NC}"
fi

# Install CLI Management Tool: whatsapp-ctl
cat << 'EOF' | $SUDO tee /usr/local/bin/whatsapp-ctl > /dev/null
#!/usr/bin/env bash
# WhatsApp Gateway Command Line Manager

case "$1" in
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
        ss -tuln | grep -E ':(5000|3001|[0-9]{4}) '
        ;;
    *)
        echo "Usage: whatsapp-ctl {status|start|stop|restart|logs|ports}"
        exit 1
        ;;
esac
EOF

$SUDO chmod +x /usr/local/bin/whatsapp-ctl
echo -e "${GREEN}  ✓ Global CLI tool installed: whatsapp-ctl${NC}"

# 8. Service Health Check & Verification
echo -e "${BLUE}[7/7] Verifying System Health & Readiness...${NC}"
sleep 3

PUBLIC_IP=$(curl -sSL https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}' || echo "localhost")

echo -e "\n${GREEN}================================================================================${NC}"
echo -e "${WHITE} 🎉 INSTALLATION COMPLETED SUCCESSFULLY! 🎉${NC}"
echo -e "${GREEN}================================================================================${NC}"
echo -e "${CYAN}  ✦ Web Dashboard:          ${WHITE}http://${PUBLIC_IP}:${TARGET_WEB_PORT}${NC}"
echo -e "${CYAN}  ✦ Local Dashboard:        ${WHITE}http://localhost:${TARGET_WEB_PORT}${NC}"
echo -e "${CYAN}  ✦ Interactive API Docs:   ${WHITE}http://${PUBLIC_IP}:${TARGET_WEB_PORT}/docs${NC}"
echo -e "${CYAN}  ✦ ReDoc Documentation:    ${WHITE}http://${PUBLIC_IP}:${TARGET_WEB_PORT}/redoc${NC}"
echo -e "${CYAN}  ✦ Bridge Core API:        ${WHITE}http://localhost:${TARGET_BRIDGE_PORT}/health${NC}"
echo -e "${GREEN}--------------------------------------------------------------------------------${NC}"
echo -e "${YELLOW}  🛡️  Anti-Ban Engine:       ENABLED (Queue + Human Typing Jitter + Spintax)${NC}"
echo -e "${YELLOW}  📲  Pairing Options:       QR Code Scanning + 8-Digit Phone Pairing Code${NC}"
echo -e "${YELLOW}  🔌  Management CLI:       whatsapp-ctl status | whatsapp-ctl restart | whatsapp-ctl logs${NC}"
echo -e "${GREEN}================================================================================\n${NC}"
echo -e "${WHITE}To get started:${NC}"
echo -e " 1. Open ${CYAN}http://${PUBLIC_IP}:${TARGET_WEB_PORT}${NC} in your browser."
echo -e " 2. Register your admin account and grab your API Key."
echo -e " 3. Click 'Add WhatsApp Account' and scan the QR or request an 8-digit Pairing Code."
echo -e "\nEnjoy your enterprise WhatsApp API Gateway!\n"
