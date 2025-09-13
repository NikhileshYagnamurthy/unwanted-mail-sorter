async function fetchEmails() {
  const emailsDiv = document.getElementById("emails");
  emailsDiv.innerHTML = "⏳ Fetching emails...";

  try {
    const res = await fetch("https://unwanted-mail-sorter.onrender.com/fetch-emails");
    const data = await res.json();

    if (!Array.isArray(data)) {
      emailsDiv.innerHTML = "⚠️ Unexpected response from backend.";
      return;
    }

    chrome.storage.sync.get(["threshold"], (result) => {
      const threshold = result.threshold || 0.6;
      emailsDiv.innerHTML = "";

      data.forEach(email => {
        const card = document.createElement("div");
        card.className = "email-card";

        let label = email.label;
        if (email.confidence < threshold * 100) {
          label = "Uncertain 🤔";
        }

        card.innerHTML = `
          <p><strong>${email.subject}</strong></p>
          <p>${label}</p>
          <p>Confidence: ${email.confidence.toFixed(2)}%</p>
          <hr>
        `;
        emailsDiv.appendChild(card);
      });
    });

  } catch (err) {
    console.error(err);
    emailsDiv.innerHTML = "⚠️ Could not connect to backend.";
  }
}

document.getElementById("refresh").addEventListener("click", fetchEmails);

// Run on popup open
fetchEmails();
