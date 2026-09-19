# Phase 2 workflow contract

The editor source is not present in this checkout, so this document defines
the integration boundary without pretending that the UI is wired. The source
repo must consume these shapes when it becomes available.

## Simulation preflight

Before generating a deck, the editor must validate a state object with:

```json
{
  "contractVersion": 1,
  "projectRevision": "project-revision-id",
  "dut": { "id": "dut-main", "documentId": "document-top" },
  "testbench": {
    "id": "tb-transient",
    "groundNode": "0",
    "inputNode": "VIN",
    "outputNode": "VOUT",
    "analysis": { "type": "tran", "start": "0", "stop": "10m", "step": "10u" }
  },
  "models": [{ "id": "resistor", "status": "built-in" }]
}
```

The preflight result is deterministic and actionable:

```json
{
  "ok": false,
  "diagnostics": [{
    "stage": "preflight",
    "code": "MISSING_TESTBENCH_OUTPUT",
    "severity": "error",
    "message": "Choose an output node before running the simulation.",
    "suggestedFix": "Open the Testbench and select the node to measure.",
    "target": { "kind": "testbench", "id": "tb-transient", "field": "outputNode" },
    "retryable": true,
    "requiresDeckRegeneration": false
  }]
}
```

Required checks are DUT, Testbench, ground, input, output, analysis type, ERC
success, and model availability. `requires-model` and `missing` are blocking;
`built-in` and `available` are runnable; `unsupported` is a clear non-runnable
diagnostic.

## Result and failure retention

Every run is associated with `projectRevision`, DUT/Testbench IDs, model
versions, generated deck, ERC/preflight diagnostics, run log, and a result
status. A failed run must retain the deck and log so that users can export or
retry without reconstructing the failure.

Waveform results use `{ signal, samples: [{x, y}], xUnit, yUnit }`. The release
repo contract helpers provide deterministic measurement and CSV serialization;
the editor source must connect them to its result panel, cursor, visibility,
and export controls.

## Gallery fixture status

The four JSON files under `test/fixtures/gallery/` are contract fixtures. They
describe the intended RC low-pass, common-source amplifier, CMOS inverter, and
differential-pair cases, including DUT, Testbench, model state, analysis,
measurements, and a deck preview. They intentionally set
`status: "blocked-source-unavailable"` and do not claim that the current
Pages bundle can open or simulate them.
