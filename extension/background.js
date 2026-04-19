// Omrum URL reporter — sends the active tab URL to a local daemon.
// No remote endpoints. No data leaves the machine.

const ENDPOINT = "http://127.0.0.1:7942/api/browser";
const POST_INTERVAL_MS = 15_000; // heartbeat so idle stale-detection works

let lastSent = { url: "", title: "", at: 0 };

async function post(payload) {
  try {
    await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
    lastSent = { url: payload.url, title: payload.title, at: Date.now() };
  } catch (_e) {
    // daemon not running — silently drop
  }
}

async function reportActive() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url || !/^https?:/i.test(tab.url)) {
      await post({ url: "", title: "" });
      return;
    }
    await post({ url: tab.url, title: tab.title || "" });
  } catch (_e) {
    // ignore
  }
}

chrome.tabs.onActivated.addListener(reportActive);

chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
  if (!tab.active) return;
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    reportActive();
  }
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await post({ url: "", title: "" });
  } else {
    reportActive();
  }
});

// Heartbeat: re-assert current tab every POST_INTERVAL_MS so the daemon
// can tell the user is still on this URL (events have a short TTL server-side).
chrome.alarms.create("heartbeat", { periodInMinutes: POST_INTERVAL_MS / 60_000 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "heartbeat") reportActive();
});

// Fire once on install/startup
reportActive();
