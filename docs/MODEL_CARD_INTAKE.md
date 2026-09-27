# Model-card intake

`scripts/model-card-intake.mjs` runs model cards through the **shipped engine**
(`site/vendor/ngspice.js`) and asks two questions of each one:

1. **Does it load at all, and if not, why?** Nothing in this tree ever asked.
   The deploy ships exactly one model library and an editor whose users are
   expected to bring their own cards; a card that the engine refuses is
   indistinguishable to the user from a card that is wrong, and both arrive as a
   failed run.
2. **Are the numbers it produces the numbers it declares?** This is the question
   [`VERIFICATION.md`](./VERIFICATION.md) records as open under "BSIM3/4
   absolute accuracy is currently **unproven**". It is answerable without any
   internal knowledge of BSIM.

The channel is `check:intake`; its negative control is `check:intake:neg`.

```bash
node scripts/model-card-intake.mjs --verbose     # or: npm run check:intake
node scripts/model-card-intake.negctl.mjs        # or: npm run check:intake:neg
```

---

## 1. The extraction, and the mistake that had to be fixed first

In strong inversion, at **constant** `Vds`, a MOSFET obeys

```
Id = 1/2 * KP * (W/L) * (Vgs - VTO)^2 * (1 + LAMBDA*Vds)
```

so `sqrt(Id)` is a straight line in `Vgs`: the **x-intercept is VTO** and the
**slope gives KP** (`KP = 2*slope^2 / ((W/L) * (1 + LAMBDA*Vds))`). Neither
number requires knowing what is inside BSIM — only that the model is a MOSFET in
strong inversion.

**Constant `Vds` is not a detail.** The first version of this extraction used a
resistive load, so `Vds` moved with `Vgs`, `(1 + LAMBDA*Vds)` stopped being
constant, the line curved, and the fit was biased:

| device (all exact by construction) | VTO error, resistive load | KP error, resistive load |
|---|---|---|
| `cmos.lib` `nmos_rvt`, tt | −1.77 % | +6.64 % |
| `cmos.lib` `nmos_rvt`, ss | −1.06 % | +7.24 % |
| `cmos.lib` `nmos_rvt`, ff | −2.94 % | +5.93 % |

The same decks, holding `Vds` with an ideal source instead:

| device | VTO error | KP error |
|---|---|---|
| `cmos.lib` `nmos_rvt`, tt | **0.000000 %** | **0.000000 %** |
| `cmos.lib` `nmos_rvt`, ss | **0.000000 %** | **0.000000 %** |
| `cmos.lib` `nmos_rvt`, ff | **0.000000 %** | **0.000000 %** |
| literal LEVEL-1 control card | 3e-9 (rel) | 2e-9 (rel) |

The values themselves, as recovered:

| corner | selector | VTO recovered / declared | KP recovered / declared |
|---|---|---|---|
| tt | `__cn_sel=0` | 0.499999998 / 0.5 | 2.00000000e-4 / 2.00000000e-4 |
| ss | `__cn_sel=1` | 0.579999998 / 0.58 | 1.70000000e-4 / 1.70000000e-4 |
| ff | `__cn_sel=-1` | 0.419999999 / 0.42 | 2.30000000e-4 / 2.30000000e-4 |

So the extraction is exact on a model whose law *is* the closed form — including
through the library's own expression path, `VTO={0.5+0.08*__cn_sel}`, and through
a nonzero `LAMBDA`. That is what licenses using it on BSIM.

---

## 2. What the cases assert

| case | kind | asserts |
|---|---|---|
| `shipped_library_tt` / `_ss` / `_ff` | recover | the artifact's own `site/models/cmos.lib` must BE the device it declares, at each corner |
| `control_level1` | recover | a literal LEVEL-1 card is recovered exactly. If this drifts, the extraction is at fault and every other recovery case is void |
| `bsim3_longchannel` | recover | BSIM3 with every second-order switch off: transconductance within 1 %, threshold within 40 mV of `VTH0` |
| `bsim4_longchannel` | recover | the same for BSIM4, at the loosest tolerance in the file |
| `reject_semicolon_dialect` | refuse | a card in the HSPICE/Spectre comment dialect must be REFUSED |
| `reject_param_name` | refuse | a misspelled parameter must be REFUSED |
| `reject_param_range` | refuse | an out-of-range value must be REFUSED, with its own reason class |

