// Independent oracle for the stability-margin evaluator.
//
// Three properties this file exists to guarantee:
//
//  1. It reads the evaluator OUT OF THE SHIPPED BYTES (site/assets/src-CMkpkg0p.js),
//     not out of the manifest. A manifest test proves the manifest is
//     self-consistent; only an artifact test proves the artifact is correct.
//     If the patch is never applied, this exits non-zero instead of passing on
//     a copy of the code that ships nowhere.
//
//  2. The expected values come from an INDEPENDENTLY WRITTEN implementation
//     (oraclePM/oracleGM below) plus closed forms. A test that recomputes the
//     answer with the same code it is testing reports the greenest number in
//     the world and means nothing.
//
//  3. It tests INVARIANCES, not just values. Multiplying a response by -1 adds
//     180 degrees of phase and cannot change a loop's stability, so every case
//     is checked twice: as written, and inverted. An evaluator that measures
//     against absolute -180 passes the first check and fails the second, and
//     reports a healthy 275 degrees for a loop that has already gone unstable.
//
// Usage: node scripts/stability-margin.oracle.mjs [--site=<dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const siteArg = process.argv.find((a) => a.startsWith('--site='));
const SITE = siteArg ? path.resolve(siteArg.slice('--site='.length)) : path.join(REPO, 'site');

const EXECUTOR = path.join(SITE, 'assets', 'src-CMkpkg0p.js');
if (!fs.existsSync(EXECUTOR)) {
  console.error('FATAL: no executor at ' + EXECUTOR);
  process.exit(2);
}
const bundle = fs.readFileSync(EXECUTOR, 'utf8');

// ---- extract the evaluator from the shipped bytes ---------------------------
// The injected block begins at "function smCross(" and ends right before the
// automatic-summariser loop it was spliced in front of. Both boundaries are
// asserted to be unique, so a silent re-anchoring fails here rather than
// quietly testing a different region.
function extract(source, startNeedle, endNeedle) {
  const starts = [...source.matchAll(new RegExp(escapeRe(startNeedle), 'g'))];
  const ends = [...source.matchAll(new RegExp(escapeRe(endNeedle), 'g'))];
  if (starts.length !== 1) {
    console.error('FATAL: start anchor ' + JSON.stringify(startNeedle) + ' occurs ' + starts.length + ' time(s), want 1');
    process.exit(2);
  }
  if (ends.length !== 1) {
    console.error('FATAL: end anchor ' + JSON.stringify(endNeedle) + ' occurs ' + ends.length + ' time(s), want 1');
    process.exit(2);
  }
  if (ends[0].index <= starts[0].index) {
    console.error('FATAL: end anchor precedes start anchor');
    process.exit(2);
  }
  return source.slice(starts[0].index, ends[0].index);
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const START = 'function smCross(';
const END = 'function Xe(e){let t=[];';
const body = extract(bundle, START, END);

// The record factory lives AFTER the summariser loop, so it is extracted
// separately rather than assumed to sit inside the same slice.
const REC_START = 'function smRecord(';
const recIdx = [...bundle.matchAll(new RegExp(escapeRe(REC_START), 'g'))];
if (recIdx.length !== 1) {
  console.error('FATAL: record factory anchor occurs ' + recIdx.length + ' time(s), want 1');
  process.exit(2);
}
// smRecord is the last injected function; take to the end of its statement by
// brace matching from its opening brace.
function takeFunction(source, startIdx) {
  const open = source.indexOf('{', startIdx);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return source.slice(startIdx, i + 1);
    }
  }
  throw new Error('unbalanced braces in injected function at ' + startIdx);
}
const recBody = takeFunction(bundle, recIdx[0].index);

// Evaluate the extracted source with only Math in scope.
const sandbox = new Function('Math',
  body + '\n' + recBody + '\nreturn { smMargins, smCross, smInterp, smUnwrap, smStatic, smPassed, smRecord };');
const { smMargins, smCross, smInterp, smUnwrap, smStatic, smPassed } = sandbox(Math);

console.log('=== evaluator source ===');
console.log('  extracted ' + body.length + ' B from ' + path.relative(REPO, EXECUTOR));
console.log('  record factory ' + recBody.length + ' B');

