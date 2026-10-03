// Optional native-DOM regression test. Uses a disposable Chromium profile, only
// serves the reader/observer and synthetic cards, and makes no AI requests.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const reader = await readFile(new URL("../src/youtube-reader.js", import.meta.url), "utf8");
const observer = await readFile(new URL("../src/feed-observer.js", import.meta.url), "utf8");
const cards = Array.from({ length: 60 }, (_, index) => `<ytd-rich-item-renderer><ytd-rich-grid-media>
  <a class="thumbnail" href="https://www.youtube.com/watch?v=native${index}"><img></a>
  <h3><a id="video-title" href="https://www.youtube.com/watch?v=native${index}">Native video ${index}</a></h3>
  <ytd-thumbnail-overlay-time-status-renderer><span id="text">12:34</span></ytd-thumbnail-overlay-time-status-renderer>
</ytd-rich-grid-media></ytd-rich-item-renderer>`).join("");
const client = String.raw`
import { processYouTubePage as read } from "/reader.js";
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
try {
  let notifications = 0;
  Object.defineProperty(globalThis, "chrome", { configurable: true, value: {
    runtime: { sendMessage: async () => { notifications++; } },
  } });
  let queries = 0;
  for (const name of ["querySelector", "querySelectorAll"]) {
    const original = document[name].bind(document);
    document[name] = (...args) => { queries++; return original(...args); };
  }
  const page = read({ includeHtml: false });
  assert(page.videos.length === 60, "All native cards are extracted");
  const labels = page.videos.map((video, index) => ({ ...video, label: index % 2 ? "bad" : "good", confidence: 0.9 }));
  const beforeLabels = queries;
  read({ labels, hideBad: true, includeHtml: false });
  assert(queries === beforeLabels, "Labels must not rescan the native document");
  const roots = [...document.body.children].filter((node) => node.matches("ytd-rich-item-renderer"));
  assert(roots.every((root, index) => (getComputedStyle(root).display === "none") === !!(index % 2)), "BAD cards collapse whole grid slots; GOOD cards stay visible");
  assert(document.body.querySelectorAll("[data-valuable-bot-thumbnail]").length === 60, "All native thumbnails are still labeled");
  read({ hideBad: false, includeHtml: false });
  assert(roots.every((root) => getComputedStyle(root).display !== "none"), "Disabling restores every card");
  const beforeReads = queries;
  for (let index = 0; index < 100; index++) read({ includeHtml: false });
  assert(queries === beforeReads, "100 unchanged snapshots perform zero document queries");
  const script = document.createElement("script"); script.src = "/observer.js";
  await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; document.head.append(script); });
  await tick();
  const initialNotifications = notifications;
  const noise = document.createElement("span"); noise.textContent = "00:01"; document.body.append(noise);
  noise.style.color = "red"; document.body.className = "theme-change"; await tick();
  assert(notifications === initialNotifications, "Non-video DOM changes do not wake the background");
  read({ labels, includeHtml: false }); await tick();
  assert(notifications === initialNotifications, "Our labels do not trigger native MutationObserver feedback");
  read({ hideBad: true, includeHtml: false }); await tick();
  const cloned = roots[1].cloneNode(true);
  cloned.querySelector("#video-title").textContent = "Brand new title";
  for (const link of cloned.querySelectorAll("a[href]")) link.href = "https://www.youtube.com/watch?v=cloned";
  document.body.append(cloned); await tick();
  assert(getComputedStyle(cloned).display !== "none", "Cloned/recycled cards lose obsolete hidden state");
  const newVideo = read({ includeHtml: false }).videos.find((video) => video.title === "Brand new title");
  assert(newVideo, "The real observer discovers newly added cards immediately");
  const beforeNewLabel = queries;
  read({ labels: [{ ...newVideo, label: "bad", confidence: 0.9 }], includeHtml: false });
  assert(queries === beforeNewLabel, "Individual native decisions use the URL index");
  assert(getComputedStyle(cloned).display === "none", "New BAD results are hidden immediately");
  const clockNotifications = notifications;
  read({ watchHtml: true, includeHtml: false }); noise.style.color = "blue"; await tick();
  assert(notifications > clockNotifications, "Live HTML still tracks non-video attribute changes");
  const summary = "PASS: 60 native cards, indexed labels, zero-query unchanged reads, reversible BAD filtering, real observer, recycled nodes, and live HTML.";
  document.body.replaceChildren(Object.assign(document.createElement("pre"), { textContent: summary }));
} catch (error) {
  document.body.replaceChildren(Object.assign(document.createElement("pre"), { textContent: "FAIL: " + error.stack }));
}
`;
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${cards}<script type="module">${client}</script></body></html>`;
const server = createServer((request, response) => {
  if (request.url === "/reader.js" || request.url === "/observer.js") {
    response.setHeader("Content-Type", "text/javascript"); response.end(request.url === "/reader.js" ? reader : observer);
  } else if (request.url === "/") {
    response.setHeader("Content-Type", "text/html"); response.end(html);
  } else { response.writeHead(404); response.end(); }
});
const profile = await mkdtemp(join(tmpdir(), "valuable-bot-browser-"));
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { stdout, stderr } = await promisify(execFile)(process.env.CHROMIUM_BIN || "chromium", [
    "--headless", "--no-sandbox", "--disable-gpu", "--disable-extensions", "--disable-background-networking",
    "--disable-sync", "--no-first-run", "--no-default-browser-check", "--no-proxy-server", "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
    `--user-data-dir=${profile}`, "--dump-dom", "--virtual-time-budget=3000", `http://127.0.0.1:${server.address().port}/`,
  ], { timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const result = stdout.match(/<pre>([\s\S]*?)<\/pre>/)?.[1];
  if (!result && process.env.DEBUG_BROWSER) console.error(stderr, stdout.slice(0, 2000), stdout.slice(-2000));
  assert.ok(result?.startsWith("PASS:"), result || "Chromium did not finish the browser test");
  console.log(result);
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
