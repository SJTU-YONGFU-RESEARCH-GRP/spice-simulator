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

Two fatal modes, both measured. Plus one observation whose mechanism was **not**
isolated, reported as such.

### 3a. Unknown parameter name — `token-syntax`

A parameter the model does not know is not warned about and not ignored. It fails
the whole card in the tokenizer:

```
strtod: Invalid argument
ERROR: fatal error in ngspice, exit(1)
```

The spelling used here is `pdibl1` for BSIM3's `PDIBLC1` — the name BSIM4/PTM
documentation uses, so it is a natural mistake. The diagnostic names the card's
**entire merged parameter line**, never the offending parameter:

```
Warning -- Version not specified on line "level=8 vth0=0.5 u0=600 tox=9n dvt0=0 ... voffcv=0"
strtod: Invalid argument
```

On a card with forty parameters that leaves the user nothing to search for. This
is the sharpest form of the intake problem: the engine refuses the card and
cannot say which part of it is wrong.

> **A correction, recorded because it was published.** An earlier revision of
> this channel asserted that the HSPICE/Spectre comment dialect — a trailing `;`
> on a parameter line — was a third fatal mode, and attributed the refusals in
> `spice_model_collections` to it. **That was wrong.** The channel's own fixture
> carrying `;` comments *loaded* when the case reached CI, so this engine
> tolerates them. The attribution was made from a local observation of the
> collection's files without ever running the fixture that encoded the claim;
> the fixture was removed rather than the claim kept.

### 3b. Out-of-range value — `parameter-range`

`PCLM=0` is the natural way to write "no channel-length modulation". BSIM3's own
parameter checker refuses the value, and this is the only refusal that carries a
diagnosis:

```
Fatal: Pclm = 0 is not positive.
Fatal error: Fatal error(s) detected during BSIM3V3.3 parameter checking for n1 in model m1
```

That is why both reduction cards carry `pclm=1e-12` rather than `0`.

A milder mismatch found while reducing the cards: **BSIM4 rejects `NLX`**, which
is BSIM3-only, through the same `strtod` path; BSIM4 plays that role with
`lpe0`/`lpeb`.

### 3c. An unresolved observation: `spice_model_collections`