// ---- synthetic AC analyses -------------------------------------------------
// A stability margin only exists if |H| starts ABOVE 0 dB; otherwise there is no
// 0 dB crossing and no margin. Every case below therefore carries A0 > 1.
function logspace(lo, hi, perDecade) {
  const k = Math.ceil(Math.log10(hi / lo) * perDecade);
  const pts = [];
  for (let i = 0; i <= k; i++) pts.push(lo * Math.pow(10, i / perDecade));
  return pts;
}
function ac(pts, H) {
  return {
    analysis: 'ac', plotName: 'AC Analysis',
    domain: { name: 'Frequency', unit: 'Hz', values: pts },
    outputs: [{ id: 'o1', label: 'v(out)', unit: 'V', values: H.map((h) => h[0]), imaginary: H.map((h) => h[1]) }],
  };
}
// Multiplying by -1 rotates the phase by 180 degrees and leaves |H| alone. It
// cannot change whether a loop is stable, so it must not change a margin.
function invert(an) {
  const o = an.outputs[0];
  return {
    ...an,
    outputs: [{
      ...o,
      values: o.values.map((v) => (v === null ? null : -v)),
      imaginary: o.imaginary.map((v) => (v === null ? null : -v)),
    }],
  };
}
// H = A0 / (1 + j w). Real = A0/(1+w^2), Imag = -A0 w/(1+w^2).
function onePole(fc, A0, lo, hi, perDecade) {
  const pts = logspace(lo, hi, perDecade);
  return ac(pts, pts.map((f) => {
    const w = f / fc;
    return [A0 / (1 + w * w), -A0 * w / (1 + w * w)];
  }));
}
// H = A0 / ((1+j a)(1+j b)). Denom D = (1-ab) + j(a+b); H = A0 * conj(D)/|D|^2.
function twoPole(f1, f2, A0, lo, hi, perDecade) {
  const pts = logspace(lo, hi, perDecade);
  return ac(pts, pts.map((f) => {
    const a = f / f1, b = f / f2;
    const dr = 1 - a * b, di = a + b;
    const dd = dr * dr + di * di;
    return [A0 * dr / dd, -A0 * di / dd];
  }));
}
// Three cascaded poles with explicit complex multiply, to avoid the sign
// ambiguity that comes from accumulating denominators by hand.
function threePole(fs3, A0, lo, hi, perDecade) {
  const pts = logspace(lo, hi, perDecade);
  return ac(pts, pts.map((f) => {
    let re = 1, im = 0;
    for (const fc of fs3) { const w = f / fc; const nr = re - im * w, ni = re * w + im; re = nr; im = ni; }
    const dd = re * re + im * im;
    return [A0 * re / dd, -A0 * im / dd];
  }));
}

