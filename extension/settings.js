document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.sync.get(["threshold"], (result) => {
    document.getElementById("threshold").value = result.threshold || 0.6;
  });
});

document.getElementById("save").addEventListener("click", () => {
  const threshold = parseFloat(document.getElementById("threshold").value);
  if (isNaN(threshold) || threshold < 0 || threshold > 1) {
    document.getElementById("status").innerText = "⚠️ Enter a valid number between 0 and 1.";
    return;
  }
  chrome.storage.sync.set({ threshold }, () => {
    document.getElementById("status").innerText = "✅ Saved!";
  });
});
