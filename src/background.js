import { classifyWithJev, clearClassifications } from "./typesafe.js";
import { processYouTubePage } from "./youtube-reader.js";

const browser = globalThis.chrome ?? globalThis.browser;
const AUTO_ALARM = "classify-youtube";
const YOUTUBE_ORIGINS = ["https://www.youtube.com/*", "https://youtube.com/*", "https://m.youtube.com/*"];
const tabs = new Map();
const popups = new Map();
const pending = new Set();
const videoKey = (video) => JSON.stringify([video.title, video.duration ?? null]);
let settingsPromise;
let alarmReady = false;
let stopped = false;
let stopping;
let inventory;

function isYouTube(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && ["youtube.com", "www.youtube.com", "m.youtube.com"].includes(parsed.hostname);
  } catch { return false; }
}
function settings() {
  settingsPromise ||= Promise.all([
    browser.storage.session.get(["autoClassify", "autoError"]),
    browser.storage.local.get(["autoClassify", "hideBadVideos"]),
  ]).then(([session, preferences]) => ({
    autoClassify: session.autoClassify ?? preferences.autoClassify ?? true,
    autoError: session.autoError || "",
    hideBadVideos: preferences.hideBadVideos === true,
  }));
  return settingsPromise;
}
async function automaticEnabled() { return !stopped && (await settings()).autoClassify; }
async function status() { return { ...await settings(), version: browser.runtime.getManifest().version }; }
function post(port, message) { try { port.postMessage(message); } catch { /* Popup closed. */ } }
async function broadcastStatus() {
  const state = await status();
  for (const port of popups.keys()) post(port, { type: "STATUS_CHANGED", ...state });
}
function pageChanged(tabId) {
  for (const [port, watch] of popups) {
    if (watch.tabId === tabId) post(port, { type: "PAGE_CHANGED", tabId });
  }
}
function wantsHtml(tabId) { return [...popups.values()].some((watch) => watch.tabId === tabId && watch.includeHtml); }
function tabState(tabId) {
  if (!tabs.has(tabId)) tabs.set(tabId, { id: tabId, results: new Map(), tasks: new Map(), labelGroups: new Map(), again: false });
  return tabs.get(tabId);
}
async function activeYouTubeTab(expectedTabId) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!isYouTube(tab?.url)) throw new Error("Open a YouTube page in the active tab first.");
  if (expectedTabId !== undefined && tab.id !== expectedTabId) throw new Error("The active tab changed. Refresh the YouTube page snapshot first.");
  return tab;
}
async function readTab(state, { includeHtml = false, force = false } = {}) {
  const { hideBadVideos } = await settings();
  const [read] = await browser.scripting.executeScript({
    target: { tabId: state.id }, func: processYouTubePage,
    args: [{ includeHtml, force, hideBad: hideBadVideos, watchHtml: wantsHtml(state.id) }],
  });
  const page = read?.result;
  if (!page || !Array.isArray(page.videos)) throw new Error("Unable to read this page. Reload it and try again.");
  if (!page.observing) {
    await browser.scripting.executeScript({ target: { tabId: state.id }, files: ["src/feed-observer.js"] });
  }
  const previous = state.page;
  // A reload can have the exact same URL/videos but a fresh DOM with no labels.
  // Reuse decisions, not the old document's 'already classified' scan marker.
  if (state.documentId !== read.documentId) state.classifiedSignature = null;
  state.documentId = read.documentId;
  // Large HTML snapshots belong only to the requesting popup, not the worker.
  const { html: _html, ...metadata } = page;
  state.page = metadata;
  state.videoIndex = new Map();
  for (const video of page.videos) {
    const key = videoKey(video);
    if (!state.videoIndex.has(key)) state.videoIndex.set(key, []);
    state.videoIndex.get(key).push(video);
  }
  for (const decision of page.decisions || []) state.results.set(videoKey(decision), decision);
  const visible = new Set(page.videos.map(videoKey));
  for (const key of state.results.keys()) if (!visible.has(key)) state.results.delete(key);
  if (previous && (previous.url !== page.url || previous.version !== page.version || (wantsHtml(state.id) && previous.htmlVersion !== page.htmlVersion))) pageChanged(state.id);
  return { ...page, tabId: state.id };
}
async function readYouTubePage(message) {
  const tab = await activeYouTubeTab();
  const state = tabState(tab.id);
  const page = await readTab(state, { includeHtml: message.includeHtml === true, force: message.force === true });
  if (await automaticEnabled()) classifyPage(state);
  return page;
}

