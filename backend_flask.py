import os
import json
import logging
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

app = Flask(__name__)
CORS(app)
app.secret_key = "super_secret_key"  # change in production

logging.basicConfig(level=logging.INFO)

# -------------------
# Google API config
# -------------------
GOOGLE_CLIENT_SECRETS_FILE = "/tmp/credentials.json"

# If GOOGLE_CREDENTIALS_JSON is in env, write it to /tmp/credentials.json
if os.environ.get("GOOGLE_CREDENTIALS_JSON"):
    with open(GOOGLE_CLIENT_SECRETS_FILE, "w") as f:
        f.write(os.environ["GOOGLE_CREDENTIALS_JSON"])

# SCOPES: must match exactly what Google returns
SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly"
]

# In-memory token store (per user, not persistent)
USER_TOKENS = {}


@app.route("/")
def index():
    return "✅ Backend running!"


@app.route("/login")
def login():
    """Start OAuth flow"""
    flow = Flow.from_client_secrets_file(
        GOOGLE_CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri="https://unwanted-mail-sorter.onrender.com/oauth2callback"
    )
    auth_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent"  # ensures refresh_token is always returned
    )
    return redirect(auth_url)


@app.route("/oauth2callback")
def oauth2callback():
    """Handle OAuth callback"""
    try:
        flow = Flow.from_client_secrets_file(
            GOOGLE_CLIENT_SECRETS_FILE,
            scopes=SCOPES,
            redirect_uri="https://unwanted-mail-sorter.onrender.com/oauth2callback"
        )
        flow.fetch_token(authorization_response=request.url)

        creds = flow.credentials
        # Save token in memory (keyed by email)
        service = build("gmail", "v1", credentials=creds)
        profile = service.users().getProfile(userId="me").execute()
        email = profile["emailAddress"]

        USER_TOKENS[email] = creds.to_json()

        logging.info(f"✅ Stored token for {email}")
        return f"Login successful! You can now fetch emails for {email}"

    except Exception as e:
        logging.exception("OAuth2 callback failed")
        return jsonify({"error": str(e)}), 500


@app.route("/fetch-emails/<user>")
def fetch_emails(user):
    """Fetch latest 5 emails for user"""
    try:
        if user not in USER_TOKENS:
            return jsonify({"error": f"No token found for user {user}"}), 400

        creds = Credentials.from_authorized_user_info(json.loads(USER_TOKENS[user]))
        service = build("gmail", "v1", credentials=creds)

        results = service.users().messages().list(
            userId="me", maxResults=5
        ).execute()
        messages = results.get("messages", [])

        emails = []
        for msg in messages:
            msg_data = service.users().messages().get(
                userId="me", id=msg["id"], format="metadata"
            ).execute()
            headers = msg_data["payload"]["headers"]
            subject = next((h["value"] for h in headers if h["name"] == "Subject"), "")
            sender = next((h["value"] for h in headers if h["name"] == "From"), "")
            emails.append({"id": msg["id"], "from": sender, "subject": subject})

        return jsonify({"emails": emails})

    except Exception as e:
        logging.exception("Fetching emails failed")
        return jsonify({"error": str(e)}), 500


@app.route("/whoami")
def whoami():
    if not USER_TOKENS:
        return jsonify({"email": None})
    # return the first logged-in email (since we store per-user)
    email = list(USER_TOKENS.keys())[0]
    return jsonify({"email": email})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
