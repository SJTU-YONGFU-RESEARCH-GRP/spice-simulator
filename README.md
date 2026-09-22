# SPICE Simulator (schematic editor)

Public GitHub Pages host for the Vite schematic editor  
(local: `http://127.0.0.1:5173/` from the editor source tree).

**Site:** https://sjtu-yongfu-research-grp.github.io/spice-simulator/

## Develop

```bash
cd /mnt/d/proj/analog-canvas-js   # or spice-simulator-editor after rename
pnpm install
pnpm --filter @icm/editor dev
```

## Publish

```bash
cd /mnt/d/proj/spice-simulator
./scripts/publish-editor-pages.sh
./scripts/release.sh          # optional version tag
```

## Layout

| Path | Role |
|---|---|
| `site/` | Built editor (Pages) |
| `scripts/publish-editor-pages.sh` | Build + commit `site/` |
| `scripts/release.sh` | Semver tag + GitHub Release |
| `docs/` | Dual-repo / lab notes |

Legacy vanilla MNA simulator code has been removed from this repository.

## Verify

`site/` is a checked-in build, so the checks that would normally run against
source have to run against the artifact instead. None of them need the editor
checkout or a package install:

```bash
node scripts/check-artifacts.mjs --accept=scripts/known-deviations.json
node scripts/smoke-test.mjs --require
node scripts/storage-resilience.mjs --require
node scripts/numeric-crosscheck.mjs
node scripts/numeric-crosscheck.negctl.mjs
node scripts/egress-integrity.mjs
node scripts/outbound-repair.negctl.mjs
node scripts/csp-conformance.mjs --require
node scripts/csp-conformance.mjs --self-test --require
node scripts/csp-guard.negctl.mjs
node scripts/offline-sim.mjs --require
node scripts/sw-cache.negctl.mjs --static-only
node scripts/precache-weight.mjs --require
node scripts/precache-budget.negctl.mjs --static-only
node scripts/example-outcomes.mjs --require
node scripts/example-outcomes.negctl.mjs --require
node scripts/shell-cache.mjs
node scripts/shell-cache.negctl.mjs --static-only
node scripts/corner-sweep.negctl.mjs
node scripts/spice-import.mjs --require
node scripts/spice-import.negctl.mjs
node scripts/gallery-shim.mjs --require
node scripts/gallery-shim.negctl.mjs
```

or `npm run check:artifacts` / `npm run smoke` / `npm run check:storage` /
`npm run check:numeric` / `npm run check:numeric:neg` / `npm run check:egress` /
`npm run check:egress:neg` / `npm run check:csp` / `npm run check:csp:neg` /
`npm run check:offline` / `npm run check:offline:neg:static` /
`npm run check:precache` / `npm run check:precache:neg:static` /
`npm run check:examples` / `npm run check:examples:neg` /
`npm run check:identity` / `npm run check:identity:neg:static` /
`npm run check:shellcache` / `npm run check:shellcache:neg:static` /
`npm run check:corner` / `npm run check:corner:neg` /
`npm run check:import` / `npm run check:import:neg:static` /
`npm run check:gallery` / `npm run check:gallery:neg:static`.

`npm run audit:ux` is **not a guard** and never fails a build. It walks the
flows a person takes -- the home page, the Gallery panel at both unlock tiers,
each built-in example's title bar, an edit, the refusal surface, an offline
reload -- and prints the *text* each surface renders, then grades what it found.
It exists because a UX defect can pass every guard: the project-identity bug
loaded, rendered, and ran, and only said the wrong circuit name. Two of its
first findings were the audit's own mistakes, and both are written into it as
comments: `requiresUnlock:!0` means **true** (reading it as `=== '1'` inverts
every gate and calls a correct gate a missing list), and the `?example=<id>`
deep link **re-seeds** the lab on every load by design, so a rename not
surviving a reload is the loader doing its job rather than a persistence bug.

`npm run bump:shellcache` rewrites `sw.js`'s cache constant from the artifact.
Run it after any change to `site/`; check 13 fails the build if you forget.

