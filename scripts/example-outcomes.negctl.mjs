#!/usr/bin/env node
/**
 * Prove the example-outcome check is not vacuous.
 *
 * A check that only ever prints PASS proves nothing. Each case below mutates a
 * throwaway copy of the artifact, runs scripts/example-outcomes.mjs against it,
 * and requires the check to notice -- and to notice for the stated reason, not
 * merely to crash. The control case runs first: if it is not green, every other
 * result in this file is meaningless.
 *
 * Usage
 *   node scripts/example-outcomes.negctl.mjs [options]
 *
 *   --only=<case>   Run one case by name.
 *   --require       Fail (exit 1) if no browser is available. Default: skip (exit 0).
 *
 * Exit codes
 *   0  every case behaved as required
 *   1  a case did not (including the control)
 *   2  usage / setup error (an anchor did not match exactly once)
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SITE = join(REPO_ROOT, 'site');
const OUT_JSON = join(REPO_ROOT, 'example-outcomes-result.json');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const REQUIRE = argv.includes('--require');
const ONLY_CASE = opt('only', null);

const APP = 'assets/App-D0jgYDVz.js';
const SURFACE = 'assets/spice-simulation-surface-Dua32hSB.js';
const FLAGSHIP = 'five-transistor-ota-sky130';
const CONTROL = 'common-source-amplifier';

// Each substitute must appear exactly once, or the case is a setup error rather
// than evidence: a mutation that landed twice, or not at all, would be testing
// something other than what it claims.
const CASES = [
  {
    name: 'control',
    why: 'the unmutated artifact must pass, or nothing below means anything',
    expect: 0,
    examples: [CONTROL, FLAGSHIP],
  },
  {
    name: 'unavailable-label-removed',
    why: 'the profile control stops warning before the run, so the refusal is no longer announced in advance',
    expect: 1,
    examples: [FLAGSHIP],
    edits: [{ file: SURFACE, from: 'children:[z,` (unavailable)`]', to: 'children:[z]' }],
  },
  {
    name: 'flagship-pointed-at-an-advertised-profile',
    why: 'the payload declares the profile the executor does advertise, so the artifact now promises a runnable lab; it must actually run',
    expect: 1,
    examples: [FLAGSHIP],
    // Twelve setups declare it in this payload, which is the point: every one
    // of them has to move, or the mutation only half-happened.
    edits: [{ file: APP, from: 'profileId:`sky130-core-continuous-ngspice46-v1`', to: 'profileId:`edu-cmos-ngspice-wasm-v1`', count: 12 }],
  },
  {
    name: 'model-library-missing',
    why: 'the runnable lab loses the model card its deck includes, so it can no longer complete',
    expect: 1,
    examples: [CONTROL],
    remove: ['models/cmos.lib'],
  },
  {
    name: 'run-control-renamed',
    why: 'the Run control stops being addressable, so the harness must report a red instead of passing quietly',
    // Not exit 2: from the artifact alone, "declares setups but offers no way to
    // run them" is a product-visible defect, and the harness cannot tell it from
    // a selector that went stale. Reporting it as a failure is the honest call.
    expect: 1,
    examples: [CONTROL],
    edits: [{ file: SURFACE, from: 'simulation-primary-button simulation-run-button', to: 'simulation-primary-button simulation-run-button-x' }],
  },
  {
    name: 'catalog-points-at-a-missing-payload',
    why: 'a catalog entry names a project binder that does not exist, so the check cannot derive what to expect and must refuse to report a verdict',
    // Renaming the *id* would have been no test at all: the app reads the same
    // catalog, so both sides move together and the deep link still resolves. A
    // dangling project reference is the shape that actually breaks.
    expect: 2,
    examples: [FLAGSHIP],
    edits: [{ file: APP, from: 'project:rg(ng)}', to: 'project:rg(ngX)}' }],
  },
  {
    name: 'no-lab-in-the-set-can-run',
    why: 'every remaining lab declares a profile the executor does not advertise, so the sweep has no positive control and must not call itself green',
    expect: 1,
    // No --examples filter: the branch-coverage rule is what is under test.
    // Both edits are needed. Deleting the catalog entry alone leaves its payload
    // referenced by nobody, and pointing the only other lab at a binder whose
    // payload is then the last slice keeps the catalog-to-payload map one-to-one
    // so the static channel can still attribute every entry.
    edits: [
      {
        file: APP,
        from: '{id:`five-transistor-ota-sky130`,name:`Five-Transistor OTA (Sky130)`,description:`Full OP/DC/AC/TRAN/Noise lab with PULSE/SIN testbenches and five corners`,requiresUnlock:!0,project:rg(ng)}',
        to: '',
      },
      { file: APP, from: 'project:rg(Qh)}', to: 'project:rg(ng)}' },
    ],
  },
];

if (ONLY_CASE) {
  const keep = CASES.filter((c) => c.name === ONLY_CASE);
  if (!keep.length) {
    console.error('example-outcomes negctl: SETUP ERROR -- no case named ' + ONLY_CASE);
    process.exit(2);
  }
  CASES.length = 0;
  CASES.push(...keep);
}

const CHROME = [
  process.env.CHROME_BIN, process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p));
if (!CHROME) {
  if (REQUIRE) { console.error('example-outcomes negctl: no browser available and --require was set'); process.exit(1); }
  console.log('example-outcomes negctl: SKIP (no browser found; install Chrome/Chromium or pass --require)');
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), 'example-outcomes-negctl-'));
cpSync(SITE, join(scratch, 'site'), { recursive: true });

const applyEdits = (c) => {
  for (const e of c.edits ?? []) {
    const p = join(scratch, 'site', e.file);
    const s = readFileSync(p, 'utf8');
    const want = e.count ?? 1;
    const n = s.split(e.from).length - 1;
    if (n !== want) { console.error('example-outcomes negctl: SETUP ERROR -- anchor for ' + c.name + ' matched ' + n + ' times in ' + e.file + ' (wanted ' + want + '): ' + JSON.stringify(e.from.slice(0, 90))); return false; }
    writeFileSync(p, s.split(e.from).join(e.to));
  }
  for (const rel of c.remove ?? []) {
    const p = join(scratch, 'site', rel);
    if (!existsSync(p)) { console.error('example-outcomes negctl: SETUP ERROR -- ' + c.name + ' wants to remove a file that is not there: ' + rel); return false; }
    unlinkSync(p);
  }
  return true;
};

const restore = (c) => {
  for (const e of c.edits ?? []) cpSync(join(SITE, e.file), join(scratch, 'site', e.file));
  for (const rel of c.remove ?? []) cpSync(join(SITE, rel), join(scratch, 'site', rel));
};

const runCase = (c) => new Promise((done) => {
  if (existsSync(OUT_JSON)) { try { unlinkSync(OUT_JSON); } catch {} }
  const args = [join(HERE, 'example-outcomes.mjs'), '--site=' + join(scratch, 'site'), '--require'];
  if (c.examples?.length) args.push('--examples=' + c.examples.join(','));
  const p = spawn(process.execPath, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  p.stderr.on('data', (d) => { out += d.toString(); });
  p.on('close', (code) => done({ code, out }));
});

let bad = 0;
console.log('example-outcomes negctl: scratch=' + scratch);
for (const c of CASES) {
  if (!applyEdits(c)) { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch {} process.exit(2); }
  const { code, out } = await runCase(c);
  restore(c);
  const reasons = out.split('\n').filter((l) => /FAIL:|SETUP ERROR/.test(l)).map((l) => l.trim()).slice(0, 2);
  const ok = code === c.expect;
  console.log((ok ? 'ok   ' : 'BAD  ') + c.name.padEnd(44) + ' exit=' + code + ' (wanted ' + c.expect + ')  ' + c.why);
  for (const r of reasons) console.log('        ' + r.slice(0, 220));
  if (!ok) bad++;
}
try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch {}

const summary = { cases: CASES.map((c) => c.name), bad };
writeFileSync(join(REPO_ROOT, 'example-outcomes-negctl-result.json'), JSON.stringify(summary, null, 2));

if (bad) {
  console.log('example-outcomes negctl: FAIL (' + bad + ' of ' + CASES.length + ' cases)');
  process.exit(1);
}
console.log('example-outcomes negctl: PASS (' + CASES.length + ' of ' + CASES.length + ' cases)');
process.exit(0);
