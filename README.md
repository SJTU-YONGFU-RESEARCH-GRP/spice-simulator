# SPICE Simulator (schematic editor)

[![version](https://img.shields.io/badge/version-0.2.6-blue.svg)](./VERSION)
[![license](https://img.shields.io/badge/license-CC--BY--4.0-blue.svg)](./LICENSE)
[![artifact guards](https://img.shields.io/badge/artifact%20guards-21-blueviolet.svg)](./docs/VERIFICATION.md)
[![verified in CI](https://img.shields.io/badge/verified%20in%20CI-static%20%2B%20browser-success.svg)](./.github/workflows/pages.yml)

A browser-based analog-circuit **schematic editor with a built-in SPICE simulation
engine** (ngspice compiled to WASM), published as a static
[GitHub Pages](https://sjtu-yongfu-research-grp.github.io/spice-simulator/) site.

This repository is the **public Pages host**. It ships a pre-built editor under
`site/` together with the engineering that makes that build trustworthy: a set of
manifest-driven patches applied to the upstream build, and a verification harness
that proves the build — and those patches — actually behave.

> **Fork context.** The shipped UI is derived from
> [`cascode-ai/analog-canvas`](https://github.com/cascode-ai/analog-canvas)
> (AGPL-3.0-only), aligned to upstream `v0.9.2`. The editor *source* lives in the
> maintainer's private sibling checkout; this repo receives the build output, not
> the source. See [`docs/REPO_LAYOUT.md`](./docs/REPO_LAYOUT.md).

---

## Overview

The product is a static site: an HTML shell, JavaScript chunks, a ~6.9 MB ngspice
WASM engine, model libraries, and a service worker (`sw.js`) that makes the whole
thing work offline. There is no server in the request path except the gallery
shim (see [C3](#features--engineering-improvements) below).

That static-everything design has one sharp consequence that shapes this entire
repository: **`site/` is a checked-in build, not something CI rebuilds.** Every
guarantee about it — that its chunk references resolve, that no development JSX
runtime leaked, that every storage read is guarded, that the CSP is enforced, that
the service-worker cache token still describes the tree, that a simulation still
finishes offline — has to be *verified against the artifact*, not assumed from
source. The verification harness in [`docs/VERIFICATION.md`](./docs/VERIFICATION.md)
exists for exactly that, and it is what lets hand-patched bytes be shipped with
confidence instead of hope.

Two more constraints are worth stating up front, because they explain several
"why is it this way" decisions:

- **The build cannot be reproduced from public sources.** The author's local
  `build:pages` is the only thing that produces `site/`; CI only *publishes* it.
  Therefore every change to the product is a **manifest-driven patch** to the
  shipped bytes (see [Architecture](#architecture)), and the cache token is
  *derived* from the bytes rather than chosen.
- **The simulation filesystem is fixed.** The engine is populated from one
  hardcoded library path; the one code path that would run a user's deck verbatim
  (`mode: 'raw'`) is not constructible from this deploy. Some capabilities that
  *exist in the artifact* are therefore *unreachable here* — and the harness is
  explicit about which claims it does and does not cover.

---

## Features & engineering improvements

The repository's substantive work is a series of targeted improvements to the
upstream build, each one closed with an independent verification channel. The
table is the headline; the *how* and the *proof* are in
[`docs/VERIFICATION.md`](./docs/VERIFICATION.md).

| # | Area | What changed | Why it matters | Verified by |
|---|------|--------------|---------------|-------------|
| D1 | **Stability margins** | Phase & Gain margin added to the automatic measurement summary, read off the Bode curve the plot already draws — engine untouched. | Closed metric enum fails *whole*; an inverting loop read against −180° misses instability by 180°. | `stability-margin.oracle.mjs` + browser channel + check 18 |
| D3-a | **MOS operating-point region** | A `Region` line per device under *Operating Point* (`Saturation · VDS ≥ Vov`), client-side, zero schema/metric-enum change. | Teaches where a transistor sits; avoids the closed-enum failure mode entirely. | `region-annotate.oracle.mjs` (ID identity, 5.2e-10) + browser + check 19 |
| — | **Corner-mapping consistency** (Check 20) | Annotation's corner→selector map must equal the deck emitter's, and both must match canonical `{-1,0,+1}`. | A drift on either side silently mis-annotates *every* device by ~±33 %. | `corner-mapping.negctl.mjs` (6 mutants) |
| D2-b′ | **Panel header count** | Outer "X values" now leads with the *total* count, matching the sum of the groups. | Header said "28 values" while groups summed to 32 (same slot meant two things). | `panel-header.negctl.mjs` + check 21 |
| A5 | **Storage resilience** | Every storage read wrapped in `try`/`catch`; no unguarded access. | Safari private mode / blocked site data / partitioned iframes must render, not crash. | `storage-resilience.mjs` + check 10 |
| — | **CSP conformance** | Enforced policy; `script-src` grants no `unsafe-eval`/`unsafe-inline`. | Closes the XSS surface; raises the browser floor to Chrome 97 / FF 102 / Safari 16. | `csp-conformance.mjs` + `csp-guard.negctl.mjs` + check 11 |
| C3 | **Gallery shim** | Four `/api/gallery/*` endpoints served read-only via the service worker from committed files. | On a static deploy those endpoints 404 and the panel never renders. | `gallery-shim.mjs` + `gallery-shim.negctl.mjs` (10 cases) + check 16 |
| C2b | **Import reachability** | Bundled `cap.lib` / `opamp.lib` resolve when a netlist is imported through the File menu. | Those libraries were unreachable; relative includes were refused as "escapes root". | `spice-import.mjs` + `spice-import.negctl.mjs` + check 15 |
| C1 | **Corner sweep** | Teaching-grade `tt`/`ss`/`ff` over the LEVEL-1 models, applied with a parameter selector. | Students see *which way* a bias point moves between corners (not a foundry corner). | `corner-sweep.negctl.mjs` (15 cases) + `numeric-crosscheck` |
| — | **Example identity** | Built-in labs carry their own project id/name; the catalog resolver overwrites the placeholder. | "Two-Stage Op Amp" was rendering as "New Circuit". | `example-outcomes.mjs` + `example-outcomes.negctl.mjs` + check 17 |
| — | **Engine egress integrity** | The third-party engine fallback verifies what it downloads by hash. | A tampered payload must be refused *and never executed*. | `egress-integrity.mjs` |
| — | **Offline simulation** | Service worker caches the engine; a second simulation finishes with the network off. | Only Cache Storage can serve the 6.9 MB engine with no network. | `offline-sim.mjs` + `sw-cache.negctl.mjs` + checks 12/13 |
| — | **Precache budget** | Install payload bounded and checked in a real browser. | `cache.addAll` aborts the install if one member fails. | `precache-weight.mjs` + `precache-budget.negctl.mjs` + check 5 |

---

## Architecture

```
                ┌─────────────────────────────────────────────┐
                │            site/  (checked-in build)         │
                │  index.html ── shell CSP ── app chunks       │
                │  ngspice.wasm (6.9 MB)  model libs           │
                │  sw.js  (service worker, offline + gallery)   │
                └───────────────┬─────────────────────────────┘
                                │  hand-patched bytes
                                ▼
        ┌───────────────────────────────────────────────────────┐
        │  Manifest-driven patching  (scripts/patch-outbound.mjs) │
        │  patch:margin · patch:region · patch:header ·           │
        │  patch:gallery · patch:import · patch:identity ·        │
        │  patch:corner · patch:storage · patch:csp               │
        │  → find/replace over shipped chunks; bump:shellcache     │
        └───────────────┬───────────────────────────────────────┘
                        │  proved by
                        ▼
   ┌───────────────────────────────────────────────────────────────────┐
   │                   Verification harness                             │
   │                                                                   │
   │  ① Artifact guards   check-artifacts.mjs  (21 static checks)       │
   │       CI: deploy job, before site/ is published                   │
   │                                                                   │
   │  ② Oracles  *.oracle.mjs  — lift shipped logic, run vs closed      │
   │       forms / independent impls  (e.g. margin, region, numerics)   │
   │                                                                   │
   │  ③ Negative controls  *.negctl.mjs  — mutate the artifact, require │
   │       each guard to go red for its OWN reason (proves non-vacuous) │
   │                                                                   │
   │  ④ Browser channels  *.mjs  — drive the real page in headless      │
   │       Chrome, read the rendered DOM  (smoke, offline, margin, …)   │
   │       CI: smoke job                                               │
   └───────────────────────────────────────────────────────────────────┘
```

**Why three independent layers?** No single check can be trusted on its own. A
guard that is green might be green because the feature is dead; an oracle that is
right might be reading code the product never calls; a browser channel that draws
the right text might be drawing it from the wrong numbers. The harness is built so
that each claim is witnessed by at least two channels that do *not* contain each
other — typically a static guard plus a browser channel, or a guard plus a
negative control that proves the guard would notice if it broke. This is the
engineering discipline the project is built on, and it is documented in full in
[`docs/VERIFICATION.md`](./docs/VERIFICATION.md).

**Dual-repo + lab worker.** Student submissions and Issues live in a separate
*private* repo (`spice-simulator-lab`), wired to this public repo as a submodule.
An optional lab-backup worker posts designs there under a salted hash of the
client IP — IPs are never written into issue bodies. See
[`docs/REPO_LAYOUT.md`](./docs/REPO_LAYOUT.md) and
[`lab-sync-worker/README.md`](./lab-sync-worker/README.md).

---

## Repository layout

```
spice-simulator/
├── site/                     # checked-in editor build (what Pages serves)
│   ├── assets/               # app chunks + ngspice.wasm
│   ├── models/               # cmos.lib, cap.lib, opamp.lib (teaching models)
│   ├── sw.js                 # service worker (offline + gallery shim)
│   └── LICENSE.md / NOTICE.md
├── scripts/                  # verification harness + manifest-driven patcher
│   ├── check-artifacts.mjs            # 21 static artifact guards
│   ├── *.oracle.mjs / *.negctl.mjs    # oracles + negative controls
│   ├── *.mjs                        # browser-driven channels
│   ├── patch-outbound.mjs            # the patcher
│   ├── *-manifest.json / *.json      # patch manifests + config (CSP, deviations…)
│   └── publish-editor-pages.sh / release.sh
├── docs/                     # this documentation
│   ├── VERIFICATION.md       # deep verification reference (guards, patches, method)
│   ├── REPO_LAYOUT.md        # public/private dual-repo layout
│   └── PRIVATE_LAB_BOOTSTRAP.md
├── lab-sync-worker/          # optional Cloudflare Worker (private-lab backup)
├── .github/workflows/pages.yml
├── LICENSE                   # this repo's tooling license
├── VERSION
└── README.md
```

> **Local-only working tree.** The maintainer keeps a separate `analysis/`
> directory of design write-ups and evidence (40+ documents) that is **not**
> published to this public repo. References to it in older notes are local-only;
> the public record of *what was built and how it was verified* is this README
> plus [`docs/VERIFICATION.md`](./docs/VERIFICATION.md).

---

## Getting started

### Develop (editor source)

The editor *source* is not in this repository — it lives in the maintainer's
private sibling checkout of the upstream project. From there:

```bash
pnpm install
pnpm --filter @icm/editor dev      # http://127.0.0.1:5173/
```

### Publish

Build output is committed into `site/` (CI only *publishes*; it does not build):

```bash
./scripts/publish-editor-pages.sh
./scripts/release.sh               # optional semver tag + GitHub Release
```

### Apply a patch / bump the cache

Every change to `site/` goes through a manifest, and any such change must be
followed by a cache-token bump:

```bash
npm run patch:margin               # re-play scripts/stability-margin.json
npm run bump:shellcache           # rewrite sw.js token from the artifact bytes
```

`bump:shellcache` is **mandatory** after any `site/` change; check 13 fails the
build if you forget. See [`docs/VERIFICATION.md`](./docs/VERIFICATION.md) for the
full patch catalog.

### Verify

The full verification command set, the per-check catalog, and the methodology are
documented in **[`docs/VERIFICATION.md`](./docs/VERIFICATION.md)**. The short
version:

```bash
node scripts/check-artifacts.mjs --accept=scripts/known-deviations.json   # 21 static guards
node scripts/smoke-test.mjs --require                                  # editor actually runs
node scripts/numeric-crosscheck.mjs                                    # numbers are right
# ... + ~20 more channels (oracle / negctl / browser)
```

or, equivalently, the `npm run check:*` scripts listed in `package.json`. All
static checks run in the CI **deploy** job (before `site/` ships); all browser
checks run in the CI **smoke** job.

`npm run audit:ux` is **not a guard** and never fails a build — it walks the user
flows (home, Gallery at both unlock tiers, each example's title bar, an edit, the
refusal surface, an offline reload) and grades the *text* each surface renders. A
UX defect can pass every guard, which is why it exists.

---

## Documentation

| Document | What it covers |
|---|---|
| [`README.md`](./README.md) | This file — overview, features, architecture, layout, getting started. |
| [`docs/VERIFICATION.md`](./docs/VERIFICATION.md) | **The verification harness**: command set, the three-layer method, the per-patch narratives, and the full guard/tool catalog. The technical heart of the project. |
| [`docs/REPO_LAYOUT.md`](./docs/REPO_LAYOUT.md) | Public/private dual-repo layout, publish flow, privacy model. |
| [`docs/PRIVATE_LAB_BOOTSTRAP.md`](./docs/PRIVATE_LAB_BOOTSTRAP.md) | Checklist for standing up the private lab repo (`spice-simulator-lab`). |
| [`lab-sync-worker/README.md`](./lab-sync-worker/README.md) | The optional Cloudflare Worker used for lab backup on Save/Export. |

---

## Contributing

This repo receives build output, not editor source, so direct source PRs do not
apply. If you are extending the verification harness or adding a patch:

1. **Every new artifact guard needs a negative control.** A guard that cannot be
   shown to notice its own breakage is not a guard (see
   [`docs/VERIFICATION.md`](./docs/VERIFICATION.md), "Negative controls").
2. **Patches are manifest-driven.** Add a `scripts/*.json` manifest and run it
   through `patch-outbound.mjs`; never edit `site/` by hand. Follow with
   `bump:shellcache`.
3. **Commits are English** (the checked-in build mangles non-ASCII commit
   metadata). Keep changes focused and referenced to the check/feature they serve.

The dual-repo model (public host + private lab) is described in
[`docs/REPO_LAYOUT.md`](./docs/REPO_LAYOUT.md); student-facing Issues belong in
the private repo only.

---

## License & attribution

- The **shipped UI** (`site/`) is a build derived from
  [`cascode-ai/analog-canvas`](https://github.com/cascode-ai/analog-canvas)
  (AGPL-3.0-only). Its terms are in [`site/LICENSE.md`](./site/LICENSE.md) and
  [`site/NOTICE.md`](./site/NOTICE.md).
- The **added tooling and documentation** in this repository (the `scripts/`
  harness, `docs/`, this README) are licensed under
  [CC-BY-4.0](./LICENSE) — the repository's own authored material.
- **License unification** across the tree (reconciling the repo's CC-BY-4.0 with
  the upstream UI's AGPL-3.0) is a tracked open item; the bundled UI's terms are
  in [`site/LICENSE.md`](./site/LICENSE.md) and
  [`site/NOTICE.md`](./site/NOTICE.md).
- Model libraries under `site/models/` are teaching-grade (LEVEL-1
  Shichman–Hodges), intentionally **not** SKY130 or any foundry corner; see the
  library headers and [`docs/VERIFICATION.md`](./docs/VERIFICATION.md) for the
  rationale.
