// Minimal service worker whose only job is receiving Web Push messages —
// this app has no offline/caching story, so there's deliberately no fetch
// handler here. Registered from src/push.js, scoped to the whole site.

self.addEventListener("push", (event) => {
  // "." not "/" for url — resolves relative to this script's own location
  // (this project can be deployed at a GitHub Pages subpath, see push.js).
  // qk (optional): a captured tile's quadkey, set by send-attack-alerts —
  // lets notificationclick below zoom the map there. Absent for the
  // energy-reset alert, which isn't about any one tile.
  let data = { title: "Plot Twist World", body: "Your energy reset.", url: ".", qk: null };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    /* non-JSON payload — fall back to the defaults above */
  }
  // No icon/badge fields — this project has no app icon asset yet, so
  // omitting them just falls back to the browser's default notification
  // glyph rather than a 404'd image. Add /icon-192.png + wire it in here
  // once a real icon exists.
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      data: { url: data.url, qk: data.qk },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { url = ".", qk } = event.notification.data || {};
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientsList.find((c) => c.url.includes(self.location.origin));
      if (existing) {
        // Already open — message the live app rather than navigating it,
        // so it can zoom the map in place without losing in-memory game
        // state (a full reload would re-fetch everything from scratch).
        if (qk) existing.postMessage({ type: "ptw:zoom-to-qk", qk });
        return existing.focus();
      }
      // Cold start — no running app to message, so the qk rides along as
      // a query param the app reads for itself once it's loaded (see
      // PlotTwistWorld.jsx's jumpToQk state).
      const target = qk ? `${url}${url.includes("?") ? "&" : "?"}qk=${encodeURIComponent(qk)}` : url;
      return self.clients.openWindow(target);
    })()
  );
});
