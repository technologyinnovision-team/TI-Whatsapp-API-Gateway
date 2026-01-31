from flask import Flask, render_template, request, redirect, url_for, jsonify, abort
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, login_required, logout_user, current_user
from werkzeug.security import generate_password_hash, check_password_hash
import requests
import uuid
import os
import secrets
from urllib.parse import quote_plus
from concurrent.futures import ThreadPoolExecutor, as_completed
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.config['SECRET_KEY'] = 'your-secret-key-change-in-production' # Change this!

db_user = os.getenv('DB_USERNAME')
db_password = os.getenv('DB_PASSWORD')
db_host = os.getenv('DB_HOST')
db_name = os.getenv('DB_NAME')

app.config['SQLALCHEMY_DATABASE_URI'] = f'mysql+pymysql://{quote_plus(db_user)}:{quote_plus(db_password)}@{db_host}/{db_name}'

db = SQLAlchemy(app)
login_manager = LoginManager()
login_manager.init_app(app)
login_manager.login_view = 'login'

BRIDGE_URL = "http://localhost:3000"

# --- Models ---
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(150), unique=True, nullable=False)
    password = db.Column(db.String(255), nullable=False)
    api_key = db.Column(db.String(64), unique=True, nullable=False)
    accounts = db.relationship('WhatsappAccount', backref='owner', lazy=True)

class WhatsappAccount(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    alias = db.Column(db.String(50), nullable=False) # User provided ID (e.g., 'marketing')
    session_id = db.Column(db.String(36), unique=True, nullable=False) # Internal UUID
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)

@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

# --- Utils ---
def generate_api_key():
    return secrets.token_hex(32)

def proxy_request(method, endpoint, json=None):
    try:
        url = f"{BRIDGE_URL}{endpoint}"
        if method == 'GET':
            return requests.get(url).json()
        elif method == 'POST':
            return requests.post(url, json=json).json()
        elif method == 'DELETE':
            return requests.delete(url).json()
    except:
        return None

# --- Routes: Auth ---

@app.route('/')
def index():
    if current_user.is_authenticated:
        return redirect(url_for('dashboard'))
    return redirect(url_for('login'))