Every card in
[`SJTU-YONGFU-RESEARCH-GRP/spice_model_collections`](https://github.com/SJTU-YONGFU-RESEARCH-GRP/spice_model_collections)
was run through this engine. The repository advertises itself as "ready-to-use
transistor models across multiple SPICE simulators including NGSPICE":

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

**Eight of eight BSIM cards are refused — including the LEVEL-1 card**, for a
model this engine certainly supports. But these cards were reduced to refusal
classes by a local run, and the **mechanism was never isolated**: the files carry
`;` comments *and* parameters well beyond the level they declare (`nmos_bsim3v3`
lists `VSATCV`, `EFCI_GLOBAL` and `DELVTRAND`, which are not BSIM3 parameters),
and a `;`-only fixture is tolerated. Which of those is responsible is **open**,
and turning it into an assertion is deliberately left out of the channel until it
is known — the claim that CI proved false is exactly the one that would have
shipped if this had been asserted on a hunch.

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

**What the first runs actually found.** Two hypotheses were put to the engine
before the arithmetic settled it, and both are recorded because the channel's own
numbers falsified the first:

| run | BSIM3 KP recovered | declared | error |
|---|---|---|---|
| fitted from mid-sweep (`keepFrom` 0.35) | 2.149541e-4 | 2.302040e-4 | −6.6 % |
| fitted deep in strong inversion (`keepFrom` 0.8) | 2.142342e-4 | 2.302040e-4 | −6.9 % |

Narrowing the window moved the answer by 0.3 pp. **The fit window was not the
cause** — an earlier draft of this section asserted that it was.

The cause was the channel-length-modulation correction. Holding `Vds` constant
makes `(1 + lambda*Vds)` a constant factor on the slope, which the extraction
divides out; but it was dividing out the LEVEL-1 library's `LAMBDA=0.05` on cards
whose `pclm` is `1e-12` — cards with no channel-length modulation at all. The
arithmetic leaves no room:

```
2.302040 / 2.142342 = 1.0746      against      1 + 0.05 * 1.5 = 1.075
2.302040 / 2.083656 = 1.1049      against      1.075 * 1.0278
```

`lambda` is now per-case, and the two numbers it recovers are the two measured
independently on resistive-load decks before this channel existed: BSIM3 at
**+0.04 %** of the declared `U0*Cox`, BSIM4 at **−2.70 %**. Two topologies, two
implementations, the same answer.

The deep-inversion window is kept — it is the regime where `Vgsteff -> Vgs - Vth`
exactly and the closed form is therefore the operative law — but it is kept on
principle, not because it repaired anything.

### What the channel records

Every recovery case emits its measured values as a workflow notice, so these are
read off the run rather than transcribed from a deck:

| case | VTO recovered | declared | KP recovered | declared | KP error |
|---|---|---|---|---|---|
| `shipped_library_tt` | 0.500000 | 0.5 | 2.000000e-4 | 2.000000e-4 | 0 |
| `shipped_library_ss` | 0.580000 | 0.58 | 1.700000e-4 | 1.700000e-4 | 0 |
| `shipped_library_ff` | 0.420000 | 0.42 | 2.300000e-4 | 2.300000e-4 | 0 |
| `control_level1` | 0.500000 | 0.5 | 2.000000e-4 | 2.000000e-4 | 0 |
| `bsim3_longchannel` | 0.474680 | 0.5 | 2.303018e-4 | 2.302040e-4 | **+0.042 %** |
| `bsim4_longchannel` | 0.481744 | 0.5 | 2.239930e-4 | 2.302040e-4 | **−2.698 %** |

The agreement is worth being explicit about, because it is the whole argument for
the method:

- BSIM3's measured threshold is **0.474680**. The resistive-load measurement above
  put it at 0.474681. BSIM4's is **0.481744** against 0.481702 there. Two
  topologies, agreement to five significant figures.
- The two KP values derived arithmetically from the previous run's numbers
  (`2.142342e-4 * 1.075` and `2.083656e-4 * 1.075`) landed on 2.303018e-4 and
  2.239930e-4 — the two values this run measured.
- The shipped library is recovered exactly at all three corners, through its own
  expression path. That is an artifact guard in its own right: it says the engine
  *is* the device `cmos.lib` declares, not merely that the file exists.

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
- **Claimed.** A card with a misspelled parameter, or with an out-of-range value,
  is refused by this engine — and for the first, the diagnostic names the card's
  whole merged parameter line rather than the offending parameter, so a user
  cannot tell which of forty parameters is wrong.
- **NOT claimed.** That a `;` inline comment is fatal. It is not: the channel's
  own fixture carrying them **loaded** in CI. An earlier revision claimed the
  opposite and attributed the `spice_model_collections` refusals to it; that is
  corrected in section 3.
- **NOT claimed.** Any mechanism for why `spice_model_collections`' cards are
  refused. The refusals were observed; the cause was not isolated, and no
  assertion rests on them.
- **NOT claimed.** Any statement about BSIM3/4 accuracy *outside* the
  long-channel limit, or at bias points other than those exercised. The
  reduction switches second-order effects **off**; it says nothing about what
  they do when they are on.
- **NOT claimed.** Any diagnosis of *why* the threshold sits 24.7 mV low. Its
  **behaviour** was measured (constant in `VTH0`, varying with `TOX` and
  temperature); its **mechanism** was not identified, and no defect is asserted.
- **NOT claimed.** That `spice_model_collections` is wrong. Its cards are
  refused by *this* engine; whether they are valid for the simulators they were
  written for was not tested here.

---

## 6. Verification status

- The extraction is validated against a closed form (`control_level1`) and
  against the artifact's declared parameters at three corners, both to 1e-8.
  **All four of those cases pass in CI.**
- The negative control builds four mutants and asserts the channel goes red for
  each one's own reason: a changed card (`card_control_vto`), a re-introduced
  physical effect (`card_bsim3_k1_on`), a misspelled parameter that has been
  corrected so the card loads (`card_param_name_repaired`), and an expectation
  that no longer matches the artifact (`expect_library_tt`).
- The BSIM tolerance bounds in `model-card-intake.json` are set wide of the
  measurements quoted in section 4, because those were taken on a **resistive**
  load before the channel used constant `Vds`. They are to be tightened against a
  recorded run of this channel in its own topology — not left as a permanent
  hedge.

### CI history

**Run 1** — `exit code 143` after 8 minutes, **no output at all.** Two plumbing
defects, neither in what the channel measures:

1. **The progress log never reached the log.** The case loop drove the engine with
   `execFileSync`, which blocks the event loop for the whole case. Node cannot
   drain an async stdout while the loop is blocked, so every line sat in a buffer
   and died with the process. Locally this is invisible, because a process that
   exits *normally* flushes on the way out.
2. **Nothing bounded a case.** A deck that never returns had no ceiling below the
   six-hour job default.

Fixed by making the loop `await`-driven, giving every case a 150 s timeout that
reports a hang as a *named* failure, and adding `timeout-minutes` to the job. The
child now writes its result to a **file** rather than to stdout, because a payload
written to an async pipe and followed by `process.exit()` can be truncated — and a
truncated payload arrives at the parent as invalid JSON, i.e. as a failed case,
which is the wrong story.

**Run 2** — `exit code 1` after ~20 s, every case executed. A guard failing the
way a guard should. But the reason lived in a step log, which needs repository
permissions to read, so the failure detail is now emitted as a **workflow
annotation** as well — annotations are readable through the public checks API, so
the reason a case failed stays visible to anyone reviewing the branch.

**Run 3** — the annotations named three failures and, in doing so, falsified one of
this document's own claims:

- `reject_semicolon_dialect` **loaded** — the `;`-dialect attribution was wrong,
  and is corrected in section 3. The fixture was removed; the assertion went with
  it rather than being kept on a hunch.
- `bsim3_longchannel` and `bsim4_longchannel` put KP 6.6 % and 9.5 % low.

**Run 4** — the `;` case is gone, the four LEVEL-1 cases and both refusal cases
pass, and the two BSIM cases still fail, by 6.9 % and 9.5 %. The fit window had
been narrowed in between, and that moved the answer by 0.3 pp — so the window was
not the cause, and the draft of section 4 that said it was is corrected there.
The cause was the channel-length-modulation correction: `2.302040 / 2.142342 =
1.0746` against `1 + 0.05 * 1.5 = 1.075`. The extraction was dividing out the
LEVEL-1 library's `LAMBDA` on cards that have no channel-length modulation.

**Run 5** — **green**, 53 s, all six steps: the four LEVEL-1 cases exact, both
refusal cases refused, and the two BSIM cases landing at +0.042 % and −2.698 %,
which is what run 4's arithmetic predicted for them. The mutation test runs after
the channel and passes, so the channel is not vacuous on a runner either.
