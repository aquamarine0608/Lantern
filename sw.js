/* Lantern service worker — keeps the app shell and CDN code available offline.
   The ~90 MB Kokoro model is cached separately by transformers.js (browser Cache API),
   so after one successful run the whole app works in airplane mode. */

const VERSION = "v3";
const SHELL = `lantern-shell-${VERSION}`;
const CDN = `lantern-cdn-${VERSION}`;
const SHELL_FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-180.png", "./icon-512.png"];
const CDN_PRECACHE = [
  "https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js",
  "https://cdn.jsdelivr.net/npm/fflate@0.8.3/esm/browser.js",
  "https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&display=swap",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    Promise.all([
      // cache: "reload" so a version bump can never repopulate from a stale HTTP cache
      caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: "reload" })))),
      // best-effort: the first visit fetches the CDN module before this worker controls
      // the page, so precache it here — otherwise "offline after one visit" silently
      // depends on the volatile HTTP cache until a second visit.
      caches.open(CDN).then((c) =>
        Promise.all(
          CDN_PRECACHE.map((u) =>
            c.match(u).then((hit) =>
              hit ||
              // migrate from any previous versioned cache first — these URLs are pinned
              // and immutable, and the CDN may be unreachable during an update install
              caches.match(u).then((old) =>
                old ? c.put(u, old) : fetch(u).then((res) => { if (cacheable(res)) return c.put(u, res); })
              )
            )
          )
        )
      ).catch(() => {}),
    ]).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("lantern-") && k !== SHELL && k !== CDN).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Opaque responses (no-cors stylesheet/font fetches) report ok === false but are
   still the real bytes — they must be cached or fonts break offline. */
const cacheable = (res) => res && (res.ok || res.type === "opaque");

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Hugging Face model files: let transformers.js manage its own cache.
  if (url.hostname.endsWith("huggingface.co") || url.hostname.endsWith("hf.co")) return;

  // Navigations: network-first so a deployed update is picked up on the next
  // visit, falling back to the cached shell offline. ignoreSearch keeps
  // home-screen launches and shared links with query params working offline.
  if (e.request.mode === "navigate") {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const forRoot = res.clone(), forIndex = res.clone();
            caches.open(SHELL).then((c) => { c.put("./", forRoot); c.put("./index.html", forIndex); });
          }
          return res;
        })
        .catch(() =>
          caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match("./"))
        )
    );
    return;
  }

  // CDN code + fonts: cache-first, fill cache on first fetch.
  const isCdn =
    url.hostname === "cdn.jsdelivr.net" ||
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com";

  if (isCdn) {
    e.respondWith(
      caches.open(CDN).then((c) =>
        c.match(e.request).then(
          (hit) =>
            hit ||
            fetch(e.request).then((res) => {
              if (cacheable(res)) c.put(e.request, res.clone());
              return res;
            })
        )
      )
    );
    return;
  }

  // Other same-origin assets (icons, manifest): cache-first per shell version.
  if (url.origin === self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(
        (hit) =>
          hit ||
          fetch(e.request).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(e.request, copy));
            }
            return res;
          })
      )
    );
  }
});
