import os
from flask import Flask, jsonify
from flask_cors import CORS
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

app = Flask(__name__)
CORS(app)  # allow extension requests

# --- Gmail Authentication ---
def get_gmail_service():
    creds = Credentials(
        token=None,  # We’ll refresh using refresh_token
        refresh_token=os.getenv("GOOGLE_REFRESH_TOKEN"),
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.getenv("GOOGLE_CLIENT_ID"),
        client_secret=os.getenv("GOOGLE_CLIENT_SECRET"),
        scopes=["https://www.googleapis.com/auth/gmail.readonly"]
    )
    return build("gmail", "v1", credentials=creds)

@app.route("/")
def home():
    return jsonify({"message": "✅ Gmail API backend is running"})

@app.route("/fetch-emails")
def fetch_emails():
    try:
        service = get_gmail_service()
        # Fetch 5 latest emails
        results = service.users().messages().list(userId="me", maxResults=5).execute()
        messages = results.get("messages", [])

        email_list = []
        for msg in messages:
            msg_data = service.users().messages().get(userId="me", id=msg["id"]).execute()
            headers = msg_data["payload"].get("headers", [])

            subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(No Subject)")

            # For now, just classify as Spam if "lottery" in subject (demo)
            if "lottery" in subject.lower():
                label = "Spam"
                confidence = 95.0
            else:
                label = "Not Spam"
                confidence = 90.0

            email_list.append({
                "subject": subject,
                "label": label,
                "confidence": confidence
            })

        return jsonify(email_list)

    except Exception as e:
        return jsonify({"error": str(e)})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
