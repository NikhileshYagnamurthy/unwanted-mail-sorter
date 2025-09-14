from google_auth_oauthlib.flow import InstalledAppFlow
import json

SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

flow = InstalledAppFlow.from_client_secrets_file(
    "credentials.json",
    SCOPES
)

creds = flow.run_local_server(
    port=8080,
    access_type="offline",  # 👈 forces refresh token
    prompt="consent"        # 👈 makes Google ask every time
)

with open("token.json", "w") as token:
    token.write(creds.to_json())

print("✅ New token.json generated with refresh_token")
