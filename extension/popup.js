const BACKEND = "https://unwanted-mail-sorter.onrender.com";

// Check if user is logged in
async function checkAuth() {
  try {
    const res = await fetch(`${BACKEND}/whoami`);
    const data = await res.json();

    if (!data.email) {
      document.getElementById("emails").innerHTML = " No user logged in.";
      document.getElementById("login").style.display = "block";
      document.getElementById("logout").style.display = "none";
      return null;
    }

    document.getElementById("login").style.display = "none";
    document.getElementById("logout").style.display = "block";
    return data.email;
  } catch (err) {
    console.error("checkAuth failed:", err);
    document.getElementById("emails").innerHTML = "⚠️ Could not connect to backend.";
    return null;
  }
}

// Fetch emails for logged-in user
async function fetchEmails(user) {
  const emailsDiv = document.getElementById("emails");
  emailsDiv.innerHTML = " Fetching emails...";

  try {
    const res = await fetch(`${BACKEND}/fetch-emails/${user}`);
    const data = await res.json();

    let emails = [];
    if (Array.isArray(data)) {
      emails = data;
    } else if (Array.isArray(data.emails)) {
      emails = data.emails;
    } else {
      emailsDiv.innerHTML = "⚠️ Unexpected response from backend.";
      return;
    }

    emailsDiv.innerHTML = "";
    emails.forEach((email) => {
      const card = document.createElement("div");
      card.className = "email-card";
      card.innerHTML = `
        <p><strong>${email.subject}</strong></p>
        <p>From: ${email.from}</p>
        <p>Label: ${email.label}</p>
        <p>Confidence: ${email.confidence.toFixed(2)}%</p>
        <hr>
      `;
      emailsDiv.appendChild(card);
    });

    if (emails.length === 0) {
      emailsDiv.innerHTML = " No emails found.";
    }
  } catch (err) {
    console.error("fetchEmails failed:", err);
    emailsDiv.innerHTML = "⚠️ Could not connect to backend.";
  }
}

// Button → login
document.getElementById("login").addEventListener("click", () => {
  chrome.tabs.create({ url: `${BACKEND}/login` });
});

// Button → refresh
document.getElementById("refresh").addEventListener("click", async () => {
  const user = await checkAuth();
  if (user) fetchEmails(user);
});

// Button → logout
document.getElementById("logout").addEventListener("click", async () => {
  try {
    const res = await fetch(`${BACKEND}/logout`, { method: "POST" });
    const data = await res.json();
    console.log("Logout:", data);

    document.getElementById("emails").innerHTML = "🛑 Logged out.";
    document.getElementById("login").style.display = "block";
    document.getElementById("logout").style.display = "none";
  } catch (err) {
    console.error("Logout failed:", err);
    document.getElementById("emails").innerHTML = "⚠️ Logout failed.";
  }
});

// Run on popup open
(async () => {
  const user = await checkAuth();
  if (user) fetchEmails(user);
})();
