import { createHash } from "node:crypto";

export const WORKFLOW_SCHEMA_VERSION = 1;
export const RESULT_BUNDLE_FILES = [
  "project.json",
  "provenance.json",
  "netlist.cir",
  "deck.cir",
  "simulation.log",
  "result.json",
  "waveforms.csv",
];

const REQUIRED_PROJECT_FIELDS = [
  "schemaVersion",
  "projectId",
  "revision",
  "name",
  "documents",
  "instances",
  "wires",
  "nets",
  "dut",
  "testbench",
  "models",
  "metadata",
];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function stableStringify(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  const source = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function assertProject(project) {
  if (!isRecord(project)) throw new Error("Project must be a JSON object");
  for (const field of REQUIRED_PROJECT_FIELDS) {
    if (!(field in project)) throw new Error(`Project is missing required field: ${field}`);
  }
  if (project.schemaVersion !== WORKFLOW_SCHEMA_VERSION) {
    throw new Error(`Unsupported workflow project schema: ${project.schemaVersion}`);
  }
  if (typeof project.projectId !== "string" || !project.projectId) {
    throw new Error("projectId must be a non-empty string");
  }
  if (!Number.isInteger(project.revision) || project.revision < 0) {
    throw new Error("revision must be a non-negative integer");
  }
  for (const field of ["documents", "instances", "wires", "nets", "models"]) {
    if (!Array.isArray(project[field])) throw new Error(`${field} must be an array`);
  }
  for (const field of ["dut", "testbench", "metadata"]) {
    if (!isRecord(project[field])) throw new Error(`${field} must be an object`);
  }
  return project;
}

export function migrateProject(input) {
  if (!isRecord(input)) throw new Error("Project must be a JSON object");
  if (input.schemaVersion === WORKFLOW_SCHEMA_VERSION) return clone(input);
  if (input.schemaVersion !== 0) {
    throw new Error(`Unsupported project schema version: ${input.schemaVersion}`);
  }
  return {
    ...clone(input),
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    projectId: input.projectId || input.id || "migrated-project",
    revision: Number.isInteger(input.revision) && input.revision >= 0 ? input.revision : 0,
    name: typeof input.name === "string" ? input.name : "Migrated project",
    documents: Array.isArray(input.documents) ? input.documents : [],
    instances: Array.isArray(input.instances) ? input.instances : [],
    wires: Array.isArray(input.wires) ? input.wires : [],
    nets: Array.isArray(input.nets) ? input.nets : [],
    dut: isRecord(input.dut) ? input.dut : {},
    testbench: isRecord(input.testbench) ? input.testbench : {},
    models: Array.isArray(input.models) ? input.models : [],
    metadata: isRecord(input.metadata) ? input.metadata : {},
  };
}

export function importProject(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid project JSON: ${error.message}`);
  }
  return assertProject(migrateProject(parsed));
}

export function exportProject(project) {
  return `${stableStringify(assertProject(migrateProject(project)))}\n`;
}

export function createNetlistManifest({
  project,
  documentId,
  dutId,
  testbenchId,
  netlist,
  modelProfileId,
  models = {},
  analysis,
  generatedAt,
  emitterId,
  emitterVersion,
}) {
  const normalizedProject = assertProject(migrateProject(project));
  if (typeof netlist !== "string") throw new Error("netlist must be a string");
  if (!documentId || !dutId || !testbenchId || !modelProfileId || !analysis) {
    throw new Error("documentId, dutId, testbenchId, modelProfileId, and analysis are required");
  }
  const modelHashes = Object.fromEntries(
    Object.keys(models).sort().map((id) => [id, sha256(models[id])]),
  );
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    projectId: normalizedProject.projectId,
    projectRevision: normalizedProject.revision,
    documentId,
    dutId,
    testbenchId,
    netlistHash: sha256(netlist),
    modelProfileId,
    modelHashes,
    analysis: clone(analysis),
    generatedAt: generatedAt || new Date(0).toISOString(),
    emitterId: emitterId || "unknown",
    emitterVersion: emitterVersion || "unknown",
  };
}

export function createProvenance({
  project,
  manifest,
  deck,
  solver,
  temperature,
  corner,
  parameters = {},
  inputFiles = ["project.json", "netlist.cir", "deck.cir"],
  outputFiles = ["simulation.log", "result.json", "waveforms.csv"],
  simulationLog = "",
  resultStatus,
  generatedAt,
}) {
  const normalizedProject = assertProject(migrateProject(project));
  if (!manifest?.netlistHash || typeof deck !== "string") {
    throw new Error("manifest with netlistHash and deck are required");
  }
  if (!solver?.id || !solver?.version) throw new Error("solver id and version are required");
  if (temperature === undefined || temperature === null || !corner || !resultStatus) {
    throw new Error("temperature, corner, and resultStatus are required");
  }
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    projectId: normalizedProject.projectId,
    projectRevision: normalizedProject.revision,
    dutId: manifest.dutId,
    testbenchId: manifest.testbenchId,
    netlistHash: manifest.netlistHash,
    deckHash: sha256(deck),
    modelProfileId: manifest.modelProfileId,
    modelHashes: clone(manifest.modelHashes),
    solver: { id: solver.id, version: solver.version },
    analysis: clone(manifest.analysis),
    temperature,
    corner,
    parameters: clone(parameters),
    inputFiles: [...inputFiles],
    outputFiles: [...outputFiles],
    simulationLog,
    generatedAt: generatedAt || new Date(0).toISOString(),
    resultStatus,
  };
}

export function validateProvenance(provenance) {
  const required = [
    "schemaVersion", "projectId", "projectRevision", "dutId", "testbenchId",
    "netlistHash", "deckHash", "modelProfileId", "modelHashes", "solver",
    "analysis", "temperature", "corner", "parameters", "inputFiles",
    "outputFiles", "simulationLog", "generatedAt", "resultStatus",
  ];
  for (const field of required) {
    if (!(field in (provenance || {}))) throw new Error(`Provenance is missing required field: ${field}`);
  }
  if (!/^[a-f0-9]{64}$/u.test(provenance.netlistHash) || !/^[a-f0-9]{64}$/u.test(provenance.deckHash)) {
    throw new Error("Provenance hashes must be SHA-256 hex strings");
  }
  return provenance;
}

export function isResultStale({ provenance, projectRevision, netlistHash, deckHash, modelProfileId, analysis, temperature, corner }) {
  const reasons = [];
  if (provenance.projectRevision !== projectRevision) reasons.push("project-revision-mismatch");
  if (netlistHash && provenance.netlistHash !== netlistHash) reasons.push("netlist-hash-mismatch");
  if (deckHash && provenance.deckHash !== deckHash) reasons.push("deck-hash-mismatch");
  if (modelProfileId && provenance.modelProfileId !== modelProfileId) reasons.push("model-profile-mismatch");
  if (analysis && stableStringify(provenance.analysis) !== stableStringify(analysis)) reasons.push("analysis-mismatch");
  if (temperature !== undefined && provenance.temperature !== temperature) reasons.push("temperature-mismatch");
  if (corner && provenance.corner !== corner) reasons.push("corner-mismatch");
  return { stale: reasons.length > 0, reasons };
}

export function exportResultBundle({ project, provenance, netlist, deck, simulationLog, result, waveformsCsv }) {
  validateProvenance(provenance);
  if (typeof netlist !== "string" || typeof deck !== "string" || typeof simulationLog !== "string" || typeof waveformsCsv !== "string") {
    throw new Error("Result bundle text files must be strings");
  }
  return {
    "project.json": exportProject(project),
    "provenance.json": `${stableStringify(provenance)}\n`,
    "netlist.cir": netlist,
    "deck.cir": deck,
    "simulation.log": simulationLog,
    "result.json": `${stableStringify(result)}\n`,
    "waveforms.csv": waveformsCsv,
  };
}

export function importResultBundle(bundle) {
  for (const name of RESULT_BUNDLE_FILES) {
    if (typeof bundle?.[name] !== "string") throw new Error(`Result bundle is missing ${name}`);
  }
  const project = importProject(bundle["project.json"]);
  const provenance = validateProvenance(JSON.parse(bundle["provenance.json"]));
  const result = JSON.parse(bundle["result.json"]);
  return {
    project,
    provenance,
    netlist: bundle["netlist.cir"],
    deck: bundle["deck.cir"],
    simulationLog: bundle["simulation.log"],
    result,
    waveformsCsv: bundle["waveforms.csv"],
  };
}
