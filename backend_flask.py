import os
from flask import Flask, jsonify
from flask_cors import CORS
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import base64
import email

app = Flask(__name__)
CORS(app)  # allow Chrome extension to call this backend


def get_gmail_service():
    """Authenticate using environment variables and return Gmail API service."""
    creds = Credentials(
        token=os.getenv("GOOGLE_ACCESS_TOKEN"),
        refresh_token=os.getenv("GOOGLE_REFRESH_TOKEN"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.getenv("GOOGLE_CLIENT_ID"),
        client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
        scopes=["https://www.googleapis.com/auth/gmail.readonly"]
    )
    return build("gmail", "v1", credentials=creds)


def classify_email(subject, snippet):
    """
    Very basic spam classifier (placeholder).
    Replace with your ML model later if needed.
    """
    spam_keywords = ["lottery", "winner", "prize", "claim now", "click here"]
    text = f"{subject} {snippet}".lower()

    for kw in spam_keywords:
        if kw in text:
            return "Spam", 98.0
    return "Not Spam", 90.0


@app.route("/")
def home():
    return jsonify({"message": "Gmail API backend is running ✅"})


@app.route("/fetch-emails")
def fetch_emails():
    try:
        service = get_gmail_service()

        # Fetch latest 5 messages
        results = service.users().messages().list(userId="me", maxResults=5).execute()
        messages = results.get("messages", [])

        email_data = []

        for msg in messages:
            msg_obj = service.users().messages().get(userId="me", id=msg["id"]).execute()
            payload = msg_obj.get("payload", {})
            headers = payload.get("headers", [])

            # Extract subject
            subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(No Subject)")

            # Extract snippet
            snippet = msg_obj.get("snippet", "")

            # Classify email
            label, confidence = classify_email(subject, snippet)

            email_data.append({
                "subject": subject,
                "label": label,
                "confidence": confidence
            })

        return jsonify({"emails": email_data})

    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))  # Render provides PORT
    app.run(host="0.0.0.0", port=port)