`npm run patch:corner` re-plays `scripts/corner-sweep.json` through the same
manifest-driven patcher as the other repairs. The corner sweep is the one repair
that also writes a **model library** (`site/models/cmos.lib`), so it is the only
patch that needs `bump:shellcache` to run after it — a model card is inside
`ENGINE_PAYLOAD_DIRS` and therefore inside the derived token.

`npm run patch:import` re-plays `scripts/import-libs.json`, which makes the model
libraries this build ships resolve from a netlist imported through the File menu.
Both repairs are insertions into `App-*.js`, so each declares a **marker** — a
string that is absent before the repair and present exactly once after — because
the patcher's default idempotence test ("the replacement is present and the
anchor is gone") only settles an edit that consumes its anchor. That patch grows
the chunk, which shifts the byte offsets the storage acceptances in
`scripts/known-deviations.json` are keyed by; those were re-derived, and check 10
is what says so if they are not.

`npm run patch:gallery` re-plays `scripts/gallery-shim.json` the same way: both
repairs are insertions, each declares a marker, and here too the marker only says
the bytes are *there* — an insertion keeps its anchor, so "replacement present,
anchor gone" can never settle and a marker is the only idempotence test available.
Neither channel is allowed to stop at that, which is why check 16 asserts the
dispatch is **called** and `gallery-shim.negctl.mjs` carries the mutant that keeps
every string of a working shim and kills the route anyway. Unlike the import patch
this one does not grow anything the shell cache hashes, so it needs no token bump
(see the C3 section below for what the shim does and what it deliberately does not).

`npm run patch:identity` re-plays `scripts/example-identity.json`, in two parts.
**Data**: three of the five built-in labs stored the project factory's placeholder
identity (`id:project-main` / `name:New Circuit`) instead of their own. The title
bar renders the project's own name, so a user who chose "Two-Stage Op Amp" read
"New Circuit" as the circuit they were editing. Those three payloads now carry
their catalog id and name. **Display**: `og()`, the single `id -> project`
boundary the catalog resolves through, returned the stored name unchanged; it now
overwrites it with the catalog's name, which is what the Gallery path already did
(`u.entry?.name ?? d.name`). The two halves are checked independently — check 17
reads the stored identity out of the chunk and refuses a placeholder, while
`example-outcomes.mjs` drives the page and asserts the title bar shows the catalog
name — so a data-only fix (resolver still able to pass a future payload's
placeholder through) and a display-only fix (stored data still wrong) each fail on
their own half. `example-identity.negctl.mjs` walks three mutations, including one
that renames every payload to the *same* wrong string: a rule written as "differs
from the catalog" would pass that tree, and the rendered-name assertion must not.

This patch changes bytes in an early part of `App-*.js`, which shifts every byte
offset after it — including the seven storage acceptances in
`scripts/known-deviations.json`, whose keys are `rel@offset`. They were re-derived
here too. That is the third time a patch has had to do this, which is why the
offsets are worth replacing with a content-derived key; until then, any patch that
grows this chunk owes the same re-derivation, and check 10 reports the drift as
stale acceptances rather than silently.

The process-corner sweep is **teaching-grade**: `tt`/`ss`/`ff` scale the
Level-1 (Shichman–Hodges) parameters of `site/models/cmos.lib` by a made-up
spread, so a student can see *which way* a bias point moves between corners.
It is not SKY130 and not any foundry corner, and it is deliberately not wired
to the `sky130` service — that executor advertises no corners and is served
outside this static site (see `docs/REPO_LAYOUT.md`). The library's own header
says the same thing at the point of use.

