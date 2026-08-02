self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "Новое уведомление" };
  }

  const title = payload.title || "Faj QR";
  const options = {
    body: payload.body || "Требуется внимание владельца",
    icon: payload.icon || "/faj-qr-icon-192.png",
    badge: payload.badge || "/faj-qr-icon-192.png",
    tag: payload.tag || "owner-alert",
    renotify: true,
    requireInteraction: true,
    data: { url: payload.url || "/admin" }
  };

  event.waitUntil(Promise.all([
    self.registration.showNotification(title, options),
    typeof self.registration.setAppBadge === "function"
      ? self.registration.setAppBadge(Number(payload.badgeCount || 1))
      : Promise.resolve()
  ]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || "/admin", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.location.origin));
    if (existing) {
      await existing.navigate(targetUrl);
      return existing.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
