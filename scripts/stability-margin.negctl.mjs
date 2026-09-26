#!/usr/bin/env node
/**
 * Prove that check 18 is not vacuous.
 *
 * check 18 claims a stack of specific things about the stability-margin repair:
 * the evaluator is present, it is CALLED rather than merely defined, the two
 * metric names are members of BOTH variants of the artifact schema's CLOSED
 * metric enum, the evaluator emits each record with its own metric/label/unit,
 * it keeps the five properties that make the number correct (unwrapped phase,
 * level-aware crossing search, margin referenced to the loop's own static
 * phase, AC-only, schema-shaped evidence), it emits a refusal rather than a gap
 * when a margin is undefined, and it derives the curve from the same two
 * expressions the plotted Bode curve is built from.
 *
 * A guard like that can be green for reasons that have nothing to do with the
 * artifact being right -- an anchor that stopped matching so a rule never ran, a
 * needle compared against itself, an enum counted in the wrong file. The only
 * way to tell a working guard from a lucky one is to break the thing it guards,
 * one way at a time, and require it to say the specific thing it is supposed to
 * say.
 *
 * Two of the cases are controls in the other direction:
 *
 *   control          an unmutated patched copy must produce NO finding, or the
 *                    mutant results below mean nothing;
 *   unpatched-tree   a copy with the manifest reversed, so the feature is absent
 *                    entirely, must fail -- this rules out a check that would
 *                    also pass on a tree that never had the repair. It is built
 *                    here rather than read from the tree under test, which is
 *                    expected to ship patched.
 *
 * The mutants, and the reason each was chosen:
 *
 *   splice-removed          THE case this check exists for. The evaluator stays
 *                           defined and every one of its bytes is intact -- a
 *                           text search finds a perfectly healthy evaluator --
 *                           while the measurement splice reverts to its pre-patch
 *                           form. The function computes correct margins that
 *                           nothing ever reads. This is the exact shape that made
 *                           an earlier import repair a no-op: bytes changed,
 *                           hashes changed, --check green, behaviour identical.
 *   evaluator-renamed       the entry point is renamed by one character, so the
 *                           definition and the call disagree.
 *   schema-enum-half        ONE of the two schema variants stops admitting the
 *                           metrics. This is the regression that made the first
 *                           version of this patch ship broken -- the artifact
 *                           fails validation and is discarded WHOLE, so every
 *                           measurement disappears and the panel reads "Full
 *                           result files are unavailable or invalid". The
 *                           "exactly two" rule exists for the half-applied case;
 *                           the fully-reverted case is the unpatched tree.
 *   emit-unit-is-output     the record stops carrying its own unit and inherits
 *                           the output's, so a phase margin of 90.6 renders as
 *                           "90.6 V". Populated, plausible, and wrong.
 *   property-level-test     the crossing search reverts to a SIGN test. Right for
 *                           0 dB by accident, wrong for the -180 deg threshold
 *                           (it catches the +/-180 wrap instead) and wrong for a
 *                           phase passing through 0 deg (it reports a gain
 *                           margin). Byte-for-byte the defect that was found by
 *                           reading the evaluator against its own uses.
 *   property-phase-ref      the phase margin reverts to an absolute reference. An
 *                           inverting loop then reads 275 degrees instead of 95,
 *                           and the same loop's instability is missed by a full
 *                           180 degrees. Found only at runtime.
 *   property-ac-only        the evaluator accepts `noise` again, where a phase
 *                           margin is meaningless.
 *   property-evidence-shape evidence reverts to an invented field name, which
 *                           matches neither arm of the schema's union. Latent:
 *                           invisible while every observed row is `unavailable`,
 *                           because those carry no evidence at all.
 *   property-unwrap         the phase stops being unwrapped, so the +/-180 wrap
 *                           reads as a 360 degree jump.
 *   property-magnitude      the dB formula drifts from the surface's, so the
 *                           margin belongs to a different curve than the one the
 *                           user is reading.
 *   property-refusal        the refusal record builder disappears, so an
 *                           undefined margin becomes a missing row instead of a
 *                           row that says why.
 *   property-refusal-reason the builder stays and the record still validates, but
 *                           the reason is dropped: the row renders, says
 *                           "Unavailable", and tells the reader nothing. THE one
 *                           mutant here that both channels are aimed at together
 *                           -- static, because a refusal has to carry its reason;
 *                           browser, because on the shipped content the refusal
 *                           is the only branch that is ever reached, so a control
 *                           that never renders a refusal controls nothing.
 *   surface-phase-drift     the surface rewrites phaseDeg, so the plotted curve
 *                           and the measured margin diverge.
 *   authoring-leak-label    the metrics are added to the setup editor's label
 *                           table. Margin is automatic-only: the authoring
 *                           schema's method union has no margin member, so this
 *                           offers an option that cannot be saved.
 *   authoring-leak-selector the same leak through the method selector, which is
 *                           the mirror image -- the check has to see both.
 *   manifest-vacuous        a manifest with no contract would let every rule pass
 *                           silently while verifying nothing.
 *
 * The runtime half (scripts/stability-margin.mjs) is declared n/a for most cases,
 * and that is stated per case rather than hidden: those mutants are static
 * properties of the artifact, and several of them (a renamed emit, an inherited
 * unit, a reverted evidence field) produce the same rendered number. It IS run
 * for the two cases that claim something about the screen -- see `browser` below
 * and the notes on runBrowser. --static-only skips those two.
 *
 * Mutations are anchored on the bytes the patcher writes, and every anchor must
 * occur exactly `count` times -- a mutation that silently matched nothing would
 * turn into a case that "passes" because nothing changed.
 *
 * `exact` cases declare the COMPLETE set of finding keys their mutation must
 * produce, so a surgical mutation that tripped three unrelated rules fails here
 * too: a check that fires on everything is as useless as one that fires on
 * nothing. `unpatched-tree` asserts a subset plus an `absent` list, because "the
 * feature is absent" legitimately trips most of the check and the point there is
 * which keys must NOT appear.
 *
 * Usage
 *   node scripts/stability-margin.negctl.mjs [--site=<dir>] [--only=<id,...>]
 *                                            [--static-only] [--require]
 *                                            [--keep] [--json=<file>]
 *
 * --site defaults to ./site. Pointing it at a tree the patcher produced from the
 * same manifest lets this control run before the real tree is touched.
 *
 * Exit codes: 0 every case behaved, 1 a case did not, 2 setup error.
 */
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const GUARD = join(HERE, 'check-artifacts.mjs');
const MANIFEST = join(HERE, 'stability-margin.json');
const RESULT = join(REPO_ROOT, 'stability-margin-result.json');

