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

Editor **source** lives in a local/private sibling checkout (`../spice-simulator-editor` or legacy `../analog-canvas-js`). Publish:

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

- Designs stay local by default.
- Optional **Lab backup on Save/Export** posts to a private Cloudflare Worker.
- Worker hashes `CF-Connecting-IP` (salted) and upserts one GitHub Issue per actor on `spice-simulator-lab`.
- **IP addresses are never written into issue bodies.**
- There is no public “Share via GitHub Issue” menu.
