# Production Deployment Guide: WhatsApp Enterprise API Gateway

This guide covers deployment options for **Linux VPS (Standalone)**, **Docker & Docker Compose**, **CloudPanel**, and **Nginx Reverse Proxy with Let's Encrypt SSL**.

---

## Option 1: Standalone Linux VPS (Recommended)

### 1. One-Line Automated Installation
Run the following command on any clean Ubuntu, Debian, CentOS, AlmaLinux, or Rocky Linux VPS:

```bash
curl -sSL https://raw.githubusercontent.com/technologyinnovision-team/TI-Whatsapp-API/main/install.sh | bash
```

The script automatically:
* Installs Node.js 20+ LTS, Python 3, pip, and build tools.
* Scans for port conflicts on `5000` and `3001` (auto-allocates next available ports if in-use).
* Sets up the Python virtual environment and installs dependencies.
* Generates secure cryptographic secrets in `.env`.
* Configures and starts `whatsapp-bridge.service` and `whatsapp-web.service` via Systemd.
* Installs the `whatsapp-ctl` command line manager.

### 2. Updating Platform & Preserving Ports
Whenever new updates are pushed, run either:
```bash
# Method 1: Using the global CLI tool
whatsapp-ctl update

# Method 2: Using the one-line updater script
curl -sSL https://raw.githubusercontent.com/technologyinnovision-team/TI-Whatsapp-API/main/update.sh | bash
```
*(All databases, WhatsApp authentication tokens, and port configurations on 5000 / 3001 are safely preserved!)*

### 3. Service Management
```bash
# Check status of both services
whatsapp-ctl status

# Update gateway to latest version
whatsapp-ctl update

# View live consolidated logs
whatsapp-ctl logs

# Restart services
whatsapp-ctl restart

# Verify system health
whatsapp-ctl health
```

---

## Option 2: Docker & Docker Compose

For containerized environments, deploy using the included `docker-compose.yml`:

```bash
# 1. Clone repository
git clone https://github.com/technologyinnovision-team/TI-Whatsapp-API.git /opt/whatsapp-gateway
cd /opt/whatsapp-gateway

# 2. Configure Environment
cp .env.example .env
nano .env  # Edit ports or secrets if desired

# 3. Launch Containers
docker compose up -d --build

# 4. View Container Status
docker compose ps
docker compose logs -f
```

---

## Option 3: CloudPanel Deployment

If you are hosting on a server with CloudPanel:

### 1. Create a Reverse Proxy Site
1. Log into your CloudPanel admin interface.
2. Navigate to **Sites** &rarr; **Add Site** &rarr; **Reverse Proxy Site**.
3. Set **Domain Name**: `wpapi.yourdomain.com`
4. Set **Reverse Proxy URL**: `http://127.0.0.1:5000`

### 2. Deploy Project Code
SSH into your server and clone into the site directory:
```bash
cd /home/YOUR_USER/htdocs/wpapi.yourdomain.com
git clone https://github.com/technologyinnovision-team/TI-Whatsapp-API.git .
./install.sh
```

### 3. Update Vhost Configuration in CloudPanel
Go to **Sites** &rarr; `wpapi.yourdomain.com` &rarr; **Vhost** tab, and ensure the configuration proxies WebSockets and headers properly:

```nginx
server {
  listen 80;
  listen [::]:80;
  listen 443 ssl http2;
  listen [::]:443 ssl http2;
  server_name wpapi.yourdomain.com;
  {{root}}

  {{ssl_certificate}}
  {{ssl_certificate_key}}

  if ($scheme != "https") {
    rewrite ^ https://$host$request_uri permanent;
  }

  location / {
    proxy_pass http://127.0.0.1:5000/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_read_timeout 900s;
    proxy_connect_timeout 900s;
  }
}
```

---

## Option 4: Manual Nginx Reverse Proxy with Let's Encrypt SSL

For standard Ubuntu/Debian servers using Certbot and Nginx:

```bash
sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/whatsapp-gateway`:

```nginx
server {
    server_name api.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:5000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "Upgrade";
        proxy_read_timeout 600s;
        client_max_body_size 50M;
    }
}
```

Enable site and acquire SSL certificate:
```bash
sudo ln -s /etc/nginx/sites-available/whatsapp-gateway /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d api.yourdomain.com
```

---

## 🔧 Port & Network Troubleshooting

If you encounter port conflicts:
1. View active listeners:
   ```bash
   whatsapp-ctl ports
   # or
   ss -tuln | grep -E ':(5000|3001) '
   ```
2. Change ports anytime in `/opt/whatsapp-gateway/.env`:
   ```ini
   WEB_PORT=5005
   BRIDGE_PORT=3002
   BRIDGE_URL=http://127.0.0.1:3002
   ```
3. Restart services:
   ```bash
   whatsapp-ctl restart
   ```
