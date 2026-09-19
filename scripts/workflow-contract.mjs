const MODEL_STATUSES = new Set([
  "available",
  "missing",
  "built-in",
  "requires-model",
  "unsupported",
]);

const DIAGNOSTIC_ORDER = [
  "MISSING_DUT",
  "MISSING_TESTBENCH",
  "MISSING_TESTBENCH_GROUND",
  "MISSING_TESTBENCH_INPUT",
  "MISSING_TESTBENCH_OUTPUT",
  "MISSING_ANALYSIS_TYPE",
  "MODEL_UNAVAILABLE",
  "MODEL_REQUIRED",
  "MODEL_UNSUPPORTED",
  "ERC_FAILED",
];

function diagnostic(code, message, suggestedFix, target, extra = {}) {
  return {
    stage: extra.stage || "preflight",
    code,
    severity: "error",
    message,
    suggestedFix,
    target: target || null,
    retryable: extra.retryable ?? true,
    requiresDeckRegeneration: extra.requiresDeckRegeneration ?? false,
  };
}

export function preflightSimulation(state) {
  const diagnostics = [];
  const dut = state?.dut;
  const testbench = state?.testbench;
  const tbTarget = testbench?.id ? { kind: "testbench", id: testbench.id } : null;
  if (!dut?.id) {
    diagnostics.push(diagnostic(
      "MISSING_DUT",
      "Choose a device under test before running the simulation.",
      "Open the simulation setup and select or create a DUT.",
      { kind: "project", field: "dut" },
    ));
  }
  if (!testbench?.id) {
    diagnostics.push(diagnostic(
      "MISSING_TESTBENCH",
      "Choose a Testbench before running the simulation.",
      "Open the simulation setup and select or create a Testbench.",
      { kind: "project", field: "testbench" },
    ));
  }
  if (testbench && !testbench.groundNode) {
    diagnostics.push(diagnostic(
      "MISSING_TESTBENCH_GROUND",
      "The Testbench has no ground node.",
      "Connect the Testbench ground to node 0 and validate ERC again.",
      { ...tbTarget, field: "groundNode" },
    ));
  }
  if (testbench && !testbench.inputNode) {
    diagnostics.push(diagnostic(
      "MISSING_TESTBENCH_INPUT",
      "Choose an input node for the Testbench.",
      "Select the driven input node in the Testbench settings.",
      { ...tbTarget, field: "inputNode" },
    ));
  }
  if (testbench && !testbench.outputNode) {
    diagnostics.push(diagnostic(
      "MISSING_TESTBENCH_OUTPUT",
      "Choose an output node for the Testbench.",
      "Select the node to measure in the Testbench settings.",
      { ...tbTarget, field: "outputNode" },
    ));
  }
  if (testbench && !testbench.analysis?.type) {
    diagnostics.push(diagnostic(
      "MISSING_ANALYSIS_TYPE",
      "Choose a simulation analysis type.",
      "Select transient, AC, or another supported analysis in the Testbench.",
      { ...tbTarget, field: "analysis.type" },
    ));
  }
  for (const model of state?.models || []) {
    if (!MODEL_STATUSES.has(model.status)) {
      diagnostics.push(diagnostic(
        "MODEL_UNAVAILABLE",
        `Model ${model.id || "(unnamed)"} has an unknown availability state.`,
        "Refresh the component library and select a supported model.",
        { kind: "model", id: model.id || null },
      ));
    } else if (model.status === "missing" || model.status === "available") {
      if (model.status === "missing") diagnostics.push(diagnostic(
        "MODEL_UNAVAILABLE",
        `Model ${model.id} is not available for this run.`,
        "Add the model reference or choose a built-in device.",
        { kind: "model", id: model.id },
        { requiresDeckRegeneration: true },
      ));
    } else if (model.status === "requires-model") {
      diagnostics.push(diagnostic(
        "MODEL_REQUIRED",
        `Model ${model.id} requires a model reference.`,
        "Attach the required model before generating the deck.",
        { kind: "model", id: model.id },
        { requiresDeckRegeneration: true },
      ));
    } else if (model.status === "unsupported") {
      diagnostics.push(diagnostic(
        "MODEL_UNSUPPORTED",
        `Model ${model.id} is not supported by the selected simulator.`,
        "Replace the device or choose a simulator with support for this model.",
        { kind: "model", id: model.id },
        { retryable: false, requiresDeckRegeneration: true },
      ));
    }
  }
  if (state?.erc?.ok === false) {
    diagnostics.push(diagnostic(
      "ERC_FAILED",
      "ERC found wiring errors that must be fixed before simulation.",
      "Open the ERC results and repair each highlighted object.",
      { kind: "erc" },
      { requiresDeckRegeneration: true },
    ));
  }
  diagnostics.sort((a, b) => DIAGNOSTIC_ORDER.indexOf(a.code) - DIAGNOSTIC_ORDER.indexOf(b.code));
  return { ok: diagnostics.length === 0, diagnostics };
}

export function searchComponents(catalog, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return [...catalog];
  return catalog.filter((item) => {
    const haystack = [item.name, item.category, ...(item.pins || []), ...(item.modelKeywords || [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function mapSimulationError(error) {
  const code = error?.code || "SIMULATION_FAILED";
  return {
    stage: error?.stage || "run",
    code,
    message: error?.message || "The simulator could not complete the run.",
    suggestedFix: error?.suggestedFix || "Inspect the retained deck and log, then retry after fixing the reported issue.",
    target: error?.target || null,
    retryable: error?.retryable !== false,
    requiresDeckRegeneration: error?.requiresDeckRegeneration === true,
  };
}

export function normalizeErcDiagnostics(items) {
  return items
    .map((item) => ({
      documentId: item.documentId || null,
      instanceId: item.instanceId || null,
      pinId: item.pinId || null,
      wireId: item.wireId || null,
      netId: item.netId || null,
      severity: item.severity || "error",
      code: item.code,
      message: item.message,
      suggestedFix: item.suggestedFix || "Inspect the highlighted object.",
    }))
    .sort((a, b) => `${a.code}:${a.documentId || ""}:${a.instanceId || ""}:${a.pinId || ""}`
      .localeCompare(`${b.code}:${b.documentId || ""}:${b.instanceId || ""}:${b.pinId || ""}`));
}

export function retainFailedRun(run) {
  if (!run?.deck || !run?.log) {
    throw new Error("A failed run must retain its generated deck and run log");
  }
  return {
    status: "failed",
    projectRevision: run.projectRevision || null,
    dutId: run.dutId || null,
    testbenchId: run.testbenchId || null,
    modelVersions: run.modelVersions || [],
    deck: run.deck,
    log: run.log,
    diagnostics: run.diagnostics || [],
    failedStage: run.failedStage || "run",
  };
}

export function measureWaveform(samples) {
  const values = samples.map((sample) => Number(sample.y)).filter(Number.isFinite);
  if (!values.length) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    min,
    max,
    mean,
    peakToPeak: max - min,
  };
}

export function waveformToCsv(waveforms) {
  const rows = ["x," + waveforms.map((waveform) => waveform.signal).join(",")];
  const length = Math.max(0, ...waveforms.map((waveform) => waveform.samples.length));
  for (let index = 0; index < length; index += 1) {
    const x = waveforms.find((waveform) => waveform.samples[index])?.samples[index]?.x ?? "";
    const values = waveforms.map((waveform) => waveform.samples[index]?.y ?? "");
    rows.push([x, ...values].join(","));
  }
  return `${rows.join("\n")}\n`;
}

export { MODEL_STATUSES };