The sweep is applied with a **parameter selector**, not `.lib` sections. The
deck includes the library with `.include`, and the executor writes
`ngbehavior=lt` into `spinit`; under that behaviour ngspice rewrites a
sectioned `.lib` into a plain include of the whole file plus an include of the
section name *as a filename*, so sectioned libraries cannot work here at all.
Re-declaring a `.model` from below is no better — ngspice keeps the first
definition and says nothing. A `.param` the deck redefines *after* the include
does work, because parameters are last-wins where models are first-wins. So the
deck writes `.param __cn_sel=<selector>` for the non-typical corners only, and
the library expresses each spread as an expression over `__cn_sel`. The typical
corner (`__cn_sel = 0`) reproduces the device set that shipped before the
feature, to within 1.9e-13 relative — an artifact of `{}`-braced parameters
reaching ngspice's expression evaluator instead of its literal parser, twelve
orders of magnitude below the smallest corner shift. Both halves are pinned:
check 14 (above) ties the advertised list to the emitter and the library, and
`numeric-crosscheck.mjs` runs the three corners plus the frozen device set in
the shipped engine.

`npm run check:corner` selects those cases with `--only=corner_default,corner_ss,
corner_ff,corner_frozen`. The two further corner claims —
`corner_default_matches_frozen` and `corner_shifts_every_device` — are
**cross-assertions** (they declare `needs:` and are evaluated whenever their
prerequisites run), not named cases, so asking `--only` for them matched nothing
and the harness exited 2. Naming only the four real cases runs the whole corner
group: cases=6, assertions=15.

Two more libraries ship in `site/models/` — `cap.lib` (role capacitors: `cout`,
compensation, bypass, MIM/MOM tags) and `opamp.lib` (behavioural `opamp_se` /
`opamp_diff` with `av0`/`gbw`/`rin`/`rout`/`vos`/`acm`/`swing`). Their headers
tell a netlist to include them, and `numeric-crosscheck.mjs` **runs** them,
because nothing ever had: the results are correct to the closed forms.

Importing such a netlist is the File menu's **Import SPICE** control — a plain
`<input type="file" multiple>`, and the only channel files can enter through
(`webkitdirectory` occurs nowhere in the build). A flat selection arrives with an
empty `webkitRelativePath`, so the importer falls back to `File.name`, while the
include resolver refuses anything that climbs above `dirname(entry)` — which for
a flat name is empty. Measured in a browser before the repair landed:

| include in the netlist | before | now |
|---|---|---|
| `.include cap.lib`, `cap.lib` also selected | imports | imports |
| `.include ../models/cap.lib` — what both headers teach | **refused: escapes the selected source root** | imports |
| `.include cap.lib`, nothing else selected | **refused: not selected or found** | imports |
| a library this build does not ship | refused | refused |
| `/usr/share/cap.lib` (not a local path) | refused | refused |

`scripts/import-libs.json` closes that: the shipped libraries join the pool handed
to the importer's decoder, and a *relative* include whose strict resolution failed
is retried by filename against that pool. Absolute and URL includes are still
refused — the last two rows above are the tests that say so, and
`spice-import.mjs` is what measures them in a browser. The trade is explicit and
**is** a behaviour change: when a netlist includes a library you did not supply,
the bundled one is used. If that library defines a different device under the same
subcircuit name, the run is not the one your netlist intended; the alternative was
a hard refusal, and the libraries are the ones this build calls educational.

Two things are still not reachable here, and the green above is not about them.
The simulator's filesystem is populated from a single hardcoded library path, and
the one code path that runs a user's own deck verbatim (`mode: 'raw'`) is not
constructible from this deploy — every setup is built as `structured`, and
imported SPICE becomes a project rather than a deck. Background and the paths
that were ruled out are in
`analysis/SPICE-Simulator-创新性产品改进评估-C2-2026-09-22.md`; the change itself,
with the measured before/after matrix and both mutants, is in
`analysis/SPICE-Simulator-创新性产品改进-C2b-导入可达性-2026-09-22.md`. It is labelled
C2b, not C3, because it is the **reachable half of C2** (the feasibility list's C2 is
"make `cap.lib`/`opamp.lib` reachable") rather than the next item on that list — whose
C3 is the unrelated service-worker Gallery shim.

That C3 is what `npm run patch:gallery` is. The Gallery panel reads four endpoints at
the **origin root** — `/api/gallery`, `/api/gallery/tags`, `/api/gallery/<id>` and
`/api/gallery/<id>/preview.svg` — and only a server can answer them, so on this static
deploy its fetches fail, the client degrades to `null`, and the gallery section never
renders. `scripts/gallery-shim.json` routes those four through the service worker to
files committed under `<scope>gallery/`, which makes the panel usable read-only.

