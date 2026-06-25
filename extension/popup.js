// popup.js — InboxAI Chrome Extension
"use strict";

const BACKEND = "https://unwanted-mail-sorter.onrender.com";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const viewLogin = $("viewLogin");
const viewDash = $("viewDashboard");
const btnLogin = $("btnLogin");
const btnScan = $("btnScan");
const btnCleanup = $("btnCleanup");
const btnCleanLbl = $("btnCleanupLabel");
const btnLogout = $("btnLogout");
const btnSettings = $("btnSettings");
const emailList = $("emailList");
const emptyState = $("emptyState");
const statsBar = $("statsBar");
const usageBar = $("usageBar");
const loadingOvl = $("loadingOverlay");
const loadingMsg = $("loadingMsg");
const toast = $("toast");
const userBadge = $("userBadge");
const upgradeLink = $("upgradeLink");

// ── State ─────────────────────────────────────────────────────────────────────
let selectedIds = new Set();
let toastTimer = null;
let isChecking = false;

// ── Utility ───────────────────────────────────────────────────────────────────
function showToast(msg, type = "", duration = 3000) {
    toast.textContent = msg;
    toast.className = `toast ${type}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.className = "toast hidden";
    }, duration);
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

// ── API calls via background service worker ──────────────────────────────────
async function api(path, opts = {}) {
    return new Promise((resolve, reject) => {
        const url = `${BACKEND}${path}`;
        const method = opts.method || "GET";
        const body = opts.body || null;
        const headers = opts.headers || { "Content-Type": "application/json" };
        
        console.log("Sending API request to background:", url);
        
        chrome.runtime.sendMessage({
            action: "apiRequest",
            url: url,
            method: method,
            headers: headers,
            body: body
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error("chrome.runtime.lastError:", chrome.runtime.lastError);
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            if (response && response.success) {
                console.log("API response received:", response.data);
                resolve(response.data);
            } else {
                console.error("API Error:", response?.error);
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
        console.log("checkAuth response:", data);
        
        if (data && data.email) {
            userBadge.textContent = data.email;
            userBadge.classList.remove("hidden");
            showView(viewDash);
            updateUsageBar(data);
            return true;
        } else {
            showView(viewLogin);
            return false;
        }
    } catch (e) {
        console.error("checkAuth error:", e);
        showView(viewLogin);
        showToast("Could not connect to backend", "error");
        return false;
    } finally {
        isChecking = false;
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    console.log("Popup loaded, checking auth...");
    checkAuth();
});

// ── Login ─────────────────────────────────────────────────────────────────────
btnLogin.addEventListener("click", () => {
    chrome.runtime.sendMessage({ action: "openLogin" });
    showToast("Login window opened. Complete login and come back.", "", 5000);
});

// ── Logout ────────────────────────────────────────────────────────────────────
btnLogout.addEventListener("click", async () => {
    await api("/logout", { method: "POST" }).catch(() => {});
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

// ── Settings ──────────────────────────────────────────────────────────────────
btnSettings.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("settings.html") });
});

// ── Usage bar ─────────────────────────────────────────────────────────────────
function updateUsageBar(data) {
    if (data.is_premium) {
        usageBar.classList.add("hidden");
        return;
    }
    const FREE = 5;
    const used = data.scans_today || 0;
    const remaining = Math.max(0, FREE - used);
    $("usageText").textContent = `${remaining} free scan${remaining !== 1 ? "s" : ""} remaining today`;
    $("usageFill").style.width = `${Math.min(100, (used / FREE) * 100)}%`;
    usageBar.classList.remove("hidden");
}

// ── Upgrade Link ──────────────────────────────────────────────────────────────
if (upgradeLink) {
    upgradeLink.addEventListener("click", (e) => {
        e.preventDefault();
        showToast("Upgrade coming soon!", "info", 3000);
    });
}

// ── Scan ──────────────────────────────────────────────────────────────────────
btnScan.addEventListener("click", async () => {
    showLoading("Scanning your inbox…");
    btnScan.disabled = true;
    selectedIds.clear();

    try {
        const data = await api("/scan-emails?max=25");

        if (data.error) {
            hideLoading();
            if (data.error === "Daily scan limit reached") {
                showToast("Daily limit reached. Upgrade for unlimited scans.", "error", 5000);
            } else {
                showToast(data.error, "error");
            }
            btnScan.disabled = false;
            return;
        }

        const emails = data.emails || [];
        renderEmails(emails);
        renderStats(data.analytics);

        // Refresh usage bar
        const whoami = await api("/whoami").catch(() => null);
        if (whoami) updateUsageBar(whoami);

        const count = emails.length;
        showToast(`✦ Scanned ${count} email${count !== 1 ? "s" : ""}`, "success");

    } catch (e) {
        console.error("Scan error:", e);
        showToast("Connection failed. Is the backend awake?", "error");
    } finally {
        hideLoading();
        btnScan.disabled = false;
    }
});

// ── Stats ─────────────────────────────────────────────────────────────────────
function renderStats(analytics) {
    if (!analytics) return;
    $("statTotal").textContent = analytics.total ?? 0;
    $("statClutter").textContent = `${analytics.clutter_score ?? 0}%`;
    $("statPhishing").textContent = analytics.phishing_count ?? 0;
    $("statClean").textContent = analytics.archiveable ?? 0;
    statsBar.classList.remove("hidden");
}

// ── Badge colour map ──────────────────────────────────────────────────────────
const BADGE_CLASS = {
    "Promotion": "badge-promotion",
    "Newsletter": "badge-newsletter",
    "Phishing Risk": "badge-phishing",
    "Security Alert": "badge-security",
    "OTP / Auth": "badge-security",
    "Finance": "badge-finance",
    "Order Update": "badge-finance",
    "Recruiter": "badge-recruiter",
    "Social Update": "badge-social",
    "Meeting / Event": "badge-important",
    "Important": "badge-important",
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
        btnCleanLbl.textContent =
            `Archive ${selectedIds.size} email${selectedIds.size !== 1 ? "s" : ""}`;
    }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
btnCleanup.addEventListener("click", async () => {
    if (selectedIds.size === 0) return;

    showLoading(`Archiving ${selectedIds.size} emails…`);
    btnCleanup.disabled = true;

    try {
        const data = await api("/cleanup", {
            method: "POST",
            body: JSON.stringify({ message_ids: [...selectedIds] }),
        });

        if (data.error) {
            showToast(data.error, "error", 5000);
        } else {
            showToast(`✓ Archived ${data.cleaned} emails`, "success");
            selectedIds.forEach(id => {
                const card = document.querySelector(`.email-card[data-id="${id}"]`);
                if (card) card.remove();
            });
            selectedIds.clear();
            updateCleanupButton();
        }
    } catch (e) {
        showToast("Cleanup failed. Please retry.", "error");
    } finally {
        hideLoading();
        btnCleanup.disabled = false;
    }
});
