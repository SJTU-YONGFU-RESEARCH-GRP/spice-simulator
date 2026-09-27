# SPICE Model Compatibility

## Problem

File presence and import-library reachability prove intake, not execution. A model
can be discoverable, statically plausible, and still fail in the shipped ngspice
WASM parser. This subsystem keeps those claims separate and records failures.
It does not change the model collection, import pool, UI or engine artifact.

## Usage and exit codes

Validated with Node 24; no npm dependencies or browser installation.

```sh
npm run model:compat
node scripts/model-compatibility.mjs site/models/ --runtime
node scripts/model-compatibility.mjs site/models/nmos_bsim3v3.ngspice --runtime --verbose
node scripts/model-compatibility.mjs site/models/ --runtime --json --output model-compatibility-report.json
npm run check:model:compat
npm run check:model:runtime
```

Default operation is static. `--runtime` also runs isolated DC probes, capability
controls, and best-effort failure localization. `--no-localize` disables reduction.
`--json` prints JSON instead of the table; both modes save the same report to the
ignored root `model-compatibility-report.json`. Custom output paths are the caller's
responsibility. An output path equal to an input is refused. Empty scans, missing
inputs and invalid arguments fail with structured `TOOL_001` diagnostics.

| Exit | Meaning |
|---|---|
| 0 | Input checks clean within the requested scope; static-only does not prove runtime |
| 1 | Warnings, expressions, partial vocabulary, or files without model cards |
| 2 | Invalid/unsupported input, model runtime failure, or failed capability control |
| 3 | Tool/engine initialization/protocol error; takes precedence over model failure |

`--help` exits 0. Runtime warnings never become a clean PASS. Capability-control
warnings are retained in their own evidence and do not make a clean input fail.
UNSUPPORTED refers to this tool's coverage, not proof that ngspice rejects a device.

## Architecture

| File under scripts/ | Responsibility |
|---|---|
| model-compatibility.mjs | Stable executable entry point |
| model-compatibility/parser.mjs | Logical lines, continuation, comments, model metadata, ordered parameters, source retention, dependencies |
| model-compatibility/rules.mjs | Family/LEVEL map, partial parameter vocabularies, conservative static diagnostics |
| model-compatibility/runtime-probe.mjs | Polarity-aware DC deck, child isolation/timeout, strict result classification |
| model-compatibility/probe-worker.mjs | Private stdin/JSON protocol; exactly one engine invocation per child |
| model-compatibility/failure-localizer.mjs | Bounded, cached complement reduction and removal controls |
| model-compatibility/reporter.mjs | Stable JSON, table, aggregate counts, capability evidence, exit priority |
| model-compatibility/cli.mjs | Sorted recursive scanning, argument handling, orchestration |
| lib/ngspice-runner.mjs | Shared engine adapter and ASCII rawfile parser extracted from numeric-crosscheck |
| model-compatibility/test/ | Layer tests, real WASM integration, negative controls and fixtures |

`numeric-crosscheck.mjs` uses the same extracted loader; its independent numerical
oracles remain unchanged. Its mutation driver rebases the shared module URL when
moving mutants into a temporary directory. No second engine implementation is used.

## Static analysis and diagnostics

The parser retains model name, device type, declared/effective LEVEL, VERSION,
parameter occurrences and unique names, card source, declaration line, `.param`
context, and include/lib directives. Continuations, parentheses, quoted/braced
expressions, case-insensitive names, SPICE suffixes, and inline comments are handled.
Parameter line fields currently identify the enclosing declaration, not the exact
continuation line. Duplicate parameters are preserved and warned about.

Missing MOS LEVEL uses the engine's conventional LEVEL=1 with a warning. Noninteger
or malformed LEVEL is INVALID; levels outside the matrix are UNSUPPORTED. Unknown
parameters are warnings against an explicitly partial vocabulary, not a definitive
list of parameters the engine rejects. Expressions are retained and warned about,
not evaluated in JavaScript. VERSION accepts dotted release identifiers.

Stable diagnostic families:

| Code | Meaning |
|---|---|
| SPICE_PARSE_001..006 | Declaration, delimiter, assignment, continuation, duplicate model, no cards |
| MODEL_LEVEL_001..003 | Unknown level, defaulted level, malformed level |
| MODEL_PARAM_001..004 | Partial-vocabulary miss, duplicate, numeric error, expression |
| MODEL_TYPE_001 / MODEL_DEP_001 | Uncovered device / unresolved context |
| ENGINE_PARSE_002 | Parser-related execution evidence |
| ENGINE_RUNTIME_001 / ENGINE_RESULT_001 | Runtime error / invalid or absent result |
| ENGINE_WARNING_001 | Engine warning retained alongside valid result |
| ENGINE_SETUP_001..002 / ENGINE_TIMEOUT_001 | Initialization/worker protocol / bounded timeout |
| LOCALIZE_001 / TOOL_001 | Reduction conclusion / CLI or filesystem error |

Rows contain independent `static` and `runtime.status` fields. A static PASS never
sets runtime PASS. Reports use schemaVersion=1, source/engine SHA-256, stable key/file
ordering, and no wall-clock timestamps, durations, or rawfile dates. Important
stdout/stderr lines are retained separately; variable names and point count are
included. Byte stability assumes identical inputs, engine, host and options.

## Runtime probe

The adapter drives **site/vendor/ngspice.js**, the shipped Emscripten/WASM module,
with the existing harness's `/proc` stubs, ASCII rawfile setting and `ngbehavior=lt`.
Every model and reduction candidate gets a fresh Node process, temporary engine
module and virtual filesystem. A 15-second timeout and 4 MiB output bound isolate
failures; one failed card does not poison later cards. Temporary modules are removed
in a finally block during normal worker completion; forced termination can leave a
small OS temporary directory for later system cleanup.

