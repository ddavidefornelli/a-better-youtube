import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
assert.equal(manifest.manifest_version, 3, "Use Manifest V3");
assert.ok(manifest.name, "Extension name is required");
assert.match(manifest.version, /^\d+(\.\d+){0,3}$/, "Invalid version format");

assert.equal(manifest.background.service_worker, "src/background.js");
assert.equal(manifest.background.type, "module");
assert.equal(manifest.background.scripts, undefined);
assert.equal(manifest.browser_specific_settings, undefined);
assert.equal(manifest.minimum_chrome_version, "120");
assert.deepEqual(manifest.host_permissions, ["https://api.typesafe.ai/*", "https://www.youtube.com/*", "https://youtube.com/*", "https://m.youtube.com/*"]);
assert.ok(manifest.permissions.includes("alarms"));

for (const path of [
  manifest.action.default_popup,
  manifest.background.service_worker,
  "src/youtube-reader.js",
  "src/typesafe.js",
  "src/typesafe-config.local.js",
  "src/popup/popup.css",
  "src/popup/popup.js",
]) {
  await access(join(root, path));
}

async function checkJavaScript(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await checkJavaScript(path);
    } else if (/\.(js|mjs)$/.test(entry.name)) {
      execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
    }
  }
}

await checkJavaScript(join(root, "src"));
await checkJavaScript(join(root, "scripts"));
console.log("Manifest, extension files, and JavaScript syntax checks passed.");
