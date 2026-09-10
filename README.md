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

## Private lab

Issues: [`spice-simulator-lab`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab)

## License

Shipped UI is a SPICE Simulator build derived from SPICE Simulator (AGPL). See `site/LICENSE.md` / `site/NOTICE.md`.