Each MOS gets W=10u, L=1u, signed VDS=1V and a 19-point signed VGS sweep from 0 to
1.8V. PASS requires exit 0, no engine error/exception, the expected DC plot and
voltage/current variables, exactly 19 complete points, and finite values. Warnings
with valid results remain WARNING. No rawfile is always failure.

The default runtime scope is the original individual card with top-level `.param`
context, not the entire library or the browser import path. Include/lib and scoped
cards are explicitly skipped pending dependency/section resolution. Integration
tests additionally mount both real BSIM3 files unchanged in the virtual filesystem
and reproduce their failures through `.include`.

## Failure localization

The reducer first requires a working LEVEL-only baseline, then verifies that a
normalized full card reproduces the original failure signature. It removes ordered
parameter chunks while preserving that signature, with at most 64 unique probes.
It checks each final parameter's removal as a negative control. Output includes
suspected occurrences, executable reduced card, original reproduction command,
baseline/failing/removal evidence, budget state and confidence.

High confidence means a reproducing **one-minimal subset**, conditional on the
fixed LEVEL, fixture and engine: removing any remaining candidate makes the probe
run. It does not mean a unique physical root cause, globally smallest subset, or
that removing these parameters repairs the complete model. Medium confidence marks
unverified minimality or exhausted budget; failed baseline, changed signature and
nonreproducing normalized source yield INCONCLUSIVE. Timeouts are not localized.

## Current compatibility matrix

Measured against the shipped engine on branch base `ff40fc9`, Node 24 on Windows.
The report records the exact engine SHA-256. Family aliases follow the existing
numeric harness's ngspice mapping; theoretical family support alone is not evidence
that this build executes an arbitrary card.

| Family | LEVEL | Shipped minimal NMOS and PMOS probes |
|---|---|---|
| MOS1 | 1 | PASS |
| MOS2 | 2 | PASS |
| MOS3 | 3 | PASS |
| BSIM3 | 8, 49 | Valid results with geometry warnings; VERSION=3.3.0 |
| BSIM4 | 14, 54 | PASS; VERSION=4.8.1 |

Static-only reports mark all shipped capabilities UNVERIFIED. Runtime reports
recompute this matrix; PROBE_VERIFIED allows execution with recorded warnings and
is scoped only to the displayed minimal cards.

| Actual collection input | Static | Runtime |
|---|---|---|
| cmos.lib: eight MOS cards | WARNING (parameter expressions) | Eight PASS |
| cmos.lib: two BJT cards | UNSUPPORTED by analyzer fixture | NOT_RUN |
| nmos_bsim3v3.ngspice | WARNING (duplicates/partial-vocabulary misses) | RUNTIME_FAILURE |
| pmos_bsim3v3.ngspice | WARNING (duplicates/partial-vocabulary misses) | RUNTIME_FAILURE |
| cap.lib, opamp.lib | WARNING (subcircuits, no model cards) | NOT_RUN |

Both real BSIM3 cards have 182 parameter occurrences. Both fail with
`strtod: Invalid argument`, engine exit 1, and no rawfile. In ten reduction probes
each, the reducer found this subset (use PMOS for the second model):

```spice
.model nmos_bsim3v3 NMOS
+ LEVEL=8
+ QMTCENCV=0.0
```

The LEVEL-only removal control produces a valid DC result, with expected BSIM3
warnings. Removing QMTCENCV from the full NMOS card **still fails**: there are other
incompatibilities. No model source was changed to manufacture a passing result.

## Verification and existing guard baseline

Layer tests cover parser/rules, positive/negative reduction, CLI exits and stable
JSON, engine errors, absent/nonfinite/truncated results, batch isolation, and real
NMOS/PMOS execution for all matrix levels. Negative controls include an unknown
parameter and a syntactically valid BSIM3 card with negative TOX: static PASS, actual
runtime failure. Existing numeric regression remains 21 cases / 46 assertions;
its five mutation controls are all detected after sharing the adapter.

The original `ff40fc9` snapshot is **not guard-clean** in a fresh checkout:
artifact check 15 has four BSIM3 embedded-library/manifest byte-drift findings;
check 13 finds a stale shell-cache token. The manifest/embedded strings contain
CRLF-sized versions while checked-in model files are LF. The derived token is
`icm-static-shell-1f023d2fe715`, versus declared `icm-static-shell-f0aacd149c32`.
The unchanged original snapshot reproduces the same five findings. Import negative
controls also fail their clean baseline and have an old three-library expectation.
These inherited failures are reported, not suppressed; this tooling change leaves
site artifacts, import manifests and their verification standards intact.

## Known limitations and future work

This is a conservative model-card analyzer, not a full SPICE preprocessor/compiler.
BJT/subcircuit execution, recursive dependency resolution, `.lib` corner selection,
`.func` and conditional preprocessing are not implemented. MOS-only fixture success
cannot prove all biases, analyses, dimensions, corners, convergence, numerical
accuracy, parameter acceptance, or GUI reachability. Parameter expressions and
partial vocabularies deliberately prevent overconfident static results. Unknown
engine warnings may need additional classifier rules as engine versions change.

Next steps are dependency-aware virtual filesystems, device-specific fixtures,
engine-derived parameter catalogs, multiple independent failure subsets, and
numeric reference comparisons. Repairing the inherited artifact integrity drift
requires a separate manifest-driven artifact change and shell-cache update.
