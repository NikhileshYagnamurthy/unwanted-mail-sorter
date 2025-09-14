import os
import logging
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

app = Flask(__name__)
CORS(app)
app.secret_key = "super_secret_key"  # ⚠️ change in production

logging.basicConfig(level=logging.INFO)

# Google API config
GOOGLE_CLIENT_SECRETS_FILE = "credentials.json"
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

# In-memory token store
USER_TOKENS = {}


# -------------------
# OAuth Login
# -------------------
@app.route("/login")
def login():
    """Redirect user to Google login"""
    flow = Flow.from_client_secrets_file(
        GOOGLE_CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=os.environ.get(
            "OAUTH_REDIRECT_URI",
            "http://localhost:5000/oauth2callback"
        ),
    )
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent"
    )
    return redirect(auth_url)


@app.route("/oauth2callback")
def oauth2callback():
    """Handle OAuth callback, exchange code for tokens"""
    flow = Flow.from_client_secrets_file(
        GOOGLE_CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=os.environ.get(
            "OAUTH_REDIRECT_URI",
            "http://localhost:5000/oauth2callback"
        ),
    )
    flow.fetch_token(authorization_response=request.url)

    creds = flow.credentials
    user_info = get_user_info(creds)

    # Store refresh token in memory (replace with DB in production)
    USER_TOKENS[user_info["email"]] = {
        "refresh_token": creds.refresh_token,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "token_uri": creds.token_uri,
        "scopes": creds.scopes,
    }

    logging.info(f"Stored token for {user_info['email']}")
    return jsonify({"msg": "Login successful", "user": user_info})


def get_user_info(creds):
    """Get user email/profile"""
    service = build("oauth2", "v2", credentials=creds)
    return service.userinfo().get().execute()


# -------------------
# Gmail Service
# -------------------
def get_gmail_service(user_id):
    if user_id not in USER_TOKENS:
        raise Exception(f"No token found for user {user_id}")

    creds = Credentials.from_authorized_user_info(USER_TOKENS[user_id])
    return build("gmail", "v1", credentials=creds)


def classify_email(subject, snippet):
    """Simple spam classifier"""
    spam_keywords = ["lottery", "winner", "prize", "claim now", "click here"]
    text = f"{subject} {snippet}".lower()
    for kw in spam_keywords:
        if kw in text:
            return "Unwanted", 98.0
    return "Wanted", 90.0


# -------------------
# Routes
# -------------------
@app.route("/")
def home():
    return jsonify({"message": "Multi-user Gmail API backend is running ✅"})


@app.route("/fetch-emails/<user_id>", methods=["GET"])
def fetch_emails(user_id):
    """Fetch Gmail emails or return mock data if no token"""
    try:
        if user_id not in USER_TOKENS:
            # Mock emails if user not logged in
            return jsonify({
                "emails": [
                    {"subject": "Win a free iPhone!", "label": "Unwanted", "confidence": 97.5},
                    {"subject": "Meeting at 3PM", "label": "Wanted", "confidence": 92.1},
                    {"subject": "Claim your lottery prize", "label": "Unwanted", "confidence": 98.3}
                ]
            })

        # ---- REAL Gmail fetch ----
        service = get_gmail_service(user_id)
        results = service.users().messages().list(userId="me", maxResults=5).execute()
        messages = results.get("messages", [])

        email_data = []
        for msg in messages:
            msg_obj = service.users().messages().get(userId="me", id=msg["id"]).execute()
            headers = msg_obj.get("payload", {}).get("headers", [])
            subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(No Subject)")
            snippet = msg_obj.get("snippet", "")

            label, confidence = classify_email(subject, snippet)

            logging.info(f"Email: {subject} | Label: {label} | Confidence: {confidence}")
            email_data.append({
                "subject": subject,
                "label": label,
                "confidence": confidence
            })

        return jsonify({"emails": email_data})

    except Exception as e:
        logging.error(f"Error fetching emails for {user_id}: {e}")
        return jsonify({"emails": []})


# -------------------
# Main
# -------------------
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=True)
