// Regenerate scripts/region-annotate.json from the runtime source, the model
// library and the tree.
//
//   node scripts/region-annotate.manifest.cjs
//   node scripts/region-annotate.manifest.cjs --site=D     # read D instead of ./site
//
// Run this after ANY upstream rebuild of site/: the contract names the surface
// chunk, and that name carries a content hash. It refuses rather than writing a
// manifest whose anchors no longer exist.
//
// It never writes site/. The tree may be pristine or already patched; a patched
// tree is normalised back to its unpatched form IN MEMORY through the manifest
// currently on disk, so regenerating does not require undoing the patch by hand
// (which is the step that fails quietly -- the same reasoning as
// stability-margin.manifest.cjs).
//
// WHAT THE PRECONDITIONS ARE FOR. Every anchor occurs exactly once, every marker
// is absent pre-patch, and the table this script derives agrees with the model
// library it was derived from. The last one is the point of the whole exercise:
// the parameters this feature reasons about are not in the run, they are in
// site/models/cmos.lib, and they are expressions that move with the corner.
// Copying them into the artifact is what makes the line possible without a
// runtime expression evaluator; re-deriving them here, and asserting in check 19
// that the artifact still matches, is what keeps that copy honest. Without it a
// corner tweak in cmos.lib would leave the annotation quietly judging every
// transistor against the previous process.
//
// WHY (base, coefficient) AND NOT AN EXPRESSION. Every spread parameter in this
// library has the form A±B*__cn_sel, and the selector takes three values (-1, 0,
// +1), so the whole expression is `base + coef*sel` at runtime -- two operations
// and no parser. A runtime evaluator would have been the only genuinely new
// logic in the feature and the only part a static check could not see; the form
// is narrow enough to refuse outright instead. Anything that does not match it
// stops this script.
const fs = require('node:fs');
const path = require('node:path');

const HERE = __dirname;
const REPO = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const siteArg = argv.find((a) => a.startsWith('--site='));
const SITE = siteArg ? path.resolve(siteArg.slice('--site='.length)) : path.join(REPO, 'site');
const FILE = path.join(HERE, 'region-annotate.json');
const RUNTIME = path.join(HERE, 'region-annotate.runtime.js');
const LIBRARY = path.join(SITE, 'models', 'cmos.lib');
const TABLE_PLACEHOLDER = '__RG_TABLE__';

function count(text, needle) {
  let n = 0, at = 0;
  for (;;) {
    const i = text.indexOf(needle, at);
    if (i === -1) return n;
    n += 1;
    at = i + needle.length;
  }
}

// SPICE numbers: a decimal with an optional SI suffix, given as a POWER OF TEN
// rather than a multiplier. `200u` must come out as 0.0002, not as
// 0.00019999999999999998: the difference is 1e-17 relative and physically
// nothing, but this table is meant to be read against cmos.lib, and a reader
// comparing the two should not have to decide whether a trailing 9999999999999998
// is a process shift or a rounding artefact. `Meg` is checked before `m` by
// lowercasing into one table, which is why the table uses full words.
const SI = { f: -15, p: -12, n: -9, u: -6, m: -3, k: 3, meg: 6, g: 9, t: 12 };
function num(text) {
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([a-zA-Z]*)$/.exec(String(text).trim());
  if (!m) throw new Error('not a number: ' + JSON.stringify(text));
  const suffix = m[2] ? m[2].toLowerCase() : '';
  const exp = suffix === '' ? 0 : SI[suffix];
  if (exp === undefined) throw new Error('unknown SI suffix in ' + JSON.stringify(text));
  const parts = /^([+-]?(?:\d+\.?\d*|\.\d+))(?:[eE]([+-]?\d+))?$/.exec(m[1]);
  if (!parts) throw new Error('not a number: ' + JSON.stringify(text));
  const e0 = parts[2] ? Number(parts[2]) : 0;
  return Number(parts[1] + 'e' + (e0 + exp));
}

