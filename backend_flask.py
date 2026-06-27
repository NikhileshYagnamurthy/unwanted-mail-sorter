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

# ── Session cookie config ──────────────────────────────────────────────────────
# IMPORTANT: the extension calls this backend via cross-origin fetch() from a
# chrome-extension:// origin (not a top-level navigation), so the cookie MUST be
# SameSite=None to be sent/received on those requests. SameSite=None requires
# Secure=True, which is fine since Render serves over HTTPS.
app.config['SESSION_COOKIE_SECURE'] = True
app.config['SESSION_COOKIE_HTTPONLY'] = True
app.config['SESSION_COOKIE_SAMESITE'] = 'None'

# ── CORS with credentials ──
# NOTE: flask_cors handles ALL CORS headers here. Do NOT add a manual
# after_request handler on top of this — Access-Control-Allow-Origin: '*'
# is invalid when credentials are involved, and adding headers on top of what
# flask_cors already sets produces duplicate header values that browsers reject.
CORS(app, supports_credentials=True, origins=[
    "chrome-extension://*",
    "http://localhost:*",
    "https://unwanted-mail-sorter.onrender.com"
])

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

if not SUPABASE_KEY:
    logging.warning("⚠️  SUPABASE_KEY is not set — all Supabase reads/writes will silently no-op!")
else:
    logging.info("Supabase configured OK.")

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
        logging.error(f"get_user non-200: {response.status_code} {response.text}")
        return None
    except Exception as e:
        logging.error(f"get_user error: {e}")
        return None

def upsert_user(email: str, data: dict):
    if not SUPABASE_KEY or not SUPABASE_URL:
        return None
    try:
        headers = get_supabase_headers()
        headers["Prefer"] = "resolution=merge-duplicates,return=representation"
        response = requests.post(
            f"{SUPABASE_URL}/rest/v1/users",
            headers=headers,
            json={"email": email, **data},
            verify=True
        )
        if response.status_code in [200, 201]:
            result = response.json()
            return result[0] if result else None
        logging.error(f"upsert_user non-200: {response.status_code} {response.text}")
        return None
    except Exception as e:
        logging.error(f"upsert_user error: {e}")
        return None

