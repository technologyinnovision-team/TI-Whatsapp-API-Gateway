# WhatsApp Enterprise API Gateway & Anti-Ban Platform (v2.0)

<p align="center">
  <img src="https://raw.githubusercontent.com/technologyinnovision-team/TI-Whatsapp-API/main/flask-app/static/banner.png" alt="WhatsApp API Gateway" width="800" onerror="this.style.display='none'"/>
</p>

<p align="center">
  <a href="#-one-line-installer-linux"><img src="https://img.shields.io/badge/Install-1--Line%20Linux%20Command-25D366?style=for-the-badge&logo=linux&logoColor=white" alt="One-Line Install" /></a>
  <a href="#-docker-deployment"><img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=for-the-badge&logo=docker&logoColor=white" alt="Docker" /></a>
  <a href="#-anti-ban-protection-engine"><img src="https://img.shields.io/badge/Anti--Ban-Protected%20v2.0-059669?style=for-the-badge&logo=shield&logoColor=white" alt="Anti-Ban" /></a>
  <img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="License" />
</p>

---

## 🌟 Overview

**Technology Innovision WhatsApp API Gateway** is a modern, high-performance, self-hosted multi-tenant solution designed to programmatically manage multiple WhatsApp accounts, dispatch messages via a comprehensive REST API, execute bulk campaigns safely, and automate customer responses.

Re-engineered from scratch, version **2.0** introduces an enterprise **Anti-Ban Protection Engine**, **Phone Number Pairing Code** linking (no camera required), **Rich Media & WhatsApp Polls**, **Spintax variation processing**, **Per-Session SOCKS5/HTTP proxies**, and **Dynamic Port Conflict Management**.

---

## ⚡ Quick Start: One-Line Linux Installer

Install and configure everything on any Linux VPS (Ubuntu, Debian, CentOS, AlmaLinux, Rocky, Fedora, Arch, Alpine) with a single command:

```bash
curl -sSL https://raw.githubusercontent.com/technologyinnovision-team/TI-Whatsapp-API/main/install.sh | bash
```

### 🔄 Updating to the Latest Version:
To update an existing installation without losing any data, sessions, or port configuration:
```bash
# Option 1: Via global CLI tool
whatsapp-ctl update

# Option 2: Via one-line updater script
curl -sSL https://raw.githubusercontent.com/technologyinnovision-team/TI-Whatsapp-API/main/update.sh | bash
```
*(All `.env` settings, port bindings, connected WhatsApp sessions, and databases are 100% preserved!)*

### What the installer handles automatically:
1. **OS & Architecture Auto-Detection**: Configures package managers and builds.
2. **Node.js 20+ & Python 3 Setup**: Installs required runtime environments.
3. **Smart Port Conflict Management**: Intelligently detects and preserves ports `5000` (Web) and `3001` (Bridge), automatically reclaiming them from previous WAAPI instances.
4. **Zero-Config Database Initialization**: Sets up resilient database layer (SQLite out-of-the-box or MySQL/PostgreSQL).
5. **Generates Cryptographic Secrets**: Generates secure random API keys and session encryption secrets.
6. **Systemd Background Services**: Configures `whatsapp-bridge.service` and `whatsapp-web.service` with auto-restart on boot.
7. **Installs Global CLI (`whatsapp-ctl`)**: Provides instant service management from your terminal (`status`, `update`, `restart`, `logs`).

---

## 🛍️ 100% Backward Compatible (Fahad Styles & E-Commerce Ready)

### Will you have to change any code in Fahad Styles or existing clients?
> [!IMPORTANT]
> **NO! Absolutely ZERO code changes are needed in Fahad Styles, WooCommerce, WordPress, Shopify, or your custom plugins.**

The universal endpoint `POST /api/v1/send` accepts the exact same payload and returns the exact same response schema:

| Setting Field in Plugin / Client | Value | Explanation |
| :--- | :--- | :--- |
| **Account ID** | `fahadstyles` | Your WhatsApp account alias created in the dashboard |
| **API Key** | `42f1f0d888161...` | Secret API key passed in `X-API-Key` header |
| **API URL** | `https://wpapp.tistack.online/api/v1/send` | Standard legacy endpoint with auto anti-ban |

#### Exact Request Sent by Fahad Styles & Existing Clients:
```json
POST https://wpapp.tistack.online/api/v1/send
Headers:
  Content-Type: application/json
  X-API-Key: YOUR_API_KEY

Body:
{
  "account_id": "fahadstyles",
  "to": "923001234567",
  "message": "Dear Customer, your order #4821 has been confirmed!"
}
```