// {A+B*__cn_sel} -> [A, +B] ; {A-B*__cn_sel} -> [A, -B] ; {A} -> [A, 0].
// Deliberately narrow: this is the only expression shape the library uses, and a
// shape it does not recognise must stop the build rather than be approximated.
function pair(braced) {
  const inner = /^\{(.*)\}$/.exec(String(braced).trim());
  if (!inner) throw new Error('not a braced expression: ' + JSON.stringify(braced));
  const body = inner[1].trim();
  if (!body.includes('__cn_sel')) return [num(body), 0];
  const m = /^(.+?)([+-])(.+?)\*__cn_sel$/.exec(body);
  if (!m) throw new Error('unsupported corner expression: ' + JSON.stringify(body));
  const coef = num(m[3]) * (m[2] === '-' ? -1 : 1);
  return [num(m[1]), coef];
}

function field(text, key) {
  const m = new RegExp('(?:^|\\s)' + key + '=(\\{[^}]*\\}|\\S+)').exec(text);
  return m ? m[1] : null;
}

// --- the library -----------------------------------------------------------
const libraryText = fs.readFileSync(LIBRARY, 'utf8');
const models = {};
const excluded = [];
for (const raw of libraryText.split(/\r?\n/)) {
  const line = raw.trim();
  const m = /^\.model\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
  if (!m) continue;
  const [, name, kindRaw, rest] = m;
  const kind = kindRaw.toLowerCase();
  if (kind !== 'nmos' && kind !== 'pmos') continue; // BJTs are not MOS regions.
  const level = field(rest, 'LEVEL');
  if (level !== '1') {
    // Kept, not dropped silently: the runtime refuses these, and this list is
    // what lets check 19 tell "correctly excluded" from "forgotten".
    excluded.push({ name, type: kind, level: level === null ? null : Number(level), source: line });
    continue;
  }
  for (const key of ['VTO', 'KP', 'GAMMA', 'PHI', 'LAMBDA']) {
    if (field(rest, key) === null) throw new Error(name + ' is LEVEL=1 but declares no ' + key);
  }
  models[name] = {
    type: kind,
    vto: pair(field(rest, 'VTO')),
    kp: pair(field(rest, 'KP')),
    gamma: num(field(rest, 'GAMMA')),
    phi: num(field(rest, 'PHI')),
    lambda: num(field(rest, 'LAMBDA')),
    source: line,
  };
}
if (Object.keys(models).length === 0) throw new Error('no LEVEL=1 MOS models found in ' + LIBRARY);

// The order of keys is fixed here and reused by check 19, so the artifact and the
// manifest can be compared as plain strings instead of by structure. The raw
// `.model` line stays in `contract.models` (check 19 compares it against
// cmos.lib) but is NOT carried into the artifact: the runtime only ever needs
// the six numbers, and shipping the source line as well would add a kilobyte of
// comment to every visitor's bundle for a check that runs on the developer's
// machine.
const TABLE_FIELDS = ['type', 'vto', 'kp', 'gamma', 'phi', 'lambda'];
function toTable(models) {
  return '{' + Object.keys(models).map((name) => JSON.stringify(name) + ':' + JSON.stringify(
    TABLE_FIELDS.reduce((o, k) => { o[k] = models[name][k]; return o; }, {})
  )).join(',') + '}';
}
const tableLiteral = toTable(models);

// --- the artifact ----------------------------------------------------------
const assetsDir = path.join(SITE, 'assets');
const surfaceNames = fs.readdirSync(assetsDir).filter((f) => /^spice-simulation-surface-.*\.js$/.test(f));
if (surfaceNames.length !== 1) throw new Error('expected exactly one spice-simulation-surface chunk, found ' + surfaceNames.length);
const surfaceName = surfaceNames[0];
const surfaceFile = 'assets/' + surfaceName;
let surfaceSrc = fs.readFileSync(path.join(assetsDir, surfaceName), 'utf8');

