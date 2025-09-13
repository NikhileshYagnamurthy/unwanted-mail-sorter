import os
from flask import Flask, jsonify
from flask_cors import CORS   # ✅ Added for CORS
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

app = Flask(__name__)
CORS(app)  # ✅ Allow cross-origin requests (needed for Chrome extension)

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

@app.route("/fetch-emails")   # ✅ renamed to match your extension code
def fetch_emails():
    try:
        service = get_gmail_service()
        results = service.users().messages().list(userId="me", maxResults=10).execute()
        messages = results.get("messages", [])

        # Return structured response instead of just IDs
        emails = []
        for msg in messages:
            msg_detail = service.users().messages().get(userId="me", id=msg["id"]).execute()
            subject = ""
            for header in msg_detail["payload"]["headers"]:
                if header["name"] == "Subject":
                    subject = header["value"]
                    break

            emails.append({
                "id": msg["id"],
                "subject": subject,
                "label": "Unknown",
                "confidence": 100.0
            })

        return jsonify(emails)

    except Exception as e:
        return jsonify({"error": str(e)})

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))  # Render provides PORT env
    app.run(host="0.0.0.0", port=port)
