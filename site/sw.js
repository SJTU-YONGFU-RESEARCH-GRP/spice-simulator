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
// Value: DERIVED, not chosen. It is the first 12 hex digits of a SHA-256 over
// (a) the bytes of every file these routes could STORE -- the shellUrls() members,
// every extension a resource tag can request, and everything under
// ENGINE_PAYLOAD_DIRS -- and (b) those two declarations themselves, because they
// decide which of those URLs are stored. Neither the constant nor these comments
// is an input, so the value is stable until the artifact or those declarations
// move. A file this worker can never be asked for (a licence text, a release
// manifest) is deliberately not hashed: it cannot go stale in anyone's cache.
// Do not edit it by hand. Run `node scripts/shell-cache.mjs --write`, which
// derives it; check 13 of scripts/check-artifacts.mjs fails the build when the
// declared token stops describing this tree. Until 2026-09-21 the value was
// picked by hand and nothing verified it, so a hand-patch could ship beside a
// stale constant and never reach a returning client at all.
// The entries below are the record of which change forced each bump; the ones
// before 2026-09-21 predate the derivation and name the asset they were taken
// from. Each of them is still the reason that bump was needed.
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
//   2026-09-20, storage-guard repair (scripts/patch-outbound.mjs with
//   --manifest=scripts/storage-guard.json, three files):
//     1aa73603f3ae <- assets/App-D0jgYDVz.js  (B9: six storage reads that ran
//                     during the first render now sit inside try/catch, so a
//                     browser that denies storage renders the editor instead
//                     of the error boundary's crash screen)
//     a6a953b256fa <- index.html              (the inline theme bootstrap in
//                     the head is wrapped too; same denial, same throw)
//     a6a953b256fa <- 404.html                (identical shell, identical fix)
// CACHE takes the surface chunk's digest again: with storage denied it was
// App-*.js that took the whole application down on first paint.
//   2026-09-20, shell-csp repair (scripts/patch-outbound.mjs with
//   --manifest=scripts/shell-csp.json, both shell documents):
//     817dbac0b7a8 <- index.html  (S5: the deploy shell now carries a
//                     Content-Security-Policy. Until now it named no origin at
//                     all, so any script injected from anywhere -- a compromised
//                     dependency, a tampered mirror, an inline payload -- ran
//                     with the editor's own authority, beside a WASM engine and
//                     the user's locally stored projects)
//     817dbac0b7a8 <- 404.html    (identical shell, identical policy)
// CACHE takes the shell document's digest: the policy IS the artifact, and a
// returning client must not keep a cached copy that still names nothing.
//   2026-09-20, runtime-cache repair (this file):
//     eb06299c334a <- the payload declaration in isEnginePayload() below
//                     (two defects: every put on the runtime route threw
//                     "Response body is already used" because the response was
//                     cloned inside the caches.open() callback, past the point
//                     where respondWith() had taken the body -- so nothing was
//                     ever stored and only install()'s shellUrls() entries were
//                     ever cached; and the engine payload, which arrives by
//                     fetch() with an empty destination, was never routed here
//                     at all -- see the comments at each site)
// CACHE takes a digest of the payload declaration rather than of a file: the
// artifact this repair changed is the worker itself, and a file cannot hash
// itself. The declaration is the thing that decides what this cache holds.
// Reproduce with: printf 'vendor/\nmodels/\n' | sha256sum | cut -c1-12
//   2026-09-20, precache shrinking (this file and site/logo.png):
//     4acc26b4ae25 <- site/logo.png  (B5: the install payload was 738.1 KiB, of
//                     which 735.9 KiB was four images. logo.png alone was
//                     365,313 B of 558x558 RGBA that the browser draws into a
//                     176x176 device-pixel box, and icon-512.png was 326,919 B
//                     that no measured page load ever requested. logo.png is now
//                     176x176 RGB and icon-512.png has left shellUrls(); the
//                     list is 105.8 KiB and bounded by
//                     scripts/precache-budget.json)
// This bump is not optional even though no asset filename changed: a returning
// client would otherwise keep serving the 558x558 logo out of its existing
// cache. Reproduce with: sha256sum site/logo.png | cut -c1-12
//   2026-09-21, derived token (scripts/shell-cache.mjs, check 13):
//     0e52479ced0d <- not a file: the token became a digest of the bytes these
//                     routes can store, plus the two declarations below that
//                     decide which of them they do. Before this, the value was
//                     the most recently patched asset's digest, chosen by hand,
//                     and nothing could see whether it still described what this
//                     worker serves. Reproduce with: node scripts/shell-cache.mjs
const CACHE = "icm-static-shell-3d9482c3c494";

