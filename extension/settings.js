// settings.js — InboxAI Settings

const BACKEND = "https://unwanted-mail-sorter.onrender.com";

// Load saved settings from Chrome storage
chrome.storage.local.get(
  ["autoArchivePromo", "autoArchiveNews", "scanCount"],
  s => {
    if (s.autoArchivePromo !== undefined)
      document.getElementById("autoArchivePromo").checked = s.autoArchivePromo;
    if (s.autoArchiveNews !== undefined)
      document.getElementById("autoArchiveNews").checked = s.autoArchiveNews;
    if (s.scanCount !== undefined)
      document.getElementById("scanCount").value = s.scanCount;
  }
);

// Save settings
document.getElementById("btnSave").addEventListener("click", () => {
  chrome.storage.local.set({
    autoArchivePromo: document.getElementById("autoArchivePromo").checked,
    autoArchiveNews:  document.getElementById("autoArchiveNews").checked,
    scanCount:        Number(document.getElementById("scanCount").value),
  });
  const msg = document.getElementById("statusMsg");
  msg.textContent = "✓ Saved";
  setTimeout(() => msg.textContent = "", 2000);
});

// Upgrade (stub — wire to Stripe later)
document.getElementById("btnUpgrade").addEventListener("click", async () => {
  try {
    const res = await fetch(`${BACKEND}/upgrade`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (data.is_premium) {
      document.getElementById("premiumStatus").style.display = "block";
      document.getElementById("btnUpgrade").disabled = true;
      document.getElementById("btnUpgrade").textContent = "✦ Premium Active";
    }
  } catch (e) {
    alert("Could not connect to server. Make sure you are logged in.");
  }
});
