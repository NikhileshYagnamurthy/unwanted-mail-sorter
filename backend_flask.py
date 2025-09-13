from flask import Flask, jsonify
from flask_cors import CORS
import os

app = Flask(__name__)
CORS(app)  # Allow requests from your Chrome extension

@app.route("/")
def home():
    return jsonify({"status": "Backend is running!"})

@app.route("/fetch-emails", methods=["GET"])
def fetch_emails():
    try:
        # --- Example Dummy Response ---
        emails = [
            {"subject": "Welcome to Gmail", "label": "Not Spam", "confidence": 95.23},
            {"subject": "You won a lottery!!!", "label": "Spam", "confidence": 98.67},
            {"subject": "Meeting tomorrow at 10AM", "label": "Not Spam", "confidence": 87.45}
        ]
        return jsonify({"emails": emails})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