function scopeUrl() {
  return new URL(self.registration.scope);
}

/**
 * What install() precaches, and the only thing it precaches.
 *
 * Every member here is downloaded by every first-time visitor before the worker
 * can serve anything, because install() runs cache.addAll() and addAll() is
 * atomic -- one member that fails to fetch aborts the whole install and the
 * application loses its offline shell entirely. That makes this list a fixed
 * up-front cost, so it is kept to what the shell actually renders offline:
 * the document, the manifest, and the three images the page asks for.
 *
 * The size of this list is bounded by scripts/precache-budget.json, which
 * check 5 of scripts/check-artifacts.mjs enforces. Two members had to go to fit:
 *
 *   icon-512.png (326,919 B) is named only by manifest.webmanifest. The page
 *   never renders it, and a browser did not request it across three measured
 *   page loads -- a cold load, a ?example= deep link, and a reload after a
 *   simulation -- while it requested icon-192.png on all three. It stays in the
 *   manifest for the browser to fetch when it wants a 512 px icon; it just does
 *   not belong in a payload that is paid atomically before first paint.
 *
 *   logo.png was 365,313 B of 558x558 RGBA. At device pixel ratio 4 the browser
 *   draws it into a 176x176 device-pixel box -- the element is 44x44 CSS and the
 *   other consumer in the stylesheet is a 40x40 mark -- so the source carried
 *   3.2x more pixels per axis than any supported display can show. It is now
 *   176x176 RGB at 44,726 B. The file is a committed build product, so a rebuild
 *   restores the old one, and the budget above is what notices.
 */