// ---- independent oracle ----------------------------------------------------
// Written from the definitions, not by reusing the evaluator's structure, and
// in particular with its own unwrap.
function series(an) {
  const f = an.domain.values, o = an.outputs[0];
  return {
    f,
    db: f.map((_, i) => 20 * Math.log10(Math.max(Math.hypot(o.values[i], o.imaginary[i]), 1e-30))),
    ph: f.map((_, i) => Math.atan2(o.imaginary[i], o.values[i]) * 180 / Math.PI),
  };
}
function unwrap(ph) {
  const out = [];
  let prev = null;
  for (const p of ph) {
    if (p === null || !Number.isFinite(p)) { out.push(null); continue; }
    let v = p;
    if (prev !== null) {
      while (v - prev > 180) v -= 360;
      while (v - prev < -180) v += 360;
    }
    prev = v;
    out.push(v);
  }
  return out;
}
// The loop's static phase: the nearest multiple of 180 to where the sweep
// starts. A response sitting at 0 deg and one sitting at 180 deg are the same
// loop with and without an inversion, so the threshold is relative to this.
function staticPhase(ph) {
  for (const p of ph) if (p !== null) return Math.round(p / 180) * 180;
  return 0;
}
// Crossing search against the LEVEL, on an already-unwrapped series.
function oracleCrossings(x, y, level) {
  const out = [];
  for (let i = 1; i < x.length; i++) {
    if (![x[i - 1], x[i], y[i - 1], y[i]].every(Number.isFinite)) continue;
    if (y[i - 1] === level) { out.push({ lx: x[i - 1], i }); continue; }
    if ((y[i - 1] - level) * (y[i] - level) < 0) {
      const t = (level - y[i - 1]) / (y[i] - y[i - 1]);
      out.push({ lx: x[i - 1] + (x[i] - x[i - 1]) * t, i });
    }
  }
  return out;
}
function oraclePM(an, lf) {
  const { db, ph } = series(an);
  const w = unwrap(ph), ref = staticPhase(w);
  const c = oracleCrossings(lf, db, 0);
  if (c.length !== 1) return null;
  const t = (c[0].lx - lf[c[0].i - 1]) / (lf[c[0].i] - lf[c[0].i - 1]);
  const p = w[c[0].i - 1] + t * (w[c[0].i] - w[c[0].i - 1]);
  return { pm: 180 + p - ref, f0: Math.pow(10, c[0].lx), ref };
}
function oracleGM(an, lf) {
  const { db, ph } = series(an);
  const w = unwrap(ph), ref = staticPhase(w);
  const c = oracleCrossings(lf, w, ref - 180);
  if (c.length !== 1) return null;
  const t = (c[0].lx - lf[c[0].i - 1]) / (lf[c[0].i] - lf[c[0].i - 1]);
  const d = db[c[0].i - 1] + t * (db[c[0].i] - db[c[0].i - 1]);
  return { gm: -d, f180: Math.pow(10, c[0].lx) };
}

// ---- harness ---------------------------------------------------------------
let failures = 0;
let assertions = 0;
const results = [];
function ok(name, cond, detail) {
  assertions++;
  if (!cond) { failures++; results.push('FAIL ' + name + (detail ? ' -- ' + detail : '')); }
  else results.push('ok   ' + name + (detail ? '  ' + detail : ''));
}
function close(name, got, want, tol) {
  const rel = Math.abs(got - want) / (Math.abs(want) || 1);
  ok(name, rel <= tol, 'got ' + got.toFixed(8) + ' want ' + want.toFixed(8) + ' rel=' + rel.toExponential(2));
}
function rec(recs, metric) { return recs.find((r) => r.metric === metric); }

/**
 * Run one analysis and its inverted twin and require identical margins.
 *
 * This is the assertion that would have caught measuring against absolute -180:
 * the inverted twin reads 180 degrees high and, on an unstable case, is not
 * refused at all.
 */
function invariant(label, an, expect) {
  const a = smMargins([an]);
  const b = smMargins([invert(an)]);
  const pa = rec(a, 'phase-margin'), pb = rec(b, 'phase-margin');
  const ga = rec(a, 'gain-margin'), gb = rec(b, 'gain-margin');
  ok(label + '/inversion does not change the PM verdict', pa.status === pb.status,
    'as-written ' + pa.status + ' vs inverted ' + pb.status);
  if (pa.status === 'available' && pb.status === 'available') {
    close(label + '/inversion does not change the PM value', pb.value, pa.value, 1e-9);
  }
  ok(label + '/inversion does not change the GM verdict', ga.status === gb.status,
    'as-written ' + ga.status + ' vs inverted ' + gb.status);
  if (ga.status === 'available' && gb.status === 'available') {
    close(label + '/inversion does not change the GM value', gb.value, ga.value, 1e-9);
  }
  if (expect) ok(label + '/verdict is ' + expect, pa.status === expect, 'status=' + pa.status);
  return { pa, pb, ga, gb };
}