All expectations live in `scripts/model-card-intake.json` so they are auditable
without reading the driver, and so the negative control can mutate either side of
the pair — the card, or the expectation.

**Scope note.** The corner *ordering* (`ss < tt < ff`) is already covered by
`numeric-crosscheck.mjs` (`corner_shifts_every_device`) and is not repeated here.
What is new is parameter **recovery** and intake **classification**.

---

## 3. What the engine actually does with a card it cannot use

Three failure modes, measured. Two of them are the same message.

### 3a. Foreign comment dialect — `token-syntax`

ngspice does not treat `;` as a comment. The token becomes `0.7;` and the whole
parameter line dies in the tokenizer:

```
strtod: Invalid argument
ERROR: fatal error in ngspice, exit(1)
```

**Every card in
[`SJTU-YONGFU-RESEARCH-GRP/spice_model_collections`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice_model_collections)
is written in this dialect**, under a README that advertises the collection as
"ready-to-use transistor models across multiple SPICE simulators including
NGSPICE". Measured against this engine:

| card | verdict |
|---|---|
| `bsim/nmos_bsim1.ngspice` | refused (`strtod`) |
| `bsim/nmos_bsim2.ngspice` | refused (`strtod`) |
| `bsim/nmos_bsim3v3.ngspice` | refused (`strtod`) |
| `bsim/nmos_bsim4.ngspice` | refused (`parse`) |
| `bsim/nmos_level1.ngspice` | refused (`strtod`) |
| `bsim/nmos_level2.ngspice` | refused (`strtod`) |
| `bsim/nmos_level3.ngspice` | refused (`strtod`) |
| `bsim/pmos_bsim3v3.ngspice` | refused (`strtod`) |
| `ptm/180nm_bulk.pm` | refused (`strtod`) |
| `ptm/45nm_LP.pm` | loads |
| `ptm/22nm_LP.pm` | loads |

Eight of eight BSIM cards are refused, **including the LEVEL-1 card** — for a
model this engine certainly supports. The refusal is caused by the comment
dialect, not by anything about the devices.

### 3b. Misspelled parameter — `token-syntax`

The correct BSIM3 name is `PDIBLC1`; `pdibl1` is the spelling used in BSIM4/PTM
documentation, so it is a natural mistake. The engine does **not** warn and carry
on — it fails the entire card:

```
strtod: Invalid argument
```

— **the same message as 3a.** A misspelled parameter and a foreign comment
dialect are indistinguishable from the diagnostic. Neither is attributable by a
user reading it.

### 3c. Out-of-range value — `parameter-range`

`PCLM=0` is the natural way to write "no channel-length modulation". BSIM3's own
parameter checker refuses the value, and this is the only refusal that carries a
diagnosis:

```
Fatal: Pclm = 0 is not positive.
Fatal error: Fatal error(s) detected during BSIM3V3.3 parameter checking for n1 in model m1
```

That is why both reduction cards carry `pclm=1e-12` rather than `0`.

A fourth, milder mismatch found while reducing the cards: **BSIM4 rejects `NLX`**,
which is BSIM3-only, through the same `strtod` path; BSIM4 plays that role with
`lpe0`/`lpeb`.

---

## 4. Measured results: what the BSIM numbers now are

The roadmap item was: *prove the BSIM numbers, or scope them down.* These are
scoped.

### BSIM3 (level=8), long-channel limit

Reduced with `scripts/model-card-fixtures/bsim3-longchannel.card`: every
short-channel (`DVT*`), DIBL (`ETA0`, `PDIBL*`), series-resistance (`RDSW`),
mobility-degradation (`UA`/`UB`/`UC`), velocity-saturation (`VSAT`) and
bulk-charge (`K1`/`K2`) switch off, with `pclm=1e-12`.

