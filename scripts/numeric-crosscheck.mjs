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
 * This script closes it by running a small set of circuits through the shipped
 * engine and comparing every result against an expectation recomputed from
 * first principles, WITHOUT calling ngspice. The two sides share no code:
 *
 *   channel 1  the artifact under test: site/vendor/ngspice.js, driven in a
 *              Node host (the same WASM the browser loads)
 *   channel 2  closed-form physics:
 *                resistive divider -> V = Vin*R2/(R1+R2)
 *                RC low-pass AC    -> |H| = 1/sqrt(1+(2*pi*f*R*C)^2)
 *                RC charge         -> V = 1-exp(-t/RC)
 *                MOS level=1 sat   -> (Vdd-Rd*A)/(1+Rd*A*lambda), A=(kp/2)(W/L)Vov^2
 *
 * Agreement is therefore evidence, not a tautology. Because the expectation is
 * computed rather than frozen, the check keeps meaning after an upstream
 * rebuild: a new engine that changes a model silently will drift off the
 * closed-form value and fail.
 *
 * Usage
 *   node scripts/numeric-crosscheck.mjs [--json] [--verbose]
 *
 *   --json      Print the machine-readable report to stdout instead of the table.
 *   --verbose   Also print per-case raw values.
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
import { existsSync, mkdtempSync, writeFileSync, readFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const VENDOR = join(REPO_ROOT, 'site', 'vendor', 'ngspice.js');

// --------------------------------------------------------------------------
// cases: deck + closed-form expectation (channel 2). No ngspice on this side.
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
    name: 'mos_sat',
    what: 'MOSFET level=1 in saturation (nonlinear device)',
    rtol: 1e-6,
    deck: [
      '* nmos common source (saturation)',
      'VDD vdd 0 1.8',
      'VG g 0 0.9',
      'RD vdd d 5k',
      'M1 d g 0 0 n1 W=10u L=1u',
      '.model n1 nmos level=1 vto=0.5 kp=200u gamma=0.4 phi=0.7 lambda=0.05',
      '.op',
      '.end',
    ].join('\n') + '\n',
    checks: [{
      v: 'v(d)',
      expect: () => {
        const A = (200e-6 / 2) * 10 * (0.9 - 0.5) ** 2; // (kp/2)(W/L)Vov^2
        return (1.8 - 5e3 * A) / (1 + 5e3 * A * 0.05);
      },
    }],
  },
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
async function main() {
  const argv = process.argv.slice(2);
  const has = (n) => argv.includes('--' + n);
  if (has('help') || has('h')) {
    console.log('usage: node scripts/numeric-crosscheck.mjs [--json] [--verbose]');
    process.exit(0);
  }
  if (!existsSync(VENDOR)) {
    console.error('numeric-crosscheck: missing ' + VENDOR);
    process.exit(2);
  }
  const SELF = fileURLToPath(import.meta.url);
  const idxOf = (r, name) => r.variables.findIndex((v) => v.name.toLowerCase() === name.toLowerCase());

  const rows = [];
  let failures = 0;
  for (let i = 0; i < CASES.length; i++) {
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
    // pick the output point to compare against
    let point = 0, axisVal = null;
    if (c.pick) {
      const ai = idxOf(parsed, c.pick.axis);
      let best = Infinity;
      for (let p = 0; p < parsed.points.length; p++) {
        const val = Number(parsed.points[p][ai].split(',')[0]);
        const d = Math.abs(val - c.pick.target);
        if (d < best) { best = d; point = p; axisVal = val; }
      }
    }
    const items = [];
    let ok = true;
    for (const chk of c.checks) {
      const vi = idxOf(parsed, chk.v);
      const cell = parsed.points[point][vi];
      const actual = c.pick && c.pick.magnitude
        ? Math.hypot(...cell.split(',').map(Number))
        : Number(cell.split(',')[0]);
      const expected = chk.expect(axisVal);
      const rel = Math.abs(actual - expected) / (Math.abs(expected) || 1);
      const pass = rel <= c.rtol;
      if (!pass) ok = false;
      items.push({ var: chk.v, actual, expected, relError: rel, pass });
    }
    if (!ok) failures++;
    rows.push({
      case: c.name, what: c.what, status: ok ? 'PASS' : 'FAIL', rtol: c.rtol,
      plot: parsed.plotname, axis: axisVal, items,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    engine: 'site/vendor/ngspice.js',
    cases: rows,
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
      const axis = r.axis != null ? `  axis=${r.axis}` : '';
      console.log(`[${r.status}] ${r.case}  (${r.what}${axis})  rtol=${r.rtol}`);
      if (has('verbose') || r.status === 'FAIL') {
        for (const it of r.items) {
          console.log(`      ${it.var.padEnd(8)} ngspice=${it.actual.toPrecision(10)}  closed-form=${it.expected.toPrecision(10)}  rel=${it.relError.toExponential(2)}  ${it.pass ? 'ok' : 'DRIFTED'}`);
        }
      }
    }
    console.log('='.repeat(84));
    console.log(`cases=${rows.length} failures=${failures}`);
  }

  if (failures) {
    console.log('numeric-crosscheck: FAIL  (report in numeric-crosscheck-result.json)');
    process.exit(1);
  }
  console.log('numeric-crosscheck: PASS');
  process.exit(0);
}
