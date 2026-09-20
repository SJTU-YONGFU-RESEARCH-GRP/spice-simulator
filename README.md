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
node scripts/numeric-crosscheck.mjs
node scripts/numeric-crosscheck.negctl.mjs
node scripts/egress-integrity.mjs
node scripts/outbound-repair.negctl.mjs
```

or `npm run check:artifacts` / `npm run smoke` / `npm run check:numeric` /
`npm run check:numeric:neg` / `npm run check:egress` / `npm run check:egress:neg`.

| Check | Question it answers |
|---|---|
| `check-artifacts.mjs` | Is the bundle self-consistent — do its references resolve, is there no development JSX runtime or folded-`undefined` call site, is every network target in the tree classified? |
| `smoke-test.mjs` | Does the editor actually run — does a real simulation finish with zero uncaught errors? |
| `numeric-crosscheck.mjs` | Are the numbers **right** — does the shipped WASM agree with first-principles closed forms and with model-independent invariants (including for BSIM3/BSIM4, which have no closed form)? |
| `numeric-crosscheck.negctl.mjs` | Would the numeric guard **notice** if it broke? Mutates the guard and the deck and requires every mutant to fail. |
| `egress-integrity.mjs` | Does the third-party engine fallback actually **verify** what it downloads? Lifts the loader and hash helper out of the shipped chunk and runs them, including a tampered payload that must be refused *and never executed*. |
| `outbound-repair.negctl.mjs` | Would the outbound checks **notice** if they broke? Nine cases, incl. two controls, against deliberately weakened copies. |

All six run in CI before `site/` is published.

Every outbound target the artifact can reach is inventoried in
`scripts/outbound-manifest.json`, with the evidence that classified it. A URL
that is not in that file fails the guard, so a rebuild that adds a host or
re-points a CDN cannot be published unreviewed. Two of the entries are
`reachable: false` on purpose — they record a URL that was read in context and
ruled out, which is the half of the audit that stops the next reader from
re-deriving the same wrong conclusion.

`node scripts/patch-outbound.mjs` repairs the outbound surface (the public
feedback link, and the integrity pin on the CDN fallback) and prints the new
`site/sw.js` cache value; `--check` reports without writing.

Deviations that are known and attributable live in
`scripts/known-deviations.json`; they are printed with their reason, never
silently skipped, and an entry that stops matching is reported as a finding.

## Private lab

Issues: [`spice-simulator-lab`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab)

## License

Shipped UI is a SPICE Simulator build derived from SPICE Simulator (AGPL). See `site/LICENSE.md` / `site/NOTICE.md`.
