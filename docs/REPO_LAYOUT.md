# Dual-repo layout (public + private lab)

| Repo | Visibility | Role |
|---|---|---|
| [`SJTU-YONGFU-RESEARCH-GRP/spice-simulator`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator) | **Public** | Pages host for the schematic editor (`site/`). No student Issues. |
| [`SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab) | **Private** | GitHub Issues for shared `.icproj` submissions; tracks the public repo as a submodule. |

## Public repo layout

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
├── docs/                     # documentation
│   ├── VERIFICATION.md               # deep verification reference
│   ├── REPO_LAYOUT.md                # this file
│   └── PRIVATE_LAB_BOOTSTRAP.md
├── lab-sync-worker/          # optional Cloudflare Worker (private-lab backup)
├── .github/workflows/pages.yml
├── LICENSE
├── VERSION
└── README.md
```

> **Local-only working tree.** The maintainer keeps a separate `analysis/`
> directory of design write-ups and evidence (40+ documents) that is **not**
> published to this public repo. Public references to it are intentionally
> omitted; the authoritative public record of what was built and how it was
> verified is `README.md` plus `docs/VERIFICATION.md`.

Editor **source** lives in the maintainer's local/private sibling checkout of the
upstream project (`analog-canvas` / the editor source tree). Publish:

```bash
cd <local checkout of this repo>
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