@app.route('/signup', methods=['GET', 'POST'])
def signup():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        
        if User.query.filter_by(username=username).first():
            return render_template('signup.html', error="Username already exists")
        
        new_user = User(
            username=username, 
            password=generate_password_hash(password, method='scrypt'),
            api_key=generate_api_key()
        )
        db.session.add(new_user)
        db.session.commit()
        login_user(new_user)
        return redirect(url_for('dashboard'))
    return render_template('signup.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        username = request.form.get('username')
        password = request.form.get('password')
        user = User.query.filter_by(username=username).first()
        
        if user and check_password_hash(user.password, password):
            login_user(user)
            return redirect(url_for('dashboard'))
        return render_template('login.html', error="Invalid credentials")
    return render_template('login.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

# --- Routes: Dashboard ---

@app.route('/dashboard')
@login_required
def dashboard():
    return render_template('dashboard.html', user=current_user)

@app.route('/account/add', methods=['POST'])
@login_required
def add_account():
    alias = request.form.get('alias')
    if not alias: return "Alias required", 400
    
    # Check if alias exists for this user
    if WhatsappAccount.query.filter_by(user_id=current_user.id, alias=alias).first():
        return "Alias already exists", 400

    session_id = str(uuid.uuid4())
    
    # Init session in bridge
    res = proxy_request('POST', '/session/init', {'sessionId': session_id})
    if not res or not res.get('success'):
        return "Bridge Error", 500
        
    new_account = WhatsappAccount(alias=alias, session_id=session_id, owner=current_user)
    db.session.add(new_account)
    db.session.commit()
    
    return redirect(url_for('view_account', id=new_account.id))

@app.route('/account/<int:id>')
@login_required
def view_account(id):
    account = WhatsappAccount.query.get_or_404(id)
    if account.user_id != current_user.id: abort(403)
    return render_template('account.html', account=account)

@app.route('/account/<int:id>/status_json')
@login_required
def account_status(id):
    account = WhatsappAccount.query.get_or_404(id)
    if account.user_id != current_user.id: abort(403)
    
    status = proxy_request('GET', f'/session/{account.session_id}/status')
    qr = proxy_request('GET', f'/session/{account.session_id}/qr')
    
    return jsonify({
        'status': status.get('status') if status else 'error',
        'qrImage': qr.get('qrImage') if qr else None
    })

@app.route('/account/<int:id>/delete', methods=['POST'])
@login_required
def delete_account(id):
    account = WhatsappAccount.query.get_or_404(id)
    if account.user_id != current_user.id: abort(403)
    
    proxy_request('DELETE', f'/session/{account.session_id}')
    db.session.delete(account)
    db.session.commit()
    
    return redirect(url_for('dashboard'))

@app.route('/account/<int:id>/reconnect', methods=['POST'])
@login_required
def reconnect_account(id):
    account = WhatsappAccount.query.get_or_404(id)
    if account.user_id != current_user.id: abort(403)
    
    # Re-init session in bridge
    res = proxy_request('POST', '/session/init', {'sessionId': account.session_id})
    if not res or not res.get('success'):
        # Just try to redirect anyway, maybe it just needs a refresh
        pass
        
    return redirect(url_for('view_account', id=account.id))

# --- Routes: Public API ---

def get_user_from_api_key():
    key = request.headers.get('X-API-Key')
    if not key: return None
    return User.query.filter_by(api_key=key).first()

@app.route('/api/v1/send', methods=['POST'])
def api_send_message():
    user = get_user_from_api_key()
    if not user:
        return jsonify({"error": "Unauthorized. Invalid or missing X-API-Key"}), 401
    
    data = request.json
    account_alias = data.get('account_id')
    to = data.get('to')
    message = data.get('message')
    
    if not account_alias or not to or not message:
        return jsonify({"error": "Missing params"}), 400
        
    account = WhatsappAccount.query.filter_by(user_id=user.id, alias=account_alias).first()
    if not account:
        return jsonify({"error": f"Account '{account_alias}' not found"}), 404
        
    # Handle bulk send
    recipients = []
    
    if isinstance(to, list):
        recipients = to
    elif isinstance(to, str):
        # Handle "123,456" and "123" cases
        if ',' in to:
            recipients = [num.strip() for num in to.split(',') if num.strip()]
        else:
            recipients = [to]
            
    # Clean duplicates
    recipients = list(set(recipients))
    
    results = []
    success_count = 0
    total = len(recipients)
    
    def send_single(recipient):
        try:
            url = f"{BRIDGE_URL}/session/{account.session_id}/send"
            bridge_res = requests.post(url, json={'to': recipient, 'message': message}, timeout=10)
            if bridge_res.status_code == 200:
                return {'to': recipient, 'status': 'sent', 'response': bridge_res.json()}
            else:
                return {'to': recipient, 'status': 'failed', 'error': bridge_res.text}
        except Exception as e:
            return {'to': recipient, 'status': 'failed', 'error': str(e)}

    # Execute in parallel with max 10 workers
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(send_single, recipient): recipient for recipient in recipients}
        
        for future in as_completed(futures):
            res = future.result()
            results.append(res)
            if res['status'] == 'sent':
                success_count += 1

    return jsonify({
        'status': 'partial_success' if success_count < total else 'success',
        'total': total,
        'successful': success_count,
        'failed': total - success_count,
        'details': results
    })

# --- Routes: Docs ---
@app.route('/docs')
def docs():
    return render_template('redoc.html')


# --- Init DB ---
with app.app_context():
    db.create_all()

if __name__ == '__main__':
    app.run(debug=True, port=5000)
