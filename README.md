# Valuable Bot Chrome extension

A dependency-free Chrome Manifest V3 extension that reads YouTube video titles,
durations, and page HTML, and labels titles and thumbnails with Jev's learning-fit decisions.
Requires Chrome 120+ (also works in compatible Chromium browsers such as Brave
and Edge). No build step or store publication is required for personal use.

## Install locally

If `src/typesafe-config.local.js` is missing, copy
`src/typesafe-config.example.js` to that path. The module is required even when
you leave its key blank and supply a session key through background messaging.

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this project's folder (the folder containing
   `manifest.json`, not the manifest file itself).
4. Pin **Valuable Bot** from Chrome's extensions menu if desired.
5. Configure your personal key in `src/typesafe-config.local.js` (see below),
   reload the extension, and open YouTube. Classification starts automatically;
   no popup or Classify click is required.

The extension stays installed after browser restarts. Keep its folder in place.
After code changes, click the extension's reload button in `chrome://extensions`,
reload any YouTube tabs to clear old injected observers, and reopen the popup.
Use the **service worker** inspection link on the extension card to debug it.

## Classify and filter videos

1. Get a personal key from [TypeSafe's dashboard](https://console.typesafe.ai/keys)
   and configure it locally (see below).
2. Open YouTube. Jev adds **[GOOD]** or **[BAD]** to titles and a **GOOD/BAD**
   badge to each matching thumbnail, including cards you have not opened.
3. Use **Activate / Deactivate** in the popup to control automatic classification.
4. Enable **Hide BAD videos** to collapse BAD cards completely instead of only
   marking them. Turn it off to restore them immediately, with their labels intact.
   The setting is remembered across browser restarts and applies to all YouTube
   tabs, independently of activation. The current watch-page title/player stays
   visible. Hidden cards remain indexed, so they are not reclassified merely
   because they are hidden or shown again. No videos are deleted from YouTube.

Only loaded cards are read: home, search, channel, playlist, Shorts, related lists,
and the current watch-page video. No auto-scrolling, fetching unloaded feeds,
or transcript reading occurs. YouTube markup changes may require selector updates.

Automatic classification is enabled by default, including with the popup closed
and after browser restarts. DOM changes update only affected cards; unrelated
page activity and our own labels do not trigger classification. Each tab keeps
an indexed snapshot and applies results directly to matching titles/thumbnails.
The popup receives status updates instead of polling. A 30-second alarm recovers
existing/restored tabs using cached snapshots, without rescanning unchanged DOM.
Discarded tabs are skipped. Navigation, visibility restoration, and player-duration
changes are also tracked.

Videos start classification in parallel, one request per uncached title/duration.
New cards never wait for earlier API calls. Manual and automatic requests across
all tabs share in-flight work and the session cache. Result bursts share storage
commits and indexed label writes rather than repeatedly reading/writing the cache
or walking the full feed. Cached decisions are applied without an API wait;
uncached labels/hiding still depend on network and AI latency, so instant new AI
results cannot be guaranteed. Large feeds can reach API rate limits.

Automatic mode stops for the current session on API errors; the activation button's
tooltip shows the error. Re-enable it after fixing the error. Chrome must remain
running. Deactivate to disable automatic requests across restarts; an in-flight call
may finish. API calls can incur charges. A code-configured key works across restarts;
keys supplied only to session storage do not.

### Classification and privacy

The profile is a 21-year-old seeking knowledge in coding, business, or maths,
with a preference for long-form and curiosity-style content and against slop,
entertainment, and politics. **GOOD** means likely substantive, relevant learning, including rigorous
foundations and technical/practical case studies. **BAD** means poor fit for that
goal (unrelated, superficial, hype, entertainment, or insufficient evidence of
relevant depth). This is not a general judgment of video quality. Classification
uses titles and durations, not transcripts or video content; it can be wrong.
Duration alone does not determine depth. Decisions also include a confidence score.

Requests use `POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`, and
one `choice` question per video. See the [API reference](https://docs.typesafe.ai/api).
Only titles, durations, and the learning profile/rubric are submitted, along with
your API key for authentication. HTML, URLs, and cookies are excluded. Decisions
are cached by title/duration, learning profile, and rubric version for the browser session (up to
1,000 entries). Failed paid requests are not automatically retried.

Keys supplied through background messaging are saved in `chrome.storage.session`
when automatic mode is enabled or after a successful manual request. They are
cleared when Chrome closes, the extension reloads, or `FORGET_TYPESAFE_KEY` is sent.
Forgetting also stops automatic mode and clears cached decisions, but not existing
page labels. Keys are not written to local/sync storage. Session storage is not an
encrypted vault.

### Optional personal key in code

Edit `src/typesafe-config.local.js` locally:

```js
export const TYPESAFE_API_KEY = "YOUR_PERSONAL_API_KEY";
```

Reload the extension. Priority is an explicitly supplied key, saved session key,
then local config. Forgetting a session key does not erase a code-embedded key;
edit the file and reload to remove/change it. The local file is Git-ignored, but anyone with the extension
files can read its key. Never share a keyed copy or embed a shared production key.

## Development

Run `npm run check` and `npm test` with Node.js 20+. No `npm install` is needed.
Tests validate the manifest, syntax, all extraction layouts, incremental/indexed
work, filtering, messaging, cache batching/deduplication, and error handling.
`npm run test:browser` additionally tests real DOM, MutationObserver, and CSS
behavior in headless Chromium (`CHROMIUM_BIN` can override the executable).
It uses a disposable profile and synthetic cards; no extension key or AI requests
are used. These tests do not replace a real YouTube/API test with your own key.

- `manifest.json` — Chrome metadata, permissions, and entry points.
- `src/background.js` — module service worker; validates tabs and launches parallel classification.
- `src/feed-observer.js` — idempotent, relevant-change observer in YouTube tabs.
- `src/youtube-reader.js` — persistent isolated-world DOM index, labels, and reversible filtering.
- `src/typesafe.js` — Jev rubric, requests, key selection, and cache.
- `src/typesafe-config.example.js` — blank template for the required local config.
- `src/popup/` — activation and BAD-video visibility controls.
- `scripts/` — validation and mocked tests.

The code aliases Chrome's promise-based `chrome` API as `browser`, with a fallback
for test environments. Background messaging uses `sendResponse` and returns `true`
to keep asynchronous response channels open on Chrome 120+. The manifest uses
`background.service_worker`, not Firefox's `background.scripts`.

The background messaging API retains manual reading/classification and HTML
snapshots: `READ_YOUTUBE_PAGE` (`includeHtml`, `force`), `CLASSIFY_VIDEOS`,
`GET_STATUS`, `SET_AUTOMATIC`, `SET_HIDE_BAD`, and `FORGET_TYPESAFE_KEY`.
HTML snapshots are serialized only when explicitly requested, returned as text,
and never submitted to the AI. Popup ports can subscribe to page/status updates.

`activeTab` and `scripting` enable reading the active page; YouTube host permissions
allow background reading/labeling in inactive tabs and a document-start feed observer. TypeSafe host access enables
AI requests. `storage` holds session-only keys, decisions, and error status, plus a local
(non-secret) activation and filtering preferences. `alarms` wakes the service worker every 30 seconds. Chrome can terminate
idle service workers, so persistent session state lives in storage and listeners
are registered at the top level. Keep scripts local; avoid inline JavaScript and
`eval`, which Manifest V3's default content security policy blocks.

## Troubleshooting

- After manifest changes, reload the extension and check its errors in
  `chrome://extensions`. Check site access for YouTube and TypeSafe.
- Connection failures and 60-second timeouts are reported separately. Check your
  connection, extension host access, and VPN/proxy/firewall settings.
- HTTP 401/403 means the key/account was rejected. HTTP 429/529 means wait before
  retrying. Never paste API keys into logs or issue reports.

## Sharing or publishing

Personal unpacked installation needs no ZIP, signing, or store submission.
For distribution, add suitable icons/listing assets and comply with Chrome Web
Store privacy and disclosure requirements.

Prepare a separate packaging directory. Replace its `src/typesafe-config.local.js`
with a blank-key copy of the example template before creating any ZIP. Do not omit
the required module and never include your real key: Git ignore does not protect
files included by ZIP commands. Package `manifest.json` and `src/` at the ZIP root
for submission to the Chrome Web Store. Development scripts are not required.
