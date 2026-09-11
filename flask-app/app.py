import os
import sys
import uuid
import json
import time
import socket
import secrets
import logging
import threading
from datetime import datetime, timezone

def utcnow():
    return datetime.now(timezone.utc)
from urllib.parse import quote_plus

import requests
import psutil
from dotenv import load_dotenv
from flask import Flask, render_template, request, redirect, url_for, jsonify, abort, flash, send_from_directory
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from werkzeug.security import generate_password_hash, check_password_hash

# Load environment configuration
root_env_path = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '.env'))
if os.path.exists(root_env_path):
    load_dotenv(root_env_path)
load_dotenv() # local .env fallback

app = Flask(__name__)
app.config['SECRET_KEY'] = os.getenv('SECRET_KEY', secrets.token_hex(32))

# ==========================================
# PORT & NETWORK MANAGEMENT
# ==========================================
def is_port_in_use(port, host='127.0.0.1'):
    """Check if a network port is already open/in-use."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0

def find_available_port(start_port=5000, max_attempts=50):
    """Find the next available port starting from start_port."""
    for p in range(start_port, start_port + max_attempts):
        if not is_port_in_use(p):
            return p
    return start_port

WEB_PORT = int(os.getenv('WEB_PORT') or os.getenv('PORT') or '5000')
BRIDGE_PORT = int(os.getenv('BRIDGE_PORT') or '3001')
BRIDGE_URL = os.getenv('BRIDGE_URL', f'http://127.0.0.1:{BRIDGE_PORT}')

# ==========================================
# UNIVERSAL DATABASE INITIALIZATION
# ==========================================
# Supports SQLite (zero-config default) and MySQL/PostgreSQL seamlessly.
db_user = os.getenv('DB_USERNAME')
db_password = os.getenv('DB_PASSWORD')
db_host = os.getenv('DB_HOST')
db_name = os.getenv('DB_NAME')
database_url = os.getenv('DATABASE_URL')

if database_url:
    app.config['SQLALCHEMY_DATABASE_URI'] = database_url
elif db_user and db_password and db_host and db_name:
    app.config['SQLALCHEMY_DATABASE_URI'] = f"mysql+pymysql://{quote_plus(db_user)}:{quote_plus(db_password)}@{db_host}/{db_name}"
else:
    # Zero-config resilient SQLite fallback
    db_path = os.path.abspath(os.path.join(os.path.dirname(__file__), 'whatsapp_gateway.db'))
    app.config['SQLALCHEMY_DATABASE_URI'] = f'sqlite:///{db_path}'

app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

db = SQLAlchemy(app)
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

# ==========================================
# DATABASE MODELS
# ==========================================
class User(UserMixin, db.Model):
    __tablename__ = 'users'
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(150), unique=True, nullable=False, index=True)
    password = db.Column(db.String(255), nullable=False)
    api_key = db.Column(db.String(64), unique=True, nullable=False, index=True)
    is_admin = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=utcnow)

    accounts = db.relationship('WhatsappAccount', backref='owner', cascade='all, delete-orphan', lazy=True)
    campaigns = db.relationship('Campaign', backref='owner', cascade='all, delete-orphan', lazy=True)
    rules = db.relationship('AutoReplyRule', backref='owner', cascade='all, delete-orphan', lazy=True)

class WhatsappAccount(db.Model):
    __tablename__ = 'whatsapp_accounts'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    alias = db.Column(db.String(100), nullable=False)
    session_id = db.Column(db.String(64), unique=True, nullable=False, index=True)
    phone_number = db.Column(db.String(50), nullable=True)
    push_name = db.Column(db.String(150), nullable=True)
    proxy_url = db.Column(db.String(255), default='')
    min_delay_ms = db.Column(db.Integer, default=4000)
    max_delay_ms = db.Column(db.Integer, default=9000)
    custom_daily_quota = db.Column(db.Integer, default=300)
    mode = db.Column(db.String(20), default='standard') # 'safe', 'standard', 'fast'
    webhook_url = db.Column(db.String(255), default='')
    webhook_secret = db.Column(db.String(100), default='')
    created_at = db.Column(db.DateTime, default=utcnow)

    logs = db.relationship('MessageLog', backref='account', cascade='all, delete-orphan', lazy=True)

class MessageLog(db.Model):
    __tablename__ = 'message_logs'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    account_id = db.Column(db.Integer, db.ForeignKey('whatsapp_accounts.id', ondelete='CASCADE'), nullable=False)
    recipient = db.Column(db.String(50), nullable=False)
    message_type = db.Column(db.String(20), default='text')
    content_preview = db.Column(db.Text, nullable=True)
    status = db.Column(db.String(20), default='sent') # 'queued', 'sent', 'failed'
    message_id = db.Column(db.String(100), nullable=True)
    error_message = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=utcnow)

class Campaign(db.Model):
    __tablename__ = 'campaigns'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    account_id = db.Column(db.Integer, db.ForeignKey('whatsapp_accounts.id', ondelete='CASCADE'), nullable=False)
    name = db.Column(db.String(150), nullable=False)
    message_type = db.Column(db.String(20), default='text')
    template_text = db.Column(db.Text, nullable=False)
    media_url = db.Column(db.String(500), nullable=True)
    recipients_json = db.Column(db.Text, nullable=False) # JSON array
    total_count = db.Column(db.Integer, default=0)
    sent_count = db.Column(db.Integer, default=0)
    failed_count = db.Column(db.Integer, default=0)
    status = db.Column(db.String(20), default='draft') # 'draft', 'running', 'completed', 'paused', 'failed'
    created_at = db.Column(db.DateTime, default=utcnow)
    updated_at = db.Column(db.DateTime, default=utcnow, onupdate=utcnow)

class AutoReplyRule(db.Model):
    __tablename__ = 'auto_reply_rules'
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
    account_id = db.Column(db.Integer, db.ForeignKey('whatsapp_accounts.id', ondelete='CASCADE'), nullable=True)
    trigger = db.Column(db.String(255), nullable=False)
    match_type = db.Column(db.String(20), default='exact') # 'exact', 'contains', 'starts_with', 'regex'
    reply_text = db.Column(db.Text, nullable=False)
    media_url = db.Column(db.String(500), nullable=True)
    is_active = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=utcnow)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# ==========================================
# UTILITIES & BRIDGE PROXY
# ==========================================
def generate_api_key():
    return f"ti_{secrets.token_hex(28)}"

def proxy_bridge(method, endpoint, json_payload=None, timeout=15):
    """Safely proxy requests to the WhatsApp Node.js Bridge."""
    url = f"{BRIDGE_URL}{endpoint}"
    try:
        if method == 'GET':
            res = requests.get(url, timeout=timeout)
        elif method == 'POST':
            res = requests.post(url, json=json_payload, timeout=timeout)
        elif method == 'DELETE':
            res = requests.delete(url, timeout=timeout)
        else:
            return None
        return res.json()
    except Exception as e:
        return {'error': f'Bridge connection error: {str(e)}', 'status': 'bridge_offline'}

def get_user_from_api_key():
    """Authenticate API requests via X-API-Key or Bearer header."""
    key = request.headers.get('X-API-Key')
    if not key and request.headers.get('Authorization'):
        auth = request.headers.get('Authorization')
        if auth.startswith('Bearer '):
            key = auth.split(' ', 1)[1].strip()
    if not key:
        return None
    return User.query.filter_by(api_key=key).first()

# ==========================================
# AUTHENTICATION ROUTES
# ==========================================
@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))

@app.route('/signup', methods=['GET', 'POST'])
def signup():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')

        if not username or not password:
            return render_template('signup.html', error="Username and password are required")

        if User.query.filter_by(username=username).first():
            return render_template('signup.html', error="Username already exists")

        is_first_user = User.query.count() == 0
        new_user = User(
            username=username,
            password=generate_password_hash(password, method='scrypt'),
            api_key=generate_api_key(),
            is_admin=is_first_user
        )
        db.session.add(new_user)
        db.session.commit()
        login_user(new_user)
        flash('Account created successfully! Welcome to WhatsApp API Gateway.', 'success')
        return redirect(url_for('dashboard'))
    return render_template('signup.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    if request.method == 'POST':
        username = request.form.get('username', '').strip()
        password = request.form.get('password', '')
        user = User.query.filter_by(username=username).first()

        if user and check_password_hash(user.password, password):
            login_user(user)
            return redirect(url_for('dashboard'))
        return render_template('login.html', error="Invalid username or password")
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# ==========================================
# DASHBOARD & ACCOUNT MANAGEMENT
# ==========================================
@app.route('/dashboard')
@login_required
def dashboard():
    accounts = WhatsappAccount.query.filter_by(user_id=current_user.id).all()
    # Enrich accounts with live status from bridge
    enriched_accounts = []
    connected_count = 0
    total_messages_today = 0

    for acc in accounts:
        status_info = proxy_bridge('GET', f'/session/{acc.session_id}/status') or {}
        safety_info = proxy_bridge('GET', f'/session/{acc.session_id}/safety') or {}
        status = status_info.get('status', 'disconnected')
        if status == 'connected':
            connected_count += 1

        phone = None
        if status_info.get('user') and status_info['user'].get('id'):
            phone = status_info['user']['id'].split(':')[0]
            if not acc.phone_number:
                acc.phone_number = phone
                db.session.commit()

        total_messages_today += safety_info.get('sentToday', 0)

        enriched_accounts.append({
            'account': acc,
            'status': status,
            'phone': phone or acc.phone_number or 'Not Linked',
            'push_name': status_info.get('user', {}).get('name') or acc.push_name or 'WhatsApp User',
            'safety': safety_info,
            'queue_length': status_info.get('queueLength', 0)
        })

    # System metrics
    cpu_percent = psutil.cpu_percent()
    mem = psutil.virtual_memory()
    mem_percent = mem.percent

    return render_template(
        'dashboard.html',
        user=current_user,
        accounts=enriched_accounts,
        connected_count=connected_count,
        total_accounts=len(accounts),
        total_messages_today=total_messages_today,
        cpu_percent=cpu_percent,
        mem_percent=mem_percent,
        web_port=WEB_PORT,
        bridge_port=BRIDGE_PORT
    )

@app.route('/account/add', methods=['POST'])
@login_required
def add_account():
    alias = request.form.get('alias', '').strip()
    proxy_url = request.form.get('proxy_url', '').strip()
    mode = request.form.get('mode', 'standard')

    if not alias:
        flash('Account alias is required', 'error')
        return redirect(url_for('dashboard'))

    if WhatsappAccount.query.filter_by(user_id=current_user.id, alias=alias).first():
        flash(f"Account alias '{alias}' already exists", 'error')
        return redirect(url_for('dashboard'))

    session_id = str(uuid.uuid4())
    
    # Initialize in bridge
    res = proxy_bridge('POST', '/session/init', {
        'sessionId': session_id,
        'proxyUrl': proxy_url,
        'mode': mode
    })

    if not res or 'error' in res:
        flash(f"Failed to initialize WhatsApp session in Bridge: {res.get('error', 'Offline')}", 'error')
        return redirect(url_for('dashboard'))

    new_account = WhatsappAccount(
        alias=alias,
        session_id=session_id,
        proxy_url=proxy_url,
        mode=mode,
        owner=current_user
    )
    db.session.add(new_account)
    db.session.commit()

    flash(f"WhatsApp Session '{alias}' created successfully! Now scan QR or enter pairing code.", 'success')
    return redirect(url_for('view_account', id=new_account.id))

@app.route('/account/<int:id>')
@login_required
def view_account(id):
    account = WhatsappAccount.query.get_or_404(id)
    if account.user_id != current_user.id:
        abort(403)

    try:
        sync_rules_to_bridge(current_user.id)
    except Exception:
        pass

    status_data = proxy_bridge('GET', f'/session/{account.session_id}/status') or {}
    qr_data = proxy_bridge('GET', f'/session/{account.session_id}/qr') or {}
    safety_data = proxy_bridge('GET', f'/session/{account.session_id}/safety') or {}

    return render_template(
        'account.html',
        account=account,
        status=status_data.get('status', 'disconnected'),
        user_info=status_data.get('user'),
        qr_image=qr_data.get('qrImage'),
        pairing_code=status_data.get('pairingCode'),
        safety=safety_data,
        queue_length=status_data.get('queueLength', 0)
    )

@app.route('/account/<int:id>/status_json')
@login_required
def account_status_json(id):
    account = WhatsappAccount.query.get_or_404(id)
    if account.user_id != current_user.id:
        abort(403)

    status = proxy_bridge('GET', f'/session/{account.session_id}/status') or {}
    qr = proxy_bridge('GET', f'/session/{account.session_id}/qr') or {}
    safety = proxy_bridge('GET', f'/session/{account.session_id}/safety') or {}

    return jsonify({
        'status': status.get('status', 'error'),
        'qrImage': qr.get('qrImage'),
        'pairingCode': status.get('pairingCode'),
        'user': status.get('user'),
        'safety': safety,
        'queueLength': status.get('queueLength', 0)
    })

@app.route('/account/<int:id>/pairing_code', methods=['POST'])
@login_required
def account_pairing_code(id):
    account = WhatsappAccount.query.get_or_404(id)
    if account.user_id != current_user.id:
        abort(403)

    phone_number = request.form.get('phone_number') or (request.json and request.json.get('phone_number'))
    if not phone_number:
        return jsonify({'error': 'Phone number is required'}), 400

    res = proxy_bridge('POST', '/session/pairing-code', {
        'sessionId': account.session_id,
        'phoneNumber': phone_number
    })

    return jsonify(res)

@app.route('/account/<int:id>/settings', methods=['POST'])
@login_required
def update_account_settings(id):
    account = WhatsappAccount.query.get_or_404(id)
    if account.user_id != current_user.id:
        abort(403)

    proxy_url = request.form.get('proxy_url', '').strip()
    mode = request.form.get('mode', 'standard')
    min_delay_ms = int(request.form.get('min_delay_ms', 4000))
    max_delay_ms = int(request.form.get('max_delay_ms', 9000))
    custom_daily_quota = int(request.form.get('custom_daily_quota', 300))
    webhook_url = request.form.get('webhook_url', '').strip()
    webhook_secret = request.form.get('webhook_secret', '').strip()

    account.proxy_url = proxy_url
    account.mode = mode
    account.min_delay_ms = min_delay_ms
    account.max_delay_ms = max_delay_ms
    account.custom_daily_quota = custom_daily_quota
    account.webhook_url = webhook_url
    account.webhook_secret = webhook_secret
    db.session.commit()

    # Sync to bridge
    proxy_bridge('POST', f'/session/{account.session_id}/settings', {
        'proxyUrl': proxy_url,
        'mode': mode,
        'minDelayMs': min_delay_ms,
        'maxDelayMs': max_delay_ms,
        'customDailyQuota': custom_daily_quota,
        'webhookUrl': webhook_url,
        'webhookSecret': webhook_secret
    })

    flash('Account settings updated successfully!', 'success')
    return redirect(url_for('view_account', id=account.id))

@app.route('/account/<int:id>/reconnect', methods=['POST'])
@login_required
def reconnect_account(id):
    account = WhatsappAccount.query.get_or_404(id)
    if account.user_id != current_user.id:
        abort(403)

    proxy_bridge('POST', f'/session/{account.session_id}/restart')
    flash(f"Reconnecting session '{account.alias}'...", 'info')
    return redirect(url_for('view_account', id=account.id))

@app.route('/account/<int:id>/delete', methods=['POST'])
@login_required
def delete_account(id):
    account = WhatsappAccount.query.get_or_404(id)
    if account.user_id != current_user.id:
        abort(403)

    proxy_bridge('DELETE', f'/session/{account.session_id}')
    db.session.delete(account)
    db.session.commit()
    flash(f"Session '{account.alias}' deleted permanently.", 'success')
    return redirect(url_for('dashboard'))

# ==========================================
# CAMPAIGNS (BULK MESSAGING WITH ANTI-BAN)
# ==========================================
@app.route('/campaigns', methods=['GET', 'POST'])
@login_required
def campaigns():
    if request.method == 'POST':
        name = request.form.get('name', '').strip()
        account_id = request.form.get('account_id')
        template_text = request.form.get('template_text', '').strip()
        media_url = request.form.get('media_url', '').strip()
        message_type = request.form.get('message_type', 'text')
        recipients_raw = request.form.get('recipients', '').strip()

        if not name or not account_id or not template_text or not recipients_raw:
            flash('All campaign fields are required', 'error')
            return redirect(url_for('campaigns'))

        account = WhatsappAccount.query.get(int(account_id))
        if not account or account.user_id != current_user.id:
            flash('Invalid WhatsApp account selected', 'error')
            return redirect(url_for('campaigns'))

        # Parse recipients (comma, newline, or JSON)
        recipients = []
        for line in recipients_raw.replace(',', '\n').split('\n'):
            clean = line.strip().replace('+', '').replace(' ', '').replace('-', '')
            if clean and clean.isdigit() and len(clean) >= 8:
                recipients.append(clean)
        recipients = list(set(recipients)) # Deduplicate

        if not recipients:
            flash('No valid recipient phone numbers found', 'error')
            return redirect(url_for('campaigns'))

        campaign = Campaign(
            name=name,
            account_id=account.id,
            user_id=current_user.id,
            message_type=message_type,
            template_text=template_text,
            media_url=media_url,
            recipients_json=json.dumps(recipients),
            total_count=len(recipients),
            status='draft'
        )
        db.session.add(campaign)
        db.session.commit()

        flash(f"Campaign '{name}' created with {len(recipients)} recipients!", 'success')
        return redirect(url_for('campaigns'))

    user_campaigns = Campaign.query.filter_by(user_id=current_user.id).order_by(Campaign.id.desc()).all()
    user_accounts = WhatsappAccount.query.filter_by(user_id=current_user.id).all()
    return render_template('campaigns.html', campaigns=user_campaigns, accounts=user_accounts)

@app.route('/campaigns/<int:id>/run', methods=['POST'])
@login_required
def run_campaign(id):
    campaign = Campaign.query.get_or_404(id)
    if campaign.user_id != current_user.id:
        abort(403)

    account = WhatsappAccount.query.get(campaign.account_id)
    if not account:
        return jsonify({'error': 'Account not found'}), 404

    campaign.status = 'running'
    db.session.commit()

    recipients = json.loads(campaign.recipients_json)

    # Dispatch to Bridge bulk queue
    payload = {
        'recipients': recipients,
        'type': campaign.message_type,
        'message': campaign.template_text,
        'media': campaign.media_url if campaign.media_url else None
    }

    res = proxy_bridge('POST', f'/session/{account.session_id}/send/bulk', payload)

    # Log in database
    for num in recipients:
        log = MessageLog(
            user_id=current_user.id,
            account_id=account.id,
            recipient=num,
            message_type=campaign.message_type,
            content_preview=campaign.template_text[:120],
            status='queued'
        )
        db.session.add(log)
    db.session.commit()

    flash(f"Campaign '{campaign.name}' enqueued safely with Anti-Ban queue protection!", 'success')
    return redirect(url_for('campaigns'))

# ==========================================
# CHATBOT & AUTO-RESPONDER
# ==========================================
@app.route('/chatbot', methods=['GET', 'POST'])
@login_required
def chatbot():
    if request.method == 'POST':
        trigger = request.form.get('trigger', '').strip()
        match_type = request.form.get('match_type', 'exact')
        reply_text = request.form.get('reply_text', '').strip()
        account_id = request.form.get('account_id')
        media_url = request.form.get('media_url', '').strip()

        if not trigger or not reply_text:
            flash('Trigger keyword and reply text are required', 'error')
            return redirect(url_for('chatbot'))

        acc_id = int(account_id) if account_id and account_id != 'all' else None
        rule = AutoReplyRule(
            user_id=current_user.id,
            account_id=acc_id,
            trigger=trigger,
            match_type=match_type,
            reply_text=reply_text,
            media_url=media_url,
            is_active=True
        )
        db.session.add(rule)
        db.session.commit()

        # Update bridge settings
        sync_rules_to_bridge(current_user.id)
        flash('Auto-responder rule added!', 'success')
        return redirect(url_for('chatbot'))

    rules = AutoReplyRule.query.filter_by(user_id=current_user.id).order_by(AutoReplyRule.id.desc()).all()
    accounts = WhatsappAccount.query.filter_by(user_id=current_user.id).all()
    return render_template('chatbot.html', rules=rules, accounts=accounts)

def sync_rules_to_bridge(user_id):
    """Sync active auto-responder rules to corresponding sessions in bridge."""
    accounts = WhatsappAccount.query.filter_by(user_id=user_id).all()
    all_user_rules = AutoReplyRule.query.filter_by(user_id=user_id, is_active=True).all()

    for acc in accounts:
        acc_rules = [
            {
                'trigger': r.trigger,
                'matchType': r.match_type,
                'replyText': r.reply_text,
                'mediaUrl': r.media_url,
                'enabled': r.is_active
            }
            for r in all_user_rules if r.account_id is None or r.account_id == acc.id
        ]
        proxy_bridge('POST', f'/session/{acc.session_id}/settings', {'autoReplyRules': acc_rules})

@app.route('/chatbot/<int:id>/delete', methods=['POST'])
@login_required
def delete_chatbot_rule(id):
    rule = AutoReplyRule.query.get_or_404(id)
    if rule.user_id != current_user.id:
        abort(403)
    db.session.delete(rule)
    db.session.commit()
    sync_rules_to_bridge(current_user.id)
    flash('Rule deleted', 'success')
    return redirect(url_for('chatbot'))

@app.route('/internal/event', methods=['POST'])
def internal_event_listener():
    data = request.json or {}
    event_type = data.get('event')
    payload = data.get('data', {})
    session_id = payload.get('sessionId') or data.get('sessionId')
    if not session_id:
        return jsonify({'status': 'ignored', 'reason': 'missing sessionId'}), 200

    account = WhatsappAccount.query.filter_by(session_id=session_id).first()
    if not account:
        return jsonify({'status': 'ignored', 'reason': 'unknown account'}), 200

    recipient = payload.get('phone') or payload.get('from', '').replace('@s.whatsapp.net', '').replace('@g.us', '') or payload.get('recipient', '')
    msg_type = payload.get('type') or 'text'
    body = payload.get('body') or payload.get('replyText') or ''
    msg_id = payload.get('messageId')

    if event_type == 'message.received':
        log = MessageLog(
            user_id=account.user_id,
            account_id=account.id,
            recipient=recipient,
            message_type=msg_type,
            content_preview=(body[:200] if body else '[Incoming media/event]'),
            status='received',
            message_id=msg_id
        )
        db.session.add(log)
        db.session.commit()
    elif event_type == 'message.auto_reply':
        reply_text = payload.get('replyText') or ''
        log = MessageLog(
            user_id=account.user_id,
            account_id=account.id,
            recipient=recipient,
            message_type='auto_reply',
            content_preview=f"Auto-Reply: {reply_text[:180]}",
            status='sent',
            message_id=msg_id
        )
        db.session.add(log)
        db.session.commit()

    return jsonify({'status': 'ok'}), 200

# ==========================================
# MESSAGE LOGS & AUDIT TRAIL
# ==========================================
@app.route('/messages')
@login_required
def messages():
    page = request.args.get('page', 1, type=int)
    logs_pagination = MessageLog.query.filter_by(user_id=current_user.id).order_by(MessageLog.id.desc()).paginate(page=page, per_page=25)
    return render_template('messages.html', logs=logs_pagination.items, pagination=logs_pagination)

# ==========================================
# SETTINGS & PORT MANAGEMENT
# ==========================================
@app.route('/settings')
@login_required
def settings():
    bridge_health = proxy_bridge('GET', '/health') or {}
    webhook_logs = proxy_bridge('GET', '/webhooks/logs') or {}

    ports_info = {
        'web_port': WEB_PORT,
        'web_port_status': 'ACTIVE (In-Use by Dashboard)',
        'bridge_port': BRIDGE_PORT,
        'bridge_port_status': 'ACTIVE (Connected)' if bridge_health.get('status') == 'healthy' else 'OFFLINE'
    }

    return render_template(
        'settings.html',
        user=current_user,
        bridge_health=bridge_health,
        ports_info=ports_info,
        webhook_logs=webhook_logs.get('logs', [])
    )

@app.route('/settings/regenerate_key', methods=['POST'])
@login_required
def regenerate_api_key():
    current_user.api_key = generate_api_key()
    db.session.commit()
    flash('New API Key generated successfully!', 'success')
    return redirect(url_for('settings'))

# ==========================================
# INTERACTIVE API DOCS (SWAGGER & REDOC)
# ==========================================
@app.route('/docs')
def docs():
    return render_template('docs.html')

@app.route('/docs/swagger')
def docs_swagger():
    return render_template('swagger.html')

@app.route('/redoc')
def redoc():
    return render_template('redoc.html')

@app.route('/static/openapi.yaml')
def openapi_yaml():
    return send_from_directory('static', 'openapi.yaml')

# ==========================================
# PUBLIC REST API (V1)
# ==========================================
@app.route('/api/v1/send/text', methods=['POST'])
def api_send_text():
    user = get_user_from_api_key()
    if not user:
        return jsonify({'error': 'Unauthorized. Missing or invalid API Key'}), 401

    data = request.json or {}
    account_alias = data.get('account_id') or data.get('account')
    to = data.get('to')
    message = data.get('message') or data.get('text')

    if not account_alias or not to or not message:
        return jsonify({'error': 'Missing required fields: account_id, to, message'}), 400

    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=account_alias).first()
    if not account:
        return jsonify({'error': f"WhatsApp account '{account_alias}' not found"}), 404

    # Bridge dispatch
    res = proxy_bridge('POST', f'/session/{account.session_id}/send', {
        'to': to,
        'type': 'text',
        'text': message
    })

    status = 'sent' if res and res.get('success') else 'failed'
    msg_id = res.get('messageId') if res else None
    err = res.get('error') if res and not res.get('success') else None

    # Log to DB
    log = MessageLog(
        user_id=user.id,
        account_id=account.id,
        recipient=to,
        message_type='text',
        content_preview=message[:120],
        status=status,
        message_id=msg_id,
        error_message=err
    )
    db.session.add(log)
    db.session.commit()

    if status == 'sent':
        return jsonify({'success': True, 'messageId': msg_id, 'status': 'sent', 'safetyReport': res.get('safetyReport')})
    else:
        return jsonify({'success': False, 'error': err or 'Bridge error'}), 500

@app.route('/api/v1/send/media', methods=['POST'])
def api_send_media():
    user = get_user_from_api_key()
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    data = request.json or {}
    account_alias = data.get('account_id') or data.get('account')
    to = data.get('to')
    media_type = data.get('type', 'image') # 'image', 'video', 'audio', 'document'
    media = data.get('media') or data.get('url')
    caption = data.get('caption', '')
    file_name = data.get('fileName', 'file.pdf')

    if not account_alias or not to or not media:
        return jsonify({'error': 'Missing required fields: account_id, to, media'}), 400

    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=account_alias).first()
    if not account:
        return jsonify({'error': 'Account not found'}), 404

    res = proxy_bridge('POST', f'/session/{account.session_id}/send', {
        'to': to,
        'type': media_type,
        'media': media,
        'caption': caption,
        'fileName': file_name
    })

    status = 'sent' if res and res.get('success') else 'failed'
    log = MessageLog(
        user_id=user.id,
        account_id=account.id,
        recipient=to,
        message_type=media_type,
        content_preview=caption[:100] or f"[{media_type.upper()} file]",
        status=status,
        message_id=res.get('messageId') if res else None,
        error_message=res.get('error') if res else None
    )
    db.session.add(log)
    db.session.commit()

    return jsonify(res)

@app.route('/api/v1/send/voice', methods=['POST'])
def api_send_voice():
    user = get_user_from_api_key()
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    data = request.json or {}
    account_alias = data.get('account_id')
    to = data.get('to')
    media = data.get('media') or data.get('url')

    if not account_alias or not to or not media:
        return jsonify({'error': 'Missing account_id, to, or media URL/base64'}), 400

    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=account_alias).first()
    if not account:
        return jsonify({'error': 'Account not found'}), 404

    res = proxy_bridge('POST', f'/session/{account.session_id}/send', {
        'to': to,
        'type': 'voice',
        'media': media,
        'ptt': True
    })

    return jsonify(res)

@app.route('/api/v1/send/poll', methods=['POST'])
def api_send_poll():
    user = get_user_from_api_key()
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    data = request.json or {}
    account_alias = data.get('account_id')
    to = data.get('to')
    name = data.get('name')
    values = data.get('values', [])
    selectable_count = data.get('selectableCount', 1)

    if not account_alias or not to or not name or len(values) < 2:
        return jsonify({'error': 'Missing params. Requires name and at least 2 values'}), 400

    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=account_alias).first()
    if not account:
        return jsonify({'error': 'Account not found'}), 404

    res = proxy_bridge('POST', f'/session/{account.session_id}/send', {
        'to': to,
        'type': 'poll',
        'name': name,
        'values': values,
        'selectableCount': selectable_count
    })

    return jsonify(res)

@app.route('/api/v1/send/buttons', methods=['POST'])
def api_send_buttons():
    user = get_user_from_api_key()
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    data = request.json or {}
    account_alias = data.get('account_id') or data.get('account')
    to = data.get('to')
    message = data.get('message') or data.get('text') or ''
    title = data.get('title', '')
    footer = data.get('footer', '')
    media = data.get('media') or data.get('url') or data.get('image')
    buttons = data.get('buttons', [])

    if not account_alias or not to or (not message and not title) or not buttons:
        return jsonify({'error': 'Missing required fields: account_id, to, message/title, buttons'}), 400

    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=str(account_alias).strip()).first()
    if not account:
        return jsonify({'error': f"Account '{account_alias}' not found"}), 404

    res = proxy_bridge('POST', f'/session/{account.session_id}/send', {
        'to': to,
        'type': 'buttons',
        'text': message,
        'title': title,
        'footer': footer,
        'media': media,
        'buttons': buttons
    })

    status = 'sent' if res and res.get('success') else 'failed'
    log = MessageLog(
        user_id=user.id,
        account_id=account.id,
        recipient=to,
        message_type='buttons',
        content_preview=(message or title)[:100] + f" [{len(buttons)} CTA Buttons]",
        status=status,
        message_id=res.get('messageId') if res else None,
        error_message=res.get('error') if res else None
    )
    db.session.add(log)
    db.session.commit()

    return jsonify(res)

@app.route('/api/v1/send/location', methods=['POST'])
def api_send_location():
    user = get_user_from_api_key()
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    data = request.json or {}
    account_alias = data.get('account_id')
    to = data.get('to')
    lat = data.get('latitude')
    lng = data.get('longitude')
    name = data.get('name', '')
    address = data.get('address', '')

    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=account_alias).first()
    if not account:
        return jsonify({'error': 'Account not found'}), 404

    res = proxy_bridge('POST', f'/session/{account.session_id}/send', {
        'to': to,
        'type': 'location',
        'latitude': lat,
        'longitude': lng,
        'name': name,
        'address': address
    })

    return jsonify(res)

@app.route('/api/v1/send/reaction', methods=['POST'])
def api_send_reaction():
    user = get_user_from_api_key()
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    data = request.json or {}
    account_alias = data.get('account_id')
    to = data.get('to')
    reaction = data.get('reaction') # e.g. '❤️', '👍'
    key = data.get('key') # WhatsApp message key object

    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=account_alias).first()
    if not account:
        return jsonify({'error': 'Account not found'}), 404

    res = proxy_bridge('POST', f'/session/{account.session_id}/send', {
        'to': to,
        'type': 'reaction',
        'reaction': reaction,
        'key': key
    })

    return jsonify(res)

# ==============================================================================
# UNIVERSAL / LEGACY SEND ENDPOINT (FAHAD STYLES & E-COMMERCE 100% COMPATIBLE)
# ==============================================================================
@app.route('/api/v1/send', methods=['POST'])
def api_send_legacy():
    user = get_user_from_api_key()
    if not user:
        return jsonify({"error": "Unauthorized. Invalid or missing X-API-Key"}), 401

    data = request.json or {}
    account_alias = data.get('account_id') or data.get('account')
    to = data.get('to')
    message = data.get('message') or data.get('text') or ''
    media = data.get('media') or data.get('url')
    buttons = data.get('buttons')
    msg_type = data.get('type')
    if not msg_type:
        if buttons:
            msg_type = 'buttons'
        elif media:
            msg_type = 'image'
        else:
            msg_type = 'text'
    caption = data.get('caption', message)
    file_name = data.get('fileName') or data.get('filename') or 'file.pdf'
    title = data.get('title', '')
    footer = data.get('footer', '')

    if not account_alias or not to or (not message and not media and not title):
        return jsonify({"error": "Missing params. Required: account_id, to, message"}), 400

    clean_alias = str(account_alias).strip()
    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=clean_alias).first()
    if not account:
        # Case-insensitive fallback
        accounts = WhatsappAccount.query.filter_by(user_id=user.id).all()
        for acc in accounts:
            if acc.alias.lower() == clean_alias.lower():
                account = acc
                break

    if not account:
        return jsonify({"error": f"Account '{account_alias}' not found"}), 404

    # Handle bulk or single recipients
    recipients = []
    if isinstance(to, list):
        recipients = to
    elif isinstance(to, str):
        if ',' in to:
            recipients = [num.strip() for num in to.split(',') if num.strip()]
        else:
            recipients = [to.strip()]
    elif isinstance(to, (int, float)):
        recipients = [str(int(to))]

    # Clean duplicates preserving order
    seen = set()
    cleaned_recipients = []
    for r in recipients:
        r_clean = str(r).strip()
        if r_clean and r_clean not in seen:
            seen.add(r_clean)
            cleaned_recipients.append(r_clean)

    if not cleaned_recipients:
        return jsonify({"error": "No valid recipients provided in 'to'"}), 400

    results = []
    success_count = 0
    total = len(cleaned_recipients)

    for recipient in cleaned_recipients:
        try:
            payload = {
                'to': recipient,
                'type': msg_type,
                'message': message,
                'text': message
            }
            if media:
                payload['media'] = media
                payload['caption'] = caption
                payload['fileName'] = file_name
            if buttons:
                payload['buttons'] = buttons
                payload['title'] = title
                payload['footer'] = footer

            bridge_res = proxy_bridge('POST', f'/session/{account.session_id}/send', payload, timeout=25)

            if bridge_res and bridge_res.get('success'):
                success_count += 1
                msg_id = bridge_res.get('messageId')
                target_jid = bridge_res.get('jid') or f"{recipient}@s.whatsapp.net"
                results.append({
                    'to': recipient,
                    'status': 'sent',
                    'response': {
                        'success': True,
                        'messageId': msg_id,
                        'jid': target_jid
                    }
                })
                log = MessageLog(
                    user_id=user.id,
                    account_id=account.id,
                    recipient=recipient,
                    message_type=msg_type,
                    content_preview=(message or caption)[:120],
                    status='sent',
                    message_id=msg_id
                )
                db.session.add(log)
            else:
                err_msg = bridge_res.get('error') if bridge_res else 'Bridge error'
                results.append({
                    'to': recipient,
                    'status': 'failed',
                    'error': err_msg
                })
                log = MessageLog(
                    user_id=user.id,
                    account_id=account.id,
                    recipient=recipient,
                    message_type=msg_type,
                    content_preview=(message or caption)[:120],
                    status='failed',
                    error_message=err_msg
                )
                db.session.add(log)
        except Exception as e:
            results.append({
                'to': recipient,
                'status': 'failed',
                'error': str(e)
            })
            log = MessageLog(
                user_id=user.id,
                account_id=account.id,
                recipient=recipient,
                message_type=msg_type,
                content_preview=(message or caption)[:120],
                status='failed',
                error_message=str(e)
            )
            db.session.add(log)

    db.session.commit()

    overall_status = 'success' if success_count == total else ('partial_success' if success_count > 0 else 'failed')
    return jsonify({
        'status': overall_status,
        'success': success_count > 0,
        'total': total,
        'successful': success_count,
        'failed': total - success_count,
        'details': results
    })

@app.route('/api/v1/sessions', methods=['GET'])
def api_list_sessions():
    user = get_user_from_api_key()
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    accounts = WhatsappAccount.query.filter_by(user_id=user.id).all()
    results = []
    for acc in accounts:
        status_data = proxy_bridge('GET', f'/session/{acc.session_id}/status') or {}
        safety_data = proxy_bridge('GET', f'/session/{acc.session_id}/safety') or {}
        results.append({
            'alias': acc.alias,
            'sessionId': acc.session_id,
            'status': status_data.get('status', 'disconnected'),
            'phoneNumber': acc.phone_number,
            'pushName': acc.push_name,
            'proxyUrl': acc.proxy_url,
            'safety': safety_data
        })

    return jsonify({'success': True, 'sessions': results})

@app.route('/api/v1/sessions/<alias>/qr', methods=['GET'])
def api_session_qr(alias):
    user = get_user_from_api_key()
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=alias).first()
    if not account:
        return jsonify({'error': 'Account not found'}), 404

    res = proxy_bridge('GET', f'/session/{account.session_id}/qr')
    return jsonify(res)

@app.route('/api/v1/sessions/<alias>/pairing-code', methods=['POST'])
def api_session_pairing_code(alias):
    user = get_user_from_api_key()
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=alias).first()
    if not account:
        return jsonify({'error': 'Account not found'}), 404

    phone_number = (request.json or {}).get('phoneNumber')
    if not phone_number:
        return jsonify({'error': 'phoneNumber is required'}), 400

    res = proxy_bridge('POST', '/session/pairing-code', {
        'sessionId': account.session_id,
        'phoneNumber': phone_number
    })
    return jsonify(res)

@app.route('/api/v1/system/health', methods=['GET'])
def api_system_health():
    bridge_res = proxy_bridge('GET', '/health') or {}
    return jsonify({
        'status': 'healthy',
        'timestamp': utcnow().isoformat(),
        'web': {
            'port': WEB_PORT,
            'status': 'online'
        },
        'bridge': bridge_res,
        'resources': {
            'cpuPercent': psutil.cpu_percent(),
            'memoryPercent': psutil.virtual_memory().percent
        }
    })

# ==========================================
# APP INITIALIZATION
# ==========================================
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    # Auto port conflict resolution
    target_port = WEB_PORT
    if is_port_in_use(target_port):
        new_port = find_available_port(target_port)
        print(f"⚠️ Port {target_port} is busy. Automatically using port {new_port}")
        target_port = new_port

    print(f"🚀 Starting TI WhatsApp Web Gateway on http://0.0.0.0:{target_port}")
    app.run(host='0.0.0.0', port=target_port, debug=False)
