#!/usr/bin/env node
/**
 * Would scripts/spice-import.mjs notice if the import repair stopped working?
 *
 * The harness asserts a contract with two halves, and each half is separately
 * breakable:
 *
 *   the pool      the shipped libraries join the file pool Ql() hands to Zl().
 *                 Without it, an include naming a library the user did not
 *                 select has nothing to resolve to.
 *   the fallback  a *relative* include that Jl() refused is retried by filename
 *                 -- but only when the path is relative, because the rule that
 *                 rejects non-local includes is not up for negotiation.
 *
 * So there are two mutants and they must fail differently:
 *
 *   pool-emptied      the array becomes empty. `bare-unselected` must go red --
 *                     nothing in the pool answers `cap.lib`. `header-form` must
 *                     stay GREEN, and that is the point of running it: the user
 *                     selected cap.lib there, so the fallback finds the user's
 *                     own file and the pool was never needed. A mutant that took
 *                     both down would not tell the two mechanisms apart.
 *
 *   absolute-allowed  the local-only guard is deleted, so `/usr/share/cap.lib`
 *                     can fall back to a filename the pool happens to hold. The
 *                     `absolute-include` control must go red: it is the fixture
 *                     written for exactly this. Every other fixture must be
 *                     unchanged, which is what says the mutation is scoped to the
 *                     rule it removed rather than to the whole feature.
 *
 * Each mutant is a real copy of the tree with real bytes changed, driven by the
 * real harness in a real browser, because the claim under test is about what a
 * user can do -- and no amount of reading the patched chunk establishes that.
 * The static channel (check 15, via check-artifacts.mjs) is required to see the
 * same breakage with the same specificity, which is what makes `--static-only`
 * a usable CI gate: a mutation that only the browser could see would leave the
 * artifact guard blind to it.
 *
 * Usage
 *   node scripts/spice-import.negctl.mjs [--require] [--keep] [--static-only]
 *
 *   --static-only  Run check 15 against each mutant and skip the browser. Faster,
 *                  and enough to catch a repair that has been undone or fenced
 *                  away; the runtime half is what catches a pool that is present
 *                  but never reaches the resolver.
 *
 * Exit codes: 0 every mutant behaved as required, 1 at least one did not,
 * 2 setup error (an anchor this script mutates is not where it expects, or no
 * browser with --require).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SITE = join(REPO_ROOT, 'site');
const CHUNK = join('assets', 'App-D0jgYDVz.js');
const HARNESS = join(HERE, 'spice-import.mjs');
const CHECKER = join(HERE, 'check-artifacts.mjs');
const MANIFEST = join(HERE, 'import-libs.json');
const RESULT = join(REPO_ROOT, 'spice-import-result.json');

const argv = process.argv.slice(2);
const has = (n) => argv.some((a) => a === '--' + n);
const REQUIRE = has('require');
const KEEP = has('keep');
const STATIC_ONLY = has('static-only');

let pass = true;
const fail = (m) => { pass = false; console.log('  FAIL: ' + m); };

// --- where to cut -----------------------------------------------------------
const pristine = readFileSync(join(SITE, CHUNK), 'utf8');

const POOL_OPEN = 'var BUILTIN_SOURCE_LIBS=[';
const POOL_CLOSE = '];function builtinSourceFiles';
const GUARD_OPEN = '!/^(?:\\/|[a-z]:';
const GUARD_CLOSE = '&&ir&&';

for (const [label, needle] of [['pool open', POOL_OPEN], ['pool close', POOL_CLOSE], ['guard open', GUARD_OPEN], ['guard close', GUARD_CLOSE]]) {
  const n = pristine.split(needle).length - 1;
  if (n !== 1) {
    console.error('spice-import.negctl: SETUP ERROR -- the ' + label + ' anchor occurs ' + n + ' time(s) in ' + CHUNK +
      '; the repair this script mutates is not in the shape it was written against');
    process.exit(2);
  }
}

function poolEmptied(text) {
  const a = text.indexOf(POOL_OPEN);
  const b = text.indexOf(POOL_CLOSE, a);
  if (a < 0 || b < 0 || b <= a) throw new Error('pool span not found');
  return text.slice(0, a) + 'var BUILTIN_SOURCE_LIBS=[]' + text.slice(b + 1);
}

function absoluteAllowed(text) {
  const a = text.indexOf(GUARD_OPEN);
  const b = text.indexOf(GUARD_CLOSE, a);
  if (a < 0 || b < 0 || b <= a) throw new Error('guard span not found');
  // Deleting the guard leaves `ir&&(...)`: the fallback still needs a name the
  // pool holds, so this widens exactly one rule and nothing else.
  return text.slice(0, a) + text.slice(b + GUARD_CLOSE.length);
}

const MUTATIONS = [
  {
    id: 'pool-emptied',
    what: 'the pool stops holding the shipped libraries',
    mutate: poolEmptied,
    expectRed: ['bare-unselected'],
    expectGreen: ['plain', 'bare-name', 'header-form', 'unknown-library', 'absolute-include'],
    expectStatic: ['import-pool-not-declaring:cap.lib', 'import-pool-not-declaring:cmos.lib', 'import-pool-not-declaring:opamp.lib'],
  },
  {
    id: 'absolute-allowed',
    what: 'the local-only guard is deleted, so a non-local include can fall back by filename',
    mutate: absoluteAllowed,
    expectRed: ['absolute-include'],
    expectGreen: ['plain', 'bare-name', 'header-form', 'bare-unselected', 'unknown-library'],
    expectStatic: ['import-fallback-unguarded'],
  },
];

// --- the static channel, and its own control ---------------------------------
/** check 15's finding keys for a given tree. */
function staticFindings(siteDir, jsonPath) {
  try {
    execFileSync(process.execPath, [CHECKER, '--site=' + siteDir, '--import=' + MANIFEST, '--json=' + jsonPath],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch { /* findings make it exit 1; the JSON is what is read */ }
  let j = null;
  try { j = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch { return null; }
  if (!j || !j.importLibs) return null;
  return (j.importLibs.findings ?? []).map((f) => f.key).sort();
}

const work = join(tmpdir(), 'spice-import-negctl-' + Date.now());
mkdirSync(work, { recursive: true });

// A mutation suite proves nothing if the guard is red on everything, so the
// unmutated tree is checked first: check 15 must be silent on it.
const clean = staticFindings(SITE, join(work, 'clean.json'));
if (clean === null) {
  console.error('spice-import.negctl: SETUP ERROR -- check-artifacts produced no importLibs block for the real tree');
  process.exit(2);
}
if (clean.length) fail('control: check 15 reports ' + JSON.stringify(clean) + ' on the unmutated tree -- a check that is red everywhere cannot witness a mutation');
else console.log('  ok  control           check 15 is silent on the unmutated tree');

for (const m of MUTATIONS) {
  const dir = join(work, m.id);
  mkdirSync(dir, { recursive: true });
  cpSync(SITE, dir, { recursive: true });

  const target = join(dir, CHUNK.split('/').join('\\'));
  const before = readFileSync(target, 'utf8');
  let after;
  try { after = m.mutate(before); } catch (e) {
    console.error('spice-import.negctl: SETUP ERROR -- ' + m.id + ': ' + e.message);
    process.exit(2);
  }
  if (after === before) {
    console.error('spice-import.negctl: SETUP ERROR -- ' + m.id + ' changed nothing');
    process.exit(2);
  }
  writeFileSync(target, after, 'utf8');

  // --- static half ---
  const seen = staticFindings(dir, join(work, m.id + '.json'));
  const wantStatic = [...m.expectStatic].sort();
  const staticOk = seen !== null && seen.length === wantStatic.length && seen.every((k, i) => k === wantStatic[i]);
  if (!staticOk) fail(m.id + ': check 15 expected exactly ' + JSON.stringify(wantStatic) + ', got ' + JSON.stringify(seen));

  // --- runtime half ---
  let reds = null, verdict = null, out = '', code = 0;
  if (!STATIC_ONLY) {
    const args = [HARNESS, '--site=' + dir];
    if (REQUIRE) args.push('--require');
    try {
      out = execFileSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
      code = e.status ?? 1;
    }
    if (/SKIP \(no browser/.test(out)) {
      if (REQUIRE) fail(m.id + ': no browser and --require was set');
      else { console.log('spice-import.negctl: SKIP (no browser found)'); rmSync(work, { recursive: true, force: true }); process.exit(0); }
    }
    if (code === 0) fail(m.id + ': the harness passed on a tree where ' + m.what + ' -- the guard is not sensitive to this');
    let json = null;
    try { json = JSON.parse(readFileSync(RESULT, 'utf8')); } catch {}
    if (!json) fail(m.id + ': the harness wrote no readable result file');
    else {
      verdict = new Map((json.fixtures ?? []).map((f) => [f.id, f.verdict]));
      reds = [...verdict].filter(([, v]) => v !== 'as-claimed').map(([k]) => k).sort();
      const want = [...m.expectRed].sort();
      if (!(reds.length === want.length && reds.every((x, i) => x === want[i]))) {
        fail(m.id + ': expected exactly ' + JSON.stringify(want) + ' to go red, got ' + JSON.stringify(reds));
      }
      for (const id of m.expectGreen) {
        if (verdict.get(id) !== 'as-claimed') fail(m.id + ': ' + id + ' must stay green (it does not depend on ' + m.what + '), got ' + JSON.stringify(verdict.get(id)));
      }
    }
  }

  console.log('  ' + (staticOk && (STATIC_ONLY || reds) ? 'ok  ' : 'BAD ') + m.id.padEnd(17) +
    (STATIC_ONLY ? 'static=' + JSON.stringify(seen) : 'red=' + JSON.stringify(reds) + ' static=' + JSON.stringify(seen)) +
    '  (' + m.what + ')');
  if (KEEP) console.log('      mutant tree: ' + dir);
}

if (!KEEP) rmSync(work, { recursive: true, force: true });

console.log('spice-import.negctl: ' + (pass ? 'PASS' : 'FAIL') + '  (' + MUTATIONS.length + ' mutant(s)' + (STATIC_ONLY ? ', static channel only' : ', both channels') + ')');
process.exit(pass ? 0 : 1);
