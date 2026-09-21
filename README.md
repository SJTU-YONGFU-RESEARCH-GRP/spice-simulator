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
```

or `npm run check:artifacts` / `npm run smoke` / `npm run check:storage` /
`npm run check:numeric` / `npm run check:numeric:neg` / `npm run check:egress` /
`npm run check:egress:neg` / `npm run check:csp` / `npm run check:csp:neg` /
`npm run check:offline` / `npm run check:offline:neg:static` /
`npm run check:precache` / `npm run check:precache:neg:static` /
`npm run check:examples` / `npm run check:examples:neg` /
`npm run check:shellcache` / `npm run check:shellcache:neg:static` /
`npm run check:corner` / `npm run check:corner:neg`.

`npm run bump:shellcache` rewrites `sw.js`'s cache constant from the artifact.
Run it after any change to `site/`; check 13 fails the build if you forget.

`npm run patch:corner` re-plays `scripts/corner-sweep.json` through the same
manifest-driven patcher as the other repairs. The corner sweep is the one repair
that also writes a **model library** (`site/models/cmos.lib`), so it is the only
patch that needs `bump:shellcache` to run after it — a model card is inside
`ENGINE_PAYLOAD_DIRS` and therefore inside the derived token.

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

Two more libraries ship in `site/models/` — `cap.lib` (role capacitors: `cout`,
compensation, bypass, MIM/MOM tags) and `opamp.lib` (behavioural `opamp_se` /
`opamp_diff` with `av0`/`gbw`/`rin`/`rout`/`vos`/`acm`/`swing`). Their headers
tell a netlist to include them, and `numeric-crosscheck.mjs` now **runs** them,
because nothing ever had: the results are correct to the closed forms. What the
app cannot do is **reach** them — the simulator's filesystem is populated from a
single hardcoded library path, and the one code path that runs a user's own deck
verbatim (`mode: 'raw'`) is not constructible from this deploy, which builds
every simulation setup as `structured` and imports SPICE into a project rather
than into a deck. So the two libraries are source material for a netlist you
import yourself, not a library the app offers. Do not read the green as "the
feature works"; see `analysis/SPICE-Simulator-创新性产品改进评估-C2-2026-09-22.md`.

`npm run preview` serves with `Cache-Control: no-store`, which is what you want
while editing the artifact but which also stops the service worker from caching
anything — so a preview cannot tell you whether the worker works. Pass
`--cache=public` to reproduce the deploy's headers when that is the question.

| Check | Question it answers |
|---|---|
| `check-artifacts.mjs` | Is the bundle self-consistent — do its references resolve, is there no development JSX runtime or folded-`undefined` call site, is every network target in the tree classified, is every storage read inside a `try`/`catch`, does the shell still carry its Content-Security-Policy, does `sw.js` still have the shape its caching needs, does the worker's atomic install payload fit its budget, does the constant it opens its cache under still describe this tree, and does the corner set the panel offers match the model library that has to answer it? |
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