// --- 1. one-pole: closed form for PM, GM undefined ---------------------------
{
  const A0 = 100, fc = 100;
  const an = onePole(fc, A0, 1, 1e5, 40);
  const recs = smMargins([an]);
  const pm = rec(recs, 'phase-margin'), gm = rec(recs, 'gain-margin');
  const theoryPM = 180 - Math.atan(Math.sqrt(A0 * A0 - 1)) * 180 / Math.PI;
  const theoryF0 = fc * Math.sqrt(A0 * A0 - 1);
  const o = oraclePM(an, an.domain.values.map(Math.log10));
  close('1p/PM vs independent oracle', pm.value, o.pm, 1e-12);
  // A 40-points-per-decade sweep resolves the crossing only to about a part in
  // 1e8, so the closed form is matched to 1e-6 rather than to machine epsilon.
  // Tightening this to 1e-9 would not test the evaluator, it would test the
  // sweep density.
  close('1p/PM vs closed form', pm.value, theoryPM, 1e-6);
  close('1p/f0 vs closed form', pm.evidence.coordinate, theoryF0, 1e-9);
  ok('1p/PM unit is deg', pm.unit === 'deg', 'unit=' + pm.unit);
  ok('1p/PM status available', pm.status === 'available', 'status=' + pm.status);
  ok('1p/GM reported unavailable', gm.status === 'unavailable', 'status=' + gm.status + ' reason=' + JSON.stringify(gm.reason));
  ok('1p/GM unit is dB even when unavailable', gm.unit === 'dB', 'unit=' + gm.unit);
  ok('1p/available record carries no reason', pm.reason === undefined, JSON.stringify(pm.reason));
  ok('1p/unavailable record carries no numeric value', gm.value === undefined, JSON.stringify(gm.value));
  // The evidence the schema actually allows.
  ok('1p/evidence is the schema point aggregate',
    pm.evidence && pm.evidence.kind === 'point' && Number.isFinite(pm.evidence.coordinate),
    JSON.stringify(pm.evidence));
  ok('1p/evidence carries no invented frequencyHz field',
    pm.evidence.frequencyHz === undefined,
    'keys=' + JSON.stringify(Object.keys(pm.evidence)));
  invariant('1p', an, 'available');
  console.log('\n-- one-pole A0=' + A0 + ' fc=' + fc + ' --');
  console.log('   PM=' + pm.value.toFixed(8) + ' deg (closed form ' + theoryPM.toFixed(8) + ') @ ' + pm.evidence.coordinate.toFixed(2) + ' Hz');
  console.log('   GM=' + gm.status + ' reason=' + JSON.stringify(gm.reason));
}

// --- 2. healthy two-pole: PM and GM both real -------------------------------
{
  const an = twoPole(1e3, 1e5, 10, 1, 1e9, 40);
  const recs = smMargins([an]);
  const pm = rec(recs, 'phase-margin'), gm = rec(recs, 'gain-margin');
  const lf = an.domain.values.map(Math.log10);
  const o = oraclePM(an, lf), og = oracleGM(an, lf);
  close('2p/PM vs independent oracle', pm.value, o.pm, 1e-12);
  close('2p/PM evidence vs oracle', pm.evidence.coordinate, o.f0, 1e-12);
  ok('2p/PM in (0,180)', pm.value > 0 && pm.value < 180, 'PM=' + pm.value.toFixed(4));
  invariant('2p', an, 'available');
  if (og) {
    close('2p/GM vs independent oracle', gm.value, og.gm, 1e-12);
    close('2p/GM evidence vs oracle', gm.evidence.coordinate, og.f180, 1e-12);
    console.log('\n-- healthy two-pole f1=1e3 f2=1e5 A0=10 --');
    console.log('   PM=' + pm.value.toFixed(8) + ' deg @ ' + pm.evidence.coordinate.toFixed(2) + ' Hz');
    console.log('   GM=' + gm.value.toFixed(8) + ' dB @ ' + gm.evidence.coordinate.toFixed(2) + ' Hz');
  } else {
    ok('2p/GM unavailable because phase never reaches the threshold', gm.status === 'unavailable', 'status=' + gm.status);
    console.log('\n-- healthy two-pole: GM genuinely undefined (phase never reaches the threshold) --');
    console.log('   PM=' + pm.value.toFixed(8) + ' deg; GM=' + gm.status);
  }
}

// --- 3. marginal two-pole: small but real PM ---------------------------------
{
  const an = twoPole(1e3, 1e4, 100, 1, 1e9, 40);
  const recs = smMargins([an]);
  const pm = rec(recs, 'phase-margin'), gm = rec(recs, 'gain-margin');
  const lf = an.domain.values.map(Math.log10);
  const o = oraclePM(an, lf), og = oracleGM(an, lf);
  close('marginal/PM vs independent oracle', pm.value, o.pm, 1e-12);
  ok('marginal/small PM is reported, not suppressed', pm.status === 'available', 'status=' + pm.status);
  if (og) close('marginal/GM vs independent oracle', gm.value, og.gm, 1e-12);
  invariant('marginal', an, 'available');
  console.log('\n-- marginal two-pole f1=1e3 f2=1e4 A0=100 --');
  console.log('   PM=' + pm.value.toFixed(8) + ' deg (small but defined); GM=' + gm.status + (og ? ' ' + gm.value.toFixed(4) + ' dB' : ''));
}

