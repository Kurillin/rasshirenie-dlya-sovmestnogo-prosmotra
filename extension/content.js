(() => {
  const ROOT_ID = "watch-together-root";
  const POLL_INTERVAL = 1500;
  const $ = (root, selector) => root.querySelector(selector);
  const youtube = globalThis.WatchTogetherYouTube;
  const playerAdapter = youtube.createPlayerAdapter();

  let room = null;
  let panelOpen = false;
  let lastMessageId = 0;
  let currentVideo = null;
  let removePlayerListeners = null;
  let lastVideoId = youtube.getVideoId();
  let pollTimer = null;
  let ui;

  function getVideoId() {
    return youtube.getVideoId();
  }

  function request(method, path, body) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type: "watch-together:request", method, path, body },
        (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error("Не удалось связаться с расширением."));
            return;
          }
          if (!response || response.error) {
            const error = new Error(
              (response && response.error) || "Неизвестная ошибка."
            );
            error.status = response && response.status;
            error.data = response && response.data;
            reject(error);
            return;
          }
          resolve(response.data);
        }
      );
    });
  }

  function showError(message) {
    ui.error.textContent = message;
    ui.error.hidden = !message;
  }

  function renderPanel() {
    ui.panel.hidden = !panelOpen;
    ui.toggle.setAttribute("aria-expanded", String(panelOpen));
    if (panelOpen) ui.name.focus();
  }

  function createUI() {
    const root = document.createElement("section");
    root.id = ROOT_ID;
    root.innerHTML = `
      <button class="wt-toggle" type="button" aria-expanded="false">
        <span aria-hidden="true">◉</span> Смотреть вместе
      </button>
      <aside class="wt-panel" hidden aria-label="Совместный просмотр">
        <header class="wt-header">
          <div>
            <div class="wt-eyebrow">YOUTUBE WATCH PARTY</div>
            <h2>Смотрим вместе</h2>
          </div>
          <button class="wt-icon-button wt-close" type="button" aria-label="Закрыть">×</button>
        </header>
        <div class="wt-error" role="alert" hidden></div>
        <div class="wt-setup">
          <label class="wt-label" for="wt-name">Как вас называть</label>
          <input class="wt-input wt-name" id="wt-name" maxlength="32" autocomplete="nickname">
          <button class="wt-button wt-create" type="button">Создать комнату</button>
          <div class="wt-divider"><span>или</span></div>
          <label class="wt-label" for="wt-code">Код комнаты</label>
          <div class="wt-join-row">
            <input class="wt-input wt-code" id="wt-code" maxlength="12" placeholder="Например, A3F7K2M9PQ">
            <button class="wt-button wt-join" type="button">Войти</button>
          </div>
        </div>
        <div class="wt-session" hidden>
          <div class="wt-room-card">
            <div>
              <span class="wt-label">КОД КОМНАТЫ</span>
              <strong class="wt-room-code"></strong>
            </div>
            <button class="wt-copy wt-icon-button" type="button" title="Скопировать код" aria-label="Скопировать код">⧉</button>
          </div>
          <div class="wt-video-warning" hidden>
            Вы открыли другое видео.
            <button class="wt-open-video" type="button">Открыть видео комнаты</button>
          </div>
          <section class="wt-members-section">
            <div class="wt-section-title">Участники <span class="wt-member-count"></span></div>
            <ul class="wt-members"></ul>
          </section>
          <section class="wt-chat-section">
            <div class="wt-section-title">Чат</div>
            <ol class="wt-messages" aria-live="polite"></ol>
            <form class="wt-chat-form">
              <input class="wt-input wt-chat-input" maxlength="500" placeholder="Написать сообщение…" aria-label="Сообщение" autocomplete="off">
              <button class="wt-send" type="submit" aria-label="Отправить">➤</button>
            </form>
          </section>
          <button class="wt-leave" type="button">Покинуть комнату</button>
        </div>
      </aside>`;
    document.documentElement.append(root);

    ui = {
      root,
      toggle: $(root, ".wt-toggle"),
      panel: $(root, ".wt-panel"),
      close: $(root, ".wt-close"),
      error: $(root, ".wt-error"),
      setup: $(root, ".wt-setup"),
      session: $(root, ".wt-session"),
      name: $(root, ".wt-name"),
      code: $(root, ".wt-code"),
      create: $(root, ".wt-create"),
      join: $(root, ".wt-join"),
      roomCode: $(root, ".wt-room-code"),
      copy: $(root, ".wt-copy"),
      warning: $(root, ".wt-video-warning"),
      openVideo: $(root, ".wt-open-video"),
      memberCount: $(root, ".wt-member-count"),
      members: $(root, ".wt-members"),
      messages: $(root, ".wt-messages"),
      chatForm: $(root, ".wt-chat-form"),
      chatInput: $(root, ".wt-chat-input"),
      leave: $(root, ".wt-leave")
    };

    clientId().then((id) => {
      storedClientId = id;
      chrome.storage.local.get(["watchTogetherName", "watchTogetherRoom"], (data) => {
        if (data.watchTogetherName) ui.name.value = data.watchTogetherName;
        if (data.watchTogetherRoom) restoreRoom(data.watchTogetherRoom);
      });
    });

    ui.toggle.addEventListener("click", () => {
      panelOpen = !panelOpen;
      renderPanel();
    });
    ui.close.addEventListener("click", () => {
      panelOpen = false;
      renderPanel();
    });
    ui.create.addEventListener("click", createRoom);
    ui.join.addEventListener("click", joinRoom);
    ui.leave.addEventListener("click", leaveRoom);
    ui.copy.addEventListener("click", copyCode);
    ui.openVideo.addEventListener("click", openRoomVideo);
    ui.chatForm.addEventListener("submit", sendChatMessage);
    ui.name.addEventListener("change", saveName);
    ui.code.addEventListener("keydown", (event) => {
      if (event.key === "Enter") joinRoom();
    });
  }

  async function saveName() {
    const name = ui.name.value.trim().slice(0, 32);
    if (name) {
      await chrome.storage.local.set({ watchTogetherName: name });
      ui.name.value = name;
    }
  }

  async function clientId() {
    const data = await chrome.storage.local.get("watchTogetherClientId");
    if (data.watchTogetherClientId) {
      storedClientId = data.watchTogetherClientId;
      return storedClientId;
    }
    const id = crypto.randomUUID();
    await chrome.storage.local.set({ watchTogetherClientId: id });
    storedClientId = id;
    return id;
  }

  async function createRoom() {
    const videoId = getVideoId();
    if (!videoId) {
      showError("Откройте видео YouTube перед созданием комнаты.");
      return;
    }
    try {
      await saveName();
      const player = youtube.getPlayer();
      const snapshot = youtube.getSnapshot(player);
      const result = await request("POST", "/rooms", {
        video_id: videoId,
        client_id: await clientId(),
        name: ui.name.value.trim() || "Гость",
        position: snapshot.position,
        paused: snapshot.paused
      });
      await activateRoom(result);
    } catch (error) {
      showError(error.message);
    }
  }

  async function joinRoom() {
    const videoId = getVideoId();
    if (!videoId) {
      showError("Откройте видео YouTube перед входом в комнату.");
      return;
    }
    const code = ui.code.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    try {
      await saveName();
      const result = await request("POST", `/rooms/${encodeURIComponent(code)}/join`, {
        video_id: videoId,
        client_id: await clientId(),
        name: ui.name.value.trim() || "Гость"
      });
      await activateRoom(result);
    } catch (error) {
      if (error.status === 409 && error.data?.video_id) {
        room = { roomCode: code, videoId: error.data.video_id, joined: false };
        ui.roomCode.textContent = code;
        ui.setup.hidden = true;
        ui.session.hidden = false;
        ui.warning.hidden = false;
        await chrome.storage.local.set({ watchTogetherRoom: room });
        panelOpen = true;
        renderPanel();
        showError("Открываем видео создателя комнаты…");
        location.href = youtube.getWatchUrl(room.videoId);
        return;
      }
      showError(error.message);
    }
  }

  async function activateRoom(data) {
    room = { roomCode: data.room_code, videoId: data.video_id, joined: true };
    lastMessageId = 0;
    ui.roomCode.textContent = room.roomCode;
    ui.setup.hidden = true;
    ui.session.hidden = false;
    ui.warning.hidden = getVideoId() === room.videoId;
    showError("");
    await chrome.storage.local.set({ watchTogetherRoom: room });
    renderState(data);
    startPolling();
    panelOpen = true;
    renderPanel();
  }

  async function restoreRoom(saved) {
    if (!saved || typeof saved.roomCode !== "string" || typeof saved.videoId !== "string") {
      return;
    }
    room = { roomCode: saved.roomCode, videoId: saved.videoId, joined: false };
    ui.roomCode.textContent = room.roomCode;
    ui.setup.hidden = true;
    ui.session.hidden = false;
    ui.warning.hidden = getVideoId() === room.videoId;
    await resumeRoom();
  }

  async function resumeRoom() {
    if (!room || getVideoId() !== room.videoId) return;
    try {
      const data = await request(
        "POST",
        `/rooms/${encodeURIComponent(room.roomCode)}/join`,
        {
          video_id: room.videoId,
          client_id: await clientId(),
          name: ui.name.value.trim() || "Гость"
        }
      );
      room.joined = true;
      renderState(data);
      startPolling();
    } catch (error) {
      showError(error.message);
    }
  }

  function startPolling() {
    if (!room || !room.joined) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollRoom, 0);
  }

  async function pollRoom() {
    if (!room || !room.joined) return;
    try {
      await sendPresence();
      const state = await request(
        "GET",
        `/rooms/${encodeURIComponent(room.roomCode)}/state`
      );
      renderState(state);
      showError("");
    } catch (error) {
      showError(error.message);
    }
    pollTimer = setTimeout(pollRoom, POLL_INTERVAL);
  }

  function getVideo() {
    return youtube.getPlayer();
  }

  async function sendPresence() {
    const video = getVideo();
    const snapshot = youtube.getSnapshot(video);
    await request("POST", `/rooms/${encodeURIComponent(room.roomCode)}/presence`, {
      client_id: await clientId(),
      current_time: snapshot.position,
      duration: snapshot.duration,
      buffered_end: snapshot.bufferedEnd,
      ready_state: snapshot.readyState,
      status: snapshot.status
    });
  }

  function renderState(state) {
    renderMembers(state.members || []);
    renderMessages(state.messages || []);
    if (state.playback) applyPlayback(state.playback);
    ui.warning.hidden = getVideoId() === room.videoId;
  }

  function renderMembers(members) {
    ui.memberCount.textContent = String(members.length);
    ui.members.replaceChildren();
    for (const member of members) {
      const item = document.createElement("li");
      item.className = "wt-member";
      const info = document.createElement("div");
      info.className = "wt-member-info";
      const name = document.createElement("strong");
      name.textContent = member.name + (member.client_id === getStoredClientId() ? " (вы)" : "");
      const detail = document.createElement("span");
      detail.textContent = formatMemberStatus(member);
      info.append(name, detail);
      const indicator = document.createElement("span");
      indicator.className = `wt-indicator wt-${member.status}`;
      indicator.setAttribute("aria-label", member.status);
      item.append(info, indicator);
      ui.members.append(item);
    }
  }

  let storedClientId = null;
  function getStoredClientId() {
    return storedClientId;
  }

  function formatTime(value) {
    if (!Number.isFinite(value) || value < 0) return "--:--";
    const seconds = Math.floor(value);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainder = seconds % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
      : `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function formatMemberStatus(member) {
    const labels = {
      loading: "Загружает видео…",
      buffering: "Буферизация",
      paused: "На паузе",
      playing: "Смотрит"
    };
    let detail = labels[member.status] || "Подключён";
    if (Number.isFinite(member.duration) && member.duration > 0) {
      const buffered = Math.min(member.buffered_end || 0, member.duration);
      const percent = Math.floor((buffered / member.duration) * 100);
      detail += ` · буфер ${formatTime(buffered)} из ${formatTime(member.duration)} (${percent}%)`;
    }
    return detail;
  }

  function renderMessages(messages) {
    for (const message of messages) {
      if (message.id <= lastMessageId) continue;
      lastMessageId = message.id;
      const item = document.createElement("li");
      item.className = "wt-message";
      const author = document.createElement("strong");
      author.textContent = message.name;
      const text = document.createElement("span");
      text.textContent = message.text;
      const time = document.createElement("time");
      time.textContent = new Date(message.created_at * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
      item.append(author, time, text);
      ui.messages.append(item);
    }
    ui.messages.scrollTop = ui.messages.scrollHeight;
  }

  async function sendChatMessage(event) {
    event.preventDefault();
    const text = ui.chatInput.value.trim();
    if (!text || !room) return;
    ui.chatInput.value = "";
    try {
      await request("POST", `/rooms/${encodeURIComponent(room.roomCode)}/chat`, {
        client_id: await clientId(),
        text
      });
      showError("");
    } catch (error) {
      showError(error.message);
    }
  }

  function applyPlayback(playback) {
    const video = getVideo();
    if (!video || video.readyState < 1 || playback.updated_by === getStoredClientId()) return;
    playerAdapter.applyPlayback(video, playback, (error) => {
      showError(
        error.message === "Не удалось перемотать видео."
          ? error.message
          : "Браузер заблокировал автовоспроизведение. Нажмите ▶ на видео."
      );
    });
  }

  async function publishPlayback(video) {
    if (!room || getVideoId() !== room.videoId) return;
    try {
      await request("POST", `/rooms/${encodeURIComponent(room.roomCode)}/playback`, {
        client_id: await clientId(),
        position: youtube.getSnapshot(video).position,
        paused: video.paused
      });
    } catch (error) {
      showError(error.message);
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(room.roomCode);
      showError("Код скопирован. Отправьте его друзьям.");
      ui.error.classList.add("wt-success");
      setTimeout(() => ui.error.classList.remove("wt-success"), 2500);
    } catch {
      showError("Не удалось скопировать код. Выделите его вручную.");
    }
  }

  function openRoomVideo() {
    if (!room || !room.videoId) return;
    location.href = youtube.getWatchUrl(room.videoId);
  }

  async function leaveRoom() {
    room = null;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    lastMessageId = 0;
    ui.messages.replaceChildren();
    ui.setup.hidden = false;
    ui.session.hidden = true;
    ui.code.value = "";
    showError("");
    await chrome.storage.local.remove("watchTogetherRoom");
  }

  function attachVideoListeners() {
    const video = getVideo();
    if (!video || video === currentVideo) return;
    if (removePlayerListeners) removePlayerListeners();
    currentVideo = video;
    removePlayerListeners = playerAdapter.subscribe(
      video,
      () => publishPlayback(video)
    );
  }

  function monitorPage() {
    attachVideoListeners();
    const videoId = getVideoId();
    if (videoId !== lastVideoId) {
      lastVideoId = videoId;
      if (removePlayerListeners) removePlayerListeners();
      removePlayerListeners = null;
      currentVideo = null;
      if (room && videoId !== room.videoId) {
        room.joined = false;
        ui.warning.hidden = false;
        showError("Чтобы продолжить совместный просмотр, откройте видео комнаты.");
      } else if (room && !room.joined && videoId === room.videoId) {
        resumeRoom();
      }
    }
  }

  createUI();
  setInterval(monitorPage, 1000);
  window.addEventListener("beforeunload", () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (removePlayerListeners) removePlayerListeners();
  });
})();