It is worth being exact about why that works, because the obvious reading says it
cannot: the worker is registered with `scope: /spice-simulator/` while `/api/gallery…`
is at the origin root, i.e. out of scope. **Scope decides which clients a worker
controls, not which of their requests it observes.** A fetch made by a controlled page
fires the worker's `fetch` event whatever the request URL, and `respondWith()` on an
out-of-scope request is honoured. That was not reasoned out, it was measured —
`gallery-shim.mjs` is the measurement — and the same file records it so the next reader
does not have to re-derive it.

The shim **ships with an empty index**, and that is a product decision rather than an
oversight. The panel renders `showGallery ? galleryCards : builtinCards`, so a non-empty
gallery does not *add* a section — it **replaces** the built-in example list, which is
the student library plus whatever the instructor unlock reveals. This route has no
unlock check, so listing the locked labs there would not merely hide that gate, it would
bypass it. An operator who wants the panel populated drops a `gallery/` directory in:

```text
site/gallery/index.json          { "entries": [ { "id": "...", "name": "...",
                                   "author"?: "...", "description"?: "...",
                                   "tags"?: ["..."], "previewRevision"?: "..." } ] }
site/gallery/<id>/project.json   the project payload, verbatim, as text
site/gallery/<id>/preview.svg    the card image
```

`<id>` is shape-checked (`^[a-z0-9][a-z0-9._-]{0,63}$`) before it is ever joined into a
path, and the shim **answers rather than caches**: it sits in front of the branch that
deliberately keeps `/api/*` out of the build-scoped shell cache, because a revisioned
preview URL that gets stored under one revision and served under the next is exactly the
stale-image bug that branch exists to prevent. Two things follow from "answers only":
the empty index is not a *repair* — the four endpoints stop being 404s, which
`gallery-shim.mjs` requires even on the shipped tree — and a populated gallery is a real
behaviour change, not an additive one.

`npm run bump:shellcache` is **not** needed after this patch: `sw.js` itself is not among
the bytes the worker route stores, so the derived token does not move. Check 16 is what
says so if that ever changes.

The scope lesson is the transferable half: "the worker is registered under X, so it cannot
answer Y" is a claim about *reachability*, and reachability claims here are settled by
driving the product (see also the C2 conclusion above, where a capability that exists in
the artifact is unreachable from this deploy, and the `sky130` executor, which is served
outside this site).

`npm run preview` serves with `Cache-Control: no-store`, which is what you want
while editing the artifact but which also stops the service worker from caching
anything — so a preview cannot tell you whether the worker works. Pass
`--cache=public` to reproduce the deploy's headers when that is the question.