// Micro-batch only label writes, never the paid requests. A burst of 100 results
// needs one indexed DOM update, not 100 full-feed extractions.
function queueLabels(state, labels, expectedUrl) {
  if (!state.labelGroups.has(expectedUrl)) state.labelGroups.set(expectedUrl, { labels: new Map(), waiters: [] });
  const group = state.labelGroups.get(expectedUrl);
  for (const label of labels) group.labels.set(label.url, label);
  const result = new Promise((resolve, reject) => group.waiters.push({ resolve, reject }));
  if (!state.labelTimer) state.labelTimer = setTimeout(() => { void flushLabels(state); }, 0);
  return result;
}
async function flushLabels(state) {
  state.labelTimer = null;
  const groups = state.labelGroups;
  state.labelGroups = new Map();
  for (const [expectedUrl, group] of groups) {
    try {
      const [applied] = await browser.scripting.executeScript({
        target: { tabId: state.id }, func: processYouTubePage,
        args: [{ labels: [...group.labels.values()], expectedUrl, includeHtml: false, includeVideos: false }],
      });
      if (!applied?.result || applied.result.stale) throw new Error("YouTube navigated while classifying. Refresh and try again; successful decisions are cached.");
      if (state.page?.url === expectedUrl && state.page.version !== applied.result.version) pageChanged(state.id);
      for (const waiter of group.waiters) waiter.resolve(applied.result);
    } catch (error) { for (const waiter of group.waiters) waiter.reject(error); }
  }
}
async function classifyYouTubeVideos(message) {
  if (!Number.isInteger(message.tabId) || typeof message.pageUrl !== "string") throw new Error("Refresh the YouTube page snapshot first.");
  await activeYouTubeTab(message.tabId);
  const evaluation = await classifyWithJev(message);
  await activeYouTubeTab(message.tabId);
  const state = tabState(message.tabId);
  for (const result of evaluation.results) state.results.set(videoKey(result), result);
  const labels = evaluation.results.map((result, index) => ({ ...result, url: message.videos[index].url }));
  const applied = await queueLabels(state, labels, message.pageUrl);
  return { ...evaluation, labeledCount: applied.labeledCount };
}
async function stopOnError(error) {
  if (stopped) return stopping;
  stopped = true; // Stop new paid work before the asynchronous storage write.
  stopping = (async () => {
    await browser.storage.session.set({ autoClassify: false, autoError: error.message });
    alarmReady = false;
    await browser.alarms.clear(AUTO_ALARM);
  })();
  return stopping;
}
function classifyPage(state) {
  const page = state.page;
  const signature = JSON.stringify([page.url, page.videos]);
  if (signature === state.classifiedSignature) return;
  state.classifiedSignature = signature;
  const labeled = new Set((page.decisions || []).map((entry) => JSON.stringify([entry.url, videoKey(entry)])));
  const cachedLabels = [];
  for (const video of page.videos) {
    const key = videoKey(video);
    const cached = state.results.get(key);
    if (cached) {
      if (!labeled.has(JSON.stringify([video.url, key]))) cachedLabels.push({ ...cached, ...video });
      continue;
    }
    if (stopped || state.tasks.has(key)) continue;
    const task = (async () => {
      let evaluation;
      try { evaluation = await classifyWithJev({ videos: [video] }); }
      catch (error) { await stopOnError(error); return; }
      const result = evaluation.results[0];
      state.results.set(key, result);
      if (tabs.get(state.id) !== state) return;
      // Navigation/new duplicate cards may have arrived during the call. Label
      // every current match, never the old card position or a different title.
      const labels = (state.videoIndex.get(key) || []).map((entry) => ({ ...result, ...entry }));
      if (labels.length) await queueLabels(state, labels, state.page.url).catch(() => {});
    })().finally(() => { state.tasks.delete(key); pending.delete(task); });
    state.tasks.set(key, task);
    pending.add(task);
  }
  if (cachedLabels.length) void queueLabels(state, cachedLabels, page.url).catch(() => {});
}

