# Verifiable browser SPICE workflow artifacts

This release repository now defines a source-independent artifact contract for
the first roadmap part. It does not replace the editor's existing internal
schema (the published editor currently imports schema 47); instead, the
workflow envelope is versioned independently at `schemaVersion: 1` and carries
the editor project as a stable payload.

The contract is implemented in
[`scripts/workflow-artifacts.mjs`](../scripts/workflow-artifacts.mjs) and is
covered by local fixtures in `test/fixtures/workflow/`.

## Project envelope

The required fields are `schemaVersion`, `projectId`, `revision`, `name`,
`documents`, `instances`, `wires`, `nets`, `dut`, `testbench`, `models`, and
`metadata`. `exportProject` sorts object keys recursively, preserves unknown
fields, and emits a trailing newline so the result is stable in diffs.

Migration currently supports the explicit legacy `schemaVersion: 0` shape and
rejects unknown future versions. The migration is deliberately small; source
repo access is required before changing the editor's real project parser.

## Netlist manifest and provenance

`createNetlistManifest` records project/revision, document, DUT, Testbench,
netlist hash, model profile and hashes, analysis, emitter identity, and time.
`createProvenance` adds deck hash, solver identity, temperature, corner,
parameters, input/output file lists, log, and result status. Hashes are SHA-256
over exact UTF-8 content.

`exportResultBundle` and `importResultBundle` use these files:

```text
project.json
provenance.json
netlist.cir
deck.cir
simulation.log
result.json
waveforms.csv
```

Failed runs retain the same bundle files and carry diagnostics plus a failed
result status. `isResultStale` compares revision, netlist/deck hashes, model
profile, analysis, temperature, and corner so an old result cannot be silently
presented as current.
