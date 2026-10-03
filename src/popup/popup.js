const browser = globalThis.chrome ?? globalThis.browser;
const button = document.querySelector("#toggle");
const hideBad = document.querySelector("#hide-bad");
let enabled = false;
let hideEnabled = false;
let hideBusy = false;
let busy = true;
let ready = false;

function render() {
  button.textContent = ready ? (enabled ? "Deactivate" : "Activate") : "Retry";
  button.disabled = busy;
  hideBad.checked = hideEnabled;
  hideBad.disabled = hideBusy || !ready;
}

function applyStatus(state) {
  if (typeof state?.autoClassify !== "boolean") throw new Error(state?.error || "Unable to load status.");
  enabled = state.autoClassify;
  hideEnabled = state.hideBadVideos === true;
  ready = true;
  button.title = state.autoError || "";
  render();
}

async function refresh() {
  applyStatus(await browser.runtime.sendMessage({ type: "GET_STATUS" }));
}

button.addEventListener("click", async () => {
  if (busy) return;
  busy = true;
  render();
  try {
    if (!ready) {
      await refresh();
      return;
    }
    const next = !enabled;
    if (next) {
      const allowed = await browser.permissions.request({ origins: [
        "https://api.typesafe.ai/*", "https://www.youtube.com/*",
        "https://youtube.com/*", "https://m.youtube.com/*",
      ] });
      if (!allowed) throw new Error("Allow API and YouTube access to activate.");
    }
    const response = await browser.runtime.sendMessage({ type: "SET_AUTOMATIC", enabled: next });
    if (!response?.ok) throw new Error(response?.error || "Unable to change activation.");
    await refresh();
  } catch (error) {
    button.title = error.message;
  } finally {
    busy = false;
    render();
  }
});

hideBad.addEventListener("change", async () => {
  if (hideBusy || !ready) return;
  const previous = hideEnabled;
  hideEnabled = hideBad.checked;
  hideBusy = true;
  render();
  try {
    const response = await browser.runtime.sendMessage({ type: "SET_HIDE_BAD", enabled: hideEnabled });
    if (!response?.ok) throw new Error(response?.error || "Unable to change BAD-video visibility.");
    await refresh();
  } catch (error) {
    hideEnabled = previous;
    button.title = error.message;
  } finally { hideBusy = false; render(); }
});

const port = browser.runtime.connect({ name: "youtube-popup" });
port.onMessage.addListener((message) => {
  if (message.type === "STATUS_CHANGED") applyStatus(message);
});
window.addEventListener("pagehide", () => port.disconnect(), { once: true });
void refresh().catch((error) => { button.title = error.message; }).finally(() => {
  busy = false;
  render();
});
