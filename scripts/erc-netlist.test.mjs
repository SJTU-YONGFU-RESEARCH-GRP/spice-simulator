import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  loadHashedBundle,
  repositoryRoot,
} from "./test-support/bundle-runtime.mjs";

async function readJson(path) {
  return JSON.parse(await readFile(join(repositoryRoot, path), "utf8"));
}

async function compileFixture(path) {
  const projectService = await loadHashedBundle("project-file-service");
  const netlistService = await loadHashedBundle("src-Dahg1Dl_");
  const projectText = await readFile(join(repositoryRoot, path), "utf8");
  const imported = projectService.c(projectText);
  assert.equal(imported.ok, true, `${path} must be a valid schema-47 project`);
  return {
    netlistService,
    result: netlistService.r(imported.project, {
      format: "spice",
      rootDocumentId: imported.project.topDocumentId,
    }),
  };
}

test("valid circuit has stable ERC output and SPICE golden netlist", async () => {
  const { netlistService, result } = await compileFixture(
    "test/fixtures/valid-source-resistor-project.json",
  );
  const expectedErc = await readJson("test/golden/erc-valid.json");
  assert.deepEqual(result.diagnostics, expectedErc);
  assert.ok(result.ir, "valid fixture should produce a netlist IR");

  const generated = netlistService.n("spice", result.ir).text;
  const expected = await readFile(
    join(repositoryRoot, "test/golden/valid-source-resistor.spi"),
    "utf8",
  );
  assert.equal(generated, expected);
});

test("missing source return connection has stable ERC diagnostics", async () => {
  const { result } = await compileFixture(
    "test/fixtures/invalid-missing-connection-project.json",
  );
  const expected = await readJson(
    "test/golden/erc-missing-connection.json",
  );
  assert.equal(result.ir, null);
  assert.deepEqual(result.diagnostics, expected);
});