const argv = process.argv.slice(2);
const has = (n) => argv.some((a) => a === '--' + n);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};
const SITE = resolve(REPO_ROOT, opt('site', 'site'));
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const STATIC_ONLY = has('static-only');
const REQUIRE = has('require');
const KEEP = has('keep');
const JSON_OUT = opt('json', null);

const die = (msg) => { console.error('stability-margin.negctl: ' + msg); process.exit(2); };

// --- the manifest drives every path and every anchor ------------------------
//
// Nothing here hardcodes a chunk name: the manifest already names the executor
// and the surface, and the surface chunk carries a content hash that moves on
// every upstream rebuild. Reading them back means an anchor cannot silently
// point at a file that no longer exists.
if (!existsSync(MANIFEST)) die('missing ' + MANIFEST);
if (!existsSync(GUARD)) die('missing ' + GUARD);

let manifestJson;
let manifestText;
try {
  manifestText = readFileSync(MANIFEST, 'utf8');
  manifestJson = JSON.parse(manifestText);
} catch (e) {
  die('cannot read the manifest as JSON: ' + e.message);
}
const CONTRACT = manifestJson.contract ?? {};
const EXECUTOR = CONTRACT.executorFile;
const SURFACE = CONTRACT.surfaceFile;
const SCHEMA = CONTRACT.schemaFile;
if (!EXECUTOR || !SURFACE || !SCHEMA) {
  die('the manifest names no executorFile/surfaceFile/schemaFile, so the anchors below have no home');
}
if (!existsSync(join(SITE, EXECUTOR))) {
  die('not a patched site tree (' + SITE + '): ' + EXECUTOR + ' is not there. Pass --site=<dir>.');
}

