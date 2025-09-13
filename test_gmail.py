from googleapiclient.discovery import build
from google.oauth2.credentials import Credentials

# Load saved credentials
SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.modify"
]

creds = Credentials.from_authorized_user_file("token.json", SCOPES)

# Build Gmail API service
service = build("gmail", "v1", credentials=creds)

# Fetch the latest 5 messages
results = service.users().messages().list(userId="me", maxResults=5).execute()
messages = results.get("messages", [])

if not messages:
    print("No messages found.")
else:
    print("✅ Connection successful! Latest 5 emails:")
    for msg in messages:
        m = service.users().messages().get(userId="me", id=msg["id"]).execute()
        headers = m["payload"]["headers"]
        subject = next((h["value"] for h in headers if h["name"] == "Subject"), "(no subject)")
        print(f"- {subject}")
