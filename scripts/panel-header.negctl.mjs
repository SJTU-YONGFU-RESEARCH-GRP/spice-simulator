#!/usr/bin/env node
/**
 * Prove that check 21 is not vacuous.
 *
 * check 21 claims the Measurements panel's outer card (function Nt) leads its
 * "X values" with the TOTAL (e.length), matching the per-output group headers
 * which lead with their GROUP TOTAL (t.length) -- not with the available count
 * (n = e.length - t.length). See D2-b' and scripts/panel-header.json.
 *
 * A guard can be green for the wrong reason: an anchor that stopped matching, a
 * needle compared against itself. The only way to tell a working guard from a
 * lucky one is to break the thing it guards and require it to say the specific
 * thing.
 *
 * Cases:
 *   control          an unmutated patched copy must produce NO finding.
 *   outer-reverted   the outer header is reverted to the defect form (leads with
 *                    n, the available count). Both positive assertions must fire:
 *                    'outer-leads-with-available' (the defect is present) and
 *                    'outer-missing-total' (the fixed form is gone).
 *   inner-removed    the per-output group header no longer leads with t.length;
 *                    the inner-group-missing assertion must fire while the outer
 *                    stays clean, proving the two assertions are independent.
 *   card-absent      function Nt is gone entirely; the check must go quiet
 *                    (status 'absent'), because the failure it exists for is a
 *                    tree that HAS the card with the wrong header, not one that
 *                    never had the card.
 *
 * Mutations are anchored on the bytes the patcher wrote and every anchor must
 * occur exactly once -- a mutation that silently matched nothing would become a
 * case that "passes" because nothing changed.
 *
 * Usage
 *   node scripts/panel-header.negctl.mjs [--site=<dir>] [--only=<id,...>] [--keep]
 *
 * --site defaults to ./site and must be a patched tree. Exit codes: 0 every case
 * behaved, 1 a case did not, 2 setup error.
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

const die = (msg) => { console.error('panel-header.negctl: ' + msg); process.exit(2); };
const count = (t, n) => { let c = 0, i = 0; for (;;) { const j = t.indexOf(n, i); if (j < 0) return c; c++; i = j + n.length; } };

if (!existsSync(GUARD)) die('missing ' + GUARD);

// The surface chunk carries a content hash that moves on every rebuild, so find
// it the way check 21 finds it.
const assetsDir = join(SITE, 'assets');
if (!existsSync(assetsDir)) die('no assets/ under ' + SITE);
const surfaces = readdirSync(assetsDir).filter((f) => /^spice-simulation-surface-.*\.js$/.test(f));
if (!surfaces.length) die('no spice-simulation-surface chunk under ' + assetsDir);
const SURFACE = 'assets/' + surfaces[0];
const surfacePath = join(SITE, SURFACE.split('/').join('\\'));
if (!readFileSync(surfacePath, 'utf8').includes('function Nt({measurements:e}){')) {
  die('the tree at ' + SITE + ' has no Measurements panel (function Nt); pass a patched --site=<dir>');
}

// The bytes check 21 reasons about, quoted once so each mutation reads as a
// statement about the artifact rather than as a pile of escapes.
const OUTER_DEFECT = 'children:[n,` `,n===1?`value`:`values`';
const OUTER_FIXED = 'children:[e.length,` `,e.length===1?`value`:`values`';
const INNER_INTACT = 'children:[t.length,` `,t.length===1?`value`:`values`';
const OUTER_SPAN_FIXED = '{"data-status":t.length?`attention`:`ready`,children:[e.length,` `,e.length===1?`value`:`values`,t.length?` · ${t.length} unavailable`:``]}';
const OUTER_SPAN_DEFECT = '{"data-status":t.length?`attention`:`ready`,children:[n,` `,n===1?`value`:`values`,t.length?` · ${t.length} unavailable`:``]}';

// --- the cases -------------------------------------------------------------
const CASES = [
  {
    id: 'control',
    why: 'an unmutated patched tree must be clean, or nothing below is evidence',
    edits: [],
    exact: [],
  },
  {
    id: 'outer-reverted',
    why: 'the outer header is reverted to the defect form (leads with n, the available count), so both positive assertions must fire',
    edits: [[SURFACE, OUTER_SPAN_FIXED, OUTER_SPAN_DEFECT]],
    exact: ['panel-header:outer-leads-with-available', 'panel-header:outer-missing-total'],
  },
  {
    id: 'inner-removed',
    why: 'the per-output group header no longer leads with t.length; the inner-group-missing assertion must fire while the outer stays clean',
    edits: [[SURFACE, INNER_INTACT, 'children:[t.size,` `,t.size===1?`value`:`values`']],
    exact: ['panel-header:inner-group-missing'],
  },
  {
    id: 'card-absent',
    why: 'function Nt is gone entirely; the check must go quiet (status absent)',
    edits: [[SURFACE, 'function Nt({measurements:e}){', 'function Nz({measurements:e}){']],
    expectStatus: 'absent',
    exact: [],
  },
];

// --- the harness -----------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), 'panel-header-negctl-'));
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
  const p = join(root, file.split('/').join('\\'));
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
  if (!parsed.panelHeader) die('the check report carries no panelHeader section');
  const j = parsed.panelHeader;
  return { status: j.status, keys: (j.findings ?? []).map((f) => f.key).sort(), notes: j.notes ?? [] };
}

// --- run -------------------------------------------------------------------
console.log('panel-header.negctl');
console.log('  site     = ' + SITE);
console.log('  surface  = ' + SURFACE);
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
  if (c.exact) {
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
process.exit(failures === 0 ? 0 : 1);