// The bytes the patcher writes, quoted once so every mutation below reads as a
// statement about the artifact rather than as a pile of escapes.
const BT = '`';
const SPLICE = CONTRACT.marginSplice;
const SPLICE_OFF = 'measurements:[...Xe(c),...nt(c,r)]';
const EVAL_DEF = CONTRACT.marginFunction;
const EMIT_PHASE = CONTRACT.phaseMarginEmit;
const EMIT_GAIN = CONTRACT.gainMarginEmit;
const LEVEL_TEST = CONTRACT.levelTestNeedle;
const PHASE_REF = CONTRACT.phaseReferenceNeedle;
const AC_ONLY = CONTRACT.acOnlyNeedle;
const EVIDENCE_SHAPE = CONTRACT.evidenceShapeNeedle;
const UNWRAP_DEF = CONTRACT.unwrapNeedle;
const MAG_FORMULA = CONTRACT.magnitudeFormulaNeedle;
// Two independent claims the contract makes about the emitter, so two needles:
// the record factory exists, and a refusal carries the reason it was given.
const REFUSAL_REASON = CONTRACT.unavailableNeedle;
const REFUSAL_DEF = CONTRACT.recordFactoryNeedle;
const SURFACE_PHASE = CONTRACT.surfacePhaseExpr;
const ENUM_PATCHED = CONTRACT.schemaMetricEnumPatched;
const ENUM_BASE = CONTRACT.schemaMetricEnum;
// The object literal that labels the AUTHORING methods, and the selector that
// offers them for an analysis kind. Both are authoring-side; the automatic path
// in the results panel carries its own label on each record and reads no table.
const NE_ANCHOR = 'ne={value:';
const D_ANCHOR = 'function D(e){return e===' + BT + 'op' + BT + '?[' + BT + 'value' + BT + ']:';
// The two schema variants are told apart by the status literal they end with,
// which is exactly how the manifest's own markers are built. Reading the marker
// back is what gives a mutation that targets ONE variant an anchor that occurs
// once: the enum text alone is written twice.
const repairMarker = (id) => {
  const rep = (manifestJson.repairs ?? []).find((r) => r.id === id);
  if (!rep || !rep.marker) die('the manifest declares no marker for repair ' + id);
  return rep.marker;
};
const MARKER_SCHEMA_AVAILABLE = repairMarker('margin-schema-available');
const MARKER_SCHEMA_UNAVAILABLE = repairMarker('margin-schema-unavailable');
if (!MARKER_SCHEMA_AVAILABLE.includes(ENUM_PATCHED) || !MARKER_SCHEMA_UNAVAILABLE.includes(ENUM_PATCHED)) {
  die('the schema repair markers do not quote the patched enum, so the half-reverted mutation has nothing to swap');
}

