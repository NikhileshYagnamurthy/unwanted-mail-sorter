"""
InboxAI — Flask Backend
Render URL: https://unwanted-mail-sorter.onrender.com
"""

import os
import json
import logging
from datetime import date
import requests

from flask import Flask, request, jsonify, redirect, session
from flask_cors import CORS
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from scorer import score_email, batch_score, inbox_analytics
import razorpay

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "inboxai-secret-2025")
app.config['SESSION_COOKIE_SECURE'] = False
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'Lax'

CORS(app, supports_credentials=True, origins=[
    "chrome-extension://*",
    "http://localhost:*",
    "https://unwanted-mail-sorter.onrender.com"
])

@app.after_request
def after_request(response):
    response.headers.add('Access-Control-Allow-Origin', '*')
    response.headers.add('Access-Control-Allow-Credentials', 'true')
    response.headers.add('Access-Control-Allow-Headers', 'Content-Type,Authorization')
    response.headers.add('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS')
    return response

logging.basicConfig(level=logging.INFO)

# ── Config ─────────────────────────────────────────────────────────────────────
BACKEND_URL = "https://unwanted-mail-sorter.onrender.com"
GOOGLE_CLIENT_SECRETS_FILE = "/tmp/credentials.json"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly",
]

FREE_TIER_DAILY_SCANS = 5

# ── Supabase Config ──────────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "https://zdjyuqbgpeatbflrkfio.supabase.co")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

# ── Razorpay Config ──────────────────────────────────────────────────────────
RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID")
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET")

razorpay_client = razorpay.Client(
    auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET)
) if RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET else None

# Write credentials.json from environment variable
if os.environ.get("GOOGLE_CREDENTIALS_JSON"):
    with open(GOOGLE_CLIENT_SECRETS_FILE, "w") as f:
        f.write(os.environ["GOOGLE_CREDENTIALS_JSON"])

# ── Gmail label list ───────────────────────────────────────────────────────────
AI_LABELS = [
    "AI/Promotions", "AI/Newsletters", "AI/Social", "AI/Recruiters",
    "AI/Finance", "AI/Orders", "AI/Transactional", "AI/Security",
    "AI/Phishing Risk", "AI/Calendar", "AI/Important",
]


# ── Supabase REST API Functions ──────────────────────────────────────────────
def get_supabase_headers():
    return {
        "apikey": SUPABASE_KEY,
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "Content-Type": "application/json"
    }

def get_user(email: str):
    if not SUPABASE_KEY or not SUPABASE_URL:
        return None
    try:
        headers = get_supabase_headers()
        response = requests.get(
            f"{SUPABASE_URL}/rest/v1/users?email=eq.{email}",
            headers=headers,
            verify=True
        )
        if response.status_code == 200:
            data = response.json()
            return data[0] if data else None
        return None
    except Exception as e:
        logging.error(f"get_user error: {e}")
        return None

def upsert_user(email: str, data: dict):
    if not SUPABASE_KEY or not SUPABASE_URL:
        return None
    try:
        headers = get_supabase_headers()
        headers["Prefer"] = "resolution=merge-duplicates"
        response = requests.post(
            f"{SUPABASE_URL}/rest/v1/users",
            headers=headers,
            json={"email": email, **data},
            verify=True
        )
        if response.status_code in [200, 201]:
            result = response.json()
            return result[0] if result else None
        return None
    except Exception as e:
        logging.error(f"upsert_user error: {e}")
        return None

def update_user(email: str, data: dict):
    if not SUPABASE_KEY or not SUPABASE_URL:
        return None
    try:
        headers = get_supabase_headers()
        response = requests.patch(
            f"{SUPABASE_URL}/rest/v1/users?email=eq.{email}",
            headers=headers,
            json=data,
            verify=True
        )
        if response.status_code == 200:
            result = response.json()
            return result[0] if result else None
        return None
    except Exception as e:
        logging.error(f"update_user error: {e}")
        return None

def check_usage(email: str):
    user = get_user(email)
    today = str(date.today())
    
    if not user:
        user = upsert_user(email, {
            "token": "",
            "is_premium": False,
            "scans_today": 0,
            "last_reset_date": today,
        })
        return user or {"is_premium": False, "scans_today": 0}
    
    if user.get("last_reset_date") != today:
        update_user(email, {"scans_today": 0, "last_reset_date": today})
        user["scans_today"] = 0
    
    return user

def get_token(email: str):
    user = get_user(email)
    if user and user.get("token"):
        return user["token"]
    return None

def set_token(email: str, token: str):
    upsert_user(email, {"token": token})
    return True


# ── Helper functions ───────────────────────────────────────────────────────────
def _creds(email):
    token_json = get_token(email)
    if not token_json:
        return None
    return Credentials.from_authorized_user_info(json.loads(token_json))

def _service(email):
    creds = _creds(email)
    if not creds:
        return None
    return build("gmail", "v1", credentials=creds)

