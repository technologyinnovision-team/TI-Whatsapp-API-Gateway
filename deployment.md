# Deployment Guide for CloudPanel (Flask + Node.js)

Target Server Path: `/home/tistack-wpapp/htdocs/wpapp.tistack.online`

## 1. Prerequisites

Ensure you have the following installed on the server (CloudPanel default usually covers these, but verify):
- **Python 3.x**
- **Node.js 20+** (Required for WhatsApp libraries)
- **Pip**
- **Virtualenv** (`sudo apt install python3-venv` if missing)

## 2. File Upload

Upload the following files/folders from your local `Development` folder to the server at `/home/tistack-wpapp/htdocs/wpapp.tistack.online/`:
1.  `flask-app/` (folder)
2.  `wa-bridge/` (folder)
3.  `supervisord.conf` (file)

**Note:** Do NOT upload `node_modules` or `__pycache__` folders. We will generate them on the server.

## 3. Server Setup Steps

SSH into your server:
```bash
ssh root@srv1124688
cd /home/tistack-wpapp/htdocs/wpapp.tistack.online/
```

### A. Python (Flask) Setup

1.  **Create Virtual Environment:**
    ```bash
    python3 -m venv venv
    ```

2.  **Activate and Install Dependencies:**
    ```bash
    source venv/bin/activate
    pip install -r flask-app/requirements.txt
    deactivate
    ```

### B. Node.js (Bridge) Setup

**CRITICAL:** The WhatsApp library requires Node.js v20. If the previous script failed, use this **MANUAL METHOD** to force the new repository:

```bash
# 1. Clean up old references
sudo apt-get remove -y nodejs libnode*
sudo rm -rf /etc/apt/sources.list.d/nodesource.list
sudo rm -rf /usr/share/keyrings/nodesource.gpg

# 2. Add dependencies
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg

# 3. Manually add the Node.js 20 GPG key and Repository
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg

echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list

# 4. Install
sudo apt-get update
sudo apt-get install -y nodejs

# 5. Verify (Must show v20.x.x)
node -v
```

1.  **Install Dependencies:**
    ```bash
    cd wa-bridge
    npm install
    cd ..
    ```

### C. Supervisor Setup (Process Management)

We use `supervisord` to keep your apps running.

1.  **Start Supervisor:**
    ```bash
    # Check if supervisor is already running; if not, start it with your config
    supervisord -c supervisord.conf
    ```

2.  **Check Status:**
    ```bash
    supervisorctl -c supervisord.conf status
    ```
    You should see both `flask-app` and `wa-bridge` showing as `RUNNING`.

    *Useful Commands:*
    - Restart all: `supervisorctl -c supervisord.conf restart all`
    - Stop all: `supervisorctl -c supervisord.conf stop all`
    - Reload config: `supervisorctl -c supervisord.conf reload`

## 4. CloudPanel Nginx Configuration

You need to update the Vhost to proxy traffic to your Flask app (running on port 5000) and support WebSockets/headers.

1.  Go to your CloudPanel Dashboard.
2.  Navigate to **Sites** -> `wpapp.tistack.online`.
3.  Go to the **Vhost** tab.
4.  **Replace the entire content** with the following configuration:

```nginx
server {
  listen 80;
  listen [::]:80;
  listen 443 quic;
  listen 443 ssl;
  listen [::]:443 quic;
  listen [::]:443 ssl;
  http2 on;
  http3 off;
  {{ssl_certificate_key}}
  {{ssl_certificate}}
  server_name wpapp.tistack.online;
  {{root}}

  {{nginx_access_log}}
  {{nginx_error_log}}

  if ($scheme != "https") {
    rewrite ^ https://$host$request_uri permanent;
  }

  location ~ /.well-known {
    auth_basic off;
    allow all;
  }

  {{settings}}

  include /etc/nginx/global_settings;

  index index.html;

  location / {
    proxy_pass http://127.0.0.1:5000/;
    proxy_http_version 1.1;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Server $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "Upgrade";
    proxy_pass_request_headers on;
    proxy_max_temp_file_size 0;
    proxy_connect_timeout 900;
    proxy_send_timeout 900;
    proxy_read_timeout 900;
    proxy_buffer_size 128k;
    proxy_buffers 4 256k;
    proxy_busy_buffers_size 256k;
    proxy_temp_file_write_size 256k;
  }
}
```

5.  **Save** the configuration.

## 5. Verification

Visit `https://wpapp.tistack.online`.
- You should see the Flask app.
- Login and test connection.
- The Flask app will internally talk to `http://localhost:3000` (wa-bridge) which is managed by Supervisor.
