import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { processYouTubePage } from "../src/youtube-reader.js";
import { classifyWithJev, resolveTypeSafeApiKey, clearClassifications } from "../src/typesafe.js";
import { Document, Element, Event, card, inDocument, pause, until } from "./fixtures.mjs";

assert.equal(resolveTypeSafeApiKey("", undefined, " code-test-key "), "code-test-key");
assert.equal(resolveTypeSafeApiKey("", "session-test-key", "code-test-key"), "session-test-key");
assert.equal(resolveTypeSafeApiKey("popup-test-key", "session-test-key", "code-test-key"), "popup-test-key");
assert.throws(() => resolveTypeSafeApiKey("", undefined, ""), /typesafe-config\.local\.js/);
assert.throws(() => resolveTypeSafeApiKey("", undefined, "invalid key"), /Invalid API key/);
const read = (doc, options = {}) => inDocument(doc, () => processYouTubePage({ includeHtml: false, ...options }));
const mutation = (target, type = "characterData", extra = {}) => ({ target, type, addedNodes: [], removedNodes: [], ...extra });
const invalidate = (doc, records) => inDocument(doc, () => doc.reader.invalidate(records));
const labeled = (entry) => /^\[(GOOD|BAD)\]/.test(entry.title.textContent);

// All layouts, URL/duration normalization, duplicate/nested cards, and thumbnails.
const doc = new Document("https://www.youtube.com/watch?v=current");
const metadata = new Element("ytd-watch-metadata");
const h1 = new Element("h1");
const watchTitle = new Element("yt-formatted-string", " Current video ");
h1.append(watchTitle); metadata.append(h1);
const player = new Element("video"); player.setAttribute("class", "html5-main-video"); player.duration = 3661.9;
const fixtures = [card(" First   video ", "abc"), card("First video", "abc", null),
  card("Short", "short", "0:30", "short"), card("Deep systems programming", "modern", "24:15", "modern"),
  card("New layout video", "unknown", null, "unknown")];
const wrapper = new Element("ytd-rich-item-renderer"); wrapper.append(fixtures[0].root);
doc.body.append(metadata, player, wrapper, ...fixtures.slice(1).map((entry) => entry.root));
let page = read(doc, { includeHtml: true });
assert.deepEqual(page.videos.map((video) => [video.title, video.duration]), [
  ["Current video", "1:01:01"], ["First video", "12:34"], ["Short", "0:30"],
  ["Deep systems programming", "24:15"], ["New layout video", null],
]);
assert.equal(page.videos[1].url, "https://www.youtube.com/watch?v=abc");
assert.equal(doc.htmlReads, 1);
const labels = page.videos.map((video) => ({ ...video, label: "good", confidence: 0.9 }));
doc.queries = [];
read(doc, { labels, includeVideos: false });
read(doc, { labels, includeVideos: false });
assert.equal(doc.queries.filter((query) => query.root === doc).length, 0, "Results must not rescan the document");
assert.ok(fixtures.every(labeled));
assert.equal(fixtures[0].title.querySelectorAll("[data-valuable-bot-label]").length, 1);
assert.equal(fixtures[0].thumbnail.querySelectorAll("[data-valuable-bot-thumbnail]").length, 1);
assert.equal(fixtures[0].thumbnail.children[0].textContent, "GOOD");
assert.match(fixtures[0].thumbnail.children[0].style.cssText, /pointer-events:none/);
assert.equal(fixtures[0].thumbnail.style.position, "relative");
assert.equal(read(doc).videos[1].title, "First video", "Never submit our own title prefix");
assert.equal(read(doc, { expectedUrl: "https://www.youtube.com/elsewhere", labels }).stale, true);
const beforeUnchanged = doc.queries.length;
for (let i = 0; i < 100; i++) read(doc);
assert.equal(doc.queries.length, beforeUnchanged, "Unchanged reads perform zero DOM queries");
assert.equal(doc.htmlReads, 1, "HTML is not serialized unless requested");

