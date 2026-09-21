#!/usr/bin/env node
/**
 * Numeric cross-check for the ngspice engine shipped in site/vendor/ngspice.js.
 *
 * Why this exists
 * ---------------
 * The artifact guard (scripts/check-artifacts.mjs) proves the bundle is
 * coherent, and the smoke test (scripts/smoke-test.mjs) proves the editor can
 * finish a simulation with zero uncaught errors. Neither says anything about
 * whether the NUMBERS are right: a build can load, run, render a curve, and
 * still be wrong. That gap -- "it runs != it is correct" -- was the one item
 * left explicitly open by the handover analysis.
 *
 * Two oracles, deliberately different in kind
 * -------------------------------------------
 * Channel 1 is always the artifact under test: site/vendor/ngspice.js driven in
 * a Node host (the same WASM the browser loads). Channel 2 comes in two flavours
 * because they cover different things and fail in different ways:
 *
 *   (a) CLOSED FORM -- recompute the answer from first principles with no
 *       ngspice on this side. Agreement is evidence, not a tautology.
 *         resistive divider      V = Vin*R2/(R1+R2)
 *         two-node network       own MNA + Gauss-Jordan, 1e-9
 *         RC low-pass AC         |H| = 1/sqrt(1+(2*pi*f*R*C)^2)
 *         RC charge              V = 1-exp(-t/RC)
 *         RC discharge           V = (1-exp(-tw/RC))*exp(-(t-tw)/RC)
 *         MOS level=1 sat        (Vdd-Rd*A)/(1+Rd*A*lambda), A=(kp/2)(W/L)Vov^2
 *         MOS level=1 triode     own bisection on Rd*Id(Vd)+Vd = Vdd
 *         diode + resistor       own bisection on Shockley, Vt = k*Tnom/q
 *       Because the expectation is COMPUTED rather than frozen, the check keeps
 *       meaning after an upstream rebuild: a new engine that silently changes a
 *       model will drift off the closed-form value and fail. Snapshot tests
 *       cannot do that.
 *
 *   (b) INVARIANTS -- relations that must hold for ANY correct engine, with no
 *       closed form required. This is what lets the check reach the models we
 *       genuinely cannot solve on paper (BSIM3 level=8/49, BSIM4 level=14/54):
 *         affine in source        a linear network scales with its source
 *         monotone transfer       Vd(Vgs) is non-increasing for a pull-up load
 *         boundedness             0 <= Vd <= Vdd
 *         off-state isolation     |Id| is negligible below threshold
 *         load-line consistency   -i(vdd) equals (Vdd-Vd)/Rd in every point
 *         exponential slope       d(ln I)/dV = 1/(n*Vt) for a junction diode
 *       Invariants are weaker than closed forms per assertion -- they bound
 *       behaviour instead of pinning a value -- but they are the only oracle we
 *       have for high-order device models, and they still catch sign errors,
 *       broken scaling, wrong regions-of-operation and non-physical output.
 *       "load-line consistency" compares two outputs of the same engine, so it
 *       is a self-consistency relation, not an independent one; it is kept
 *       because it validates the current/voltage bookkeeping per model.
 *
 * Usage
 *   node scripts/numeric-crosscheck.mjs [--json] [--verbose] [--only=<name,...>]
 *
 *   --json      Print the machine-readable report to stdout instead of the table.
 *   --verbose   Also print per-case raw values.
 *   --only=a,b  Run just the named cases (used by the negative-control driver,
 *               which only needs the cases a given mutant is meant to break).
 *               An unknown name is a setup error, not a silent skip.
 *
 * Exit codes
 *   0  all cases within tolerance
 *   1  at least one case drifted (or the engine could not be driven)
 *   2  setup error (missing site/vendor/ngspice.js)
 *
 * ENVIRONMENT_IS_NODE note: an Emscripten build carries a Node branch, so the
 * exact same module that runs in the browser can be driven from Node with no
 * browser. One deck per process -- the runtime is not re-entrant -- so this
 * script re-execs itself once per case with --run=<i>.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const VENDOR = join(REPO_ROOT, 'site', 'vendor', 'ngspice.js');

// --------------------------------------------------------------------------
// shared PHYSCIAL CONSTANTS used by the closed-form channel (channel 2a).
// ngspice runs at its nominal temperature (27 C) unless a deck says otherwise.
// --------------------------------------------------------------------------
const Q_E = 1.602176634e-19;          // elementary charge [C]
const K_B = 1.380649e-23;             // Boltzmann constant [J/K]
const KELVIN = 273.15;                // 0 C in K
const TNOM_C = 27;                    // ngspice default nominal temperature
const VTHERM = (K_B / Q_E) * (TNOM_C + KELVIN);  // ~0.02586493 V

// --------------------------------------------------------------------------
// generic numerics used by the closed-form channel. Independent of ngspice.
// --------------------------------------------------------------------------
/** Gauss-Jordan elimination with partial pivoting. Solves A x = b. */
function solveLinear(A, b) {
  const n = b.length;
  const M = A.map((row, i) => row.concat([b[i]]));
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    const t = M[col]; M[col] = M[piv]; M[piv] = t;
    const d = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / d;
      for (let k = col; k <= n; k++) M[r][k] -= f * M[col][k];
    }
  }
  return M.map((row, i) => row[n] / M[i][i]);
}

/** Bisection on a bracketing interval. Returns the midpoint of the final bracket. */
function bisect(f, lo, hi, iters = 300) {
  let a = lo, b = hi;
  for (let i = 0; i < iters; i++) {
    const m = (a + b) / 2;
    if (f(m) > 0) a = m; else b = m;
  }
  return (a + b) / 2;
}

