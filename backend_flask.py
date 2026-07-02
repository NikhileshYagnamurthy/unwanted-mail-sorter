"""
InboxAI — Flask Backend (Production Ready)
Render URL: https://unwanted-mail-sorter.onrender.com
"""

import os
import json
import logging
import time
from datetime import date
from abc import ABC, abstractmethod
import requests
import jwt

from flask import Flask, request, jsonify, redirect, session
from flask_cors import CORS
from google.oauth2 import id_token
from google.auth.transport import requests as google_requests

import razorpay

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "inboxai-secret-2025")

# ── Logging Configuration ──────────────────────────────────────────────────────
# Using structured-like logging for production audit trails
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger("inboxai")

# ── Session cookie config ──────────────────────────────────────────────────────
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'None'

CORS(app, supports_credentials=True, origins=[
    "chrome-extension://*",
    "http://localhost:*",
    "https://unwanted-mail-sorter.onrender.com"
])

# ── Config ─────────────────────────────────────────────────────────────────────
BACKEND_URL = "https://unwanted-mail-sorter.onrender.com"
JWT_SECRET = os.environ.get("JWT_SECRET", app.secret_key)
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID")
FREE_TIER_DAILY_SCANS = 5

# ── Supabase Config ──────────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://zdjyuqbgpeatbflrkfio.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# ── Payment Abstraction Layer ──────────────────────────────────────────────────
class PaymentProvider(ABC):
    @abstractmethod
    def create_order(self, email, amount, currency):
        pass

    @abstractmethod
    def verify_payment(self, data):
        pass

class RazorpayProvider(PaymentProvider):
    def __init__(self):
        self.key_id = os.environ.get("RAZORPAY_KEY_ID")
        self.key_secret = os.environ.get("RAZORPAY_KEY_SECRET")
        if self.key_id and self.key_secret:
            self.client = razorpay.Client(auth=(self.key_id, self.key_secret))
        else:
            self.client = None

    def create_order(self, email, amount, currency):
        if not self.client:
            raise Exception("Razorpay not configured")
        order_data = {
            "amount": amount,
            "currency": currency,
            "receipt": f"premium_{email}_{date.today()}",
            "payment_capture": 1,
            "notes": {"email": email}
        }
        return self.client.order.create(order_data)

    def verify_payment(self, data):
        if not self.client:
            raise Exception("Razorpay not configured")
        self.client.utility.verify_payment_signature(data)
        return data.get("notes", {}).get("email") or data.get("prefill", {}).get("email")

# Initialize payment service
payment_service = RazorpayProvider()

# ── Supabase REST API Functions ──────────────────────────────────────────────
def get_supabase_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json"
    }

def get_user(email: str):
    if not SUPABASE_KEY or not SUPABASE_URL: return None
    try:
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/users?email=eq.{email}",
            headers=get_supabase_headers()
        )
        if response.status_code == 200:
            data = response.json()
            return data[0] if data else None
    except Exception as e:
        logger.error(f"DB Error (get_user): {e}")
    return None

def upsert_user(email: str, data: dict):
    if not SUPABASE_KEY or not SUPABASE_URL: return None
    try:
        headers = get_supabase_headers()
        headers["Prefer"] = "resolution=merge-duplicates,return=representation"
        response = requests.post(
            f"{SUPABASE_URL}/rest/v1/users",
            headers=headers,
            json={"email": email, **data}
        )
        if response.status_code in [200, 201]:
            result = response.json()
            return result[0] if result else None
    except Exception as e:
        logger.error(f"DB Error (upsert_user): {e}")
    return None

def update_user(email: str, data: dict):
    if not SUPABASE_KEY or not SUPABASE_URL: return None
    try:
        headers = get_supabase_headers()
        headers["Prefer"] = "return=representation"
        response = requests.patch(
            f"{SUPABASE_URL}/rest/v1/users?email=eq.{email}",
            headers=headers,
            json=data
        )
        if response.status_code == 200:
            result = response.json()
            return result[0] if result else None
    except Exception as e:
        logger.error(f"DB Error (update_user): {e}")
    return None

def check_usage(email: str):
    user = get_user(email)
    today = str(date.today())
    if not user:
        user = upsert_user(email, {
            "is_premium": False,
            "scans_today": 0,
            "last_reset_date": today,
        })
        return user or {"is_premium": False, "scans_today": 0}
    if user.get("last_reset_date") != today:
        update_user(email, {"scans_today": 0, "last_reset_date": today})
        user["scans_today"] = 0
    return user

# ── Authentication Helpers ─────────────────────────────────────────────────────
def verify_google_token(token):
    try:
        idinfo = id_token.verify_oauth2_token(token, google_requests.Request(), GOOGLE_CLIENT_ID)
        return idinfo['email']
    except Exception:
        try:
            resp = requests.get(f"https://oauth2.googleapis.com/tokeninfo?access_token={token}")
            if resp.status_code == 200:
                return resp.json().get("email")
        except Exception as e:
            logger.error(f"Auth Error (Google Token): {e}")
    return None