def _get_or_create_label(service, name):
    labels = service.users().labels().list(userId="me").execute().get("labels", [])
    for lbl in labels:
        if lbl["name"].lower() == name.lower():
            return lbl["id"]
    created = service.users().labels().create(
        userId="me",
        body={
            "name": name,
            "labelListVisibility": "labelShow",
            "messageListVisibility": "show",
        },
    ).execute()
    return created["id"]

def _ensure_ai_labels(service):
    label_map = {}
    for name in AI_LABELS:
        label_map[name] = _get_or_create_label(service, name)
    return label_map


# ── Routes ─────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return "InboxAI backend is running!"


@app.route("/login")
def login():
    flow = Flow.from_client_secrets_file(
        GOOGLE_CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri="https://unwanted-mail-sorter.onrender.com/oauth2callback",
    )
    auth_url, _ = flow.authorization_url(access_type="offline", prompt="consent")
    return redirect(auth_url)


@app.route("/oauth2callback")
def oauth2callback():
    try:
        flow = Flow.from_client_secrets_file(
            GOOGLE_CLIENT_SECRETS_FILE,
            scopes=SCOPES,
            redirect_uri="https://unwanted-mail-sorter.onrender.com/oauth2callback",
        )
        flow.fetch_token(authorization_response=request.url)
        creds = flow.credentials
        service = build("gmail", "v1", credentials=creds)
        email = service.users().getProfile(userId="me").execute()["emailAddress"]
        
        set_token(email, creds.to_json())
        session['user_email'] = email
        logging.info(f"Authenticated: {email}")
        
        return """
        <html>
        <body style="font-family:sans-serif;text-align:center;padding:60px;
                     background:#0f0f13;color:#fff;">
          <h2 style="color:#7c6aff;">&#10022; Login Successful!</h2>
          <p>You can close this tab and go back to the extension.</p>
          <script>setTimeout(()=>window.close(), 2000)</script>
        </body>
        </html>
        """
    except Exception as e:
        logging.exception("OAuth failed")
        return jsonify({"error": str(e)}), 500


@app.route("/whoami")
def whoami():
    email = session.get('user_email')
    if not email:
        return jsonify({"email": None})
    
    user = check_usage(email)
    scans_remaining = (
        "unlimited" if user.get("is_premium")
        else max(0, FREE_TIER_DAILY_SCANS - user.get("scans_today", 0))
    )
    
    return jsonify({
        "email": email,
        "scans_today": user.get("scans_today", 0),
        "scans_remaining": scans_remaining,
        "is_premium": user.get("is_premium", False),
    })


@app.route("/logout", methods=["POST"])
def logout():
    session.pop('user_email', None)
    return jsonify({"message": "Logged out"})


@app.route("/scan-emails")
def scan_emails():
    email = session.get('user_email')
    if not email:
        return jsonify({"error": "Not authenticated"}), 401

    user = check_usage(email)
    
    if not user.get("is_premium") and user.get("scans_today", 0) >= FREE_TIER_DAILY_SCANS:
        return jsonify({
            "error": "Daily scan limit reached",
            "limit": FREE_TIER_DAILY_SCANS,
            "upgrade_hint": "Upgrade to premium for unlimited scans.",
        }), 429

    max_results = min(
        int(request.args.get("max", 25)),
        50 if not user.get("is_premium") else 200,
    )
    query = request.args.get("query", "in:inbox")

    try:
        service = _service(email)
        if not service:
            return jsonify({"error": "Not authenticated"}), 401
            
        label_map = _ensure_ai_labels(service)

        results = service.users().messages().list(
            userId="me", maxResults=max_results, q=query
        ).execute()
        messages = results.get("messages", [])

        raw_emails = []
        for msg in messages:
            data = service.users().messages().get(
                userId="me", id=msg["id"], format="metadata",
                metadataHeaders=["Subject", "From", "List-Unsubscribe", "Precedence"],
            ).execute()
            hdrs = {h["name"]: h["value"] for h in data["payload"].get("headers", [])}
            raw_emails.append({
                "id": msg["id"],
                "subject": hdrs.get("Subject", "(no subject)"),
                "from": hdrs.get("From", ""),
                "snippet": data.get("snippet", ""),
                "headers": {
                    "List-Unsubscribe": hdrs.get("List-Unsubscribe", ""),
                    "Precedence": hdrs.get("Precedence", ""),
                },
            })

        scored = batch_score(raw_emails)

        for e in scored:
            label_id = label_map.get(e["label"])
            if label_id:
                body = {"addLabelIds": [label_id]}
                if e.get("archive"):
                    body["removeLabelIds"] = ["INBOX"]
                try:
                    service.users().messages().modify(
                        userId="me", id=e["id"], body=body
                    ).execute()
                except Exception:
                    pass

        analytics = inbox_analytics(scored)

        update_user(email, {"scans_today": user.get("scans_today", 0) + 1})

        return jsonify({
            "emails": scored,
            "analytics": analytics,
            "scans_used": user.get("scans_today", 0) + 1,
            "scans_remaining": (
                "unlimited" if user.get("is_premium")
                else max(0, FREE_TIER_DAILY_SCANS - user.get("scans_today", 0) - 1)
            ),
        })

    except Exception as e:
        logging.exception("scan-emails failed")
        return jsonify({"error": str(e)}), 500


