const BACKEND = "https://unwanted-mail-sorter.onrender.com";

// Check if user is logged in
async function checkAuth() {
  const res = await fetch(`${BACKEND}/whoami`);
  const data = await res.json();

  if (!data.email) {
    // No user logged in → show login button
    document.getElementById("emails").innerHTML = "⚠️ No user logged in.";
    document.getElementById("login").style.display = "block";
    return null;
  }

  document.getElementById("login").style.display = "none";
  return data.email;
}

// Fetch emails for logged-in user
async function fetchEmails(user) {
  const emailsDiv = document.getElementById("emails");
  emailsDiv.innerHTML = "⏳ Fetching emails...";

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

    // Render emails
    emailsDiv.innerHTML = "";
    emails.forEach(email => {
      const card = document.createElement("div");
      card.className = "email-card";
      card.innerHTML = `
        <p><strong>${email.subject}</strong></p>
        <p>From: ${email.from}</p>
        <hr>
      `;
      emailsDiv.appendChild(card);
    });

    if (emails.length === 0) {
      emailsDiv.innerHTML = "📭 No emails found.";
    }
  } catch (err) {
    console.error(err);
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

// Run on popup open
(async () => {
  const user = await checkAuth();
  if (user) fetchEmails(user);
})();
