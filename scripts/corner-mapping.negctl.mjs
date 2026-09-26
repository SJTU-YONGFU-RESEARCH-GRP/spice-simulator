#!/usr/bin/env node
/**
 * Prove that check 20 (corner mapping consistency) is not vacuous.
 *
 * Check 20 claims the corner->selector map the ANNOTATION reads
 * (rgAnnotate, in the spice-simulation-surface chunk) is the SAME map the DECK
 * EMITTER writes (src-CMkpkg0p.js -> __cn_sel). The two ternaries are written
 * independently; if either drifts, the region line is computed against the
 * wrong process corner with no error. The D3 feasibility write-up (analysis/
 * 60_improvements/SPICE-Simulator-D3-工作区标注可行性-2026-09-23.md, section 3.3)
 * named this exact risk and noted it had zero guarding.
 *
 * A guard like that can be green for the wrong reason -- an anchor that stopped
 * matching so the rule never ran, two sides compared against copies of
 * themselves, or a parse that always yields the canonical map regardless of the
 * bytes. The only way to tell a working guard from a lucky one is to break the
 * thing it guards, one way at a time, and require it to say the specific thing
 * it is supposed to say.
 *
 * Two cases are controls in the other direction:
 *
 *   control        an unmutated patched copy must produce NO finding, or the
 *                  mutant results below mean nothing. This is the baseline the
 *                  guard is supposed to keep clean; if it is not clean the
 *                  check itself is broken, not the tree.
 *   annotation-absent  a copy with rgAnnotate removed must report the feature
 *                  as absent rather than as a finding -- this rules out a check
 *                  that would also fire (as a parse failure) on a tree that
 *                  never had the annotation repair.
 *
 * The mutants, and the reason each was chosen:
 *
 *   deck-ss-ff-flipped     the emitter swaps ss and ff: a `tt` simulation is
 *                          fine, but an `ss` simulation is tagged __cn_sel=-1
 *                          (ff) while the annotation still reads ss as +1.
 *                          This is the silent half of the corner question: the
 *                          row still renders, the numbers still look like
 *                          numbers, and they are the other corner's.
 *   annotation-ss-ff-flipped  the annotation swaps ss and ff symmetrically: the
 *                          same silent misjudgement, approached from the other
 *                          side, to prove the check is not only watching the
 *                          emitter.
 *   both-flipped           both sides swap ss and ff TOGETHER. The two sides
 *                          still agree with each other, so a check that only
 *                          compared them would pass -- but both now disagree
 *                          with the canonical {-1,0,+1} map, so every ss/ff
 *                          simulation is annotated against the wrong corner.
 *                          This proves the canonical comparison is doing work
 *                          and is not redundant with the side-to-side one.
 *   deck-tt-broken         tt stops mapping to selector 0 and instead emits
 *                          __cn_sel=1. The typical case is the one every
 *                          example and every default setup uses, so a tt drift
 *                          is the most likely to ship unnoticed.
 *
 * Mutations are anchored on the bytes the two sides actually emit, and every
 * anchor must occur exactly once -- a mutation that silently matched nothing
 * would turn into a case that "passes" because nothing changed.
 *
 * `exact` cases declare the COMPLETE set of finding keys their mutation must
 * produce, so a surgical mutation that tripped an unrelated rule fails here
 * too: a check that fires on everything is as useless as one that fires on
 * nothing.
 *
 * Usage
 *   node scripts/corner-mapping.negctl.mjs [--site=<dir>] [--only=<id,...>]
 *                                          [--keep] [--json=<file>]
 *
 * --site defaults to ./site and must be a tree the patcher produced (it must
 * carry rgAnnotate). Exit codes: 0 every case behaved, 1 a case did not,
 * 2 setup error.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const GUARD = join(HERE, 'check-artifacts.mjs');

const argv = process.argv.slice(2);
const has = (n) => argv.some((a) => a === '--' + n);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};
const SITE = resolve(REPO_ROOT, opt('site', 'site'));
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = has('keep');
const JSON_OUT = opt('json', null);

const die = (msg) => { console.error('corner-mapping.negctl: ' + msg); process.exit(2); };
const count = (t, n) => { let c = 0, i = 0; for (;;) { const j = t.indexOf(n, i); if (j < 0) return c; c++; i = j + n.length; } };

if (!existsSync(SITE)) die('not a site tree: ' + SITE + ' (pass --site=<dir>)');
if (!existsSync(GUARD)) die('missing ' + GUARD);

const ASSETS = join(SITE, 'assets');
if (!existsSync(ASSETS)) die('no assets/ under ' + SITE);
const surfaceName = readdirSync(ASSETS).find((f) => /^spice-simulation-surface-.*\.js$/.test(f));
const deckName = 'src-CMkpkg0p.js';
if (!surfaceName) die('no spice-simulation-surface chunk under ' + ASSETS);
if (!existsSync(join(ASSETS, deckName))) die('no ' + deckName + ' under ' + ASSETS);

const surfacePath = join(ASSETS, surfaceName);
const deckPath = join(ASSETS, deckName);
if (!readFileSync(surfacePath, 'utf8').includes('function rgAnnotate')) {
  die('the tree at ' + SITE + ' carries no rgAnnotate, so it was never patched with the region annotation');
}

// The bytes the two sides emit, quoted once so every mutation reads as a
// statement about the artifact rather than as a pile of escapes.
const DECK_SSFF = 'c===`ss`?1:c===`ff`?-1';
const DECK_SSFF_FLIP = 'c===`ss`?-1:c===`ff`?1';
const DECK_TT = 'c===`tt`)return`.include ${n}`';
const DECK_TT_BROKEN = 'c===`tt`)return`.include ${n}\n.param __cn_sel=1`';
const ANN_SSFF = 'section === `ss` ? 1 : section === `ff` ? -1';
const ANN_SSFF_FLIP = 'section === `ss` ? -1 : section === `ff` ? 1';

// --- the cases -------------------------------------------------------------
const CASES = [
  {
    id: 'control',
    why: 'an unmutated patched tree must be clean, or nothing below is evidence',
    edits: [],
    expectStatus: 'checked',
    exact: [],
  },
  {
    id: 'annotation-absent',
    why: 'a tree with rgAnnotate removed must report the feature absent, not as a finding',
    edits: [[join('assets', surfaceName), 'function rgAnnotate', 'function old_rgAnnotate']],
    expectStatus: 'absent',
    exact: [],
  },
  {
    id: 'deck-ss-ff-flipped',
    why: 'the emitter swaps ss and ff: an ss simulation is tagged the ff selector while the annotation still reads ss as +1',
    edits: [[join('assets', deckName), DECK_SSFF, DECK_SSFF_FLIP]],
    expectStatus: 'checked',
    exact: ['corner-map:ss', 'corner-map:ff'],
  },
  {
    id: 'annotation-ss-ff-flipped',
    why: 'the annotation swaps ss and ff: the same silent misjudgement, approached from the other side',
    edits: [[join('assets', surfaceName), ANN_SSFF, ANN_SSFF_FLIP]],
    expectStatus: 'checked',
    exact: ['corner-map:ss', 'corner-map:ff'],
  },
  {
    id: 'both-flipped',
    why: 'both sides swap ss and ff together: they still agree with each other, but both disagree with the canonical {-1,0,+1} map',
    edits: [
      [join('assets', deckName), DECK_SSFF, DECK_SSFF_FLIP],
      [join('assets', surfaceName), ANN_SSFF, ANN_SSFF_FLIP],
    ],
    expectStatus: 'checked',
    exact: ['corner-map:ss', 'corner-map:ff'],
  },
  {
    id: 'deck-tt-broken',
    why: 'tt stops mapping to selector 0 and instead emits __cn_sel=1 -- the typical case every default setup uses',
    edits: [[join('assets', deckName), DECK_TT, DECK_TT_BROKEN]],
    expectStatus: 'checked',
    exact: ['corner-map:tt'],
  },
];

// --- the harness -----------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), 'corner-negctl-'));
const WORK = join(TMP, 'site');
const MUTATED = [];

function snapshot(p) {
  if (!MUTATED.some((m) => m.path === p)) MUTATED.push({ path: p, text: readFileSync(p, 'utf8') });
}
function restore() {
  for (const m of MUTATED) writeFileSync(m.path, m.text);
  MUTATED.length = 0;
}

function applyEdit(root, file, find, replace) {
  const p = join(root, file);
  if (!existsSync(p)) die('mutation target is not in the tree: ' + file);
  snapshot(p);
  const before = readFileSync(p, 'utf8');
  const n = count(before, find);
  if (n !== 1) {
    die('anchor ' + JSON.stringify(String(find).slice(0, 70)) + ' occurs ' + n + ' time(s) in ' + file + ', not once -- the mutation would not mean what this case says it means');
  }
  const after = before.split(find).join(replace);
  if (after === before) die('the mutation of ' + file + ' changed nothing');
  writeFileSync(p, after);
}

function runCheck(site) {
  const js = join(TMP, 'check-' + Math.random().toString(36).slice(2) + '.json');
  const r = spawnSync(process.execPath, [GUARD, '--site=' + site, '--json=' + js], { encoding: 'utf8' });
  if (!existsSync(js)) {
    die('check-artifacts produced no JSON report (exit ' + r.status + ')\n' + (r.stderr || '').slice(0, 800));
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(js, 'utf8'));
  } catch (e) {
    die('cannot read the check report: ' + e.message);
  }
  if (!parsed.cornerMapping) die('the check report carries no cornerMapping section');
  const j = parsed.cornerMapping;
  return { status: j.status, keys: (j.findings ?? []).map((f) => f.key).sort(), notes: j.notes ?? [] };
}

// --- run -------------------------------------------------------------------
console.log('corner-mapping.negctl');
console.log('  guard    = ' + GUARD);
console.log('  site     = ' + SITE);
console.log('  surface  = ' + surfaceName);
console.log('  deck     = ' + deckName);
console.log('  work     = ' + WORK);
console.log('');

cpSync(SITE, WORK, { recursive: true });

const report = [];
let failures = 0;
let ran = 0;

for (const c of CASES) {
  if (ONLY.length && !ONLY.includes(c.id)) continue;
  ran++;
  restore();
  const problems = [];

  try {
    for (const [file, find, replace] of c.edits ?? []) applyEdit(WORK, file, find, replace);
  } catch (e) {
    die(e.message);
  }

  const got = runCheck(WORK);
  const wantStatus = c.expectStatus ?? 'checked';
  if (got.status !== wantStatus) {
    problems.push('status is ' + got.status + ', expected ' + wantStatus + (got.notes.length ? ' [' + got.notes.join('; ') + ']' : ''));
  }
  if (got.status === wantStatus && wantStatus !== 'absent' && c.exact) {
    const want = c.exact.slice().sort();
    if (JSON.stringify(got.keys) !== JSON.stringify(want)) {
      problems.push('findings are ' + JSON.stringify(got.keys) + ', expected exactly ' + JSON.stringify(want));
    }
  }

  const ok = problems.length === 0;
  if (!ok) failures++;
  report.push({ id: c.id, ok, problems, keys: got.keys, status: got.status });
  console.log((ok ? '  ok   ' : '  FAIL ') + c.id);
  console.log('         ' + c.why);
  if (ok) {
    console.log('         ' + got.status + '  ' + (got.keys.length ? JSON.stringify(got.keys) : '(no finding)'));
  } else {
    for (const p of problems) console.log('         -> ' + p);
  }
}

restore();
if (KEEP) {
  console.log('\nkept ' + TMP);
} else {
  rmSync(TMP, { recursive: true, force: true });
}

console.log('');
console.log((failures === 0 ? 'all ' + ran + ' case(s) behaved' : failures + ' of ' + ran + ' case(s) did not behave'));
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify({ site: SITE, cases: report, failures }, null, 2), 'utf8');
}
process.exit(failures === 0 ? 0 : 1);
