#!/usr/bin/env node
/**
 * Negative control for the outbound repair (B7 + S4).
 *
 * Two things guard that repair, and a check that cannot fail is worse than no
 * check -- it turns "nobody looked" into "the build is green". So both are
 * exercised against deliberately broken copies:
 *
 *   check-artifacts.mjs check 9   every assertion it makes is given a tree that
 *                                 violates exactly that assertion.
 *   egress-integrity.mjs          the runtime probe is given a chunk whose
 *                                 verification has been removed, so "the pin is
 *                                 enforced" is proven by the probe going red
 *                                 rather than by it going green.
 *
 * Nothing here writes to site/ or to any tracked file: every case builds a
 * throwaway tree under the system temp directory. The trees are synthetic on
 * purpose. The assertions under test are about the *set* of URLs and the
 * *presence and behaviour* of a repaired form, so a two-file tree exercises
 * them exactly as well as the real 13 MiB artifact, in milliseconds.
 *
 * Usage
 *   node scripts/outbound-repair.negctl.mjs [--json=<file>]
 *
 * Exit codes: 0 every case behaved as required, 1 a mutant survived or a
 * control failed, 2 usage or IO error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CHECK = join(HERE, 'check-artifacts.mjs');
const PROBE = join(HERE, 'egress-integrity.mjs');
const MANIFEST = join(HERE, 'outbound-manifest.json');
const SHELL_CSP = join(HERE, 'shell-csp.json');

const INDEX_FILE = 'assets/index-7P_aude7.js';
const ENGINE_FILE = 'assets/src-CMkpkg0p.js';

const load = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Resolve {PIN} in a repair edit against the manifest. */
function resolveEdit(manifest, repair, edit) {
  const pin = repair.pinFrom
    ? (manifest.targets ?? []).find((t) => t.url === repair.pinFrom)?.integrity?.hex ?? null
    : null;
  const sub = (s) => (s ?? '').split('{PIN}').join(pin ?? '');
  return { find: sub(edit.find), replace: sub(edit.replace) };
}

/** The single backticked URL inside a repaired fragment. */
function extractUrl(text) {
  const m = /`(https?:\/\/[^`]+)`/.exec(text);
  return m ? m[1] : '';
}

/**
 * The repaired engine chunk, exactly as scripts/patch-outbound.mjs would write
 * it, optionally weakened. `mutation` is null, 'strip-guard', 'weaken-guard' or
 * 'drop-marker'.
 */
function repairedEngineChunk(manifest, mutation) {
  const engine = (manifest.repairs ?? []).find((r) => r.id === 'ngspice-cdn-integrity');
  let text = engine.edits
    .map((e) => resolveEdit(manifest, engine, e).replace)
    .join('\n');
  if (mutation === 'strip-guard') {
    // The verification clause is gone: the payload is fetched and executed.
    text = text.replace(
      /if\(S&&await [A-Za-z_$][\w$]*\(r\)!==S\)throw Error\(`[^`]*`\);/,
      '');
  } else if (mutation === 'weaken-guard') {
    // Present, plausible, and never true.
    text = text.replace('if(S&&', 'if(!1&&');
  } else if (mutation === 'drop-marker') {
    // The clause survives but its message is gone, so the branch cannot be
    // identified any more and the probe must refuse to report a pass.
    text = text.split('ngspice WASM failed its SHA-256 pin').join('ngspice WASM rejected');
  }
  return text;
}

/**
 * Apply one weakening to the *real* engine chunk. Refusing to no-op matters:
 * a mutation that silently misses would leave the probe failing for some other
 * reason and read like a caught defect.
 */
