export const MODEL_STATUSES = Object.freeze([
  "available",
  "missing",
  "built-in",
  "requires-model",
  "unsupported",
  "invalid",
]);

const MODEL_STATUS_SET = new Set(MODEL_STATUSES);
const ANALYSIS_IDS = new Set(["op", "dc", "ac", "tran"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export class PluginContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "PluginContractError";
    this.code = code;
    this.details = details;
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new PluginContractError("INVALID_PLUGIN", `${field} must be a non-empty string`, { field });
  }
}

export function validateModelProfile(modelProfile) {
  if (!isRecord(modelProfile)) throw new PluginContractError("INVALID_MODEL_PROFILE", "modelProfile must be an object");
  for (const field of ["profileId", "devices", "modelFiles", "analyses", "temperatures", "corners", "inputLimits", "outputLimits", "license", "availability"]) {
    if (!(field in modelProfile)) throw new PluginContractError("INVALID_MODEL_PROFILE", `modelProfile is missing ${field}`, { field });
  }
  requireString(modelProfile.profileId, "modelProfile.profileId");
  if (!Array.isArray(modelProfile.devices) || !Array.isArray(modelProfile.modelFiles) || !Array.isArray(modelProfile.analyses)) {
    throw new PluginContractError("INVALID_MODEL_PROFILE", "modelProfile devices, modelFiles, and analyses must be arrays");
  }
  if (!MODEL_STATUS_SET.has(modelProfile.availability)) {
    throw new PluginContractError("INVALID_MODEL_PROFILE", `Unknown model availability: ${modelProfile.availability}`);
  }
  for (const analysis of modelProfile.analyses) {
    if (!ANALYSIS_IDS.has(analysis)) throw new PluginContractError("INVALID_MODEL_PROFILE", `Unsupported analysis id: ${analysis}`);
  }
  return clone(modelProfile);
}

export function validateDevice(device) {
  if (!isRecord(device)) throw new PluginContractError("INVALID_DEVICE", "Device must be an object");
  for (const field of ["id", "symbolId", "pins", "parameters", "modelRequirements", "modelStatus", "netlistEmitter"]) {
    if (!(field in device)) throw new PluginContractError("INVALID_DEVICE", `Device is missing ${field}`, { field });
  }
  requireString(device.id, "device.id");
  requireString(device.symbolId, "device.symbolId");
  if (!Array.isArray(device.pins) || !Array.isArray(device.parameters) || !Array.isArray(device.modelRequirements)) {
    throw new PluginContractError("INVALID_DEVICE", `Device ${device.id} pins, parameters, and modelRequirements must be arrays`);
  }
  if (!MODEL_STATUS_SET.has(device.modelStatus)) throw new PluginContractError("INVALID_DEVICE", `Unknown model status: ${device.modelStatus}`);
  return clone(device);
}

export function validateAnalysisPlugin(plugin) {
  if (!isRecord(plugin)) throw new PluginContractError("INVALID_ANALYSIS", "Analysis plugin must be an object");
  for (const field of ["id", "label", "parameters", "validate", "buildDeck", "parseResult", "explainError", "measurements"]) {
    if (!(field in plugin)) throw new PluginContractError("INVALID_ANALYSIS", `Analysis plugin is missing ${field}`, { field });
  }
  requireString(plugin.id, "analysis.id");
  requireString(plugin.label, "analysis.label");
  if (!ANALYSIS_IDS.has(plugin.id)) throw new PluginContractError("INVALID_ANALYSIS", `Unsupported analysis id: ${plugin.id}`);
  for (const method of ["validate", "buildDeck", "parseResult", "explainError"]) {
    if (typeof plugin[method] !== "function") throw new PluginContractError("INVALID_ANALYSIS", `${plugin.id}.${method} must be a function`);
  }
  if (!Array.isArray(plugin.measurements)) throw new PluginContractError("INVALID_ANALYSIS", `${plugin.id}.measurements must be an array`);
  return plugin;
}

