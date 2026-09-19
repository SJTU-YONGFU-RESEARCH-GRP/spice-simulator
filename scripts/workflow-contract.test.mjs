import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  mapSimulationError,
  measureWaveform,
  normalizeErcDiagnostics,
  preflightSimulation,
  retainFailedRun,
  searchComponents,
  waveformToCsv,
} from "./workflow-contract.mjs";

const root = process.cwd();
const galleryRoot = join(root, "test", "fixtures", "gallery");

test("Gallery contract fixtures declare the complete case shape", async () => {
  const names = (await readdir(galleryRoot)).filter((name) => name.endsWith(".json"));
  assert.deepEqual(names.sort(), [
    "cmos-inverter.json",
    "common-source-amplifier.json",
    "differential-pair.json",
    "rc-lowpass.json",
  ]);
  for (const name of names) {
    const fixture = JSON.parse(await readFile(join(galleryRoot, name), "utf8"));
    assert.equal(fixture.contractVersion, 1);
    assert.equal(fixture.status, "blocked-source-unavailable");
    assert.ok(fixture.id && fixture.title);
    assert.ok(fixture.dut?.id && fixture.testbench?.id);
    assert.ok(fixture.testbench.groundNode);
    assert.ok(fixture.testbench.inputNode);
    assert.ok(fixture.testbench.outputNode);
    assert.ok(fixture.testbench.analysis?.type);
    assert.ok(Array.isArray(fixture.models) && fixture.models.length > 0);
    assert.ok(Array.isArray(fixture.expectedMeasurements) && fixture.expectedMeasurements.length > 0);
    assert.match(fixture.deckPreview, /^\* Contract deck preview/mu);
  }
});

test("simulation preflight returns stable actionable diagnostics", () => {
  const result = preflightSimulation({
    dut: { id: "dut-main" },
    testbench: { id: "tb-main", groundNode: "0", inputNode: "VIN", outputNode: "VOUT", analysis: { type: "tran" } },
    models: [{ id: "m1", status: "requires-model" }],
    erc: { ok: true },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map((item) => item.code), ["MODEL_REQUIRED"]);
  assert.equal(result.diagnostics[0].target.id, "m1");
});

test("component search covers name, category, pins, and model keywords", () => {
  const catalog = [
    { name: "NMOS", category: "transistor", pins: ["D", "G", "S"], modelKeywords: ["mosfet"] },
    { name: "Resistor", category: "passive", pins: ["1", "2"], modelKeywords: ["ohmic"] },
  ];
  assert.deepEqual(searchComponents(catalog, "gate"), []);
  assert.equal(searchComponents(catalog, "mosfet")[0].name, "NMOS");
  assert.equal(searchComponents(catalog, "passive")[0].name, "Resistor");
});

test("simulation errors and waveform exports retain actionable context", () => {
  const mapped = mapSimulationError({
    stage: "deck",
    code: "NETLIST_INVALID",
    message: "The generated deck is invalid.",
    suggestedFix: "Repair the highlighted net and regenerate the deck.",
    target: { kind: "net", id: "n1" },
    requiresDeckRegeneration: true,
  });
  assert.deepEqual(mapped, {
    stage: "deck",
    code: "NETLIST_INVALID",
    message: "The generated deck is invalid.",
    suggestedFix: "Repair the highlighted net and regenerate the deck.",
    target: { kind: "net", id: "n1" },
    retryable: true,
    requiresDeckRegeneration: true,
  });
  assert.deepEqual(measureWaveform([{ x: 0, y: 1 }, { x: 1, y: 3 }, { x: 2, y: 2 }]), {
    min: 1,
    max: 3,
    mean: 2,
    peakToPeak: 2,
  });
  assert.equal(waveformToCsv([
    { signal: "VIN", samples: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    { signal: "VOUT", samples: [{ x: 0, y: 0.2 }, { x: 1, y: 0.8 }] },
  ]), "x,VIN,VOUT\n0,0,0.2\n1,1,0.8\n");
});

test("ERC locations and failed runs remain stable and recoverable", () => {
  const erc = normalizeErcDiagnostics([
    {
      documentId: "doc",
      instanceId: "r2",
      pinId: "1",
      code: "MISSING_PIN_NET",
      message: "R2.1 is not connected",
      suggestedFix: "Connect pin 1",
    },
    {
      documentId: "doc",
      instanceId: "r1",
      pinId: "2",
      code: "MISSING_PIN_NET",
      message: "R1.2 is not connected",
      suggestedFix: "Connect pin 2",
    },
  ]);
  assert.deepEqual(erc.map((item) => item.instanceId), ["r1", "r2"]);
  assert.equal(erc[0].suggestedFix, "Connect pin 2");

  const retained = retainFailedRun({
    projectRevision: "rev-1",
    dutId: "dut",
    testbenchId: "tb",
    modelVersions: ["m1@fixture"],
    deck: "* deck",
    log: "error at deck stage",
    diagnostics: erc,
    failedStage: "deck",
  });
  assert.equal(retained.status, "failed");
  assert.equal(retained.deck, "* deck");
  assert.equal(retained.log, "error at deck stage");
  assert.equal(retained.failedStage, "deck");
});
