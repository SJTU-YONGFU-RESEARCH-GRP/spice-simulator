# SPICE Simulator (schematic editor)

Public GitHub Pages host for the Vite schematic editor  
(local: `http://127.0.0.1:5173/` from the editor source tree).

**Site:** https://sjtu-yongfu-research-grp.github.io/spice-simulator/

## Develop

This repository is the deployable Pages shell; the editor source is kept in
the sibling private workspace referenced below. You can still validate the
checked-in site and Worker changes without that workspace:

```bash
npm install
npm test
npm run verify:site
```

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

Trust and data-boundary checks are documented in
[`docs/PHASE1_STATUS.md`](docs/PHASE1_STATUS.md) and
[`docs/DATA_STATES.md`](docs/DATA_STATES.md). The checked-in shell can validate
the public bundle, release metadata, project round trips, ERC, and netlist
goldens; the private editor source is required to regenerate the UI.

The source-independent Phase 2 workflow contract and Gallery case definitions
are in [`docs/PHASE2_WORKFLOW_CONTRACT.md`](docs/PHASE2_WORKFLOW_CONTRACT.md).
They are validated by `npm run test:workflow-contract`, but remain marked
`blocked-source-unavailable` until the editor source is supplied.

The verifiable workflow artifact contract (project migration, deterministic
netlist/provenance, stale-result detection, and result bundles) is documented
in [`docs/WORKFLOW_ARTIFACTS.md`](docs/WORKFLOW_ARTIFACTS.md) and tested with
`npm run test:workflow-artifacts`.

`npm run release:dry` and the publish script are intended for WSL because the
source build uses `pnpm` and Bash. `scripts/publish-editor-pages.sh --no-push`
now performs the full build and local commit without contacting the remote;
use `--dry-run` to skip both commit and push.

Legacy vanilla MNA simulator code has been removed from this repository.

## Private lab

Issues: [`spice-simulator-lab`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab)

## License

Shipped UI is a SPICE Simulator build derived from SPICE Simulator (AGPL). See `site/LICENSE.md` / `site/NOTICE.md`.
