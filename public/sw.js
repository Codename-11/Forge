const VERSION = "2026-06-06";
const STATIC_CACHE = `forge-static-${VERSION}`;
const PAGE_CACHE = `forge-pages-${VERSION}`;
const OFFLINE_URL = "/offline";
const OFFLINE_PAGE_CACHE_FLAG = "/__forge_pwa/offline-page-cache-enabled";
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/brand/forge-app-icon-v2-ember.svg",
  "/icons/forge-icon-192.png",
  "/icons/forge-icon-512.png",
  "/icons/forge-maskable-512.png",
  "/apple-icon.png",
  "/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith("forge-") && key !== STATIC_CACHE && key !== PAGE_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  if (request.headers.has("range")) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (isStatefulPath(url.pathname)) return;

  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

async function networkFirstNavigation(request) {
  const cachePages = await isOfflinePageCacheEnabled();
  try {
    const response = await fetch(request);
    if (cachePages && shouldCacheNavigation(request, response)) {
      const cache = await caches.open(PAGE_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  } catch {
    if (cachePages) {
      const cachedPage = await caches.match(request);
      if (cachedPage) return cachedPage;
    }
    const cached = await caches.match(OFFLINE_URL);
    return (
      cached ??
      new Response("Forge is offline.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      })
    );
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "SKIP_WAITING") {
    self.skipWaiting();
    return;
  }
  if (data.type === "SET_OFFLINE_PAGE_CACHE") {
    event.waitUntil(setOfflinePageCacheEnabled(data.enabled === true));
  }
});

self.addEventListener("push", (event) => {
  const payload = readPushPayload(event);
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: payload.icon ?? "/icons/forge-icon-192.png",
      badge: payload.badge ?? "/icons/forge-icon-192.png",
      tag: payload.tag,
      data: { url: payload.url ?? "/", notificationId: payload.notificationId ?? null },
      renotify: payload.renotify === true,
      requireInteraction: payload.requireInteraction === true,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client && client.url === targetUrl) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (!response || response.status !== 200 || response.type !== "basic") {
    return response;
  }

  const cache = await caches.open(STATIC_CACHE);
  await cache.put(request, response.clone());
  return response;
}

function isStatefulPath(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/signin") ||
    pathname.startsWith("/connections/") ||
    pathname.startsWith("/_next/image")
  );
}

function isStaticAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/brand/") ||
    pathname.startsWith("/icons/") ||
    pathname === "/apple-icon.png" ||
    pathname === "/icon.svg" ||
    pathname === "/manifest.webmanifest"
  );
}

function shouldCacheNavigation(request, response) {
  if (!response || response.status !== 200 || response.type !== "basic") return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname === OFFLINE_URL) return false;
  if (url.pathname.startsWith("/api/")) return false;
  if (url.pathname.startsWith("/auth/")) return false;
  if (url.pathname.startsWith("/signin")) return false;
  if (url.pathname.startsWith("/_next/")) return false;
  return true;
}

async function isOfflinePageCacheEnabled() {
  const cached = await caches.match(OFFLINE_PAGE_CACHE_FLAG);
  if (!cached) return false;
  return (await cached.text()) === "1";
}

async function setOfflinePageCacheEnabled(enabled) {
  const cache = await caches.open(STATIC_CACHE);
  if (enabled) {
    await cache.put(OFFLINE_PAGE_CACHE_FLAG, new Response("1"));
    return;
  }
  await cache.delete(OFFLINE_PAGE_CACHE_FLAG);
  await caches.delete(PAGE_CACHE);
}

function readPushPayload(event) {
  const fallback = {
    title: "Forge",
    body: "New Forge notification",
    url: "/",
    tag: "forge-notification",
  };
  if (!event.data) return fallback;
  try {
    return { ...fallback, ...event.data.json() };
  } catch {
    return { ...fallback, body: event.data.text() };
  }
}