const CASES = [
  {
    id: 'control',
    why: 'an unmutated patched tree must be clean, or nothing below is evidence -- statically AND in the browser, or a browser failure below would only prove the harness is broken',
    edits: [],
    exact: [],
    browser: { expectPass: true },
  },
  {
    id: 'unpatched-tree',
    why: 'the tree with the manifest reversed, where the margin feature does not exist at all',
    unpatched: true,
    expect: [
      'margin-repair-missing:margin-evaluator',
      'margin-repair-missing:margin-splice',
      'margin-repair-missing:margin-schema-available',
      'margin-repair-missing:margin-schema-unavailable',
      'margin-evaluator-absent',
      'margin-schema-enum:0-of-2',
      'margin-schema-enum-unpatched',
      'margin-emit-missing:phase-margin',
      'margin-emit-missing:gain-margin',
      'margin-property-missing:crossing-search',
      'margin-property-missing:phase-reference',
      'margin-property-missing:record-factory',
      'margin-property-missing:refusal-record',
    ],
    // Claims this check must NOT make about a tree that never had the feature.
    // The unit/emit rules live behind "the evaluator exists", the splice rule
    // lives behind "it exists but is not called", and the surface was never
    // reverted by the manifest at all -- so none of these has anything to say.
    absent: [
      'margin-splice-missing',
      'margin-contract-vacuous',
      'margin-surface-drift:phase',
      'margin-surface-drift:magnitude',
      'margin-authoring-leak:phase-margin',
      'margin-authoring-leak:gain-margin',
      'margin-emit-undeclared:phase-margin',
      'margin-property-undeclared:crossing-search',
    ],
  },
  {
    id: 'splice-removed',
    why: 'the evaluator stays defined and intact while the measurement splice reverts -- computed correctly, read by nobody',
    edits: [[EXECUTOR, SPLICE, SPLICE_OFF]],
    exact: ['margin-repair-missing:margin-splice', 'margin-splice-missing'],
  },
  {
    id: 'evaluator-renamed',
    why: 'the entry point is renamed by one character, so the definition and the call disagree',
    edits: [[EXECUTOR, EVAL_DEF, 'function smMarginsX(e){let t=[];']],
    exact: ['margin-repair-missing:margin-evaluator', 'margin-evaluator-absent'],
  },
  {
    id: 'schema-enum-half',
    why: 'one of the two schema variants stops admitting the metrics; the artifact then fails validation and is discarded whole',
    edits: [[SCHEMA, MARKER_SCHEMA_UNAVAILABLE, MARKER_SCHEMA_UNAVAILABLE.replace(ENUM_PATCHED, ENUM_BASE)]],
    exact: ['margin-schema-enum:1-of-2', 'margin-schema-enum-unpatched', 'margin-repair-missing:margin-schema-unavailable'],
  },
  {
    id: 'emit-unit-is-output',
    why: 'the record inherits the output unit, so a phase margin renders as volts -- populated and wrong',
    edits: [[EXECUTOR, EMIT_PHASE, 'smRecord(n,e,i,' + BT + 'phase-margin' + BT + ',' + BT + 'Phase margin' + BT + ',n.unit,p,h,m)']],
    exact: ['margin-emit-missing:phase-margin'],
  },
  {
    id: 'emit-metric-renamed',
    why: 'the metric is renamed on the emitting side only, so the row that reaches the schema is one the enum does not admit',
    edits: [[EXECUTOR, EMIT_GAIN, 'smRecord(n,e,i,' + BT + 'gain-margin-db' + BT + ',' + BT + 'Gain margin' + BT + ',' + BT + 'dB' + BT + ',f,y,v)']],
    exact: ['margin-emit-missing:gain-margin'],
  },
  {
    id: 'property-level-test',
    why: 'the crossing search reverts to a sign test: right for 0 dB by accident, wrong for the threshold and for a phase passing through 0 degrees',
    edits: [[EXECUTOR, LEVEL_TEST, 'if(a*o<0){']],
    exact: ['margin-property-missing:level-test'],
  },
  {
    id: 'property-phase-ref',
    why: 'the margin reverts to an absolute reference: an inverting loop then reads 275 degrees and its instability is missed by a full 180',
    edits: [[EXECUTOR, PHASE_REF, 'p=180+t']],
    exact: ['margin-property-missing:phase-reference'],
  },
  {
    id: 'property-ac-only',
    why: 'a noise analysis is accepted again, where a phase margin is meaningless',
    edits: [[EXECUTOR, AC_ONLY, 'if(e.analysis===' + BT + 'noise' + BT + ')return;']],
    exact: ['margin-property-missing:ac-only'],
  },
  {
    id: 'property-evidence-shape',
    why: 'evidence reverts to an invented field name, which matches neither arm of the schema union -- latent, because unavailable rows carry none',
    edits: [[EXECUTOR, EVIDENCE_SHAPE, 'evidence:{kind:' + BT + 'point' + BT + ',frequencyHz:']],
    exact: ['margin-property-missing:evidence-shape'],
  },
  {
    id: 'property-unwrap',
    why: 'the phase stops being unwrapped, so the +/-180 wrap reads as a 360 degree jump',
    edits: [[EXECUTOR, UNWRAP_DEF, 'function smWrapSlow(']],
    exact: ['margin-property-missing:unwrap'],
  },
  {
    id: 'property-magnitude',
    why: 'the dB clamp floor drifts from the surface\'s, so the margin belongs to a different curve than the one on screen',
    edits: [[EXECUTOR, MAG_FORMULA, '20*Math.log10(Math.max(Math.hypot(t,n),1e-12))']],
    exact: ['margin-property-missing:magnitude-formula'],
  },
  {
    id: 'property-refusal',
    why: 'the record factory is renamed away, so neither row of a margin pair can be built at all',
    edits: [[EXECUTOR, REFUSAL_DEF, 'function smBuildRecord(']],
    exact: ['margin-property-missing:record-factory'],
  },
  {
    id: 'property-refusal-reason',
    why: 'the builder stays and the shape stays valid, but the reason is dropped -- so the row still renders and still says "Unavailable", and tells the reader nothing. This is the case the two channels are aimed at together: static, because the refusal has to carry its reason; browser, because on the shipped content the refusal is the ONLY branch that is ever reached',
    edits: [[EXECUTOR, REFUSAL_REASON, 'return{...u,status:' + BT + 'unavailable' + BT + ',reason:' + BT + BT + '}']],
    exact: ['margin-property-missing:refusal-record'],
    browser: { expectPass: false, re: /is unavailable and renders no reason/ },
  },
  {
    id: 'surface-phase-drift',
    why: 'the surface rewrites phaseDeg, so the plotted curve and the measured margin diverge',
    edits: [[SURFACE, SURFACE_PHASE, 'phaseDeg:-Math.atan2(n,t)*180/Math.PI']],
    exact: ['margin-surface-drift:phase'],
  },
  {
    id: 'authoring-leak-label',
    why: 'the metrics are added to the setup editor\'s label table: an option the authoring schema cannot build',
    edits: [[SURFACE, NE_ANCHOR,
      'ne={"phase-margin":' + BT + 'Phase margin' + BT + ',"gain-margin":' + BT + 'Gain margin' + BT + ',value:']],
    exact: ['margin-authoring-leak:phase-margin', 'margin-authoring-leak:gain-margin'],
  },
  {
    id: 'authoring-leak-selector',
    why: 'the same leak through the method selector -- the mirror image, and the reason both tables are read',
    edits: [[SURFACE, D_ANCHOR,
      'function D(e){return e===' + BT + 'op' + BT + '?[' + BT + 'value' + BT + ',' + BT + 'phase-margin' + BT + ',' + BT + 'gain-margin' + BT + ']:']],
    exact: ['margin-authoring-leak:phase-margin', 'margin-authoring-leak:gain-margin'],
  },
  {
    id: 'manifest-vacuous',
    why: 'a manifest with no contract would let every rule pass silently while verifying nothing',
    manifest: [['"contract": {', '"contractX": {']],
    exact: ['margin-contract-vacuous'],
  },
];

