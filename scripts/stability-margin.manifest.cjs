// Regenerate scripts/stability-margin.json from the evaluator source and the tree.
//
//   node scripts/stability-margin.manifest.cjs
//
// Run this after ANY upstream rebuild of site/: the contract names the two
// chunks the repairs edit, and both names carry a content hash. It refuses
// rather than writing a manifest whose anchors no longer exist, and it is
// idempotent -- it normalises an already-patched tree back to its unpatched form
// through the current manifest first, so regenerating a contract does not
// require undoing the patch by hand (which is the step that fails quietly).
//
// What it enforces before writing anything: every anchor occurs exactly once,
// every marker is absent pre-patch, the surface still draws the curve the margin
// is measured on with the same formulas the evaluator uses, and each chunk is
// identified by content rather than by name. Those preconditions are not
// ceremony -- one of them caught the contract's missing surfaceFile key, which
// had made check 18 report `vacuous` on every tree.
//
// Why this manifest needed a generator at all: it embeds a ~3 KB evaluator and
// names twenty-odd needles, and the seven other manifests in this repository are
// hand-maintained JSON. Those are needle-and-substitution patches; this one is
// code. Regenerating it by hand is how the regression below shipped in the first
// place.
//
// The first version of this manifest shipped a regression: it put two new
// metrics into the executor's measurement list, but the client validates the
// evaluated-output artifact against a schema whose `metric` field is a CLOSED
// enum. Validation failed, the artifact was thrown away, and the results panel
// replaced every table with "Full result files are unavailable or invalid".
// Bytes changed, sha matched, --check was green, the patch report was clean.
//
// The first version of this manifest shipped a regression: it put two new
// metrics into the executor's measurement list, but the client validates the
// evaluated-output artifact against a schema whose `metric` field is a CLOSED
// enum. Validation failed, the artifact was thrown away, and the results panel
// replaced every table with "Full result files are unavailable or invalid".
// Bytes changed, sha matched, --check was green, the patch report was clean.
//
// Three corrections, in order of severity:
//
//  1. NEW REPAIR -- register the two metrics in that enum. Without it the
//     feature does not merely fail to show; it destroys the result the user
//     would otherwise have seen.
//  2. The record's `evidence` must use the schema's own shape. `evidence` is a
//     union of {kind:'point',coordinate} and {kind:'window',start,stop}; the
//     first version emitted {frequencyHz}, which matches neither. That was
//     invisible only because every row observed so far was `unavailable`, and
//     unavailable rows carry no evidence -- a latent version of (1).
//  3. DROP the two authoring repairs. They added the metrics to the setup UI's
//     picker, but the setup schema's method union is closed too, so the picker
//     would have offered an option that fails validation when used. A margin is
//     derived from the whole sweep, like the existing automatic minimum and
//     maximum; it is not a user-authored rule.
//
// And two corrections to the evaluator found by reading it against its own uses:
//
//  4. `smCross` took a level and ignored it, detecting a SIGN CHANGE instead.
//     That is 0 dB by accident; for the -180 deg search it caught the +/-180
//     wrap rather than a crossing, and a phase that wandered through 0 deg would
//     have been reported as a gain margin. Fixed to compare against the level,
//     which requires the phase to be unwrapped first or the wrap stops being
//     detectable at all.
//  5. Only a real AC analysis is a transfer function. The first version also
//     accepted `noise`, where a "phase margin" is meaningless; it was inert only
//     because noise outputs carry no imaginary part.
//  6. The margin is measured relative to the loop's LOW-FREQUENCY PHASE, not
//     against absolute 0 and -180. A single-pole inverting stage sits at 180 deg
//     at low frequency and has exactly the same margin as its non-inverting
//     twin; measuring against absolute -180 reported 275 deg for it, and would
//     have called the same loop stable after it had already gone unstable,
//     because the test would need another 180 deg of lag to notice.
//
// The evaluator itself lives in scripts/stability-margin.evaluator.js and is
// copied into the manifest verbatim, so it can be read as code rather than as an
// escaped JSON string. The manifest -- not this script -- is what the patcher
// applies, which is why the two must be regenerated together.
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..');
const FILE = path.join(HERE, 'stability-margin.json');
const cur = JSON.parse(fs.readFileSync(FILE, 'utf8'));

