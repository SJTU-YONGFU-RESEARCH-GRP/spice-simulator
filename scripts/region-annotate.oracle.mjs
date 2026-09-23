#!/usr/bin/env node
/**
 * Does the injected region arithmetic answer the question it claims to answer?
 *
 *   node scripts/region-annotate.oracle.mjs [--site=<dir>] [--require]
 *
 * This is the numeric side of D3, and it deliberately needs no browser and no
 * reference file. Every expectation below is either
 *
 *   - CONSTRUCTED, so the answer follows from how the input was built (set VDS
 *     to half the overdrive and the only possible answer is linear), or
 *   - COMPUTED HERE, from cmos.lib's constants through the LEVEL-1 body-effect
 *     relation written out longhand, so the comparison is between two
 *     independent evaluations of the same physics rather than between the
 *     artifact and itself.
 *
 * What it cannot see is whether the row reaches the screen; that is
 * scripts/region-annotate.mjs. What it also cannot see is whether the table it
 * lifts out of the artifact still matches cmos.lib; that is check 19. The three
 * are separate on purpose: the failure this feature is most exposed to is a
 * library edit that leaves the annotation judging against the previous process,
 * and only a check that reads BOTH files can notice it.
 *
 * Why a hand-written oracle at all: the runtime's whole job is one inequality
 * whose inputs move with the corner and whose sign flips for PMOS. A wrong sign
 * or a stale corner produces a confident, wrong, plausible word, and nothing on
 * screen looks any different. These cases are what makes a wrong sign fail.
 *
 * Exit codes: 0 all cases passed (or --require absent and some failed), 1 a
 * --require run had a failure, 2 the artifact carries no injected runtime.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const argv = process.argv.slice(2);
const siteArg = argv.find((a) => a.startsWith('--site='));
const SITE = siteArg ? resolve(siteArg.slice('--site='.length)) : join(REPO, 'site');
const REQUIRE = argv.includes('--require');

const assetsDir = join(SITE, 'assets');
if (!existsSync(assetsDir)) { console.error('no assets under ' + assetsDir); process.exit(2); }
const names = readdirSync(assetsDir).filter((f) => /^spice-simulation-surface-.*\.js$/.test(f));
if (names.length !== 1) { console.error('expected one surface chunk, found ' + names.length); process.exit(2); }
const surface = readFileSync(join(assetsDir, names[0]), 'utf8');
const from = surface.indexOf('var rgTable = {');
const to = surface.indexOf('var Ht=', from);
if (from === -1 || to === -1) { console.error('no injected runtime in ' + names[0]); process.exit(2); }

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(surface.slice(from, to) + '\n', sandbox);
const { rgTable, rgDevice, rgAnnotate, rgFmt } = sandbox;
if (!rgTable || typeof rgDevice !== 'function' || typeof rgAnnotate !== 'function') { console.error('runtime incomplete'); process.exit(2); }

let failed = 0;
const check = (name, pass, detail) => {
  if (!pass) failed += 1;
  console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '   ' + detail));
};
// Two lines can name the same region and still differ, because each also prints
// the overdrive it used. Comparisons of REGION go through this; only the screen
// harness compares whole strings.
const word = (line) => { const m = /^Region\s+([^·]+?)\s*(?:·|$)/.exec(String(line ?? '')); return m ? m[1] : null; };

// --- fixtures --------------------------------------------------------------
// kp/phi/gamma/vto are read from the artifact; the arithmetic below is not.
const GAMMA = 0.4, PHI = 0.7; // the library's level-1 constants, written out so
// the comparison does not go through the artifact's own table for its physics.

const DEVICE = (name, instanceId, polarity) => ({ id: 'd-' + instanceId, documentId: 'document-main', instanceId, occurrence: [], reference: instanceId, polarity });
const DOCS = (model) => [{ id: 'document-main', instances: [{ id: 'M1', reference: 'M1', netlist: { binding: { kind: 'model', deviceClass: 'mos', name: model } } }] }];
const withValues = (dev, vgs, vds, vbs, status) => ({ ...dev, values: [
  { parameter: 'vgs', label: 'VGS', unit: 'V', status: status || 'available', value: vgs },
  { parameter: 'vds', label: 'VDS', unit: 'V', status: status || 'available', value: vds },
  { parameter: 'vbs', label: 'VBS', unit: 'V', status: status || 'available', value: vbs },
  { parameter: 'id', label: 'ID', unit: 'A', status: status || 'available', value: 1e-4 },
] });

// --- 1. the table itself ---------------------------------------------------
console.log('table');
check('the artifact carries the eight LEVEL=1 models',
  ['nmos_rvt', 'pmos_rvt', 'nmos_nat', 'nmos_dep', 'nmos_hvt', 'pmos_hvt', 'nmos_tox', 'pmos_tox'].every((m) => rgTable[m]),
  Object.keys(rgTable).join(', '));
check('a table entry carries no library line (the artifact does not ship the comment)',
  Object.values(rgTable).every((m) => m.source === undefined && Object.keys(m).join(',') === 'type,vto,kp,gamma,phi,lambda'));
check('the four NMOS models really do disagree about VTO',
  new Set(['nmos_rvt', 'nmos_nat', 'nmos_dep', 'nmos_hvt'].map((m) => rgTable[m].vto[0])).size === 4,
  ['nmos_rvt', 'nmos_nat', 'nmos_dep', 'nmos_hvt'].map((m) => m + '=' + rgTable[m].vto[0]).join(' '));
check('PMOS VTO is the negative of its NMOS twin',
  rgTable.pmos_rvt.vto[0] === -rgTable.nmos_rvt.vto[0] && rgTable.pmos_rvt.vto[1] === -rgTable.nmos_rvt.vto[1]);

// --- 2. constructed regions ------------------------------------------------
// VTO at sel=0 comes from the table; the overdrive is then arithmetic.
console.log('\nconstructed regions (nmos_rvt, __cn_sel=0)');
const VTO0 = rgTable.nmos_rvt.vto[0];
const VGS = 0.9;
const VOV = VGS - VTO0; // = 0.4000000000000001 with these constants
check('the overdrive the construction is built on', Math.abs(VOV - 0.4) < 1e-12, 'VGS=' + VGS + ' VTO(tt)=' + VTO0 + ' -> Vov=' + VOV);
const at = (vds, model, vgs, vbs, sel) => rgDevice(withValues(DEVICE(model || 'nmos_rvt', 'M1', (model || 'nmos_rvt').startsWith('pmos') ? 'pmos' : 'nmos'), vgs === undefined ? VGS : vgs, vds, vbs === undefined ? 0 : vbs), sel === undefined ? 0 : sel, DOCS(model || 'nmos_rvt'));

check('VDS below the overdrive is linear', /^Region\s+Linear/.test(at(VOV * 0.5) || ''), at(VOV * 0.5));
check('VDS above the overdrive is saturation', /^Region\s+Saturation/.test(at(VOV * 1.5) || ''), at(VOV * 1.5));
check('VDS exactly at the overdrive is the edge, not a side',
  /^Region\s+At the edge of saturation/.test(at(VOV) || ''), at(VOV));
check('just inside the tolerance band is still the edge', /edge/.test(at(VOV * 1.019) || ''), at(VOV * 1.019));
check('just outside the tolerance band picks a side', /Saturation/.test(at(VOV * 1.021) || ''), at(VOV * 1.021));
check('the symmetric case below the band also picks a side', /Linear/.test(at(VOV * 0.979) || ''), at(VOV * 0.979));
check('VGS at threshold is cutoff, not linear', /Cutoff/.test(at(0.5, 'nmos_rvt', VTO0) || ''), at(0.5, 'nmos_rvt', VTO0));
check('VGS below threshold is cutoff', /Cutoff/.test(at(0.5, 'nmos_rvt', VTO0 - 0.2) || ''), at(0.5, 'nmos_rvt', VTO0 - 0.2));
check('the cutoff line states the overdrive it used', /Vov = -200\.0 mV/.test(at(0.5, 'nmos_rvt', VTO0 - 0.2) || ''), at(0.5, 'nmos_rvt', VTO0 - 0.2));

// --- 3. body effect, computed here longhand --------------------------------
console.log('\nbody effect (computed in this file from GAMMA and PHI)');
const VBS = -0.5;
const VSB = -VBS;
const VTH_hand = VTO0 + GAMMA * (Math.sqrt(PHI + VSB) - Math.sqrt(PHI));
const VOV_hand = VGS - VTH_hand;
const bodyLine = at(VOV_hand * 0.5, 'nmos_rvt', VGS, VBS);
check('the row reports the body-shifted overdrive this file computed',
  bodyLine === 'Region  Linear · Vov = ' + rgFmt(VOV_hand) + ' > VDS = ' + rgFmt(VOV_hand * 0.5),
  'hand Vov=' + VOV_hand + ' -> ' + JSON.stringify(bodyLine));
check('the body-shifted overdrive really differs from the flat one', Math.abs(VOV_hand - VOV) > 0.1, 'flat ' + VOV + ' vs shifted ' + VOV_hand);
check('the region flips between flat and shifted at the same bias',
  at(VOV * 0.9) !== at(VOV * 0.9, 'nmos_rvt', VGS, VBS),
  'flat: ' + at(VOV * 0.9) + '  |  shifted: ' + at(VOV * 0.9, 'nmos_rvt', VGS, VBS));

// --- 4. the model name is load-bearing --------------------------------------
console.log('\nthe model name decides, not the polarity');
const bias = { vgs: 0.75, vds: 0.1, vbs: 0 };
const rvt = at(bias.vds, 'nmos_rvt', bias.vgs, bias.vbs);
const hvt = at(bias.vds, 'nmos_hvt', bias.vgs, bias.vbs);
check('two NMOS models at the same bias land in different regions', word(rvt) !== word(hvt), 'nmos_rvt: ' + rvt + '  |  nmos_hvt: ' + hvt);
check('and they are the regions their VTO implies',
  /Linear/.test(rvt) && /Saturation/.test(hvt), 'VTO ' + rgTable.nmos_rvt.vto[0] + ' vs ' + rgTable.nmos_hvt.vto[0]);

// --- 5. the corner moves the answer -----------------------------------------
console.log('\nthe corner selector moves the answer');
const flipVds = 0.2, flipVgs = 0.75;
const tt = at(flipVds, 'nmos_rvt', flipVgs, 0, 0);
const ss = at(flipVds, 'nmos_rvt', flipVgs, 0, 1);
const ff = at(flipVds, 'nmos_rvt', flipVgs, 0, -1);
check('the same bias is a different region in tt and ss', word(tt) !== word(ss), 'tt: ' + tt + '  |  ss: ' + ss);
check('slow raises the threshold, fast lowers it',
  /Linear/.test(tt) && /Saturation/.test(ss) && /Linear/.test(ff),
  'tt: ' + tt + '  |  ss: ' + ss + '  |  ff: ' + ff);
check('the spread moves threshold up and gain down on the slow corner',
  rgTable.nmos_rvt.vto[1] > 0 && rgTable.nmos_rvt.kp[1] < 0,
  'VTO coef=' + rgTable.nmos_rvt.vto[1] + '  KP coef=' + rgTable.nmos_rvt.kp[1]);

// --- 6. PMOS is the mirror, computed by flipping the input -------------------
console.log('\nPMOS mirrors (the same circuit, every node negated)');
const pairs = [[0.9, 0.5, 0], [0.9, 0.1, 0], [0.9, -0.1, -0.4], [0.6, 0.4, 0]];
let mirrored = 0;
for (const [vgs, vds, vbs] of pairs) {
  const n = at(vds, 'nmos_rvt', vgs, vbs, 0);
  const p = at(-vds, 'pmos_rvt', -vgs, -vbs, 0);
  if (n !== null && p !== null && word(n) === word(p)) mirrored += 1;
  else console.log('        mirror mismatch at vgs=' + vgs + ' vds=' + vds + ' vbs=' + vbs + ': nmos ' + JSON.stringify(n) + ' vs pmos ' + JSON.stringify(p));
}
check('every PMOS case is the NMOS case with the sign of the region reversed back', mirrored === pairs.length, mirrored + '/' + pairs.length);
check('and the PMOS branch is not simply the NMOS word', word(at(0.5, 'pmos_rvt', -0.9, 0, 0)) !== word(at(0.5, 'nmos_rvt', 0.9, 0, 0)),
  'pmos(' + at(0.5, 'pmos_rvt', -0.9, 0, 0) + ') vs nmos(' + at(0.5, 'nmos_rvt', 0.9, 0, 0) + ')');

// --- 7. refusals ------------------------------------------------------------
console.log('\nrefusals');
check('a model that is not in the table gets no line',
  rgDevice(withValues(DEVICE('M1', 'M1', 'nmos'), 0.9, 0.5, 0), 0, DOCS('bsim4_unknown')) === null);
check('and the same device against a model that IS in the table does get a line', at(0.5, 'nmos_rvt') !== null, at(0.5, 'nmos_rvt'));
check('an unknown corner selector adds no line at all',
  rgAnnotate({ documents: DOCS('nmos_rvt') }, { result: { metadata: { configuration: { modelLibrary: { section: 'weird' } } } }, outputData: { deviceOperatingPoints: [withValues(DEVICE('nmos_rvt', 'M1', 'nmos'), 0.9, 0.5, 0)] } })[0].region === undefined);
check('a device the schematic does not know gets no line',
  rgDevice(withValues(DEVICE('nmos_rvt', 'NOT-AN-INSTANCE', 'nmos'), 0.9, 0.5, 0), 0, DOCS('nmos_rvt')) === null);
check('an unavailable bias gets no line',
  rgDevice(withValues(DEVICE('nmos_rvt', 'M1', 'nmos'), 0.9, 0.5, 0, 'unavailable'), 0, DOCS('nmos_rvt')) === null);
check('a body bias that empties the surface potential gets no line (PHI+VSB <= 0)',
  rgDevice(withValues(DEVICE('nmos_rvt', 'M1', 'nmos'), 0.9, 0.5, 1.0), 0, DOCS('nmos_rvt')) === null,
  'VBS=1.0 -> PSI=' + (PHI - 1.0));
check('the same device with a sane body bias does get a line',
  rgDevice(withValues(DEVICE('nmos_rvt', 'M1', 'nmos'), 0.9, 0.5, -0.5), 0, DOCS('nmos_rvt')) !== null);

// --- 8. the corner selector mapping ----------------------------------------
console.log('\nwhat the deck assembler saw -> the selector it did NOT write');
const selOf = (section) => {
  const run = { result: { metadata: { configuration: { modelLibrary: { section } } } }, outputData: { deviceOperatingPoints: [withValues(DEVICE('nmos_rvt', 'M1', 'nmos'), 0.75, 0.2, 0)] } };
  return rgAnnotate({ documents: DOCS('nmos_rvt') }, run)[0].region;
};
check('an absent selector behaves like tt', selOf(undefined) === selOf('tt'), JSON.stringify(selOf(undefined)));
check('null behaves like tt', selOf(null) === selOf('tt'), JSON.stringify(selOf(null)));
check('the empty string behaves like tt', selOf('') === selOf('tt'));
check('tt is not the same region as ss', word(selOf('tt')) !== word(selOf('ss')), 'tt: ' + selOf('tt') + ' | ss: ' + selOf('ss'));
check('ff lands back with tt while ss does not',
  word(selOf('ss')) !== word(selOf('tt')) && word(selOf('ff')) === word(selOf('tt')),
  'tt: ' + word(selOf('tt')) + ' | ss: ' + word(selOf('ss')) + ' | ff: ' + word(selOf('ff')));

// --- 9. the runtime is idempotent and non-destructive ------------------------
console.log('\nthe run\'s device list is not mutated');
const dev = withValues(DEVICE('nmos_rvt', 'M1', 'nmos'), 0.9, 0.5, 0);
const list = [dev];
const run = { result: { metadata: { configuration: { modelLibrary: { section: null } } } }, outputData: { deviceOperatingPoints: list } };
const out = rgAnnotate({ documents: DOCS('nmos_rvt') }, run);
check('the input device object is untouched', list[0].region === undefined);
check('the output is a different object', out !== list && out[0] !== list[0]);
check('the output keeps every field the card reads', out[0].values === dev.values && out[0].reference === dev.reference && out[0].polarity === dev.polarity);

console.log('');
console.log(failed === 0 ? 'RESULT: all checks passed' : 'RESULT: ' + failed + ' check(s) FAILED');
console.log('  site = ' + SITE + '  (' + names[0] + ')');
process.exit(REQUIRE && failed ? 1 : 0);
