import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  PluginContractError,
  ProfileRegistry,
  createAnalysisPlugins,
  createBackendAdapter,
  createFixtureBackend,
  negotiateCapabilities,
  validateModelProfile,
  validateProfile,
} from "./plugin-backend.mjs";
import {
  createNetlistManifest,
  createProvenance,
} from "./workflow-artifacts.mjs";

const root = process.cwd();

async function profileFixture() {
  return JSON.parse(await readFile(join(root, "test", "fixtures", "plugins", "edu-passives-profile.json"), "utf8"));
}

async function projectFixture() {
  return JSON.parse(await readFile(join(root, "test", "fixtures", "workflow", "project-v1.json"), "utf8"));
}

test("profile registry validates model/profile contracts and rejects duplicates", async () => {
  const profile = await profileFixture();
  assert.equal(validateProfile(profile).id, "edu-passives-v1");
  assert.equal(validateModelProfile(profile.modelProfile).profileId, "edu-passives-models-v1");
  const registry = new ProfileRegistry();
  registry.register(profile);
  assert.deepEqual(registry.list().map((item) => item.id), ["edu-passives-v1"]);
  assert.throws(() => registry.register(profile), (error) => error.code === "DUPLICATE_PROFILE");
});

test("analysis plugins cover op, dc, ac, and tran with deterministic deck text", () => {
  const plugins = createAnalysisPlugins();
  assert.deepEqual(plugins.map((plugin) => plugin.id), ["op", "dc", "ac", "tran"]);
  assert.equal(plugins.find((plugin) => plugin.id === "op").buildDeck({}), ".op\n");
  assert.equal(plugins.find((plugin) => plugin.id === "dc").buildDeck({ source: "VIN", start: 0, stop: 5, step: 0.1 }), ".dc VIN 0 5 0.1\n");
  assert.equal(plugins.find((plugin) => plugin.id === "ac").buildDeck({ sweep: "dec", points: 20, start: 10, stop: "1Meg" }), ".ac dec 20 10 1Meg\n");
  assert.equal(plugins.find((plugin) => plugin.id === "tran").buildDeck({ step: "10u", stop: "10m" }), ".tran 10u 10m\n");
});

test("capability negotiation reports unsupported devices, models, analyses, and features", async () => {
  const profile = await profileFixture();
  const backend = createFixtureBackend();
  const result = negotiateCapabilities({
    profile,
    backend,
    requestedDevices: ["nmos"],
    requestedAnalyses: ["tran"],
    requestedModels: ["nmos-level1"],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map((item) => item.code), ["UNSUPPORTED_DEVICE", "MODEL_UNAVAILABLE"]);
  assert.deepEqual(result.analyses, ["op", "dc", "ac", "tran"]);

  const limitedProfile = { ...profile, capabilities: { ...profile.capabilities, supportsMeasurements: true } };
  const limitedBackend = { ...backend, capabilities: { ...backend.capabilities, supportsMeasurements: false } };
  const featureResult = negotiateCapabilities({ profile: limitedProfile, backend: limitedBackend });
  assert.deepEqual(featureResult.diagnostics.map((item) => item.code), ["UNSUPPORTED_BACKEND_FEATURE"]);
});

test("fixture backend prepares, runs, cancels, parses, and explains errors offline", async () => {
  const backend = createFixtureBackend();
  const prepared = backend.prepare({ analysis: { type: "tran", step: "1u", stop: "1m" } });
  assert.equal(prepared.deck, ".tran 1u 1m\n.end\n");
  const completed = await backend.run(prepared.deck, { runId: "run-1" });
  assert.equal(completed.status, "completed");
  assert.deepEqual(backend.parseResult(completed.raw), { signals: [], measurements: [] });
  backend.cancel("run-2");
  assert.equal((await backend.run(prepared.deck, { runId: "run-2" })).status, "cancelled");
  assert.deepEqual(backend.explainError({ code: "E1", message: "bad" }), { stage: "backend", code: "E1", message: "bad", retryable: true });
});

test("unsupported analysis and malformed adapters fail with stable error codes", () => {
  const backend = createFixtureBackend();
  assert.throws(() => backend.prepare({ analysis: { type: "noise" } }), (error) => error.code === "UNSUPPORTED_ANALYSIS");
  assert.throws(() => createBackendAdapter({ id: "bad" }), (error) => error instanceof PluginContractError && error.code === "INVALID_BACKEND");
});

test("backend identity and model profile flow into existing provenance unchanged", async () => {
  const profile = await profileFixture();
  const project = await projectFixture();
  const backend = createFixtureBackend();
  const prepared = backend.prepare({ analysis: { type: "op" } });
  const manifest = createNetlistManifest({
    project,
    documentId: "document-top",
    dutId: "dut-main",
    testbenchId: "tb-main",
    netlist: prepared.deck,
    modelProfileId: profile.modelProfile.profileId,
    models: { resistor: "built-in" },
    analysis: { type: "op" },
    emitterId: backend.id,
    emitterVersion: backend.version,
  });
  const provenance = createProvenance({
    project,
    manifest,
    deck: prepared.deck,
    solver: { id: backend.id, version: backend.version },
    temperature: 27,
    corner: "typical",
    resultStatus: "completed",
  });
  assert.equal(provenance.modelProfileId, "edu-passives-models-v1");
  assert.deepEqual(provenance.solver, { id: "fixture-local", version: "1.0.0" });
  assert.deepEqual(provenance.analysis, { type: "op" });
});
