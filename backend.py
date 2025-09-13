from __future__ import print_function
import os
import csv
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

# ML libraries
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
import pandas as pd
import numpy as np

# Gmail scopes (readonly + modify to apply labels)
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify"
]

# Label name in Gmail where unwanted mails will be moved
UNWANTED_LABEL = "Filtered-Unwanted"


# ------------------- AUTH -------------------
def authenticate_gmail():
    """Authenticate and return Gmail API service"""
    creds = None
    if os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
            creds = flow.run_local_server(port=8080)
        with open("token.json", "w") as token:
            token.write(creds.to_json())

    service = build("gmail", "v1", credentials=creds)
    return service


# ------------------- FETCH EMAILS -------------------
def fetch_emails(service, max_results=20):
    """Fetch email subjects + IDs from inbox"""
    results = service.users().messages().list(userId="me", maxResults=max_results).execute()
    messages = results.get("messages", [])
    email_data = []

    for msg in messages:
        msg_data = service.users().messages().get(userId="me", id=msg["id"]).execute()
        payload = msg_data.get("payload", {})
        headers = payload.get("headers", [])
        subject = "(no subject)"
        for header in headers:
            if header["name"] == "Subject":
                subject = header["value"]
                break
        email_data.append({"id": msg["id"], "subject": subject})
    return email_data


# ------------------- EXPORT CSV -------------------
def export_to_csv(subjects, filename="emails.csv"):
    """Export fetched emails into a CSV for manual labeling"""
    if os.path.exists(filename):
        print(f"⚠️ {filename} already exists. Not overwriting. Label your emails there.")
        return

    with open(filename, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f, quoting=csv.QUOTE_ALL)
        writer.writerow(["Subject", "Label"])  # Header
        for subject in subjects:
            writer.writerow([subject, ""])  # Empty label
    print(f"✅ Emails exported to {filename}. Open it and label Wanted/Unwanted.")


# ------------------- TRAIN MODEL -------------------
def train_model_from_csv(filename="emails.csv"):
    """Train a Logistic Regression model from labeled CSV"""
    if not os.path.exists(filename):
        print("❌ No emails.csv file found. Run export step first.")
        return None, None

    df = pd.read_csv(filename).dropna()

    if df.empty:
        print("❌ No labeled data found. Please label some emails in emails.csv first.")
        return None, None

    vectorizer = TfidfVectorizer()
    X = vectorizer.fit_transform(df["Subject"])
    y = df["Label"]

    model = LogisticRegression(max_iter=200)
    model.fit(X, y)

    print("✅ Model trained successfully on your labeled data.")
    return vectorizer, model


# ------------------- CLASSIFY -------------------
def classify_emails(service, emails, vectorizer, model):
    """Classify and optionally move unwanted emails"""
    if not vectorizer or not model:
        print("❌ Model not trained yet.")
        return

    subjects = [e["subject"] for e in emails]
    X_test = vectorizer.transform(subjects)
    predictions = model.predict(X_test)
    probs = model.predict_proba(X_test)

    for i, (subject, pred) in enumerate(zip(subjects, predictions)):
        confidence = np.max(probs[i]) * 100
        print(f"Subject: {subject} → {pred} ({confidence:.2f}% confident)")

        if pred == "Unwanted":
            move_to_label(service, emails[i]["id"], UNWANTED_LABEL)


# ------------------- MOVE TO LABEL -------------------
def move_to_label(service, msg_id, label_name):
    """Move email to a Gmail label"""
    # Get all labels
    labels_resp = service.users().labels().list(userId="me").execute()
    labels = labels_resp.get("labels", [])
    label_id = None

    for label in labels:
        if label["name"] == label_name:
            label_id = label["id"]
            break

    if not label_id:
        print(f"❌ Label '{label_name}' not found in Gmail. Please create it first.")
        return

    service.users().messages().modify(
        userId="me",
        id=msg_id,
        body={"addLabelIds": [label_id], "removeLabelIds": ["INBOX"]}
    ).execute()
    print(f"📩 Moved email to label: {label_name}")


# ------------------- MAIN -------------------
if __name__ == "__main__":
    service = authenticate_gmail()

    # Step 1: Export to CSV (first run only)
    subjects = [e["subject"] for e in fetch_emails(service, max_results=20)]
    export_to_csv(subjects)

    # Step 2: Train model (after labeling emails.csv)
    vectorizer, model = train_model_from_csv()

    # Step 3: Classify and auto-move new emails
    if model:
        new_emails = fetch_emails(service, max_results=10)
        classify_emails(service, new_emails, vectorizer, model)