// Normalise a patched tree back to its unpatched form, in memory, using the
// manifest currently on disk. Any repair whose replacement appears more than once
// means the tree is not in a state this script understands.
let normalised = surfaceSrc;
const notes = [];
if (fs.existsSync(FILE)) {
  const old = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  for (const rep of old.repairs || []) {
    for (const ed of rep.edits || []) {
      const n = count(normalised, ed.replace);
      if (n === 1) normalised = normalised.split(ed.replace).join(ed.find);
      else if (n > 1) throw new Error('cannot normalise ' + rep.id + ': its replacement occurs ' + n + ' times');
      else notes.push(rep.id + ' was not present (already unpatched)');
    }
  }
} else {
  notes.push('no manifest on disk; assuming a pristine tree');
}

// --- the contract ----------------------------------------------------------
const utAnchor = 'var Ht=``;function Ut({devices:e}){';
const utRowAnchor = '},void 0,!1,{fileName:Ht,lineNumber:24},this)]},e.id,!0,';
const callsiteFind = '(0,T.jsxDEV)(Ut,{devices:u.outputData.deviceOperatingPoints??[]},void 0,!1,{fileName:$,lineNumber:1556},this)';
const callsiteReplace = '(0,T.jsxDEV)(Ut,{devices:rgAnnotate(n,u)},void 0,!1,{fileName:$,lineNumber:1556},this)';
const rowReplace = '},void 0,!1,{fileName:Ht,lineNumber:24},this),e.region?(0,T.jsxDEV)(`p`,{className:`simulation-device-region`,children:e.region},void 0,!1,{fileName:Ht,lineNumber:31},this):null]},e.id,!0,';

const runtimeSrc = fs.readFileSync(RUNTIME, 'utf8');
if (count(runtimeSrc, TABLE_PLACEHOLDER) !== 1) throw new Error('runtime must contain exactly one ' + TABLE_PLACEHOLDER);
// Injected verbatim, minus the blank lines and comments the runtime carries for
// readers: the artifact is a single line per module and does not need them.
const injected =
  'var rgTable = ' + tableLiteral + ';\n' +
  runtimeSrc
    .split(/\r?\n/)
    .filter((l) => { const t = l.trim(); return t !== '' && !t.startsWith('//'); })
    .filter((l) => !l.includes(TABLE_PLACEHOLDER))
    .join('\n');

