# Verification

`site/` is a **checked-in build**, so the checks that would normally run against
source have to run against the **artifact** instead. None of them need the editor
checkout or a package install. This document is the technical reference for the
harness: the command set, the methodology behind it, the per-patch narratives,
and the full guard/tool catalog.

---

## Quick reference

### Direct node commands

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
node scripts/corner-mapping.negctl.mjs
node scripts/spice-import.mjs --require
node scripts/spice-import.negctl.mjs
node scripts/gallery-shim.mjs --require
node scripts/gallery-shim.negctl.mjs
```

### npm scripts (equivalent)

`npm run check:artifacts` / `npm run smoke` / `npm run check:storage` /
`npm run check:numeric` / `npm run check:numeric:neg` / `npm run check:egress` /
`npm run check:egress:neg` / `npm run check:csp` / `npm run check:csp:neg` /
`npm run check:offline` / `npm run check:offline:neg:static` /
`npm run check:precache` / `npm run check:precache:neg:static` /
`npm run check:examples` / `npm run check:examples:neg` /
`npm run check:identity` / `npm run check:identity:neg:static` /
`npm run check:shellcache` / `npm run check:shellcache:neg:static` /
`npm run check:corner` / `npm run check:corner:neg` /
`npm run check:import` / `npm run check:import:neg:static` /
`npm run check:gallery` / `npm run check:gallery:neg:static` /
`npm run check:margin` / `npm run check:margin:neg:static` /
`npm run check:margin:browser` /
`npm run check:region` / `npm run check:region:neg` /
`npm run check:region:browser` /
`npm run check:cornermap` / `npm run check:cornermap:neg`.

### Not a guard

`npm run audit:ux` is **not a guard** and never fails a build. It walks the flows
a person takes — the home page, the Gallery panel at both unlock tiers, each
built-in example's title bar, an edit, the refusal surface, an offline reload —
and prints the *text* each surface renders, then grades what it found. It exists
because a UX defect can pass every guard: the project-identity bug loaded,
rendered, and ran, and only said the wrong circuit name. Two of its first
findings were the audit's own mistakes, and both are written into it as comments:
`requiresUnlock:!0` means **true** (reading it as `=== '1'` inverts every gate
and calls a correct gate a missing list), and the `?example=<id>` deep link
**re-seeds** the lab on every load by design, so a rename not surviving a reload
is the loader doing its job rather than a persistence bug.

### Cache token

`npm run bump:shellcache` rewrites `sw.js`'s cache constant from the artifact.
Run it after **any** change to `site/`; check 13 fails the build if you forget.
The token is *derived*, not chosen — see below.

---

## Methodology: four independent layers

No single check can be trusted on its own. The harness is built so that each
claim is witnessed by at least two channels that do **not** contain each other.

[`docs/verification-methodology.svg`](./verification-methodology.svg) draws the
same four layers as a diagram — what each one gates, and the sharpest assertion
each one is judged on.

1. **Artifact guards — `check-artifacts.mjs` (21 static checks).** Run in the CI
   **deploy** job, before `site/` is published. They read the shipped bytes
   directly: do references resolve, is there no development JSX runtime or
   folded-`undefined` call site, is every network target classified, is every
   storage read guarded, does the CSP still have its shape, does `sw.js` still
   have the shape its caching needs, does the worker's install payload fit its
   budget, does the cache constant still describe this tree, do the corner set
   and the model library agree, does an imported netlist resolve the shipped
   libraries, etc.

2. **Oracles — `*.oracle.mjs`.** Lift a source fragment out of the shipped bytes,
   compile it where necessary, and run it against **closed forms** or an
   **independently written** implementation. They cannot see the screen, which is
   exactly why they are one of two channels rather than the only one. The sharpest
   assertions are identities (e.g. the drain-current formula implied by the region
   a row claims reproduces the engine's current to 5.2e-10 relative).

3. **Negative controls — `*.negctl.mjs`.** Mutate the artifact and require each
   guard to go **red for its own stated reason**. They prove a guard is not
   vacuous: a guard that stays green when its feature is broken is worse than no
   guard, because it looks like the tree has a problem. Every mutant is anchored
   on the bytes the patched tree actually carries and must occur exactly once, so
   a mutation that matched nothing cannot masquerade as a pass.

4. **Browser channels — `*.mjs` runtime.** Drive the real page in headless
   Chrome and read the rendered **DOM** — not just text, but the row in the
   table's shape, the title bar, the card. Run in the CI **smoke** job. A margin
   computed and never drawn passes every other check in this repository, so a
   browser channel that reads the screen is the only thing that catches it.

**CI split.** All static checks run on the **deploy** job (before publish); all
browser checks run on the **smoke** job. A build cannot ship with a red deploy
job, and a published site cannot stay red on the smoke job.

---

## Patch catalog

Every change to `site/` is applied by `scripts/patch-outbound.mjs` from a manifest
(`--manifest=<file>`), which does find/replace over the shipped chunks. An edit
that consumes its anchor is idempotent by default; an **insertion** declares a
**marker** — a string absent before the repair and present exactly once after —
because the default idempotence test cannot settle an insertion. Any change to
`site/` bytes must be followed by `npm run bump:shellcache` (check 13 enforces
this), except patches that touch nothing the worker route hashes.

### `patch:margin` — D1, stability margins

Adds **Phase margin** and **Gain margin** to the automatic measurement summary.
The Bode plot already carried both ingredients — an AC output is stored as a pair
of arrays and the plotting layer already derives `magnitudeDb` / `phaseDeg` from
exactly those two — so the margin is read off the curve that is already drawn and
the engine is untouched. Four things about it are worth knowing, and three of
them are mistakes that had already been made once:

- **The schema's metric enum is closed, and its failure mode is total.** The
  artifact schema enumerates every metric a result file may carry and rejects any
  file carrying an unknown one *whole*: the panel then falls back to "Full result
  files are unavailable or invalid" and **every** measurement disappears, not just
  the margin. The enum is written **twice** (the available and the unavailable
  variant) and a margin that is not available still travels through the second
  one, so extending one and not the other loses the whole result — a build that
  looks broken because it is. That was found by running the patched tree against
  the unpatched one, not by reading code.
- **Automatic only.** Margin is deliberately *absent* from the authoring tables in
  the surface chunk: the setup editor validates its method kind against a closed
  union with no margin member, so offering the option would let a user save a setup
  the authoring schema cannot build. Check 18 asserts the absence, which is what
  makes a well-meant re-add show up rather than ship.
- **The phase margin is measured against the loop's own static phase**, not
  against absolute −180. Against −180 an inverting loop reports ≈275° — a plausible
  number that misses the instability by a full 180°. The oracle pins this with an
  inversion-invariance assertion: an inverting stage must report the same margin
  as its non-inverting twin.
- **Crossings are found against a level, after unwrapping the phase.** Both
  shortcuts fail as numbers that look fine rather than as crashes: a sign test
  reads the ±180 wrap as a crossing and reports a gain margin for a phase that
  merely passed through zero.

Two independent channels read the same claim, and neither contains the other.
`stability-margin.oracle.mjs` lifts the evaluator out of the shipped bytes and
checks it against closed forms (it cannot see the screen), while
`stability-margin.mjs` drives the page and reads the rendered table — a margin that
is computed and never drawn passes every other check in this repository. The
committed example cannot exercise the interesting half of that: with `vin` at 1.0
its AC response never crosses 0 dB, so on this tree every margin is `unavailable`
by design and the "the value agrees with its own unit" branch would never run.
`--fixture=center-magnitude` copies the tree and offsets each magnitude curve so it
straddles 0 dB (measured: the AC output spans 4.5 dB, ~20 dB below 0 dB, so
centring — not peak-normalising — is what guarantees a crossing). On that tree the
page renders `Phase margin = 89.235 deg` next to three structured refusals, and the
panel's own measurement count moves by exactly one row against the committed tree.

Both schema edits here replace the very text an anchor would key on, so this is
the one manifest whose `requires` cannot be the unpatched enum: each precondition
is taken from the text *after* the enum, which is unique and survives the patch.
The generator asserts both readings before it writes, and `patch:margin --check`
is the channel that reports a manifest whose anchors a patch would consume.

### `patch:region` — D3-a, operating-point region

Adds a **Region** line to each device card under the Operating Point tab —
`Region Saturation · VDS = 200.0 mV ≥ Vov = 250.0 mV` and its two siblings, with a
refusal instead of a line whenever the reading cannot be trusted. It is the only
repair in this repository whose input does not exist in the run at all, and that is
what shapes everything about it:

- **The device parameters are never in the run.** The deck the engine executes
  carries `.include ".../cmos.lib"` and a `.param __cn_sel` selector and nothing
  else: no `.model` line, no `LEVEL`, no `VTO`. `prepared.cir`, `log.txt` and
  `out.raw` were each read and none of them carries a device parameter, so a
  region computed at display time would need an expression evaluator over a
  netlist the client does not have. Instead the eight LEVEL=1 models are parsed
  out of `site/models/cmos.lib` at build time into `[typical, corner-coefficient]`
  pairs and inlined. Check 19 re-derives that table from the library and fails any
  tree where the two disagree — otherwise an upstream corner tweak would leave
  every transistor judged against the previous process.
- **The corner is not a parameter either.** It comes from
  `result.metadata.configuration.modelLibrary.section`, the same field the deck
  assembler reads when it decides whether to emit `.param __cn_sel`. `tt`, the
  empty string and `null` all mean "nothing was emitted and the library's own
  `= 0` stands"; `ss` and `ff` move the threshold and the transconductance the way
  the library's coefficients say.
- **Nothing about it touches the payload.** Not the result file, not the metric
  enum, not the schema. The reading is derived on the client from measurements
  already on screen, so the enum's total-failure mode cannot be reached through
  it — and check 19 asserts the table never reaches the artifact-schema chunk, in
  either of the two places it could hide.
- **A device it cannot judge gets no line rather than a wrong one.** A model the
  table does not carry, a corner selector with no mapping, an instance that is not
  in the schematic, an operating point the engine did not produce, and a body bias
  that would make `PHI + VSB` non-positive all refuse. Within ±2 % of `VDS == Vov`
  the line says *at the edge of saturation* instead of picking a side, because that
  is where both LEVEL=1 formulas are equally wrong.
- **PMOS is the mirror of NMOS, not a second code path.** The signs are flipped
  once on the way in, so an inverting device cannot drift out of step with its
  complement; the oracle runs the same operating point through both polarities.
- **The model name is read, never guessed.** The device is resolved through
  `documentId` + `instanceId` into the schematic instance's
  `netlist.binding.name`; a device whose binding cannot be found refuses.
- **The corner the annotation reads must be the corner the deck emitted.** The
  annotation turns `section` into a numeric selector with its *own* ternary, and
  the deck emitter turns the same `section` into `.param __cn_sel` with a
  *different* ternary. The D3 feasibility write-up named this as an unguarded
  risk: if either side drifts — the emitter swaps `ss` and `ff`, or `tt` stops
  mapping to `0` — every device is annotated against the wrong process corner with
  no error, by the corner's own spread (about ±33 % for this library's `VTO`/`KP`).
  Check 20 re-derives both maps from the shipped chunks and requires them to agree
  with each other *and* with the canonical `{-1, 0, +1}`; `corner-mapping.negctl.mjs`
  proves it is not vacuous by flipping `ss`/`ff` on each side, flipping both
  together, and breaking `tt`, and requiring each drift to be named while the
  unmutated tree stays clean.

Two channels again. `region-annotate.oracle.mjs` lifts the injected runtime out of
the shipped chunk, builds operating points structurally (`VDS = Vov/2` must be
linear, `VDS = 2·Vov` must be saturated) and against an independently written
body-effect expression, and its sharpest assertion is an *identity*: the
drain-current formula implied by the region the row claims reproduces the current
the engine produced — 5.2e-10 relative on the shipped lab, while the other
region's formula misses it by a factor of four, so a row cannot be right about the
region and wrong about the number. `region-annotate.mjs` drives the page, opens
the Operating Point tab, and requires the text the artifact's own function
computes to be the text the card renders.

### `patch:header` — D2-b′, panel header count

Fixes **D2-b′**: the Measurements panel's outer card (function `Nt`) led its
"X values" with the *available* count (`n = e.length - t.length`, where `t` is the
unavailable list) while every per-output group header led with its *group total*
(`t.length`). The same slot meant two different things, so the header read "28
values" while the groups summed to 32, both attaching "4 unavailable". The patch
makes the outer header lead with the total (`e.length`) so it agrees with the sum
of the groups. It is a one-token substitution in the surface chunk — no payload,
schema, or metric-enum change — and because `site/` bytes changed,
`bump:shellcache` must follow it. Check 21 asserts the outer header leads with
`e.length` and the group header still leads with `t.length`; `panel-header.negctl.mjs`
proves it is not vacuous by reverting the outer header to the defect form (both
positive assertions fire), removing the group header's leading count (the inner
assertion fires alone), and deleting function `Nt` (the check goes quiet rather
than passing).

### `patch:corner` — C1, corner sweep

Applies the **teaching-grade** process corner: `tt`/`ss`/`ff` scale the Level-1
(Shichman–Hodges) parameters of `site/models/cmos.lib` by a made-up spread, so a
student can see *which way* a bias point moves between corners. It is not SKY130
and not any foundry corner, and it is deliberately not wired to the `sky130`
service — that executor advertises no corners and is served outside this static
site. The library's own header says the same thing at the point of use.

The sweep is applied with a **parameter selector**, not `.lib` sections. The deck
includes the library with `.include`, and the executor writes `ngbehavior=lt` into
`spinit`; under that behaviour ngspice rewrites a sectioned `.lib` into a plain
include of the whole file plus an include of the section name *as a filename*, so
sectioned libraries cannot work here at all. Re-declaring a `.model` from below is
no better — ngspice keeps the first definition and says nothing. A `.param` the
deck redefines *after* the include does work, because parameters are last-wins
where models are first-wins. So the deck writes `.param __cn_sel=<selector>` for
the non-typical corners only, and the library expresses each spread as an
expression over `__cn_sel`. The typical corner (`__cn_sel = 0`) reproduces the
device set that shipped before the feature, to within 1.9e-13 relative — an
artifact of `{}`-braced parameters reaching ngspice's expression evaluator instead
of its literal parser, twelve orders of magnitude below the smallest corner shift.
Both halves are pinned: check 14 ties the advertised list to the emitter and the
library, and `numeric-crosscheck.mjs` runs the three corners plus the frozen
device set in the shipped engine.

This is the one repair that also writes a **model library**
(`site/models/cmos.lib`), so it is the only patch that needs `bump:shellcache`
after it — a model card is inside `ENGINE_PAYLOAD_DIRS` and therefore inside the
derived token. `npm run check:corner` selects the corner cases with
`--only=corner_default,corner_ss,corner_ff,corner_frozen`; the two further corner
claims — `corner_default_matches_frozen` and `corner_shifts_every_device` — are
**cross-assertions** (they declare `needs:` and are evaluated whenever their
prerequisites run), not named cases.

Two more libraries ship in `site/models/` — `cap.lib` (role capacitors: `cout`,
compensation, bypass, MIM/MOM tags) and `opamp.lib` (behavioural `opamp_se` /
`opamp_diff` with `av0`/`gbw`/`rin`/`rout`/`vos`/`acm`/`swing`). Their headers
tell a netlist to include them, and `numeric-crosscheck.mjs` **runs** them, because
nothing ever had: the results are correct to the closed forms.

### `patch:import` — C2b, import reachability

Importing a netlist is the File menu's **Import SPICE** control — a plain
`<input type="file" multiple>`, and the only channel files can enter through
(`webkitdirectory` occurs nowhere in the build). A flat selection arrives with an
empty `webkitRelativePath`, so the importer falls back to `File.name`, while the
include resolver refuses anything that climbs above `dirname(entry)` — which for a
flat name is empty. Measured in a browser before the repair landed:

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
imported SPICE becomes a project rather than a deck. The change itself, with the
measured before/after matrix and both mutants, is the C2b write-up; it is labelled
C2b, not C3, because it is the **reachable half of C2** rather than the next item
on that list — whose C3 is the unrelated service-worker Gallery shim.

### `patch:gallery` — C3, gallery shim

The Gallery panel reads four endpoints at the **origin root** —
`/api/gallery`, `/api/gallery/tags`, `/api/gallery/<id>` and
`/api/gallery/<id>/preview.svg` — and only a server can answer them, so on this
static deploy its fetches fail, the client degrades to `null`, and the gallery
section never renders. `scripts/gallery-shim.json` routes those four through the
service worker to files committed under `<scope>gallery/`, which makes the panel
usable read-only.

It is worth being exact about why that works, because the obvious reading says it
cannot: the worker is registered with `scope: /spice-simulator/` while
`/api/gallery…` is at the origin root, i.e. out of scope. **Scope decides which
clients a worker controls, not which of their requests it observes.** A fetch made
by a controlled page fires the worker's `fetch` event whatever the request URL, and
`respondWith()` on an out-of-scope request is honoured. That was not reasoned out,
it was measured — `gallery-shim.mjs` is the measurement — and the same file records
it so the next reader does not have to re-derive it.

The shim **ships with an empty index**, and that is a product decision rather than
an oversight. The panel renders `showGallery ? galleryCards : builtinCards`, so a
non-empty gallery does not *add* a section — it **replaces** the built-in example
list, which is the student library plus whatever the instructor unlock reveals.
This route has no unlock check, so listing the locked labs there would not merely
hide that gate, it would bypass it. An operator who wants the panel populated drops
a `gallery/` directory in:

```text
site/gallery/index.json          { "entries": [ { "id": "...", "name": "...",
                                   "author"?: "...", "description"?: "...",
                                   "tags"?: ["..."], "previewRevision"?: "..." } ] }
