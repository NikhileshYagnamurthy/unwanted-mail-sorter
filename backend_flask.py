import os
import logging
from flask import Flask, request, jsonify
from flask_cors import CORS
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

app = Flask(__name__)
CORS(app)

# Enable logging for Render
logging.basicConfig(level=logging.INFO)

# In-memory store for multiple users’ tokens
USER_TOKENS = {}


def get_gmail_service(user_id):
    """Build Gmail service for a given user_id using stored token_json"""
    if user_id not in USER_TOKENS:
        raise Exception(f"No token found for user {user_id}")

    creds = Credentials.from_authorized_user_info(USER_TOKENS[user_id])
    return build("gmail", "v1", credentials=creds)


def classify_email(subject, snippet):
    """Very simple spam filter (replace later with ML model)"""
    spam_keywords = ["lottery", "winner", "prize", "claim now", "click here"]
    text = f"{subject} {snippet}".lower()

    for kw in spam_keywords:
        if kw in text:
            return "Unwanted", 98.0
    return "Wanted", 90.0


@app.route("/")
def home():
    return jsonify({"message": "Multi-user Gmail API backend is running ✅"})


@app.route("/add-token", methods=["POST"])
def add_token():
    """Store a user's Gmail token"""
    try:
        data = request.json
        user_id = data.get("user_id")
        token_json = data.get("token_json")

        if not user_id or not token_json:
            return jsonify({"error": "user_id and token_json are required"}), 400

        USER_TOKENS[user_id] = token_json
        logging.info(f"Stored token for user {user_id}")
        return jsonify({"message": f"Token stored for {user_id}"})

    except Exception as e:
        logging.error(f"Error storing token: {e}")
        return jsonify({"error": str(e)}), 500


@app.route("/fetch-emails/<user_id>", methods=["GET"])
def fetch_emails(user_id):
    """Fetch and classify recent emails for a user"""
    try:
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
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