// --- 4. genuinely unstable: phase passes the threshold below unity gain ------
{
  const an = threePole([1e3, 1e4, 1e5], 1e5, 1e-1, 1e7, 40);
  const recs = smMargins([an]);
  const pm = rec(recs, 'phase-margin');
  ok('unstable/PM refused rather than reported as healthy', pm.status === 'unavailable', 'status=' + pm.status + ' PM=' + pm.value);
  ok('unstable/refusal names the cause', typeof pm.reason === 'string' && /passed -180 degrees/.test(pm.reason), JSON.stringify(pm.reason));
  // The inverted twin is the SAME loop with the inversion written down. It must
  // be refused too. Measuring against absolute -180 fails exactly here: it would
  // report a comfortable margin for this one.
  const inv = invariant('unstable', an, 'unavailable');
  ok('unstable/inverted twin is refused for the same reason',
    inv.pb.status === 'unavailable' && /passed 0 degrees/.test(String(inv.pb.reason)),
    'inverted reason=' + JSON.stringify(inv.pb.reason));
  console.log('\n-- unstable three-pole (and its inverted twin) --');
  console.log('   PM=' + pm.status + ' reason=' + JSON.stringify(pm.reason));
  console.log('   inverted PM=' + inv.pb.status + ' reason=' + JSON.stringify(inv.pb.reason));
}

// --- 5. the phase reference: inversion must not move the margin -------------
// A single-pole stage at A0=10 with the pole at 1 kHz. Non-inverting, the phase
// runs 0 -> -90 and PM = 180 - atan(9.9499) = 95.711 deg. Inverting, the phase
// runs 180 -> 90 and the SAME loop must still read 95.711 deg. Measuring against
// absolute -180 reads 275.711 deg here, and the difference is the whole point of
// this section.
{
  const pts = logspace(1, 1e5, 40);
  const H = pts.map((f) => { const w = f / 1e3; return [-10 / (1 + w * w), 10 * w / (1 + w * w)]; });
  const an = ac(pts, H);
  const { ph } = series(an);
  const exact = H.map((h) => Math.atan2(h[1], h[0]) * 180 / Math.PI);
  // phase[0] must be the atan2 identity, not 180.0000: the sweep starts at 1 Hz
  // with the pole at 1 kHz, so it is close to 180 but not at it.
  close('ref/first phase sample matches atan2', ph[0], exact[0], 1e-12);
  ok('ref/first phase is in the positive half-plane', ph[0] > 90, 'phase[0]=' + ph[0].toFixed(4));
  ok('ref/phase stays in the positive half-plane across the sweep',
    ph.every((p) => p > 0), 'phase[1]=' + ph[1].toFixed(3) + ' last=' + ph[ph.length - 1].toFixed(3));
  close('ref/atan2(0,-10) is +180', Math.atan2(0, -10) * 180 / Math.PI, 180, 1e-12);
  // The static phase snaps to 180, so the threshold is 0 deg, so the phase never
  // reaches it and the gain margin is undefined -- not "0 dB".
  const recs = smMargins([an]);
  const pm = rec(recs, 'phase-margin'), gm = rec(recs, 'gain-margin');
  const w = 9.9498743710662;                    // sqrt(99): |H| = 1
  const theoryPM = 180 - Math.atan(w) * 180 / Math.PI;
  ok('ref/inverting stage yields a defined PM', pm.status === 'available', 'status=' + pm.status);
  close('ref/inverting PM matches the non-inverting closed form', pm.value, theoryPM, 1e-5);
  ok('ref/inverting PM is inside (0,180)', pm.value > 0 && pm.value < 180, 'PM=' + pm.value.toFixed(4));
  ok('ref/inverting GM threshold is 0 degrees, not -180',
    typeof gm.reason === 'string' && /reaches 0 degrees/.test(gm.reason), JSON.stringify(gm.reason));
  invariant('ref', an, 'available');
  console.log('\n-- inverting single-pole A0=10, pole 1 kHz (phase reference pin) --');
  console.log('   static phase snapped to 180 deg, so the threshold is 0 deg');
  console.log('   PM=' + pm.value.toFixed(6) + ' deg (closed form ' + theoryPM.toFixed(6) + '); GM=' + gm.status + ' ' + JSON.stringify(gm.reason));
}