// Optional filtering is reversible, indexed, and never hides the playing video.
const badLabels = labels.filter((entry) => ["Short", "New layout video", "Current video"].includes(entry.title)).map((entry) => ({ ...entry, label: "bad" }));
read(doc, { labels: badLabels });
assert.equal(fixtures[2].root.getAttribute("data-valuable-bot-hidden"), null, "Marking remains the default");
const hidePage = read(doc, { hideBad: true });
assert.equal(hidePage.hiddenCount, 2);
assert.equal(hidePage.videos.length, page.videos.length, "Hidden videos remain in the classified index");
assert.equal(fixtures[2].root.getAttribute("data-valuable-bot-hidden"), "");
assert.equal(fixtures[4].root.getAttribute("data-valuable-bot-hidden"), "", "Unknown single-video containers can be filtered too");
assert.equal(metadata.getAttribute("data-valuable-bot-hidden"), null, "The watch-page title/player stay visible");
assert.equal(fixtures[0].root.getAttribute("data-valuable-bot-hidden"), null, "GOOD cards stay visible");
assert.equal(doc.body.getAttribute("data-valuable-bot-hidden"), null);
assert.equal(read(doc, { hideBad: false }).hiddenCount, 0);
assert.equal(fixtures[2].root.getAttribute("data-valuable-bot-hidden"), null);
assert.equal(fixtures[4].root.getAttribute("data-valuable-bot-hidden"), null);
read(doc, { labels });

// Incremental recycling, duration changes, removed nodes, and same-input new cards.
fixtures[0].title.textContent = "Recycled title";
fixtures[0].title.href = "/watch?v=recycled";
fixtures[0].thumbnail.href = "/watch?v=recycled";
invalidate(doc, [mutation(fixtures[0].title, "attributes", { attributeName: "href" })]);
doc.queries = [];
page = read(doc);
assert.ok(page.videos.some((video) => video.title === "Recycled title"));
assert.equal(fixtures[0].thumbnail.querySelector("[data-valuable-bot-thumbnail]"), null);
assert.equal(doc.queries.filter((query) => query.root === doc).length, 0, "Only the recycled card is extracted");
const current = page.videos.find((video) => video.title === "Recycled title");
read(doc, { labels: [{ ...current, label: "bad", confidence: 0.8 }] });
fixtures[0].time.textContent = "13:00";
invalidate(doc, [mutation(fixtures[0].time, "characterData")]);
page = read(doc);
assert.equal(page.videos.find((video) => video.url === current.url).duration, "13:00");
assert.equal(fixtures[0].title.querySelector("[data-valuable-bot-label]"), null, "Duration changes invalidate decisions too");
const duplicate = card("Short", "new-short", "0:30", "short");
doc.body.append(duplicate.root);
invalidate(doc, [mutation(doc.body, "childList", { addedNodes: [duplicate.root] })]);
read(doc);
assert.ok(labeled(duplicate), "Same-input cards reuse in-page decisions instantly");
fixtures[3].root.remove();
invalidate(doc, [mutation(doc.body, "childList", { removedNodes: [fixtures[3].root] })]);
assert.ok(!read(doc).videos.some((video) => video.title === "Deep systems programming"));
player.duration = 120;
inDocument(doc, () => doc.reader.playerChanged());
assert.equal(read(doc).videos[0].duration, "2:00", "Loaded metadata updates the watch-page duration");
read(doc, { clearDecisions: true });
assert.ok(labeled(duplicate), "Forgetting cached decisions leaves existing page labels intact");
assert.equal(read(doc).decisions.length, 0);
assert.ok(labeled(duplicate));

