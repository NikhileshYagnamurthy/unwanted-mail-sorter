// background.js — InboxAI Service Worker
import { scoreEmail, batchScore, inboxAnalytics } from './scorer.js';
import * as gmail from './gmail_api.js';

console.log("InboxAI service worker started.");

const BACKEND = "https://unwanted-mail-sorter.onrender.com";
let backendToken = null;

// ── Auth Exchange ─────────────────────────────────────────────────────────────
async function performAuthExchange(interactive = false) {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive }, async (googleToken) => {
            if (chrome.runtime.lastError || !googleToken) {
                const err = chrome.runtime.lastError?.message || "No Google token";
                console.error("Google Auth Error:", err);
                reject(new Error(err));
                return;
            }

            try {
                const response = await fetch(`${BACKEND}/auth/verify-google`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id_token: googleToken })
                });

                if (response.status === 401) {
                    console.warn("Backend rejected token. Clearing cache...");
                    chrome.identity.removeCachedAuthToken({ token: googleToken });
                    if (!interactive) {
                        resolve(await performAuthExchange(false));
                        return;
                    }
                }

                if (!response.ok) {
                    throw new Error(`Backend auth failed: ${response.status}`);
                }

                const data = await response.json();
                if (data.token) {
                    backendToken = data.token;
                    await chrome.storage.local.set({ backendToken: data.token, cachedEmail: data.email });
                    resolve({ token: data.token, email: data.email });
                } else {
                    throw new Error(data.error || "No token in response");
                }
            } catch (error) {
                console.error("Auth Exchange Error:", error);
                reject(error);
            }
        });
    });
}

// ── Backend Fetch with auto-refresh ──────────────────────────────────────────
async function backendFetch(path, options = {}) {
    const url = path.startsWith("http") ? path : `${BACKEND}${path}`;
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };

    if (backendToken) {
        headers["Authorization"] = `Bearer ${backendToken}`;
    }

    let response = await fetch(url, { ...options, headers });

    if (response.status === 401 && backendToken) {
        console.log("JWT expired. Refreshing...");
        try {
            await performAuthExchange(false);
            headers["Authorization"] = `Bearer ${backendToken}`;
            response = await fetch(url, { ...options, headers });
        } catch {
            try {
                await performAuthExchange(true);
                headers["Authorization"] = `Bearer ${backendToken}`;
                response = await fetch(url, { ...options, headers });
            } catch (e) {
                backendToken = null;
                chrome.storage.local.remove("backendToken");
                throw e;
            }
        }
    }
    return response;
}

// ── Parallel metadata fetch ───────────────────────────────────────────────────
// Fetches metadata for multiple messages concurrently in batches to avoid
// hitting Gmail API rate limits. Batch size of 8 gives ~3x speedup over
// sequential without triggering 429s.
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

// ── Label application in parallel ─────────────────────────────────────────────
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

// ── Message Handler ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

    // ── Passthrough API Request (for /whoami etc.) ──
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

    // ── Local Gmail Scan ──────────────────────────────────────────────────────
    if (message.action === "scanEmails") {
        (async () => {
            try {
                // 1. Auth check — fail fast if not signed in
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
                const query = message.query || "in:inbox";
                console.log(`Fetching up to ${maxResults} messages...`);
                const messages = await gmail.listMessages(query, maxResults);
                console.log(`Found ${messages.length} messages. Fetching metadata in parallel...`);

                // 3. Fetch metadata in parallel batches (much faster than sequential)
                const rawEmails = await fetchMetadataBatch(messages, 8);
                console.log(`Got metadata for ${rawEmails.length} emails. Scoring...`);

                // 4. Score locally
                const scored = batchScore(rawEmails);

                // 5. Apply Gmail labels in parallel batches
                console.log("Applying labels...");
                await applyLabelsBatch(scored, 8);

                const analytics = inboxAnalytics(scored);

                // 6. Tell backend to increment usage (fire-and-forget pattern)
                backendFetch("/usage/increment-scan", { method: "POST" })
                    .then(r => { if (r.status === 429) console.warn("Usage limit hit server-side"); })
                    .catch(e => console.warn("Usage increment failed (non-blocking):", e));

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

    // ── Cleanup ───────────────────────────────────────────────────────────────
    if (message.action === "cleanup") {
        (async () => {
            try {
                const ids = message.message_ids || [];
                if (ids.length === 0) {
                    sendResponse({ success: true, data: { cleaned: 0 } });
                    return;
                }

                // Validate against backend first (enforces free-tier 50 limit)
                const validationRes = await backendFetch("/usage/validate-cleanup", {
                    method: "POST",
                    body: JSON.stringify({ count: ids.length })
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

    // ── Login ─────────────────────────────────────────────────────────────────
    if (message.action === "login") {
        (async () => {
            try {
                const data = await performAuthExchange(true);
                sendResponse({ success: true, email: data.email });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        })();
        return true;
    }

    // ── Logout ────────────────────────────────────────────────────────────────
    if (message.action === "logout") {
        backendToken = null;
        chrome.storage.local.remove(["backendToken", "cachedEmail", "cachedPremium"]);
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
            if (token) chrome.identity.removeCachedAuthToken({ token });
        });
        sendResponse({ success: true });
        return true;
    }

    // ── Open login page (legacy fallback) ─────────────────────────────────────
    if (message.action === "openLogin") {
        chrome.tabs.create({ url: `${BACKEND}/login` });
        return true;
    }
});

// ── Restore token on startup ──────────────────────────────────────────────────
chrome.storage.local.get(["backendToken"], (res) => {
    if (res.backendToken) backendToken = res.backendToken;
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("InboxAI extension installed successfully.");
});
