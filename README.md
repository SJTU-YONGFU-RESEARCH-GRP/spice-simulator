# SPICE Simulator (schematic editor)

Browser schematic editor with in-browser ngspice (WASM).  
**This is the Vite app you run locally at** `http://127.0.0.1:5173/` — not the older vanilla netlist-only MNA demo.

## Public site

https://sjtu-yongfu-research-grp.github.io/spice-simulator/

## Develop (editor)

```bash
cd /mnt/d/proj/analog-canvas-js   # or d:\proj\analog-canvas-js
pnpm install
pnpm --filter @icm/editor dev    # → http://127.0.0.1:5173/
```

## Publish the editor to GitHub Pages

From WSL:

```bash
cd /mnt/d/proj/spice-simulator
chmod +x scripts/publish-editor-pages.sh
./scripts/publish-editor-pages.sh
```

That builds `@icm/editor` with `base=/spice-simulator/`, copies into `./site`, commits, and pushes. CI deploys `site/` → `gh-pages`.

## Version tags

```bash
./scripts/release.sh 0.2.0   # bump VERSION + tag (after publishing site/)
```

## Private lab (issues)

Shared circuits / GitHub Issues live on private  
[`spice-simulator-lab`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab) — not on this public Issues list.

See [docs/REPO_LAYOUT.md](docs/REPO_LAYOUT.md).

## License

The shipped editor is based on Analog Canvas (AGPL). See `site/LICENSE.md` / `site/NOTICE.md` after a publish.
