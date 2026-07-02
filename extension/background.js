// background.js — InboxAI Service Worker
import { scoreEmail, batchScore, inboxAnalytics } from './scorer.js';
import * as gmail from './gmail_api.js';

console.log("InboxAI service worker started.");

// ── Config ─────────────────────────────────────────────────────────────────────
const BACKEND = "https://unwanted-mail-sorter.onrender.com";

// Cache for the backend JWT
let backendToken = null;

/**
 * Perform a login/token-exchange flow.
 * Detects expired Google tokens and attempts recovery.
 */
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
                    // Google token might be stale in Chrome's cache
                    console.warn("Backend rejected Google token. Clearing cache and retrying...");
                    chrome.identity.removeCachedAuthToken({ token: googleToken });
                    // One recursive retry without interaction
                    if (!interactive) {
                        resolve(await performAuthExchange(false));
                        return;
                    }
                }

                if (!response.ok) {
                    throw new Error(`Backend verification failed: ${response.status}`);
                }

                const data = await response.json();
                if (data.token) {
                    backendToken = data.token;
                    await chrome.storage.local.set({ backendToken: data.token });
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

/**
 * Reusable fetch helper for backend requests with auto-refresh.
 */
async function backendFetch(path, options = {}) {
    const url = path.startsWith("http") ? path : `${BACKEND}${path}`;
    const headers = options.headers || { "Content-Type": "application/json" };
    
    if (backendToken) {
        headers["Authorization"] = `Bearer ${backendToken}`;
    }

    let response = await fetch(url, { ...options, headers });

    // Handle expired backend JWT (401)
    if (response.status === 401 && backendToken) {
        console.log("Backend JWT expired. Attempting refresh...");
        try {
            // 1. Attempt silent refresh first
            await performAuthExchange(false);
            
            // Retry the original request with new token
            headers["Authorization"] = `Bearer ${backendToken}`;
            response = await fetch(url, { ...options, headers });
        } catch (refreshError) {
            console.warn("Silent refresh failed. Attempting interactive recovery...");
            
            try {
                // 2. Attempt interactive refresh (only if it's a user-initiated request)
                // We assume requests from popup are user-initiated.
                await performAuthExchange(true);
                
                // Retry the original request with new token
                headers["Authorization"] = `Bearer ${backendToken}`;
                response = await fetch(url, { ...options, headers });
            } catch (interactiveError) {
                console.error("Authentication recovery failed:", interactiveError);
                backendToken = null;
                await chrome.storage.local.remove("backendToken");
            }
        }
    }

    return response;
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // ── Unified API Request Handler ──
    if (message.action === "apiRequest") {
        backendFetch(message.url, {
            method: message.method || "GET",
            headers: message.headers,
            body: message.body || null,
        })
        .then(async response => {
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            return response.json();
        })
        .then(data => sendResponse({ success: true, data: data }))
        .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    // ── NEW: Local Gmail Scan ──
    if (message.action === "scanEmails") {
        (async () => {
            try {
                // 1. Check usage/auth with backend first (No Gmail content sent)
                const whoamiRes = await backendFetch("/whoami");

                if (whoamiRes.status === 401) throw new Error("Authentication expired. Please log in again.");
                if (!whoamiRes.ok) throw new Error(`Backend error: ${whoamiRes.status}`);

                const whoami = await whoamiRes.json();
                if (!whoami || !whoami.email) throw new Error("Not authenticated");
                
                // Check limits (simplified, backend still enforces this on actual actions)
                if (!whoami.is_premium && whoami.scans_today >= 5) {
                    throw new Error("Daily scan limit reached");
                }

                // 2. Fetch from Gmail API directly
                const maxResults = message.max || 25;
                const query = message.query || "in:inbox";
                const messages = await gmail.listMessages(query, maxResults);

                const rawEmails = [];
                for (const msg of messages) {
                    const data = await gmail.getMessageMetadata(msg.id);
                    const hdrs = {};
                    (data.payload.headers || []).forEach(h => hdrs[h.name] = h.value);
                    
                    rawEmails.push({
                        id: msg.id,
                        subject: hdrs["Subject"] || "(no subject)",
                        from: hdrs["From"] || "",
                        snippet: data.snippet || "",
                        headers: {
                            "List-Unsubscribe": hdrs["List-Unsubscribe"] || "",
                            "Precedence": hdrs["Precedence"] || "",
                        },
                    });
                }

                // 3. Local Scoring
                const scored = batchScore(rawEmails);
                
                // 4. Apply labels in Gmail
                for (const e of scored) {
                    const labelId = await gmail.getOrCreateLabel(e.label);
                    const addLabels = [labelId];
                    const removeLabels = e.archive ? ["INBOX"] : [];
                    await gmail.modifyMessage(e.id, addLabels, removeLabels).catch(() => {});
                }

                const analytics = inboxAnalytics(scored);

                // 5. Notify backend of scan (Increment usage counter)
                const usageResponse = await backendFetch("/usage/increment-scan", { method: "POST" });

                if (usageResponse.status === 429) throw new Error("Daily scan limit reached");
                if (!usageResponse.ok) console.warn("Failed to increment usage, but scan completed.");

                const usageRes = await usageResponse.json().catch(() => ({}));
                
                sendResponse({ 
                    success: true, 
                    data: { 
                        emails: scored, 
                        analytics: analytics,
                        scans_used: usageRes.scans_today || (whoami.scans_today || 0) + 1,
                        scans_remaining: whoami.is_premium ? "unlimited" : Math.max(0, 5 - (usageRes.scans_today || whoami.scans_today + 1))
                    } 
                });
            } catch (error) {
                console.error("Local scan failed:", error);
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }

    // ── NEW: Local Cleanup ──
    if (message.action === "cleanup") {
        (async () => {
            try {
                const ids = message.message_ids || [];
                
                // 1. Validate with backend first
                const validationRes = await backendFetch("/usage/validate-cleanup", {
                    method: "POST",
                    body: JSON.stringify({ count: ids.length })
                });

                if (validationRes.status === 403) {
                    const errData = await validationRes.json();
                    throw new Error(errData.error || "Cleanup limit exceeded");
                }
                if (!validationRes.ok) throw new Error(`Backend validation failed: ${validationRes.status}`);

                const validation = await validationRes.json();
                if (validation.error) throw new Error(validation.error);

                // 2. Perform actual Gmail operation
                await gmail.batchModifyMessages(ids, [], ["INBOX"]);
                sendResponse({ success: true, data: { cleaned: ids.length } });
            } catch (error) {
                sendResponse({ success: false, error: error.message });
            }
        })();
        return true;
    }
    
    if (message.action === "login") {
        performAuthExchange(true)
            .then(data => sendResponse({ success: true, email: data.email }))
            .catch(err => sendResponse({ success: false, error: err.message }));
        return true;
    }

    if (message.action === "openLogin") {
        chrome.tabs.create({
            url: "https://unwanted-mail-sorter.onrender.com/login"
        });
        return true;
    }
    
    if (message.action === "logout") {
        backendToken = null;
        chrome.storage.local.remove("backendToken");
        // Also clear chrome identity cache
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
            if (token) {
                chrome.identity.removeCachedAuthToken({ token: token });
            }
        });
        sendResponse({ success: true });
        return true;
    }
});

// Load token from storage on startup
chrome.storage.local.get(["backendToken"], (res) => {
    if (res.backendToken) backendToken = res.backendToken;
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("InboxAI extension installed successfully.");
});
