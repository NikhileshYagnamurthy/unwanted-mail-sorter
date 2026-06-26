"""
InboxAI — Flask Backend
Render URL: https://unwanted-mail-sorter.onrender.com
"""

import os
import json
import logging
import hmac
import hashlib
from datetime import date

from flask import Flask, request, jsonify, redirect, render_template_string
from flask_cors import CORS
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build

from scorer import score_email, batch_score, inbox_analytics

import razorpay

app = Flask(__name__)

# ── CORS: explicit origins only (required for credentials: "include") ──────────
CORS(app,
     supports_credentials=True,
     origins=[
         "chrome-extension://",   # filled at runtime by Chrome
         "https://unwanted-mail-sorter.onrender.com",
     ],
     allow_headers=["Content-Type"],
     methods=["GET", "POST", "OPTIONS"])

# Allow ALL origins for non-credentialed preflight — needed for extension
@app.after_request
def add_cors(response):
    origin = request.headers.get("Origin", "")
    if origin.startswith("chrome-extension://") or origin == "https://unwanted-mail-sorter.onrender.com":
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return response

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

# ── Razorpay Config ────────────────────────────────────────────────────────────
RAZORPAY_KEY_ID     = os.environ.get("RAZORPAY_KEY_ID")
RAZORPAY_KEY_SECRET = os.environ.get("RAZORPAY_KEY_SECRET")
razorpay_client = razorpay.Client(
    auth=(RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET)
) if RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET else None

# Write credentials.json from Render env var
if os.environ.get("GOOGLE_CREDENTIALS_JSON"):
    with open(GOOGLE_CLIENT_SECRETS_FILE, "w") as f:
        f.write(os.environ["GOOGLE_CREDENTIALS_JSON"])

# ── In-memory stores ───────────────────────────────────────────────────────────
USER_TOKENS = {}   # { email: creds_json_string }
USAGE_LOG   = {}   # { email: { date, scans, is_premium } }

# ── Gmail label list ───────────────────────────────────────────────────────────
AI_LABELS = [
    "AI/Promotions", "AI/Newsletters", "AI/Social", "AI/Recruiters",
    "AI/Finance", "AI/Orders", "AI/Transactional", "AI/Security",
    "AI/Phishing Risk", "AI/Calendar", "AI/Important",
]


# ── Helpers ────────────────────────────────────────────────────────────────────
def _creds(email):
    return Credentials.from_authorized_user_info(json.loads(USER_TOKENS[email]))

def _service(email):
    return build("gmail", "v1", credentials=_creds(email))

def _get_or_create_label(service, name):
    labels = service.users().labels().list(userId="me").execute().get("labels", [])
    for lbl in labels:
        if lbl["name"].lower() == name.lower():
            return lbl["id"]
    created = service.users().labels().create(
        userId="me",
        body={"name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show"},
    ).execute()
    return created["id"]

def _ensure_ai_labels(service):
    label_map = {}
    for name in AI_LABELS:
        label_map[name] = _get_or_create_label(service, name)
    return label_map

def _check_usage(email):
    today = str(date.today())
    entry = USAGE_LOG.get(email, {"date": today, "scans": 0, "is_premium": False})
    if entry["date"] != today:
        entry = {"date": today, "scans": 0, "is_premium": entry.get("is_premium", False)}
    USAGE_LOG[email] = entry
    return entry

def _current_user():
    return list(USER_TOKENS.keys())[0] if USER_TOKENS else None


# ── Basic routes ───────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return "InboxAI backend is running!"

@app.route("/login")
def login():
    flow = Flow.from_client_secrets_file(
        GOOGLE_CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=f"{BACKEND_URL}/oauth2callback",
    )
    auth_url, _ = flow.authorization_url(access_type="offline", prompt="consent")
    return redirect(auth_url)

