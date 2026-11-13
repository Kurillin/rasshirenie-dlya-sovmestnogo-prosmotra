const assert = require("node:assert/strict");
const test = require("node:test");

require("../extension/update-checker.js");

const { checkForUpdate, compareVersions } = globalThis.WatchTogetherUpdateChecker;

test("compares numeric version components rather than strings", () => {
  assert.equal(compareVersions("1.0.10", "1.0.2"), 1);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.0", "1.0.1"), -1);
  assert.throws(() => compareVersions("1.65536", "1.0"), /номер версии/);
});

test("reports a newer GitHub release with a canonical release page link", async () => {
  let requestUrl;
  const result = await checkForUpdate("1.0.0", async (url, options) => {
    requestUrl = url;
    assert.equal(options.cache, "no-store");
    return {
      status: 200,
      ok: true,
      json: async () => ({
        tag_name: "v1.0.10",
        html_url: "https://example.com/untrusted-link"
      })
    };
  });

  assert.match(requestUrl, /github\.com\/repos\/Yarowinindirection\//);
  assert.equal(result.available, true);
  assert.equal(result.latestVersion, "1.0.10");
  assert.equal(
    result.releaseUrl,
    "https://github.com/Yarowinindirection/rasshirenie-dlya-sovmestnogo-prosmotra/releases/tag/v1.0.10"
  );
});

test("does not report an equal or older release as an update", async () => {
  for (const tag of ["1.0.0", "v0.9.9"]) {
    const result = await checkForUpdate("1.0.0", async () => ({
      status: 200,
      ok: true,
      json: async () => ({ tag_name: tag })
    }));
    assert.equal(result.available, false);
  }
});

test("reports when no GitHub release has been published", async () => {
  const result = await checkForUpdate("1.0.0", async () => ({
    status: 404,
    ok: false
  }));
  assert.equal(result.releaseFound, false);
  assert.equal(result.available, false);
});

test("surfaces API errors and invalid release versions", async () => {
  await assert.rejects(
    checkForUpdate("1.0.0", async () => ({ status: 503, ok: false })),
    /503/
  );
  await assert.rejects(
    checkForUpdate("1.0.0", async () => ({
      status: 200,
      ok: true,
      json: async () => ({ tag_name: "latest" })
    })),
    /номер версии/
  );
});
