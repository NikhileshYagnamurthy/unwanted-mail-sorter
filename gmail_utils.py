import os
import base64
import re
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

# If modifying scopes, delete token.json
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

def authenticate_gmail():
    """Authenticate Gmail API and return service object."""
    creds = None
    if os.path.exists("token.json"):
        creds = Credentials.from_authorized_user_file("token.json", SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
            creds = flow.run_local_server(port=0)
        with open("token.json", "w") as token:
            token.write(creds.to_json())

    service = build("gmail", "v1", credentials=creds)
    return service


def fetch_recent_emails(service, max_results=10):
    """Fetch recent emails with subject lines."""
    results = service.users().messages().list(userId="me", maxResults=max_results).execute()
    messages = results.get("messages", [])
    emails = []

    for msg in messages:
        msg_data = service.users().messages().get(userId="me", id=msg["id"]).execute()
        headers = msg_data.get("payload", {}).get("headers", [])
        subject = ""
        for h in headers:
            if h["name"].lower() == "subject":
                subject = h["value"]
        emails.append({"id": msg["id"], "subject": subject})
    return emails


def move_to_label(service, msg_id, label_name="Filtered-Unwanted"):
    """Move an email to a label, creating it if needed."""
    # Check if label exists
    labels_res = service.users().labels().list(userId="me").execute()
    labels = labels_res.get("labels", [])
    label_id = None

    for l in labels:
        if l["name"].lower() == label_name.lower():
            label_id = l["id"]

    # Create if not exists
    if not label_id:
        label_obj = {"name": label_name, "labelListVisibility": "labelShow", "messageListVisibility": "show"}
        new_label = service.users().labels().create(userId="me", body=label_obj).execute()
        label_id = new_label["id"]

    # Move message
    service.users().messages().modify(
        userId="me",
        id=msg_id,
        body={"addLabelIds": [label_id], "removeLabelIds": ["INBOX"]}
    ).execute()
