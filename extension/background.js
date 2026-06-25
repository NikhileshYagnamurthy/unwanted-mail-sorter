// background.js — InboxAI service worker

const BACKEND = "https://unwanted-mail-sorter.onrender.com";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ threshold: 50, autoScan: false });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "openLogin") {
    chrome.tabs.create({ url: `${BACKEND}/login` });
    sendResponse({ ok: true });
  }
  if (msg.action === "getBackendUrl") {
    sendResponse({ url: BACKEND });
  }
  return true;
});
