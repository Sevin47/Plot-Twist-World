// Minimal service worker whose only job is receiving Web Push messages —
// this app has no offline/caching story, so there's deliberately no fetch
// handler here. Registered from src/push.js, scoped to the whole site.

self.addEventListener("push", (event) => {
  // "." not "/" for url — resolves relative to this script's own location
  // (this project can be deployed at a GitHub Pages subpath, see push.js).
  let data = { title: "Plot Twist World", body: "Your energy reset.", url: "." };
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
      data: { url: data.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/";
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientsList.find((c) => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })()
  );
});
