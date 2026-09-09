# SPICE Simulator

[![License: CC BY 4.0](https://img.shields.io/badge/License-CC%20BY%204.0-green?logo=creativecommons&logoColor=white)](https://creativecommons.org/licenses/by/4.0/)
[![JavaScript](https://img.shields.io/badge/javascript-ES%20modules-F7DF1E?logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![Version](https://img.shields.io/badge/version-0.1.0-blue?logo=semver&logoColor=white)](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator)

**Repository:** [SJTU-YONGFU-RESEARCH-GRP/spice-simulator](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator)

**Live demo:** [https://sjtu-yongfu-research-grp.github.io/spice-simulator/](https://sjtu-yongfu-research-grp.github.io/spice-simulator/)

Browser SPICE-like circuit simulator (vanilla ES modules). JS MNA engine for DC / TRAN / AC / NOISE / TF, plus optional ngspice WASM. Because it is a **JavaScript platform**, simulation runs in each user’s browser and **circuit data is retained by the individual** (local `localStorage`), not by a shared backend.

## Table of contents

- [Privacy and data retention](#privacy-and-data-retention)
- [Quick start](#quick-start)
- [Fork and self-host](#fork-and-self-host)
- [Analyses (JS engine)](#analyses-js-engine)
- [Engines](#engines)
- [Deploy (GitHub Pages)](#deploy-github-pages)
- [Public vs private lab](#public-vs-private-lab)
- [Layout](#layout)
- [License](#license)

## Privacy and data retention

- Netlists, theme, and UI preferences stay in the **browser** on that machine / profile.
- The JS (and optional ngspice WASM) engines run **in the page**; default simulation does not upload netlists to our servers.
- Fork or clone to host your own copy so students and labs keep data under their own site or local system.

## Quick start

```bash
node scripts/serve.mjs
```

Open [http://localhost:5173](http://localhost:5173). Hit **Run** (or F5). Cycle **Example** for sample netlists.

```bash
node scripts/smoke.mjs   # or: npm test
```

No build step and no npm install required for local use.

## Fork and self-host

1. Fork [SJTU-YONGFU-RESEARCH-GRP/spice-simulator](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator).
2. Enable **GitHub Pages** via Actions on the fork (workflow publishes `release/`), **or** serve locally with `node scripts/serve.mjs`.
3. Point users at your Pages URL or `http://localhost:5173`.

Details for the public bundle live in [`release/README.md`](release/README.md).

## Analyses (JS engine)

| Command | Notes |
|---|---|
| `.op` / `.dc` | Operating point |
| `.dc Vsrc start stop step` | DC source sweep (plot `i(Vsrc)`, `v(n)`) |
| `.dc V1 … V2 …` | Nested DC (family curves, e.g. MOS Id–Vds) |
| `.tran tstep tstop [UIC] [ADAPTIVE]` | Transient (trap + optional adaptive) |
| `.ac dec\|lin\|oct N fstart fstop` | Small-signal Bode |
| `.disto [V(out)] dec\|lin\|oct N fstart fstop` | Harmonic distortion vs freq (TRAN+Fourier → HD2/HD3/THD) |
| `.pz [V(out)]` | Poles of linearized (G+sC) at DC bias |
| `.mc N [seed=…]` | Monte Carlo DC; mark R/C/L with `lot=10%` / `dev=` |
| `.noise V(out) src …` | Noise density + ∫rms |
| `.tf V(out) src` | Transfer, Zin, Zout |
| `.step param …` | Parameter sweeps / overlays |
| `.four f0 v(out)` | Fourier / THD after TRAN |
| `.print [tran|dc|ac] signals…` | Prefer signals in the plot list |
| `.meas` / `.param` / `.func` / `.include` / `.temp` | Measures (MAX/MIN/PP/AVG/RMS/AT/WHEN/TRIG–TARG + FROM/TO), params, funcs, libraries |
| `.ic V(n)=…` | Hard initial conditions (UIC / caps); also `C… IC=` / `L… IC=` on device lines |
| `.nodeset V(n)=…` | Soft NR initial guess for DC / TRAN |
| `.option …` | `temp` `tnom` `reltol` `abstol` `vntol` `gmin` `gminsteps` `srcsteps` `itl1` `method=trap\|gear` |

Devices: R L C V I D M Q E G F H S W B, `K` coupling, `X` + `.subckt`, built-in `OPAMP`.

Passives: `R1 a b 1k tc1=0.001 tc2=0` (temp coeffs vs `tnom`); `C1 out 0 1u IC=5` / `L1 … IC=` with `.tran … UIC`; `L1 a b 1m Rser=0.5` / `C1 a b 1u Rser=0.1` series resistance.

Diode `.model D (Is=… N=… Rs=… BV=… Cjo=… TT=… IKF=… ISR=… NR=…)`.

MOS `.model NMOS (Vto=… Kp=… Lambda=… Cgso=… Cox=… RD=… RS=…)`.

BJT `.model NPN (Is=… Bf=… Vaf=… Cje=… Cjc=… Tf=… RE=… RC=… RB=… IKF=…)`.

AC: Bode `db(v(…))` / `ph(v(…))` with continuous phase unwrap; selecting both uses dual Y axes in the plot.

Waveform **XY** mode: first selected signal → X axis, remaining → Y (Lissajous, parametric I–V). Netlists mentioning `Lissajous` / `XY` auto-enable it.

Sources: `DC`, `AC`, `PULSE(...)`, `SIN(vo va freq [td [theta [phase]]])`, `PWL(t1 v1 …)`, `EXP(v1 v2 td1 tau1 [td2 tau2])`, behavioral `B n+ n- V=expr` / `I=expr`.

## Engines

- **JS** — default in-browser MNA solver
- **ngspice** — vendored WASM (`vendor/ngspice.js`), runs in a Worker

## Deploy (GitHub Pages)

Site: [https://sjtu-yongfu-research-grp.github.io/spice-simulator/](https://sjtu-yongfu-research-grp.github.io/spice-simulator/)

```bash
# From WSL (recommended)
cd /mnt/d/proj/spice-simulator
chmod +x scripts/release.sh
./scripts/release.sh 0.1.0          # exact version (first release)
./scripts/release.sh                # patch bump
./scripts/release.sh minor
./scripts/release.sh --dry-run

# From Windows PowerShell → WSL
wsl -e bash -lc 'cd /mnt/d/proj/spice-simulator && ./scripts/release.sh'
```

Push to `main`/`master`. Workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) builds `release/` and publishes it to the **`gh-pages`** branch.

One-time GitHub setting (needed for the site URL to resolve):

1. Open [repo Settings → Pages](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator/settings/pages)
2. **Build and deployment → Source**: Deploy from a branch
3. Branch: `gh-pages` / `/ (root)` → Save

## Public vs private lab

| Repo | Role |
|---|---|
| [spice-simulator](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator) (public) | Open-source code + Pages site |
| [spice-simulator-lab](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab) (private) | Issues / shared circuits; tracks this repo as a submodule |

See [docs/REPO_LAYOUT.md](docs/REPO_LAYOUT.md) and [docs/PRIVATE_LAB_BOOTSTRAP.md](docs/PRIVATE_LAB_BOOTSTRAP.md).

## Layout

```
index.html          UI shell
src/netlist/        parse, .param, .include, .step, .subckt
src/engine/         MNA, TRAN/AC/NOISE/TF/DC, FFT, ngspice
src/ui/             waveform, schematic, CSV/VCD/golden
lib/models.cir      sample library
scripts/serve.mjs   local static server
scripts/build-release.mjs   obfuscated Pages bundle → release/
```

## License

Licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). See [LICENSE](LICENSE).

Third-party assets (for example vendored ngspice) remain under their respective licenses.