// --- the injected evaluator --------------------------------------------------
//
// Read from a canonical file rather than recovered from the previous manifest,
// so the injection is reviewable as code instead of as an escaped JSON string.
// Lines beginning with `//` are the file's own documentation and are stripped;
// everything else is injected verbatim.
const fragment = fs.readFileSync(path.join(HERE, 'stability-margin.evaluator.js'), 'utf8');
const injected = fragment
  .split('\n')
  .filter((line) => !line.startsWith('//'))
  .join('\n')
  .trim();
if (!injected.startsWith('function smCross(')) {
  console.log('REFUSED: the evaluator fragment does not start with smCross');
  process.exit(2);
}

for (const [name, needle] of [
  ['smCross', 'function smCross('],
  ['smInterp', 'function smInterp('],
  ['smUnwrap', 'function smUnwrap('],
  ['smStatic', 'function smStatic('],
  ['smPassed', 'function smPassed('],
  ['smMargins', 'function smMargins('],
  ['smRecord', 'function smRecord('],
]) {
  if (!injected.includes(needle)) {
    console.log('REFUSED: the evaluator is missing ' + name + ' (' + needle + ')');
    process.exit(2);
  }
}
// The four properties this version exists to have.
for (const [name, needle] of [
  ['level-aware crossing test', 'if((a-n)*(o-n)<0){'],
  ['AC-only guard', 'if(e.analysis!==`ac`)return;'],
  ['schema-shaped evidence', 'evidence:{kind:`point`,coordinate:'],
  ['phase referenced to the static phase', 'p=180+t-z'],
  ['no noise branch', 'analysis!==`noise`'],
]) {
  const present = injected.includes(needle);
  const wantPresent = name !== 'no noise branch';
  if (present !== wantPresent) {
    console.log('REFUSED: ' + name + ' -- expected ' + (wantPresent ? 'present' : 'absent'));
    process.exit(2);
  }
}

// --- the schema enum ---------------------------------------------------------
const baseEnum = 'metric:t([`operating-point`,`minimum`,`maximum`,`peak-to-peak`,`time-mean`,`time-rms`,`sample-at`])';
const newEnum = 'metric:t([`operating-point`,`minimum`,`maximum`,`peak-to-peak`,`time-mean`,`time-rms`,`sample-at`,`phase-margin`,`gain-margin`])';

// The surface's own curve, quoted once. The margin has to be measured on the
// same curve the Bode plot draws, or the user reads a crossing off the plot and
// gets a number that belongs to a different curve.
const surfacePhaseExpr = 'phaseDeg:Math.atan2(n,t)*180/Math.PI';
const surfaceMagnitudeExpr = 'magnitudeDb:20*Math.log10(Math.max(r,1e-30))';

// --- the two emit calls ------------------------------------------------------
// Lifted out of the injected source rather than written by hand, so the
// manifest's spelling of each row's metric, label and unit cannot drift from
// the code that produces it. The call has no nested parentheses, so the body is
// flat and a single-level match is exact.
function emitCall(metric) {
  const found = new RegExp('smRecord\\([^)]*`' + metric + '`[^)]*\\)').exec(injected);
  if (!found) {
    console.log('REFUSED: the evaluator emits no smRecord(...) call for ' + metric);
    process.exit(2);
  }
  return found[0];
}

