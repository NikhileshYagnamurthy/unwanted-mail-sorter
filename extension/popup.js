// popup.js — InboxAI Chrome Extension
"use strict";

const BACKEND = "https://unwanted-mail-sorter.onrender.com";

// ── Cache user in storage ──
async function getCachedUser() {
    return new Promise((resolve) => {
        chrome.storage.local.get(["cachedEmail", "cachedPremium"], (result) => {
            resolve(result.cachedEmail ? { email: result.cachedEmail, is_premium: result.cachedPremium || false } : null);
        });
    });
}

async function setCachedUser(email, is_premium = false) {
    return new Promise((resolve) => {
        chrome.storage.local.set({ cachedEmail: email, cachedPremium: is_premium }, resolve);
    });
}

async function clearCachedUser() {
    return new Promise((resolve) => {
        chrome.storage.local.remove(["cachedEmail", "cachedPremium", "backendToken"], resolve);
    });
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const viewLogin    = $("viewLogin");
const viewDash     = $("viewDashboard");
const btnLogin     = $("btnLogin");
const btnScan      = $("btnScan");
const btnCleanup   = $("btnCleanup");
const btnCleanLbl  = $("btnCleanupLabel");
const btnLogout    = $("btnLogout");
const btnSettings  = $("btnSettings");
const emailList    = $("emailList");
const emptyState   = $("emptyState");
const statsBar     = $("statsBar");
const usageBar     = $("usageBar");
const loadingOvl   = $("loadingOverlay");
const loadingMsg   = $("loadingMsg");
const toast        = $("toast");
const userBadge    = $("userBadge");
const upgradeLink  = $("upgradeLink");

// ── State ─────────────────────────────────────────────────────────────────────
let selectedIds   = new Set();
let toastTimer    = null;
let isChecking    = false;

// ── Utility ───────────────────────────────────────────────────────────────────
function showToast(msg, type = "", duration = 3000) {
    toast.textContent = msg;
    toast.className = `toast ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.className = "toast hidden"; }, duration);
}

function showLoading(msg = "Scanning your inbox…") {
    loadingMsg.textContent = msg;
    loadingOvl.classList.remove("hidden");
}

function hideLoading() {
    loadingOvl.classList.add("hidden");
}

function showView(view) {
    viewLogin.classList.add("hidden");
    viewDash.classList.add("hidden");
    view.classList.remove("hidden");
}

// ── Lightweight API helper (for /whoami only — still session/JWT based) ───────
async function api(path, opts = {}) {
    return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
            action: "apiRequest",
            url: `${BACKEND}${path}`,
            method: opts.method || "GET",
            headers: opts.headers || { "Content-Type": "application/json" },
            body: opts.body || null,
        }, (response) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (response && response.success) {
                resolve(response.data);
            } else {
                reject(new Error(response?.error || "API request failed"));
            }
        });
    });
}

// ── Check Auth ────────────────────────────────────────────────────────────────
async function checkAuth() {
    if (isChecking) return;
    isChecking = true;
    try {
        const data = await api("/whoami");
        if (data && data.email) {
            await setCachedUser(data.email, data.is_premium);
            userBadge.textContent = data.email;
            userBadge.classList.remove("hidden");
            showView(viewDash);
            updateUsageBar(data);
            return true;
        }
        // No valid session — check local cache as fallback display only
        const cached = await getCachedUser();
        if (cached) {
            userBadge.textContent = cached.email;
            userBadge.classList.remove("hidden");
            showView(viewDash);
            return true;
        }
        showView(viewLogin);
        return false;
    } catch (e) {
        console.error("checkAuth error:", e);
        const cached = await getCachedUser();
        if (cached) {
            userBadge.textContent = cached.email;
            userBadge.classList.remove("hidden");
            showView(viewDash);
            return true;
        }
        showView(viewLogin);
        showToast("Could not connect to backend", "error");
        return false;
    } finally {
        isChecking = false;
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
});

// ── Login ─────────────────────────────────────────────────────────────────────
// Uses the new background.js `login` action → chrome.identity.getAuthToken
btnLogin.addEventListener("click", () => {
    showLoading("Connecting to Google…");
    btnLogin.disabled = true;

    chrome.runtime.sendMessage({ action: "login" }, async (response) => {
        hideLoading();
        btnLogin.disabled = false;

        if (chrome.runtime.lastError) {
            showToast("Login failed: " + chrome.runtime.lastError.message, "error", 5000);
            return;
        }

        if (response && response.success) {
            await setCachedUser(response.email);
            userBadge.textContent = response.email;
            userBadge.classList.remove("hidden");
            showView(viewDash);
            // Refresh usage data
            api("/whoami").then(d => { if (d) updateUsageBar(d); }).catch(() => {});
            showToast("✦ Signed in successfully", "success");
        } else {
            const err = response?.error || "Unknown error";
            // Give actionable error message
            if (err.includes("OAuth2 not granted") || err.includes("No Google token")) {
                showToast("Sign-in setup needed — see README for OAuth steps", "error", 6000);
            } else {
                showToast("Login failed: " + err, "error", 5000);
            }
        }
    });
});

// ── Logout ────────────────────────────────────────────────────────────────────
btnLogout.addEventListener("click", async () => {
    chrome.runtime.sendMessage({ action: "logout" }, async () => {
        await clearCachedUser();
        userBadge.classList.add("hidden");
        selectedIds.clear();
        emailList.innerHTML = "";
        emailList.appendChild(emptyState);
        emptyState.classList.remove("hidden");
        statsBar.classList.add("hidden");
        usageBar.classList.add("hidden");
        showView(viewLogin);
        showToast("Signed out");
    });
});

// ── Settings ──────────────────────────────────────────────────────────────────
btnSettings.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

// ── Upgrade Link ──────────────────────────────────────────────────────────────
if (upgradeLink) {
    upgradeLink.addEventListener("click", (e) => {
        e.preventDefault();
        chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
    });
}

// ── Usage bar ─────────────────────────────────────────────────────────────────
function updateUsageBar(data) {
    if (data.is_premium) {
        usageBar.classList.add("hidden");
        return;
    }
    const FREE = 5;
    const used = data.scans_today || 0;
    const remaining = typeof data.scans_remaining === "number"
        ? data.scans_remaining
        : Math.max(0, FREE - used);
    $("usageText").textContent = `${remaining} free scan${remaining !== 1 ? "s" : ""} remaining today`;
    $("usageFill").style.width = `${Math.min(100, (used / FREE) * 100)}%`;
    usageBar.classList.remove("hidden");
}

// ── Scan ──────────────────────────────────────────────────────────────────────
// Uses the new `scanEmails` action in background.js which:
//  1. Checks usage/auth with backend JWT
//  2. Fetches emails directly from Gmail API (parallel)
//  3. Scores locally via scorer.js
//  4. Applies labels in Gmail
//  5. Notifies backend to increment usage counter
btnScan.addEventListener("click", () => {
    showLoading("Scanning your inbox…");
    btnScan.disabled = true;
    selectedIds.clear();

    // Read user's scanCount setting
    chrome.storage.local.get(["scanCount"], (s) => {
        const max = s.scanCount || 25;

        chrome.runtime.sendMessage(
            { action: "scanEmails", max, query: "in:inbox" },
            (response) => {
                hideLoading();
                btnScan.disabled = false;

                if (chrome.runtime.lastError) {
                    showToast("Extension error: " + chrome.runtime.lastError.message, "error");
                    return;
                }

                if (!response || !response.success) {
                    const err = response?.error || "Scan failed";
                    if (err === "Daily scan limit reached") {
                        showToast("Daily limit reached. Upgrade for unlimited scans.", "error", 5000);
                    } else if (err.includes("Not authenticated") || err.includes("expired")) {
                        showToast("Session expired — please sign in again.", "error", 5000);
                        showView(viewLogin);
                    } else {
                        showToast(err, "error");
                    }
                    return;
                }

                const data = response.data;
                const emails = data.emails || [];
                renderEmails(emails);
                renderStats(data.analytics);

                // Update usage display from scan response
                updateUsageBar({
                    is_premium: data.scans_remaining === "unlimited",
                    scans_today: data.scans_used || 0,
                    scans_remaining: data.scans_remaining,
                });

                showToast(`✦ Scanned ${emails.length} email${emails.length !== 1 ? "s" : ""}`, "success");
            }
        );
    });
});

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats(analytics) {
    if (!analytics) return;
    $("statTotal").textContent    = analytics.total ?? 0;
    $("statClutter").textContent  = `${analytics.clutter_score ?? 0}%`;
    $("statPhishing").textContent = analytics.phishing_count ?? 0;
    $("statClean").textContent    = analytics.archiveable ?? 0;
    statsBar.classList.remove("hidden");
}

// ── Badge colour map ──────────────────────────────────────────────────────────
const BADGE_CLASS = {
    "Promotion":       "badge-promotion",
    "Newsletter":      "badge-newsletter",
    "Phishing Risk":   "badge-phishing",
    "Security Alert":  "badge-security",
    "OTP / Auth":      "badge-security",
    "Finance":         "badge-finance",
    "Order Update":    "badge-finance",
    "Recruiter":       "badge-recruiter",
    "Social Update":   "badge-social",
    "Meeting / Event": "badge-important",
    "Important":       "badge-important",
};

// ── Render email list ─────────────────────────────────────────────────────────
function renderEmails(emails) {
    emailList.innerHTML = "";

    if (!emails.length) {
        emailList.appendChild(emptyState);
        emptyState.classList.remove("hidden");
        btnCleanup.classList.add("hidden");
        return;
    }
    emptyState.classList.add("hidden");

    emails.forEach(email => {
        const card = document.createElement("div");
        card.className = "email-card";
        card.dataset.id = email.id;

        const badgeClass = BADGE_CLASS[email.category] || "badge-default";
        const reasonTags = (email.reasons || []).map(r => {
            const isWarn = r.toLowerCase().includes("suspicious") ||
                           r.toLowerCase().includes("spoofing") ||
                           r.toLowerCase().includes("urgency");
            return `<span class="reason-tag ${isWarn ? "warn" : ""}">${r}</span>`;
        }).join("");

        card.innerHTML = `
            <div class="card-top">
                <div class="card-check"></div>
                <div class="card-info">
                    <div class="card-subject" title="${email.subject}">${email.subject}</div>
                    <div class="card-from">${email.from || "Unknown"}</div>
                </div>
                <span class="card-badge ${badgeClass}">${email.category}</span>
            </div>
            <div class="card-reasons">${reasonTags}</div>
            <div class="confidence-bar">
                <div class="conf-track">
                    <div class="conf-fill" style="width:${email.confidence}%"></div>
                </div>
                <span class="conf-label">${email.confidence}%</span>
            </div>
        `;

        card.addEventListener("click", () => toggleSelect(card, email.id));
        card.addEventListener("dblclick", e => {
            e.stopPropagation();
            card.classList.toggle("expanded");
        });

        emailList.appendChild(card);
    });
}

// ── Select / deselect ─────────────────────────────────────────────────────────
function toggleSelect(card, id) {
    if (selectedIds.has(id)) {
        selectedIds.delete(id);
        card.classList.remove("selected");
    } else {
        selectedIds.add(id);
        card.classList.add("selected");
    }
    updateCleanupButton();
}

function updateCleanupButton() {
    if (selectedIds.size === 0) {
        btnCleanup.classList.add("hidden");
    } else {
        btnCleanup.classList.remove("hidden");
        btnCleanLbl.textContent = `Archive ${selectedIds.size} email${selectedIds.size !== 1 ? "s" : ""}`;
    }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
// Uses the new `cleanup` action in background.js which:
//  1. Validates count against backend (free tier: 50 max)
//  2. Calls Gmail batchModify directly
btnCleanup.addEventListener("click", () => {
    if (selectedIds.size === 0) return;

    showLoading(`Archiving ${selectedIds.size} emails…`);
    btnCleanup.disabled = true;

    chrome.runtime.sendMessage(
        { action: "cleanup", message_ids: [...selectedIds] },
        (response) => {
            hideLoading();
            btnCleanup.disabled = false;

            if (chrome.runtime.lastError) {
                showToast("Extension error: " + chrome.runtime.lastError.message, "error");
                return;
            }

            if (!response || !response.success) {
                showToast(response?.error || "Cleanup failed. Please retry.", "error", 5000);
                return;
            }

            showToast(`✓ Archived ${response.data.cleaned} emails`, "success");
            selectedIds.forEach(id => {
                const card = document.querySelector(`.email-card[data-id="${id}"]`);
                if (card) card.remove();
            });
            selectedIds.clear();
            updateCleanupButton();
        }
    );
});