- **Transconductance** recovers to within **+0.08 %** of the declared
  `U0 * Cox = 2.302040e-4 A/V^2` (`U0=600 cm^2/Vs`, `TOX=9 nm`). The engine is
  using the mobility and oxide thickness the card declares.
- **Threshold** sits **−24.7 mV** from the declared `VTH0`. Characterised:
  sweeping `VTH0` from 0.2 V to 1.0 V leaves the offset at **−0.024667 V**,
  constant to six decimals — it does not track `VTH0`. It does move with oxide
  thickness (−24.9 mV at 5 nm, −21.0 mV at 22 nm) and with temperature.
- The recovered threshold is **stable across fit windows** in deep strong
  inversion and drifts only as the window is extended into moderate inversion,
  which is BSIM3's deliberate `Vgsteff` smoothing:

  | fit window | VTO recovered |
  |---|---|
  | last 4 points (`Vgs >= 1.64`) | 0.474681 |
  | last 20 points (`Vgs >= 1.32`) | 0.474883 |
  | last 40 points (`Vgs >= 0.92`) | 0.480116 |
  | last 50 points (`Vgs >= 0.72`) | 0.502843 |
  | *LEVEL-1 control, every window* | *0.500000* |

### BSIM4 (level=14), long-channel limit

Under the **identical** switch-off set, BSIM4 retains a transconductance residual
of about **−2.7 %**, and it survives every further reduction tried:

| additional switch-off | recovered KP error |
|---|---|
| (baseline) | −2.746 % |
| `a0=0` | −2.746 % |
| `ags=0` | −2.746 % |
| `a0=0 ags=0 b0=0 b1=0` | −2.746 % |
| `a0=0 ags=0 dwc=0 dlc=0 xw=0` | −2.746 % |

**BSIM4 is less reducible than BSIM3.** The channel reports the number at a loose
bound rather than pretending the reduction is exact; that residual is the honest
shape of "BSIM4 absolute accuracy" as it stands.

---

## 5. What is claimed, and what is not

Stated plainly, because the difference matters:

- **Claimed.** In its long-channel limit the engine uses the BSIM3 mobility and
  oxide thickness the card declares, within 0.08 %; its threshold is 24.7 mV
  below the declared `VTH0` under the stated conditions. BSIM4 keeps a ~2.7 %
  transconductance residual under any reduction tried here.
- **Claimed.** The shipped `cmos.lib` behaves as the device it declares at all
  three corners, to 1e-8 relative.
- **Claimed.** A card written in the `;` dialect, or with a misspelled
  parameter, or with an out-of-range value, is refused by this engine — and the
  first two are indistinguishable from the diagnostic.
- **NOT claimed.** Any statement about BSIM3/4 accuracy *outside* the
  long-channel limit, or at bias points other than those exercised. The
  reduction switches second-order effects **off**; it says nothing about what
  they do when they are on.
- **NOT claimed.** Any diagnosis of *why* the threshold sits 24.7 mV low. Its
  **behaviour** was measured (constant in `VTH0`, varying with `TOX` and
  temperature); its **mechanism** was not identified, and no defect is asserted.
- **NOT claimed.** That `spice_model_collections` is wrong. Its cards are
  refused by *this* engine because of a comment dialect; whether they are valid
  for the simulators they were written for was not tested here.

---

## 6. Verification status

- The extraction is validated against a closed form (`control_level1`) and
  against the artifact's declared parameters at three corners, both to 1e-8.
- The negative control builds four mutants and asserts the channel goes red for
  each one's own reason: a changed card (`card_control_vto`), a re-introduced
  physical effect (`card_bsim3_k1_on`), a card that is no longer refusable
  (`card_dialect_repaired`), and an expectation that no longer matches the
  artifact (`expect_library_tt`).
- The BSIM tolerance bounds in `model-card-intake.json` were set from
  measurements taken on a **resistive-load** deck, before this channel used the
  constant-`Vds` topology. They are deliberately wider than those measurements
  and are to be **tightened against the first recorded run of this channel
  in its own topology** — not left as a permanent hedge.