site/gallery/<id>/project.json   the project payload, verbatim, as text
site/gallery/<id>/preview.svg    the card image
```

`<id>` is shape-checked (`^[a-z0-9][a-z0-9._-]{0,63}$`) before it is ever joined
into a path, and the shim **answers rather than caches**: it sits in front of the
branch that deliberately keeps `/api/*` out of the build-scoped shell cache,
because a revisioned preview URL that gets stored under one revision and served
under the next is exactly the stale-image bug that branch exists to prevent. Two
things follow from "answers only": the empty index is not a *repair* — the four
endpoints stop being 404s, which `gallery-shim.mjs` requires even on the shipped
tree — and a populated gallery is a real behaviour change, not an additive one.

`npm run bump:shellcache` is **not** needed after this patch: `sw.js` itself is not
among the bytes the worker route stores, so the derived token does not move. Check
16 is what says so if that ever changes. The scope lesson is the transferable
half: "the worker is registered under X, so it cannot answer Y" is a claim about
*reachability*, and reachability claims here are settled by driving the product.

### `patch:identity` — example identity (data + display)

In two parts. **Data**: three of the five built-in labs stored the project
factory's placeholder identity (`id:project-main` / `name:New Circuit`) instead of
their own. The title bar renders the project's own name, so a user who chose
"Two-Stage Op Amp" read "New Circuit" as the circuit they were editing. Those
three payloads now carry their catalog id and name. **Display**: `og()`, the
single `id -> project` boundary the catalog resolves through, returned the stored
name unchanged; it now overwrites it with the catalog's name, which is what the
Gallery path already did (`u.entry?.name ?? d.name`). The two halves are checked
independently — check 17 reads the stored identity out of the chunk and refuses a
placeholder, while `example-outcomes.mjs` drives the page and asserts the title
bar shows the catalog name — so a data-only fix (resolver still able to pass a
future payload's placeholder through) and a display-only fix (stored data still
wrong) each fail on their own half. `example-identity.negctl.mjs` walks three
mutations, including one that renames every payload to the *same* wrong string: a
rule written as "differs from the catalog" would pass that tree, and the
rendered-name assertion must not.

This patch changes bytes in an early part of `App-*.js`, which shifts every byte
offset after it — including the seven storage acceptances in
`scripts/known-deviations.json`, whose keys are `rel@offset`. They were re-derived
here too. That is the third time a patch has had to do this, which is why the
offsets are worth replacing with a content-derived key; until then, any patch that
grows this chunk owes the same re-derivation, and check 10 reports the drift as
stale acceptances rather than silently.

### `patch:storage` — A5, storage resilience

Wraps every storage read in `site/` in a guarded accessor so that a browser that
**denies** storage — Safari private mode, blocked site data, partitioned iframes —
still renders the editor instead of crashing. `storage-resilience.mjs` loads the
home page and an `?example=` deep link with `localStorage`/`sessionStorage`
replaced by throwing getters and requires the editor, not the crash screen.
Check 10 (the artifact guard) holds the static half — that no unguarded storage
read remains in the shipped chunks.

### `patch:csp` — CSP conformance

`site/index.html` and `site/404.html` carry the deploy shell's
Content-Security-Policy, declared in `scripts/shell-csp.json`. The directive set
was derived by measurement, not from a template: it names `'self'` for the app's
own chunks, `'wasm-unsafe-eval'` for the engine, `blob:` for the worker and the
CDN fallback, and `https://cdn.jsdelivr.net` — the one origin, which the outbound
manifest already classifies. `script-src` deliberately does **not** grant
`'unsafe-eval'` or `'unsafe-inline'`, and check 11 fails the build if either
appears. Two consequences worth knowing: the inline theme bootstrap is approved by
a hash re-derived from the document on every run, and the policy raises the
browser floor to Chrome 97 / Firefox 102 / Safari 16, because that is when
`wasm-unsafe-eval` arrived. `csp-conformance.mjs` boots the page and runs a
simulation under the shipped policy, requiring zero violations — after first
proving the violation collector can see one (`--self-test` serves a deliberately
violating page and requires both the violation to be observed and the injected code
never to run).

---

## Guard & tool catalog

| Check / tool | Question it answers |
|---|---|
| `check-artifacts.mjs` | Is the bundle self-consistent — do its references resolve, is there no development JSX runtime or folded-`undefined` call site, is every network target in the tree classified, is every storage read inside a `try`/`catch`, does the shell still carry its Content-Security-Policy, does `sw.js` still have the shape its caching needs, does the worker's atomic install payload fit its budget, does the constant it opens its cache under still describe this tree, does the corner set the panel offers match the model library that has to answer it, and does an imported netlist still resolve the model libraries this build ships (including that the text embedded in the chunk is still the bytes of `site/models/*.lib` and that the injected pool is called rather than merely present)? It also holds the static gallery shim to its contract (both insertions present, the dispatch **before** the `/api/` early return that would otherwise swallow it, the entry id shape-checked before it becomes a path segment, no Cache Storage access in a region that must only answer, every key the shipped client reads still written by an object literal passed to `galleryJson()`), and holds the stability-margin repair to both halves of itself (evaluator present **and called**, the closed metric enum extended in **both** variants, the emitted metric/label/unit kept as a matched set, the five correctness properties still present, the metrics still **absent** from the authoring tables), and holds the region repair (table re-derived from the library, table never reaches the schema chunk, both halves of the corner map agree with canonical `{-1,0,+1}`), and holds the panel-header repair (outer leads with total, group still leads with total). |
| `smoke-test.mjs` | Does the editor actually run — does a real simulation finish with zero uncaught errors? |
| `storage-resilience.mjs` | Does the editor still render in a browser that **denies** storage? Loads the home page and an `?example=` deep link with `localStorage`/`sessionStorage` replaced by throwing getters and requires the editor, not the crash screen. |
| `numeric-crosscheck.mjs` | Are the numbers **right** — does the shipped WASM agree with first-principles closed forms and with model-independent invariants (including for BSIM3/BSIM4, which have no closed form)? It also runs the two **role libraries** the deploy ships (`cap.lib`, `opamp.lib`): an ideal capacitor must be an open circuit at dc and charge with `tau = R*C`, and `opamp_se` must follow its soft-rail tanh transfer behind the series `Rout`. |
| `numeric-crosscheck.negctl.mjs` | Would the numeric guard **notice** if it broke? Mutates the guard and the deck, and (for the corner and role-library groups) the **artifact's own library files**, and requires every mutant to fail — while the mutant that makes the corner selector inert must leave "the default still matches the frozen device set" green, so the two cross-checks are shown to be independent rather than two names for one claim. |
| `egress-integrity.mjs` | Does the third-party engine fallback actually **verify** what it downloads? Lifts the loader and hash helper out of the shipped chunk and runs them, including a tampered payload that must be refused *and never executed*. |
| `outbound-repair.negctl.mjs` | Would the outbound checks **notice** if they broke? Nine cases, incl. two controls, against deliberately weakened copies. |
| `csp-conformance.mjs` | Is the shell's Content-Security-Policy **enforced** and does it leave the editor working? Boots the page, opens an example and runs a simulation under the shipped policy, requiring zero violations — after first proving the violation collector can see one (`--self-test`). |
| `csp-guard.negctl.mjs` | Would check 11 **notice** if it broke? Twelve cases against mutated copies of the real shell — a missing policy, a hand-edited policy, two shells that disagree, an inline script edited without updating its hash, `'unsafe-eval'`/`'unsafe-inline'`/`*` added to script-src, a dropped directive, an empty document list and an unaudited origin — each required to produce its own finding. |
| `offline-sim.mjs` | Can the worker do its job? Serves the artifact with deploy-like cache headers, warms a simulation, then turns the network **and** the HTTP cache off and requires a second simulation to finish. Only Cache Storage can serve the 6.88 MB engine under those conditions. |
| `sw-cache.negctl.mjs` | Would that test **notice**? Re-introduces the two defects that made the worker cache nothing (a response cloned inside the `caches.open()` callback; the engine unrouted because its `fetch()` has an empty `destination`) and requires **both** channels to catch them: check 12 names each defect, and `offline-sim.mjs` fails. `--static-only` runs just the source-level half. |
| `precache-weight.mjs` | How big is the install payload **in a browser**? `install()` runs `cache.addAll(shellUrls())`, which every first-time visitor downloads in full before the editor works offline — and which aborts the install outright if one member fails. Reads the shell cache back, sums what is really stored, compares each entry against its file on disk, holds the total to `scripts/precache-budget.json`, and requires the cache the browser opened to be the name `scripts/shell-cache.mjs` derives. |
| `precache-budget.negctl.mjs` | Would the install-budget check **notice**? Three mutants — `logo.png` replaced by a real 512×512 PNG, the 512 px manifest icon re-declared in `shellUrls()`, and a precache target deleted — each required to be caught by **both** channels: check 5 names it, and `precache-weight.mjs` fails. `--static-only` runs without a browser. |
| `example-outcomes.mjs` | Do the built-in examples do what the catalog says? Walks every catalog entry. Expectations are computed from the shipped chunks and checked against the page the product renders, so the two sides are independent. An example with no setups must offer nothing to run; one whose profile is advertised must complete and render; one whose profile is not must carry a `(unavailable)` warning **before** the run and then refuse with a structured problem. The sweep requires both a completion and a refusal to appear. |
| `example-outcomes.negctl.mjs` | Would that check **notice**? Six mutants — the pre-run warning removed, the unavailable profile declared as available, the runnable lab's model card deleted, the Run control made unaddressable, a catalog entry pointing at a payload that does not exist, and the only un-runnable lab removed from the catalog — each required to turn the check red for its own stated reason. The control case runs first. |
| `spice-import.mjs` | Can a user actually get a netlist in, and what happens to its `.include` lines? Clicks the real **Import SPICE** label in a real browser with file-chooser interception on, and requires Chrome to report the chooser event before it hands any files over. Then reads the product's own sentence back: four spellings must import, and two controls must still refuse. |
| `spice-import.negctl.mjs` | Would that guard **notice**? Two mutants against real copies, each pinning one half of the repair: emptying the pool must turn exactly `bare-unselected` red while `header-form` stays green, and deleting the local-only guard must turn exactly `absolute-include` red. Both channels are required to see each mutant, with `check 15` naming it. `--static-only` runs without a browser. |
| `gallery-shim.mjs` | Can the Gallery panel work on a static deploy? Drives the panel in a real browser on two trees. On the committed tree the gallery must stay **dark** while the two list endpoints stop being 404s; on a copy with a two-entry `gallery/` the panel must **light**. The preview image loads from its revisioned URL, and clicking a card opens the circuit. |
| `gallery-shim.negctl.mjs` | Would that guard **notice**? Ten cases against real copies, including two controls, and the case the whole check exists for: `route-after-api-return` moves the dispatch behind `if (isSameOriginApi(...)) return;` — every string the shim consists of is still present exactly once, a text search finds a perfectly healthy shim, and the four endpoints are 404s. Nothing but an ordered assertion, or a browser, can see it. `--static-only` runs the whole suite without a browser. |
| `shell-cache.mjs` | Does the constant `sw.js` opens its cache under still describe **this tree**? The token is **derived, not chosen**: a SHA-256 over the bytes these routes could store — the `shellUrls()` members, every extension a resource tag can request, and everything under `ENGINE_PAYLOAD_DIRS` — plus those two declarations. A file the worker can never be asked for (a licence text, a release manifest) is deliberately *not* hashed. `--write` restores it; `--check` (the default) reports. |
| `shell-cache.negctl.mjs` | Would check 13 **notice**? Nine mutants — a chunk patched while its content-hashed filename stays, a model card patched, the constant set by hand, the constant deleted, `activate()`'s retirement prefix narrowed, a directory added to `ENGINE_PAYLOAD_DIRS`, a member dropped from `shellUrls()`, `install()` re-pointed at a cache name outside the prefix, and a file added that this worker can never be asked for (which must **not** move the token) — each required to produce its own outcome. Both channels run. `--static-only` runs without a browser. |
| `corner-sweep.negctl.mjs` | Would the corner feature **notice** if it broke? Fifteen cases against real patched copies: a control, the unpatched tree, the corner list emptied or re-ordered, the selector emission dropped, mapped to the wrong value, given an extra branch, or having the typical corner map to a non-zero selector, the emitted `.param` renamed, the descriptor or the run record stripped, the library's base model moved or a device left unmodelled, a manifest that declares a corner the artifact does not implement, and a manifest that is vacuous. Each must turn check 14 red for its own named reason. |
| `stability-margin.oracle.mjs` | Is the margin **right**? Lifts the evaluator out of the shipped bytes and runs it against closed forms and invariances: a constant −20 dB/decade loop must yield the textbook numbers, an **inverting** loop must report the same margins as its non-inverting twin, a phase that merely passes through 0° must not be read as a crossing, a loop that never crosses must refuse *with a reason*, and every accepted record must carry the schema's own `evidence` aggregate. 69 assertions; it cannot see the screen. |
| `stability-margin.mjs` | Does the margin reach the **screen**? Drives a real browser through the built-in lab's Run control and reads the rendered measurement table back, asserting the row is drawn *in the table's shape*, that both metrics appear, that each value agrees with its **own** unit — `deg` for the phase, `dB` for the gain — that a refusal carries its reason, and that the panel's own count of rendered measurements matches the rows found. `--fixture=center-magnitude` answers the observation gap (the committed example's AC never crosses 0 dB). Needs a real browser. |
| `stability-margin.negctl.mjs` | Would check 18 and the two margin channels **notice**? Nineteen cases against real copies, opening with two controls. Then: the evaluator renamed by one character, the splice reverted while the evaluator stays intact, the enum extended in only **one** of its two variants, the emitted unit replaced by the output's own, the metric renamed on the emitting side only, the authoring tables re-populated through the label table **and** through the method selector, a manifest with no contract, and a per-property sweep that reverts one correct behaviour at a time. `--static-only` runs the whole suite without a browser. |
| `region-annotate.manifest.cjs` | Where does the operating-region table come from? Parses the eight LEVEL=1 models out of `site/models/cmos.lib` into `[typical, corner-coefficient]` pairs — written as powers of ten, so `200u` lands as `0.0002` rather than `0.00019999999999999998` — takes the injected runtime from `region-annotate.runtime.js`, normalises a patched tree back to its unpatched form **in memory**, and asserts every precondition in both forms before it writes, including that each `requires` survives the patch that would otherwise consume it. |
| `region-annotate.oracle.mjs` | Is the region **right**? Lifts the injected runtime out of the shipped bytes and runs it against structurally built operating points and an independently written body-effect expression. Its sharpest assertion is an *identity*: the drain-current formula implied by the region the row claims reproduces the current the engine produced — 5.2e-10 relative on the shipped lab, while the other region's formula misses it by a factor of four. Also pins the corner map, the PMOS mirror, six refusal paths, and that the run's device list is not mutated in place. |
| `region-annotate.mjs` | Does the region reach the **screen**? Drives a real browser to the Operating Point tab on the shipped lab and requires the text the artifact's own function computes to be the text the card renders — character for character — then reads the corner out of the run and reconciles the parameters behind that line with the engine's own drain current. Needs a real browser. |
| `region-annotate.negctl.mjs` | Would check 19 and that channel **notice**? Nineteen cases against real copies, opening with two controls pointing in opposite directions. Then: one table parameter moved, a model dropped from the library, a LEVEL=1 model added to the exclusion list, the callsite reverted to the raw device list, each of the five clauses dropped in turn, and the table pasted into the schema chunk through **both** arms of the leak rule. Plus three manifest cases and a tree whose card is gone entirely, where the check must go quiet. |
| `corner-mapping.negctl.mjs` | Would check 20 **notice**? Six cases against real patched copies, opening with two controls: an unmutated tree that must stay clean, and a tree with `rgAnnotate` removed, which must report the feature `absent` rather than as a parse failure. Then four mutants of the corner→selector map — `ss`/`ff` swapped on the emitter, on the annotation, both together, and `tt` made to emit `__cn_sel=1`. Each mutant must be named for its own corner. |
| `panel-header.negctl.mjs` | Would check 21 **notice**? Four cases against real patched copies: a control that must stay clean, the outer header reverted to the defect form (both positive assertions fire), the per-output group header stripped of its leading count (the inner assertion fires alone while the outer stays clean), and function `Nt` removed entirely where the check must go quiet (`status absent`) rather than pass. Each mutant is anchored on the bytes the patched tree actually carries and must occur exactly once. |

---

## The outbound surface & CSP

Every outbound target the artifact can reach is inventoried in
`scripts/outbound-manifest.json`, with the evidence that classified it. A URL that
is not in that file fails the guard, so a rebuild that adds a host or re-points a
CDN cannot be published unreviewed. Two of the entries are `reachable: false` on
purpose — they record a URL that was read in context and ruled out, which is the
half of the audit that stops the next reader from re-deriving the same wrong
conclusion.

`node scripts/patch-outbound.mjs` repairs the outbound surface (the public feedback
link, and the integrity pin on the CDN fallback) and prints the new `site/sw.js`
cache value; `--check` reports without writing. The script is manifest-driven —
`--manifest=<file>` applies whatever repair set that file declares, which is how the
storage guards (`npm run patch:storage`) and the shell policy (`npm run patch:csp`)
are applied.

---

## Known deviations

Deviations that are known and attributable live in
`scripts/known-deviations.json`; they are printed with their reason, never silently
skipped, and an entry that stops matching is reported as a finding. The storage
acceptances there are keyed by `rel@offset`; because a patch that grows `App-*.js`
shifts every offset after it, those keys are re-derived after any such patch, and
check 10 reports the drift as stale acceptances rather than silently passing.

---

## CI

All of these run in CI: the source-level checks on the **deploy** job, before
`site/` is published; the browser checks on the **smoke** job. A build cannot ship
with a red deploy job, and a published site cannot stay red on the smoke job.