@app.route("/cleanup", methods=["POST"])
def cleanup():
    email = session.get('user_email')
    if not email:
        return jsonify({"error": "Not authenticated"}), 401

    user = check_usage(email)
    data = request.json or {}
    message_ids = data.get("message_ids", [])

    if not user.get("is_premium") and len(message_ids) > 50:
        return jsonify({
            "error": "Free tier cleanup limit is 50 emails at a time.",
            "upgrade_hint": "Upgrade to premium for unlimited bulk cleanup.",
        }), 403

    try:
        service = _service(email)
        if not service:
            return jsonify({"error": "Not authenticated"}), 401
            
        succeeded = 0
        failed = 0
        for mid in message_ids:
            try:
                service.users().messages().modify(
                    userId="me", id=mid,
                    body={"removeLabelIds": ["INBOX"]},
                ).execute()
                succeeded += 1
            except Exception:
                failed += 1

        return jsonify({"cleaned": succeeded, "failed": failed})

    except Exception as e:
        logging.exception("cleanup failed")
        return jsonify({"error": str(e)}), 500


@app.route("/explain-email", methods=["POST"])
def explain_email():
    email = session.get('user_email')
    if not email:
        return jsonify({"error": "Not authenticated"}), 401

    user = check_usage(email)
    if not user.get("is_premium"):
        return jsonify({
            "error": "Premium feature",
            "upgrade_hint": "Upgrade to get AI explanations for suspicious emails.",
        }), 403

    openai_key = os.environ.get("OPENAI_API_KEY")
    if not openai_key:
        return jsonify({"error": "OpenAI not configured on server"}), 500

    data = request.json or {}
    subject = data.get("subject", "")
    sender = data.get("from", "")
    snippet = data.get("snippet", "")
    local = data.get("local_result", {})

    try:
        import openai
        openai.api_key = openai_key
        prompt = f"""You are an email security expert. Analyze this email briefly.

Subject: {subject}
From: {sender}
Preview: {snippet}
Pre-classified as: {local.get('category')} (confidence {local.get('confidence')}%)
Signals detected: {', '.join(local.get('reasons', []))}

Explain in 2-3 plain English sentences what this email is and if the user should act on it."""

        response = openai.chat.completions.create(
            model="gpt-3.5-turbo",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=150,
            temperature=0.3,
        )
        return jsonify({"explanation": response.choices[0].message.content.strip()})
    except Exception as e:
        logging.exception("OpenAI explain failed")
        return jsonify({"error": str(e)}), 500


@app.route("/upgrade", methods=["POST"])
def upgrade():
    email = session.get('user_email')
    if not email:
        return jsonify({"error": "Not authenticated"}), 401
    
    update_user(email, {
        "is_premium": True,
        "premium_since": str(date.today())
    })
    
    return jsonify({"message": f"{email} upgraded to premium", "is_premium": True})


# ── Razorpay Payment Routes ────────────────────────────────────────────────────

@app.route("/create-order", methods=["POST"])
def create_order():
    if not razorpay_client:
        return jsonify({"error": "Razorpay not configured"}), 500
    
    email = session.get('user_email')
    if not email:
        return jsonify({"error": "Not authenticated"}), 401
    
    currency = request.json.get("currency", "INR")
    
    if currency == "USD":
        amount = 119
    else:
        amount = 1000
    
    try:
        order_data = {
            "amount": amount,
            "currency": currency,
            "receipt": f"premium_{email}_{date.today()}",
            "payment_capture": 1,
            "notes": {"email": email}
        }
        
        order = razorpay_client.order.create(order_data)
        return jsonify({
            "order_id": order["id"],
            "amount": order["amount"],
            "currency": order["currency"]
        })
    except Exception as e:
        logging.error(f"Razorpay order creation failed: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/payment-callback", methods=["POST"])
def payment_callback():
    try:
        data = request.json
        logging.info(f"Payment callback received: {data}")
        
        razorpay_client.utility.verify_payment_signature(data)
        
        email = data.get("notes", {}).get("email")
        if not email:
            email = data.get("prefill", {}).get("email")
        
        if email:
            update_user(email, {
                "is_premium": True,
                "premium_since": str(date.today())
            })
            logging.info(f"✅ Premium activated for {email}")
            return jsonify({
                "status": "success",
                "message": "Premium activated!",
                "email": email
            })
        
        return jsonify({"error": "User not found"}), 404
            
    except razorpay.errors.SignatureVerificationError:
        logging.error("Payment signature verification failed")
        return jsonify({"error": "Invalid signature"}), 400
    except Exception as e:
        logging.error(f"Payment callback failed: {e}")
        return jsonify({"error": str(e)}), 400


@app.route("/razorpay-key", methods=["GET"])
def get_razorpay_key():
    if not RAZORPAY_KEY_ID:
        return jsonify({"error": "Razorpay not configured"}), 500
    return jsonify({"key_id": RAZORPAY_KEY_ID})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