const manifest = {
  version: 1,
  $comment:
    'Adds one line of interpretation under each device in the Operating Point tab\'s "MOS operating-point details" card, saying which region the transistor is in and showing the quantities that decided it (Vov and VDS). The four numbers it reads are already on screen; what was missing was the reading, and the shipped example sits at VDS = 41.6 mV against Vov = 400 mV -- textbook linear region, indistinguishable on screen from a working amplifier.\n' +
    'The parameters are NOT in the run. The deck carries only `.include ".../cmos.lib"` plus a `.param __cn_sel` selector; there is no `.model` line, no LEVEL, no VTO, and log.txt and out.raw carry no device parameters either. So the table is copied out of site/models/cmos.lib at build time and re-derived by check 19, which fails any tree where the two disagree -- otherwise a corner tweak in the library would leave every transistor judged against the previous process.',
  $how:
    'node scripts/region-annotate.manifest.cjs        # regenerate after any upstream rebuild\n' +
    'node scripts/patch-outbound.mjs --manifest=scripts/region-annotate.json\n' +
    '  --site=D  patch D instead of ./site (used to try the manifest on a copy first)\n' +
    'Then, because site/ bytes changed: node scripts/shell-cache.mjs --write\n' +
    'And verify, cheapest first:\n' +
    '  node scripts/check-artifacts.mjs      # check 19, static: the table still matches cmos.lib\n' +
    '  node scripts/region-annotate.oracle.mjs --site=D   # LEVEL-1 ID vs the engine\'s own ID\n' +
    '  node scripts/region-annotate.negctl.mjs --site=D   # is check 19 vacuous?\n' +
    '  node scripts/region-annotate.mjs --site=D          # is the line on the screen?',
  $shape:
    'region-runtime and region-row are INSERTIONS (the find text survives inside the replace). region-callsite is a SUBSTITUTION. For an insertion the "already applied" test is the marker, not the find, which survives by construction.',
  $mechanism:
    'A region is a reading of measurements the user already has, not a new measurement, so it must not enter the artifact as one. Three things would have had to change to make it a measurement, and each is a live failure mode in this tree:\n' +
    '  1. the artifact schema\'s `metric` enum (files-DP-BVVb4.js) is CLOSED and declared TWICE. A name missing there fails validation, the artifact is discarded, and the panel replaces every table with "Full result files are unavailable or invalid" -- the user loses the results they already had. This is what D1 shipped and had to fix.\n' +
    '  2. `deviceOperatingPoints` is likewise declared TWICE and inconsistently: the request-side schema closes parameter/label/unit to enums, the result-side leaves them open, and NEITHER has a `model` field -- while zod strips unknown keys, so a `model` added to the payload would be silently eaten.\n' +
    '  3. adding it to the automatic summary would put it in measurements.csv, where a per-device interpretation does not belong and where nothing on the Operating Point tab would show it.\n' +
    'So the computation happens in the client, on the device list the panel already receives, and NOTHING in the payload, the schema or the metric enum changes. The model name is not carried in the payload either -- it is read back from the schematic instance, which already holds it as netlist.binding.name, using the document walk `surface` already performs twice.',
  contract: {
    $why: 'What check 19 in scripts/check-artifacts.mjs looks for.',
    surfaceFile,
    libraryFile: 'models/cmos.lib',
    runtimeFile: 'scripts/region-annotate.runtime.js',
    utAnchor,
    utRowAnchor,
    callsiteFind,
    callsiteReplace,
    tablePlaceholder: TABLE_PLACEHOLDER,
    tableLiteral,
    tableFields: TABLE_FIELDS,
    // The prefix the artifact opens the table with. It deliberately stops short
    // of the brace: the literal below already carries one, and the two are
    // concatenated by anyone who wants the full text. Writing `{` here too is
    // how check 19 came to look for `{{` and find nothing.
    tableMarker: 'var rgTable = ',
    rowClass: 'simulation-device-region',
    deviceProp: 'region',
    // Where the corner comes from: the value the deck assembler reads when it
    // decides whether to emit `.param __cn_sel`. Null/absent/'tt' => it emitted
    // nothing and the library's own `= 0` stands (ne() in the executor).
    cornerSource: 'result.metadata.configuration.modelLibrary.section',
    cornerMap: { null: '0', tt: '0', ss: '1', ff: '-1' },
    edgeTolerance: 0.02,
    edgeToleranceNeedle: '<= 0.02 * Math.abs(VOV)',
    refusalNeedle: 'if (!(VOV > 0)) return `Region  Cutoff',
    modelLookupNeedle: 'inst.netlist?.binding?.name ?? null',
    bodyEffectNeedle: 'VTH = VTO + p.gamma * (Math.sqrt(PSI) - Math.sqrt(p.phi))',
    pmosFlipNeedle: 'let s = p.type === `pmos` ? -1 : 1;',
    levelOneOnly: true,
    models,
    excluded,
  },
  targets: [surfaceFile],
  repairs: [
    {
      id: 'region-runtime',
      file: surfaceFile,
      why:
        'Injects the parameter table and the four functions that turn a device record into one line of text. Without this the callsite below would reference a function that does not exist and every Operating Point render would throw.',
      marker: 'var rgTable = {',
      requires: utAnchor,
      edits: [{ find: utAnchor, replace: injected + '\n' + utAnchor }],
    },
    {
      id: 'region-row',
      file: surfaceFile,
      why:
        'Draws the line. The runtime defines the text but nothing renders it; a device with no `region` property (every refusal path) renders exactly the card this app had before.',
      marker: 'simulation-device-region',
      requires: 'function Ut({devices:e}){',
      edits: [{ find: utRowAnchor, replace: rowReplace }],
    },
    {
      id: 'region-callsite',
      file: surfaceFile,
      why:
        'Feeds the annotated device list to the card. `n` is the project and `u` the run, both already in scope where the card is created; untouched, the card receives the raw device list and the row repair above has nothing to draw.',
      marker: 'devices:rgAnnotate(n,u)',
      requires: '(0,T.jsxDEV)(Ut,',
      edits: [{ find: callsiteFind, replace: callsiteReplace }],
    },
  ],
};