// --------------------------------------------------------------------------
// reusable device-level closed forms (channel 2a)
// --------------------------------------------------------------------------
const MOS_L1 = { kp: 200e-6, W: 10, L: 1, vto: 0.5, lambda: 0.05 };
const MOS_DECK = [
  'VDD vdd 0 1.8',
  'VG g 0 0.9',
  'RD vdd d 5k',
  'M1 d g 0 0 n1 W=10u L=1u',
  '.model n1 nmos level=1 vto=0.5 kp=200u gamma=0.4 phi=0.7 lambda=0.05',
].join('\n');

/** Id for an ideal level=1 NMOS in saturation, including the lambda slope. */
function mosSatCurrent(vgs, vds) {
  const A = (MOS_L1.kp / 2) * (MOS_L1.W / MOS_L1.L) * (vgs - MOS_L1.vto) ** 2;
  return A * (1 + MOS_L1.lambda * vds);
}
/** Level=1 triode current. */
function mosTriodeCurrent(vgs, vds) {
  const beta = MOS_L1.kp * (MOS_L1.W / MOS_L1.L);
  const vov = vgs - MOS_L1.vto;
  return beta * (vov * vds - (vds * vds) / 2) * (1 + MOS_L1.lambda * vds);
}
/** Shockley diode current. */
function diodeCurrent(vd, is = 1e-14, n = 1) {
  return is * (Math.exp(vd / (n * VTHERM)) - 1);
}

// --------------------------------------------------------------------------
// reusable INVARIANT families (channel 2b). Each returns a list of predicates
// over a whole plot. They need no closed form, so they also apply to models we
// cannot solve analytically.
// --------------------------------------------------------------------------
/** Invariants every common-source NMOS stage with a resistive pull-up obeys. */
function mosSweepInvariants({ vdd, rd, offUpTo }) {
  return [
    (X) => {
      const vd = X.col('v(d)');
      let bad = -1;
      for (let i = 1; i < vd.length; i++) if (vd[i] > vd[i - 1] + 1e-9) { bad = i; break; }
      return {
        label: 'Vd(Vgs) non-increasing',
        actual: vd[bad], expected: vd[bad - 1], relError: bad < 0 ? 0 : Math.abs(vd[bad] - vd[bad - 1]),
        ok: bad < 0, detail: bad < 0 ? `${vd.length} points` : `rises at index ${bad}`,
      };
    },
    (X) => {
      const vd = X.col('v(d)');
      const lo = Math.min(...vd), hi = Math.max(...vd);
      return {
        label: '0 <= Vd <= Vdd', actual: hi, expected: vdd,
        relError: Math.max((lo < -1e-9 ? -lo : 0), (hi > vdd + 1e-9 ? hi - vdd : 0)),
        ok: lo >= -1e-9 && hi <= vdd + 1e-9, detail: `min=${lo.toPrecision(6)} max=${hi.toPrecision(6)}`,
      };
    },
    (X) => {
      const vs = X.col('v(v-sweep)'), id = X.col('i(vdd)');
      let worst = 0, at = null;
      for (let i = 0; i < vs.length; i++) {
        if (vs[i] > offUpTo + 1e-12) continue;
        const d = Math.abs(id[i]);
        if (d > worst) { worst = d; at = vs[i]; }
      }
      return {
        label: `|Id| negligible below Vgs=${offUpTo}`, actual: worst, expected: 0,
        relError: worst, ok: worst <= 1e-9, detail: `max |Id| = ${worst.toExponential(2)} A`,
      };
    },
    (X) => {
      // More gate drive can never reduce the drain current of a pull-up stage.
      const vs = X.col('v(v-sweep)'), id = X.col('i(vdd)').map(Math.abs);
      let bad = -1;
      for (let i = 1; i < id.length; i++) {
        // allow a hair of numerical noise, but not a real reversal
        if (id[i] < id[i - 1] * (1 - 1e-9) - 1e-15) { bad = i; break; }
      }
      return {
        label: '|Id| non-decreasing in Vgs',
        actual: id[bad], expected: id[bad - 1],
        relError: bad < 0 ? 0 : Math.abs(id[bad] - id[bad - 1]) / Math.max(id[bad - 1], 1e-15),
        ok: bad < 0,
        detail: bad < 0 ? `${id.length} points` : `drops at Vgs=${Number(vs[bad]).toPrecision(4)}`,
      };
    },
    (X) => {
      const vd = X.col('v(d)'), id = X.col('i(vdd)');
      // The relation is exact, but it is compared through (Vdd - Vd), which
      // loses ~log10(Vdd/(Vdd-Vd)) digits when the stage is off. A pure
      // relative test would then flag a 1e-20 A residue as a 1e-8 drift, so a
      // relative test OR an absolute floor derived from the print precision of
      // the rawfile (15 significant digits) may satisfy the invariant.
      const absFloor = (vdd / rd) * 1e-12;
      let worstAbs = 0, worstRel = 0, at = null;
      for (let i = 0; i < vd.length; i++) {
        const fromSource = -id[i];                 // current delivered by VDD
        const fromResistor = (vdd - vd[i]) / rd;   // Ohm's law on the load
        const mismatch = Math.abs(fromSource - fromResistor);
        const scale = Math.max(Math.abs(fromSource), Math.abs(fromResistor), 1e-12);
        if (mismatch > worstAbs) { worstAbs = mismatch; at = i; }
        if (mismatch > absFloor) worstRel = Math.max(worstRel, mismatch / scale);
      }
      const ok = worstAbs <= absFloor || worstRel <= 1e-9;
      return {
        label: '-i(vdd) == (Vdd-Vd)/Rd', actual: worstAbs, expected: absFloor,
        relError: worstRel, ok,
        detail: `max |mismatch| = ${worstAbs.toExponential(2)} A (floor ${absFloor.toExponential(2)}), max rel above floor = ${worstRel.toExponential(2)} at point ${at}`,
      };
    },
    (X) => {
      const vs = X.col('v(v-sweep)'), vd = X.col('v(d)');
      const last = vd.length - 1;
      return {
        label: 'strong inversion pulls drain below Vdd/2',
        actual: vd[last], expected: vdd / 2,
        relError: Math.abs(vd[last] - vdd / 2) / (vdd / 2),
        ok: vd[last] < vdd / 2, detail: `Vd=${vd[last].toPrecision(6)} at Vgs=${Number(vs[last]).toPrecision(4)}`,
      };
    },
  ];
}

