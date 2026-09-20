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
```

or `npm run check:artifacts` / `npm run smoke` / `npm run check:storage` /
`npm run check:numeric` / `npm run check:numeric:neg` / `npm run check:egress` /
`npm run check:egress:neg` / `npm run check:csp` / `npm run check:csp:neg` /
`npm run check:offline` / `npm run check:offline:neg:static` /
`npm run check:precache` / `npm run check:precache:neg:static` /
`npm run check:examples` / `npm run check:examples:neg`.

`npm run preview` serves with `Cache-Control: no-store`, which is what you want
while editing the artifact but which also stops the service worker from caching
anything — so a preview cannot tell you whether the worker works. Pass
`--cache=public` to reproduce the deploy's headers when that is the question.

| Check | Question it answers |
|---|---|
| `check-artifacts.mjs` | Is the bundle self-consistent — do its references resolve, is there no development JSX runtime or folded-`undefined` call site, is every network target in the tree classified, is every storage read inside a `try`/`catch`, does the shell still carry its Content-Security-Policy, does `sw.js` still have the shape its caching needs, and does the worker's atomic install payload fit its budget? |
| `smoke-test.mjs` | Does the editor actually run — does a real simulation finish with zero uncaught errors? |
| `storage-resilience.mjs` | Does the editor still render in a browser that **denies** storage? Loads the home page and an `?example=` deep link with `localStorage`/`sessionStorage` replaced by throwing getters — the failure mode of Safari private mode, blocked site data and partitioned iframes — and requires the editor, not the crash screen. |
| `numeric-crosscheck.mjs` | Are the numbers **right** — does the shipped WASM agree with first-principles closed forms and with model-independent invariants (including for BSIM3/BSIM4, which have no closed form)? |
| `numeric-crosscheck.negctl.mjs` | Would the numeric guard **notice** if it broke? Mutates the guard and the deck and requires every mutant to fail. |
| `egress-integrity.mjs` | Does the third-party engine fallback actually **verify** what it downloads? Lifts the loader and hash helper out of the shipped chunk and runs them, including a tampered payload that must be refused *and never executed*. |
| `outbound-repair.negctl.mjs` | Would the outbound checks **notice** if they broke? Nine cases, incl. two controls, against deliberately weakened copies. |
| `csp-conformance.mjs` | Is the shell's Content-Security-Policy **enforced** and does it leave the editor working? Boots the page, opens an example and runs a simulation under the shipped policy, requiring zero violations — after first proving the violation collector can see one (`--self-test` serves a deliberately violating page and requires both the violation to be observed and the injected code never to run). |
| `csp-guard.negctl.mjs` | Would check 11 **notice** if it broke? Twelve cases against mutated copies of the real shell — a missing policy, a hand-edited policy, two shells that disagree, an inline script edited without updating its hash, `'unsafe-eval'`/`'unsafe-inline'`/`*` added to script-src, a dropped directive, an empty document list and an unaudited origin — each required to produce its own finding. |
| `offline-sim.mjs` | Can the worker do its job? Serves the artifact with deploy-like cache headers, warms a simulation, then turns the network **and** the HTTP cache off — on the page and on the worker — and requires a second simulation to finish. Only Cache Storage can serve the 6.88 MB engine under those conditions. |
| `sw-cache.negctl.mjs` | Would that test **notice**? Re-introduces the two defects that made the worker cache nothing (a response cloned inside the `caches.open()` callback; the engine unrouted because its `fetch()` has an empty `destination`) and requires **both** channels to catch them: check 12 names each defect, and `offline-sim.mjs` fails. `--static-only` runs just the source-level half, without a browser. |
| `precache-weight.mjs` | How big is the install payload **in a browser**? `install()` runs `cache.addAll(shellUrls())`, which every first-time visitor downloads in full before the editor works offline — and which aborts the install outright if one member fails. This loads the app, reads the shell cache back, sums what is really stored, compares each entry against its file on disk, and holds the total to `scripts/precache-budget.json`. |
| `precache-budget.negctl.mjs` | Would the install-budget check **notice**? Three mutants — `logo.png` replaced by a real 512×512 PNG, the 512 px manifest icon re-declared in `shellUrls()`, and a precache target deleted (where `addAll()`'s atomicity aborts the install) — each required to be caught by **both** channels: check 5 names it, and `precache-weight.mjs` fails. `--static-only` runs without a browser. |
| `example-outcomes.mjs` | Do the built-in examples do what the catalog says? Walks every catalog entry. Expectations are computed from the shipped chunks — the catalog, each payload's setup list, and the browser executor's advertised profiles — and then checked against the page the product renders, so the two sides are independent. An example with no setups must offer nothing to run; one whose profile is advertised must complete and render; one whose profile is not must carry a `(unavailable)` warning **before** the run and then refuse with a structured problem, drawing no plots. The sweep requires both a completion and a refusal to appear, because a harness that has only ever seen one of them cannot tell an honest refusal from a dead run. |
| `example-outcomes.negctl.mjs` | Would that check **notice**? Six mutants — the pre-run warning removed, the unavailable profile declared as available, the runnable lab's model card deleted, the Run control made unaddressable, a catalog entry pointing at a payload that does not exist, and the only un-runnable lab removed from the catalog — each required to turn the check red for its own stated reason. The control case runs first: if it is not green, nothing else in the file means anything. |

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
