// settings.js — InboxAI Settings
const BACKEND = "https://unwanted-mail-sorter.onrender.com";

let selectedCurrency = "INR";

// ── Load settings from Chrome storage ─────────────────────────────────────────
chrome.storage.local.get(
  ["autoArchivePromo", "autoArchiveNews", "showReasons", "scanCount"],
  s => {
    if (s.autoArchivePromo !== undefined)
      document.getElementById("autoArchivePromo").checked = s.autoArchivePromo;
    if (s.autoArchiveNews !== undefined)
      document.getElementById("autoArchiveNews").checked = s.autoArchiveNews;
    if (s.showReasons !== undefined)
      document.getElementById("showReasons").checked = s.showReasons;
    if (s.scanCount !== undefined)
      document.getElementById("scanCount").value = s.scanCount;
  }
);

// ── Save settings ─────────────────────────────────────────────────────────────
document.getElementById("btnSave").addEventListener("click", () => {
  chrome.storage.local.set({
    autoArchivePromo: document.getElementById("autoArchivePromo").checked,
    autoArchiveNews:  document.getElementById("autoArchiveNews").checked,
    showReasons:      document.getElementById("showReasons").checked,
    scanCount:        Number(document.getElementById("scanCount").value),
  });
  const msg = document.getElementById("statusMsg");
  msg.textContent = "✓ Saved";
  setTimeout(() => msg.textContent = "", 2000);
});

// ── Check premium status on load ──────────────────────────────────────────────
async function checkStatus() {
  try {
    const res  = await fetch(`${BACKEND}/whoami`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    const premiumStatus = document.getElementById("premiumStatus");
    const btnUpgrade    = document.getElementById("btnUpgrade");
    if (!data || !data.email) {
      premiumStatus.style.display = "block";
      premiumStatus.textContent   = "⚠️ Please login to the extension first";
      premiumStatus.style.color   = "#f87171";
      btnUpgrade.disabled         = true;
      btnUpgrade.textContent      = "Login Required";
      return;
    }
    if (data.is_premium) {
      premiumStatus.style.display = "block";
      premiumStatus.textContent   = "✦ You are already a premium member!";
      premiumStatus.style.color   = "#34d399";
      btnUpgrade.disabled         = true;
      btnUpgrade.textContent      = "✦ Premium Active";
    }
  } catch (e) {
    console.error("Failed to check status:", e);
  }
}
checkStatus();

// ── Currency selector ─────────────────────────────────────────────────────────
document.querySelectorAll(".currency-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".currency-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedCurrency = btn.dataset.currency;
    document.getElementById("btnUpgrade").textContent =
      selectedCurrency === "INR" ? "Upgrade — ₹10/mo" : "Upgrade — $1.19/mo";
  });
});

// ── Upgrade: open hosted payment page on Render ───────────────────────────────
// WHY THIS APPROACH:
// Chrome MV3 extensions block external scripts like checkout.razorpay.com/v1/checkout.js
// due to strict Content Security Policy. Trying to load it inside the extension
// silently fails — Razorpay never initializes.
// Fix: open our /pay page hosted on Render (normal webpage, no CSP issues).
// We pass the selected currency along so /pay charges the right amount.
document.getElementById("btnUpgrade").addEventListener("click", () => {
  chrome.tabs.create({ url: `${BACKEND}/pay?currency=${selectedCurrency}` });
});