// The observer filters noise, repairs removed markers, and does not poll.
{
  const source = await readFile(new URL("../src/feed-observer.js", import.meta.url), "utf8");
  const home = new Document();
  const entry = card("Observer video", "observer"); home.body.append(entry.root);
  const video = read(home).videos[0];
  read(home, { labels: [{ ...video, label: "good", confidence: 0.9 }] });
  let onMutation;
  let observers = 0;
  let notifications = 0;
  let scheduled;
  const context = vm.createContext({
    document: home, __valuableBotPageReader: home.reader,
    MutationObserver: class { constructor(fn) { onMutation = fn; observers++; } observe(options, config) { assert.equal(options, home); assert.equal(config.attributes, true); } },
    setTimeout(fn, delay) { assert.equal(delay, 0); assert.equal(scheduled, undefined); scheduled = fn; return 1; },
    setInterval() { assert.fail("Unchanged pages must not be polled"); },
    browser: { runtime: { sendMessage: async (message) => { assert.equal(message.type, "YOUTUBE_FEED_CHANGED"); notifications++; } } },
  });
  vm.runInContext(source, context); vm.runInContext(source, context);
  assert.equal(observers, 1); assert.equal(notifications, 1);
  const runTick = () => { const tick = scheduled; scheduled = undefined; inDocument(home, tick); };
  const clock = new Element("span", "00:01"); home.body.append(clock);
  inDocument(home, () => onMutation([mutation(clock, "characterData")]));
  assert.equal(scheduled, undefined, "Unrelated DOM activity does not wake the background");
  inDocument(home, () => onMutation([mutation(home.body, "attributes", { attributeName: "class" })]));
  assert.equal(scheduled, undefined, "Body/theme class changes must not rescan the whole feed");
  const marker = entry.title.querySelector("[data-valuable-bot-label]");
  inDocument(home, () => onMutation([mutation(entry.title, "childList", { addedNodes: [marker] }), mutation(marker, "attributes", { attributeName: "title" })]));
  assert.equal(scheduled, undefined, "Own labels do not cause feedback loops");
  for (let i = 0; i < 10; i++) inDocument(home, () => onMutation([mutation(entry.title, "attributes", { attributeName: "title" })]));
  runTick();
  assert.equal(notifications, 1, "Relevant but unchanged inputs do not notify either");
  marker.remove();
  inDocument(home, () => onMutation([mutation(entry.title, "childList", { removedNodes: [marker] })]));
  runTick(); assert.ok(labeled(entry)); assert.equal(notifications, 2);
  read(home, { watchHtml: true });
  inDocument(home, () => onMutation([mutation(clock, "attributes", { attributeName: "style" })]));
  runTick(); assert.equal(notifications, 3, "Expanded HTML receives even non-video attribute changes");
  read(home, { watchHtml: false });
  inDocument(home, () => onMutation([mutation(clock, "attributes", { attributeName: "style" })]));
  assert.equal(scheduled, undefined);
  inDocument(home, () => home.events.get("yt-navigate-finish")[0]());
  runTick(); assert.equal(notifications, 4);
  const arrival = card("Interleaved arrival", "interleaved"); home.body.append(arrival.root);
  inDocument(home, () => onMutation([mutation(home.body, "childList", { addedNodes: [arrival.root] })]));
  // A label write flushes pending DOM work before the notification timer runs.
  read(home, { labels: [{ ...video, label: "good", confidence: 0.9 }], includeVideos: false });
  runTick(); assert.equal(notifications, 5, "Interleaved label writes cannot swallow new-card notifications");
}