// --- setup ------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'margin-negctl-'));
const copy = join(work, 'site');
console.log('stability-margin.negctl: building a copy of ' + SITE + ' in ' + copy);
try {
  cpSync(SITE, copy, { recursive: true });
} catch (e) {
  die('cannot copy the artifact: ' + e.message);
}

const count = (text, needle) => {
  let n = 0;
  let at = 0;
  for (;;) {
    const i = text.indexOf(needle, at);
    if (i === -1) return n;
    n += 1;
    at = i + needle.length;
  }
};

// The manifest and the tree must agree, or every case below is testing a tree
// this script only assumes is patched. Two shapes live in this manifest and they
// are checked differently:
//   insertion      `replace` contains `find`, which therefore survives:
//                  patchedness is "the marker occurs exactly once".
//   substitution   `replace` does not contain `find`; the `find` must have been
//                  CONSUMED, so it occurs 0 times and the marker once.
// Asserting one shape for both is how this driver first failed, and the failure
// was correct: margin-splice is a substitution.
let editsChecked = 0;
let markersChecked = 0;
for (const repair of manifestJson.repairs ?? []) {
  const path = join(copy, repair.file);
  if (!existsSync(path)) die('the manifest names ' + repair.file + ', which the tree does not have');
  const text = readFileSync(path, 'utf8');
  for (const [i, edit] of (repair.edits ?? []).entries()) {
    const seenReplace = count(text, edit.replace);
    if (seenReplace !== 1) {
      die('the tree does not look patched for ' + repair.id + ' edit #' + i + ': its `replace` occurs ' +
        seenReplace + ' time(s), expected 1. Re-run the patcher, or the cases below are not about a patched tree.');
    }
    if (!edit.replace.includes(edit.find)) {
      const seenFind = count(text, edit.find);
      if (seenFind !== 0) {
        die('the tree does not look patched for ' + repair.id + ' edit #' + i +
          ': a substitution should have consumed its `find`, which still occurs ' + seenFind + ' time(s)');
      }
    }
    if (repair.marker) {
      const seen = count(text, repair.marker);
      if (seen !== 1) {
        die('the tree does not look patched for ' + repair.id + ': its marker ' +
          JSON.stringify(repair.marker) + ' occurs ' + seen + ' time(s), expected 1');
      }
      markersChecked += 1;
    }
  }
  editsChecked += 1;
}
console.log('stability-margin.negctl: the manifest and the tree agree (' + editsChecked + ' repair(s), ' + markersChecked + ' marker(s) uniquely present)');