@app.route("/oauth2callback")
def oauth2callback():
    try:
        flow = Flow.from_client_secrets_file(
            GOOGLE_CLIENT_SECRETS_FILE,
            scopes=SCOPES,
            redirect_uri=f"{BACKEND_URL}/oauth2callback",
        )
        flow.fetch_token(authorization_response=request.url)
        creds = flow.credentials
        service = build("gmail", "v1", credentials=creds)
        email = service.users().getProfile(userId="me").execute()["emailAddress"]
        USER_TOKENS[email] = creds.to_json()
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
    email = _current_user()
    if not email:
        return jsonify({"email": None})
    usage = _check_usage(email)
    return jsonify({
        "email":           email,
        "scans_today":     usage["scans"],
        "scans_remaining": "unlimited" if usage["is_premium"] else max(0, FREE_TIER_DAILY_SCANS - usage["scans"]),
        "is_premium":      usage["is_premium"],
    })

@app.route("/logout", methods=["POST"])
def logout():
    email = _current_user()
    if email:
        USER_TOKENS.pop(email, None)
    return jsonify({"message": "Logged out"})


# ── Core email routes ──────────────────────────────────────────────────────────

@app.route("/scan-emails")
def scan_emails():
    email = _current_user()
    if not email:
        return jsonify({"error": "Not authenticated"}), 401

    usage = _check_usage(email)
    if not usage["is_premium"] and usage["scans"] >= FREE_TIER_DAILY_SCANS:
        return jsonify({
            "error": "Daily scan limit reached",
            "limit": FREE_TIER_DAILY_SCANS,
            "upgrade_hint": "Upgrade to premium for unlimited scans.",
        }), 429

    max_results = min(int(request.args.get("max", 25)), 50 if not usage["is_premium"] else 200)
    query = request.args.get("query", "in:inbox")

    try:
        service  = _service(email)
        label_map = _ensure_ai_labels(service)

        results  = service.users().messages().list(userId="me", maxResults=max_results, q=query).execute()
        messages = results.get("messages", [])

        raw_emails = []
        for msg in messages:
            data = service.users().messages().get(
                userId="me", id=msg["id"], format="metadata",
                metadataHeaders=["Subject", "From", "List-Unsubscribe", "Precedence"],
            ).execute()
            hdrs = {h["name"]: h["value"] for h in data["payload"].get("headers", [])}
            raw_emails.append({
                "id":      msg["id"],
                "subject": hdrs.get("Subject", "(no subject)"),
                "from":    hdrs.get("From", ""),
                "snippet": data.get("snippet", ""),
                "headers": {
                    "List-Unsubscribe": hdrs.get("List-Unsubscribe", ""),
                    "Precedence":       hdrs.get("Precedence", ""),
                },
            })

        scored    = batch_score(raw_emails)
        analytics = inbox_analytics(scored)

        for e in scored:
            label_id = label_map.get(e["label"])
            if label_id:
                body = {"addLabelIds": [label_id]}
                if e.get("archive"):
                    body["removeLabelIds"] = ["INBOX"]
                try:
                    service.users().messages().modify(userId="me", id=e["id"], body=body).execute()
                except Exception:
                    pass

        usage["scans"] += 1
        USAGE_LOG[email] = usage

        return jsonify({
            "emails":          scored,
            "analytics":       analytics,
            "scans_used":      usage["scans"],
            "scans_remaining": "unlimited" if usage["is_premium"] else max(0, FREE_TIER_DAILY_SCANS - usage["scans"]),
        })

    except Exception as e:
        logging.exception("scan-emails failed")
        return jsonify({"error": str(e)}), 500


