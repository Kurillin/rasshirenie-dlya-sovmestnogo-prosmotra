const API_BASE = "https://ext.namalkin.site/watch-together/api";

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
