// background.js — InboxAI Service Worker
import { scoreEmail, batchScore, inboxAnalytics } from './scorer.js';
import * as gmail from './gmail_api.js';

console.log("InboxAI service worker started.");

const BACKEND = "https://unwanted-mail-sorter.onrender.com";
const OAUTH_CLIENT_ID = "707704340887-lmlgo23fvtvl98sfmid12fi1r6078kbm.apps.googleusercontent.com";
const OAUTH_SCOPES = [
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.readonly"
];

let backendToken = null;

async function exchangeTokenWithBackend(googleToken) {
    const response = await fetch(`${BACKEND}/auth/verify-google`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id_token: googleToken })
    });
    if (!response.ok) throw new Error(`Backend auth failed: ${response.status}`);
    const data = await response.json();
    if (!data.token) throw new Error(data.error || "No token in response");
    backendToken = data.token;
    await chrome.storage.local.set({ backendToken: data.token, cachedEmail: data.email });
    return { token: data.token, email: data.email };
}

async function getGoogleAccessToken() {
    return new Promise((resolve, reject) => {
        const redirectUri = chrome.identity.getRedirectURL();
        const authUrl =
            `https://accounts.google.com/o/oauth2/v2/auth?` +
            `client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}` +
            `&response_type=token` +
            `&redirect_uri=${encodeURIComponent(redirectUri)}` +
            `&scope=${encodeURIComponent(OAUTH_SCOPES.join(" "))}` +
            `&prompt=select_account` +
            `&access_type=online`;

        chrome.identity.launchWebAuthFlow(
            { url: authUrl, interactive: true },
            (responseUrl) => {
                if (chrome.runtime.lastError) {
                    return reject(new Error(chrome.runtime.lastError.message));
                }
                if (!responseUrl) return reject(new Error("No response URL returned"));
                const hash = new URL(responseUrl).hash.substring(1);
                const params = new URLSearchParams(hash);
                const token = params.get("access_token");
                if (!token) return reject(new Error("No access_token in response"));
                resolve(token);
            }
        );
    });
}

async function performInteractiveAuth() {
    const googleToken = await getGoogleAccessToken();
    await chrome.storage.local.set({ googleAccessToken: googleToken });
    return await exchangeTokenWithBackend(googleToken);
}

async function performSilentAuth() {
    const res = await chrome.storage.local.get(["googleAccessToken"]);
    if (!res.googleAccessToken) throw new Error("No cached Google token");
    return await exchangeTokenWithBackend(res.googleAccessToken);
}

async function backendFetch(path, options = {}) {
    const url = path.startsWith("http") ? path : `${BACKEND}${path}`;
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (backendToken) headers["Authorization"] = `Bearer ${backendToken}`;
    let response = await fetch(url, { ...options, headers });
    if (response.status === 401 && backendToken) {
        try {
            await performSilentAuth();
            headers["Authorization"] = `Bearer ${backendToken}`;
            response = await fetch(url, { ...options, headers });
        } catch {
            backendToken = null;
            chrome.storage.local.remove("backendToken");
        }
    }
    return response;
}

async function fetchMetadataBatch(messages, batchSize = 8) {
    const results = [];
    for (let i = 0; i < messages.length; i += batchSize) {
        const batch = messages.slice(i, i + batchSize);
        const batchResults = await Promise.all(
            batch.map(async (msg) => {
                try {
                    const data = await gmail.getMessageMetadata(msg.id);
                    const hdrs = {};
                    (data.payload?.headers || []).forEach(h => hdrs[h.name] = h.value);
                    return {
                        id: msg.id,
                        subject: hdrs["Subject"] || "(no subject)",
                        from: hdrs["From"] || "",
                        snippet: data.snippet || "",
                        headers: {
                            "List-Unsubscribe": hdrs["List-Unsubscribe"] || "",
                            "Precedence": hdrs["Precedence"] || "",
                        },
                    };
                } catch (err) {
                    console.warn(`Failed to fetch metadata for ${msg.id}:`, err);
                    return null;
                }
            })
        );
        results.push(...batchResults.filter(Boolean));
    }
    return results;
}