export function validateProfile(profile) {
  if (!isRecord(profile)) throw new PluginContractError("INVALID_PROFILE", "Profile must be an object");
  for (const field of ["id", "label", "devices", "analyses", "capabilities"]) {
    if (!(field in profile)) throw new PluginContractError("INVALID_PROFILE", `Profile is missing ${field}`, { field });
  }
  requireString(profile.id, "profile.id");
  requireString(profile.label, "profile.label");
  if (!Array.isArray(profile.devices) || !Array.isArray(profile.analyses) || !isRecord(profile.capabilities)) {
    throw new PluginContractError("INVALID_PROFILE", "Profile devices, analyses, and capabilities have invalid types");
  }
  const devices = profile.devices.map(validateDevice);
  const analyses = profile.analyses.map((analysis) => typeof analysis === "string" ? analysis : analysis.id);
  for (const analysis of analyses) {
    if (!ANALYSIS_IDS.has(analysis)) throw new PluginContractError("INVALID_PROFILE", `Unsupported analysis id: ${analysis}`);
  }
  const normalized = { ...clone(profile), devices, analyses };
  if (profile.modelProfile) normalized.modelProfile = validateModelProfile(profile.modelProfile);
  return normalized;
}

export class ProfileRegistry {
  #profiles = new Map();

