(() => {
  const RELEASES_URL =
    "https://api.github.com/repos/Yarowinindirection/rasshirenie-dlya-sovmestnogo-prosmotra/releases/latest";
  const RELEASE_PAGE_URL =
    "https://github.com/Yarowinindirection/rasshirenie-dlya-sovmestnogo-prosmotra/releases/tag/";
  const VERSION_PATTERN = /^\d+(?:\.\d+){0,3}$/;

  function parseVersion(value) {
    if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
      throw new Error("Некорректный номер версии расширения.");
    }
    const parts = value.split(".").map(Number);
    if (parts.some((part) => !Number.isInteger(part) || part > 65535)) {
      throw new Error("Некорректный номер версии расширения.");
    }
    return parts;
  }

  function compareVersions(left, right) {
    const leftParts = parseVersion(left);
    const rightParts = parseVersion(right);
    const partCount = Math.max(leftParts.length, rightParts.length);
    for (let index = 0; index < partCount; index += 1) {
      const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
      if (difference !== 0) return Math.sign(difference);
    }
    return 0;
  }

  async function checkForUpdate(installedVersion, fetchImpl = fetch) {
    parseVersion(installedVersion);
    const response = await fetchImpl(RELEASES_URL, {
      headers: { Accept: "application/vnd.github+json" },
      cache: "no-store"
    });

    if (response.status === 404) {
      return {
        releaseFound: false,
        available: false,
        installedVersion,
        latestVersion: null,
        releaseUrl: null
      };
    }
    if (!response.ok) {
      throw new Error(`GitHub вернул ошибку проверки обновлений (${response.status}).`);
    }

    const release = await response.json();
    if (!release || typeof release.tag_name !== "string") {
      throw new Error("У релиза GitHub отсутствует номер версии.");
    }
    const tag = release.tag_name.trim();
    const latestVersion = tag.replace(/^v/i, "");
    parseVersion(latestVersion);

    return {
      releaseFound: true,
      available: compareVersions(latestVersion, installedVersion) > 0,
      installedVersion,
      latestVersion,
      releaseUrl: RELEASE_PAGE_URL + encodeURIComponent(tag)
    };
  }

  globalThis.WatchTogetherUpdateChecker = { checkForUpdate, compareVersions };
})();
