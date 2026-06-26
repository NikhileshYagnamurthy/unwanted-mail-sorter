// background.js — InboxAI Service Worker

console.log("InboxAI service worker started.");

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "apiRequest") {
        console.log("Proxying API request:", message.url);
        
        fetch(message.url, {
            method: message.method || "GET",
            headers: message.headers || { "Content-Type": "application/json" },
            credentials: "include",
            body: message.body || null,
        })
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            return response.json();
        })
        .then(data => {
            console.log("API response received:", data);
            sendResponse({ success: true, data: data });
        })
        .catch(error => {
            console.error("API request failed:", error);
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }
    
    if (message.action === "openLogin") {
        chrome.tabs.create({
            url: "https://unwanted-mail-sorter.onrender.com/login"
        });
        return true;
    }
});

chrome.runtime.onInstalled.addListener(() => {
    console.log("InboxAI extension installed successfully.");
});