#### Exact Response Returned to Fahad Styles:
```json
{
  "status": "success",
  "total": 1,
  "successful": 1,
  "failed": 0,
  "details": [
    {
      "to": "923001234567",
      "status": "sent",
      "response": {
        "success": true,
        "messageId": "3EB048194...",
        "jid": "923001234567@s.whatsapp.net"
      }
    }
  ],
  "success": true
}
```

Behind the scenes, your messages now automatically benefit from our **Anti-Ban Protection Engine** (human typing simulation, Spintax randomization, and queue jitter) without requiring you to touch a single line of code in Fahad Styles!

---

## 🐳 Docker Deployment

Run the complete gateway using Docker & Docker Compose:

```bash
# 1. Clone repository
git clone https://github.com/technologyinnovision-team/TI-Whatsapp-API.git
cd TI-Whatsapp-API

# 2. Copy environment configuration
cp .env.example .env

# 3. Start containers
docker compose up -d
```

Access the Web Dashboard at `http://localhost:5000` and Swagger API Docs at `http://localhost:5000/docs`.

---

## 🛡️ Anti-Ban Protection Engine

WhatsApp flags and bans automated accounts primarily due to **burst concurrency**, **zero-jitter intervals**, **identical message hashes**, **missing presence states**, and **IP correlation across multiple accounts**. Our Anti-Ban Engine solves every single one of these factors:

```
                  ┌─────────────────────────────────────────┐
                  │       Incoming Outgoing Messages        │
                  └────────────────────┬────────────────────┘
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │    Per-Session FIFO Async Queue         │
                  │  (Never fires concurrent socket calls)  │
                  └────────────────────┬────────────────────┘
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │      Spintax Variation Resolver         │
                  │   {Hi|Hello|Hey} -> Dynamic variation   │
                  └────────────────────┬────────────────────┘
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │       Human Simulation Controller       │
                  │  1. Send 'available' presence           │
                  │  2. Dynamic typing (35ms/char + jitter) │
                  │  3. Recording state for voice notes     │
                  │  4. Send 'paused' -> Dispatch payload   │
                  └────────────────────┬────────────────────┘
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │       Safe Jitter Interval Delay        │
                  │      (Randomized 4s - 12s sleep)        │
                  └────────────────────┬────────────────────┘
                                       ▼
                  ┌─────────────────────────────────────────┐
                  │       Isolated Session Proxy Router     │
                  │      (SOCKS5 / HTTP Proxy Per Number)   │
                  └────────────────────┬────────────────────┘
                                       ▼
                            WhatsApp Socket Servers
```

* **Dynamic Human Typing Simulator**: Calculates natural keyboard typing speeds (30–50ms per character) plus randomized human pauses before sending.
* **PTT Voice Note Presence**: Sets `recording` presence instead of `composing` when sending voice memos.
* **Built-in Spintax Engine**: Supports `{Hello|Hi|Greetings} {friend|valued client}` to guarantee unique hashes on bulk sends.
* **Session Warm-Up Schedule**: Enforces safe daily ramps for fresh phone numbers (Day 1: 35, Day 2: 70, Day 3: 140, etc.).
* **Per-Session Proxy Support**: Route individual WhatsApp numbers through dedicated residential or datacenter SOCKS5/HTTP proxies.
* **Auto-Offline Presence**: Automatically sends `unavailable` presence after idle periods to prevent "24/7 online" bot detection.
* **Real-time Safety Score**: Computes a live 0–100% health score for each WhatsApp session.

---

## 🚀 Key Features

* **Multi-Tenancy & Multi-Session**: Run and manage multiple WhatsApp accounts in an isolated multi-tenant architecture.
* **Pairing Code (Camera-Free)**: Link WhatsApp on headless servers or cloud VPS without scanning a QR code by entering an 8-digit code.
* **Rich Messaging Suite**:
  * Plain text with Spintax, emojis, and `@phone` mentions.
  * Media: Images, Videos (with GIF option), Audio, Documents (PDF, ZIP, Word with custom filenames).
  * Push-to-Talk (PTT) Voice Notes (`audio/ogg; codecs=opus`).
  * WhatsApp Interactive Polls (single/multi choice).
  * Contact Cards (vCard).
  * GPS Location Coordinates.
  * Emoji Message Reactions (`❤️`, `👍`, etc.).