  register(profile) {
    const normalized = validateProfile(profile);
    if (this.#profiles.has(normalized.id)) throw new PluginContractError("DUPLICATE_PROFILE", `Profile already registered: ${normalized.id}`);
    this.#profiles.set(normalized.id, normalized);
    return clone(normalized);
  }

  get(id) {
    return this.#profiles.has(id) ? clone(this.#profiles.get(id)) : null;
  }

  list() {
    return [...this.#profiles.values()].map(clone).sort((a, b) => a.id.localeCompare(b.id));
  }
}

function makeDiagnostic(code, message, target, extra = {}) {
  return {
    stage: "capability-negotiation",
    code,
    severity: "error",
    message,
    target: target || null,
    suggestedFix: extra.suggestedFix || "Choose a compatible profile or backend capability.",
    retryable: extra.retryable ?? true,
  };
}

export function negotiateCapabilities({ profile, backend, requestedDevices = [], requestedAnalyses = [], requestedModels = [] }) {
  const normalizedProfile = validateProfile(profile);
  if (!isRecord(backend) || !isRecord(backend.capabilities)) throw new PluginContractError("INVALID_BACKEND", "Backend capabilities are required");
  const capabilities = backend.capabilities;
  const diagnostics = [];
  const profileDevices = new Map(normalizedProfile.devices.map((device) => [device.id, device]));
  const profileAnalyses = new Set(normalizedProfile.analyses);
  const backendDevices = new Set(capabilities.devices || []);
  const backendAnalyses = new Set(capabilities.analyses || []);
  for (const id of requestedDevices) {
    if (!profileDevices.has(id) || (backendDevices.size && !backendDevices.has(id))) {
      diagnostics.push(makeDiagnostic("UNSUPPORTED_DEVICE", `Device ${id} is not supported by this backend.`, { kind: "device", id }));
    }
  }
  for (const id of requestedAnalyses) {
    if (!profileAnalyses.has(id) || (backendAnalyses.size && !backendAnalyses.has(id))) {
      diagnostics.push(makeDiagnostic("UNSUPPORTED_ANALYSIS", `Analysis ${id} is not supported by this backend.`, { kind: "analysis", id }));
    }
  }
  for (const id of requestedModels) {
    const device = [...profileDevices.values()].find((candidate) => candidate.modelRequirements.includes(id));
    const status = device?.modelStatus;
    if (!device || status === "missing" || status === "requires-model" || status === "unsupported" || status === "invalid") {
      diagnostics.push(makeDiagnostic("MODEL_UNAVAILABLE", `Model ${id} is not runnable in the selected profile.`, { kind: "model", id }));
    }
  }
  for (const feature of ["supportsCancel", "supportsWaveforms", "supportsMeasurements", "supportsResultExport"]) {
    if (normalizedProfile.capabilities[feature] === true && capabilities[feature] !== true) {
      diagnostics.push(makeDiagnostic("UNSUPPORTED_BACKEND_FEATURE", `Backend does not support required feature ${feature}.`, { kind: "backend", feature }));
    }
  }
  return {
    ok: diagnostics.length === 0,
    profileId: normalizedProfile.id,
    backendId: backend.id || "unknown",
    devices: [...profileDevices.keys()].filter((id) => !backendDevices.size || backendDevices.has(id)),
    analyses: [...profileAnalyses].filter((id) => !backendAnalyses.size || backendAnalyses.has(id)),
    capabilities: clone(capabilities),
    diagnostics,
  };
}

export function createAnalysisPlugins() {
  const definitions = {
    op: {
      label: "Operating point",
      measurements: ["operatingPoint"],
      validate: () => ({ ok: true, diagnostics: [] }),
      buildDeck: () => ".op\n",
    },
    dc: {
      label: "DC sweep",
      measurements: ["sweep"],
      validate: (testbench) => ({ ok: Boolean(testbench?.source && testbench?.start !== undefined && testbench?.stop !== undefined && testbench?.step !== undefined), diagnostics: [] }),
      buildDeck: (input) => `.dc ${input.source} ${input.start} ${input.stop} ${input.step}\n`,
    },
    ac: {
      label: "AC sweep",
      measurements: ["gain", "phase"],
      validate: (testbench) => ({ ok: Boolean(testbench?.sweep && testbench?.start !== undefined && testbench?.stop !== undefined && testbench?.points !== undefined), diagnostics: [] }),
      buildDeck: (input) => `.ac ${input.sweep} ${input.points} ${input.start} ${input.stop}\n`,
    },
    tran: {
      label: "Transient",
      measurements: ["min", "max", "riseTime"],
      validate: (testbench) => ({ ok: Boolean(testbench?.step !== undefined && testbench?.stop !== undefined), diagnostics: [] }),
      buildDeck: (input) => `.tran ${input.step} ${input.stop}\n`,
    },
  };
  return Object.entries(definitions).map(([id, definition]) => validateAnalysisPlugin({
    id,
    label: definition.label,
    parameters: {},
    validate: definition.validate,
    buildDeck: definition.buildDeck,
    parseResult: (raw) => raw,
    explainError: (error) => ({ code: error?.code || "ANALYSIS_ERROR", message: error?.message || "Analysis failed" }),
    measurements: definition.measurements,
  }));
}

export function createBackendAdapter(definition) {
  if (!isRecord(definition)) throw new PluginContractError("INVALID_BACKEND", "Backend adapter must be an object");
  for (const field of ["id", "version", "capabilities", "prepare", "run", "cancel", "parseResult", "explainError"]) {
    if (!(field in definition)) throw new PluginContractError("INVALID_BACKEND", `Backend is missing ${field}`, { field });
  }
  requireString(definition.id, "backend.id");
  requireString(definition.version, "backend.version");
  for (const method of ["prepare", "run", "cancel", "parseResult", "explainError"]) {
    if (typeof definition[method] !== "function") throw new PluginContractError("INVALID_BACKEND", `${definition.id}.${method} must be a function`);
  }
  return definition;
}

export function createFixtureBackend(analysisPlugins = createAnalysisPlugins()) {
  const plugins = new Map(analysisPlugins.map((plugin) => [plugin.id, plugin]));
  const cancelled = new Set();
  return createBackendAdapter({
    id: "fixture-local",
    version: "1.0.0",
    capabilities: {
      devices: ["resistor", "capacitor"],
      analyses: [...plugins.keys()],
      supportsCancel: true,
      supportsWaveforms: true,
      supportsMeasurements: true,
      supportsResultExport: true,
      limits: { maxNodes: 100, maxSamples: 100000 },
    },
    prepare(input) {
      const plugin = plugins.get(input?.analysis?.type);
      if (!plugin) throw new PluginContractError("UNSUPPORTED_ANALYSIS", `No analysis plugin for ${input?.analysis?.type}`);
      const validation = plugin.validate(input.analysis);
      if (!validation.ok) throw new PluginContractError("INVALID_ANALYSIS_PARAMETERS", `Invalid ${plugin.id} parameters`, { diagnostics: validation.diagnostics });
      return {
        analysisId: plugin.id,
        deck: `${plugin.buildDeck(input.analysis)}.end\n`,
      };
    },
    async run(deck, options = {}) {
      const runId = options.runId || "fixture-run";
      if (cancelled.has(runId)) return { runId, status: "cancelled", raw: { signals: [] } };
      return { runId, status: "completed", raw: { deck, signals: [], measurements: [] } };
    },
    cancel(runId) {
      cancelled.add(runId);
      return { runId, cancelled: true };
    },
    parseResult(raw) {
      return { signals: raw?.signals || [], measurements: raw?.measurements || [] };
    },
    explainError(error) {
      return {
        stage: "backend",
        code: error?.code || "BACKEND_ERROR",
        message: error?.message || "Fixture backend error",
        retryable: error?.code !== "UNSUPPORTED_ANALYSIS",
      };
    },
  });
}
