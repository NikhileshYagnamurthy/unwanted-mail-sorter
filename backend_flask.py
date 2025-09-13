import os
from flask import Flask, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)  # ✅ Allow requests from your Chrome extension

@app.route("/")
def home():
    return jsonify({"message": "Gmail API backend is running ✅"})

@app.route("/fetch-emails")
def fetch_emails():
    """
    For now, return mock emails so extension displays correctly.
    Later, we’ll connect this with Gmail API.
    """
    emails = [
        {
            "subject": "Welcome to Gmail",
            "label": "Not Spam",
            "confidence": 95.23
        },
        {
            "subject": "You won a lottery!!!",
            "label": "Spam",
            "confidence": 98.67
        },
        {
            "subject": "Meeting tomorrow at 10AM",
            "label": "Not Spam",
            "confidence": 87.45
        }
    ]
    return jsonify(emails)

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
