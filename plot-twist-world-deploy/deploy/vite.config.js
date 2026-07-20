import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";

// build id: short git commit hash (falls back to a timestamp if there's no
// git repo, e.g. a zip export) — this powers the in-game "update available"
// check and the corner version badge, distinct from BUILD_TAG (a hand-bumped
// human-readable string in PlotTwistWorld.jsx used only in the debug panel).
function buildId() {
  try { return execSync("git rev-parse --short HEAD").toString().trim(); }
  catch { return Date.now().toString(36); }
}
const APP_VERSION = buildId();

// emits dist/version.json so the running app can poll for a newer deploy
// without a service worker — see the version-check effect in
// PlotTwistWorld.jsx that fetches this and compares against __APP_VERSION__.
function versionJsonPlugin() {
  return {
    name: "plot-twist-version-json",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: JSON.stringify({ version: APP_VERSION }) });
    },
  };
}

// base './' makes the build work on GitHub Pages subpaths too
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss(), versionJsonPlugin()],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
});
