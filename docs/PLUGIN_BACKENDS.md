# Pluginized model and analysis backends

This release repository defines the second roadmap part without touching the
published editor bundle. The contract is implemented in
[`scripts/plugin-backend.mjs`](../scripts/plugin-backend.mjs).

## Profile contract

An editor profile has an `id`, `label`, `devices`, `analyses`, and
`capabilities`. Each device declares pins, parameters, model requirements,
model status, and a netlist emitter descriptor. Model profiles additionally
declare model files, file hashes, supported analyses, temperature/corner
limits, input/output limits, license/source, and availability.

The allowed model states are:

```text
available | missing | built-in | requires-model | unsupported | invalid
```

`ProfileRegistry` rejects duplicate IDs and malformed profiles before the UI
can display them.

## Analysis and backend contracts

Analysis plugins implement `validate`, `buildDeck`, `parseResult`,
`explainError`, and a measurement list. The release contract includes local
deterministic implementations for `op`, `dc`, `ac`, and `tran`; these produce
deck text for tests and do not invoke a real solver.

Backends expose `prepare`, `run`, `cancel`, `parseResult`, and `explainError`,
plus explicit capabilities for analyses, devices, cancellation, waveforms,
measurements, and result export. `negotiateCapabilities` returns supported
features and stable diagnostics for unsupported devices, analyses, models, or
backend features. The UI must consume this result instead of assuming every
backend supports the same feature set.

`createFixtureBackend` is intentionally offline and deterministic. It is a
contract adapter for CI, not an ngspice/WASM implementation. A real adapter
belongs in the unavailable editor source repo and must preserve the existing
workflow provenance fields (`modelProfileId`, `modelHashes`, `analysis`, and
`solver`).
