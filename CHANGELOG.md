# Changelog

All notable changes to this repository and to the Pages application it
publishes. Every entry names the script or commit that proves it, so a claim
here can be re-checked without a conversation.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> ### Read this first: the work on this branch is ahead of the version number
>
> `VERSION` and `package.json` read **`0.2.6`**. The last commit that advanced
> them is `e59fbba` (2026-09-10), and the manifest the site itself ships —
> `site/release-manifest.json` — still carries
> `"builtAt": "2026-09-10T13:50:11Z", "version": "0.2.6"`.
>
> Everything recorded under **[Unreleased]** below landed *after* that commit
> and has **not** been released. That is a deliberate state, not an oversight,
> but it does mean the changelog cannot call any of it a release. To promote it,
> run `./scripts/release.sh <version>`, which advances `VERSION`,
> `package.json` and `site/release-manifest.json` in one commit and deploys.

---

## [Unreleased]

The body of work between `e59fbba` (v0.2.6) and `1995b2c`. It is roughly two
things: a verification harness that did not exist before, and the checks it
found.

### Added — the verification harness

The repository now ships 35 scripts under `scripts/`. None of them changes what
the simulator does. They exist to make the claim "this works" checkable by a
machine that has no opinion.

| Layer | Count | What it is | Entry point |
|---|---|---|---|
| **Artifact guards** | 21 numbered checks | Static assertions read straight off the bytes `site/` will serve: every root-absolute reference resolved against the deployed base, CSP policy and inline-script hashes, service-worker cache contract, shell-cache invalidation token, closed metric enums, JSX call sites, storage access, outbound egress. | `node scripts/check-artifacts.mjs` |
| **Oracles** | 3 | Lift a computation back out of the shipped chunk and recompute it from first principles, in an independently written implementation. | `stability-margin.oracle.mjs`, `region-annotate.oracle.mjs`, `numeric-crosscheck.mjs` |
| **Negative controls** | 15 | `scripts/*.negctl.mjs`. Copy the tree to a temp dir, mutate it, require the guard to name the mutation — with a control tree that must stay clean. Proves the guard is not vacuous. | `npm run check:header:neg`, etc. |
| **Browser channels** | 11 | Drive the shipped artifact in headless Chrome: smoke, storage-denied, policy-enforced, offline simulation, netlist import, gallery, example outcomes, margin and region rendering. | `node scripts/smoke-test.mjs --require` |
| **Patch manifests** | 12 | `scripts/*.json`, consumed by `patch-outbound.mjs`. The build product is never hand-edited. | `npm run patch:region`, etc. |

The layering is on purpose. A static guard cannot see runtime, a browser channel
cannot see whether a number is *correct*, and an oracle cannot tell you the row
was ever drawn. Each layer is gated separately in CI, so a green build means
four independent things are green. See
[`docs/VERIFICATION.md`](./docs/VERIFICATION.md) for the per-patch narratives
and [`docs/verification-methodology.svg`](./docs/verification-methodology.svg)
for the shape of it.

### Added — product improvements

Each row is a targeted repair or feature on the upstream build, in the order it
landed. Commit refs are short hashes on branch `xyp`.

| Area | Change | Commit |
|---|---|---|
| **Engine numeric assurance** | The shipped ngspice build is cross-checked against first-principles closed forms, covering linear circuits, MOS level 1–4 and diodes; a later pass adds an invariant layer and mutation-tests the whole thing. | `0be9d33`, `2bcbccd` |
| **Headless runtime smoke test** | CI loads the page, opens an example and runs a simulation, failing the build on any uncaught error. Closes a class of defect that every static check walked past. | `409f8fe` |
| **Artifact guard** | First version. Catches artifact-path, JSX-runtime, service-worker and unlock-gate defects — including 31 JSX call sites compiled to `(void 0)`, which shipped a site that loaded fine and crashed on Run. | `b82a4b6` |
| **JSX call-site repair** | Same defect class repaired, plus a guard so a rebuild cannot quietly reintroduce it. | `7dbcffe` |
| **Outbound egress inventory** | Every target the artifact can reach is classified in `scripts/outbound-manifest.json`; the public feedback link was dead, and the third-party engine fallback now verifies what it downloads by hash. | `922b162` |
| **Storage resilience** | Seven unguarded storage reads that turned a storage-denied browser into the error boundary's crash screen are wrapped; six repaired reads are deliberately *not* accepted into the deviation list, so a reappearance is a live finding. | `72ca261` |
| **Content-Security-Policy** | An enforced policy on both shell documents. `script-src` grants neither `unsafe-eval` nor `unsafe-inline`, raising the browser floor to Chrome 97 / Firefox 102 / Safari 16. | `4a43d87` |
| **Worker runtime cache (N4/P)** | Every `cache.put()` on the runtime route threw "Response body is already used", so the cache held only install's six shell entries and the 6.88 MB engine was never routed there. Repaired and proven offline. | `4188e15` |
| **Worker install payload (B5)** | Install payload shrunk by 632 KiB and bounded, after the check that sums it found 735.9 KiB of two images inside a 738.1 KiB budget. | `a4f596f` |
| **B-class review pass** | Every built-in example is asked what it does when you press Run, and must say which — including the ones that are not labs and must not pretend to be. | `7dab9c5` |
| **Shell-cache token (M2)** | The constant `sw.js` opens its cache under is no longer chosen by hand. It is derived from the artifact, because this repository hand-patches that artifact while keeping every filename. | `1303d81` |
| **Engine egress integrity** | Asserted by running the loader and hash helper lifted out of the shipped chunk: a tampered payload must be refused *and never executed*. | `922b162` |
| **Process corner selection (C1)** | The executor emitted no selector and the library had no corner parameters, so all three choices returned the same devices. Now `tt`/`ss`/`ff` over the LEVEL-1 models, applied with a parameter selector. Teaching-grade, not a foundry corner. | `59d03dc` |
| **Import reachability (C2)** | `cap.lib` and `opamp.lib` resolve when a netlist is imported through the File menu. The include resolver had refused every relative include, because a flat multi-file selection yields an empty `dirname`. | `368ffbd` |
| **Gallery panel (C3)** | Four `/api/gallery/*` endpoints answered read-only by the service worker from committed files. Scope decides which *clients* a worker controls, not which of their requests it sees — the naive reading had it dismissed as unreachable. | `2f4c023` |
| **Example identity** | "Two-Stage Op Amp" rendered as "New Circuit" because the catalog resolver overwrote the payload's own name. Built-in labs now carry their own project id/name. | `0eaee02` |
| **Stability margins (D1)** | Phase and gain margin in the automatic measurement summary, read off the Bode curve the plot already draws. Measured relative to the loop's own low-frequency phase, so an inverting loop reports the same margin as the non-inverting one. | `c451076` |
| **MOS operating-point region (D3-a)** | A `Region` line per device under *Operating Point* — `Saturation · VDS ≥ Vov` — computed client-side from the same LEVEL-1 parameters the engine solved against, with body effect and PMOS sign handled. Zero schema change: the artifact's metric enum is closed and declared twice. | `691c254`, `5712b79` |
| **Corner-mapping consistency (Check 20)** | The corner the annotation reads and the `__cn_sel` the deck emitter write were two independently written ternaries that were never cross-checked. A drift mis-annotates every device by roughly ±33 % with no error. | `632c239` |
| **Panel header count (D2-b′)** | The Measurements panel said "28 values" while the groups beneath summed to 32. The same slot led with "available" at the top and "total" one level down. | `8508eb8` |

