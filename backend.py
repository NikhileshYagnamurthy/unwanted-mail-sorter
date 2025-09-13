from __future__ import print_function
import os
import json
from flask import Flask, jsonify
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
import pickle
import numpy as np

# Load ML models
with open("vectorizer.pkl", "rb") as f:
    vectorizer = pickle.load(f)
with open("model.pkl", "rb") as f:
    model = pickle.load(f)

# Gmail scopes
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

app = Flask(__name__)


# ------------------- AUTH -------------------
def get_gmail_service():
    """Authenticate Gmail API using token.json (local) or Render env var"""
    creds = None

    # 1. Try Render env var
    token_env = os.environ.get("TOKEN_JSON")
    if token_env:
        creds_data = json.loads(token_env)
        creds = Credentials.from_authorized_user_info(creds_data, SCOPES)

    # 2. Fallback: local token.json
    elif os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)

    # 3. Refresh if needed
    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())

    if not creds:
        raise Exception("❌ No valid credentials found. Run generate_token.py locally first.")

    return build("gmail", "v1", credentials=creds)


# ------------------- FETCH EMAILS -------------------
def fetch_emails(service, max_results=10):
    """Fetch subjects of latest emails"""
    results = service.users().messages().list(userId="me", maxResults=max_results).execute()
    messages = results.get("messages", [])
    email_data = []

    for msg in messages:
        msg_data = service.users().messages().get(userId="me", id=msg["id"]).execute()
        headers = msg_data.get("payload", {}).get("headers", [])
        subject = "(no subject)"
        for header in headers:
            if header["name"] == "Subject":
                subject = header["value"]
                break
        email_data.append({"id": msg["id"], "subject": subject})

    return email_data


# ------------------- CLASSIFY -------------------
def classify_emails(emails):
    """Classify emails as Wanted/Unwanted"""
    subjects = [e["subject"] for e in emails]
    X_test = vectorizer.transform(subjects)
    predictions = model.predict(X_test)
    probs = model.predict_proba(X_test)

    results = []
    for i, subject in enumerate(subjects):
        confidence = np.max(probs[i]) * 100
        results.append({
            "subject": subject,
            "prediction": predictions[i],
            "confidence": f"{confidence:.2f}%"
        })
    return results


# ------------------- ROUTE -------------------
@app.route("/fetch-emails", methods=["GET"])
def fetch_and_classify():
    try:
        service = get_gmail_service()
        emails = fetch_emails(service, max_results=10)
        classified = classify_emails(emails)
        return jsonify(classified)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ------------------- MAIN -------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