// Per-tab scan locks: a changing tab never rescans unrelated tabs, and arrivals
// during a read get one immediate follow-up. No scan waits for network work.
function scanTab(tabId) {
  const state = tabState(tabId);
  if (state.scan) { state.again = true; return state.scan; }
  state.scan = (async () => {
    do {
      state.again = false;
      try {
        await readTab(state);
        if (await automaticEnabled()) classifyPage(state);
      } catch { /* Closed, discarded, inaccessible, or navigating tab. */ }
    } while (state.again && tabs.get(tabId) === state);
  })().finally(() => { state.scan = null; });
  return state.scan;
}
async function runAutomatic() {
  if (inventory) return inventory;
  inventory = (async () => {
    if (!await automaticEnabled()) return;
    if (!alarmReady) {
      await browser.alarms.create(AUTO_ALARM, { periodInMinutes: 0.5 });
      alarmReady = true;
    }
    const openTabs = await browser.tabs.query({ url: YOUTUBE_ORIGINS });
    await Promise.all(openTabs.filter((tab) => !tab.discarded).map((tab) => scanTab(tab.id)));
  })().catch(stopOnError).finally(() => { inventory = null; });
  return inventory;
}
async function setAutomatic(message) {
  if (message.enabled) {
    if (!await browser.permissions.contains({ origins: [...YOUTUBE_ORIGINS, "https://api.typesafe.ai/*"] })) {
      throw new Error("Allow YouTube and TypeSafe access for background classification.");
    }
    if (message.apiKey?.trim()) {
      const key = message.apiKey.trim();
      if (key.length > 512 || /\s/.test(key)) throw new Error("Invalid API key format.");
      await browser.storage.session.set({ typesafeApiKey: key });
    }
    if (stopping) await stopping;
    stopped = false;
    stopping = null;
    await browser.storage.local.set({ autoClassify: true });
    await browser.storage.session.set({ autoClassify: true, autoError: "" });
    settingsPromise = null;
    for (const state of tabs.values()) state.classifiedSignature = null;
    void runAutomatic();
  } else {
    stopped = true;
    await browser.storage.local.set({ autoClassify: false });
    await browser.storage.session.set({ autoClassify: false });
    settingsPromise = null;
    alarmReady = false;
    await browser.alarms.clear(AUTO_ALARM);
  }
  return { ok: true };
}
async function setHideBad(message) {
  const enabled = message.enabled === true;
  await browser.storage.local.set({ hideBadVideos: enabled });
  settingsPromise = null;
  const openTabs = await browser.tabs.query({ url: YOUTUBE_ORIGINS });
  await Promise.all(openTabs.filter((tab) => !tab.discarded).map(async (tab) => {
    try {
      await browser.scripting.executeScript({ target: { tabId: tab.id }, func: processYouTubePage,
        args: [{ hideBad: enabled, includeHtml: false, includeVideos: false }] });
      pageChanged(tab.id);
    } catch { /* Tab closed or navigated. */ }
  }));
  return { ok: true };
}
async function updateHtmlWatch(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    await browser.scripting.executeScript({ target: { tabId }, func: processYouTubePage,
      args: [{ watchHtml: wantsHtml(tabId), includeHtml: false, includeVideos: false }] });
  } catch { /* Tab closed. */ }
}