// --------------------------------------------------------------------------
// --------------------------------------------------------------------------
// The process-corner group. Four decks that differ only in the selector line
// the deck emitter would write, run against the library that ships in the
// artifact -- so a library that stopped answering the selector, or a corner
// whose spread was quietly dropped, fails here rather than only in a browser.
//
// The library is read from the tree, not transcribed, because the library is
// the thing under test. The one thing frozen is the pre-corner device set, and
// it is frozen on purpose: it is the oracle for "the default still means what it
// always meant", and an oracle that moved with the artifact could not say that.
// --------------------------------------------------------------------------
const CORNER_LIB_PATH = '/spice-simulator/models/cmos.lib';
const CORNER_LIB_FILE = join(REPO_ROOT, 'site', 'models', 'cmos.lib');
const CORNER_SENSE = Array.from({ length: 10 }, (_, i) => 'i(vs' + (i + 1) + ')');
const CORNER_DEVICES = [
  'nmos_rvt', 'nmos_nat', 'nmos_dep', 'nmos_hvt', 'nmos_tox',
  'pmos_rvt', 'pmos_hvt', 'pmos_tox', 'npn_l1', 'pnp_l1',
];

// The device set as it shipped before the corners existed (commit 1303d81).
const FROZEN_TYPICAL_MODELS = [
  '.model nmos_rvt NMOS LEVEL=1 VTO=0.5 KP=200u GAMMA=0.4 PHI=0.7 LAMBDA=0.05',
  '.model pmos_rvt PMOS LEVEL=1 VTO=-0.5 KP=100u GAMMA=0.4 PHI=0.7 LAMBDA=0.05',
  '.model nmos_nat NMOS LEVEL=1 VTO=0.0 KP=200u GAMMA=0.4 PHI=0.7 LAMBDA=0.05',
  '.model nmos_dep NMOS LEVEL=1 VTO=-0.7 KP=200u GAMMA=0.4 PHI=0.7 LAMBDA=0.05',
  '.model nmos_hvt NMOS LEVEL=1 VTO=0.7 KP=200u GAMMA=0.4 PHI=0.7 LAMBDA=0.05',
  '.model pmos_hvt PMOS LEVEL=1 VTO=-0.7 KP=100u GAMMA=0.4 PHI=0.7 LAMBDA=0.05',
  '.model nmos_tox NMOS LEVEL=1 VTO=0.7 KP=80u GAMMA=0.4 PHI=0.7 LAMBDA=0.05',
  '.model pmos_tox PMOS LEVEL=1 VTO=-0.7 KP=40u GAMMA=0.4 PHI=0.7 LAMBDA=0.05',
  '.model npn_l1 NPN IS=1e-16 BF=100 NF=1 VAF=50 IKF=1e-2',
  '.model pnp_l1 PNP IS=1e-16 BF=50 NF=1 VAF=30 IKF=5e-3',
].join('\n') + '\n';

// Ten devices, each fed through a 0 V sense source so its branch current is a
// rawfile variable. Magnitudes are compared: ngspice's sign for i(vxxx) follows
// the element's node order, and the claim here is about current, not polarity.
// The BJT bases are biased so both devices sit in the active region -- a
// transistor that is simply off would still "change" between corners, on
// leakage, and would pass an ordering test for the wrong reason.
const CORNER_CIRCUIT = [
  'VDD vdd 0 1.8',
  'VCC vcc 0 1.8',
  'VG  g  0 0.9',
  'VGP gp 0 0',
  'VS1 vdd m1 0',
  'M1 m1 g 0 0 nmos_rvt W=10u L=1u',
  'VS2 vdd m2 0',
  'M2 m2 g 0 0 nmos_nat W=10u L=1u',
  'VS3 vdd m3 0',
  'M3 m3 g 0 0 nmos_dep W=10u L=1u',
  'VS4 vdd m4 0',
  'M4 m4 g 0 0 nmos_hvt W=10u L=1u',
  'VS5 vdd m5 0',
  'M5 m5 g 0 0 nmos_tox W=10u L=1u',
  'VS6 m6 0 0',
  'MP1 m6 gp vdd vdd pmos_rvt W=10u L=1u',
  'VS7 m7 0 0',
  'MP2 m7 gp vdd vdd pmos_hvt W=10u L=1u',
  'VS8 m8 0 0',
  'MP3 m8 gp vdd vdd pmos_tox W=10u L=1u',
  'RB1 vdd b1 100k',
  'VS9 vcc c1 0',
  'Q1 c1 b1 0 npn_l1',
  'RB2 b2 0 100k',
  'VS10 c2 0 0',
  'Q2 c2 b2 vcc pnp_l1',
].join('\n');

