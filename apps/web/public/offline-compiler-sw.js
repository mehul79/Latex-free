// Only pinned compiler assets are intercepted. No API, document, or app-shell caching.
const VERSION = "busytex-20240217-7936974349";
const CACHE = `latex-free-compiler-${VERSION}`;
const NAMES = [
  "busytex.js",
  "busytex.wasm",
  "busytex_pipeline.js",
  "busytex_worker.js",
  "texlive-basic.js",
  "texlive-basic.data",
];
const PATHS = new Set(NAMES.map((name) => `/compiler/${VERSION}/${name}`));
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.search ||
    !PATHS.has(url.pathname)
  )
    return;
  event.respondWith(
    caches
      .open(CACHE)
      .then((cache) => cache.match(event.request))
      .then((response) => response || fetch(event.request)),
  );
});
