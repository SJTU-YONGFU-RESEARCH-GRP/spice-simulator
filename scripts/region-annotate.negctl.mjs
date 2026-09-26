#!/usr/bin/env node
/**
 * Prove that check 19 is not vacuous.
 *
 * check 19 claims a stack of specific things about the MOS-operating-region
 * repair: the table in the artifact is re-derived from models/cmos.lib (the only
 * place the LEVEL=1 parameters exist, since the deck the engine runs carries
 * `.include` and a corner selector and nothing else); the row element and the
 * callsite that feeds it are each present exactly once; the five clauses that
 * make a reading trustworthy -- the refusal, the edge band, the model lookup,
 * the body-effect term, the PMOS sign flip -- are all still there; and none of
 * it leaked into the artifact-schema chunk, whose metric enum is closed and
 * declared twice, so ONE unlisted name there makes the client discard the whole
 * result file and the panel lose every measurement the user had.
 *
 * A guard like that can be green for reasons that have nothing to do with the
 * artifact being right -- an anchor that stopped matching so a rule never ran, a
 * needle compared against itself, a table compared with a copy of itself pasted
 * in the wrong chunk. The only way to tell a working guard from a lucky one is
 * to break the thing it guards, one way at a time, and require it to say the
 * specific thing it is supposed to say.
 *
 * Two cases are controls in the other direction:
 *
 *   control          an unmutated patched copy must produce NO finding, or the
 *                    mutant results below mean nothing;
 *   unpatched-tree   a copy with the manifest reversed, so the feature is absent
 *                    entirely, must fail with its own list of keys -- this rules
 *                    out a check that would also pass on a tree that never had
 *                    the repair. It is built here, by applying the manifest
 *                    backwards, rather than read from the tree under test, which
 *                    is expected to ship patched.
 *
 * The mutants, and the reason each was chosen:
 *
 *   table-value-mutated      one parameter in the artifact's table moves, so the
 *                            row is now computed from numbers the engine never
 *                            solved against. This is the silent half of the
 *                            corner question: the row still renders, the number
 *                            still looks like a number, and it is wrong.
 *   library-vto-moved        the LIBRARY moves and the manifest does not. The
 *                            case the re-derivation exists for: an upstream
 *                            corner tweak in cmos.lib would otherwise leave every
 *                            transistor judged against the previous process.
 *   library-model-dropped    a whole LEVEL=1 model leaves the library. Both the
 *                            set comparison and the per-model source comparison
 *                            have something to say, and both must say it.
 *   exclusion-level-one      the manifest excludes a model the library declares
 *                            at LEVEL=1. The exclusion list is the one place a
 *                            model can be dropped from the table without the set
 *                            comparison noticing, and a LEVEL=1 model excluded
 *                            is exactly the model the table exists for.
 *   row-class-dropped        the row element stops being rendered: the table and
 *                            every function are intact, the callsite is intact,
 *                            and the screen gains nothing.
 *   callsite-reverted        the card is handed the RAW device list again. Bytes
 *                            change, the table is present, the row component is
 *                            present -- and no device ever carries `region`. This
 *                            is the exact shape that made an earlier import
 *                            repair a no-op: patched, hashed, and inert.
 *   refusal-dropped          the cutoff branch stops refusing and returns null
 *                            instead, so a device that cannot be judged is
 *                            silently given no line rather than being skipped on
 *                            purpose.
 *   edge-band-widened        the tolerance moves by a decade, so devices right at
 *                            the boundary are called flatly linear or saturated
 *                            rather than "at the edge".
 *   body-effect-gone         Vth stops moving with VSB, so a source-degenerated
 *                            device is misjudged by the amount the body effect
 *                            contributes.
 *   pmos-flip-gone           the sign flip goes, so every PMOS is judged with
 *                            NMOS signs -- and, since the failure is symmetric,
 *                            it still prints a plausible region for a large part
 *                            of the operating plane.
 *   model-lookup-gone        the model name is no longer read from the schematic
 *                            instance, so the lookup is by nothing and every
 *                            device falls through to a refusal.
 *   payload-leak-table       the table is pasted into the schema chunk. The row
 *                            would still work; what breaks is the result file,
 *                            discarded whole for a metric name the closed enum
 *                            does not carry.
 *   payload-leak-rowclass    the same rule's other arm: the row class -- not the
 *                            table -- reaches the schema chunk. One boolean over
 *                            two needles is one boolean that can go stale on
 *                            either of them.
 *   manifest-field-missing   a manifest with one required clause missing must be
 *                            reported as unusable rather than passing every rule
 *                            it can longer check.
 *   manifest-param-edited    the table literal is left alone and the manifest's
 *                            own parameters move, which is what a hand-edited
 *                            contract looks like.
 *   manifest-absent          a manifest path that is not there: no reading of
 *                            this tree is possible, and the check must say so
 *                            rather than pass.
 *   card-absent              the tree does not draw the per-device card at all.
 *                            The check must go quiet -- the failure it exists for
 *                            is a tree that HAS the card and no annotation, not
 *                            one that never had the card.
 *
 * Mutations are anchored on the bytes the patcher writes, and every anchor must
 * occur exactly once -- a mutation that silently matched nothing would turn into
 * a case that "passes" because nothing changed.
 *
 * `exact` cases declare the COMPLETE set of finding keys their mutation must
 * produce, so a surgical mutation that tripped three unrelated rules fails here
 * too: a check that fires on everything is as useless as one that fires on
 * nothing. `unpatched-tree` asserts a subset plus an `absent` list, because "the
 * feature is absent" legitimately trips most of the check and the point there is
 * which keys must NOT appear.
 *
 * Usage
 *   node scripts/region-annotate.negctl.mjs [--site=<dir>] [--only=<id,...>]
 *                                           [--keep] [--json=<file>]
 *
 * --site defaults to ./site and must be a tree the patcher produced from the
 * same manifest. Exit codes: 0 every case behaved, 1 a case did not, 2 setup
 * error.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const GUARD = join(HERE, 'check-artifacts.mjs');
const MANIFEST = join(HERE, 'region-annotate.json');

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

const die = (msg) => { console.error('region-annotate.negctl: ' + msg); process.exit(2); };
const count = (t, n) => { let c = 0, i = 0; for (;;) { const j = t.indexOf(n, i); if (j < 0) return c; c++; i = j + n.length; } };

// --- the manifest drives every path and every anchor ------------------------
if (!existsSync(MANIFEST)) die('missing ' + MANIFEST + ' (run scripts/region-annotate.manifest.cjs)');
if (!existsSync(GUARD)) die('missing ' + GUARD);

let manifestJson;
let manifestText;
try {
  manifestText = readFileSync(MANIFEST, 'utf8');
  manifestJson = JSON.parse(manifestText);
} catch (e) {
  die('cannot read the manifest as JSON: ' + e.message);
}
const C = manifestJson.contract ?? {};
const REPAIRS = manifestJson.repairs ?? [];
for (const k of ['surfaceFile', 'libraryFile', 'tableLiteral', 'tableMarker', 'rowClass',
  'utAnchor', 'utRowAnchor', 'callsiteFind', 'callsiteReplace', 'refusalNeedle',
  'edgeToleranceNeedle', 'modelLookupNeedle', 'bodyEffectNeedle', 'pmosFlipNeedle', 'models']) {
  if (C[k] === undefined || C[k] === null || C[k] === '') die('the manifest has no contract.' + k + ', so an anchor below has no home');
}
if (!REPAIRS.length) die('the manifest declares no repairs, so the unpatched-tree control cannot be built');

const SURFACE = C.surfaceFile;
const LIBRARY = C.libraryFile;
const TABLE = String(C.tableMarker) + String(C.tableLiteral) + ';';
const TABLE_MARKER = String(C.tableMarker);

const surfacePath = join(SITE, SURFACE);
const libraryPath = join(SITE, LIBRARY);
if (!existsSync(surfacePath)) {
  die('not a patched site tree (' + SITE + '): ' + SURFACE + ' is not there. Pass --site=<dir>.');
}
if (!readFileSync(surfacePath, 'utf8').includes(TABLE_MARKER)) {
  die('the tree at ' + SITE + ' carries no region table, so it was never patched. Run patch-outbound.mjs --manifest=scripts/region-annotate.json --site=<dir> first.');
}
if (!existsSync(libraryPath)) die('the tree at ' + SITE + ' has no ' + LIBRARY);

// The schema chunk, found the way check 19 finds it rather than named here: the
// chunk carries a content hash that moves on every upstream rebuild.
const assetsDir = join(SITE, 'assets');
const schemas = existsSync(assetsDir) ? readdirSync(assetsDir).filter((f) => /^files-.*\.js$/.test(f)) : [];
if (!schemas.length) die('no artifact-schema chunk under ' + assetsDir + ', so the leak case cannot be aimed');

// The bytes the patcher wrote, quoted once so every mutation below reads as a
// statement about the artifact rather than as a pile of escapes.
const REFUSAL = C.refusalNeedle;
const EDGE = C.edgeToleranceNeedle;
const LOOKUP = C.modelLookupNeedle;
const BODY = C.bodyEffectNeedle;
const FLIP = C.pmosFlipNeedle;
const ROW = C.rowClass;
const CALLSITE = C.callsiteReplace;
const VTO_NMOS_RVT = '"vto":[0.5,0.08]';
const NMOS_RVT_LINE = C.models.nmos_rvt.source;

// --- the cases -------------------------------------------------------------
const CASES = [
  {
    id: 'control',
    why: 'an unmutated patched tree must be clean, or nothing below is evidence',
    edits: [],
    exact: [],
  },
  {
    id: 'unpatched-tree',
    why: 'the tree with the manifest reversed, where the annotation does not exist at all',
    reverse: true,
    expect: [
      'region-table-drift',
      'region-wiring:the-row-element',
      'region-wiring:the-callsite',
      'region-refusal-lost:the-refusal-branch',
      'region-refusal-lost:the-tolerance-band',
      'region-refusal-lost:the-model-lookup',
      'region-refusal-lost:the-body-effect-term',
      'region-refusal-lost:the-PMOS-sign-flip',
    ],
    // Claims this check must NOT make about a tree that never had the feature.
    // The library and the manifest both still declare all eight models, so the
    // set/parameter comparisons have nothing to report; and nothing was pasted
    // into the schema, so the leak rule has nothing to report either.
    absent: [
      'region-model-set-drift',
      'region-source-drift:nmos_rvt',
      'region-param-drift:nmos_rvt',
      'region-contract-vacuous',
    ],
  },
  {
    id: 'table-value-mutated',
    why: 'one parameter in the artifact table moves, so the row is computed from numbers the engine never solved against',
    edits: [[SURFACE, VTO_NMOS_RVT, '"vto":[0.51,0.08]']],
    exact: ['region-table-drift'],
  },
  {
    id: 'exclusion-level-one',
    why: 'the manifest excludes a model the library declares at LEVEL=1: the exclusion list is the one place a model can leave the table without the set comparison noticing, and a LEVEL=1 model excluded is exactly the model the table exists for',
    manifestEdit: (m) => {
      m.contract.excluded = [{ name: 'nmos_rvt', source: m.contract.models.nmos_rvt.source, level: '1' }];
    },
    exact: ['region-exclusion-level-one:nmos_rvt'],
  },
  {
    id: 'library-vto-moved',
    why: 'the LIBRARY moves and the manifest does not: the corner tweak that would leave every transistor judged against the previous process',
    edits: [[LIBRARY, NMOS_RVT_LINE, NMOS_RVT_LINE.replace('VTO={0.5+0.08*__cn_sel}', 'VTO={0.52+0.08*__cn_sel}')]],
    exact: ['region-source-drift:nmos_rvt'],
  },
  {
    id: 'library-model-dropped',
    why: 'a whole LEVEL=1 model leaves the library: both the set comparison and the per-model source comparison must speak',
    edits: [[LIBRARY, NMOS_RVT_LINE, '']],
    exact: ['region-model-set-drift', 'region-source-drift:nmos_rvt'],
  },
  {
    id: 'row-class-dropped',
    why: 'the row element stops being rendered: table intact, callsite intact, screen gains nothing',
    edits: [[SURFACE, ROW, 'sim-region-line']],
    exact: ['region-wiring:the-row-element'],
  },
  {
    id: 'callsite-reverted',
    why: 'the card is handed the raw device list again: bytes change, table present, row present, and no device ever carries `region`',
    edits: [[SURFACE, CALLSITE, C.callsiteFind]],
    exact: ['region-wiring:the-callsite'],
  },
  {
    id: 'refusal-dropped',
    why: 'the cutoff branch returns null instead of refusing, so a device that cannot be judged is given no line rather than skipped on purpose',
    edits: [[SURFACE, REFUSAL, 'if (!(VOV > 0)) return null; // Region  Cutoff']],
    exact: ['region-refusal-lost:the-refusal-branch'],
  },
  {
    id: 'edge-band-widened',
    why: 'the tolerance moves by a decade, so a device right at the boundary is called flatly linear or saturated instead of "at the edge"',
    edits: [[SURFACE, EDGE, '<= 0.2 * Math.abs(VOV)']],
    exact: ['region-refusal-lost:the-tolerance-band'],
  },
  {
    id: 'body-effect-gone',
    why: 'Vth stops moving with VSB, so a source-degenerated device is misjudged by exactly the body-effect term',
    edits: [[SURFACE, BODY, 'VTH = VTO']],
    exact: ['region-refusal-lost:the-body-effect-term'],
  },
  {
    id: 'pmos-flip-gone',
    why: 'the sign flip goes, so every PMOS is judged with NMOS signs -- and, being symmetric, still prints a plausible region over much of the plane',
    edits: [[SURFACE, FLIP, 'let s = 1;']],
    exact: ['region-refusal-lost:the-PMOS-sign-flip'],
  },
  {
    id: 'model-lookup-gone',
    why: 'the model name stops being read from the schematic instance, so every device falls through to a refusal',
    edits: [[SURFACE, LOOKUP, 'null']],
    exact: ['region-refusal-lost:the-model-lookup'],
  },
  {
    id: 'payload-leak-table',
    why: 'the table is pasted into the schema chunk: the metric enum is closed and declared twice, so the result file is discarded whole and every measurement disappears',
    edits: [[join('assets', schemas[0]), null, '\nvar rgTable = ' + C.tableLiteral + ';\n']],
    append: true,
    exact: ['region-in-payload:' + schemas[0]],
  },
  {
    id: 'payload-leak-rowclass',
    why: 'the same rule\'s other arm: the row class -- not the table -- reaches the schema chunk, so the one boolean that guards both needles cannot go stale on either',
    edits: [[join('assets', schemas[0]), null, '\nvar rgRowClass = ' + JSON.stringify(C.rowClass) + ';\n']],
    append: true,
    exact: ['region-in-payload:' + schemas[0]],
  },
  {
    id: 'manifest-field-missing',
    why: 'a manifest with one required clause missing must be reported as unusable rather than passing every rule it can no longer check',
    manifestEdit: (m) => { delete m.contract.pmosFlipNeedle; },
    expectStatus: 'vacuous',
    exact: ['region-contract-vacuous'],
  },
  {
    id: 'manifest-param-edited',
    why: 'the table literal is left alone and the manifest\'s own parameters move, which is what a hand-edited contract looks like',
    manifestEdit: (m) => { m.contract.models.nmos_rvt.vto = [0.55, 0.08]; },
    exact: ['region-param-drift:nmos_rvt'],
  },
  {
    id: 'manifest-absent',
    why: 'a manifest path that is not there: no reading of this tree is possible, and the check must say so rather than pass',
    regionMissing: true,
    expectStatus: 'absent',
    exact: [],
  },
  {
    id: 'card-absent',
    why: 'the tree does not draw the per-device card at all -- the check must go quiet, because the failure it exists for is a tree that HAS the card and no annotation',
    edits: [[SURFACE, C.utAnchor, String(C.utAnchor).replace('function Ut(', 'function Uz(')]],
    expectStatus: 'absent',
    exact: [],
  },
];

// --- the harness -----------------------------------------------------------
const TMP = mkdtempSync(join(tmpdir(), 'region-negctl-'));
const WORK = join(TMP, 'site');
const MUTATED = [];

function snapshot(p) {
  if (!MUTATED.some((m) => m.path === p)) MUTATED.push({ path: p, text: readFileSync(p, 'utf8') });
}
function restore() {
  for (const m of MUTATED) writeFileSync(m.path, m.text);
  MUTATED.length = 0;
}

function applyEdit(root, file, find, replace, append) {
  const p = join(root, file);
  if (!existsSync(p)) die('mutation target is not in the tree: ' + file);
  snapshot(p);
  const before = readFileSync(p, 'utf8');
  let after;
  if (append) {
    after = before + replace;
  } else {
    const n = find instanceof RegExp
      ? (before.match(new RegExp(find.source, find.flags.includes('g') ? find.flags : find.flags + 'g')) ?? []).length
      : count(before, find);
    if (n !== 1) {
      die('anchor ' + JSON.stringify(String(find).slice(0, 70)) + ' occurs ' + n + ' time(s) in ' + file + ', not once -- the mutation would not mean what this case says it means');
    }
    after = find instanceof RegExp ? before.replace(find, replace) : before.split(find).join(replace);
  }
  if (after === before) die('the mutation of ' + file + ' changed nothing');
  writeFileSync(p, after);
}

function runCheck(site, regionArg) {
  const js = join(TMP, 'check-' + Math.random().toString(36).slice(2) + '.json');
  const args = [GUARD, '--site=' + site, '--json=' + js];
  if (regionArg !== undefined) args.push('--region=' + regionArg);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (!existsSync(js)) {
    die('check-artifacts produced no JSON report (exit ' + r.status + ')\n' + (r.stderr || '').slice(0, 800));
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(js, 'utf8'));
  } catch (e) {
    die('cannot read the check report: ' + e.message);
  }
  if (!parsed.regionAnnotation) die('the check report carries no regionAnnotation section');
  const j = parsed.regionAnnotation;
  return { status: j.status, keys: (j.findings ?? []).map((f) => f.key).sort(), notes: j.notes ?? [] };
}

// --- run -------------------------------------------------------------------
console.log('region-annotate.negctl');
console.log('  manifest = ' + MANIFEST);
console.log('  site     = ' + SITE);
console.log('  surface  = ' + SURFACE);
console.log('  schema   = ' + schemas.join(', '));
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
    if (c.reverse) {
      for (const rep of REPAIRS) {
        for (const ed of rep.edits ?? []) applyEdit(WORK, rep.file, ed.replace, ed.find, false);
      }
    }
    for (const [file, find, replace] of c.edits ?? []) applyEdit(WORK, file, find, replace, c.append && find === null);
  } catch (e) {
    die(e.message);
  }

  let regionArg;
  if (c.regionMissing) {
    regionArg = join(TMP, 'no-such-manifest.json');
  } else if (c.manifestEdit) {
    const m = JSON.parse(manifestText);
    c.manifestEdit(m);
    regionArg = join(TMP, 'manifest-' + c.id + '.json');
    writeFileSync(regionArg, JSON.stringify(m, null, 2));
  }

  const got = runCheck(WORK, regionArg);
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
  for (const k of c.expect ?? []) {
    if (!got.keys.includes(k)) problems.push('expected finding ' + k + ' and it is not there (' + JSON.stringify(got.keys) + ')');
  }
  for (const k of c.absent ?? []) {
    if (got.keys.includes(k)) problems.push('this check must not claim ' + k + ' about a tree that never had the feature');
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
  writeFileSync(JSON_OUT, JSON.stringify({ site: SITE, manifest: MANIFEST, cases: report, failures }, null, 2), 'utf8');
}
process.exit(failures === 0 ? 0 : 1);