function shellUrls() {
  const scope = scopeUrl();
  return [
    new URL("./", scope).toString(),
    new URL("manifest.webmanifest", scope).toString(),
    new URL("logo.png", scope).toString(),
    new URL("favicon.png", scope).toString(),
    new URL("icon-192.png", scope).toString(),
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

/**
 * Directories, relative to this worker's scope, that hold the simulation
 * engine rather than the shell.
 *
 * These are cached on first use, not at install. site/vendor/ngspice.js alone
 * is ~7 MB of base64 WASM, so putting it in shellUrls() would make every
 * visitor download the engine before they had asked to simulate anything --
 * which is why it was never there.
 *
 * It was not on the runtime route either, and that was the defect. The
 * application requests these files with fetch(), and a fetch() carries an
 * empty request.destination, so isStaticAsset() -- which matches on
 * destination -- declined them. The worker never stored them, and the engine
 * payload consequently sat outside this cache entirely. Running a simulation
 * offline still appeared to work, but only for as long as the browser's own
 * HTTP cache happened to hold a fresh copy of a 7 MB body: a ten-minute
 * window, under an eviction policy that is not ours to decide. Caching the
 * shell so that the editor opens offline, while leaving the engine to the
 * browser, makes the offline capability incidental rather than designed --
 * and an editor that opens but cannot simulate is not the offline experience
 * this worker exists to provide.
 *
 * A directory prefix is used instead of a file list so that a model file
 * added to models/ later is covered without a second change here.
 */
const ENGINE_PAYLOAD_DIRS = ["vendor/", "models/"];

function isEnginePayload(request) {
  const url = new URL(request.url);
  const scope = scopeUrl();
  if (url.origin !== scope.origin) return false;
  const scopePath = scope.pathname.replace(/\/?$/, "/");
  if (!url.pathname.startsWith(scopePath)) return false;
  const rel = url.pathname.slice(scopePath.length);
  return ENGINE_PAYLOAD_DIRS.some(
    (dir) => rel.startsWith(dir) && rel.length > dir.length,
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

/**
 * Static gallery shim.
 *
 * The Gallery panel reads four origin-root endpoints --
 *   /api/gallery                            list (+ ?author=, ?tags=, ?cursor=)
 *   /api/gallery/tags                       tag facets
 *   /api/gallery/<id>                       one entry, as projectText
 *   /api/gallery/<id>/preview.svg           the card image (revisioned)
 * -- and only a server can answer them. On this deploy there is no server, the
 * panel's fetch fails, the client degrades to `null`, and the gallery section
 * never renders. That is the whole of the gallery feature here: reachable code,
 * no reachable data.
 *
 * This route answers those four from files committed under <scope>gallery/:
 *
 *   gallery/index.json            { "entries": [ { id, name, author?,
 *                                   description?, tags?, previewRevision? } ] }
 *   gallery/<id>/project.json     the project payload, verbatim, as text
 *   gallery/<id>/preview.svg      the card image
 *
 * It is shipped with an EMPTY index on purpose, and that is a product decision
 * rather than an oversight. A non-empty list does not add a section to the
 * panel: the panel renders `showGallery ? galleryCards : builtinCards`, so any
 * entry at all replaces the built-in example list -- the student library plus
 * whatever the instructor unlock reveals. A static gallery therefore cannot be
 * "on" by default without either hiding the unlock flow or (if the locked labs
 * were listed here, since this path has no unlock check) bypassing it. An
 * operator who wants the panel populated drops a gallery/ directory in; the
 * default deploy keeps exactly the behaviour it shipped with.
 *
 * It ANSWERS rather than caches, which is why it sits before the isSameOriginApi
 * early return below instead of behind it. That branch deliberately leaves
 * /api/* to its own HTTP policy -- revisioned preview URLs exist so a changed
 * preview is never served under an old name -- and a shim that stored them in
 * the build-scoped shell cache would defeat exactly that. Nothing here touches
 * Cache Storage.
 */
const GALLERY_API = "/api/gallery";
// Ids become path segments, so they are matched against a closed shape before
// they are joined to anything. `../` cannot survive this test.
const GALLERY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function isGalleryApi(request) {
  const url = new URL(request.url);
  return (
    url.origin === scopeUrl().origin &&
    (url.pathname === GALLERY_API || url.pathname.startsWith(GALLERY_API + "/"))
  );
}

function galleryJson(body, status) {
  return new Response(JSON.stringify(body), {
    status: status ?? 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function galleryEntryView(entry) {
  const view = { id: entry.id, name: entry.name };
  if (typeof entry.author === "string") view.author = entry.author;
  if (typeof entry.description === "string") view.description = entry.description;
  if (Array.isArray(entry.tags)) {
    view.tags = entry.tags.filter((tag) => typeof tag === "string" && tag);
  }
  if (typeof entry.previewRevision === "string") {
    view.previewRevision = entry.previewRevision;
  }
  return view;
}

/** The committed index, with anything that is not a usable entry dropped. */
function readGalleryIndex() {
  return fetch(new URL("gallery/index.json", scopeUrl()).toString(), {
    cache: "no-store",
  })
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((body) => {
      const list = body && Array.isArray(body.entries) ? body.entries : [];
      return list.filter(
        (entry) =>
          entry &&
          typeof entry.id === "string" &&
          GALLERY_ID.test(entry.id) &&
          typeof entry.name === "string",
      );
    });
}

/** Tag facets, derived from the index the way a server would derive them. */
function galleryTags(entries) {
  const counts = new Map();
  for (const entry of entries) {
    for (const tag of Array.isArray(entry.tags) ? entry.tags : []) {
      if (typeof tag === "string" && tag) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([tag, count]) => ({ tag, count }));
}

function galleryApiResponse(request) {
  const url = new URL(request.url);
  const rest = url.pathname.slice(GALLERY_API.length);

  if (rest === "") {
    return readGalleryIndex().then((entries) => {
      const author = (url.searchParams.get("author") ?? "").trim().toLowerCase();
      const wanted = (url.searchParams.get("tags") ?? "")
        .split(",")
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);
      let list = entries;
      if (author) {
        list = list.filter((entry) =>
          String(entry.author ?? "").toLowerCase().includes(author),
        );
      }
      if (wanted.length > 0) {
        list = list.filter((entry) => {
          const held = (Array.isArray(entry.tags) ? entry.tags : []).map((tag) =>
            String(tag).toLowerCase(),
          );
          return wanted.every((tag) => held.includes(tag));
        });
      }
      return galleryJson({
        entries: list.map(galleryEntryView),
        nextCursor: null,
        total: list.length,
      });
    });
  }

  if (rest === "/tags") {
    return readGalleryIndex().then((entries) =>
      galleryJson({ tags: galleryTags(entries) }),
    );
  }

  const match = /^\/([^/]+)(\/preview\.svg)?$/.exec(rest);
  if (!match || !GALLERY_ID.test(match[1])) {
    return Promise.resolve(galleryJson({ error: "not-found" }, 404));
  }
  const id = match[1];

  if (match[2]) {
    return fetch(new URL("gallery/" + id + "/preview.svg", scopeUrl()).toString(), {
      cache: "no-store",
    })
      .then((response) =>
        response.ok
          ? new Response(response.body, {
              status: 200,
              headers: { "content-type": "image/svg+xml; charset=utf-8" },
            })
          : new Response("", { status: 404 }),
      )
      .catch(() => new Response("", { status: 404 }));
  }

  return readGalleryIndex()
    .then((entries) => {
      const entry = entries.find((candidate) => candidate.id === id);
      if (!entry) return null;
      return fetch(new URL("gallery/" + id + "/project.json", scopeUrl()).toString(), {
        cache: "no-store",
      })
        .then((response) => (response.ok ? response.text() : null))
        .catch(() => null)
        .then((projectText) =>
          projectText === null
            ? null
            : galleryJson({
                projectText,
                entry: {
                  name: entry.name,
                  author: entry.author ?? "",
                  description: entry.description ?? "",
                  tags: Array.isArray(entry.tags) ? entry.tags : [],
                },
                ownerUserId: null,
              }),
        );
    })
    .then((response) => response ?? galleryJson({ error: "not-found" }, 404));
}
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  // APIs own their own HTTP caching policy. In particular, Gallery previews
  // use revisioned URLs; putting them in the build-scoped shell cache would
  // ignore that policy and keep an old or access-controlled image alive.
  // The gallery shim answers the four endpoints the panel calls, and only those.
  // Every other /api/ path still falls through to the early return below, where
  // the API is left to its own HTTP policy.
  if (isGalleryApi(event.request)) {
    event.respondWith(galleryApiResponse(event.request));
    return;
  }

  if (isSameOriginApi(event.request)) return;

  // Navigation is network-first so a deployed build can replace index.html and
  // point at its fresh, content-hashed Vite assets. Offline falls back only to
  // the known shell, never to a Project or arbitrary cached request.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.ok) {
            // Clone while this body is still ours. respondWith() hands the
            // response to the client, so a clone taken any later -- inside the
            // caches.open() callback, say -- throws "Response body is already
            // used", which is exactly what this branch used to do.
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(scopeUrl(), copy));
          }
          return response;
        })
        .catch(() => caches.match(scopeUrl())),
    );
    return;
  }

  // Only same-origin static assets are cached. This intentionally excludes
  // arbitrary GETs, imported files, Project downloads, and future APIs. The
  // engine payload is a same-origin GET whose destination is empty because it
  // arrives by fetch() rather than by a resource tag, so it is matched by path
  // instead -- see isEnginePayload().
  if (
    (isStaticAsset(event.request) || isEnginePayload(event.request)) &&
    new URL(event.request.url).origin === scopeUrl().origin
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request).then((response) => {
          if (response.ok && servesWhatWasAsked(event.request, response)) {
            // Clone while this body is still ours -- see the navigation branch
            // above. Until this was hoisted out of the callback, every put from
            // this route threw "Response body is already used"; the promise was
            // fire-and-forget, so the rejection went nowhere and the whole route
            // silently stored nothing. The only entries this cache ever held
            // were the ones install() added via shellUrls().
            const copy = response.clone();
            void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
          }
          return response;
        });
      }),
    );
  }
});
