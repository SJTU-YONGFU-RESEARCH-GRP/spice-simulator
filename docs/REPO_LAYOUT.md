# Dual-repo layout (public + private lab)

| Repo | Visibility | Role |
|---|---|---|
| [`SJTU-YONGFU-RESEARCH-GRP/spice-simulator`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator) | **Public** | Open-source simulator + Pages site. Student-facing code; issues stay off this repo. |
| [`SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab) | **Private** | Instructor lab: GitHub Issues for shared `.icproj` submissions, internal notes, and the public tree as a **git submodule**. |

## Why two repos

- Opening the public simulator must not expose class submissions, IPs, or instructor unlock workflows in Issues.
- Share-via-GitHub-Issue in the editor targets **`spice-simulator-lab` only**.
- Country/city may be attached with user consent; **IP addresses are never written into issue bodies**.

## Public repo (`spice-simulator`)

```
src/ styles/ lib/ vendor/   # readable source (open source)
scripts/build-release.mjs   # produces obfuscated Pages bundle
release/                    # generated; what Pages deploys
```

Build the public bundle:

```bash
npm install
npm run build:release
```

GitHub Actions builds `release/` then deploys that folder to Pages (not the raw `src/` tree). Large PDK trees under `models/pdk/` are **not** copied into `release/` (Pages size); keep them in the repo for local work.

## Private lab (`spice-simulator-lab`)

Recommended layout on the private side:

```
spice-simulator-lab/
  README.md
  docs/                 # internal instructor docs
  .gitmodules
  spice-simulator/      # submodule → public SJTU-YONGFU-RESEARCH-GRP/spice-simulator
```

Add the public repo as a submodule (run inside the private clone):

```bash
git submodule add https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator.git spice-simulator
git commit -m "Track public spice-simulator as submodule"
```

Configure Issues on **lab** only:

1. Repo → **Settings** → **General** → Features → enable **Issues**.
2. Add label `icproj` (editor share links use it).
3. Do **not** enable student write access on the public repo Issues.

Optional: disable Issues on the public `spice-simulator` repo so accidental traffic cannot land there.

## Editor share target

`apps/editor` (Analog Canvas JS fork) uses:

```text
SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab
```

as `DEFAULT_GALLERY_ISSUES_REPO`. Change that constant only if the private lab is renamed.

## Obfuscation note

Release minification/mangling raises the bar for casual copying of the Pages bundle. It is **not** cryptographic protection: client-side unlock hashes and issue templates remain recoverable. Keep secrets (tokens, private keys) out of both repos; use Cloudflare Worker secrets if you later add a private results API.