/** The deck the assembler would build for this selector: include, then selector. */
function cornerDeck(selector) {
  const lines = ['* SPICE simulation deck', '.include "' + CORNER_LIB_PATH + '"'];
  if (selector !== null) lines.push('.param __cn_sel=' + selector);
  lines.push(CORNER_CIRCUIT, '.op', '.end');
  return lines.join('\n') + '\n';
}

function cornerLibrary() {
  try { return readFileSync(CORNER_LIB_FILE, 'utf8'); } catch { return null; }
}

/** A corner is only revealed by its devices if all of them are conducting. */
function cornerConductsInvariant(X) {
  const dead = [];
  for (const name of CORNER_SENSE) {
    const j = X.index(name);
    const a = (j < 0 || X.parsed.points.length === 0)
      ? null
      : Math.abs(Number(String(X.parsed.points[0][j]).split(',')[0]));
    if (a === null || !(a > 1e-9)) dead.push(name + '=' + String(a));
  }
  return {
    label: 'every sense source carries > 1 nA',
    actual: CORNER_SENSE.length - dead.length, expected: CORNER_SENSE.length,
    relError: null,
    detail: dead.length ? 'not conducting: ' + dead.join(', ') : 'all ten devices in the active region',
    ok: dead.length === 0,
  };
}

function cornerCases() {
  const shipped = cornerLibrary();
  const shared = {
    corner: true,
    rtol: 1e-9,
    files: shipped === null ? {} : { [CORNER_LIB_PATH]: shipped },
    invariants: [cornerConductsInvariant],
  };
  return [
    { name: 'corner_default', what: 'shipped library, no selector line', deck: cornerDeck(null), ...shared },
    { name: 'corner_ss', what: 'shipped library, slow corner', deck: cornerDeck(1), ...shared },
    { name: 'corner_ff', what: 'shipped library, fast corner', deck: cornerDeck(-1), ...shared },
    {
      name: 'corner_frozen', what: 'the device set that shipped before the corners, no selector',
      deck: cornerDeck(null), ...shared, files: { [CORNER_LIB_PATH]: FROZEN_TYPICAL_MODELS },
    },
  ];
}

/** First value of a name in an op rawfile, or null. */
function opValue(parsed, name) {
  const j = parsed.variables.findIndex((v) => v.name.toLowerCase() === name.toLowerCase());
  if (j < 0 || parsed.points.length === 0) return null;
  const v = Number(String(parsed.points[0][j]).split(',')[0]);
  return Number.isFinite(v) ? v : null;
}

// --------------------------------------------------------------------------
// Cross-case checks. These need more than one run, so they cannot live in a
// case's own invariant list. The two are deliberately independent: one is about
// the DEFAULT not moving, the other about the CORNERS moving. A mutant that
// makes the selector inert must break the second and leave the first alone, and
// that is exactly what scripts/numeric-crosscheck.negctl.mjs asserts.
// --------------------------------------------------------------------------
const CORNER_CROSS = [
  {
    name: 'corner_default_matches_frozen',
    what: 'the library with no selector reproduces the pre-corner device set',
    needs: ['corner_default', 'corner_frozen'],
    check(byName) {
      const a = byName.get('corner_frozen');
      const b = byName.get('corner_default');
      let worst = 0;
      let where = 'none';
      let compared = 0;
      for (const v of a.variables) {
        const x = opValue(a, v.name);
        const y = opValue(b, v.name);
        if (x === null || y === null || x === 0) continue;
        compared += 1;
        const rel = Math.abs(y - x) / Math.abs(x);
        if (rel > worst) { worst = rel; where = v.name + ' pre-corner=' + expo(x) + ' shipped=' + expo(y); }
      }
      const pass = compared > 0 && worst <= 1e-12;
      return [{
        kind: 'cross', var: 'worst relative difference over ' + compared + ' variables',
        actual: worst, expected: 0, relError: worst,
        detail: 'at ' + where + '; the spread parameters reach the solver through the expression evaluator, ' +
          'which is worth about 2e-13 -- the tolerance is 1e-12, five times that, and twelve orders below the ' +
          'smallest corner shift',
        pass,
      }];
    },
  },
  {
    name: 'corner_shifts_every_device',
    what: 'ss is slower and ff is faster for every device, with the typical corner between them',
    needs: ['corner_default', 'corner_ss', 'corner_ff'],
    check(byName) {
      const d = byName.get('corner_default');
      const s = byName.get('corner_ss');
      const f = byName.get('corner_ff');
      const items = [];
      for (let i = 0; i < CORNER_SENSE.length; i++) {
        const n = CORNER_SENSE[i];
        const x = opValue(d, n), y = opValue(s, n), z = opValue(f, n);
        if (x === null || y === null || z === null) {
          items.push({ kind: 'cross', var: n, detail: 'not a finite value in all three runs', pass: false });
          continue;
        }
        const A = Math.abs(x), B = Math.abs(y), C = Math.abs(z);
        const ordered = B < A && A < C;
        const shift = A === 0 ? 0 : Math.abs(B - A) / A;
        // The shift floor is what stops this from passing on numerical noise:
        // three identical answers trivially satisfy a "<=" but not a "<", and a
        // corner that moved a device by 1e-15 would be no corner at all.
        const material = shift >= 1e-3;
        items.push({
          kind: 'cross', var: n + ' (' + CORNER_DEVICES[i] + ')',
          actual: B, expected: null, relError: shift,
          detail: '|I| ff=' + expo(C) + '  tt=' + expo(A) + '  ss=' + expo(B) +
            '  ss shift=' + expo(shift) + (material ? '' : ' (below the 1e-3 floor)'),
          pass: ordered && material,
        });
      }
      return items;
    },
  },
];

