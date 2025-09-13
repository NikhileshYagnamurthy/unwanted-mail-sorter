import os
import threading
import time
import pandas as pd
from flask import Flask, jsonify
from flask_cors import CORS
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.naive_bayes import MultinomialNB
from gmail_utils import authenticate_gmail, fetch_recent_emails, move_to_label

# Flask app setup
app = Flask(__name__)
CORS(app)

# Globals
model = None
vectorizer = None
service = None
POLL_INTERVAL = 60  # seconds


# ---- Training function ----
def train_model():
    global model, vectorizer
    if not os.path.exists("emails.csv"):
        print("⚠️ emails.csv not found! Please create it with 'subject','label' columns.")
        return

    df = pd.read_csv("emails.csv")
    if "subject" not in df or "label" not in df:
        print("⚠️ emails.csv must contain 'subject' and 'label' columns.")
        return

    vectorizer = TfidfVectorizer()
    X = vectorizer.fit_transform(df["subject"])
    y = df["label"]

    model = MultinomialNB()
    model.fit(X, y)

    print(f"✅ Trained model on {len(df)} examples.")


# ---- Polling worker ----
def poll_inbox():
    global service
    while True:
        try:
            if service and model:
                emails = fetch_recent_emails(service, max_results=10)
                for e in emails:
                    subject = e["subject"]
                    msg_id = e["id"]
                    X_test = vectorizer.transform([subject])
                    pred = model.predict(X_test)[0]
                    conf = model.predict_proba(X_test).max()

                    if pred == "Unwanted":
                        move_to_label(service, msg_id, "Filtered-Unwanted")
                        print(f"Moved message {msg_id} -> Filtered-Unwanted (conf {conf:.2f})")
            else:
                print("⚠️ Service or model not ready.")
        except Exception as ex:
            print("❌ Polling error:", ex)

        time.sleep(POLL_INTERVAL)


# ---- Flask endpoints ----
@app.route("/fetch-emails", methods=["GET"])
def api_fetch_emails():
    if not service or not model:
        return jsonify({"error": "Service or model not ready"}), 500

    emails = fetch_recent_emails(service, max_results=10)
    results = []

    for e in emails:
        subject = e["subject"]
        msg_id = e["id"]
        X_test = vectorizer.transform([subject])
        pred = model.predict(X_test)[0]
        conf = model.predict_proba(X_test).max()

        results.append({
            "id": msg_id,
            "subject": subject,
            "label": pred,
            "confidence": round(conf * 100, 2)
        })

    return jsonify(results)


# ---- Main ----
if __name__ == "__main__":
    print("Starting backend (Flask + polling)...")

    # Authenticate Gmail
    service = authenticate_gmail()

    # Train model
    train_model()

    # Start polling thread
    t = threading.Thread(target=poll_inbox, daemon=True)
    t.start()
    print(f"🔁 Polling thread started (interval sec = {POLL_INTERVAL} )")

    # Start Flask server
    app.run(port=5000, debug=True)
