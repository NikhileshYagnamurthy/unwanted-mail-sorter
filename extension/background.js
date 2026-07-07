// background.js — InboxAI Service Worker
import { scoreEmail, batchScore, inboxAnalytics } from './scorer.js';
import * as gmail from './gmail_api.js';

console.log("InboxAI service worker started.");

const BACKEND = "https://unwanted-mail-sorter.onrender.com";
let backendToken = null;

// ── Token exchange with backend ────────────────────────────────────────────────
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

// ── Silent auth (no UI) ────────────────────────────────────────────────────────
// Reuses Chrome's cached grant without any UI — only used for token refresh.
async function performSilentAuth() {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: false }, async (googleToken) => {
            if (chrome.runtime.lastError || !googleToken) {
                reject(new Error(chrome.runtime.lastError?.message || "No cached token"));
                return;
            }
            try { resolve(await exchangeTokenWithBackend(googleToken)); }
            catch (e) { reject(e); }
        });
    });
}

// ── Interactive auth — ALWAYS shows Google account picker ──────────────────────
// Uses launchWebAuthFlow with prompt=select_account so the user always sees
// the account chooser regardless of Chrome's cached state.
// getAuthToken({ interactive: true }) silently reuses the Chrome profile account
// without showing any UI — that's why we use launchWebAuthFlow here instead.
async function performInteractiveAuth() {
    return new Promise((resolve, reject) => {
        const manifest    = chrome.runtime.getManifest();
        const clientId    = manifest.oauth2.client_id;
        const scopes      = manifest.oauth2.scopes.join(" ");
        const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

        const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authUrl.searchParams.set("client_id",     clientId);
        authUrl.searchParams.set("response_type", "token");
        authUrl.searchParams.set("redirect_uri",  redirectUri);
        authUrl.searchParams.set("scope",         scopes);
        authUrl.searchParams.set("prompt",        "select_account"); // always show picker

        chrome.identity.launchWebAuthFlow(
            { url: authUrl.toString(), interactive: true },
            async (redirectUrl) => {
                if (chrome.runtime.lastError || !redirectUrl) {
                    reject(new Error(chrome.runtime.lastError?.message || "Sign-in cancelled"));
                    return;
                }
                // Access token lives in the URL hash: #access_token=xxx&token_type=Bearer&...
                const params      = new URLSearchParams(new URL(redirectUrl).hash.slice(1));
                const accessToken = params.get("access_token");
                if (!accessToken) {
                    reject(new Error("No access token in response"));
                    return;
                }
                try { resolve(await exchangeTokenWithBackend(accessToken)); }
                catch (e) { reject(e); }
            }
        );
    });
}

