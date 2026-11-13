(() => {
  const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
  const PLAYBACK_EVENTS = ["play", "pause", "seeked"];
  const SEEK_TOLERANCE_SECONDS = 1.5;
  const SUPPRESSION_WINDOW_MS = 3000;

  function getVideoId(href = location.href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }

    if (!["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
      return null;
    }

    const watchId = url.pathname === "/watch" ? url.searchParams.get("v") : null;
    const pathMatch = url.pathname.match(/^\/(?:shorts|live|embed|v)\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    const videoId = watchId || (pathMatch && pathMatch[1]);
    return videoId && VIDEO_ID_PATTERN.test(videoId) ? videoId : null;
  }

  function getPlayer(documentRoot = document) {
    return documentRoot.querySelector("video.html5-main-video") ||
      documentRoot.querySelector("video");
  }

  function getSnapshot(player = getPlayer()) {
    if (!player) {
      return {
        position: 0,
        paused: true,
        duration: null,
        bufferedEnd: 0,
        readyState: 0,
        status: "loading"
      };
    }

    let bufferedEnd = 0;
    if (player.buffered.length) {
      bufferedEnd = player.buffered.end(player.buffered.length - 1);
    }

    const readyState = player.readyState;
    const position = Number.isFinite(player.currentTime) ? player.currentTime : 0;
    const duration = Number.isFinite(player.duration) && player.duration >= 0
      ? player.duration
      : null;
    const status = readyState < 2
      ? "loading"
      : player.seeking || (!player.paused && bufferedEnd - position < 2)
        ? "buffering"
        : player.paused
          ? "paused"
          : "playing";

    return {
      position,
      paused: player.paused,
      duration,
      bufferedEnd,
      readyState,
      status
    };
  }

  function createPlayerAdapter() {
    const suppressions = new WeakMap();

    function subscribe(player, onChange) {
      const onEvent = (event) => {
        const suppression = suppressions.get(player);
        if (suppression && Date.now() <= suppression.expiresAt) {
          if (event.type === "seeked" && suppression.seek !== null) {
            const isRemoteSeek =
              Math.abs(player.currentTime - suppression.seek) < SEEK_TOLERANCE_SECONDS;
            suppression.seek = null;
            if (isRemoteSeek) return;
          } else if (
            (event.type === "play" || event.type === "pause") &&
            suppression.paused !== null
          ) {
            const isRemotePause = player.paused === suppression.paused;
            suppression.paused = null;
            if (isRemotePause) return;
          }
        } else if (suppression) {
          suppressions.delete(player);
        }

        onChange(event);
      };

      for (const eventName of PLAYBACK_EVENTS) {
        player.addEventListener(eventName, onEvent);
      }

      return () => {
        for (const eventName of PLAYBACK_EVENTS) {
          player.removeEventListener(eventName, onEvent);
        }
      };
    }

    function applyPlayback(player, playback, onBlocked) {
      const seek = Math.abs(player.currentTime - playback.position) >= SEEK_TOLERANCE_SECONDS;
      const changePaused = player.paused !== playback.paused;
      if (!seek && !changePaused) return;

      const suppression = {
        seek: null,
        paused: null,
        expiresAt: Date.now() + SUPPRESSION_WINDOW_MS
      };
      suppressions.set(player, suppression);

      if (seek) {
        try {
          player.currentTime = playback.position;
          suppression.seek = player.currentTime;
        } catch {
          suppression.seek = null;
          onBlocked(new Error("Не удалось перемотать видео."));
        }
      }

      if (changePaused && playback.paused) {
        suppression.paused = true;
        player.pause();
      } else if (changePaused) {
        suppression.paused = false;
        player.play().catch((error) => {
          suppression.paused = null;
          onBlocked(error);
        });
      }
    }

    return { subscribe, applyPlayback };
  }

  globalThis.WatchTogetherYouTube = {
    getVideoId,
    getPlayer,
    getSnapshot,
    getWatchUrl: (videoId) => `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    createPlayerAdapter
  };
})();