function mutateEngine(text, mutation) {
  let out = text;
  if (mutation === 'strip-guard') {
    // The verification clause is gone: the payload is fetched and executed.
    out = text.replace(
      /if\(S&&await [A-Za-z_$][\w$]*\(r\)!==S\)throw Error\(`[^`]*`\);/,
      '');
  } else if (mutation === 'weaken-guard') {
    // Present, plausible, and never true.
    out = text.replace('if(S&&', 'if(!1&&');
  } else if (mutation === 'drop-marker') {
    // The clause survives but its message is gone, so the branch cannot be
    // identified any more and the probe must refuse to report a pass.
    out = text.split('ngspice WASM failed its SHA-256 pin').join('ngspice WASM rejected');
  }
  if (mutation !== null && out === text) {
    throw new Error('mutation ' + mutation + ' did not change the engine chunk: ' +
      'the artifact was rebuilt and this control no longer tests anything');
  }
  return out;
}

/**
 * Write a tree that check 9 should accept, then optionally add one defect.
 * `defect` is null, 'forbidden', 'undeclared' or 'repair-lost'.
 *
 * `engineFrom` selects what goes into the engine chunk: 'repair' (the repaired
 * form a synthetic tree can build from the manifest alone) or 'real' (the
 * committed artifact, used by the runtime-probe cases so they run against the
 * code that actually ships).
 */
function buildTree(dir, manifest, { defect = null, engineMutation = null, engineFrom = 'repair' } = {}) {
  mkdirSync(join(dir, 'assets'), { recursive: true });
  // A miniature but VALID deploy shell. The checks that are not under test here
  // still run, so the tree has to be coherent for them too: the policy is read
  // out of the shell-csp manifest rather than hard-coded, which keeps this
  // miniature in step with check 11 whatever the policy later becomes.
  const shell = load(SHELL_CSP);
  const policyTag = '<meta http-equiv="Content-Security-Policy" content="' + shell.policy + '" />';
  for (const doc of shell.shellDocuments ?? ['index.html']) {
    writeFileSync(join(dir, doc),
      '<!doctype html><meta charset="UTF-8" />' + policyTag + '<title>negctl</title>\n', 'utf8');
  }

  const link = (manifest.repairs ?? []).find((r) => r.id === 'bug-report-link');
  const forbidden = (manifest.forbidden ?? [])[0]?.url ?? '';
  let index = 'var m=`' + extractUrl(resolveEdit(manifest, link, link).replace) + '`;\n';
  if (defect === 'forbidden') index += 'var bad=`' + forbidden + '`;\n';
  if (defect === 'undeclared') index += 'var evil="https:\\/\\/evil.example.com\\/x.js";\n';
  writeFileSync(join(dir, INDEX_FILE), index, 'utf8');

  const engine = (manifest.repairs ?? []).find((r) => r.id === 'ngspice-cdn-integrity');
  let body;
  if (engineFrom === 'real') {
    const real = join(REPO_ROOT, 'site', ENGINE_FILE);
    if (!existsSync(real)) throw new Error('the committed artifact is missing: ' + real);
    body = mutateEngine(readFileSync(real, 'utf8'), engineMutation);
  } else if (defect === 'repair-lost') {
    body = engine.edits.map((e) => resolveEdit(manifest, engine, e).find).join('\n');
  } else {
    body = repairedEngineChunk(manifest, engineMutation);
  }
  writeFileSync(join(dir, ENGINE_FILE), body, 'utf8');
}

/** Run a child and return its exit code plus its JSON report (or null). */
function run(args, jsonPath) {
  let exit = 0;
  try {
    execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    exit = typeof e.status === 'number' ? e.status : -1;
  }
  let report = null;
  try {
    report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  } catch { /* surfaced as a missing report */ }
  return { exit, report };
}

function main() {
  const argv = process.argv.slice(2);
  let jsonOut = null;
  for (const a of argv) {
    if (a.startsWith('--json=')) jsonOut = a.slice('--json='.length);
    else {
      console.error('unknown argument: ' + a);
      console.error('usage: node scripts/outbound-repair.negctl.mjs [--json=<file>]');
      return 2;
    }
  }
  for (const p of [CHECK, PROBE, MANIFEST, SHELL_CSP]) {
    if (!existsSync(p)) {
      console.error('missing ' + p);
      return 2;
    }
  }

  const root = mkdtempSync(join(tmpdir(), 'outbound-negctl-'));
  const accept = join(root, 'accept-empty.json');
  writeFileSync(accept, JSON.stringify({ accepted: [] }, null, 2), 'utf8');

  // A manifest whose pin no longer matches the engine the repository ships:
  // same length, different value, so only re-derivation can notice.
  const driftPath = join(root, 'manifest-drift.json');
  const drift = load(MANIFEST);
  const pinned = (drift.targets ?? []).find((t) => t.integrity?.mustEqual);
  pinned.integrity.hex = pinned.integrity.hex.replace(/^.{4}/, 'dead');
  writeFileSync(driftPath, JSON.stringify(drift, null, 2), 'utf8');

  // Each case names the exact evidence that must appear. A bare exit code would
  // let one assertion cover for another, so the finding key (check 9) or the
  // failed assertion id (probe) is asserted too.
  const CASES = [
    {
      id: 'check9:clean', kind: 'check9', expectExit: 0, expect: [],
      note: 'control -- a correctly repaired tree must be clean',
    },
    {
      id: 'check9:forbidden', kind: 'check9', defect: 'forbidden', expectExit: 1,
      expect: ['egress-forbidden:'],
    },
    {
      id: 'check9:undeclared', kind: 'check9', defect: 'undeclared', expectExit: 1,
      expect: ['egress-undeclared:https://evil.example.com/x.js'],
    },
    {
      id: 'check9:repair-lost', kind: 'check9', defect: 'repair-lost', expectExit: 1,
      expect: ['egress-repair-lost:ngspice-cdn-integrity#0', 'egress-repair-lost:ngspice-cdn-integrity#1'],
    },
    {
      // Built from the drifted manifest, so its repaired form embeds the
      // drifted pin and the repair assertions stay satisfied.
      id: 'check9:pin-drift', kind: 'check9', manifest: driftPath, expectExit: 1,
      expect: ['egress-pin-drift:'],
    },
    {
      id: 'probe:control', kind: 'probe', engineFrom: 'real', expectExit: 0, expect: [],
      note: 'control -- the committed artifact must satisfy every runtime assertion',
    },
    {
      id: 'probe:weaken-guard', kind: 'probe', engineFrom: 'real', engineMutation: 'weaken-guard',
      expectExit: 1, expect: ['pin-mismatch'],
      note: 'guard present but never true -> the fail-closed branch must be proven by behaviour, ' +
        'not by the marker being present',
    },
    {
      id: 'probe:guard-removed', kind: 'probe', engineFrom: 'real', engineMutation: 'strip-guard',
      expectExit: 3, expect: [],
      note: 'the clause and its message are gone -> the probe must refuse to report anything',
    },
    {
      id: 'probe:drop-marker', kind: 'probe', engineFrom: 'real', engineMutation: 'drop-marker',
      expectExit: 3, expect: [],
      note: 'the branch can no longer be identified -> the probe must not pass',
    },
  ];

  const results = [];
  console.log('outbound repair -- negative control');
  console.log('  temp tree = ' + root);
  console.log('');

  for (const c of CASES) {
    const dir = join(root, c.id.replace(':', '-'));
    const manifestPath = c.manifest ?? MANIFEST;
    try {
      buildTree(dir, load(manifestPath), c);
    } catch (e) {
      // A control that cannot build its mutant tests nothing. Say so loudly
      // instead of letting it look like a caught defect.
      console.log('  FAIL  ' + c.id + '  (setup)');
      console.log('        !! ' + e.message);
      results.push({ id: c.id, exit: null, evidence: [], problems: ['setup: ' + e.message], note: c.note ?? null, ok: false });
      continue;
    }
    const jsonPath = join(root, c.id.replace(':', '-') + '.json');

    let exit;
    let evidence;
    if (c.kind === 'check9') {
      const r = run([
        CHECK, '--site=' + dir, '--outbound=' + manifestPath,
        '--accept=' + accept, '--json=' + jsonPath,
      ], jsonPath);
      exit = r.exit;
      evidence = (r.report?.outbound?.findings ?? []).map((f) => f.key);
      // Only the control asserts the global finding count: the mutants are
      // expected to add findings, and a mutant tree is minimal, so unrelated
      // checks stay quiet either way.
      if (c.id === 'check9:clean' && (r.report?.findings ?? -1) !== 0) {
        evidence.push('!! control tree has ' + r.report?.findings + ' finding(s) outside check 9');
      }
    } else {
      const r = run([PROBE, '--site=' + dir, '--json=' + jsonPath], jsonPath);
      exit = r.exit;
      evidence = r.report?.failed ?? [];
      if (c.expect.length === 0 && exit === 0 && (r.report?.assertions ?? []).length === 0) {
        evidence.push('!! probe reported no assertions at all');
      }
    }

    const problems = [];
    if (exit !== c.expectExit) problems.push('exit ' + exit + ', expected ' + c.expectExit);
    for (const want of c.expect) {
      if (!evidence.some((e) => e.startsWith(want))) problems.push('missing evidence ' + want);
    }
    if (c.expect.length === 0 && evidence.some((e) => e.startsWith('!!'))) {
      problems.push(evidence.filter((e) => e.startsWith('!!')).join('; '));
    }
    // exit 3 is the probe refusing to judge (it cannot find the branch); a
    // genuine failure is exit 1 and must name the assertion it failed.
    if (c.expect.length === 0 && c.kind === 'probe' && exit === 1 && evidence.length === 0) {
      problems.push('the probe reported a failure without naming an assertion');
    }

    results.push({ id: c.id, exit, evidence, problems, note: c.note ?? null, ok: problems.length === 0 });
    console.log('  ' + (problems.length === 0 ? 'PASS' : 'FAIL') + '  ' + c.id + '  (exit ' + exit + ')');
    if (c.note) console.log('        -- ' + c.note);
    for (const e of evidence) console.log('        -> ' + e);
    for (const p of problems) console.log('        !! ' + p);
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log('RESULT: ' + (results.length - failed.length) + '/' + results.length +
    ' case(s) behaved as required   [controls: ' +
    (results[0].ok && results[5].ok ? 'clean' : 'BROKEN') + ']');

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({
      generatedFrom: MANIFEST,
      tempTree: root,
      cases: results.map(({ id, exit, evidence, problems, ok }) => ({ id, exit, evidence, problems, ok })),
      passed: results.length - failed.length,
      total: results.length,
    }, null, 2), 'utf8');
  }

  return failed.length === 0 ? 0 : 1;
}

process.exit(main());