| Check | Question it answers |
|---|---|
| `check-artifacts.mjs` | Is the bundle self-consistent — do its references resolve, is there no development JSX runtime or folded-`undefined` call site, is every network target in the tree classified, is every storage read inside a `try`/`catch`, does the shell still carry its Content-Security-Policy, does `sw.js` still have the shape its caching needs, does the worker's atomic install payload fit its budget, does the constant it opens its cache under still describe this tree, does the corner set the panel offers match the model library that has to answer it, and does an imported netlist still resolve the model libraries this build ships (including that the text embedded in the chunk is still the bytes of `site/models/*.lib` and that the injected pool is called rather than merely present)? It also holds the static gallery shim to its contract: both insertions present, the dispatch **before** the `/api/` early return that would otherwise swallow it (a defined-but-dead route passes every string test), the entry id shape-checked before it becomes a path segment, no Cache Storage access in a region that must only answer, and every key the shipped client reads still written by an object literal passed to `galleryJson()` — where renaming `entries:` to `items:` leaves the identifier `entries` all over the index reader and so defeats a substring test. |
| `smoke-test.mjs` | Does the editor actually run — does a real simulation finish with zero uncaught errors? |
| `storage-resilience.mjs` | Does the editor still render in a browser that **denies** storage? Loads the home page and an `?example=` deep link with `localStorage`/`sessionStorage` replaced by throwing getters — the failure mode of Safari private mode, blocked site data and partitioned iframes — and requires the editor, not the crash screen. |
| `numeric-crosscheck.mjs` | Are the numbers **right** — does the shipped WASM agree with first-principles closed forms and with model-independent invariants (including for BSIM3/BSIM4, which have no closed form)? It also runs the two **role libraries** the deploy ships (`cap.lib`, `opamp.lib`): an ideal capacitor must be an open circuit at dc and charge with `tau = R*C`, and `opamp_se` must follow its soft-rail tanh transfer behind the series `Rout`. |
| `numeric-crosscheck.negctl.mjs` | Would the numeric guard **notice** if it broke? Mutates the guard and the deck, and (for the corner and role-library groups) the **artifact's own library files**, and requires every mutant to fail — while the mutant that makes the corner selector inert must leave "the default still matches the frozen device set" green, so the two cross-checks are shown to be independent rather than two names for one claim. |
| `egress-integrity.mjs` | Does the third-party engine fallback actually **verify** what it downloads? Lifts the loader and hash helper out of the shipped chunk and runs them, including a tampered payload that must be refused *and never executed*. |
| `outbound-repair.negctl.mjs` | Would the outbound checks **notice** if they broke? Nine cases, incl. two controls, against deliberately weakened copies. |
| `csp-conformance.mjs` | Is the shell's Content-Security-Policy **enforced** and does it leave the editor working? Boots the page, opens an example and runs a simulation under the shipped policy, requiring zero violations — after first proving the violation collector can see one (`--self-test` serves a deliberately violating page and requires both the violation to be observed and the injected code never to run). |
| `csp-guard.negctl.mjs` | Would check 11 **notice** if it broke? Twelve cases against mutated copies of the real shell — a missing policy, a hand-edited policy, two shells that disagree, an inline script edited without updating its hash, `'unsafe-eval'`/`'unsafe-inline'`/`*` added to script-src, a dropped directive, an empty document list and an unaudited origin — each required to produce its own finding. |
| `offline-sim.mjs` | Can the worker do its job? Serves the artifact with deploy-like cache headers, warms a simulation, then turns the network **and** the HTTP cache off — on the page and on the worker — and requires a second simulation to finish. Only Cache Storage can serve the 6.88 MB engine under those conditions. |
| `sw-cache.negctl.mjs` | Would that test **notice**? Re-introduces the two defects that made the worker cache nothing (a response cloned inside the `caches.open()` callback; the engine unrouted because its `fetch()` has an empty `destination`) and requires **both** channels to catch them: check 12 names each defect, and `offline-sim.mjs` fails. `--static-only` runs just the source-level half, without a browser. |
| `precache-weight.mjs` | How big is the install payload **in a browser**? `install()` runs `cache.addAll(shellUrls())`, which every first-time visitor downloads in full before the editor works offline — and which aborts the install outright if one member fails. This loads the app, reads the shell cache back, sums what is really stored, compares each entry against its file on disk, holds the total to `scripts/precache-budget.json`, and requires the cache the browser opened to be the name `scripts/shell-cache.mjs` derives — the static half of check 13 cannot see whether the worker opened it. |
| `precache-budget.negctl.mjs` | Would the install-budget check **notice**? Three mutants — `logo.png` replaced by a real 512×512 PNG, the 512 px manifest icon re-declared in `shellUrls()`, and a precache target deleted (where `addAll()`'s atomicity aborts the install) — each required to be caught by **both** channels: check 5 names it, and `precache-weight.mjs` fails. `--static-only` runs without a browser. |
| `example-outcomes.mjs` | Do the built-in examples do what the catalog says? Walks every catalog entry. Expectations are computed from the shipped chunks — the catalog, each payload's setup list, and the browser executor's advertised profiles — and then checked against the page the product renders, so the two sides are independent. An example with no setups must offer nothing to run; one whose profile is advertised must complete and render; one whose profile is not must carry a `(unavailable)` warning **before** the run and then refuse with a structured problem, drawing no plots. The sweep requires both a completion and a refusal to appear, because a harness that has only ever seen one of them cannot tell an honest refusal from a dead run. |
| `example-outcomes.negctl.mjs` | Would that check **notice**? Six mutants — the pre-run warning removed, the unavailable profile declared as available, the runnable lab's model card deleted, the Run control made unaddressable, a catalog entry pointing at a payload that does not exist, and the only un-runnable lab removed from the catalog — each required to turn the check red for its own stated reason. The control case runs first: if it is not green, nothing else in the file means anything. |
| `spice-import.mjs` | Can a user actually get a netlist in, and what happens to its `.include` lines? Clicks the real **Import SPICE** label in a real browser with file-chooser interception on, and requires Chrome to report the chooser event before it hands any files over — so "the control is drivable through the picker a user would use" is asserted, not assumed. Then it reads the product's own sentence back: four spellings (no includes, a bare name with the library selected, the `../models/<lib>` form both library headers teach, the bare name with nothing selected) must import, and two controls must still refuse — a library this build does not ship, and `/usr/share/cap.lib`, which is deliberately a name the pool holds so that relaxing the local-only rule turns it green. |
| `spice-import.negctl.mjs` | Would that guard **notice**? Two mutants against real copies, each pinning one half of the repair: emptying the pool must turn exactly `bare-unselected` red while `header-form` stays green — the user selected that file, so the fallback found it and the pool was never needed, and a mutant that took both down would not tell the two mechanisms apart — and deleting the local-only guard must turn exactly `absolute-include` red. Both channels are required to see each mutant, with `check 15` naming it: the static side catches a pool that is present but never wired, which a browser run cannot distinguish from one that is simply empty. `--static-only` runs without a browser and first requires check 15 to be silent on the unmutated tree. |
| `gallery-shim.mjs` | Can the Gallery panel work on a static deploy? Drives the panel in a real browser on two trees. On the committed tree the gallery must stay **dark** — the built-in example card is what a student sees — while the two list endpoints stop being 404s, because a shim that lit the panel up here would be replacing the example list rather than adding to it. On a copy with a two-entry `gallery/` the panel must **light**: the search box and tag menu appear, the cards render, the tag facets carry the right counts, the preview image loads from its revisioned URL, and clicking a card opens the circuit through `/api/gallery/<id>`. That last step is the half a list-only test misses. The fixture's project payload is lifted out of the shipped chunk and evaluated rather than hand-written, so the schema under test is the product's, not my reading of it. It first had to falsify the natural reading of the worker's scope (see above) — that is why it exists at all. |
| `gallery-shim.negctl.mjs` | Would that guard **notice**? Ten cases against real copies, including two controls (an unmutated tree, and the same tree with the manifest reversed), and the case the whole check exists for: `route-after-api-return` moves the dispatch behind `if (isSameOriginApi(...)) return;` — every string the shim consists of is still present exactly once, a text search finds a perfectly healthy shim, and the four endpoints are 404s. Nothing but an ordered assertion, or a browser, can see it. The rest are surgical in the other direction: removing the dispatch turns **both** browser cases red, while renaming the list key or moving only the preview path must turn exactly the **populated** tree red and leave the shipped tree green — a mutant that took both down would not tell "this key broke" apart from "the shim broke outright". Three cases declare themselves **static-only** and say why: no fixture supplies a hostile id, so the id guard's failure surface is not observable in either browser case, and the static assertion is its control rather than a claim the browser also makes. `--static-only` runs the whole suite without a browser. |
| `shell-cache.mjs` | Does the constant `sw.js` opens its cache under still describe **this tree**? Upstream's build injects a digest of the emitted asset graph there, and that injection is what lets a deploy retire a stale shell. This repository does not run that build: every repair is a hand-patch that *keeps* the filename the content hash is supposed to police, and the static route is cache-first with no revalidation — so a stale constant hides the repair from every returning client for good. The token is therefore **derived, not chosen**: a SHA-256 over the bytes these routes could store — the `shellUrls()` members, every extension a resource tag can request, and everything under `ENGINE_PAYLOAD_DIRS` — plus those two declarations, because they decide which of those URLs are stored. A file the worker can never be asked for (a licence text, a release manifest) is deliberately *not* hashed: it cannot go stale in anyone's cache. `--write` restores it; `--check` (the default) reports. |
| `shell-cache.negctl.mjs` | Would check 13 **notice**? Nine mutants — a chunk patched while its content-hashed filename stays, a model card patched (in scope only through `ENGINE_PAYLOAD_DIRS`), the constant set by hand instead of derived, the constant deleted, `activate()`'s retirement prefix narrowed so no old shell is ever dropped, a directory added to `ENGINE_PAYLOAD_DIRS`, a member dropped from `shellUrls()`, `install()` re-pointed at a cache name outside the prefix, and a file added that this worker can never be asked for (which must **not** move the token, pinning the scope) — each required to produce its own outcome. Both channels run, and neither contains the other: `activate-filter-narrowed` requires the runtime channel to *pass* (the retirement rule is static-only), while `install-cache-renamed` leaves the static guard **completely green** — the constant and both declarations are untouched — and only the browser can report it. `--static-only` runs without a browser. |
| `corner-sweep.negctl.mjs` | Would the corner feature **notice** if it broke? Fifteen cases against real patched copies: a control, the unpatched tree, the capability's corner list emptied or re-ordered, the selector emission dropped, mapped to the wrong value, given an extra branch, or having the typical corner map to a non-zero selector, the emitted `.param` renamed, the descriptor or the run record stripped, the library's base model moved or a device left unmodelled, a manifest that declares a corner the artifact does not implement, and a manifest that is vacuous. Each must turn check 14 red for its own named reason. The runtime half is pinned by `numeric-crosscheck.negctl.mjs`'s `corner_inert` mutant, which edits the **shipped library** so it stops answering the selector: `corner_shifts_every_device` must fail while `corner_default_matches_frozen` stays green — a guard that only ever saw one of those two outcomes could not tell a live sweep from a dead one. |

All of these run in CI: the source-level checks on the deploy job, before `site/`
is published; the browser checks on the `smoke` job.

Every outbound target the artifact can reach is inventoried in
`scripts/outbound-manifest.json`, with the evidence that classified it. A URL
that is not in that file fails the guard, so a rebuild that adds a host or
re-points a CDN cannot be published unreviewed. Two of the entries are
`reachable: false` on purpose — they record a URL that was read in context and
ruled out, which is the half of the audit that stops the next reader from
re-deriving the same wrong conclusion.

`site/index.html` and `site/404.html` carry the deploy shell's
Content-Security-Policy, declared in `scripts/shell-csp.json`. The directive set
was derived by measurement, not from a template: it names `'self'` for the app's
own chunks, `'wasm-unsafe-eval'` for the engine, `blob:` for the worker and the
CDN fallback, and `https://cdn.jsdelivr.net` — the one origin, which the outbound
manifest already classifies. `script-src` deliberately does **not** grant
`'unsafe-eval'` or `'unsafe-inline'`, and check 11 fails the build if either
appears. Two consequences worth knowing: the inline theme bootstrap is approved
by a hash re-derived from the document on every run, and the policy raises the
browser floor to Chrome 97 / Firefox 102 / Safari 16, because that is when
`wasm-unsafe-eval` arrived.

`node scripts/patch-outbound.mjs` repairs the outbound surface (the public
feedback link, and the integrity pin on the CDN fallback) and prints the new
`site/sw.js` cache value; `--check` reports without writing. The script is
manifest-driven — `--manifest=<file>` applies whatever repair set that file
declares, which is how the storage guards (`npm run patch:storage`) and the shell
policy (`npm run patch:csp`) are applied.

Deviations that are known and attributable live in
`scripts/known-deviations.json`; they are printed with their reason, never
silently skipped, and an entry that stops matching is reported as a finding.

## Private lab

Issues: [`spice-simulator-lab`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab)

## License

Shipped UI is a SPICE Simulator build derived from SPICE Simulator (AGPL). See `site/LICENSE.md` / `site/NOTICE.md`.
