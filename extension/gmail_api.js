/**
 * Gmail API Client for InboxAI
 * Handles all direct communication with Gmail REST API.
 */

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

async function getAccessToken() {
    return new Promise((resolve, reject) => {
        chrome.identity.getAuthToken({ interactive: false }, (token) => {
            if (chrome.runtime.lastError || !token) {
                reject(new Error(chrome.runtime.lastError?.message || "No Google token"));
            } else {
                resolve(token);
            }
        });
    });
}

/**
 * Exponential backoff helper
 */
async function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function gmailFetch(path, options = {}, retryCount = 0) {
    const MAX_RETRIES = 3;
    const token = await getAccessToken();
    const url = `${GMAIL_BASE}${path}`;
    
    const headers = {
        ...options.headers,
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
    };

    try {
        const response = await fetch(url, { ...options, headers });
        
        // Handle expired token
        if (response.status === 401) {
            console.warn("Gmail API 401. Clearing cache and retrying...");
            chrome.identity.removeCachedAuthToken({ token });
            // Only retry token expiration once per request flow
            if (retryCount === 0) {
                return gmailFetch(path, options, retryCount + 1);
            }
            throw new Error("Gmail API Authentication persistent failure.");
        }

        // Handle temporary failures with exponential backoff (429, 5xx)
        if ((response.status === 429 || response.status >= 500) && retryCount < MAX_RETRIES) {
            const delay = Math.pow(2, retryCount) * 1000 + Math.random() * 1000;
            console.warn(`Gmail API ${response.status}. Retrying in ${Math.round(delay)}ms...`);
            await wait(delay);
            return gmailFetch(path, options, retryCount + 1);
        }

        if (!response.ok) {
            const error = await response.json().catch(() => ({ error: { message: response.statusText } }));
            throw new Error(error.error?.message || `Gmail API Error ${response.status}`);
        }

        return response.json();
    } catch (error) {
        // Handle network errors (offline, etc.)
        if (error.message.includes("fetch") && retryCount < MAX_RETRIES) {
            const delay = Math.pow(2, retryCount) * 1000;
            await wait(delay);
            return gmailFetch(path, options, retryCount + 1);
        }
        throw error;
    }
}

/**
 * List messages based on query
 */
async function listMessages(query = "in:inbox", maxResults = 25) {
    const data = await gmailFetch(`/messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`);
    return data.messages || [];
}

/**
 * Get full message metadata
 */
async function getMessageMetadata(id) {
    return gmailFetch(`/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=List-Unsubscribe&metadataHeaders=Precedence`);
}

/**
 * Get or create a label by name
 */
let labelCache = {};
async function getOrCreateLabel(name) {
    if (labelCache[name]) return labelCache[name];

    const data = await gmailFetch("/labels");
    const existing = data.labels.find(l => l.name.toLowerCase() === name.toLowerCase());
    
    if (existing) {
        labelCache[name] = existing.id;
        return existing.id;
    }

    const created = await gmailFetch("/labels", {
        method: "POST",
        body: JSON.stringify({
            name: name,
            labelListVisibility: "labelShow",
            messageListVisibility: "show"
        })
    });

    labelCache[name] = created.id;
    return created.id;
}

/**
 * Modify message labels (Add/Remove)
 */
async function modifyMessage(id, addLabelIds = [], removeLabelIds = []) {
    return gmailFetch(`/messages/${id}/modify`, {
        method: "POST",
        body: JSON.stringify({
            addLabelIds,
            removeLabelIds
        })
    });
}

/**
 * Batch modify messages
 */
async function batchModifyMessages(ids, addLabelIds = [], removeLabelIds = []) {
    if (ids.length === 0) return;
    return gmailFetch("/messages/batchModify", {
        method: "POST",
        body: JSON.stringify({
            ids,
            addLabelIds,
            removeLabelIds
        })
    });
}

// Export for background.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        listMessages,
        getMessageMetadata,
        getOrCreateLabel,
        modifyMessage,
        batchModifyMessages
    };
}