// cases: deck + channel-2 oracle. No ngspice on this side.
// --------------------------------------------------------------------------
const CASES = [
  {
    name: 'dc_divider',
    what: 'linear resistive divider',
    rtol: 1e-9,
    deck: [
      '* resistive divider',
      'V1 in 0 5',
      'R1 in mid 1k',
      'R2 mid 0 2k',
      '.op',
      '.end',
    ].join('\n') + '\n',
    checks: [{ v: 'v(mid)', expect: () => (5 * 2e3) / (1e3 + 2e3) }],
  },
  {
    name: 'dc_two_node_sweep',
    what: 'two-node resistive network, swept source (own MNA solver)',
    rtol: 1e-9,
    deck: [
      '* two-node resistive network, swept source',
      'V1 in 0 1',
      'R1 in na 1k',
      'R2 na 0 2k',
      'R3 na nb 3k',
      'R4 nb 0 4k',
      '.dc V1 1 5 1',
      '.end',
    ].join('\n') + '\n',
    invariants: [
      (X) => {
        const vs = X.col('v(v-sweep)'), va = X.col('v(na)'), vb = X.col('v(nb)');
        const G1 = 1 / 1e3, G2 = 1 / 2e3, G3 = 1 / 3e3, G4 = 1 / 4e3;
        let worst = 0, at = null, sample = null;
        for (let i = 0; i < vs.length; i++) {
          const [ea, eb] = solveLinear(
            [[G1 + G2 + G3, -G3], [-G3, G3 + G4]],
            [vs[i] * G1, 0],
          );
          const r = Math.max(
            Math.abs(va[i] - ea) / Math.abs(ea),
            Math.abs(vb[i] - eb) / Math.abs(eb),
          );
          if (r > worst) { worst = r; at = vs[i]; sample = { a: va[i], ea, b: vb[i], eb }; }
        }
        return {
          label: 'V(na),V(nb) vs own MNA (per sweep point)',
          actual: sample.a, expected: sample.ea, relError: worst,
          ok: worst <= 1e-9,
          detail: `worst @Vin=${Number(at).toPrecision(4)}  V(nb): got ${sample.b.toPrecision(9)} want ${sample.eb.toPrecision(9)}`,
        };
      },
    ],
  },
  {
    name: 'rc_ac',
    what: 'RC low-pass magnitude (frequency domain)',
    rtol: 1e-6,
    deck: [
      '* rc lowpass',
      'V1 in 0 dc 0 ac 1',
      'R1 in out 1k',
      'C1 out 0 1u',
      '.ac dec 10 1 10k',
      '.end',
    ].join('\n') + '\n',
    pick: { axis: 'frequency', target: 100, magnitude: true },
    checks: [{ v: 'v(out)', expect: (f) => 1 / Math.sqrt(1 + (2 * Math.PI * f * 1e3 * 1e-6) ** 2) }],
  },
  {
    name: 'rc_tran',
    what: 'RC charge curve (time domain)',
    rtol: 3e-3,
    deck: [
      '* rc charge',
      'V1 in 0 pulse(0 1 0 1n 1n 100 200)',
      'R1 in out 1k',
      'C1 out 0 1u',
      '.tran 0.5m 5m',
      '.end',
    ].join('\n') + '\n',
    pick: { axis: 'time', target: 2e-3 },
    checks: [{ v: 'v(out)', expect: (t) => 1 - Math.exp(-t / (1e3 * 1e-6)) }],
  },
  {
    name: 'rc_discharge',
    what: 'RC discharge branch after a 1 ms pulse ends',
    rtol: 3e-3,
    deck: [
      '* rc charge then discharge',
      'V1 in 0 pulse(0 1 0 1n 1n 1m 10)',
      'R1 in out 1k',
      'C1 out 0 1u',
      '.tran 0.05m 4m',
      '.end',
    ].join('\n') + '\n',
    // expect() receives the ACTUAL time of the sampled point, so the exact
    // solution can be evaluated there regardless of ngspice's timestep choice.
    pick: { axis: 'time', target: 2e-3 },
    checks: [{
      v: 'v(out)',
      expect: (t) => {
        const tau = 1e3 * 1e-6, tw = 1e-3;
        return (1 - Math.exp(-tw / tau)) * Math.exp(-(t - tw) / tau);
      },
    }],
  },
  {
    name: 'mos_sat',
    what: 'MOSFET level=1 in saturation (nonlinear device)',
    rtol: 1e-6,
    deck: [
      '* nmos common source (saturation)',
      MOS_DECK,
      '.op',
      '.end',
    ].join('\n') + '\n',
    checks: [{
      v: 'v(d)',
      // Vd = Vdd - Rd*Id(Vd), Id from the closed form above.
      expect: () => bisect(
        (vd) => (1.8 - 5e3 * mosSatCurrent(0.9, vd)) - vd, 0, 1.8,
      ),
    }],
  },
  {
    name: 'mos_triode',
    what: 'MOSFET level=1 in the linear (triode) region',
    rtol: 1e-6,
    deck: [
      '* nmos common source (linear region)',
      'VDD vdd 0 1.8',
      'VG g 0 0.9',
      'RD vdd d 20k',
      'M1 d g 0 0 n1 W=10u L=1u',
      '.model n1 nmos level=1 vto=0.5 kp=200u gamma=0.4 phi=0.7 lambda=0.05',
      '.op',
      '.end',
    ].join('\n') + '\n',
    checks: [{
      v: 'v(d)',
      // In triode Id rises with Vd, so Vd = Vdd - Rd*Id(Vd) has the bracket
      // [0, Vov]; the load line and the channel cross exactly once there.
      expect: () => bisect(
        (vd) => (1.8 - 20e3 * mosTriodeCurrent(0.9, vd)) - vd, 0, 0.9 - MOS_L1.vto,
      ),
    }],
  },
  {
    name: 'diode_res',
    what: 'junction diode biased through a resistor (Shockley, own solver)',
    rtol: 1e-4,
    deck: [
      '* diode with series resistor',
      'V1 in 0 0.6',
      'R1 in out 1k',
      'D1 out 0 d1',
      '.model d1 d is=1e-14 n=1',
      '.op',
      '.end',
    ].join('\n') + '\n',
    checks: [{
      v: 'v(out)',
      // (Vin - Vd)/R = Is*(exp(Vd/(n*Vt)) - 1), solved by bisection. The
      // tolerance is looser than the linear cases because the exponential
      // amplifies any difference in the thermal voltage: dVd/dVt ~ ln(I/Is).
      expect: () => bisect((vd) => (0.6 - vd) / 1e3 - diodeCurrent(vd), 0, 0.95),
    }],
  },
  {
    name: 'mos_sweep_l1',
    what: 'level=1 transfer sweep: invariant layer',
    rtol: 0,
    deck: [
      '* nmos transfer sweep, level=1',
      'VDD vdd 0 1.8',
      'VG g 0 0',
      'RD vdd d 5k',
      'M1 d g 0 0 n1 W=10u L=1u',
      '.model n1 nmos level=1 vto=0.5 kp=200u gamma=0.4 phi=0.7 lambda=0.05',
      '.dc VG 0 1.8 0.2',
      '.end',
    ].join('\n') + '\n',
    invariants: mosSweepInvariants({ vdd: 1.8, rd: 5e3, offUpTo: 0.2 }),
  },
  {
    name: 'bsim3_sweep',
    what: 'BSIM3 (level=8) transfer sweep: invariant layer',
    rtol: 0,
    deck: [
      '* nmos transfer sweep, bsim3',
      'VDD vdd 0 1.8',
      'VG g 0 0',
      'RD vdd d 5k',
      'M1 d g 0 0 n1 W=10u L=1u',
      '.model n1 nmos level=8 vth0=0.5 u0=600 tox=9n',
      '.dc VG 0 1.8 0.2',
      '.end',
    ].join('\n') + '\n',
    invariants: mosSweepInvariants({ vdd: 1.8, rd: 5e3, offUpTo: 0.2 }),
  },
  {
    name: 'bsim4_sweep',
    what: 'BSIM4 (level=14) transfer sweep: invariant layer',
    rtol: 0,
    deck: [
      '* nmos transfer sweep, bsim4',
      'VDD vdd 0 1.8',
      'VG g 0 0',
      'RD vdd d 5k',
      'M1 d g 0 0 n1 W=10u L=1u',
      '.model n1 nmos level=14 vth0=0.5 u0=600 toxe=9n',
      '.dc VG 0 1.8 0.2',
      '.end',
    ].join('\n') + '\n',
    invariants: mosSweepInvariants({ vdd: 1.8, rd: 5e3, offUpTo: 0.2 }),
  },
  {
    name: 'diode_exp_slope',
    what: 'diode exponential law: d(ln I)/dV must equal 1/(n*Vt)',
    rtol: 1e-3,
    deck: [
      '* diode exponential law',
      'V1 in 0 0.5',
      'D1 in 0 d1',
      '.model d1 d is=1e-14 n=1',
      '.dc V1 0.5 0.8 0.05',
      '.end',
    ].join('\n') + '\n',
    invariants: [
      (X) => {
        const v = X.col('v(in)'), i = X.col('i(v1)').map(Math.abs);
        // least-squares slope of ln(I) vs V over the points where I >> Is, so
        // the "-1" in Shockley's law is negligible and ln(I) ~ V/(n*Vt).
        const pts = [];
        for (let k = 0; k < v.length; k++) if (i[k] > 1e-8) pts.push([v[k], Math.log(i[k])]);
        const n = pts.length;
        const sx = pts.reduce((s, p) => s + p[0], 0);
        const sy = pts.reduce((s, p) => s + p[1], 0);
        const sxx = pts.reduce((s, p) => s + p[0] * p[0], 0);
        const sxy = pts.reduce((s, p) => s + p[0] * p[1], 0);
        const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
        const expected = 1 / VTHERM;
        const rel = Math.abs(slope - expected) / expected;
        return {
          label: 'slope of ln|I(v1)| vs V',
          actual: slope, expected, relError: rel, ok: rel <= 1e-3,
          detail: `${n} points fitted; 1/Vt = ${expected.toFixed(4)} per volt`,
        };
      },
    ],
  },
  ...cornerCases(),
];