// Chrome mocks, with real change events and document-isolated persistent state.
const saved = { typesafeApiKey: "test-secret" };
const preferences = { autoClassify: false };
const stats = { gets: 0, writes: 0, injections: [], queries: 0, requests: [] };
const storageChanged = new Event();
function storageArea(values, area) {
  return {
    async get(keys) {
      stats.gets++;
      const names = keys == null ? Object.keys(values) : typeof keys === "string" ? [keys] : keys;
      return structuredClone(Object.fromEntries(names.filter((name) => name in values).map((name) => [name, values[name]])));
    },
    async set(items) {
      stats.writes++;
      const changes = {};
      for (const [name, value] of Object.entries(items)) { changes[name] = { oldValue: values[name], newValue: structuredClone(value) }; values[name] = structuredClone(value); }
      storageChanged.emit(changes, area);
    },
    async remove(keys) {
      const changes = {};
      for (const name of keys) if (name in values) { changes[name] = { oldValue: values[name] }; delete values[name]; }
      storageChanged.emit(changes, area);
    },
  };
}
let activeTabId = 1;
let permission = true;
let statusCode = 200;
let networkError;
let malformed = false;
const deferred = new Map();
const openTabs = new Map([[1, { doc: new Document(), discarded: false }]]);
const chrome = {
  runtime: { id: "test-extension", getManifest: () => ({ version: "0.1.0" }),
    onInstalled: new Event(), onStartup: new Event(), onMessage: new Event(), onConnect: new Event() },
  storage: { session: storageArea(saved, "session"), local: storageArea(preferences, "local"), onChanged: storageChanged },
  permissions: { contains: async () => permission, onAdded: new Event(), onRemoved: new Event() },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: new Event() },
  windows: { onFocusChanged: new Event() },
  tabs: {
    async query(query) {
      stats.queries++;
      return [...openTabs].filter(([id, tab]) => query.url ? /youtube\.com\//.test(tab.doc.url) : id === activeTabId)
        .map(([id, tab]) => ({ id, url: tab.doc.url, discarded: tab.discarded }));
    },
    onUpdated: new Event(), onRemoved: new Event(), onActivated: new Event(),
  },
  scripting: { async executeScript({ target, func, args = [], files }) {
    const tab = openTabs.get(target.tabId);
    if (!tab || tab.discarded) throw new Error("Tab unavailable");
    stats.injections.push({ tabId: target.tabId, files, options: args[0] });
    if (files) { assert.deepEqual(files, ["src/feed-observer.js"]); tab.doc.observing = true; return []; }
    assert.equal(func, processYouTubePage);
    return [{ result: structuredClone(inDocument(tab.doc, () => func(...args))), documentId: `document-${target.tabId}` }];
  } },
};
globalThis.chrome = chrome;
function mockResponse(body) {
  return { ok: statusCode === 200, status: statusCode, json: async () => ({ model: "jev-test", answers: {
    video_0: { type: "choice", choice: malformed ? "other" : body.state.videos[0].title.includes("Entertainment") ? "bad" : "good", confidence: 0.9 },
  } }) };
}
globalThis.fetch = async (url, options) => {
  assert.equal(url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(options.headers.Authorization, "Bearer test-secret");
  assert.equal(options.credentials, "omit"); assert.equal(options.redirect, "error");
  const body = JSON.parse(options.body); stats.requests.push(body);
  if (networkError) throw networkError;
  if (deferred.has(body.state.videos[0].title)) return new Promise((resolve) => deferred.set(body.state.videos[0].title, () => resolve(mockResponse(body))));
  return mockResponse(body);
};
const setPermission = (value) => { permission = value; (value ? chrome.permissions.onAdded : chrome.permissions.onRemoved).emit({ origins: ["https://api.typesafe.ai/*"] }); };
const input = { apiKey: "test-secret", videos: [{ title: "Deep coding", duration: "10:00", url: "https://www.youtube.com/watch?v=code", html: "private" }, { title: "Entertainment", duration: null }] };
let evaluation = await classifyWithJev(input);
assert.deepEqual(evaluation.results.map((result) => result.label), ["good", "bad"]);
assert.equal(evaluation.evaluatedCount, 2);
assert.equal(stats.requests.length, 2);
assert.equal(stats.gets, 1, "The session cache is hydrated only once");
assert.equal(stats.writes, 1, "Simultaneous results share one durable write");
assert.equal(saved.typesafeApiKey, "test-secret");
for (const body of stats.requests) {
  assert.equal(body.model, "jev-latest"); assert.match(body.state.viewer, /21-year-old/);
  for (const subject of [/coding/, /business/, /mathematics/]) assert.match(body.questions.video_0.criteria.good, subject);
  assert.equal(body.state.videos[0].url, undefined); assert.equal(body.state.videos[0].html, undefined);
}
const cachedRequests = stats.requests.length;
const cachedGets = stats.gets;
const cachedWrites = stats.writes;
for (let i = 0; i < 50; i++) await classifyWithJev({ ...input, apiKey: "" });
assert.equal(stats.requests.length, cachedRequests);
assert.equal(stats.gets, cachedGets, "Cached decisions require no storage reads");
assert.equal(stats.writes, cachedWrites, "Cached decisions require no storage writes");
await assert.rejects(classifyWithJev({ ...input, videos: Array(51).fill(input.videos[0]) }), /1 and 50/);
await assert.rejects(classifyWithJev({ ...input, videos: [input.videos[0], { title: "" }] }), /Invalid video title/);
await assert.rejects(classifyWithJev({ ...input, videos: [{ title: "Invalid", duration: 10 }] }), /Invalid video duration/);
await clearClassifications();
setPermission(false);
await assert.rejects(classifyWithJev(input), /host permission is missing/);
setPermission(true);
for (const [code, pattern] of [[403, /rejected the API key/], [429, /rate-limited/], [500, /HTTP 500/]]) {
  statusCode = code;
  const before = stats.requests.length;
  await assert.rejects(classifyWithJev(input), pattern);
  assert.equal(stats.requests.length, before + 2, "Failed paid requests have no automatic retry");
}
statusCode = 200; malformed = true;
await assert.rejects(classifyWithJev(input), /Invalid TypeSafe classification/);
malformed = false;
networkError = { name: "TimeoutError" }; await assert.rejects(classifyWithJev(input), /60 seconds/);
networkError = { name: "TypeError" }; await assert.rejects(classifyWithJev(input), /Cannot connect/);
networkError = null;

// Actual key resolution deduplicates manual/automatic calls, even while slow.
await chrome.storage.session.set({ typesafeApiKey: "test-secret" });
deferred.set("Slow concurrent", null);
const slow = classifyWithJev({ apiKey: "test-secret", videos: [{ title: "Slow concurrent" }] });
const duplicateSlow = classifyWithJev({ apiKey: "", videos: [{ title: "Slow concurrent" }] });
const fast = classifyWithJev({ apiKey: "test-secret", videos: [{ title: "Fast concurrent" }] });
await fast;
assert.equal(typeof deferred.get("Slow concurrent"), "function");
assert.equal(stats.requests.filter((body) => body.state.videos[0].title === "Slow concurrent").length, 1);
deferred.get("Slow concurrent")(); await slow; await duplicateSlow; deferred.delete("Slow concurrent");
assert.equal(saved.typesafeClassifications.length, 2, "Concurrent cache commits retain both decisions");
await clearClassifications();

// Real module loading and Chrome's asynchronous response-channel contract.
await import("../src/background.js");
function send(message, sender = { id: chrome.runtime.id }) {
  let respond;
  const result = new Promise((resolve) => { respond = resolve; });
  const [keepAlive] = chrome.runtime.onMessage.emit(message, sender, respond);
  if (keepAlive === undefined) return;
  assert.equal(keepAlive, true, "Chrome 120 messages must keep the response channel open");
  return result;
}
const main = openTabs.get(1).doc;
const mainCards = [card("Main coding", "main"), card("Main Entertainment", "bad")]; main.body.append(...mainCards.map((entry) => entry.root));
const snapshot = (await send({ type: "READ_YOUTUBE_PAGE" })).page;
assert.equal(snapshot.tabId, 1); assert.equal(snapshot.videos.length, 2);
for (const url of ["https://example.com/", "https://youtube.com.evil.test/", "http://www.youtube.com/"]) {
  main.url = url;
  assert.match((await send({ type: "READ_YOUTUBE_PAGE" })).error, /Open a YouTube page/);
}
main.url = snapshot.url;
assert.equal(send({ type: "CLASSIFY_VIDEOS" }, { id: chrome.runtime.id, tab: { id: 1 } }), undefined);
assert.equal(send({ type: "READ_YOUTUBE_PAGE" }, { id: "other-extension" }), undefined);
const manual = { type: "CLASSIFY_VIDEOS", ...input, tabId: 1, pageUrl: main.url, videos: snapshot.videos };
evaluation = (await send(manual)).evaluation;
assert.equal(evaluation.results[0].label, "good"); assert.equal(evaluation.results[1].label, "bad");
assert.ok(mainCards.every(labeled));
const beforeManualCache = stats.requests.length;
await send({ ...manual, apiKey: "" }); assert.equal(stats.requests.length, beforeManualCache);
openTabs.set(2, { doc: new Document("https://example.com/"), discarded: false });
activeTabId = 2;
assert.match((await send(manual)).error, /Open a YouTube page/);
openTabs.get(2).doc.url = "https://www.youtube.com/";
assert.match((await send(manual)).error, /active tab changed/);
activeTabId = 1;
await send({ type: "FORGET_TYPESAFE_KEY" });
assert.equal(saved.typesafeApiKey, undefined); assert.equal(saved.typesafeClassifications, undefined);
assert.ok(mainCards.every(labeled), "Forgetting does not strip page labels");
assert.equal(read(main).decisions.length, 0, "Forgetting clears the in-page decision cache too");

// Background: >50 videos, all tabs, stable feeds, targeted changes and fallbacks.
const background = new Document();
const backgroundCards = Array.from({ length: 55 }, (_, index) => card(`Background ${index}`, `bg${index}`, "2:00", index % 3 === 0 ? "modern" : "classic"));
background.body.append(...backgroundCards.map((entry) => entry.root));
openTabs.set(1, { doc: background, discarded: false });
const other = new Document(); const shared = card("Background 0", "shared", "2:00"); other.body.append(shared.root);
openTabs.set(2, { doc: other, discarded: false });
const discarded = new Document(); discarded.body.append(card("Discarded", "discarded").root);
openTabs.set(3, { doc: discarded, discarded: true });
await chrome.storage.local.remove(["autoClassify"]);
await chrome.storage.session.remove(["autoClassify"]);
await chrome.storage.session.set({ typesafeApiKey: "test-secret" });
assert.equal((await send({ type: "GET_STATUS" })).autoClassify, true);
// Explicitly enabling also resumes the current worker after an earlier opt-out.
const beforeAutomatic = stats.requests.length;
const writesBeforeAutomatic = stats.writes;
await send({ type: "SET_AUTOMATIC", enabled: true });
await until(() => backgroundCards.every(labeled) && labeled(shared));
assert.equal(stats.requests.length, beforeAutomatic + 55, "All tabs share title/duration paid work");
assert.ok(stats.writes - writesBeforeAutomatic <= 3, "55 parallel results do not write 55 cache snapshots");
const labelsInjected = stats.injections.filter((item) => item.options?.labels && item.options.labels.some((entry) => entry.title.startsWith("Background")));
assert.equal(labelsInjected.length, 2, "A simultaneous result burst is one indexed label update per tab");
assert.equal(labelsInjected[0].options.includeVideos, false);
const queriesAfterLabeling = background.queries.length;
const requestsAfterLabeling = stats.requests.length;
const getsAfterLabeling = stats.gets;
for (let i = 0; i < 5; i++) await Promise.all(chrome.alarms.onAlarm.emit({ name: "classify-youtube" }));
assert.equal(stats.requests.length, requestsAfterLabeling);
assert.equal(stats.gets, getsAfterLabeling, "Fallbacks do not keep reloading keys/settings/cache");
assert.equal(background.queries.length, queriesAfterLabeling, "Fallbacks read indexed snapshots, not the DOM");
assert.equal(stats.injections.filter((item) => item.files && item.tabId === 1).length, 2, "One observer install for each of this tab's documents");
const later = card("Loaded later", "later", "3:00"); backgroundCards.push(later); background.body.append(later.root);
invalidate(background, [mutation(background.body, "childList", { addedNodes: [later.root] })]);
const feedSender = { id: chrome.runtime.id, tab: { id: 1 }, frameId: 0, url: background.url };
const injectionsBeforeChange = stats.injections.length;
assert.equal(send({ type: "YOUTUBE_FEED_CHANGED" }, { ...feedSender, url: "https://youtube.com.evil.test/" }), undefined);
assert.equal(send({ type: "YOUTUBE_FEED_CHANGED" }, { ...feedSender, frameId: 1 }), undefined);
await Promise.all([send({ type: "YOUTUBE_FEED_CHANGED" }, feedSender), send({ type: "YOUTUBE_FEED_CHANGED" }, feedSender)]);
await until(() => labeled(later));
assert.equal(stats.requests.length, requestsAfterLabeling + 1);
assert.ok(stats.injections.slice(injectionsBeforeChange).every((item) => item.tabId === 1), "A tab change never rescans unrelated tabs");

// A slow result cannot delay later arrivals, and recycled cards cannot be mislabeled.
const slowCard = card("Slow background", "slow", "4:00"); background.body.append(slowCard.root);
deferred.set("Slow background", null);
invalidate(background, [mutation(background.body, "childList", { addedNodes: [slowCard.root] })]);
await send({ type: "YOUTUBE_FEED_CHANGED" }, feedSender);
await until(() => typeof deferred.get("Slow background") === "function");
const arrival = card("Immediate arrival", "arrival", "4:00"); background.body.append(arrival.root);
invalidate(background, [mutation(background.body, "childList", { addedNodes: [arrival.root] })]);
await send({ type: "YOUTUBE_FEED_CHANGED" }, feedSender);
await until(() => labeled(arrival));
assert.ok(!labeled(slowCard), "New arrivals do not wait for an older slow call");
slowCard.title.textContent = "Recycled Entertainment";
invalidate(background, [mutation(slowCard.title)]);
await send({ type: "YOUTUBE_FEED_CHANGED" }, feedSender);
await until(() => /^\[BAD\]/.test(slowCard.title.textContent));
deferred.get("Slow background")(); deferred.delete("Slow background"); await pause(20);
assert.match(slowCard.title.textContent, /^\[BAD\]/, "Late old decisions cannot overwrite a recycled title");

// Hide/show preferences apply to every tab without classification or refresh.
const requestsBeforeHide = stats.requests.length;
await send({ type: "SET_HIDE_BAD", enabled: true });
assert.equal(preferences.hideBadVideos, true);
assert.equal((await send({ type: "GET_STATUS" })).hideBadVideos, true);
assert.equal(slowCard.root.getAttribute("data-valuable-bot-hidden"), "");
assert.equal(shared.root.getAttribute("data-valuable-bot-hidden"), null);
assert.equal(stats.requests.length, requestsBeforeHide);
const newBad = card("Fresh Entertainment", "fresh-bad"); background.body.append(newBad.root);
invalidate(background, [mutation(background.body, "childList", { addedNodes: [newBad.root] })]);
await send({ type: "YOUTUBE_FEED_CHANGED" }, feedSender);
await until(() => newBad.root.getAttribute("data-valuable-bot-hidden") === "");
await send({ type: "SET_HIDE_BAD", enabled: false });
assert.equal(newBad.root.getAttribute("data-valuable-bot-hidden"), null);
assert.equal(slowCard.root.getAttribute("data-valuable-bot-hidden"), null);
assert.match(newBad.title.textContent, /^\[BAD\]/, "Restoring cards keeps their labels");
await send({ type: "SET_HIDE_BAD", enabled: true });

// Popup subscriptions see automatic results and stop HTML work on disconnect.
const messages = [];
const popupPort = { name: "youtube-popup", sender: { id: chrome.runtime.id }, onMessage: new Event(), onDisconnect: new Event(), postMessage: (message) => messages.push(message) };
chrome.runtime.onConnect.emit(popupPort);
popupPort.onMessage.emit({ type: "WATCH_PAGE", tabId: 1, includeHtml: true });
await pause(); assert.equal(background.reader.watchHtml, true);
const htmlReads = background.htmlReads;
await send({ type: "YOUTUBE_FEED_CHANGED" }, feedSender);
assert.equal(background.htmlReads, htmlReads, "Change signals never serialize HTML in addition to the popup read");
await send({ type: "READ_YOUTUBE_PAGE", includeHtml: true });
assert.ok(background.htmlReads > htmlReads);
popupPort.onDisconnect.emit(); await pause(); assert.equal(background.reader.watchHtml, false);
const late = card("Popup confidence", "confidence"); background.body.append(late.root);
invalidate(background, [mutation(background.body, "childList", { addedNodes: [late.root] })]);
await send({ type: "YOUTUBE_FEED_CHANGED" }, feedSender); await until(() => labeled(late));
assert.ok((await send({ type: "READ_YOUTUBE_PAGE" })).page.decisions.some((entry) => entry.title === "Popup confidence" && entry.confidence === 0.9));

// Errors disable paid work once; opt-out survives a session reset/restart.
statusCode = 429;
const failed = card("API failure", "failed"); background.body.append(failed.root);
invalidate(background, [mutation(background.body, "childList", { addedNodes: [failed.root] })]);
await send({ type: "YOUTUBE_FEED_CHANGED" }, feedSender);
await until(() => saved.autoClassify === false);
assert.match(saved.autoError, /rate-limited/);
const failedCalls = stats.requests.length;
await Promise.all(chrome.alarms.onAlarm.emit({ name: "classify-youtube" }));
await send({ type: "YOUTUBE_FEED_CHANGED" }, feedSender);
assert.equal(stats.requests.length, failedCalls, "Stopped automatic work never retries failed paid calls");
statusCode = 200;
await send({ type: "SET_AUTOMATIC", enabled: false });
await chrome.storage.session.remove(Object.keys(saved));
assert.equal((await send({ type: "GET_STATUS" })).autoClassify, false);
assert.equal((await send({ type: "GET_STATUS" })).hideBadVideos, true, "Filtering preference survives session reset");
chrome.runtime.onStartup.emit(); await pause(); assert.equal(stats.requests.length, failedCalls);

// Popup: single activation toggle, permission failures, status updates, and cleanup.
{
  const source = await readFile(new URL("../src/popup/popup.js", import.meta.url), "utf8");
  const button = { events: {}, addEventListener(name, fn) { this.events[name] = fn; } };
  const hideBad = { checked: false, events: {}, addEventListener(name, fn) { this.events[name] = fn; } };
  let onHide;
  let popupAuto = false;
  let popupHide = false;
  let hideError = false;
  let allowed = true;
  let disconnected = false;
  const outgoing = [];
  const clientPort = { onMessage: new Event(), disconnect() { disconnected = true; } };
  vm.runInNewContext(source, {
    document: { querySelector: (id) => { assert.ok(["#toggle", "#hide-bad"].includes(id)); return id === "#toggle" ? button : hideBad; } },
    browser: { permissions: { request: async () => allowed }, runtime: {
      connect: () => clientPort,
      sendMessage(message) {
        outgoing.push(message);
        if (message.type === "GET_STATUS") return Promise.resolve({ autoClassify: popupAuto, hideBadVideos: popupHide });
        if (message.type === "SET_AUTOMATIC") { popupAuto = message.enabled; return Promise.resolve({ ok: true }); }
        if (message.type === "SET_HIDE_BAD") {
          if (hideError) return Promise.resolve({ error: "Visibility failed" });
          popupHide = message.enabled; return Promise.resolve({ ok: true });
        }
        assert.fail(`Unexpected popup message: ${message.type}`);
      },
    } },
    setInterval() { assert.fail("The popup must not poll"); },

    window: { addEventListener(name, fn) { assert.equal(name, "pagehide"); onHide = fn; } },
  });
  await pause();
  assert.equal(button.textContent, "Activate");
  assert.equal(button.disabled, false);
  assert.equal(outgoing.length, 1, "Opening only reads activation status");
  await button.events.click();
  assert.equal(popupAuto, true);
  assert.equal(button.textContent, "Deactivate");
  await button.events.click();
  assert.equal(popupAuto, false);
  assert.equal(button.textContent, "Activate");
  allowed = false;
  await button.events.click();
  assert.equal(popupAuto, false);
  assert.match(button.title, /Allow API/);
  assert.equal(button.disabled, false);
  hideBad.checked = true; await hideBad.events.change();
  assert.equal(popupHide, true); assert.equal(hideBad.checked, true);
  assert.equal(popupAuto, false, "Filtering does not enable paid classification");
  hideError = true;
  hideBad.checked = false; await hideBad.events.change();
  assert.equal(hideBad.checked, true, "Failed visibility changes restore the checkbox");
  assert.match(button.title, /Visibility failed/);
  assert.equal(hideBad.disabled, false);
  clientPort.onMessage.emit({ type: "STATUS_CHANGED", autoClassify: true, hideBadVideos: true });
  assert.equal(button.textContent, "Deactivate");
  clientPort.onMessage.emit({ type: "STATUS_CHANGED", autoClassify: false, autoError: "Rate limited" });
  assert.equal(button.textContent, "Activate");
  assert.equal(button.title, "Rate limited");
  onHide(); assert.equal(disconnected, true);
}
console.log("Passed: indexed/incremental DOM work, push-driven popup, shared cache/requests, batched writes/labels, all layouts, automatic/manual mode, privacy, errors, and cleanup.");