// ── Backend Fetch with auto-refresh ───────────────────────────────────────────
async function backendFetch(path, options = {}) {
    const url     = path.startsWith("http") ? path : `${BACKEND}${path}`;
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (backendToken) headers["Authorization"] = `Bearer ${backendToken}`;

    let response = await fetch(url, { ...options, headers });

    // JWT expired — try silent refresh first, then give up (don't re-prompt interactively
    // here; that would show an unexpected popup mid-scan)
    if (response.status === 401 && backendToken) {
        console.log("JWT expired. Attempting silent refresh...");
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

// ── Parallel metadata fetch ────────────────────────────────────────────────────
// Fetches metadata for multiple messages concurrently in batches.
// Batch of 8 gives ~3x speedup over sequential without triggering Gmail 429s.
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
                        id:      msg.id,
                        subject: hdrs["Subject"] || "(no subject)",
                        from:    hdrs["From"]    || "",
                        snippet: data.snippet    || "",
                        headers: {
                            "List-Unsubscribe": hdrs["List-Unsubscribe"] || "",
                            "Precedence":       hdrs["Precedence"]       || "",
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

// ── Label application in parallel ─────────────────────────────────────────────
async function applyLabelsBatch(scored, batchSize = 8) {
    for (let i = 0; i < scored.length; i += batchSize) {
        const batch = scored.slice(i, i + batchSize);
        await Promise.all(
            batch.map(async (e) => {
                try {
                    const labelId      = await gmail.getOrCreateLabel(e.label);
                    const removeLabels = e.archive ? ["INBOX"] : [];
                    await gmail.modifyMessage(e.id, [labelId], removeLabels);
                } catch (err) {
                    console.warn(`Failed to label ${e.id}:`, err);
                }
            })
        );
    }
}

// ── Message Handler ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // ── Passthrough API Request (for /whoami etc.) ─────────────────────────
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

    // ── Local Gmail Scan ───────────────────────────────────────────────────
    if (message.action === "scanEmails") {
        (async () => {
            try {
                // 1. Auth check — fail fast with a clear message
                const whoamiRes = await backendFetch("/whoami");
                if (whoamiRes.status === 401) throw new Error("Not authenticated. Please sign in.");
                if (!whoamiRes.ok) throw new Error(`Backend error: ${whoamiRes.status}`);
                const whoami = await whoamiRes.json();
                if (!whoami?.email) throw new Error("Not authenticated. Please sign in.");
                if (!whoami.is_premium && whoami.scans_today >= 5) {
                    throw new Error("Daily scan limit reached");
                }

                // 2. List messages from Gmail
                const maxResults = message.max || 25;
                const query      = message.query || "in:inbox";
                console.log(`Fetching up to ${maxResults} messages...`);
                const messages = await gmail.listMessages(query, maxResults);
                console.log(`Found ${messages.length} messages. Fetching metadata in parallel...`);

                // 3. Parallel metadata fetch (much faster than sequential)
                const rawEmails = await fetchMetadataBatch(messages, 8);
                console.log(`Metadata done for ${rawEmails.length} emails. Scoring...`);

                // 4. Local scoring (zero backend calls, zero latency)
                const scored = batchScore(rawEmails);

                // 5. Apply Gmail labels in parallel batches
                console.log("Applying labels...");
                await applyLabelsBatch(scored, 8);

                const analytics = inboxAnalytics(scored);

                // 6. Increment usage counter (fire-and-forget — doesn't block scan response)
                backendFetch("/usage/increment-scan", { method: "POST" })
                    .then(r => { if (r.status === 429) console.warn("Usage limit hit server-side"); })
                    .catch(e => console.warn("Usage increment failed (non-blocking):", e));

                sendResponse({
                    success: true,
                    data: {
                        emails:          scored,
                        analytics,
                        scans_used:      (whoami.scans_today || 0) + 1,
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

    // ── Cleanup ────────────────────────────────────────────────────────────
    if (message.action === "cleanup") {
        (async () => {
            try {
                const ids = message.message_ids || [];
                if (ids.length === 0) {
                    sendResponse({ success: true, data: { cleaned: 0 } });
                    return;
                }
                // Validate against backend (enforces free-tier 50 email limit)
                const validationRes = await backendFetch("/usage/validate-cleanup", {
                    method: "POST",
                    body:   JSON.stringify({ count: ids.length })
                });
                if (validationRes.status === 403) {
                    const errData = await validationRes.json().catch(() => ({}));
                    throw new Error(errData.error || "Free tier: max 50 emails per cleanup. Upgrade for more.");
                }
                if (!validationRes.ok) throw new Error(`Validation failed: ${validationRes.status}`);

                // Archive directly via Gmail API
                await gmail.batchModifyMessages(ids, [], ["INBOX"]);
                sendResponse({ success: true, data: { cleaned: ids.length } });
            } catch (error) {
                console.error("Cleanup failed:", error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

    // ── Login — shows account picker every time ────────────────────────────
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

    // ── Logout — fully clears ALL cached tokens ────────────────────────────
    if (message.action === "logout") {
        backendToken = null;
        chrome.storage.local.remove(["backendToken", "cachedEmail", "cachedPremium"]);
        // clearAllCachedAuthTokens wipes every token Chrome has stored for this
        // extension — ensures the next login always shows the account picker
        chrome.identity.clearAllCachedAuthTokens(() => {
            console.log("All cached auth tokens cleared.");
        });
        sendResponse({ success: true });
        return true;
    }

    // ── Legacy fallback ────────────────────────────────────────────────────
    if (message.action === "openLogin") {
        chrome.tabs.create({ url: `${BACKEND}/login` });
        return true;
    }
});

// ── Restore token on startup ───────────────────────────────────────────────────
chrome.storage.local.get(["backendToken"], (res) => {
    if (res.backendToken) backendToken = res.backendToken;
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("InboxAI extension installed successfully.");
});