### Changed

- **Release commits are scoped to `site/`.** `05f9264` drops `git add -A`, which
  used to sweep unrelated files into a release commit.
- **Release tooling.** `scripts/release.sh` now records the release in
  `site/release-manifest.json`, and publishes prefer SSH remotes under WSL
  (`22c66b0`, `514ceaf`, `7a66327`).
- **Local preview.** `2e0caa4` adds `scripts/serve-local.mjs` and a `.cmd`
  entry point, so previewing does not depend on the caller's `PATH`.

### Fixed

- 31 JSX call sites compiled to `(void 0)` — the editor loaded, then crashed on
  Run. `7dbcffe`, guarded by check 8.
- Seven unguarded storage reads that crashed the editor when the browser denies
  storage. `72ca261`, behaviourally covered by `storage-resilience.mjs`.
- The public feedback link, which pointed at a dead destination.
  `922b162`.
- The worker's runtime cache, which held neither the engine nor a working clone.
  `4188e15`, proven by running offline with the HTTP cache disabled.
- The install payload, which paid for two images and then some.
  `a4f596f`, `precache-weight.mjs`.
- The Measurements panel header count. `8508eb8`, guarded by check 21.

### Documentation

- `1995b2c` — `README.md` restructured into overview, features, architecture,
  layout, getting started and documentation; `docs/VERIFICATION.md` added as
  the deep reference for the harness; `docs/REPO_LAYOUT.md` brought up to date.
- `39f4006` — README's `analysis/` references repointed at their subdirectories.
- `CHANGELOG.md` — this file.
- `docs/verification-methodology.svg` — the four-layer method as a diagram.

---

## [0.2.6] — 2026-09-10

Released by `e59fbba`. The commit itself is version bookkeeping only
(`VERSION`, `package.json`, `site/release-manifest.json`); the content in this
window is the schematic-editor publish.

- **Schematic editor published to Pages**, replacing the legacy vanilla MNA
  simulator UI (`b63c161`).

## [0.2.5] — 2026-09-10

Released by `4fb8fea`. Bookkeeping only.

- Schematic-editor publishes and Pages workflow fixes for this window:
  `0019bac`, `517448e`.

## [0.1.0] — 2026-09-09

First published version, released by `57aaf56`. Bookkeeping only.

- Pages deployment moved onto a `gh-pages` branch, avoiding the Setup Pages
  gate (`bfc6940`, `e4aa723`).
- The Pages site was replaced with the Vite schematic editor, and the legacy
  vanilla MNA simulator was deleted from the public repository
  (`e170558`, `4f50fff`, `3d06e74`).
- Release tooling normalised: WSL preference and LF line endings
  (`22c66b0`), `scripts/release.sh` marked executable (`514ceaf`),
  SSH remotes preferred (`7a66327`).
- Branding and the private lab-sync worker for Save/Export issue upserts
  (`9ba38c8`, `fa99901`).

---

## Notes for readers of this file

Two things about this repository tend to surprise people, so they are recorded
here rather than discovered later.

**`site/` is a build product, and it is the only source that is published.** The
editor source lives in a private sibling checkout and is not in any public
repository. `scripts/patch-outbound.mjs` applies repairs to the committed bytes
through a JSON manifest, so nothing is hand-edited, and `npm run bump:shellcache`
then re-derives the token `sw.js` opens its cache under. If you patch the bytes
without that step, every returning visitor stays on the copy they already have.

**Known deviations are printed, never skipped.** `scripts/known-deviations.json`
accepts a finding that is understood and attributable, and check 21 reports any
entry that stops matching as a finding in its own right. The list therefore
cannot outlive the code it describes — a rebuild that shifts a byte offset
resurfaces the finding rather than hiding behind it.

Conventions used above: `[Unreleased]` has no date because it has no release
date yet; commit refs are short hashes on branch `xyp`; and every "verified by"
style claim in the tables of [`docs/VERIFICATION.md`](./docs/VERIFICATION.md)
cites the script that re-derives it.
