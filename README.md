# Whatsapp API Gateway

**Whatsapp API Gateway** is a powerful, self-hosted solution that allows you to manage multiple WhatsApp accounts and send messages programmatically via a REST API. Built with a robust **Flask** dashboard and a high-performance **Node.js (Baileys)** bridge, this platform is designed for stability, scalability, and ease of use.

## 🚀 Key Features

*   **Multi-Tenancy**: Manage multiple WhatsApp accounts (sessions) from a single user dashboard.
*   **Simple Authentication**: Scan QR codes just like WhatsApp Web to connect accounts.
*   **REST API**: easy-to-use API for sending messages from your external applications.
*   **Bulk Messaging**: Send messages to single numbers or broadcast to lists of recipients.
*   **Human Simulation**: Intelligent "typing" and presence simulation (Online/Offline/Composing) to reduce ban risks.
*   **Session Persistence**: Automatically restores sessions on restart.
*   **Status Monitoring**: Real-time connection status and QR code generation for re-linking.
*   **User Management**: Built-in user authentication, API key generation, and account isolation.

---

## 🛠 Tech Stack

*   **Frontend/Backend**: Python (Flask), SQLAlchemy, Jinja2 Templates.
*   **Bridge/Core**: Node.js, Express, [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys).
*   **Database**: MySQL / MariaDB.
*   **Process Management**: Supervisor (recommended for production).

---

## 📋 Prerequisites

Before you begin, ensure you have the following installed:

1.  **Node.js**: v20.x or higher (Required for the latest WhatsApp libraries).
2.  **Python**: 3.8 or higher.
3.  **MySQL Server**: Running and accessible.

---

## ⚙️ Installation

### 1. Clone the Repository
```bash
git clone https://github.com/technologyinnovision-team/TI-Whatsapp-API-Gateway.git
cd TI-Whatsapp-API-Gateway
```

### 2. Database Setup
Create a new MySQL database for the application.
```sql
CREATE DATABASE whatsapp_gateway;
```

### 3. Backend Setup (Flask)
Navigate to the `flask-app` directory and set up the Python environment.

```bash
cd flask-app
# Create virtual environment
python -m venv venv
# Activate (Windows)
venv\Scripts\activate
# Activate (Linux/Mac)
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

**Configuration:**
Create a `.env` file in the `flask-app` directory:
```ini
DB_USERNAME=root
DB_PASSWORD=yourpassword
DB_HOST=localhost
DB_NAME=whatsapp_gateway
SECRET_KEY=your-super-secret-key-change-this
```

### 4. Bridge Setup (Node.js)
Navigate to the `wa-bridge` directory and install Node dependencies.

```bash
cd ../wa-bridge
npm install
```

---

## 🚀 Running the Application

For development, you need to run both the Bridge and the Flask app.

**Terminal 1 (Bridge):**
```bash
cd wa-bridge
node server.js
# Runs on Port 3000
```

**Terminal 2 (Flask App):**
```bash
cd flask-app
# Ensure venv is active
python app.py
# Runs on Port 5000
```

Visit `http://localhost:5000` in your browser to access the dashboard.

---

## 📖 API Documentation

The platform exposes a public API for sending messages. You can find your `X-API-Key` in the User Dashboard.

### Send Message Endpoint

**POST** `/api/v1/send`

**Headers:**
*   `Content-Type`: `application/json`
*   `X-API-Key`: `your_generated_api_key_here`

**Body Parameters:**
| Parameter | Type | Description |
| :--- | :--- | :--- |
| `account_id` | `string` | The **Alias** connection name you created in the dashboard. |
| `to` | `string` or `array` | Phone number (with country code, no `+`) OR list of numbers. |
| `message` | `string` | The text message content. |

**Example Request:**
```json
{
  "account_id": "marketing_1",
  "to": "1234567890",
  "message": "Hello! This is a test message from the Gateway."
}
```

**Example Bulk Request:**
```json
{
  "account_id": "marketing_1",
  "to": ["1234567890", "0987654321"],
  "message": "Weekly Newsletter Request"
}
```

---

## 📦 Production Deployment

For production environments (Ubuntu/Debian), we recommend using **Supervisor** to keep both services running and **Nginx** as a reverse proxy.

Refer to `deployment.md` in the root directory for a detailed step-by-step guide on deploying to a VPS (like shared hosting or cloud servers).

### Quick Supervisor Config Snippet
```ini
[program:wa-bridge]
command=/usr/bin/node server.js
directory=/path/to/wa-bridge
autostart=true
autorestart=true

[program:flask-app]
command=/path/to/venv/bin/gunicorn -w 4 -b 127.0.0.1:5000 app:app
directory=/path/to/flask-app
autostart=true
autorestart=true
```

---

## 🔒 Security Notes

*   **API Keys**: Keep your API keys secret. Anyone with a key can send messages via your connected accounts.
*   **Session Data**: The `wa-bridge/auth_info` folder contains sensitive session credentials. Ensure this folder is secured and not publicly accessible.
*   **Rate Limiting**: While the system handles queuing, avoid sending thousands of messages instantly to prevent WhatsApp from flagging your numbers.

---

## 🤝 Contributing

Contributions are welcome! Please fork the repository and submit a pull request for any enhancements.

## 📄 License

This project is open-source and available under the [MIT License](LICENSE).