@app.route("/cleanup", methods=["POST"])
def cleanup():
    email = _current_user()
    if not email:
        return jsonify({"error": "Not authenticated"}), 401

    usage = _check_usage(email)
    data  = request.json or {}
    message_ids = data.get("message_ids", [])

    if not usage["is_premium"] and len(message_ids) > 50:
        return jsonify({
            "error": "Free tier cleanup limit is 50 emails at a time.",
            "upgrade_hint": "Upgrade to premium for unlimited bulk cleanup.",
        }), 403

    try:
        service   = _service(email)
        succeeded = 0
        failed    = 0
        for mid in message_ids:
            try:
                service.users().messages().modify(
                    userId="me", id=mid, body={"removeLabelIds": ["INBOX"]}
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
    email = _current_user()
    if not email:
        return jsonify({"error": "Not authenticated"}), 401

    usage = _check_usage(email)
    if not usage["is_premium"]:
        return jsonify({"error": "Premium feature"}), 403

    openai_key = os.environ.get("OPENAI_API_KEY")
    if not openai_key:
        return jsonify({"error": "OpenAI not configured"}), 500

    data    = request.json or {}
    subject = data.get("subject", "")
    sender  = data.get("from", "")
    snippet = data.get("snippet", "")
    local   = data.get("local_result", {})

    try:
        import openai
        openai.api_key = openai_key
        prompt = f"""You are an email security expert. Analyze this email briefly.
Subject: {subject}
From: {sender}
Preview: {snippet}
Pre-classified as: {local.get('category')} (confidence {local.get('confidence')}%)
Signals: {', '.join(local.get('reasons', []))}
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


# ── Razorpay: key + order ──────────────────────────────────────────────────────

@app.route("/razorpay-key")
def get_razorpay_key():
    if not RAZORPAY_KEY_ID:
        return jsonify({"error": "Razorpay not configured"}), 500
    return jsonify({"key_id": RAZORPAY_KEY_ID})


@app.route("/create-order", methods=["POST"])
def create_order():
    if not razorpay_client:
        return jsonify({"error": "Razorpay not configured"}), 500

    email = _current_user()
    if not email:
        return jsonify({"error": "Not authenticated"}), 401

    data     = request.json or {}
    currency = data.get("currency", "INR")
    amount   = 119 if currency == "USD" else 1000  # ₹10 test / $1.19

    try:
        order = razorpay_client.order.create({
            "amount":          amount,
            "currency":        currency,
            "receipt":         f"premium_{email}_{date.today()}",
            "payment_capture": 1,
            "notes":           {"email": email},
        })
        return jsonify({
            "order_id": order["id"],
            "amount":   order["amount"],
            "currency": order["currency"],
        })
    except Exception as e:
        logging.error(f"Razorpay order creation failed: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/payment-callback", methods=["POST"])
def payment_callback():
    """
    Verify Razorpay signature and mark user as premium.
    Called from the hosted /pay page (not from the extension directly).
    """
    try:
        data = request.json or {}

        # ── Signature verification ─────────────────────────────────────────────
        # Only pass the 3 required fields — extra fields break verification
        razorpay_client.utility.verify_payment_signature({
            "razorpay_payment_id": data["razorpay_payment_id"],
            "razorpay_order_id":   data["razorpay_order_id"],
            "razorpay_signature":  data["razorpay_signature"],
        })

        # ── Activate premium ───────────────────────────────────────────────────
        email = data.get("email", "")
        if not email:
            return jsonify({"error": "Email missing"}), 400

        USAGE_LOG.setdefault(email, {"date": str(date.today()), "scans": 0})
        USAGE_LOG[email]["is_premium"]     = True
        USAGE_LOG[email]["premium_since"]  = str(date.today())
        logging.info(f"Premium activated: {email}")

        return jsonify({"status": "success", "message": "Premium activated!", "email": email})

    except razorpay.errors.SignatureVerificationError:
        logging.error("Signature verification failed")
        return jsonify({"error": "Invalid payment signature"}), 400
    except Exception as e:
        logging.error(f"Payment callback failed: {e}")
        return jsonify({"error": str(e)}), 400


# ── Hosted payment page ────────────────────────────────────────────────────────
# This is the KEY FIX: Razorpay runs here on Render (normal webpage),
# NOT inside the Chrome extension where CSP blocks external scripts.

PAYMENT_PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>InboxAI — Upgrade to Premium</title>
<script src="https://checkout.razorpay.com/v1/checkout.js"></script>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:system-ui,sans-serif;background:#0f0f13;color:#f0f0f5;
       min-height:100vh;display:flex;align-items:center;justify-content:center;}
  .card{background:#18181f;border:1px solid #2e2e3a;border-radius:16px;
        padding:40px 32px;max-width:380px;width:100%;text-align:center;}
  .logo{font-size:32px;color:#7c6aff;margin-bottom:16px;}
  h1{font-size:22px;font-weight:600;margin-bottom:8px;}
  p{font-size:14px;color:#9090a8;margin-bottom:24px;line-height:1.5;}
  .features{text-align:left;margin-bottom:28px;}
  .feature{font-size:13px;color:#9090a8;padding:6px 0;
            border-bottom:1px solid #2e2e3a;display:flex;align-items:center;gap:8px;}
  .feature:last-child{border-bottom:none;}
  .feature::before{content:"✦";color:#7c6aff;font-size:10px;flex-shrink:0;}
  .currency-row{display:flex;gap:8px;margin-bottom:20px;}
  .cur-btn{flex:1;padding:10px;border:1px solid #2e2e3a;border-radius:8px;
           background:#22222c;color:#9090a8;cursor:pointer;font-family:inherit;
           font-size:12px;transition:all 0.2s;}
  .cur-btn.active{border-color:#7c6aff;background:rgba(124,106,255,.12);color:#f0f0f5;}
  .cur-btn .price{display:block;font-size:18px;font-weight:600;color:#f0f0f5;margin-top:2px;}
  .btn{width:100%;padding:13px;background:#7c6aff;color:#fff;border:none;
       border-radius:8px;font-size:15px;font-weight:600;cursor:pointer;
       font-family:inherit;transition:opacity 0.15s;}
  .btn:hover{opacity:0.85}
  .btn:disabled{opacity:0.5;cursor:not-allowed;}
  .status{margin-top:16px;font-size:13px;min-height:20px;}
  .success{color:#34d399;}
  .error{color:#f87171;}
  .email-display{font-size:12px;color:#5a5a72;margin-bottom:20px;}
</style>
</head>
<body>
<div class="card">
  <div class="logo">✦</div>
  <h1>Upgrade to Premium</h1>
  <p class="email-display">Logged in as: <strong id="emailDisplay">Loading...</strong></p>

  <div class="features">
    <div class="feature">Unlimited scans per day</div>
    <div class="feature">Bulk cleanup — up to 500 emails at once</div>
    <div class="feature">Deep AI explanations for suspicious emails</div>
    <div class="feature">Advanced inbox analytics</div>
  </div>

  <div class="currency-row">
    <button class="cur-btn active" id="btnINR" onclick="selectCurrency('INR')">
      🇮🇳 India
      <span class="price">₹10</span>
      <span style="font-size:10px;color:#5a5a72;">/ month (test)</span>
    </button>
    <button class="cur-btn" id="btnUSD" onclick="selectCurrency('USD')">
      🌍 International
      <span class="price">$1.19</span>
      <span style="font-size:10px;color:#5a5a72;">/ month</span>
    </button>
  </div>

  <button class="btn" id="btnPay" onclick="startPayment()">
    Upgrade — ₹10/mo
  </button>
  <div class="status" id="status"></div>
</div>

<script>
const BACKEND = "https://unwanted-mail-sorter.onrender.com";
let selectedCurrency = "INR";
let userEmail = "";

// Check login status
fetch(`${BACKEND}/whoami`, { credentials: "include" })
  .then(r => r.json())
  .then(data => {
    if (!data.email) {
      document.getElementById("emailDisplay").textContent = "Not logged in";
      document.getElementById("btnPay").disabled = true;
      document.getElementById("status").innerHTML = '<span class="error">Please login to the extension first.</span>';
      return;
    }
    userEmail = data.email;
    document.getElementById("emailDisplay").textContent = data.email;

    if (data.is_premium) {
      document.getElementById("btnPay").disabled = true;
      document.getElementById("btnPay").textContent = "✦ Already Premium";
      document.getElementById("status").innerHTML = '<span class="success">You are already a premium member!</span>';
    }
  })
  .catch(() => {
    document.getElementById("emailDisplay").textContent = "Could not connect";
  });

function selectCurrency(cur) {
  selectedCurrency = cur;
  document.getElementById("btnINR").classList.toggle("active", cur === "INR");
  document.getElementById("btnUSD").classList.toggle("active", cur === "USD");
  document.getElementById("btnPay").textContent =
    cur === "INR" ? "Upgrade — ₹10/mo" : "Upgrade — $1.19/mo";
}

async function startPayment() {
  const btn    = document.getElementById("btnPay");
  const status = document.getElementById("status");

  if (!userEmail) {
    status.innerHTML = '<span class="error">Please login to the extension first.</span>';
    return;
  }

  btn.disabled    = true;
  btn.textContent = "Creating order...";
  status.textContent = "";

  try {
    // Get Razorpay key
    const keyRes = await fetch(`${BACKEND}/razorpay-key`, { credentials: "include" });
    const keyData = await keyRes.json();
    if (keyData.error) throw new Error(keyData.error);

    // Create order
    const orderRes = await fetch(`${BACKEND}/create-order`, {
      method:      "POST",
      credentials: "include",
      headers:     { "Content-Type": "application/json" },
      body:        JSON.stringify({ currency: selectedCurrency }),
    });
    const order = await orderRes.json();
    if (order.error) throw new Error(order.error);

    btn.textContent = "Opening payment...";

    // Open Razorpay — works here because this is a normal webpage, not an extension
    const rzp = new Razorpay({
      key:      keyData.key_id,
      amount:   order.amount,
      currency: order.currency,
      name:     "InboxAI Premium",
      description: "Unlimited scans & smart email organization",
      order_id: order.order_id,
      prefill:  { email: userEmail },
      theme:    { color: "#7c6aff" },
      handler: async function(response) {
        btn.textContent = "Verifying payment...";
        try {
          const verifyRes = await fetch(`${BACKEND}/payment-callback`, {
            method:      "POST",
            credentials: "include",
            headers:     { "Content-Type": "application/json" },
            body:        JSON.stringify({
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_order_id:   response.razorpay_order_id,
              razorpay_signature:  response.razorpay_signature,
              email:               userEmail,
            }),
          });
          const result = await verifyRes.json();
          if (result.status === "success") {
            status.innerHTML = '<span class="success">🎉 Premium activated! You can close this tab.</span>';
            btn.textContent  = "✦ Premium Active";
            btn.disabled     = true;
          } else {
            throw new Error(result.error || "Verification failed");
          }
        } catch(e) {
          status.innerHTML = `<span class="error">Verification failed: ${e.message}</span>`;
          btn.disabled     = false;
          btn.textContent  = selectedCurrency === "INR" ? "Try Again — ₹10/mo" : "Try Again — $1.19/mo";
        }
      },
      modal: {
        ondismiss: function() {
          btn.disabled    = false;
          btn.textContent = selectedCurrency === "INR" ? "Upgrade — ₹10/mo" : "Upgrade — $1.19/mo";
        }
      }
    });
    rzp.open();

  } catch(e) {
    status.innerHTML = `<span class="error">Error: ${e.message}</span>`;
    btn.disabled     = false;
    btn.textContent  = selectedCurrency === "INR" ? "Upgrade — ₹10/mo" : "Upgrade — $1.19/mo";
  }
}
</script>
</body>
</html>"""


@app.route("/pay")
def payment_page():
    """
    Hosted payment page — opened in a new browser tab from the extension.
    Razorpay checkout.js loads here without any CSP restrictions.
    """
    return render_template_string(PAYMENT_PAGE)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