// The emit calls, and the record factory's name taken from them, so the contract
// cannot drift from the code that builds the rows. The name is sliced off the
// call rather than matched with a pattern like /([\w$]+)\([^)]*`phase-margin`/ --
// that pattern's leftmost match is the ENCLOSING call (`t.push(smRecord(...`),
// which silently yields the name of a function that does not exist.
const phaseEmit = emitCall('phase-margin');
const gainEmit = emitCall('gain-margin');
const recordFactoryNeedle = 'function ' + phaseEmit.slice(0, phaseEmit.indexOf('(')) + '(';

// --- the three chunks this manifest edits ------------------------------------
//
// Every chunk name carries a content hash, so a hardcoded name is a name that
// goes stale on the next upstream rebuild -- and the failure is quiet: the
// check reports `absent`, which reads as "this tree has nothing to check"
// rather than as "the manifest is pointing at a file that no longer exists".
// This is not hypothetical: surfaceFile was missing from the contract entirely,
// and check 18 reported `vacuous` on every tree until the missing key was found.
//
// The executor cannot be found by name at all -- eight chunks match `src-*.js`
// -- so each chunk is identified by what it CONTAINS, and the discovery refuses
// unless exactly one candidate matches.
const assetsDir = path.join(REPO, 'site', 'assets');
const assetNames = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js')) : [];
function findChunk(prefix, needle, label) {
  const hits = assetNames
    .filter((f) => f.startsWith(prefix))
    .filter((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8').includes(needle));
  if (hits.length !== 1) {
    console.log('REFUSED: ' + hits.length + ' chunk(s) named ' + prefix + '*.js contain the ' + label +
      ' (' + JSON.stringify(String(needle).slice(0, 60)) + '); expected exactly 1');
    process.exit(2);
  }
  return hits[0];
}
// The needles are chosen to survive patching, because this script has to work on
// an already-patched tree as well as a pristine one. `measurements:[...Xe(c),...`
// is the PREFIX of the splice call -- the manifest's own edit inserts
// `smMargins(c),` after it -- and `metric:t([`operating-point`,` is the prefix of
// the enum the schema patches rewrite. The completed forms are one-state
// needles: on a patched tree the pre-patch form no longer exists, and the
// discovery would refuse the very tree it is supposed to describe.
const executorName = findChunk('src-', 'measurements:[...Xe(c),...', 'automatic-summary splice');
const schemaName = findChunk('files-', baseEnum.slice(0, baseEnum.indexOf('`minimum`')), 'closed metric enum');
const surfaceName = findChunk('spice-simulation-surface-', surfacePhaseExpr, 'phase curve');
const enumTail = ',label:r(),unit:r(),origin:t([`automatic`,`authored`]).optional(),measurementId:C.optional(),' +
  'evidence:m([f({kind:d(`point`),coordinate:i()}),f({kind:d(`window`),start:i(),stop:i()})]).optional(),';

// The schema is a discriminated union with an available and an unavailable
// variant, each repeating the enum, so the enum has two distinct homes and the
// patcher's one-occurrence rule forces one repair each.
//
// A marker has to be absent before patching and unique after, so each marker is
// built from the PATCHED text. The enum members it carries are what make it
// absent beforehand; the `status` literal is what keeps the two variants apart.
const schemaEdits = [
  {
    id: 'margin-schema-available',
    marker: newEnum + enumTail + 'status:d(`available`)',
    find: baseEnum + enumTail + 'status:d(`available`),value:i().finite()})',
    replace: newEnum + enumTail + 'status:d(`available`),value:i().finite()})',
  },
  {
    id: 'margin-schema-unavailable',
    marker: newEnum + enumTail + 'status:d(`unavailable`)',
    find: baseEnum + enumTail + 'status:d(`unavailable`),reason:r()})',
    replace: newEnum + enumTail + 'status:d(`unavailable`),reason:r()})',
  },
];

// The precondition for a SUBSTITUTION, which is not the same thing as its find.
//
// `requires` names the context the replacement depends on, and it has to hold
// BOTH before and after the manifest is applied. The unpatched enum cannot be
// its own precondition: the substitution rewrites it, so on a patched tree
// --check reports the anchor missing and exits 3. That is what this manifest did
// until this function replaced `requires: baseEnum`, and it was the only manifest
// in the repository that did -- every other one names a surviving anchor.
//
// Nor is any anchor built out of enum text usable: this chunk declares the enum
// TWICE, one row per status variant, and the two copies are byte-identical from
// the enum through the shape that follows it. What separates them sits further
// down, inside the tail. So the precondition is taken from the part of `find`
// that lies AFTER the enum: the patch does not touch it, and its appearing
// exactly once is the same property that made `find` unique to begin with.
const schemaPrecondition = (edit) => edit.find.slice(baseEnum.length);

// --- assemble ----------------------------------------------------------------
const manifest = {
  version: 1,
  $comment:
    'Adds phase margin and gain margin to the automatic measurement summary: derived from the whole ' +
    'AC sweep, one pair of rows per complex output, alongside the existing minimum/maximum/peak-to-peak ' +
    'rows. Both rows are always emitted; when a margin is not defined the row says why rather than ' +
    'disappearing or reading zero.\n' +
    'Both margins are measured relative to the LOOP\'S LOW-FREQUENCY PHASE (see $mechanism and the ' +
    'comments in scripts/stability-margin.evaluator.js), so an inverting and a non-inverting stage with ' +
    'the same poles report the same margin -- which is the physically correct answer, and the one that ' +
    'notices instability without needing an extra 180 degrees of lag.',
  $how:
    'node scripts/stability-margin.manifest.cjs        # regenerate after any upstream rebuild\n' +
    'node scripts/patch-outbound.mjs --manifest=scripts/stability-margin.json\n' +
    '  --site=D  patch D instead of ./site (used to try the manifest on a copy first)\n' +
    'Then, because site/ bytes changed: node scripts/shell-cache.mjs --write\n' +
    'And verify, cheapest first:\n' +
    '  node scripts/check-artifacts.mjs      # check 18, static\n' +
    '  node scripts/stability-margin.oracle.mjs --site=D   # the numbers, from the shipped bytes\n' +
    '  node scripts/stability-margin.negctl.mjs --site=D   # is check 18 vacuous?\n' +
    '  node scripts/stability-margin.mjs --site=D          # is the row on the screen?\n' +
    '  node scripts/stability-margin.mjs --fixture=center-magnitude\n' +
    '    # and is the row DRAWN when a margin actually exists? Every margin this lab\n' +
    '    # can produce on the shipped tree is a refusal, so without the fixture the\n' +
    '    # value-vs-unit branch of that harness never executes.',
  $shape:
    'margin-evaluator and margin-splice are INSERTIONS (the find text survives inside the replace). ' +
    'margin-schema-available and margin-schema-unavailable are SUBSTITUTIONS (the find text does not ' +
    'survive). For an insertion the "already applied" test is the marker, not the find, which survives ' +
    'by construction.',
  $mechanism:
    'The executor builds the evaluated-output artifact and hands it to the client, which validates it ' +
    'against a zod schema before drawing anything. Three separate closed lists decide whether a new ' +
    'metric can exist at all:\n' +
    '  1. the ARTIFACT SCHEMA metric enum (files-DP-BVVb4.js). A metric missing here fails validation, ' +
    'the artifact is discarded, and the panel shows "Full result files are unavailable or invalid" -- ' +
    'the user loses the result they already had.\n' +
    '  2. the record factory already in the executor, which computes every automatic summary row.\n' +
    '  3. the setup picker (the `ne` label table and the AC branch of `D`), which governs AUTHORED ' +
    'measurements and is deliberately NOT touched: the setup schema\'s method union is closed as well, ' +
    'so listing a metric there without implementing the authored path offers the user an option that ' +
    'cannot be used.\n' +
    'A margin is a property of the whole frequency response, so it belongs in group 1+2 as an automatic ' +
    'row, not in group 3 as a rule the user writes.',
    contract: {
      $why:
        'What check 18 in scripts/check-artifacts.mjs looks for. Every list that gates whether these rows ' +
        'can reach the screen appears here; a needle for the evaluator alone is what let the first version ' +
        'pass while the artifact failed validation.',
      executorFile: 'assets/' + executorName,
      // The surface chunk is content-hashed, so its name changes on every
      // upstream rebuild. Deriving it from the tree rather than hardcoding it is
      // what stops this manifest from naming a file that no longer exists --
      // which the check could only report as 'absent', not as a finding.
      surfaceFile: 'assets/' + surfaceName,
      schemaFile: 'assets/' + schemaName,
      // The applicability gate: the automatic summary builder the margin rows
      // join. It is the thing a tree has to carry for this feature to mean
      // anything, and it survives patching (the evaluator is injected in FRONT
      // of it), so it is present in a patched and an unpatched tree alike. That
      // is what makes it a gate on "does this tree declare the feature" rather
      // than on "is the feature already there" -- the latter would switch this
      // check off in exactly the state it exists to catch.
      autoSummaryAnchor: 'function Xe(e){let t=[];',
      marginFunction: 'function smMargins(e){let t=[];',
      marginSplice: 'measurements:[...Xe(c),...smMargins(c),...nt(c,r)]',
      phaseMarginMetric: 'phase-margin',
      gainMarginMetric: 'gain-margin',
      phaseMarginUnit: 'deg',
      gainMarginUnit: 'dB',
      // The exact calls that emit the two rows, lifted out of the evaluator
      // source so they cannot drift from it. Pinning the metric, the label and
      // the unit in one needle is what makes a rename of any of the three show
      // up: the record factory's default unit is the output's (a volt or an
      // amp), so a margin that inherits it renders as "112.5 V" -- populated,
      // and wrong.
      phaseMarginEmit: phaseEmit,
      gainMarginEmit: gainEmit,
      // The margin has to be measured on the SAME curve the Bode plot draws, or
      // the user reads a crossing off the plot and gets a number that belongs to
      // a different curve. The two chunks compute that curve independently --
      // the surface once per point for the plot, the evaluator once per output
      // for the margin -- so this is a cross-chunk agreement, and it is the only
      // place it can be established statically.
      surfacePhaseExpr,
      surfaceMagnitudeExpr,
      // The evaluator's half of the same agreement, expressed over its own
      // variables (it reads `values`/`imaginary` rather than a point object).
      phaseFormulaNeedle: 'Math.atan2(n,t)*180/Math.PI',
      magnitudeFormulaNeedle: '20*Math.log10(Math.max(Math.hypot(t,n),1e-30))',
      crossingNeedle: 'function smCross(',
      // Detection has to compare against the LEVEL, not against zero. The first
      // version tested `a*o<0`, which is a sign change: right for 0 dB by
      // accident, and wrong for -180 deg (it caught the +/-180 wrap instead) and
      // wrong for a phase that crosses 0 deg (it reported a gain margin).
      levelTestNeedle: 'if((a-n)*(o-n)<0){',
      unwrapNeedle: 'function smUnwrap(',
      // The margin is measured relative to the loop's low-frequency phase, so
      // that an inverting and a non-inverting loop with the same poles get the
      // same margin. Against absolute -180 an inverting loop reads 180 deg high
      // and its instability threshold is missed by a full 180 deg.
      staticPhaseNeedle: 'function smStatic(',
      phaseReferenceNeedle: 'p=180+t-z',
      acOnlyNeedle: 'if(e.analysis!==`ac`)return;',
      evidenceShapeNeedle: 'evidence:{kind:`point`,coordinate:',
      schemaMetricEnum: baseEnum,
      schemaMetricEnumPatched: newEnum,
      schemaEnumOccurrences: 2,
      // Two independent claims, two needles. The record factory has to exist;
      // and a refusal has to carry the reason it was given. Pinning only the
      // first would be satisfied by a builder that returns the right shape with
      // an empty reason -- a row that renders, says "Unavailable", and tells the
      // reader nothing.
      recordFactoryNeedle,
      unavailableNeedle: 'return{...u,status:`unavailable`,reason:s}',
    },
  targets: [
    'assets/' + executorName,
    'assets/' + schemaName,
  ],
  repairs: [
    {
      id: 'margin-evaluator',
      file: 'assets/' + executorName,
      why:
        'Injects the margin evaluator next to the existing automatic summary builder, so the new rows are ' +
        'produced by the same code path that already computes minimum, maximum and peak to peak.',
      marker: 'function smMargins(e){let t=[];',
      requires: 'function Xe(e){let t=[];',
      edits: [{ find: 'function Xe(e){let t=[];', replace: injected + 'function Xe(e){let t=[];' }],
    },
    {
      id: 'margin-splice',
      file: 'assets/' + executorName,
      why:
        'Wires the evaluator into the measurement list. An injection that defines a function without ' +
        'calling it changes bytes and behaviour by nothing, so the splice is what makes the evaluator ' +
        'reachable. The find text does not survive; the marker is the spliced form.',
      marker: '...smMargins(c),',
      requires: '...Xe(c),',
      edits: [{
        find: 'measurements:[...Xe(c),...nt(c,r)]',
        replace: 'measurements:[...Xe(c),...smMargins(c),...nt(c,r)]',
      }],
    },
    {
      id: 'margin-schema-available',
      file: 'assets/' + schemaName,
      why:
        'The available variant of the result-measurement schema. Without this member the artifact fails ' +
        'validation and the whole result is discarded, which is a regression: the rows are computed, then ' +
        'the payload that carries them is rejected.',
      marker: schemaEdits[0].marker,
      requires: schemaPrecondition(schemaEdits[0]),
      edits: [{ find: schemaEdits[0].find, replace: schemaEdits[0].replace }],
    },
    {
      id: 'margin-schema-unavailable',
      file: 'assets/' + schemaName,
      why:
        'The unavailable variant, which repeats the enum. A margin that is not defined still has to pass ' +
        'validation on its way to the panel, or the refusal never reaches the user.',
      marker: schemaEdits[1].marker,
      requires: schemaPrecondition(schemaEdits[1]),
      edits: [{ find: schemaEdits[1].find, replace: schemaEdits[1].replace }],
    },
  ],
};

// --- preconditions, checked against the tree's UNPATCHED form -----------------
//
// The tree may or may not have this manifest applied already, and the generator
// has to work either way. Requiring a pristine tree means the only way to change
// a contract is to undo the patch first, and the undo is the step that fails
// silently -- the tree looks clean and the anchors below are then derived from
// patched bytes. So the two patched files are normalised back through the
// CURRENT manifest's own edits before anything is asserted. The normalisation is
// idempotent: on a pristine tree no `replace` is present and nothing moves.
function normalise(text, rel) {
  let out = text;
  for (const rep of cur.repairs ?? []) {
    if (rep.file !== rel) continue;
    for (const edit of rep.edits ?? []) {
      if (edit.replace && out.includes(edit.replace)) out = out.split(edit.replace).join(edit.find);
    }
  }
  return out;
}
const src = normalise(fs.readFileSync(path.join(REPO, 'site', 'assets', executorName), 'utf8'), 'assets/' + executorName);
const filesChunk = normalise(fs.readFileSync(path.join(REPO, 'site', 'assets', schemaName), 'utf8'), 'assets/' + schemaName);
const surfaceSrc = fs.readFileSync(path.join(REPO, 'site', 'assets', surfaceName), 'utf8');

// Every repair's `requires` has to name an anchor that exists BOTH before and
// after this manifest is applied. The patcher checks that itself and refuses the
// whole manifest -- exit 3, "unusable" -- when it cannot find one, and the schema
// substitutions shipped with `requires: baseEnum`: an anchor their own edit
// destroys. Nothing noticed because the failure only appears once the patch is in
// place, and by then the ordinary runs still pass. So it is asserted here, on
// both forms of each file, rather than left to be discovered by a --check nobody
// runs. The same assertion fails loudly if a `requires` stops being unique, which
// is the other half of the patcher's exit-3 condition.
const forms = {
  pristine: { ['assets/' + executorName]: src, ['assets/' + schemaName]: filesChunk },
  patched: {
    ['assets/' + executorName]: fs.readFileSync(path.join(REPO, 'site', 'assets', executorName), 'utf8'),
    ['assets/' + schemaName]: fs.readFileSync(path.join(REPO, 'site', 'assets', schemaName), 'utf8'),
  },
};
const anchorChecks = [];
for (const rep of manifest.repairs) {
  for (const [when, form] of Object.entries(forms)) {
    const text = form[rep.file];
    if (text == null) continue;
    anchorChecks.push([
      rep.id + ' requires-anchor is present exactly once on the ' + when + ' tree',
      text.split(rep.requires).length - 1 === 1,
    ]);
  }
}

const checks = [
  ['executor is not already patched', src.split('function smMargins(').length - 1 === 0],
  ['splice anchor occurs once', src.split('measurements:[...Xe(c),...nt(c,r)]').length - 1 === 1],
  ['schema enum occurs twice', filesChunk.split(baseEnum).length - 1 === 2],
  ['available anchor occurs once', filesChunk.split(schemaEdits[0].find).length - 1 === 1],
  ['unavailable anchor occurs once', filesChunk.split(schemaEdits[1].find).length - 1 === 1],
  ['available marker is absent pre-patch', filesChunk.split(schemaEdits[0].marker).length - 1 === 0],
  ['unavailable marker is absent pre-patch', filesChunk.split(schemaEdits[1].marker).length - 1 === 0],
  ['authoring affordance is absent (reverted)', !src.includes('phase-margin')],
  // The margin is read off the same curve the plot draws, so the two chunks have
  // to agree on how that curve is computed. Both are asserted, because a change
  // to EITHER one silently moves the margin off the curve the user is reading.
  ['surface declares the phase curve', surfaceSrc.includes(manifest.contract.surfacePhaseExpr)],
  ['surface declares the magnitude curve', surfaceSrc.includes(manifest.contract.surfaceMagnitudeExpr)],
  ['evaluator declares a record factory', injected.includes(manifest.contract.recordFactoryNeedle)],
  ['evaluator refuses with a reason', injected.includes(manifest.contract.unavailableNeedle)],
  ['evaluator uses the same phase formula', injected.includes(manifest.contract.phaseFormulaNeedle)],
  ['evaluator uses the same magnitude formula', injected.includes(manifest.contract.magnitudeFormulaNeedle)],
  ...anchorChecks,
];
let ok = true;
for (const [name, pass] of checks) {
  console.log((pass ? '  ok   ' : '  FAIL ') + name);
  if (!pass) ok = false;
}
if (!ok) {
  console.log('\nPreconditions failed. The tree does not reduce to the shape this manifest was written');
  console.log('against -- an anchor moved, or the current manifest no longer reverses it. Restore with');
  console.log('  git checkout -- site/');
  process.exit(2);
}

fs.writeFileSync(FILE, JSON.stringify(manifest, null, 2) + '\n');
console.log('\nwrote ' + FILE + '  (' + manifest.repairs.length + ' repairs, ' +
  new Set(manifest.repairs.map((r) => r.file)).size + ' file(s))');
for (const r of manifest.repairs) console.log('  ' + r.id.padEnd(28) + ' marker=' + JSON.stringify(r.marker.slice(0, 70)));
