import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();

async function script(name) {
  return readFile(join(root, "scripts", name), "utf8");
}

function assertGuarded(scriptText, guard, operation) {
  const guardIndex = scriptText.indexOf(guard);
  const operationIndex = scriptText.indexOf(operation);
  assert.notEqual(guardIndex, -1, `missing guard: ${guard}`);
  assert.notEqual(operationIndex, -1, `missing operation: ${operation}`);
  assert.ok(
    guardIndex < operationIndex,
    `${operation} must appear after ${guard}`,
  );
}

function assertCallAfter(scriptText, guard, call) {
  const guardIndex = scriptText.lastIndexOf(guard);
  const operationIndex = scriptText.indexOf(`\n${call}\n`, guardIndex);
  assert.notEqual(guardIndex, -1, `missing guard: ${guard}`);
  assert.notEqual(operationIndex, -1, `missing call: ${call}`);
  assert.ok(operationIndex > guardIndex, `${call} must be called after ${guard}`);
}

test("publish script keeps dry-run and no-push side-effect boundaries explicit", async () => {
  const text = await script("publish-editor-pages.sh");
  assert.match(text, /set -euo pipefail/u);
  assert.match(text, /--dry-run/u);
  assert.match(text, /--no-push/u);
  assert.doesNotMatch(text, /git remote set-url/u);
  assertGuarded(text, "Dry run — no editor build", "ensure_pnpm");
  assertGuarded(text, 'if [[ "$NO_PUSH" -eq 1 ]]', "git push origin HEAD");
});

test("release script does not build, mutate, tag, or push during dry-run", async () => {
  const text = await script("release.sh");
  assert.match(text, /set -euo pipefail/u);
  assert.match(text, /--dry-run/u);
  assert.match(text, /--no-push/u);
  assert.doesNotMatch(text, /git remote set-url/u);
  assertCallAfter(text, "Dry run — no build, commit, tag, or push.", "ensure_pnpm");
  assertGuarded(text, "Dry run — no build, commit, tag, or push.", "fs.writeFileSync");
  assert.match(text, /publish-editor-pages\.sh --no-push/u);
  assertGuarded(text, 'if [[ "$NO_PUSH" -eq 1 ]]', 'git push -u "$REMOTE"');
});