// --- preconditions ---------------------------------------------------------
const checks = [];
checks.push(['surface declares the details card', normalised.includes('MOS operating-point details')]);
checks.push(['surface declares the card component', normalised.includes('function Ut({devices:e}){')]);
checks.push(['surface is unpatched (no table)', !normalised.includes('var rgTable = ')]);
checks.push(['surface is unpatched (no row class)', !normalised.includes('simulation-device-region')]);
checks.push(['surface is unpatched (no callsite)', !normalised.includes('rgAnnotate(n,u)')]);
checks.push(['ut anchor occurs once', count(normalised, utAnchor) === 1]);
checks.push(['ut row anchor occurs once', count(normalised, utRowAnchor) === 1]);
checks.push(['callsite anchor occurs once', count(normalised, callsiteFind) === 1]);
checks.push(['library declares the corner selector', libraryText.includes('.param __cn_sel')]);
checks.push(['every table parameter came from a library line', Object.values(models).every((m) => libraryText.includes(m.source))]);
checks.push(['table literal is what the runtime placeholder expects', count(runtimeSrc, TABLE_PLACEHOLDER) === 1]);

// The patched form, built by applying every edit once. A `requires` is checked
// against BOTH forms, because the patcher's exit-3 condition is about the tree it
// is handed -- and a manifest whose `requires` is the text its own edit consumes
// is green on the pristine tree and unusable on the patched one. That mistake has
// already been made once in this repository.
let patched = normalised;
for (const rep of manifest.repairs) for (const ed of rep.edits) patched = patched.split(ed.find).join(ed.replace);

for (const rep of manifest.repairs) {
  checks.push([rep.id + ' requires is present exactly once (pristine)', count(normalised, rep.requires) === 1]);
  checks.push([rep.id + ' requires is present exactly once (patched)', count(patched, rep.requires) === 1]);
  checks.push([rep.id + ' marker is absent pre-patch', count(normalised, rep.marker) === 0]);
  for (const ed of rep.edits) {
    checks.push([rep.id + ' find occurs once (pristine)', count(normalised, ed.find) === 1]);
    // An insertion keeps its find inside the replace; a substitution consumes it.
    checks.push([rep.id + ' find survives inside replace at most once', count(ed.replace, ed.find) <= 1]);
  }
}
checks.push(['every marker lands exactly once after patching', manifest.repairs.every((r) => count(patched, r.marker) === 1)]);

let bad = 0;
for (const [name, pass] of checks) {
  if (!pass) bad += 1;
  console.log((pass ? '  ok   ' : '  FAIL ') + name);
}
if (bad) {
  console.log('\nPreconditions failed. The tree does not reduce to the shape this manifest was written against.');
  console.log('Restore with:  git checkout -- site/');
  process.exit(2);
}
for (const n of notes) console.log('  note  ' + n);

fs.writeFileSync(FILE, JSON.stringify(manifest, null, 2) + '\n');
console.log('\nwrote ' + FILE);
console.log('  models  ' + Object.keys(models).length + ' LEVEL=1 (' + Object.keys(models).join(', ') + ')');
console.log('  excluded ' + excluded.length + (excluded.length ? ' (' + excluded.map((e) => e.name + ' LEVEL=' + e.level).join(', ') + ')' : ''));
console.log('  table   ' + tableLiteral.length + ' chars');
for (const r of manifest.repairs) console.log('  ' + r.id.padEnd(20) + ' marker=' + JSON.stringify(r.marker.slice(0, 60)));
