import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  createNetlistManifest,
  createProvenance,
  exportProject,
  exportResultBundle,
  importProject,
  importResultBundle,
  isResultStale,
  migrateProject,
  sha256,
  stableStringify,
  validateProvenance,
} from "./workflow-artifacts.mjs";

const root = process.cwd();

async function fixture(name) {
  return JSON.parse(await readFile(join(root, "test", "fixtures", "workflow", name), "utf8"));
}

test("project schema round-trip is stable and preserves unknown fields", async () => {
  const project = await fixture("project-v1.json");
  const exported = exportProject(project);
  const imported = importProject(exported);
  assert.equal(imported.schemaVersion, 1);
  assert.deepEqual(imported.metadata.unknownField, { preserve: true });
  assert.equal(exportProject(imported), exported);
});

test("schema migration upgrades v0 and rejects unknown future versions", async () => {
  const legacy = await fixture("project-v0.json");
  const migrated = migrateProject(legacy);
  assert.equal(migrated.schemaVersion, 1);
  assert.equal(migrated.projectId, "legacy-workflow-fixture");
  assert.equal(migrated.revision, 0);
  assert.deepEqual(migrated.metadata, { legacy: true });
  assert.throws(() => migrateProject({ schemaVersion: 99 }), /Unsupported project schema/);
});

test("same project, model, analysis, and netlist produce deterministic hashes", async () => {
  const project = await fixture("project-v1.json");
  const args = {
    project,
    documentId: "document-top",
    dutId: "dut-main",
    testbenchId: "tb-main",
    netlist: "R1 n1 0 1k\n.op\n",
    modelProfileId: "built-in-passives",
    models: { resistor: { status: "built-in", value: "1k" } },
    analysis: { type: "op" },
    generatedAt: "2026-01-01T00:00:00.000Z",
    emitterId: "fixture-emitter",
    emitterVersion: "1.0.0",
  };
  const first = createNetlistManifest(args);
  const second = createNetlistManifest({ ...args, models: { resistor: { value: "1k", status: "built-in" } } });
  assert.equal(first.netlistHash, second.netlistHash);
  assert.deepEqual(first.modelHashes, second.modelHashes);
  assert.equal(stableStringify(first), stableStringify(second));
});

test("provenance is complete and model content changes invalidate its hash", async () => {
  const project = await fixture("project-v1.json");
  const manifest = createNetlistManifest({
    project,
    documentId: "document-top",
    dutId: "dut-main",
    testbenchId: "tb-main",
    netlist: "R1 n1 0 1k\n.op\n",
    modelProfileId: "built-in-passives",
    models: { resistor: "1k" },
    analysis: { type: "op" },
  });
  const provenance = createProvenance({
    project,
    manifest,
    deck: "R1 n1 0 1k\n.op\n.end\n",
    solver: { id: "fixture-solver", version: "0.1.0" },
    temperature: 27,
    corner: "typical",
    parameters: { tolerance: "nominal" },
    simulationLog: "ok",
    resultStatus: "completed",
  });
  assert.doesNotThrow(() => validateProvenance(provenance));
  assert.equal(Object.keys(provenance.modelHashes).length, 1);
  const changedManifest = createNetlistManifest({
    project,
    documentId: "document-top",
    dutId: "dut-main",
    testbenchId: "tb-main",
    netlist: "R1 n1 0 1k\n.op\n",
    modelProfileId: "built-in-passives",
    models: { resistor: "2k" },
    analysis: { type: "op" },
  });
  assert.notEqual(manifest.modelHashes.resistor, changedManifest.modelHashes.resistor);
});

test("stale result detection covers revision, analysis, temperature, and corner", async () => {
  const project = await fixture("project-v1.json");
  const manifest = createNetlistManifest({
    project,
    documentId: "document-top",
    dutId: "dut-main",
    testbenchId: "tb-main",
    netlist: "R1 n1 0 1k\n.op\n",
    modelProfileId: "built-in-passives",
    models: { resistor: "1k" },
    analysis: { type: "op" },
  });
  const provenance = createProvenance({ project, manifest, deck: "deck", solver: { id: "s", version: "1" }, temperature: 27, corner: "tt", resultStatus: "completed" });
  const stale = isResultStale({ provenance, projectRevision: 13, netlistHash: manifest.netlistHash, modelProfileId: "built-in-passives", analysis: { type: "tran" }, temperature: 85, corner: "ss" });
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.reasons, ["project-revision-mismatch", "analysis-mismatch", "temperature-mismatch", "corner-mismatch"]);
});

test("result bundle export/import is reversible for completed and failed runs", async () => {
  const project = await fixture("project-v1.json");
  const netlist = "R1 n1 0 1k\n.op\n";
  const deck = `${netlist}.end\n`;
  const manifest = createNetlistManifest({ project, documentId: "document-top", dutId: "dut-main", testbenchId: "tb-main", netlist, modelProfileId: "built-in-passives", models: { resistor: "1k" }, analysis: { type: "op" } });
  const provenance = createProvenance({ project, manifest, deck, solver: { id: "fixture", version: "1" }, temperature: 27, corner: "tt", resultStatus: "failed", simulationLog: "error" });
  const bundle = exportResultBundle({ project, provenance, netlist, deck, simulationLog: "error", result: { status: "failed", diagnostics: [{ code: "SOLVER_ERROR" }] }, waveformsCsv: "x,VOUT\n" });
  const imported = importResultBundle(bundle);
  assert.equal(imported.project.projectId, project.projectId);
  assert.equal(imported.provenance.resultStatus, "failed");
  assert.equal(imported.deck, deck);
  assert.deepEqual(imported.result.diagnostics, [{ code: "SOLVER_ERROR" }]);
  assert.equal(sha256(imported.deck), provenance.deckHash);
});
