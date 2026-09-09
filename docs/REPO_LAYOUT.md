# Dual-repo layout (public + private lab)

| Repo | Visibility | Role |
|---|---|---|
| [`SJTU-YONGFU-RESEARCH-GRP/spice-simulator`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator) | **Public** | Pages host for the schematic editor (`site/`). No student Issues. |
| [`SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab) | **Private** | GitHub Issues for shared `.icproj` submissions; tracks the public repo as a submodule. |

## Public repo layout

```
site/                         # Vite editor build (what Pages serves)
scripts/publish-editor-pages.sh
scripts/release.sh
docs/
```

Editor **source** lives in `analog-canvas-js` (local/private development). Publish:

```bash
cd /mnt/d/proj/spice-simulator
./scripts/publish-editor-pages.sh
```

## Private lab

```bash
git submodule add https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator.git spice-simulator
```

Enable Issues + label `icproj` on the lab repo only.

## Privacy

Country/city on issue shares are optional with consent. **IP addresses are never written into issue bodies.**
