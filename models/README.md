# Device, capacitor & idea-opamp models

Shared educational Level-1 MOSFET/BJT cards, role capacitors, and behavioral idea opamps for `netlists/*.sp`.

## Include

From a deck under `netlists/`:

```spice
.include ../models/cmos.lib
.include ../models/cap.lib     ; when using Cout / Cc / bypass X* caps
.include ../models/opamp.lib   ; when using behavioral opamps
```

Do **not** re-inline `.model` / ideal-cap subckt cards in netlists. The Python bench expands `.include` relative to the netlist file before writing result workdirs (ngspice `cwd` is not the netlist folder).

## MOSFET flavors

| Model | Type | Role | VTO (V) | KP (A/V²) |
| --- | --- | --- | --- | --- |
| `nmos_rvt` | NMOS | Regular Vt | +0.50 | 200e-6 |
| `pmos_rvt` | PMOS | Regular Vt | −0.50 | 100e-6 |
| `nmos_nat` | NMOS | Native / near-zero Vt | 0.00 | 200e-6 |
| `nmos_dep` | NMOS | Depletion (Seok/SCM \(G{=}0\) CS) | −0.70 | 200e-6 |
| `nmos_hvt` | NMOS | High Vt | +0.70 | 200e-6 |
| `pmos_hvt` | PMOS | High Vt | −0.70 | 100e-6 |
| `nmos_tox` | NMOS | Thick oxide (~3.3 V I/O) | +0.70 | 80e-6 |
| `pmos_tox` | PMOS | Thick oxide (~3.3 V I/O) | −0.70 | 40e-6 |

`nmos_nat` (\(V_{TO}=0\)) is **off** at \(V_{GS}=0\) under Level-1 square-law. Use **`nmos_dep`** for published Seok / Cordova **gate-grounded** current sources (educational \(V_{TO}<0\) stand-in for a process native that still conducts in that bias).

### Transfer ($I_D$–$V_{GS}$)

![MOS Id-Vgs](plots/mos_id_vgs.png)

### Output family ($I_D$–$V_{DS}$, RVT)

![MOS Id-Vds](plots/mos_id_vds.png)

## BJT flavors

| Model | Type | Role | BF | VAF (V) |
| --- | --- | --- | --- | --- |
| `npn_l1` | NPN | Educational vertical NPN | 100 | 50 |
| `pnp_l1` | PNP | Educational vertical PNP | 50 | 30 |

Use these names on `Q*` cards (not `M*`).

### Gummel ($I_C$–$V_{BE}$)

![BJT Ic-Vbe](plots/bjt_ic_vbe.png)

## Temperature

All cards use `TNOM=27`.

| Device | Params | Educational intent |
| --- | --- | --- |
| MOSFET | `TCV=±1.5e-3` V/°C, `BEX=-1.5` | Vt shifts with T; mobility ~ `(T/TNOM)^BEX` |
| BJT | `XTI=3`, `EG=1.11`, `XTB=-1.5` | `IS`/`BF` temp via Gummel–Poon |

NMOS `TCV` is negative; PMOS `TCV` is positive so `|VTO|` falls as T rises.

![MOS Id-Vgs vs temperature](plots/mos_id_vgs_temp.png)

![BJT Ic-Vbe vs temperature](plots/bjt_ic_vbe_temp.png)

Deck example:

```spice
.temp 27
.step temp -40 125 10
```

## Monte Carlo (LOT)

Default is nominal (`.param mc=0`). Enable global process spread:

```spice
.param mc=1
```

| Param | Default (1σ) | Applies to |
| --- | --- | --- |
| `sig_vto_lot` | 20 mV | MOSFET `VTO` (N/P independent) |
| `sig_kp_lot` | 5% | MOSFET `KP` (relative) |
| `sig_is_lot` | 10% | BJT `IS` (relative) |
| `sig_bf_lot` | 10% | BJT `BF` (relative) |

Override sigmas in the deck before or after the include if needed. Values are educational, not foundry-calibrated.

**DEV (per-device mismatch)** is not auto-applied: Level-1 `.model` cards are shared across instances. `sig_vto_dev` / `sig_kp_dev` are provided for decks that build per-instance models or subckts.

![MOS Id-Vgs LOT MC (RVT overview)](plots/mos_id_vgs_mc.png)

**All MOSFET flavors** (rvt / nat / hvt / tox) — each is a full **ngspice n=10 000** LOT run:

![MOS Id-Vgs LOT MC all devices](plots/mos_id_vgs_mc_all.png)

![BJT Ic-Vbe LOT MC](plots/bjt_ic_vbe_mc.png)

**Why NPN/PNP look “flat” on a log Gummel plot:** `sig_is_lot=10%` is multiplicative on \(I_C\). On a log-\(I\) axis that is only ~0.04 decades, so the p5–p95 band is almost invisible. The BJT figure therefore also shows **\(I_C/I_{C,\mathrm{nom}}\)** (clear ±10% band) and a **\(V_{BE}\) @ \(I_C=1\,\mu\mathrm{A}\)** histogram (σ ≈ 2.6 mV ≈ \(V_T\cdot 10\%\)). `sig_bf_lot` mainly moves \(I_B\), not \(I_C\).

Characterization MC is a **full ngspice** LOT run with **n = 10 000** trials **per device** (7 MOS + 2 BJT). Per-device figures: `plots/mc_<model>_*.png`. Raw arrays: `models/char/mc_results/*.npz`.

## Regenerate plots