* **Bulk Broadcast Studio**: Run scheduled campaigns with CSV/number lists, Spintax variation preview, and live progress bars.
* **Auto-Responder & Chatbot**: Rule builder matching exact, contains, starts-with, or regex keywords with automated Spintax replies.
* **Incoming Event Webhooks**: Dispatches real-time webhooks for incoming messages, delivery receipts (sent, delivered, read), and connection states with HMAC SHA-256 signatures.
* **Interactive API Documentation**: Swagger UI (`/docs`) and ReDoc (`/redoc`) with interactive "Try It Out" consoles.
* **Modern Dark UI/UX**: Built with Tailwind CSS, Lucide icons, glassmorphism, responsive navigation, and dark mode.

---

## 📡 REST API Reference

Authenticate all requests using the `X-API-Key` header or `Authorization: Bearer <key>`.

### 1. Send Text Message
```bash
curl -X POST http://localhost:5000/api/v1/send/text \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "account_id": "support_desk",
    "to": "15551234567",
    "message": "{Hello|Hi} friend! Your verification code is 59381."
  }'
```

### 2. Send Media (Image, Video, Document)
```bash
curl -X POST http://localhost:5000/api/v1/send/media \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "account_id": "support_desk",
    "to": "15551234567",
    "type": "image",
    "media": "https://example.com/banner.jpg",
    "caption": "{Check out|Look at} our new update!"
  }'
```

### 3. Send Voice Note (PTT)
```bash
curl -X POST http://localhost:5000/api/v1/send/voice \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "account_id": "support_desk",
    "to": "15551234567",
    "media": "https://example.com/audio/sample.mp3"
  }'
```

### 4. Send Interactive Poll
```bash
curl -X POST http://localhost:5000/api/v1/send/poll \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "account_id": "support_desk",
    "to": "15551234567",
    "name": "Which feature would you like next?",
    "values": ["Faster Delivery", "Mobile App", "More Discounts"],
    "selectableCount": 1
  }'
```

### 5. Request 8-Digit Pairing Code
```bash
curl -X POST http://localhost:5000/api/v1/sessions/support_desk/pairing-code \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_API_KEY" \
  -d '{
    "phoneNumber": "15551234567"
  }'
```

### 6. System Health & Ports
```bash
curl http://localhost:5000/api/v1/system/health
```

---

## 💻 CLI Management Tool (`whatsapp-ctl`)

When installed on Linux, manage services with `whatsapp-ctl`:

```bash
# Check service status
whatsapp-ctl status

# Update gateway to latest version (preserves all data and ports)
whatsapp-ctl update

# View live application logs
whatsapp-ctl logs

# Restart gateway services
whatsapp-ctl restart

# Verify system health
whatsapp-ctl health

# Check active ports
whatsapp-ctl ports

# Stop or Start
whatsapp-ctl stop
whatsapp-ctl start
```

---

## ⚙️ Configuration (`.env`)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `WEB_PORT` | `5000` | Port for Flask Web Gateway & Dashboard |
| `BRIDGE_PORT` | `3001` | Port for Node.js Baileys Bridge |
| `BRIDGE_URL` | `http://127.0.0.1:3001` | Internal URL for Bridge communication |
| `DATABASE_URL` | `sqlite:///whatsapp_gateway.db` | SQLAlchemy connection string (SQLite, MySQL, PostgreSQL) |
| `SECRET_KEY` | *(Generated)* | Flask session signing secret |
| `WEBHOOK_SECRET` | *(Generated)* | HMAC secret for signing outgoing webhooks |
| `DEFAULT_MIN_DELAY_MS` | `4000` | Minimum anti-ban delay between messages (ms) |
| `DEFAULT_MAX_DELAY_MS` | `9000` | Maximum anti-ban delay between messages (ms) |
| `DEFAULT_DAILY_QUOTA` | `300` | Maximum messages per account per day |

---

## 🔒 Security Best Practices

1. **Firewall**: Expose only the Web Dashboard port (`5000` or via Reverse Proxy `80/443`). Keep the Bridge port (`3001`) internal.
2. **Reverse Proxy & SSL**: Deploy behind Nginx or Caddy with Let's Encrypt SSL.
3. **Session Credentials**: The `wa-bridge/auth_info` directory contains cryptographic WhatsApp credentials and is protected in `.gitignore`. Never share or commit this folder.

---

## 📄 License & Credits

Developed by **[Technology Innovision](https://technologyinnovision.com)**.  
Licensed under the [MIT License](LICENSE).