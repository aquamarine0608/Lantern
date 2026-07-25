/* Lantern service worker — keeps the app shell and CDN code available offline.
   The ~90 MB Kokoro model is cached separately by transformers.js (browser Cache API),
   so after one successful run the whole app works in airplane mode. */

const SHELL = "lantern-shell-v1";
const CDN = "lantern-cdn-v1";
const SHELL_FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-180.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("lantern-") && k !== SHELL && k !== CDN).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Hugging Face model files: let transformers.js manage its own cache.
  if (url.hostname.endsWith("huggingface.co")) return;

  // CDN code + fonts: cache-first, fill cache on first fetch.
  const isCdn =
    url.hostname === "cdn.jsdelivr.net" ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com";

  if (isCdn || url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(isCdn ? CDN : SHELL).then((c) => c.put(e.request, copy));
            }
            return res;
          })
      )
    );
  }
});