// Every mutation anchor below quotes bytes the patcher wrote. If any of them
// stopped occurring the mutation would silently become a no-op, so the set is
// validated up front rather than trusted per case.
{
  const ex = readFileSync(join(copy, EXECUTOR), 'utf8');
  const sf = readFileSync(join(copy, SURFACE), 'utf8');
  const sc = readFileSync(join(copy, SCHEMA), 'utf8');
  const anchors = [
    [EXECUTOR, ex, SPLICE, 1], [EXECUTOR, ex, SPLICE_OFF, 0], [EXECUTOR, ex, EVAL_DEF, 1],
    [EXECUTOR, ex, EMIT_PHASE, 1], [EXECUTOR, ex, EMIT_GAIN, 1],
    [EXECUTOR, ex, LEVEL_TEST, 1], [EXECUTOR, ex, PHASE_REF, 1], [EXECUTOR, ex, AC_ONLY, 1],
    [EXECUTOR, ex, EVIDENCE_SHAPE, 1], [EXECUTOR, ex, UNWRAP_DEF, 1], [EXECUTOR, ex, MAG_FORMULA, 1],
    [EXECUTOR, ex, REFUSAL_DEF, 1], [EXECUTOR, ex, REFUSAL_REASON, 1],
    [SURFACE, sf, SURFACE_PHASE, 1], [SURFACE, sf, NE_ANCHOR, 1], [SURFACE, sf, D_ANCHOR, 1],
    [SCHEMA, sc, ENUM_PATCHED, 2], [SCHEMA, sc, ENUM_BASE, 0],
  ];
  for (const [file, text, needle, want] of anchors) {
    const seen = count(text, needle);
    if (seen !== want) {
      die('mutation anchor ' + JSON.stringify(String(needle).slice(0, 56)) + ' occurs ' + seen + ' time(s) in ' + file + ', want ' + want +
        '. The patcher output moved; re-derive the anchors before trusting these cases.');
    }
  }
  console.log('stability-margin.negctl: all ' + anchors.length + ' mutation anchor(s) verified');
}

// The unpatched tree is materialised by reversing the manifest -- each edit's
// `replace` swapped back to its `find`. The count is asserted: a reverse that
// matched nothing would leave the case testing a patched tree again, which is
// exactly the silent failure this construction exists to remove.
const UNPATCHED = join(work, 'unpatched-site');
{
  try { cpSync(copy, UNPATCHED, { recursive: true }); }
  catch (e) { die('cannot copy for the unpatched tree: ' + e.message); }
  let reversed = 0;
  for (const repair of manifestJson.repairs ?? []) {
    const path = join(UNPATCHED, repair.file);
    let text = readFileSync(path, 'utf8');
    for (const [i, edit] of (repair.edits ?? []).entries()) {
      const seen = count(text, edit.replace);
      if (seen !== 1) {
        die('cannot reverse ' + repair.id + ' edit #' + i + ': the patched form occurs ' + seen + ' time(s)');
      }
      text = text.split(edit.replace).join(edit.find);
      reversed += 1;
    }
    writeFileSync(path, text, 'utf8');
  }
  console.log('stability-margin.negctl: unpatched tree built by reversing ' + reversed + ' edit(s)');
}

