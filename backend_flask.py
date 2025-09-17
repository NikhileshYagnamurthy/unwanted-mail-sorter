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

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly",
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
        redirect_uri="https://unwanted-mail-sorter.onrender.com/oauth2callback",
    )
    auth_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent",  # ensures refresh_token is always returned
    )
    return redirect(auth_url)


@app.route("/oauth2callback")
def oauth2callback():
    """Handle OAuth callback"""
    try:
        flow = Flow.from_client_secrets_file(
            GOOGLE_CLIENT_SECRETS_FILE,
            scopes=SCOPES,
            redirect_uri="https://unwanted-mail-sorter.onrender.com/oauth2callback",
        )
        flow.fetch_token(authorization_response=request.url)

        creds = flow.credentials
        service = build("gmail", "v1", credentials=creds)
        profile = service.users().getProfile(userId="me").execute()
        email = profile["emailAddress"]

        USER_TOKENS[email] = creds.to_json()
        logging.info(f"✅ Stored token for {email}")

        return f"Login successful! You can now fetch emails for {email}"

    except Exception as e:
        logging.exception("OAuth2 callback failed")
        return jsonify({"error": str(e)}), 500


def get_or_create_label(service, label_name="Filtered-Unwanted"):
    """Return existing label ID or create if missing"""
    labels = service.users().labels().list(userId="me").execute().get("labels", [])
    for lbl in labels:
        if lbl["name"].lower() == label_name.lower():  # case-insensitive match
            return lbl["id"]

    # Create only if missing
    new_label = {
        "name": label_name,
        "labelListVisibility": "labelShow",
        "messageListVisibility": "show",
    }
    created = service.users().labels().create(userId="me", body=new_label).execute()
    return created["id"]


@app.route("/fetch-emails/<user>")
def fetch_and_classify_emails(user):
    """Classify, move unwanted mails, then fetch latest 10"""
    try:
        if user not in USER_TOKENS:
            return jsonify({"error": f"No token found for user {user}"}), 400

        creds = Credentials.from_authorized_user_info(json.loads(USER_TOKENS[user]))
        service = build("gmail", "v1", credentials=creds)

        # Get (or create) unwanted label safely
        unwanted_label_id = get_or_create_label(service, "Filtered-Unwanted")

        # Fetch latest 10 messages
        results = service.users().messages().list(
            userId="me", maxResults=10
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

            # ----- SIMPLE CLASSIFIER (replace with ML later) -----
            unwanted_keywords = ["facebook", "lovable", "notification"]
            label = "Wanted"
            confidence = 99.0
            if any(
                k.lower() in subject.lower() or k.lower() in sender.lower()
                for k in unwanted_keywords
            ):
                label = "Unwanted 🚫"
                confidence = 95.0
                # Move to unwanted label
                service.users().messages().modify(
                    userId="me",
                    id=msg["id"],
                    body={"addLabelIds": [unwanted_label_id], "removeLabelIds": ["INBOX"]},
                ).execute()

            emails.append(
                {
                    "id": msg["id"],
                    "from": sender,
                    "subject": subject,
                    "label": label,
                    "confidence": confidence,
                }
            )

        return jsonify({"emails": emails})

    except Exception as e:
        logging.exception("Fetch+Classify failed")
        return jsonify({"error": str(e)}), 500


@app.route("/whoami")
def whoami():
    if not USER_TOKENS:
        return jsonify({"email": None})
    email = list(USER_TOKENS.keys())[0]
    return jsonify({"email": email})


@app.route("/logout", methods=["POST"])
def logout():
    """Log out current user"""
    if not USER_TOKENS:
        return jsonify({"message": "No user logged in"}), 200
    email = list(USER_TOKENS.keys())[0]
    USER_TOKENS.pop(email, None)
    logging.info(f"🛑 Logged out {email}")
    return jsonify({"message": f"Logged out {email}"}), 200


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
