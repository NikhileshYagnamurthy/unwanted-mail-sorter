"""
InboxAI — Flask Backend
Render URL: https://unwanted-mail-sorter.onrender.com
"""

import os
import json
import logging
from datetime import date

from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from scorer import score_email, batch_score, inbox_analytics
import razorpay

# ── Supabase ──────────────────────────────────────────────────────────────────
from supabase import create_client, Client

app = Flask(__name__)
CORS(app, supports_credentials=True)
app.secret_key = os.environ.get("SECRET_KEY", "inboxai-secret-2025")

logging.basicConfig(level=logging.INFO)

# ── Config ─────────────────────────────────────────────────────────────────────
BACKEND_URL = "https://unwanted-mail-sorter.onrender.com"
GOOGLE_CLIENT_SECRETS_FILE = "/tmp/credentials.json"

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly",
]

FREE_TIER_DAILY_SCANS = 5

# ── Supabase Client ───────────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY) if SUPABASE_URL and SUPABASE_KEY else None

# ── Razorpay Config ──────────────────────────────────────────────────────────
RAZORPAY_KEY_ID = os.environ.get("RAZORPAY_KEY_ID")
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET")

razorpay_client = razorpay.Client(
    auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET)
) if RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET else None

# Write credentials.json from environment variable set on Render
if os.environ.get("GOOGLE_CREDENTIALS_JSON"):
    with open(GOOGLE_CLIENT_SECRETS_FILE, "w") as f:
        f.write(os.environ["GOOGLE_CREDENTIALS_JSON"])

# ── Gmail label list ───────────────────────────────────────────────────────────
AI_LABELS = [
    "AI/Promotions", "AI/Newsletters", "AI/Social", "AI/Recruiters",
    "AI/Finance", "AI/Orders", "AI/Transactional", "AI/Security",
    "AI/Phishing Risk", "AI/Calendar", "AI/Important",
]


# ── Database Functions ────────────────────────────────────────────────────────
def get_user(email: str):
    """Get user from Supabase."""
    if not supabase:
        return None
    try:
        result = supabase.table("users").select("*").eq("email", email).execute()
        return result.data[0] if result.data else None
    except Exception as e:
        logging.error(f"get_user error: {e}")
        return None

def upsert_user(email: str, data: dict):
    """Insert or update user in Supabase."""
    if not supabase:
        return None
    try:
        result = supabase.table("users").upsert({"email": email, **data}).execute()
        return result.data[0] if result.data else None
    except Exception as e:
        logging.error(f"upsert_user error: {e}")
        return None

def update_user(email: str, data: dict):
    """Update user in Supabase."""
    if not supabase:
        return None
    try:
        result = supabase.table("users").update(data).eq("email", email).execute()
        return result.data[0] if result.data else None
    except Exception as e:
        logging.error(f"update_user error: {e}")
        return None

def check_usage(email: str):
    """Check and update user usage."""
    user = get_user(email)
    today = str(date.today())
    
    if not user:
        # Create new user
        user = upsert_user(email, {
            "token": "",
            "is_premium": False,
            "scans_today": 0,
            "last_reset_date": today,
        })
        return user or {"is_premium": False, "scans_today": 0}
    
    # Reset scans if new day
    if user.get("last_reset_date") != today:
        update_user(email, {"scans_today": 0, "last_reset_date": today})
        user["scans_today"] = 0
    
    return user

def get_token(email: str):
    """Get stored Gmail token."""
    user = get_user(email)
    if user and user.get("token"):
        return user["token"]
    return None

def set_token(email: str, token: str):
    """Store Gmail token."""
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


def _current_user():
    # Get user from session - simplified for now
    # In production, use session cookies
    return None


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
        
        # Store token in Supabase
        set_token(email, creds.to_json())
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
    # Get email from request (simplified)
    email = request.headers.get("X-User-Email") or request.args.get("email")
    
    if not email:
        # Try to get from session (simplified - just return null for now)
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
    email = request.headers.get("X-User-Email") or request.json.get("email")
    if email:
        # Remove token from Supabase
        update_user(email, {"token": ""})
    return jsonify({"message": "Logged out"})


@app.route("/scan-emails")
def scan_emails():
    email = request.headers.get("X-User-Email") or request.args.get("email")
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

        # Update usage in database
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
    email = request.headers.get("X-User-Email") or request.json.get("email")
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
    email = request.headers.get("X-User-Email") or request.json.get("email")
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
    email = request.json.get("email")
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
    
    email = request.json.get("email")
    if not email:
        return jsonify({"error": "Not authenticated"}), 401
    
    currency = request.json.get("currency", "INR")
    
    if currency == "USD":
        amount = 119
    else:
        amount = 1000  # ₹10 for testing
    
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