def create_backend_token(email):
    payload = {"email": email, "exp": time.time() + 3600}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def verify_backend_token(token):
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        return payload.get("email")
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None

def get_authenticated_user():
    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split(" ")[1]
        email = verify_backend_token(token)
        if email: return email
    return session.get('user_email')

# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return "InboxAI backend is running!"

@app.route("/auth/verify-google", methods=["POST"])
def auth_verify_google():
    data = request.json or {}
    token_str = data.get("id_token")
    if not token_str:
        return jsonify({"error": "No token provided"}), 400
    email = verify_google_token(token_str)
    if not email:
        logger.warning(f"Auth Failed: Invalid Google token.")
        return jsonify({"error": "Invalid Google token"}), 401
    check_usage(email)
    logger.info(f"Auth Success: {email}")
    return jsonify({"token": create_backend_token(email), "email": email})

@app.route("/whoami")
def whoami():
    email = get_authenticated_user()
    if not email: return jsonify({"email": None})
    user = check_usage(email)
    return jsonify({
        "email": email,
        "scans_today": user.get("scans_today", 0),
        "is_premium": user.get("is_premium", False),
    })

@app.route("/usage/increment-scan", methods=["POST"])
def increment_scan():
    email = get_authenticated_user()
    if not email: return jsonify({"error": "Not authenticated"}), 401
    user = check_usage(email)
    scans_today = user.get("scans_today", 0)
    if not user.get("is_premium") and scans_today >= FREE_TIER_DAILY_SCANS:
        logger.warning(f"Usage Limit: {email} hit daily scan limit.")
        return jsonify({"error": "Daily scan limit reached"}), 429
    update_user(email, {"scans_today": scans_today + 1})
    logger.info(f"Usage Update: {email} performed a scan.")
    return jsonify({"success": True, "scans_today": scans_today + 1})

@app.route("/usage/validate-cleanup", methods=["POST"])
def validate_cleanup():
    email = get_authenticated_user()
    if not email: return jsonify({"error": "Not authenticated"}), 401
    user = check_usage(email)
    count = (request.json or {}).get("count", 0)
    if not user.get("is_premium") and count > 50:
        logger.warning(f"Usage Limit: {email} attempted bulk cleanup of {count} emails.")
        return jsonify({"error": "Free tier limit is 50 emails"}), 403
    return jsonify({"success": True})

@app.route("/explain-email", methods=["POST"])
def explain_email():
    email = get_authenticated_user()
    if not email: return jsonify({"error": "Not authenticated"}), 401
    user = check_usage(email)
    if not user.get("is_premium"):
        return jsonify({"error": "Premium feature"}), 403
    
    openai_key = os.environ.get("OPENAI_API_KEY")
    if not openai_key: return jsonify({"error": "OpenAI not configured"}), 500
    
    data = request.json or {}
    try:
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        prompt = f"Analyze this email briefly: Subject: {data.get('subject')} From: {data.get('from')} Snippet: {data.get('snippet')}"
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=100
        )
        logger.info(f"AI Feature: {email} requested email explanation.")
        return jsonify({"explanation": response.choices[0].message.content.strip()})
    except Exception as e:
        logger.error(f"AI Error: {e}")
        return jsonify({"error": "AI service failed"}), 500

@app.route("/upgrade", methods=["POST"])
def upgrade():
    email = get_authenticated_user()
    if not email: return jsonify({"error": "Not authenticated"}), 401
    update_user(email, {"is_premium": True, "premium_since": str(date.today())})
    logger.info(f"Premium Event: {email} manually upgraded to premium.")
    return jsonify({"is_premium": True})

@app.route("/create-order", methods=["POST"])
def create_order():
    email = get_authenticated_user()
    if not email: return jsonify({"error": "Not authenticated"}), 401
    currency = (request.json or {}).get("currency", "INR")
    amount = 119 if currency == "USD" else 1000
    try:
        order = payment_service.create_order(email, amount, currency)
        return jsonify({"order_id": order["id"], "amount": order["amount"], "currency": order["currency"]})
    except Exception as e:
        logger.error(f"Payment Error (Order): {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/payment-callback", methods=["POST"])
def payment_callback():
    try:
        email = payment_service.verify_payment(request.json)
        if email:
            update_user(email, {"is_premium": True, "premium_since": str(date.today())})
            logger.info(f"Payment Success: Premium activated for {email}.")
            return jsonify({"status": "success", "email": email})
        return jsonify({"error": "User not found"}), 404
    except Exception as e:
        logger.error(f"Payment Error (Callback): {e}")
        return jsonify({"error": str(e)}), 400

@app.route("/pay")
def pay_page():
    email = get_authenticated_user()
    if not email: return "Not logged in", 401
    # Simple hosted checkout placeholder
    return f"<html><body><h2>✦ InboxAI Premium</h2><p>Account: {email}</p><p>Payment abstraction active. Use extension to trigger Razorpay.</p></body></html>"

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 10000)))
