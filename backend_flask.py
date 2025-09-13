import os
import logging
from flask import Flask, jsonify
from flask_cors import CORS
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

app = Flask(__name__)
CORS(app)

# Enable logging to Render logs
logging.basicConfig(level=logging.INFO)


def get_gmail_service():
    creds = Credentials(
        token=None,  # Let API refresh automatically
        refresh_token=os.getenv("GOOGLE_REFRESH_TOKEN"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.getenv("GOOGLE_CLIENT_ID"),
        client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
        scopes=["https://www.googleapis.com/auth/gmail.modify"]  # ✅ match existing refresh_token scope
    )
    return build("gmail", "v1", credentials=creds)


# Placeholder simple classifier (replace later with Logistic Regression)
def classify_email(subject, snippet):
    spam_keywords = ["lottery", "winner", "prize", "claim now", "click here"]
    text = f"{subject} {snippet}".lower()

    for kw in spam_keywords:
        if kw in text:
            return "Unwanted", 98.0
    return "Wanted", 90.0


@app.route("/")
def home():
    return jsonify({"message": "Gmail API backend is running ✅"})


@app.route("/fetch-emails")
def fetch_emails():
    try:
        service = get_gmail_service()
        results = service.users().messages().list(userId="me", maxResults=5).execute()
        messages = results.get("messages", [])

        email_data = []

        for msg in messages:
            msg_obj = service.users().messages().get(userId="me", id=msg["id"]).execute()
            headers = msg_obj.get("payload", {}).get("headers", [])
            subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(No Subject)")
            snippet = msg_obj.get("snippet", "")

            # Classify
            label, confidence = classify_email(subject, snippet)

            # 🔥 Log subject and classification to Render logs
            logging.info(f"Email: {subject} | Label: {label} | Confidence: {confidence}")

            email_data.append({
                "subject": subject,
                "label": label,
                "confidence": confidence
            })

        return jsonify({"emails": email_data})

    except Exception as e:
        logging.error(f"Error fetching emails: {e}")
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