// --------------------------------------------------------------------------
// child mode: run exactly one deck and print the parsed rawfile as JSON.
// --------------------------------------------------------------------------
function parseRaw(text) {
  const lines = text.split(/\r?\n/);
  let plotname = null;
  for (const l of lines) {
    const m = l.match(/^Plotname:\s*(.*)$/);
    if (m) plotname = m[1].trim();
  }
  const vi = lines.findIndex((l) => /^Variables:/.test(l));
  const si = lines.findIndex((l) => /^Values:/.test(l));
  const variables = [];
  for (let i = vi + 1; i >= 0 && i < si; i++) {
    const m = lines[i].match(/^\s*(\d+)\s+(\S+)/);
    if (m) variables.push({ index: Number(m[1]), name: m[2] });
  }
  const points = [];
  let cur = null;
  if (si >= 0) {
    for (let i = si + 1; i < lines.length; i++) {
      const raw = lines[i];
      const m = raw.match(/^\s*(\d+)\t(.*)$/);
      if (m) {
        if (cur) points.push(cur);
        cur = [m[2]];
      } else {
        const v = raw.replace(/^\s+/, '').trim();
        if (v !== '' && cur) cur.push(v);
      }
    }
    if (cur) points.push(cur);
  }
  return { plotname, variables, points };
}

