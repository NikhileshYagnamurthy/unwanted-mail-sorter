import os
import json
import logging
import pandas as pd
import joblib
from flask import Flask, request, jsonify, redirect
from flask_cors import CORS
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression

app = Flask(__name__)
CORS(app, resources={r"/*": {
    "origins": ["chrome-extension://dbbpcjelnbppmdodapgbeecmifndkibg"]
}})
app.secret_key = "super_secret_key"  # change in production

logging.basicConfig(level=logging.INFO)

# -------------------
# Google API config
# -------------------
GOOGLE_CLIENT_SECRETS_FILE = "/tmp/credentials.json"

if os.environ.get("GOOGLE_CREDENTIALS_JSON"):
    with open(GOOGLE_CLIENT_SECRETS_FILE, "w") as f:
        f.write(os.environ["GOOGLE_CREDENTIALS_JSON"])

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly"
]

USER_TOKENS = {}

# -------------------
# ML Model Setup
# -------------------
MODEL_FILE = "model.pkl"
VEC_FILE = "vectorizer.pkl"

def train_model():
    logging.info("📊 Training model from emails.csv...")
    df = pd.read_csv("emails.csv")
    vectorizer = TfidfVectorizer(stop_words="english")
    X = vectorizer.fit_transform(df["subject"])
    y = df["label"]

    model = LogisticRegression(max_iter=1000)
    model.fit(X, y)

    joblib.dump(model, MODEL_FILE)
    joblib.dump(vectorizer, VEC_FILE)
    logging.info("✅ Model trained and saved.")

def load_model():
    if not os.path.exists(MODEL_FILE) or not os.path.exists(VEC_FILE):
        train_model()
    model = joblib.load(MODEL_FILE)
    vectorizer = joblib.load(VEC_FILE)
    return model, vectorizer

model, vectorizer = load_model()

# -------------------
# Routes
# -------------------
@app.route("/")
def index():
    return "✅ Backend running with ML classifier!"

@app.route("/login")
def login():
    flow = Flow.from_client_secrets_file(
        GOOGLE_CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri="https://unwanted-mail-sorter.onrender.com/oauth2callback"
    )
    auth_url, state = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent"
    )
    return redirect(auth_url)

@app.route("/oauth2callback")
def oauth2callback():
    try:
        flow = Flow.from_client_secrets_file(
            GOOGLE_CLIENT_SECRETS_FILE,
            scopes=SCOPES,
            redirect_uri="https://unwanted-mail-sorter.onrender.com/oauth2callback"
        )
        flow.fetch_token(authorization_response=request.url)

        creds = flow.credentials
        service = build("gmail", "v1", credentials=creds)
        profile = service.users().getProfile(userId="me").execute()
        email = profile["emailAddress"]

        USER_TOKENS[email] = creds.to_json()
        logging.info(f"✅ Stored token for {email}")

        return f"Login successful! You can now fetch emails for {email}"

    except Exception as e:
        logging.exception("OAuth2 callback failed")
        return jsonify({"error": str(e)}), 500

def get_or_create_label(service, label_name="Filtered-Unwanted"):
    labels = service.users().labels().list(userId="me").execute().get("labels", [])
    for lbl in labels:
        if lbl["name"] == label_name:
            return lbl["id"]
    new_label = {
        "name": label_name,
        "labelListVisibility": "labelShow",
        "messageListVisibility": "show",
    }
    created = service.users().labels().create(userId="me", body=new_label).execute()
    return created["id"]

@app.route("/fetch-emails/<user>")
def fetch_and_classify_emails(user):
    try:
        if user not in USER_TOKENS:
            return jsonify({"error": f"No token found for user {user}"}), 400

        creds = Credentials.from_authorized_user_info(json.loads(USER_TOKENS[user]))
        service = build("gmail", "v1", credentials=creds)

        unwanted_label_id = get_or_create_label(service, "Filtered-Unwanted")

        results = service.users().messages().list(
            userId="me", maxResults=10
        ).execute()
        messages = results.get("messages", [])

        emails = []
        for msg in messages:
            msg_data = service.users().messages().get(
                userId="me", id=msg["id"], format="metadata"
            ).execute()
            headers = msg_data["payload"]["headers"]
            subject = next((h["value"] for h in headers if h["name"] == "Subject"), "")
            sender = next((h["value"] for h in headers if h["name"] == "From"), "")

            # ML Prediction
            X_test = vectorizer.transform([subject])
            pred = model.predict(X_test)[0]
            proba = model.predict_proba(X_test)[0].max() * 100

            label = pred
            if label == "Unwanted":
                service.users().messages().modify(
                    userId="me",
                    id=msg["id"],
                    body={"addLabelIds": [unwanted_label_id],
                          "removeLabelIds": ["INBOX"]}
                ).execute()

            emails.append({
                "id": msg["id"],
                "from": sender,
                "subject": subject,
                "label": label,
                "confidence": round(proba, 2)
            })

        return jsonify({"emails": emails})

    except Exception as e:
        logging.exception("Fetch+Classify failed")
        return jsonify({"error": str(e)}), 500

@app.route("/whoami")
def whoami():
    if not USER_TOKENS:
        return jsonify({"email": None})
    email = list(USER_TOKENS.keys())[0]
    return jsonify({"email": email})

@app.route("/logout/<user>", methods=["POST"])
def logout(user):
    if user in USER_TOKENS:
        USER_TOKENS.pop(user, None)
        logging.info(f"🚪 Logged out {user}")
        return jsonify({"msg": f"Logged out {user}"})
    return jsonify({"error": f"No session found for {user}"}), 400

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=10000)