browser.runtime.onInstalled.addListener(() => { void runAutomatic(); });
browser.runtime.onStartup.addListener(() => { void runAutomatic(); });
browser.alarms.onAlarm.addListener((alarm) => { if (alarm.name === AUTO_ALARM) return runAutomatic(); });
browser.storage.onChanged.addListener((changes) => {
  if (changes.autoClassify || changes.autoError || changes.hideBadVideos) { settingsPromise = null; void broadcastStatus(); }
});
browser.tabs.onUpdated.addListener((id, change, tab) => {
  if ((change.status === "complete" || change.url) && isYouTube(change.url || tab.url)) {
    void automaticEnabled().then((enabled) => { if (enabled || [...popups.values()].some((watch) => watch.tabId === id)) void scanTab(id); });
  }
});
browser.tabs.onRemoved.addListener((id) => { tabs.delete(id); pageChanged(id); });
const activeTabChanged = () => { for (const port of popups.keys()) post(port, { type: "ACTIVE_TAB_CHANGED" }); };
browser.tabs.onActivated.addListener(activeTabChanged);
browser.windows.onFocusChanged.addListener(activeTabChanged);
browser.runtime.onConnect.addListener((port) => {
  if (port.name !== "youtube-popup" || port.sender?.id !== browser.runtime.id || port.sender.tab) return;
  popups.set(port, { tabId: null, includeHtml: false });
  void status().then((state) => post(port, { type: "STATUS_CHANGED", ...state }));
  port.onMessage.addListener((message) => {
    if (message?.type !== "WATCH_PAGE" || !Number.isInteger(message.tabId)) return;
    const previous = popups.get(port)?.tabId;
    popups.set(port, { tabId: message.tabId, includeHtml: message.includeHtml === true });
    if (previous !== message.tabId) void updateHtmlWatch(previous);
    void updateHtmlWatch(message.tabId);
  });
  port.onDisconnect.addListener(() => {
    const previous = popups.get(port)?.tabId;
    popups.delete(port);
    void updateHtmlWatch(previous);
  });
});

// sendResponse + true is required for asynchronous messaging on Chrome 120.
browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const response = handleMessage(message, sender);
  if (response === undefined) return;
  Promise.resolve(response).then(sendResponse, (error) => sendResponse({ error: error.message }));
  return true;
});
function handleMessage(message, sender) {
  if (sender.id !== browser.runtime.id) return;
  if (sender.tab) {
    // Content scripts can signal changes, not supply keys or API inputs.
    if (message?.type !== "YOUTUBE_FEED_CHANGED" || sender.frameId !== 0 || !isYouTube(sender.url)) return;
    return automaticEnabled().then((enabled) => {
      if (enabled || [...popups.values()].some((watch) => watch.tabId === sender.tab.id)) return scanTab(sender.tab.id).then(() => ({ ok: true }));
      return { ok: true, idle: true };
    });
  }
  if (message?.type === "GET_STATUS") return status();
  if (message?.type === "CLASSIFY_VIDEOS") return classifyYouTubeVideos(message).then((evaluation) => ({ evaluation }));
  if (message?.type === "SET_AUTOMATIC") return setAutomatic(message);
  if (message?.type === "SET_HIDE_BAD") return setHideBad(message);
  if (message?.type === "FORGET_TYPESAFE_KEY") {
    return setAutomatic({ enabled: false }).then(async () => {
      await Promise.allSettled([...pending]);
      await clearClassifications();
      await Promise.all([...tabs.values()].map(async (state) => {
        state.results.clear();
        state.classifiedSignature = null;
        try {
          await browser.scripting.executeScript({ target: { tabId: state.id }, func: processYouTubePage,
            args: [{ clearDecisions: true, includeHtml: false, includeVideos: false }] });
        } catch { /* Tab closed. */ }
      }));
      return { ok: true };
    });
  }
  if (message?.type === "READ_YOUTUBE_PAGE") return readYouTubePage(message).then((page) => ({ page }));
}
