import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// player-facing semantic version — the single source of truth is
// package.json's "version" field (bump it by hand per release, e.g.
// `npm version minor`). Shown in the corner badge and the "new version"
// banner text.
const APP_VERSION = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8")
).version;

// build fingerprint: short git commit hash (falls back to a timestamp if
// there's no git repo, e.g. a zip export). Changes on every real deploy
// even when nobody remembered to bump package.json's version, so this
// (not APP_VERSION) is what the client actually compares to detect a stale
// bundle — see PlotTwistWorld.jsx's version-check effect.
function buildId() {
  try { return execSync("git rev-parse --short HEAD").toString().trim(); }
  catch { return Date.now().toString(36); }
}
const BUILD_ID = buildId();

// emits dist/version.json so the running app can poll for a newer deploy
// without a service worker.
function versionJsonPlugin() {
  return {
    name: "plot-twist-version-json",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: APP_VERSION, build: BUILD_ID }) });
    },
  };
}

// base './' makes the build work on GitHub Pages subpaths too
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), versionJsonPlugin()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION), __BUILD_ID__: JSON.stringify(BUILD_ID) },
});
