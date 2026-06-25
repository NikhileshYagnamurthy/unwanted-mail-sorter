// popup.js — InboxAI Chrome Extension
"use strict";

const BACKEND = "https://unwanted-mail-sorter.onrender.com";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $           = id => document.getElementById(id);
const viewLogin   = $("viewLogin");
const viewDash    = $("viewDashboard");
const btnLogin    = $("btnLogin");
const btnScan     = $("btnScan");
const btnCleanup  = $("btnCleanup");
const btnCleanLbl = $("btnCleanupLabel");
const btnLogout   = $("btnLogout");
const btnSettings = $("btnSettings");
const emailList   = $("emailList");
const emptyState  = $("emptyState");
const statsBar    = $("statsBar");
const usageBar    = $("usageBar");
const loadingOvl  = $("loadingOverlay");
const loadingMsg  = $("loadingMsg");
const toast       = $("toast");
const userBadge   = $("userBadge");

// ── State ─────────────────────────────────────────────────────────────────────
let selectedIds = new Set();
let toastTimer  = null;

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

async function api(path, opts = {}) {
  const res = await fetch(`${BACKEND}${path}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  return res.json();
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(str, n) {
  return str.length > n ? str.slice(0, n) + "…" : str;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const data = await api("/whoami");
    if (data && data.email) {
      userBadge.textContent = data.email;
      userBadge.classList.remove("hidden");
      showView(viewDash);
      updateUsageBar(data);
    } else {
      showView(viewLogin);
    }
  } catch (e) {
    showView(viewLogin);
  }
}

// ── Login ─────────────────────────────────────────────────────────────────────
btnLogin.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "openLogin" });

  // Poll backend every 2 seconds to detect when login completes
  const poll = setInterval(async () => {
    try {
      const data = await api("/whoami");
      if (data && data.email) {
        clearInterval(poll);
        userBadge.textContent = data.email;
        userBadge.classList.remove("hidden");
        showView(viewDash);
        updateUsageBar(data);
        showToast("Logged in successfully!", "success");
      }
    } catch (e) {
      // still waiting
    }
  }, 2000);

  // Stop polling after 2 minutes
  setTimeout(() => clearInterval(poll), 120000);
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
    showToast("Connection failed. Is the backend awake?", "error");
  } finally {
    hideLoading();
    btnScan.disabled = false;
  }
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
  "Promotion":     "badge-promotion",
  "Newsletter":    "badge-newsletter",
  "Phishing Risk": "badge-phishing",
  "Security Alert":"badge-security",
  "OTP / Auth":    "badge-security",
  "Finance":       "badge-finance",
  "Order Update":  "badge-finance",
  "Recruiter":     "badge-recruiter",
  "Social Update": "badge-social",
  "Meeting / Event":"badge-important",
  "Important":     "badge-important",
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
      return `<span class="reason-tag ${isWarn ? "warn" : ""}">${escHtml(r)}</span>`;
    }).join("");

    card.innerHTML = `
      <div class="card-top">
        <div class="card-check"></div>
        <div class="card-info">
          <div class="card-subject" title="${escHtml(email.subject)}">${escHtml(email.subject)}</div>
          <div class="card-from">${escHtml(truncate(email.from || "", 42))}</div>
        </div>
        <span class="card-badge ${badgeClass}">${escHtml(email.category)}</span>
      </div>
      <div class="card-reasons">${reasonTags}</div>
      <div class="confidence-bar">
        <div class="conf-track">
          <div class="conf-fill" style="width:${email.confidence}%"></div>
        </div>
        <span class="conf-label">${email.confidence}%</span>
      </div>
    `;

    // Click = select/deselect
    card.addEventListener("click", () => toggleSelect(card, email.id));

    // Double-click = expand reasons
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
      // Remove archived cards from UI
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

// ── Start ─────────────────────────────────────────────────────────────────────
init();