// --- 6. ambiguous multi-crossing must be refused ----------------------------
{
  const pts = logspace(1e-1, 1e3, 40);
  // |H| oscillates across 1 (0 dB) several times.
  const H = pts.map((f) => { const a = Math.sin(Math.log10(f)) * 2; return [a, 1e-4]; });
  const an = ac(pts, H);
  const recs = smMargins([an]);
  const pm = rec(recs, 'phase-margin');
  ok('ambiguous/multi-crossing refused', pm.status === 'unavailable', 'status=' + pm.status + ' PM=' + pm.value);
  ok('ambiguous/refusal mentions the crossing count', typeof pm.reason === 'string' && /\btimes\b/.test(pm.reason), JSON.stringify(pm.reason));
  console.log('\n-- ambiguous multi-crossing --');
  console.log('   PM=' + pm.status + ' reason=' + JSON.stringify(pm.reason));
}

// --- 7. degenerate axis (0 Hz present) must be refused ----------------------
{
  const an = {
    analysis: 'ac', plotName: 'AC',
    domain: { name: 'Frequency', unit: 'Hz', values: [0, 10, 100] },
    outputs: [{ id: 'o1', label: 'v', unit: 'V', values: [100, 10, 1], imaginary: [0, -1, -0.1] }],
  };
  const recs = smMargins([an]);
  const pm = rec(recs, 'phase-margin');
  ok('degenerate/axis with 0 Hz refused', pm.status === 'unavailable', 'status=' + pm.status);
  console.log('\n-- degenerate axis --');
  console.log('   PM=' + pm.status + ' reason=' + JSON.stringify(pm.reason));
}

// --- 8. non-AC analyses produce nothing -------------------------------------
{
  const recs = smMargins([{ analysis: 'tran', plotName: 'Transient', domain: { name: 'Time', unit: 's', values: [0, 1] }, outputs: [{ id: 'o', label: 'v', unit: 'V', values: [0, 1] }] }]);
  ok('non-AC/produces no records', recs.length === 0, 'count=' + recs.length);
  // A noise analysis has a frequency axis too, but its outputs are spectral
  // densities, not a transfer function. Restricting to `ac` is by construction,
  // not by the accident that noise outputs happen to lack an imaginary half.
  const noisy = smMargins([{
    analysis: 'noise', plotName: 'Noise Analysis',
    domain: { name: 'Frequency', unit: 'Hz', values: [1, 10, 100] },
    outputs: [{ id: 'n', label: 'onoise', unit: 'V', values: [1e-8, 1e-8, 1e-8], imaginary: [0, 0, 0] }],
  }]);
  ok('noise/produces no records even when an imaginary half is present', noisy.length === 0, 'count=' + noisy.length);
  console.log('\n-- non-AC analysis --');
  console.log('   tran records=' + recs.length + ', noise records=' + noisy.length);
}

// --- 9. complex output missing its imaginary half is skipped ----------------
{
  const recs = smMargins([{ analysis: 'ac', plotName: 'AC', domain: { name: 'Frequency', unit: 'Hz', values: [1, 10] }, outputs: [{ id: 'o', label: 'v', unit: 'V', values: [1, 0.1] }] }]);
  ok('no-imaginary/produces no records', recs.length === 0, 'count=' + recs.length);
  console.log('\n-- AC output without an imaginary array --');
  console.log('   records=' + recs.length);
}

