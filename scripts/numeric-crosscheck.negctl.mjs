#!/usr/bin/env node
/**
 * Negative control ("mutation test") for scripts/numeric-crosscheck.mjs.
 *
 * Why this exists
 * ---------------
 * A guard that only ever prints PASS proves nothing -- it may be asserting
 * something that is true by construction, or may never reach its assertions at
 * all. The project rule for this repo is that every new check must be shown to
 * fail when the thing it guards is broken. This script automates that for the
 * numeric cross-check so the property is reproducible instead of an anecdote in
 * a commit message: it runs on demand and in CI right after the guard itself.
 *
 * It writes three mutants and requires ALL of them to go red:
 *
 *   cf_oracle  breaks the closed-form expectation     -> dc_divider must fail
 *   inv_limit  feeds the invariant layer a wrong load  -> all three MOS sweeps
 *              resistor                                  must fail
 *   model_n    changes the DECK (diode ideality n=1->2) while the oracle keeps
 *              n=1 -- i.e. simulates a silently changed device model, which is
 *              exactly the upstream-rebuild regression the guard exists for
 *
 * The mutants are copies of the guard with its paths rewritten to the real
 * repo and to a temp directory, so the real guard and its result file are never
 * touched. Each mutant is run with --only=<its target cases>, so the driver
 * stays cheap. String anchors are asserted by count: if a rename ever makes an
 * anchor ambiguous this script fails loudly instead of silently mutating the
 * wrong place (String.replace() is not global, and a single-occurrence miss
 * would otherwise look like a surviving mutant / guard blind spot).
 *
 * Exit codes
 *   0  every mutant was caught (guard is not vacuous)
 *   1  a mutant survived, or an anchor no longer matches the guard source
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SRC = join(HERE, 'numeric-crosscheck.mjs');
const NODE = process.execPath;

const MUTATIONS = [
  {
    id: 'cf_oracle',
    what: 'closed-form channel: wrong divider expectation (3.333 -> 3.0)',
    from: '(5 * 2e3) / (1e3 + 2e3)',
    to: '3.0',
    count: 1,
    expectCases: ['dc_divider'],
  },
  {
    id: 'inv_limit',
    what: 'invariant layer: load-line invariant given the wrong load resistor (5k -> 4k)',
    from: 'mosSweepInvariants({ vdd: 1.8, rd: 5e3, offUpTo: 0.2 })',
    to: 'mosSweepInvariants({ vdd: 1.8, rd: 4e3, offUpTo: 0.2 })',
    count: 3,
    expectCases: ['mos_sweep_l1', 'bsim3_sweep', 'bsim4_sweep'],
  },
  {
    id: 'model_n',
    what: 'engine input: diode ideality n=1 -> n=2 while the oracle keeps n=1',
    from: "'.model d1 d is=1e-14 n=1',",
    to: "'.model d1 d is=1e-14 n=2',",
    count: 2,
    expectCases: ['diode_res', 'diode_exp_slope'],
  },
];

const src = readFileSync(SRC, 'utf8');
const suite = mkdtempSync(join(tmpdir(), 'nc-negctl-'));

/** Rewrite the mutant's paths: real repo for the engine, temp dir for its report. */
function rehome(text, id) {
  return text
    .replace("resolve(HERE, '..')", JSON.stringify(REPO_ROOT))
    .replace("join(REPO_ROOT, 'numeric-crosscheck-result.json')",
      JSON.stringify(join(suite, `result-${id}.json`)));
}

let allGood = true;
try {
  for (const m of MUTATIONS) {
    const hits = src.split(m.from).length - 1; // String.replace() is not global
    if (hits !== m.count) {
      console.log(`[SETUP-ERROR] ${m.id}: expected ${m.count} anchor occurrence(s), found ${hits}`);
      console.log(`              anchor: ${m.from}`);
      allGood = false;
      continue;
    }

    const path = join(suite, `mutant-${m.id}.mjs`);
    writeFileSync(path, rehome(src.replaceAll(m.from, m.to), m.id), 'utf8');

    let out = '', code = 0;
    // --only keeps the driver cheap: each mutant is run against just the cases
    // it is supposed to break, instead of all of them three times over.
    try {
      out = execFileSync(NODE, [path, '--verbose', '--only=' + m.expectCases.join(',')],
        { encoding: 'utf8', maxBuffer: 1 << 26 });
    } catch (e) {
      out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
      code = (e && e.status) != null ? e.status : -1;
    }

    const failedCases = [...out.matchAll(/^\[FAIL\] (\S+)/gm)].map((x) => x[1]);
    const drifted = [...out.matchAll(/^\s+\[(?:cf|inv)\].*DRIFTED\s*$/gm)].map((l) => l[0].trim());
    const summary = (out.match(/cases=\d+ assertions=\d+ failures=\d+/) || ['<no summary>'])[0];
    const caughtAll = m.expectCases.every((c) => failedCases.includes(c));
    const ok = code === 1 && caughtAll;
    if (!ok) allGood = false;

    console.log(`[${ok ? 'OK' : 'BAD'}] mutant ${m.id}: exit=${code}  ${summary}`);
    console.log(`       intent : ${m.what}`);
    console.log(`       caught : ${failedCases.length ? failedCases.join(', ') : 'NOTHING'}`);
    for (const d of drifted) console.log(`       red    : ${d}`);
  }
} finally {
  try { rmSync(suite, { recursive: true, force: true }); } catch {}
}

console.log(allGood
  ? '\nnumeric-crosscheck negative-control: PASS -- every mutant was caught, the guard is not vacuous'
  : '\nnumeric-crosscheck negative-control: FAIL -- a mutant survived or an anchor moved; the guard may have a blind spot');
process.exit(allGood ? 0 : 1);
