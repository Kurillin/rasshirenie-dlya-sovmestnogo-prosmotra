const API_BASE = "https://ext.namalkin.site/watch-together/api";
const UPDATE_CACHE_KEY = "watchTogetherUpdateCheck";
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

importScripts("update-checker.js");

async function getUpdateStatus(force) {
  const cachedData = await chrome.storage.local.get(UPDATE_CACHE_KEY);
  const cached = cachedData[UPDATE_CACHE_KEY];
  if (
    !force &&
    cached &&
    Date.now() - cached.checkedAt < UPDATE_CHECK_INTERVAL
  ) {
    return cached.result;
  }

  const result = await WatchTogetherUpdateChecker.checkForUpdate(
    chrome.runtime.getManifest().version
  );
  await chrome.storage.local.set({
    [UPDATE_CACHE_KEY]: { checkedAt: Date.now(), result }
  });
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.type === "watch-together:check-updates") {
    getUpdateStatus(message.force === true)
      .then((result) => sendResponse({ data: result }))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (!message || message.type !== "watch-together:request") {
    return false;
  }

  const { method, path, body } = message;
  if (
    typeof method !== "string" ||
    typeof path !== "string" ||
    !path.startsWith("/") ||
    path.startsWith("//")
  ) {
    sendResponse({ error: "Некорректный запрос." });
    return false;
  }

  const options = { method, cache: "no-store" };
  if (body !== undefined) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  fetch(`${API_BASE}${path}`, options)
    .then(async (response) => {
      const payload = await response.json();
      if (!response.ok) {
        sendResponse({
          error: payload.error || `Ошибка сервера (${response.status}).`,
          status: response.status,
          data: payload
        });
        return;
      }
      sendResponse({ data: payload });
    })
    .catch(() => sendResponse({ error: "Нет связи с сервером просмотра." }));

  return true;
});