// --- 10. NaN samples must not fabricate a crossing --------------------------
{
  const pts = logspace(1, 1e5, 40);
  const an = onePole(100, 100, 1, 1e5, 40);
  const mid = Math.floor(pts.length / 2);
  an.outputs[0].values[mid] = NaN;
  an.outputs[0].imaginary[mid] = NaN;
  const recs = smMargins([an]);
  const pm = rec(recs, 'phase-margin');
  const survived = pm.status === 'available' || pm.status === 'unavailable';
  ok('NaN/sample handled without throwing or fabricating', survived, 'status=' + pm.status);
  console.log('\n-- a NaN sample in the middle of the sweep --');
  console.log('   PM=' + pm.status + (pm.status === 'available' ? ' ' + pm.value.toFixed(4) : ' reason=' + JSON.stringify(pm.reason)));
}

// --- 11. helpers behave on their own ---------------------------------------
{
  // smCross returns EVERY crossing so the caller can distinguish one from many.
  const xs = [0, 1, 2, 3, 4];
  const ys = [1, -1, 1, -1, 1];
  ok('smCross/finds all zero crossings', smCross(xs, ys, 0).length === 4, 'count=' + smCross(xs, ys, 0).length);
  ok('smCross/returns empty when no crossing', smCross([0, 1, 2], [1, 2, 3], 0).length === 0);
  // The level parameter must actually decide what counts as a crossing.
  // Regression pin: the first version tested a SIGN CHANGE, so this returned 0.
  ok('smCross/finds a crossing of a non-zero level',
    smCross([0, 1, 2], [1, 2, 3], 2.5).length === 1, 'count=' + smCross([0, 1, 2], [1, 2, 3], 2.5).length);
  // A phase that merely passes through 0 deg must NOT read as a -180 crossing.
  // Regression pin: a sign test returns 1 here and invents a gain margin.
  ok('smCross/does not mistake a 0 deg pass for a -180 deg crossing',
    smCross([0, 1, 2], [-1, 1, 2], -180).length === 0, 'count=' + smCross([0, 1, 2], [-1, 1, 2], -180).length);
  ok('smCross/counts a sample sitting exactly on the level',
    smCross([0, 1, 2], [-1, -180, -200], -180).length === 1, 'count=' + smCross([0, 1, 2], [-1, -180, -200], -180).length);
  // smInterp interpolates linearly in the x coordinate.
  close('smInterp/linear midpoint', smInterp([0, 1, 2], [0, 10, 20], 0.5), 5, 1e-12);
  // smUnwrap makes the phase continuous. 0 -> -90 -> -170 -> +175 -> +160 is a
  // monotone descent through -180 that atan2 reports in the positive half-plane.
  const uw = smUnwrap([0, -90, -170, 175, 160]);
  close('smUnwrap/first element unchanged', uw[0], 0, 1e-12);
  close('smUnwrap/wrapped +175 becomes -185', uw[3], -185, 1e-12);
  close('smUnwrap/last becomes -200', uw[4], -200, 1e-12);
  // smStatic snaps the low-frequency phase to the loop's static value.
  ok('smStatic/snaps ~180 to 180', smStatic([179.9, 170]) === 180, 'got ' + smStatic([179.9, 170]));
  ok('smStatic/snaps ~0 to 0', smStatic([0.5, -10]) === 0, 'got ' + smStatic([0.5, -10]));
  ok('smStatic/skips leading non-finite samples', smStatic([null, NaN, 175]) === 180, 'got ' + smStatic([null, NaN, 175]));
  // smPassed takes an ALREADY UNWRAPPED series and asks whether it reached the
  // threshold strictly before index t.
  ok('smPassed/true when the threshold was crossed earlier', smPassed([0, -90, -200, -300], 3, -180) === true);
  ok('smPassed/false when the crossing is at the call index', smPassed([0, -90, -180, -200], 2, -180) === false);
  console.log('\n-- helper unit checks --');
  console.log('   smUnwrap([0,-90,-170,175,160]) = [' + uw.join(', ') + ']');
  console.log('   smStatic([179.9,170]) = ' + smStatic([179.9, 170]));
}

// ---- report ----------------------------------------------------------------
console.log('\n=== ' + assertions + ' assertions, ' + failures + ' failure(s) ===');
for (const r of results) console.log('  ' + r);
console.log('\n' + (failures ? 'FAIL' : 'PASS') + ': evaluator matches the closed-form and independent oracles');
process.exit(failures ? 1 : 0);