async function runOne(index) {
  const c = CASES[index];
  const dir = mkdtempSync(join(tmpdir(), 'ngspice-deck-'));
  const modulePath = join(dir, 'ngspice.mjs');
  copyFileSync(VENDOR, modulePath); // .mjs forces ESM regardless of package type
  const { default: createNgspiceModule } = await import(pathToFileURL(modulePath).href);
  const mod = await createNgspiceModule({ print: () => {}, printErr: () => {} });

  const mkdirp = (p) => {
    let acc = '';
    for (const seg of p.split('/').filter(Boolean)) {
      acc += '/' + seg;
      try { mod.FS.mkdir(acc); } catch {}
    }
  };
  mkdirp('/proc/self');
  mkdirp('/usr/local/share/ngspice/scripts');
  mkdirp('/models');
  // Missing /proc/meminfo makes ngspice abort with a misleading memory error.
  mod.FS.writeFile('/proc/meminfo',
    'MemTotal:       16777216 kB\nMemFree:        8388608 kB\nMemAvailable:   8388608 kB\n');
  mod.FS.writeFile('/proc/self/statm', '0 0 0 0 0 0 0\n');
  mod.FS.writeFile('/usr/local/share/ngspice/scripts/spinit',
    'set filetype=ascii\nset ngbehavior=lt\n');
  // Extra files the case needs inside the virtual FS. The corner cases put the
  // artifact's own model library at the path the executor's constant resolves
  // to, so the deck text is the deck the application would assemble.
  for (const [p, text] of Object.entries(c.files ?? {})) {
    mkdirp(p.slice(0, p.lastIndexOf('/')));
    mod.FS.writeFile(p, text);
  }
  mod.FS.writeFile('/circuit.cir', c.deck.trim());
  try { mod.FS.unlink('/out.raw'); } catch {}
  mod.noExitRuntime = true;

  const argvOf = (list) => {
    const ptrs = list.map((s) => mod.stringToUTF8OnStack(s));
    const argv = mod.stackAlloc((list.length + 1) * 4);
    for (let i = 0; i < ptrs.length; i++) mod.HEAP32[(argv >> 2) + i] = ptrs[i];
    mod.HEAP32[(argv >> 2) + ptrs.length] = 0;
    return { argc: list.length, argv };
  };
  try {
    const { argc, argv } = argvOf(['ngspice', '-b', '-r', '/out.raw', '/circuit.cir']);
    mod._main(argc, argv); // Emscripten signals exit by throwing; ignore either way
  } catch { /* exit(code) */ }

  let raw = null;
  try { raw = mod.FS.readFile('/out.raw', { encoding: 'utf8' }); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
  return raw ? parseRaw(raw) : { plotname: null, variables: [], points: [] };
}

const RUN_ARG = process.argv.slice(2).find((a) => a.startsWith('--run='));
if (RUN_ARG) {
  const idx = Number(RUN_ARG.slice('--run='.length));
  runOne(idx).then((r) => {
    process.stdout.write(JSON.stringify(r));
    process.exit(0);
  }).catch((e) => {
    process.stdout.write(JSON.stringify({ error: String((e && e.message) || e) }));
    process.exit(0);
  });
} else {
  await main();
}

// --------------------------------------------------------------------------
// parent mode
// --------------------------------------------------------------------------
// Declared as hoisted function declarations: main() runs from the top-level
// dispatch below, which is evaluated before these lines are reached.
function fmt(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v.toPrecision(10) : String(v);
}
function expo(v) {
  return (typeof v === 'number' && Number.isFinite(v)) ? v.toExponential(2) : String(v);
}

/** Column accessors + point selection handed to the invariant predicates. */
function makeCtx(parsed) {
  const index = (name) => parsed.variables.findIndex((v) => v.name.toLowerCase() === name.toLowerCase());
  const cell = (p, name) => parsed.points[p][index(name)];
  const col = (name) => {
    const i = index(name);
    if (i < 0) return null;
    return parsed.points.map((p) => Number(String(p[i]).split(',')[0]));
  };
  return {
    parsed, index, cell, col,
    nearest(axis, target) {
      const ai = index(axis);
      let best = Infinity, point = 0, val = null;
      for (let p = 0; p < parsed.points.length; p++) {
        const v = Number(String(parsed.points[p][ai]).split(',')[0]);
        const d = Math.abs(v - target);
        if (d < best) { best = d; point = p; val = v; }
      }
      return { point, val };
    },
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const has = (n) => argv.includes('--' + n);
  if (has('help') || has('h')) {
    console.log('usage: node scripts/numeric-crosscheck.mjs [--json] [--verbose] [--only=<name,...>]');
    process.exit(0);
  }
  if (!existsSync(VENDOR)) {
    console.error('numeric-crosscheck: missing ' + VENDOR);
    process.exit(2);
  }
  const SELF = fileURLToPath(import.meta.url);

  // --only: restrict the run to a named subset. An unknown name is a setup
  // error rather than a silent skip -- a filter that quietly matches nothing
  // would report PASS on zero assertions, which is the exact failure mode this
  // whole script exists to avoid.
  const onlyArg = argv.find((a) => a.startsWith('--only='));
  let indices = CASES.map((_, i) => i);
  if (onlyArg) {
    const want = onlyArg.slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean);
    const known = new Set(CASES.map((c) => c.name));
    const unknown = want.filter((n) => !known.has(n));
    if (unknown.length) {
      console.error('numeric-crosscheck: unknown case name(s): ' + unknown.join(', '));
      process.exit(2);
    }
    indices = CASES.map((c, i) => [c, i]).filter(([c]) => want.includes(c.name)).map(([, i]) => i);
    if (indices.length === 0) {
      console.error('numeric-crosscheck: --only matched no cases');
      process.exit(2);
    }
  }

  const rows = [];
  const parsedByCase = new Map();
  let failures = 0, assertions = 0;
  for (const i of indices) {
    const c = CASES[i];
    let parsed;
    try {
      const out = execFileSync(process.execPath, [SELF, '--run=' + i], { encoding: 'utf8', maxBuffer: 1 << 26 });
      parsed = JSON.parse(out);
    } catch (e) {
      rows.push({ case: c.name, status: 'RUN-ERROR', detail: String((e && e.message) || e) });
      failures++;
      continue;
    }
    if (parsed.error || !parsed.points || parsed.points.length === 0) {
      rows.push({ case: c.name, status: 'NO-RESULT', detail: parsed.error || 'empty rawfile' });
      failures++;
      continue;
    }
    const X = makeCtx(parsed);
    parsedByCase.set(c.name, parsed);

    // pick the output point to compare against (per-check closed-form cases)
    let point = 0, axisVal = null;
    if (c.pick) {
      const got = X.nearest(c.pick.axis, c.pick.target);
      point = got.point; axisVal = got.val;
    }

    const items = [];
    let ok = true;
    for (const chk of c.checks || []) {
      const vi = X.index(chk.v);
      const cell = parsed.points[point][vi];
      const actual = c.pick && c.pick.magnitude
        ? Math.hypot(...cell.split(',').map(Number))
        : Number(cell.split(',')[0]);
      const expected = chk.expect(axisVal);
      const rel = Math.abs(actual - expected) / (Math.abs(expected) || 1);
      const pass = rel <= c.rtol;
      if (!pass) ok = false;
      items.push({ kind: 'closed-form', var: chk.v, actual, expected, relError: rel, pass });
    }
    for (const inv of c.invariants || []) {
      let r;
      try {
        r = inv(X);
      } catch (e) {
        r = { label: 'invariant', ok: false, detail: 'threw: ' + String((e && e.message) || e) };
      }
      if (!r.ok) ok = false;
      items.push({
        kind: 'invariant', var: r.label, actual: r.actual, expected: r.expected,
        relError: r.relError, detail: r.detail, pass: r.ok,
      });
    }
    assertions += items.length;
    if (!ok) failures++;
    rows.push({
      case: c.name, what: c.what, status: ok ? 'PASS' : 'FAIL', rtol: c.rtol,
      plot: parsed.plotname, axis: axisVal, items,
    });
  }

  // Cross-case checks, run only when every case they need produced a rawfile.
  // Under --only a missing input is reported as SKIP rather than PASS: a
  // focused run is a debugging tool, and a skipped check that printed "ok"
  // would be the hollow green this whole script exists to avoid.
  for (const x of CORNER_CROSS) {
    const absent = x.needs.filter((n) => !parsedByCase.has(n));
    if (absent.length > 0) {
      rows.push({
        case: x.name, what: x.what, status: 'SKIP',
        detail: 'needs ' + absent.join(', ') + ', which this run did not execute',
      });
      continue;
    }
    const items = x.check(parsedByCase);
    const ok = items.every((it) => it.pass);
    if (!ok) failures++;
    assertions += items.length;
    rows.push({ case: x.name, what: x.what, status: ok ? 'PASS' : 'FAIL', items });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    engine: 'site/vendor/ngspice.js',
    cases: rows,
    assertions,
    failures,
  };
  const outJson = join(REPO_ROOT, 'numeric-crosscheck-result.json');
  try { writeFileSync(outJson, JSON.stringify(report, null, 2)); } catch {}

  if (has('json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('numeric-crosscheck: shipped ngspice vs first-principles recomputation');
    console.log('='.repeat(84));
    for (const r of rows) {
      if (!r.items) { console.log(`[${r.status}] ${r.case}  ${r.detail || ''}`); continue; }
      const axis = r.axis != null ? `  axis=${Number(r.axis).toPrecision(6)}` : '';
      console.log(`[${r.status}] ${r.case}  (${r.what}${axis})`);
      if (has('verbose') || r.status === 'FAIL') {
        for (const it of r.items) {
          const head = `      [${it.kind === 'invariant' ? 'inv' : 'cf '}] ${it.var}`;
          const nums = (it.actual != null && it.expected != null)
            ? `  ngspice=${fmt(it.actual)}  oracle=${fmt(it.expected)}  rel=${expo(it.relError)}`
            : '';
          const det = it.detail ? `  (${it.detail})` : '';
          console.log(`${head}${nums}${det}  ${it.pass ? 'ok' : 'DRIFTED'}`);
        }
      }
    }
    console.log('='.repeat(84));
    console.log(`cases=${rows.length} assertions=${assertions} failures=${failures}`);
  }

  if (failures) {
    console.log('numeric-crosscheck: FAIL  (report in numeric-crosscheck-result.json)');
    process.exit(1);
  }
  console.log('numeric-crosscheck: PASS');
  process.exit(0);
}
