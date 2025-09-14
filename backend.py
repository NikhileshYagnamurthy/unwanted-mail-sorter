from flask import Flask, redirect, request, jsonify, session
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
import os
import json

app = Flask(__name__)
app.secret_key = "super_secret_key"  # change in production

# Load your client secrets (the one you already have in credentials.json)
GOOGLE_CLIENT_SECRETS_FILE = "credentials.json"
SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]

# Temporary storage (later replace with DB)
USER_TOKENS = {}

@app.route("/login")
def login():
    flow = Flow.from_client_secrets_file(
        GOOGLE_CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri="http://localhost:5000/oauth2callback"  # in prod: https://yourapp.onrender.com/oauth2callback
    )
    auth_url, _ = flow.authorization_url(
        access_type="offline",
        include_granted_scopes="true",
        prompt="consent"
    )
    return redirect(auth_url)


@app.route("/oauth2callback")
def oauth2callback():
    flow = Flow.from_client_secrets_file(
        GOOGLE_CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri="http://localhost:5000/oauth2callback"  # change in Render
    )
    flow.fetch_token(authorization_response=request.url)

    creds = flow.credentials
    user_info = get_user_info(creds)  # we’ll define this helper below

    # Save refresh_token per user (for now just in memory)
    USER_TOKENS[user_info["email"]] = {
        "refresh_token": creds.refresh_token,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "token_uri": creds.token_uri,
        "scopes": creds.scopes
    }

    return jsonify({"msg": "Login successful", "user": user_info})


def get_user_info(creds):
    """Helper to fetch user email after login."""
    from googleapiclient.discovery import build
    service = build("oauth2", "v2", credentials=creds)
    return service.userinfo().get().execute()