def update_user(email: str, data: dict):
    if not SUPABASE_KEY or not SUPABASE_URL:
        return None
    try:
        headers = get_supabase_headers()
        headers["Prefer"] = "return=representation"
        response = requests.patch(
            f"{SUPABASE_URL}/rest/v1/users?email=eq.{email}",
            headers=headers,
            json=data,
            verify=True
        )
        if response.status_code == 200:
            result = response.json()
            return result[0] if result else None
        logging.error(f"update_user non-200: {response.status_code} {response.text}")
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
        session.permanent = True
        logging.info(f"Authenticated: {email}")
        logging.info(f"Session after login: {dict(session)}")
        
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
    logging.info(f"whoami called, session email: {email}")
    
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
    logging.info(f"scan-emails called, session email: {email}")
    logging.info(f"Full session: {dict(session)}")
    
    if not email:
        logging.warning("No email in session, returning 401")
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
        from openai import OpenAI
        client = OpenAI(api_key=openai_key)
        prompt = f"""You are an email security expert. Analyze this email briefly.

Subject: {subject}
From: {sender}
Preview: {snippet}
Pre-classified as: {local.get('category')} (confidence {local.get('confidence')}%)
Signals detected: {', '.join(local.get('reasons', []))}

Explain in 2-3 plain English sentences what this email is and if the user should act on it."""

        response = client.chat.completions.create(
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
    
    currency = (request.json or {}).get("currency", "INR")
    
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


@app.route("/pay")
def pay_page():
    """
    Hosted checkout page. Opened via chrome.tabs.create() from the extension,
    so it's a normal top-level browser tab on our own domain — the session
    cookie is sent normally and Razorpay's checkout.js is allowed to load here
    (unlike inside the extension popup, which is blocked by MV3's CSP).
    """
    email = session.get('user_email')
    currency = request.args.get("currency", "INR")

    if not email:
        return """
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;
                     background:#0f0f13;color:#fff;">
          <h2 style="color:#f87171;">Not logged in</h2>
          <p>Please log in through the extension first, then try upgrading again.</p>
        </body></html>
        """, 401

    if not razorpay_client or not RAZORPAY_KEY_ID:
        return """
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;
                     background:#0f0f13;color:#fff;">
          <h2 style="color:#f87171;">Payments unavailable</h2>
          <p>Razorpay is not configured on the server right now.</p>
        </body></html>
        """, 500

    amount = 119 if currency == "USD" else 1000
    display_price = "$1.19" if currency == "USD" else "₹10"

    try:
        order = razorpay_client.order.create({
            "amount": amount,
            "currency": currency,
            "receipt": f"premium_{email}_{date.today()}",
            "payment_capture": 1,
            "notes": {"email": email},
        })
    except Exception as e:
        logging.exception("Failed to create order on /pay")
        return f"""
        <html><body style="font-family:sans-serif;text-align:center;padding:60px;
                     background:#0f0f13;color:#fff;">
          <h2 style="color:#f87171;">Could not start checkout</h2>
          <p>{str(e)}</p>
        </body></html>
        """, 500

    return f"""
    <html>
    <head>
      <meta charset="UTF-8"/>
      <title>InboxAI — Upgrade to Premium</title>
      <style>
        body {{
          font-family: 'DM Sans', system-ui, sans-serif;
          background:#0f0f13; color:#f0f0f5;
          display:flex; align-items:center; justify-content:center;
          height:100vh; margin:0; text-align:center;
        }}
        .card {{ max-width:360px; padding:32px; }}
        h2 {{ color:#7c6aff; margin-bottom:12px; }}
        p {{ color:#9090a8; font-size:14px; line-height:1.5; }}
        button {{
          background:#7c6aff; color:#fff; border:none; border-radius:8px;
          padding:12px 28px; font-size:14px; font-weight:600; cursor:pointer;
          margin-top:20px;
        }}
        button:disabled {{ opacity:0.5; cursor:not-allowed; }}
        #status {{ margin-top:16px; font-size:13px; }}
      </style>
    </head>
    <body>
      <div class="card">
        <h2>✦ InboxAI Premium</h2>
        <p>Account: {email}</p>
        <p>Amount: {display_price}</p>
        <button id="payBtn">Pay {display_price}</button>
        <div id="status"></div>
      </div>

      <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
      <script>
        document.getElementById("payBtn").addEventListener("click", function () {{
          var btn = document.getElementById("payBtn");
          var status = document.getElementById("status");
          btn.disabled = true;
          status.textContent = "Opening checkout...";

          var options = {{
            key: "{RAZORPAY_KEY_ID}",
            amount: "{amount}",
            currency: "{currency}",
            order_id: "{order['id']}",
            name: "InboxAI",
            description: "Premium subscription",
            prefill: {{ email: "{email}" }},
            notes: {{ email: "{email}" }},
            handler: function (response) {{
              status.style.color = "#9090a8";
              status.textContent = "Verifying payment...";
              fetch("{BACKEND_URL}/payment-callback", {{
                method: "POST",
                credentials: "include",
                headers: {{ "Content-Type": "application/json" }},
                body: JSON.stringify({{
                  razorpay_order_id: response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature: response.razorpay_signature,
                  notes: {{ email: "{email}" }}
                }})
              }})
              .then(function (r) {{ return r.json(); }})
              .then(function (data) {{
                if (data.status === "success") {{
                  status.style.color = "#34d399";
                  status.textContent = "✦ Premium activated! You can close this tab.";
                  btn.style.display = "none";
                  setTimeout(function () {{ window.close(); }}, 2500);
                }} else {{
                  status.style.color = "#f87171";
                  status.textContent = "Payment verification failed: " + (data.error || "unknown error");
                  btn.disabled = false;
                }}
              }})
              .catch(function (err) {{
                status.style.color = "#f87171";
                status.textContent = "Verification request failed: " + err.message;
                btn.disabled = false;
              }});
            }},
            modal: {{
              ondismiss: function () {{
                btn.disabled = false;
                status.textContent = "Checkout closed.";
              }}
            }},
            theme: {{ color: "#7c6aff" }}
          }};

          var rzp = new Razorpay(options);
          rzp.on('payment.failed', function (response) {{
            status.style.color = "#f87171";
            status.textContent = "Payment failed: " + response.error.description;
            btn.disabled = false;
          }});
          rzp.open();
        }});
      </script>
    </body>
    </html>
    """


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