// --- the static channel -----------------------------------------------------
/** check 18's finding keys for a given tree and manifest. */
function staticFindings(siteDir, manifestPath, tag) {
  const out = join(work, 'guard-' + tag + '.json');
  try {
    execFileSync(process.execPath,
      [GUARD, '--site=' + siteDir, '--margin=' + manifestPath, '--json=' + out],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  } catch { /* findings make the guard exit 1, which is the ordinary case here */ }
  if (!existsSync(out)) return { error: 'the guard wrote no json' };
  let blob;
  try { blob = JSON.parse(readFileSync(out, 'utf8')); }
  catch (e) { return { error: 'unreadable guard json: ' + e.message }; }
  rmSync(out, { force: true });
  const section = blob.stabilityMargin;
  if (!section) return { error: 'the guard reported no stabilityMargin section' };
  return { status: section.status, keys: (section.findings ?? []).map((f) => f.key) };
}

// --- the runtime channel ----------------------------------------------------
/**
 * Drive scripts/stability-margin.mjs against a tree.
 *
 * check 18 is a static check, and most of the mutants above are properties no
 * render can show: a renamed emit, an inherited unit or a reverted evidence
 * field all produce the same screen. But two of its claims ARE about the screen
 * -- the row is drawn at all, and it is drawn saying something -- and those are
 * exactly the claims the static half cannot witness. So the two cases below also
 * drive the browser harness:
 *
 *   control                    it has to come back GREEN on the unmutated tree,
 *                              or a red below would only prove the harness is
 *                              broken;
 *   property-refusal-reason    it has to come back RED, with the stated reason,
 *                              when a refusal stops carrying its reason.
 *
 * A missing browser is reported as skipped rather than as passed -- with
 * --require it is an error instead, because a green that was never observed is
 * the thing this whole file exists to prevent.
 */
function runBrowser(siteDir, tag) {
  const out = join(work, 'browser-' + tag + '.log');
  const args = [join(HERE, 'stability-margin.mjs'), '--site=' + siteDir];
  if (REQUIRE) args.push('--require');
  let res;
  try {
    res = spawnSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 300000 });
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
  const text = (res.stdout || '') + (res.stderr || '');
  try { writeFileSync(out, text, 'utf8'); } catch {}
  if (/SKIP \(no browser/.test(text) || /no browser found/.test(text)) return { skipped: true };
  return { code: res.status, text };
}

// --- runner -----------------------------------------------------------------
let bad = 0;
const results = [];
const saved = new Map();

function restore() {
  for (const [path, text] of saved) {
    try { writeFileSync(path, text, 'utf8'); } catch {}
  }
  saved.clear();
}

const selected = ONLY.length ? CASES.filter((c) => ONLY.includes(c.id)) : CASES;
if (!selected.length) die('--only matched no case: ' + JSON.stringify(ONLY));

console.log('stability-margin.negctl: ' + selected.length + ' case(s)' + (STATIC_ONLY ? ' (--static-only)' : ''));
for (const c of selected) {
  try {
    let setup = null;
    let manifestPath = MANIFEST;

    for (const [file, find, replace] of c.edits ?? []) {
      const path = join(copy, file);
      if (!saved.has(path)) saved.set(path, readFileSync(path, 'utf8'));
      const text = readFileSync(path, 'utf8');
      const seen = count(text, find);
      if (seen !== 1) { setup = 'anchor occurs ' + seen + ' time(s) in ' + file + ': ' + JSON.stringify(String(find).slice(0, 60)); break; }
      writeFileSync(path, text.split(find).join(replace), 'utf8');
    }
    if (setup === null && c.manifest) {
      let text = manifestText;
      for (const [find, replace] of c.manifest) {
        const seen = count(text, find);
        if (seen !== 1) { setup = 'manifest anchor occurs ' + seen + ' time(s): ' + JSON.stringify(find); break; }
        text = text.split(find).join(replace);
      }
      if (setup === null) {
        manifestPath = join(work, 'manifest-' + c.id + '.json');
        writeFileSync(manifestPath, text, 'utf8');
      }
    }
    if (setup !== null) throw new Error(setup);

    // The mutation must actually have changed the tree, or this case would
    // "pass" because nothing was mutated.
    if ((c.edits ?? []).length) {
      const path = join(copy, (c.edits[0][0]));
      if (readFileSync(path, 'utf8') === saved.get(path)) throw new Error('the mutation changed nothing');
    }

    const site = c.unpatched ? UNPATCHED : copy;
    const got = staticFindings(site, manifestPath, c.id);
    if (got.error) throw new Error(got.error);

    const uniq = [...new Set(got.keys)].sort();
    let staticOk;
    if (c.exact) {
      const want = [...new Set(c.exact)].sort();
      const missing = want.filter((k) => !uniq.includes(k));
      const extra = uniq.filter((k) => !want.includes(k));
      staticOk = missing.length === 0 && extra.length === 0;
      if (!staticOk) {
        if (missing.length) console.log('        check 18 expected but absent: ' + JSON.stringify(missing));
        if (extra.length) console.log('        check 18 fired for an unrelated reason: ' + JSON.stringify(extra));
      }
    } else {
      const missing = (c.expect ?? []).filter((k) => !uniq.includes(k));
      const present = (c.absent ?? []).filter((k) => uniq.includes(k));
      staticOk = missing.length === 0 && present.length === 0;
      if (!staticOk) {
        if (missing.length) console.log('        check 18 expected but absent: ' + JSON.stringify(missing));
        if (present.length) console.log('        check 18 must not fire: ' + JSON.stringify(present));
      }
    }

    // --- the runtime half, when this case claims something about the screen ---
    let runtimeOk = true;
    let runtimeNote = 'declared n/a';
    if (c.browser) {
      if (STATIC_ONLY) {
        runtimeNote = 'skipped (--static-only)';
      } else {
        const rb = runBrowser(copy, c.id);
        if (rb.error) { runtimeOk = false; runtimeNote = 'browser error: ' + rb.error; }
        else if (rb.skipped) {
          if (REQUIRE) { runtimeOk = false; runtimeNote = 'no browser and --require was set'; }
          else runtimeNote = 'skipped (no browser)';
        } else if (c.browser.expectPass) {
          runtimeOk = rb.code === 0;
          runtimeNote = rb.code === 0 ? 'browser PASS' : 'browser FAILED on an unmutated tree (exit ' + rb.code + ')';
        } else {
          const matched = c.browser.re.test(rb.text);
          runtimeOk = rb.code === 1 && matched;
          runtimeNote = 'browser exit ' + rb.code + (matched ? ' with the stated reason' : ', reason not stated');
          if (!runtimeOk && rb.code === 1) console.log('        browser: went red, but not for the stated reason');
          if (!runtimeOk && rb.code === 0) console.log('        browser: PASSED on a tree whose refusals carry no reason');
        }
      }
    }

    const ok = staticOk && runtimeOk;
    if (!ok) bad += 1;
    results.push({
      id: c.id, why: c.why, ok, staticOk, runtimeOk,
      keys: uniq, exact: c.exact ?? null, expect: c.expect ?? null, absent: c.absent ?? null,
      status: got.status, runtime: runtimeNote,
    });
    console.log('  ' + (ok ? 'ok  ' : 'BAD ') + c.id.padEnd(24) + 'status=' + String(got.status).padEnd(8) +
      'keys=' + JSON.stringify(uniq));
    if (c.browser) console.log('        runtime: ' + runtimeNote);
  } catch (e) {
    bad += 1;
    results.push({ id: c.id, why: c.why, ok: false, setup: String((e && e.message) || e) });
    console.log('  BAD ' + c.id.padEnd(24) + 'SETUP ERROR: ' + String((e && e.message) || e));
  } finally {
    restore();
  }
}

if (JSON_OUT) {
  writeFileSync(resolve(REPO_ROOT, JSON_OUT), JSON.stringify({
    site: SITE, copy, only: ONLY, staticOnly: STATIC_ONLY, results, failures: bad,
  }, null, 2), 'utf8');
}

if (!KEEP) {
  try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); } catch {}
} else {
  console.log('stability-margin.negctl: kept ' + work);
}

const ran = results.length;
console.log('stability-margin.negctl: ' + (ran - bad) + '/' + ran + ' case(s) behaved');
if (bad > 0) {
  console.log('stability-margin.negctl: FAIL -- at least one mutation was not caught for its own stated reason');
  process.exit(1);
}
if (ran === 0) {
  console.log('stability-margin.negctl: FAIL -- no case ran');
  process.exit(2);
}
console.log('stability-margin.negctl: PASS');
process.exit(0);
