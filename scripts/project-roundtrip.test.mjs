import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  loadHashedBundle,
  repositoryRoot,
} from "./test-support/bundle-runtime.mjs";

test("project export → import → export preserves the canonical structure", async () => {
  const service = await loadHashedBundle("project-file-service");
  const fixture = await readFile(
    join(repositoryRoot, "test", "fixtures", "minimal-project.json"),
    "utf8",
  );
  const firstImport = service.c(fixture);
  assert.equal(firstImport.ok, true);
  assert.equal(firstImport.sourceSchemaVersion, 47);
  assert.equal(firstImport.project.schemaVersion, 47);

  const firstExport = service.o(firstImport.project);
  const secondImport = service.c(firstExport);
  const secondExport = service.o(secondImport.project);

  assert.deepEqual(JSON.parse(secondExport), JSON.parse(firstExport));
  assert.equal(secondImport.project.topDocumentId, "document-top");
  assert.equal(secondImport.project.documents.length, 1);
});