```bash
# families + temp + full 10k ngspice MC (parallel; ~15–25 min on a 16-thread machine)
python models/char/run_char.py

# MC only
python models/char/run_char.py --mc-only --mc-runs 10000 --workers 16
```

## Capacitors (`models/cap.lib`)

Ideal two-terminal caps wrapped as **role** (and optional **tech-tag**) subcircuits so discovery decks document *why* a C is present. Electrically identical to a bare `C` element.

```spice
.include ../models/cap.lib
Xcout vref 0   cap_out  c={Cout}
Xcc   vx   vref cap_comp c={Cc}
```

| Subckt | Default `c` | Role |
| --- | --- | --- |
| `cap_out` | `200p` | \(C_{\mathrm{out}}\) — VREF / load decoupling (`vref`→`0`) |
| `cap_comp` | `2p` | \(C_c\) — miller / mid-node compensation |
| `cap_bypass` | `10p` | Supply or bias-node bypass |
| `cap_mim` | `200p` | MIM-style name tag (ideal C) |
| `cap_mom` | `2p` | MOM-style name tag (ideal C) |

Bare `Cname n1 n2 {C}` remains valid; prefer `X… cap_*` when the capacitor is part of the VREF story (e.g. §IV.vii Cout/Cc). Open-PDK remaps leave these ideal caps unchanged.

## Idea opamps

Behavioral amplifiers beside the device cards (`models/opamp.lib`). Prefer these
for loop / buffer benches; use MOSFET/BJT cards for the reference core.

```spice
.include ../models/opamp.lib
X1 inp inm out vdd 0 opamp_se
X2 inp inm outp outm vdd 0 opamp_diff
```

| Subckt | Pins | Role |
| --- | --- | --- |
| `opamp_se` | `inp inm out vdd vss` | Diff-in → single-ended out |
| `opamp_diff` | `inp inm outp outm vdd vss` | Diff-in → differential out |

### Recommended non-ideal defaults (library defaults)

Tuned for **1.8 V** educational CMOS / IoT VREF work. Measured with ngspice-45 (WSL):

| Param | Default | Meaning | Measured (SE / DIFF) |
| --- | --- | --- | --- |
| `av0` | `10k` (80 dB) | DC open-loop gain | **80.0 dB** / **80.0 dB** |
| `gbw` | `1meg` (1 MHz) | Unity-gain frequency | **1.00 MHz** / **1.00 MHz** |
| `rin` | `100meg` | Differential input R | — |
| `rout` | `10k` | Series output R (OTA-ish) | — |
| `vos` | `1m` | Input offset | buffer err ≈ **1.6 mV** |
| `acm` | `10` | CM gain (CMRR ≈ 60 dB) | SE input-referred; DIFF shifts Voc |
| `swing` | `0.9` | Soft half-scale (± from mid) | — |
| `vocm` | `0.9` | DIFF output CM setpoint | DIFF only |

Ideal override (near-perfect teaching amp):

```spice
X1 inp inm out vdd 0 opamp_se av0=1e6 gbw=100meg rin=1T rout=1m vos=0 acm=0 swing=10
```

Measured ideal: **120 dB** DC gain, **100 MHz** GBW, buffer error **≪ 1 µV**.

### Characterization plots

```bash
python models/char/run_opamp_char.py
```

![SE DC](plots/opamp_se_dc.png)

![SE AC](plots/opamp_se_ac.png)

![SE buffer](plots/opamp_se_buffer.png)

![DIFF DC](plots/opamp_diff_dc.png)

![DIFF AC](plots/opamp_diff_ac.png)

![CM sweep](plots/opamp_cm.png)

### Verilog-A twins

`models/veriloga/opamp_se.va` and `opamp_diff.va` match the same equations/params.
Compile with OpenVAF in WSL (`openvaf …`), load `*.osdi`, instantiate with `N`
devices — see `models/veriloga/README.md`. Day-to-day benches should keep using
`opamp.lib` (`X` subcircuits); no OpenVAF step required.


`vref-discover` may assign MOSFET/BJT models, library capacitors, and library opamps. Architectures are **not** limited to 2T / SCM / Hybrid. Typical uses:

- **Native NMOS** — near-0 Vt diode / early turn-on path in 2T stacks
- **HVT N/P** — delayed / CTAT devices, intentional multi-Vt ΔVt cores
- **RVT N/P** — default diode loads and current-source devices
- **Thick-oxide N/P** — higher-voltage / I/O-style devices; weaker drive than thin-ox at same W/L
- **NPN / PNP** — bandgap / PTAT cores, \(V_{BE}\) references (explicit `Q` instances)
- **Role capacitors** (`models/cap.lib`: `cap_out`, `cap_comp`, …) — Cout / Cc / bypass when stability or AC load is intentional
- **Behavioral opamps** (`models/opamp.lib`: `opamp_se`, `opamp_diff`) — use while discovering opamp-assisted VREF loops; replace with a transistor OTA only after functionality is confirmed

## Open foundry PDKs (multi-PDK journal evidence)

Educational Level-1 above is for discovery. For Papers A/C robustness, use open PDK trees under [`pdk/`](pdk/README.md):

| Dir | Process |
| --- | --- |
| `pdk/sky130_fd_pr/` | SkyWater SKY130 |
| `pdk/gf180mcu_fd_pr/` | GF180MCU |
| `pdk/ihp-sg13g2/` | IHP SG13G2 (~130 nm) |

```bash
cd models/pdk && ./fetch.sh --all   # WSL / Git Bash; trees are gitignored
```
