// Runs at document start and can also be injected into restored/existing tabs.
(() => {
  const browser = globalThis.chrome ?? globalThis.browser;
  if (globalThis.__valuableBotFeedObserver) return;
  globalThis.__valuableBotFeedObserver = true;
  let timer = null;
  let forceSignal = false;
  let htmlChanged = false;
  let dormant = false;
  let notifiedVersion = globalThis.__valuableBotPageReader?.version;
  const sendChange = () => {
    notifiedVersion = globalThis.__valuableBotPageReader?.version;
    browser.runtime.sendMessage({ type: "YOUTUBE_FEED_CHANGED" }).then((response) => {
      dormant = response?.idle === true;
    }).catch(() => {});
  };
  const notify = (force = false) => {
    // An opted-out fresh tab has no index yet. Stop bootstrap/noise messages;
    // enabling automatic mode installs its index and resumes this same observer.
    if (dormant && !globalThis.__valuableBotPageReader) return;
    forceSignal ||= force;
    // Coalesce only the current DOM burst, not a trailing debounce. New cards
    // never wait for a quiet feed, an earlier API request, or a periodic timer.
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const reader = globalThis.__valuableBotPageReader;
      reader?.flush();
      // An intervening label write/read may already have flushed the dirty
      // cards. Compare revisions so that it cannot swallow their notification.
      const changed = reader && reader.version !== notifiedVersion;
      if (!reader || changed || forceSignal || (htmlChanged && reader.watchHtml)) sendChange();
      forceSignal = false;
      htmlChanged = false;
    }, 0);
  };
  new MutationObserver((records) => {
    const reader = globalThis.__valuableBotPageReader;
    if (!reader) { notify(); return; }
    if (reader.invalidate(records)) {
      htmlChanged ||= reader.watchHtml;
      notify();
    }
  }).observe(document, {
    subtree: true, childList: true, characterData: true,
    // All attributes matter to the optional live HTML view. The reader filters
    // out non-video attributes before scheduling any extraction/classification.
    attributes: true,
  });
  document.addEventListener("yt-navigate-finish", () => {
    globalThis.__valuableBotPageReader?.navigate();
    notify(true);
  });
  for (const event of ["loadedmetadata", "durationchange"]) {
    document.addEventListener(event, (event) => {
      if (!event.target.matches?.("video.html5-main-video")) return;
      globalThis.__valuableBotPageReader?.playerChanged();
      notify();
    }, true);
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    globalThis.__valuableBotPageReader?.navigate();
    notify(true);
  });
  sendChange();
})();
