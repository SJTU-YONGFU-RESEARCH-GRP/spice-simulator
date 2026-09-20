// This worker owns only the static application shell. User Projects and
// browser recovery records are deliberately outside Cache Storage.
// Replaced by the Vite build with a digest of the emitted index.html. This
// changes when its content-hashed application asset graph changes, allowing
// activate() to remove the prior shell instead of retaining it indefinitely.
//
// Manual bumps (2026-09-19). Assets are cached by URL and served without
// revalidation -- the shell list at install time, and any same-origin
// script/style/image/font/manifest on first fetch -- so a hand-patch that keeps
// its filename is invisible to every returning client for as long as this
// constant lives. Bumping it is the only thing that can retire the stale copy:
// activate() drops every "icm-static-shell-*" cache but this one, and the
// runtime fetches were written into this same bucket. App-*.js is only ever
// reached through that second route, not through shellUrls().
// Value: first 12 hex digits of the most recently patched asset's SHA-256.
//   c639654867ce  <- assets/src-CMkpkg0p.js          (base-relative asset paths)
//   06929bd5df04  <- assets/jsx-dev-runtime-DuB4xY43.js  (ref semantics)
//   c676f34651bc  <- assets/App-D0jgYDVz.js          (unlock gate on ?example=)
//   e334a99451bc  <- assets/spice-simulation-surface-Dua32hSB.js  (28 JSX sites)
//   9d4063a821ec  <- assets/cell-manager-dialog-DJciZ6wz.js       (2 JSX sites)
//   1f8cc619d874  <- assets/App-D0jgYDVz.js                       (1 JSX site)
// The A7 repair of 2026-09-19 patched all three in one pass (31 call sites
// emitted as `(void 0)(`, uncallable). CACHE takes the surface chunk's digest:
// that is the one whose failure took the whole application down on Run.
//   2026-09-20, outbound repair (scripts/patch-outbound.mjs, two chunks):
//     bcc8626f4326 <- assets/index-7P_aude7.js   (B7: feedback link re-pointed
//                     from the private spice-simulator-lab to the public
//                     spice-simulator repository's new-issue URL)
//     ff20e7487948 <- assets/src-CMkpkg0p.js     (S4: the ngspice CDN fallback
//                     now verifies the payload against the SHA-256 of the
//                     engine this repository ships, and refuses to execute on
//                     mismatch)
const CACHE = "icm-static-shell-ff20e7487948";

function scopeUrl() {
  return new URL(self.registration.scope);
}

function shellUrls() {
  const scope = scopeUrl();
  return [
    new URL("./", scope).toString(),
    new URL("manifest.webmanifest", scope).toString(),
    new URL("logo.png", scope).toString(),
    new URL("favicon.png", scope).toString(),
    new URL("icon-192.png", scope).toString(),
    new URL("icon-512.png", scope).toString(),
  ];
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(shellUrls())),
  );
  // Do not skipWaiting: a new shell must never take over an editor with
  // unsaved in-memory work. The browser activates it after the old client ends.
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith("icm-static-shell-") && key !== CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      ),
  );
});

function isStaticAsset(request) {
  return ["script", "style", "image", "font", "manifest"].includes(
    request.destination,
  );
}

function isSameOriginApi(request) {
  const requestUrl = new URL(request.url);
  const scope = scopeUrl();
  return (
    requestUrl.origin === scope.origin &&
    (requestUrl.pathname === "/api" || requestUrl.pathname.startsWith("/api/"))
  );
}

/**
 * Whether a response is the kind of thing the request asked for.
 *
 * Asset names carry a content hash, so this cache is keyed on names that
 * promise never to change meaning — which makes a wrong answer permanent.
 * A single-page-application fallback answers a missing asset with the app
 * shell under `200 text/html`; caching that as a script would leave the name
 * broken for as long as the cache lives, long after the deploy that caused
 * it. Store only what matches.
 */
function servesWhatWasAsked(request, response) {
  if (
    (response.headers.get("cache-control") ?? "")
      .toLowerCase()
      .includes("no-store")
  ) {
    return false;
  }
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  if (!type) return true;
  if (request.destination === "script") return type.includes("javascript");
  if (request.destination === "style") return type.includes("css");
  return !type.includes("text/html");
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // APIs own their own HTTP caching policy. In particular, Gallery previews
  // use revisioned URLs; putting them in the build-scoped shell cache would
  // ignore that policy and keep an old or access-controlled image alive.
  if (isSameOriginApi(event.request)) return;

  // Navigation is network-first so a deployed build can replace index.html and
  // point at its fresh, content-hashed Vite assets. Offline falls back only to
  // the known shell, never to a Project or arbitrary cached request.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            void caches
              .open(CACHE)
              .then((cache) => cache.put(scopeUrl(), response.clone()));
          }
          return response;
        })
        .catch(() => caches.match(scopeUrl())),
    );
    return;
  }

  // Only same-origin static assets are cached. This intentionally excludes
  // arbitrary GETs, imported files, Project downloads, and future APIs.
  if (
    isStaticAsset(event.request) &&
    new URL(event.request.url).origin === scopeUrl().origin
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok && servesWhatWasAsked(event.request, response)) {
            void caches
              .open(CACHE)
              .then((cache) => cache.put(event.request, response.clone()));
          }
          return response;
        });
      }),
    );
  }
});
