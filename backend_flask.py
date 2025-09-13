import os
from flask import Flask, jsonify
from flask_cors import CORS
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import base64
import email
import random

app = Flask(__name__)
CORS(app)  # Allow Chrome extension to connect

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

@app.route("/")
def home():
    return jsonify({"message": "Gmail API backend is running ✅"})

@app.route("/fetch-emails")
def fetch_emails():
    try:
        service = get_gmail_service()
        results = service.users().messages().list(userId="me", maxResults=5).execute()
        messages = results.get("messages", [])

        emails = []
        for msg in messages:
            msg_data = service.users().messages().get(userId="me", id=msg["id"]).execute()
            headers = msg_data["payload"]["headers"]

            subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(No Subject)")

            # 🔥 Dummy classification (replace with ML later)
            label = random.choice(["Spam", "Not Spam"])
            confidence = round(random.uniform(70, 99), 2)

            emails.append({
                "subject": subject,
                "label": label,
                "confidence": confidence
            })

        return jsonify(emails)

    except Exception as e:
        return jsonify({"error": str(e)})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))  # Render provides PORT env
    app.run(host="0.0.0.0", port=port)
