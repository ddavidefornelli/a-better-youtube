// Self-contained: Chrome serializes this function into the tab's isolated world.
// Keep the DOM index there, not in the service worker. Reading an unchanged page
// and applying one decision must never walk the entire feed again.
export function processYouTubePage(options = {}) {
  const { expectedUrl = null } = options;
  if (expectedUrl && location.href !== expectedUrl) return { stale: true, labeledCount: 0 };
  let reader = globalThis.__valuableBotPageReader;
  if (!reader || reader.document !== document) {
    const cardSelector = "ytm-shorts-lockup-view-model, .shortsLockupViewModelHost, ytd-rich-item-renderer, ytd-rich-grid-media, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, yt-lockup-view-model, .yt-lockup-view-model, .yt-lockup-view-model-wiz, ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, yt-shorts-lockup-view-model, ytm-video-with-context-renderer, ytm-compact-video-renderer";
    const titleSelector = "#video-title, #video-title-link, .yt-lockup-metadata-view-model__title, .yt-lockup-metadata-view-model-wiz__title, .yt-lockup-metadata-view-model__heading-reset, .yt-lockup-metadata-view-model-wiz__heading-reset, .shortsLockupViewModelHostMetadataTitle, .shortsLockupViewModelHostOutsideMetadataTitle, #video-title-container, .media-item-headline, h3 a[href], h3";
    const durationSelector = "ytd-thumbnail-overlay-time-status-renderer #text, .yt-badge-shape__text, .yt-badge-shape-wiz__text, .yt-thumbnail-overlay-badge-view-model__badge-text";
    const linkSelector = 'a[href*="/watch?"], a[href*="/shorts/"]';
    const watchSelector = "ytd-watch-metadata h1 yt-formatted-string, ytd-video-primary-info-renderer h1 yt-formatted-string";
    const relevantSelector = `${cardSelector}, ${linkSelector}, ${watchSelector}`;
    const titles = new Map();
    const cardContainers = new WeakSet();
    const thumbnails = new Map();
    const decisions = new Map();
    const hidden = new Set();
    let hideStyle;
    const dirty = new Set([document]);
    let byUrl = new Map();
    let titleIndex = new Map();
    let thumbnailIndex = new Map();
    let pageUrl = location.href;
    let videos = [];
    let signature = "";
    let version = 0;
    let htmlVersion = 0;
    let snapshotDecisions = [];
    let snapshotVersion = -1;
    const clean = (value) => value?.replace(/\s+/g, " ").trim() || "";
    const key = (video) => JSON.stringify([video.title, video.duration ?? null]);
    const contains = (root, node) => root === document || root === node || root.contains?.(node);
    const select = (root, selector) => [
      ...(root.matches?.(selector) ? [root] : []), ...root.querySelectorAll(selector),
    ];
    const videoUrl = (href) => {
      if (!href) return null;
      let url;
      try { url = new URL(href, location.href); } catch { return null; }
      if (url.protocol !== "https:" || !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) return null;
      if (url.pathname === "/watch" && url.searchParams.get("v")) {
        url.search = `?v=${encodeURIComponent(url.searchParams.get("v"))}`;
      } else if (/^\/shorts\/[^/]+\/?$/.test(url.pathname)) url.search = "";
      else return null;
      url.hash = "";
      return url.href;
    };
    const readTitle = (element) => {
      if (!element) return "";
      const attribute = element.getAttribute("title");
      if (attribute) return clean(attribute);
      if (!element.querySelector("[data-valuable-bot-label]")) return clean(element.textContent) || clean(element.getAttribute("aria-label"));
      const copy = element.cloneNode(true);
      for (const marker of copy.querySelectorAll("[data-valuable-bot-label]")) marker.remove();
      return clean(copy.textContent) || clean(element.getAttribute("aria-label"));
    };
    const formatDuration = (seconds) => {
      const total = Math.floor(seconds);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      return `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(total % 60).padStart(2, "0")}`;
    };
    const cardRoot = (element, url) => {
      let root = element.closest(cardSelector);
      if (root === document.body || root === document.documentElement) return null;
      if (root && select(root, linkSelector).some((link) => videoUrl(link.href) !== url)) root = null;
      if (root) {
        // Hide the grid item too, so nested cards don't leave empty grid slots.
        for (let parent = root.parentElement?.closest(cardSelector); parent; parent = parent.parentElement?.closest(cardSelector)) {
          if (parent === document.body || parent === document.documentElement) break;
          if (select(parent, linkSelector).some((link) => videoUrl(link.href) !== url)) break;
          root = parent;
        }
        return root;
      }
      // Unknown layouts: find the smallest single-video container shared by
      // the heading and thumbnail. Never hide a whole feed or the page body.
      const heading = element.closest("h3");
      const fallback = element.closest("li, article") || (heading?.parentElement === document.body || heading?.parentElement === document.documentElement ? heading : heading?.parentElement);
      for (let parent = fallback; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
        const links = select(parent, linkSelector);
        if (links.some((link) => videoUrl(link.href) !== url)) return heading || null;
        if (links.some((link) => link.querySelector("img, yt-image, ytd-thumbnail, .ytThumbnailViewModelHost"))) return parent;
      }
      return fallback || null;
    };
    const scan = (root, affected, foundTitles, foundThumbnails) => {
      const visit = (element, href, duration, isWatch = false) => {
        if (!element || foundTitles.has(element)) return;
        const url = videoUrl(href);
        const title = readTitle(element);
        if (!url || !title) return;
        foundTitles.add(element);
        const previous = titles.get(element);
        if (previous) affected.add(previous.url);
        titles.set(element, { title, url, duration: duration || null, isWatch, container: isWatch ? null : cardRoot(element, url) });
        affected.add(url);
      };
      if (root.isConnected !== false) {
        const watchTitle = root.matches?.(watchSelector) ? root : root.querySelector(watchSelector);
        if (location.pathname === "/watch" && watchTitle) {
          const player = document.querySelector("video.html5-main-video");
          const duration = player && Number.isFinite(player.duration) && player.duration > 0 ? formatDuration(player.duration) : null;
          visit(watchTitle, location.href, duration, true);
        }
        for (const card of select(root, cardSelector)) {
          cardContainers.add(card);
          const element = card.querySelector(titleSelector);
          const link = element?.closest("a[href]") || element?.querySelector("a[href]") || card.querySelector(linkSelector);
          visit(element, link?.href, clean(card.querySelector(durationSelector)?.textContent));
        }
        // A single link pass covers unknown containers, modern plain-text h3
        // anchors, and thumbnails. Never classify accessibility/thumbnail text.
        for (const link of select(root, linkSelector)) {
          const title = link.matches?.(titleSelector) || link.closest("h3") ? link
            : link.querySelector("#video-title, h3, .yt-core-attributed-string") || (link.matches?.("a[title]") ? link : null);
          const container = link.closest(cardSelector);
          visit(title, link.href, clean(container?.querySelector(durationSelector)?.textContent));
          if (link.querySelector("img, yt-image, ytd-thumbnail, .ytThumbnailViewModelHost")) {
            const previous = thumbnails.get(link);
            if (previous) affected.add(previous);
            const url = videoUrl(link.href);
            if (url) {
              thumbnails.set(link, url);
              foundThumbnails.add(link);
              affected.add(url);
            }
          }
        }
      }
    };
    const pruneDecisions = () => {
      if (decisions.size <= 1000) return;
      const active = new Set(videos.map(key));
      for (const decisionKey of decisions.keys()) {
        if (decisions.size <= Math.max(1000, active.size)) break;
        if (!active.has(decisionKey)) decisions.delete(decisionKey);
      }
    };
    const index = () => {
      byUrl = new Map();
      titleIndex = new Map();
      thumbnailIndex = new Map();
      const add = (map, url, element) => {
        if (!map.has(url)) map.set(url, new Set());
        map.get(url).add(element);
      };
      for (const [element, video] of titles) {
        const previous = byUrl.get(video.url);
        if (!previous) byUrl.set(video.url, { title: video.title, url: video.url, duration: video.duration });
        else if (!previous.duration && video.duration) previous.duration = video.duration;
        add(titleIndex, video.url, element);
      }
      for (const [link, url] of thumbnails) add(thumbnailIndex, url, link);
      videos = [...byUrl.values()];
      const activeContainers = new Set([...titles.values()].map((entry) => entry.container));
      for (const root of hidden) {
        if (!activeContainers.has(root)) { root.removeAttribute("data-valuable-bot-hidden"); hidden.delete(root); }
      }
      pruneDecisions();
      const next = JSON.stringify([pageUrl, videos]);
      if (next !== signature) { signature = next; version++; }
    };
    const updateVisibility = (urls) => {
      let changed = false;
      for (const url of urls) {
        const video = byUrl.get(url);
        const decision = video && decisions.get(key(video));
        for (const element of titleIndex.get(url) || []) {
          const entry = titles.get(element);
          const root = entry.container;
          if (!root) continue; // Keep the current watch-page title/player visible.
          const shouldHide = reader.hideBad && entry.title === video?.title && decision?.label === "bad";
          if (shouldHide && (!hidden.has(root) || root.getAttribute("data-valuable-bot-hidden") === null || !hideStyle?.isConnected)) {
            if (!hideStyle?.isConnected) {
              hideStyle = document.createElement("style");
              hideStyle.setAttribute("data-valuable-bot-label", "");
              hideStyle.textContent = "[data-valuable-bot-hidden]{display:none!important}";
              (document.head || document.documentElement).append(hideStyle);
            }
            root.setAttribute("data-valuable-bot-hidden", ""); hidden.add(root); changed = true;
          } else if (!shouldHide && (hidden.has(root) || root.getAttribute("data-valuable-bot-hidden") !== null)) {
            root.removeAttribute("data-valuable-bot-hidden"); hidden.delete(root); changed = true;
          }
        }
      }
      if (changed) { version++; htmlVersion++; }
    };
    const apply = (urls) => {
      let changed = false;
      let labeledCount = 0;
      for (const url of urls) {
        const video = byUrl.get(url);
        const decision = video && decisions.get(key(video));
        for (const element of titleIndex.get(url) || []) {
          const entry = titles.get(element);
          let marker = element.querySelector("[data-valuable-bot-label]");
          const validVideo = video && entry.title === video.title;
          const valid = validVideo && decision;
          if (marker && (!validVideo || marker.getAttribute("data-video-url") !== url
              || marker.getAttribute("data-video-title") !== video.title
              || marker.getAttribute("data-video-duration") !== (video.duration || ""))) {
            marker.remove(); marker = null; changed = true;
          }
          if (!valid) continue;
          const text = `[${decision.label.toUpperCase()}] `;
          if (marker?.textContent !== text) {
            marker ||= document.createElement("span");
            marker.setAttribute("data-valuable-bot-label", "");
            marker.setAttribute("data-video-url", url);
            marker.setAttribute("data-video-title", video.title);
            marker.setAttribute("data-video-duration", video.duration || "");
            marker.textContent = text;
            marker.style.color = decision.label === "good" ? "#16a34a" : "#ef4444";
            marker.style.fontWeight = "700";
            marker.title = "Jev: fit for deep coding, business, or maths knowledge (title-based estimate).";
            if (!marker.parentNode) element.prepend(marker);
            changed = true;
          }
          labeledCount++;
        }
        for (const link of thumbnailIndex.get(url) || []) {
          let badge = link.querySelector("[data-valuable-bot-thumbnail]");
          if (badge && (!video || badge.getAttribute("data-video-url") !== url
              || badge.getAttribute("data-video-title") !== video.title
              || badge.getAttribute("data-video-duration") !== (video.duration || ""))) {
            badge.remove(); badge = null; changed = true;
          }
          if (!decision || badge?.getAttribute("data-decision") === decision.label) continue;
          badge ||= document.createElement("span");
          badge.setAttribute("data-valuable-bot-label", "");
          badge.setAttribute("data-valuable-bot-thumbnail", "");
          badge.setAttribute("data-video-url", url);
          badge.setAttribute("data-video-title", video.title);
          badge.setAttribute("data-video-duration", video.duration || "");
          badge.setAttribute("data-decision", decision.label);
          badge.textContent = decision.label.toUpperCase();
          badge.title = "Jev: title-based learning-fit estimate, not a review of video content.";
          badge.style.cssText = `position:absolute;top:8px;left:8px;z-index:10;pointer-events:none;padding:4px 7px;border-radius:4px;color:white;background:${decision.label === "good" ? "#166534" : "#991b1b"};font:700 12px/1.2 sans-serif;`;
          if (getComputedStyle(link).position === "static") link.style.position = "relative";
          if (!badge.parentNode) link.prepend(badge);
          changed = true;
        }
      }
      if (changed) { version++; htmlVersion++; }
      updateVisibility(urls);
      return labeledCount;
    };
    const addDirty = (root) => {
      if (!root || dirty.has(document)) return;
      for (const existing of dirty) {
        if (contains(existing, root)) return;
        if (contains(root, existing)) dirty.delete(existing);
      }
      dirty.add(root);
    };
    reader = {
      document, watchHtml: false, hideBad: false,
      get version() { return version; },
      invalidate(records) {
        let htmlChanged = false;
        for (const record of records) {
          const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          htmlChanged = true;
          if (target?.closest?.("[data-valuable-bot-label]")) continue;
          if (record.type === "attributes" && !["href", "title", "aria-label", "class"].includes(record.attributeName)) continue;
          if (record.type === "attributes" && record.attributeName === "class" && !target?.closest?.(cardSelector)
              && !cardContainers.has(target) && !titles.has(target) && !thumbnails.has(target)) continue;
          // Added markers are ours. Removed markers must be repaired when
          // YouTube rewrites a title, even if the title itself stayed the same.
          const nodes = record.type === "childList" ? [...record.addedNodes, ...record.removedNodes] : [target];
          if (record.type === "childList" && !record.removedNodes.length
              && nodes.every((node) => (node.nodeType === 1 ? node : node.parentElement)?.closest?.("[data-valuable-bot-label]"))) continue;
          const container = target?.closest?.(`${cardSelector}, ytd-watch-metadata, ytd-video-primary-info-renderer`);
          if (container) { addDirty(container); continue; }
          const link = target?.closest?.(linkSelector);
          if (link) { addDirty(link); continue; }
          for (const node of nodes) {
            if (node?.nodeType === 1 && (titles.has(node) || thumbnails.has(node)
                || node.matches?.(relevantSelector) || node.querySelector?.(relevantSelector))) addDirty(node);
          }
        }
        if (htmlChanged) htmlVersion++;
        return dirty.size > 0 || (htmlChanged && reader.watchHtml);
      },
      navigate() { dirty.clear(); dirty.add(document); htmlVersion++; },
      playerChanged() {
        const title = document.querySelector(watchSelector);
        if (title) addDirty(title);
      },
      flush(force = false) {
        const before = version;
        if (force || pageUrl !== location.href) { pageUrl = location.href; dirty.clear(); dirty.add(document); }
        if (dirty.size) {
          const affected = new Set();
          const foundTitles = new Set();
          const foundThumbnails = new Set();
          for (const root of dirty) scan(root, affected, foundTitles, foundThumbnails);
          // One cleanup pass per mutation burst, not one whole-index pass for
          // each newly added card. Ancestor lookup is bounded by DOM depth.
          const inDirtyScope = (node) => {
            if (dirty.has(document)) return true;
            for (let current = node; current; current = current.parentNode) if (dirty.has(current)) return true;
            return false;
          };
          for (const [element, video] of titles) {
            if (inDirtyScope(element) && !foundTitles.has(element)) {
              titles.delete(element); affected.add(video.url);
              element.querySelector("[data-valuable-bot-label]")?.remove();
            }
          }
          for (const [link, url] of thumbnails) {
            if (inDirtyScope(link) && !foundThumbnails.has(link)) {
              thumbnails.delete(link); affected.add(url);
              link.querySelector("[data-valuable-bot-thumbnail]")?.remove();
            }
          }
          dirty.clear();
          index();
          apply(affected);
        }
        return version !== before;
      },
      read({ labels = null, includeHtml = true, includeVideos = true, force = false, watchHtml, hideBad, clearDecisions = false } = {}) {
        if (watchHtml !== undefined) reader.watchHtml = watchHtml;
        const visibilityChanged = hideBad !== undefined && reader.hideBad !== hideBad;
        if (hideBad !== undefined) reader.hideBad = hideBad;
        reader.flush(force);
        if (visibilityChanged) updateVisibility(byUrl.keys());
        if (clearDecisions) { decisions.clear(); version++; updateVisibility(byUrl.keys()); }
        let labeledCount = 0;
        if (labels) {
          const urls = new Set();
          for (const entry of labels) {
            if (!['good', 'bad'].includes(entry.label) || typeof entry.title !== 'string') continue;
            const decisionKey = key(entry);
            const previous = decisions.get(decisionKey);
            if (previous?.label !== entry.label || previous?.confidence !== entry.confidence) version++;
            decisions.set(decisionKey, entry);
            urls.add(entry.url);
          }
          labeledCount = apply(urls);
          pruneDecisions();
        }
        if (includeVideos && snapshotVersion !== version) {
          snapshotDecisions = videos.flatMap((video) => {
            const decision = decisions.get(key(video));
            return decision ? [{ ...decision, ...video }] : [];
          });
          snapshotVersion = version;
        }
        return {
          url: pageUrl, version, htmlVersion, labeledCount, hiddenCount: hidden.size,
          observing: !!globalThis.__valuableBotFeedObserver,
          ...(includeVideos ? { videos, decisions: snapshotDecisions } : {}),
          ...(includeHtml ? { html: document.documentElement.outerHTML } : {}),
        };
      },
    };
    globalThis.__valuableBotPageReader = reader;
  }
  return reader.read(options);
}
