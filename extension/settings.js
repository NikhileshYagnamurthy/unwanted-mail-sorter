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

// ── Check premium status ──────────────────────────────────────────────────────
async function checkPremiumStatus() {
  try {
    const res = await fetch(`${BACKEND}/whoami`, {
      credentials: "include",
      headers: { "Content-Type": "application/json" }
    });
    const data = await res.json();
    if (data && data.is_premium) {
      document.getElementById("premiumStatus").style.display = "block";
      document.getElementById("premiumStatus").textContent = "✦ You are already a premium member!";
      document.getElementById("btnUpgrade").disabled = true;
      document.getElementById("btnUpgrade").textContent = "✦ Premium Active";
    }
  } catch (e) {
    console.error("Failed to check premium status:", e);
  }
}
checkPremiumStatus();

// ── API call via background service worker ────────────────────────────────────
async function api(path, opts = {}) {
  return new Promise((resolve, reject) => {
    const url = `${BACKEND}${path}`;
    const method = opts.method || "GET";
    const body = opts.body || null;
    const headers = opts.headers || { "Content-Type": "application/json" };
    
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
        console.log("API response:", response.data);
        resolve(response.data);
      } else {
        console.error("API Error:", response?.error);
        reject(new Error(response?.error || "API request failed"));
      }
    });
  });
}

// ── Upgrade button ────────────────────────────────────────────────────────────
document.getElementById("btnUpgrade").addEventListener("click", async () => {
  const btn = document.getElementById("btnUpgrade");
  btn.disabled = true;
  btn.textContent = "Processing...";
  
  try {
    // 1. Get Razorpay Key
    const keyData = await api("/razorpay-key");
    
    if (keyData.error) {
      alert("Payment setup not configured. Please try again later.");
      btn.disabled = false;
      btn.textContent = selectedCurrency === "INR" ? "Upgrade — ₹10/mo" : "Upgrade — $1.19/mo";
      return;
    }
    
    // 2. Create order using the API function (sends credentials via background)
    const order = await api("/create-order", {
      method: "POST",
      body: JSON.stringify({ currency: selectedCurrency })
    });
    
    if (order.error) {
      alert("Failed to create order: " + order.error);
      btn.disabled = false;
      btn.textContent = selectedCurrency === "INR" ? "Upgrade — ₹10/mo" : "Upgrade — $1.19/mo";
      return;
    }
    
    // 3. Get user email
    const whoami = await api("/whoami");
    const userEmail = whoami.email || "";
    
    // 4. Open Razorpay Checkout
    const options = {
      key: keyData.key_id,
      amount: order.amount,
      currency: order.currency || "INR",
      name: "InboxAI Premium",
      description: "Unlimited scans & smart email organization",
      order_id: order.order_id,
      prefill: {
        email: userEmail
      },
      theme: {
        color: "#7c6aff"
      },
      handler: function(response) {
        // Verify payment on backend
        api("/payment-callback", {
          method: "POST",
          body: JSON.stringify({
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_signature: response.razorpay_signature,
            notes: { email: userEmail }
          })
        })
        .then(data => {
          if (data.status === "success") {
            document.getElementById("premiumStatus").style.display = "block";
            document.getElementById("premiumStatus").textContent = "✦ Premium activated!";
            btn.disabled = true;
            btn.textContent = "✦ Premium Active";
            alert("🎉 Premium activated successfully!");
          } else {
            alert("Payment verification failed. Please contact support.");
          }
        })
        .catch(err => {
          console.error("Verification error:", err);
          alert("Payment verification failed. Please contact support.");
        });
      },
      modal: {
        ondismiss: function() {
          btn.disabled = false;
          btn.textContent = selectedCurrency === "INR" ? "Upgrade — ₹10/mo" : "Upgrade — $1.19/mo";
        }
      }
    };
    
    const rzp = new Razorpay(options);
    rzp.open();
    
  } catch (error) {
    console.error("Payment error:", error);
    alert("Payment setup failed. Please try again.");
    btn.disabled = false;
    btn.textContent = selectedCurrency === "INR" ? "Upgrade — ₹10/mo" : "Upgrade — $1.19/mo";
  }
});
