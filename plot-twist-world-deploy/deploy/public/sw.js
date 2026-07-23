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
  const target = qk ? `${url}${url.includes("?") ? "&" : "?"}qk=${encodeURIComponent(qk)}` : url;
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientsList.find((c) => c.url.includes(self.location.origin));
      if (existing) {
        if (qk) {
          // navigate(), not postMessage, to an existing tab — iOS
          // frequently suspends (or silently re-executes) a backgrounded
          // PWA's JS between the phone locking and the notification being
          // tapped, so a postMessage sent to that page can arrive before
          // its message listener has re-registered, or after the page's
          // gone entirely — it's just lost, no error, no retry. navigate()
          // forces a real (re)load of the qk-bearing URL, which the app
          // parses fresh on every mount regardless of what state its JS
          // was in a moment ago — the one path already confirmed to work.
          try {
            await existing.navigate(target);
            return existing.focus();
          } catch {
            // navigate() unsupported/blocked in this browser — best-effort
            // postMessage for a page that's actually still alive.
            existing.postMessage({ type: "ptw:zoom-to-qk", qk });
          }
        }
        return existing.focus();
      }
      // Cold start — nothing to navigate, so the qk rides along as a query
      // param the app reads for itself once it's loaded (see
      // PlotTwistWorld.jsx's jumpToQk state).
      return self.clients.openWindow(target);
    })()
  );
});
