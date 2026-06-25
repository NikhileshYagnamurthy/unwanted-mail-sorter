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

app = Flask(__name__)

# ── CORS: Allow all origins (like your working version) ──
CORS(app, supports_credentials=True)

app.secret_key = os.environ.get("SECRET_KEY", "inboxai-secret-2025")

logging.basicConfig(level=logging.INFO)

# ── Config ─────────────────────────────────────────────────────────────────────
BACKEND_URL = "https://unwanted-mail-sorter.onrender.com"
GOOGLE_CLIENT_SECRETS_FILE = "/tmp/credentials.json"

# ── SCOPES: Only the 2 that worked before ──
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly",
]

FREE_TIER_DAILY_SCANS = 5

# Write credentials.json from environment variable set on Render
if os.environ.get("GOOGLE_CREDENTIALS_JSON"):
    with open(GOOGLE_CLIENT_SECRETS_FILE, "w") as f:
        f.write(os.environ["GOOGLE_CREDENTIALS_JSON"])

# ── In-memory stores ───────────────────────────────────────────────────────────
# NOTE: These reset on every Render cold start (free tier sleeps).
# Replace with Supabase later when you have real users.
USER_TOKENS = {}   # { email: creds_json_string }
USAGE_LOG   = {}   # { email: { date, scans, is_premium } }

# ── Gmail label list ───────────────────────────────────────────────────────────
AI_LABELS = [
    "AI/Promotions", "AI/Newsletters", "AI/Social", "AI/Recruiters",
    "AI/Finance", "AI/Orders", "AI/Transactional", "AI/Security",
    "AI/Phishing Risk", "AI/Calendar", "AI/Important",
]


# ── Helper functions ───────────────────────────────────────────────────────────
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


def _check_usage(email):
    today = str(date.today())
    entry = USAGE_LOG.get(email, {"date": today, "scans": 0, "is_premium": False})
    if entry["date"] != today:
        entry = {"date": today, "scans": 0, "is_premium": entry.get("is_premium", False)}
    USAGE_LOG[email] = entry
    return entry


def _current_user():
    return list(USER_TOKENS.keys())[0] if USER_TOKENS else None


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
    scans_remaining = (
        "unlimited" if usage["is_premium"]
        else max(0, FREE_TIER_DAILY_SCANS - usage["scans"])
    )
    return jsonify({
        "email":           email,
        "scans_today":     usage["scans"],
        "scans_remaining": scans_remaining,
        "is_premium":      usage["is_premium"],
    })


@app.route("/logout", methods=["POST"])
def logout():
    email = _current_user()
    if email:
        USER_TOKENS.pop(email, None)
    return jsonify({"message": "Logged out"})


@app.route("/scan-emails")
def scan_emails():
    email = _current_user()
    if not email:
        return jsonify({"error": "Not authenticated"}), 401

    usage = _check_usage(email)
    if not usage["is_premium"] and usage["scans"] >= FREE_TIER_DAILY_SCANS:
        return jsonify({
            "error":        "Daily scan limit reached",
            "limit":        FREE_TIER_DAILY_SCANS,
            "upgrade_hint": "Upgrade to premium for unlimited scans.",
        }), 429

    max_results = min(
        int(request.args.get("max", 25)),
        50 if not usage["is_premium"] else 200,
    )
    query = request.args.get("query", "in:inbox")

    try:
        service = _service(email)
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
                "id":      msg["id"],
                "subject": hdrs.get("Subject", "(no subject)"),
                "from":    hdrs.get("From", ""),
                "snippet": data.get("snippet", ""),
                "headers": {
                    "List-Unsubscribe": hdrs.get("List-Unsubscribe", ""),
                    "Precedence":       hdrs.get("Precedence", ""),
                },
            })

        # Score all emails locally — zero API cost
        scored = batch_score(raw_emails)

        # Apply Gmail labels
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
                    pass  # don't crash full scan on one email failure

        analytics = inbox_analytics(scored)

        usage["scans"] += 1
        USAGE_LOG[email] = usage

        return jsonify({
            "emails":          scored,
            "analytics":       analytics,
            "scans_used":      usage["scans"],
            "scans_remaining": (
                "unlimited" if usage["is_premium"]
                else max(0, FREE_TIER_DAILY_SCANS - usage["scans"])
            ),
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
    data = request.json or {}
    message_ids = data.get("message_ids", [])

    if not usage["is_premium"] and len(message_ids) > 50:
        return jsonify({
            "error":        "Free tier cleanup limit is 50 emails at a time.",
            "upgrade_hint": "Upgrade to premium for unlimited bulk cleanup.",
        }), 403

    try:
        service = _service(email)
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
    """Premium only — calls OpenAI for a plain-English email explanation."""
    email = _current_user()
    if not email:
        return jsonify({"error": "Not authenticated"}), 401

    usage = _check_usage(email)
    if not usage["is_premium"]:
        return jsonify({
            "error":        "Premium feature",
            "upgrade_hint": "Upgrade to get AI explanations for suspicious emails.",
        }), 403

    openai_key = os.environ.get("OPENAI_API_KEY")
    if not openai_key:
        return jsonify({"error": "OpenAI not configured on server"}), 500

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
    """Stub — wire to Stripe/Lemon Squeezy when ready."""
    email = _current_user()
    if not email:
        return jsonify({"error": "Not authenticated"}), 401
    USAGE_LOG.setdefault(email, {"date": str(date.today()), "scans": 0, "is_premium": False})
    USAGE_LOG[email]["is_premium"] = True
    return jsonify({"message": f"{email} upgraded to premium", "is_premium": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 10000))
    app.run(host="0.0.0.0", port=port)