async function applyLabelsBatch(scored, batchSize = 8) {
    for (let i = 0; i < scored.length; i += batchSize) {
        const batch = scored.slice(i, i + batchSize);
        await Promise.all(
            batch.map(async (e) => {
                try {
                    const labelId = await gmail.getOrCreateLabel(e.label);
                    const removeLabels = e.archive ? ["INBOX"] : [];
                    await gmail.modifyMessage(e.id, [labelId], removeLabels);
                } catch (err) {
                    console.warn(`Failed to label ${e.id}:`, err);
                }
            })
        );
    }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "apiRequest") {
        const headers = { "Content-Type": "application/json", ...(message.headers || {}) };
        if (backendToken) headers["Authorization"] = `Bearer ${backendToken}`;
        fetch(message.url, {
            method: message.method || "GET",
            headers,
            body: message.body || null,
        })
        .then(r => {
            if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.statusText}`);
            return r.json();
        })
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === "scanEmails") {
        (async () => {
            try {
                const whoamiRes = await backendFetch("/whoami");
                if (whoamiRes.status === 401) throw new Error("Not authenticated. Please sign in.");
                if (!whoamiRes.ok) throw new Error(`Backend error: ${whoamiRes.status}`);
                const whoami = await whoamiRes.json();
                if (!whoami?.email) throw new Error("Not authenticated. Please sign in.");
                if (!whoami.is_premium && whoami.scans_today >= 5) {
                    throw new Error("Daily scan limit reached");
                }

                const maxResults = message.max || 25;
                const query = message.query || "in:inbox";
                const messages = await gmail.listMessages(query, maxResults);
                const rawEmails = await fetchMetadataBatch(messages, 8);
                const scored = batchScore(rawEmails);
                await applyLabelsBatch(scored, 8);
                const analytics = inboxAnalytics(scored);

                backendFetch("/usage/increment-scan", { method: "POST" })
                    .then(r => { if (r.status === 429) console.warn("Usage limit hit server-side"); })
                    .catch(e => console.warn("Usage increment failed:", e));

                sendResponse({
                    success: true,
                    data: {
                        emails: scored,
                        analytics,
                        scans_used: (whoami.scans_today || 0) + 1,
                        scans_remaining: whoami.is_premium
                            ? "unlimited"
                            : Math.max(0, 5 - (whoami.scans_today || 0) - 1),
                    }
                });
            } catch (error) {
                console.error("Scan failed:", error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

    if (message.action === "cleanup") {
        (async () => {
            try {
                const ids = message.message_ids || [];
                if (ids.length === 0) {
                    sendResponse({ success: true, data: { cleaned: 0 } });
                    return;
                }
                const validationRes = await backendFetch("/usage/validate-cleanup", {
                    method: "POST",
                    body: JSON.stringify({ count: ids.length })
                });
                if (validationRes.status === 403) {
                    const errData = await validationRes.json().catch(() => ({}));
                    throw new Error(errData.error || "Free tier: max 50 emails per cleanup. Upgrade for more.");
                }
                if (!validationRes.ok) throw new Error(`Validation failed: ${validationRes.status}`);

                await gmail.batchModifyMessages(ids, [], ["INBOX"]);
                sendResponse({ success: true, data: { cleaned: ids.length } });
            } catch (error) {
                console.error("Cleanup failed:", error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

    if (message.action === "login") {
        (async () => {
            try {
                const data = await performInteractiveAuth();
                sendResponse({ success: true, email: data.email });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    if (message.action === "logout") {
        backendToken = null;
        chrome.storage.local.remove(["backendToken", "cachedEmail", "cachedPremium", "googleAccessToken"]);
        chrome.identity.clearAllCachedAuthTokens(() => {
            console.log("All cached auth tokens cleared.");
        });
        sendResponse({ success: true });
        return true;
    }

    if (message.action === "openLogin") {
        chrome.tabs.create({ url: `${BACKEND}/login` });
        return true;
    }
});

chrome.storage.local.get(["backendToken"], (res) => {
    if (res.backendToken) backendToken = res.backendToken;
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("InboxAI extension installed successfully.");
});
