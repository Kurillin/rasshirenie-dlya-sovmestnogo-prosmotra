const assert = require("node:assert/strict");
const test = require("node:test");

require("../extension/youtube-adapter.js");

const adapter = globalThis.WatchTogetherYouTube;

test("recognizes standard, mobile, Shorts, live, embed, and legacy video URLs", () => {
  const cases = [
    ["https://www.youtube.com/watch?v=abcdefghijk", "abcdefghijk"],
    ["https://m.youtube.com/watch?v=abcdefghijk&t=30", "abcdefghijk"],
    ["https://www.youtube.com/shorts/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/live/abcdefghijk?feature=share", "abcdefghijk"],
    ["https://www.youtube.com/embed/abcdefghijk", "abcdefghijk"],
    ["https://www.youtube.com/v/abcdefghijk", "abcdefghijk"]
  ];

  for (const [url, expected] of cases) {
    assert.equal(adapter.getVideoId(url), expected, url);
  }
});

test("rejects non-YouTube pages, malformed IDs, and non-video routes", () => {
  assert.equal(adapter.getVideoId("https://example.com/watch?v=abcdefghijk"), null);
  assert.equal(adapter.getVideoId("https://www.youtube.com/watch?v=abcdefghij"), null);
  assert.equal(adapter.getVideoId("https://www.youtube.com/channel/abcdefghijk"), null);
  assert.equal(adapter.getVideoId("not a URL"), null);
});

test("selects the main YouTube video player before another video element", () => {
  const mainPlayer = {};
  const otherPlayer = {};
  const documentRoot = {
    querySelector(selector) {
      return selector === "video.html5-main-video" ? mainPlayer : otherPlayer;
    }
  };

  assert.equal(adapter.getPlayer(documentRoot), mainPlayer);
  assert.equal(adapter.getPlayer({ querySelector: () => null }), null);
});

test("reports player loading and buffering state and finite duration", () => {
  assert.deepEqual(adapter.getSnapshot(null), {
    position: 0,
    paused: true,
    duration: null,
    bufferedEnd: 0,
    readyState: 0,
    status: "loading"
  });

  const player = {
    currentTime: 12,
    duration: 100,
    paused: false,
    seeking: false,
    readyState: 3,
    buffered: { length: 1, end: () => 13 }
  };
  assert.equal(adapter.getSnapshot(player).status, "buffering");
  assert.equal(adapter.getSnapshot(player).duration, 100);
  assert.equal(adapter.getSnapshot(player).bufferedEnd, 13);

  player.buffered.end = () => 20;
  assert.equal(adapter.getSnapshot(player).status, "playing");
  player.duration = Infinity;
  assert.equal(adapter.getSnapshot(player).duration, null);
});

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this._currentTime = 0;
    this.paused = true;
    this.readyState = 4;
  }

  get currentTime() {
    return this._currentTime;
  }

  set currentTime(value) {
    this._currentTime = value;
    queueMicrotask(() => this.dispatchEvent(new Event("seeked")));
  }

  play() {
    this.paused = false;
    queueMicrotask(() => this.dispatchEvent(new Event("play")));
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }
}

test("does not echo remote seeking or playback changes as local actions", async () => {
  const player = new FakeVideo();
  const playerAdapter = adapter.createPlayerAdapter();
  const events = [];
  playerAdapter.subscribe(player, (event) => events.push(event.type));

  playerAdapter.applyPlayback(
    player,
    { position: 30, paused: false },
    (error) => assert.fail(error.message)
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(events, []);
  assert.equal(player.currentTime, 30);
  assert.equal(player.paused, false);

  player.pause();
  assert.deepEqual(events, ["pause"]);
});

test("reports blocked autoplay and allows future user events", async () => {
  const player = new FakeVideo();
  player.play = () => Promise.reject(new Error("autoplay blocked"));
  const playerAdapter = adapter.createPlayerAdapter();
  const events = [];
  const errors = [];
  playerAdapter.subscribe(player, (event) => events.push(event.type));

  playerAdapter.applyPlayback(
    player,
    { position: 0, paused: false },
    (error) => errors.push(error.message)
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(errors, ["autoplay blocked"]);
  player.dispatchEvent(new Event("play"));
  assert.deepEqual(events, ["play"]);
});
