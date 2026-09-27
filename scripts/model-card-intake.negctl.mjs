#!/usr/bin/env node
/**
 * Negative control ("mutation test") for scripts/model-card-intake.mjs.
 *
 * Why this exists
 * ---------------
 * The project rule for this repo is that every new check must be shown to fail
 * when the thing it guards is broken -- a guard that only ever prints PASS
 * proves nothing. This script automates that for the intake channel so the
 * property is reproducible instead of an anecdote in a commit message.
 *
 * It writes four mutants and requires ALL of them to go red, each for its own
 * reason:
 *
 *   card_control_vto     edits the CONTROL card's VTO (0.5 -> 0.65) while the
 *                        contract keeps 0.5. The recovery must notice that the
 *                        card no longer says what it said. This is the mutant
 *                        that proves the channel reads the card at all, rather
 *                        than reporting a number it computed some other way.
 *
 *   card_bsim3_k1_on     puts K1 back into the reduced BSIM3 card. K1 is the
 *                        bulk-charge term, worth about -21 % on the recovered
 *                        transconductance -- the largest single effect in the
 *                        reduction. If the BSIM3 case survives this, it is not
 *                        testing the model, only that a file exists.
 *
 *   card_param_name_repaired
 *                        corrects the misspelling (pdibl1 -> pdiblc1), so the
 *                        card now loads and means exactly what it says. A card
 *                        that loads must not be reported as refused; if the
 *                        refusal assertion survives this, it was vacuous.
 *
 *   expect_library_tt    edits the CONTRACT so the slow-corner case declares the
 *                        typical corner's VTO (0.58 -> 0.5). This is the mutant
 *                        that proves the three library cases observe the
 *                        selector: a channel that recovered whatever the
 *                        selector happened to give it, without comparing against
 *                        the declared per-corner value, would pass this mutant.
 *
 * Mutating the CONTRACT rather than the driver is deliberate for the last one:
 * the contract is the expectation table, so an expectation that no longer
 * matches the artifact is exactly the class of drift the channel exists to
 * catch, and it must be caught by data, not by code.
 *
 * Layout. Each mutant is a copy of the driver with its path constants rewritten
 * to the real repo (for the engine and the site) and to a temp suite (for the
 * mutated contract, the mutated fixtures and the result file), so the real
 * driver, contract, fixtures and result file are never touched. String anchors
 * are asserted by COUNT: String.replace() is not global, so a single-occurrence
 * miss would otherwise look like a surviving mutant / guard blind spot.
 *
 * Exit codes
 *   0  every mutant was caught (the channel is not vacuous)
 *   1  a mutant survived, or an anchor no longer matches
 *   2  setup error (driver or contract missing)
 *
 * --static-only
 *   Validate the mutant harness itself (anchors, fixture/contract rewrites) and
 *   stop before running anything. This exists because every engine run costs a
 *   WASM instantiation, and because the harness must be checkable on a machine
 *   that cannot run the engine.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SRC = join(HERE, 'model-card-intake.mjs');
const CONTRACT = join(HERE, 'model-card-intake.json');
const FIXTURES = join(HERE, 'model-card-fixtures');
const STATIC_ONLY = process.argv.includes('--static-only');

if (!existsSync(SRC) || !existsSync(CONTRACT)) {
  console.error('model-card-intake negative-control: driver or contract missing');
  process.exit(2);
}

const MUTATIONS = [
  {
    id: 'card_control_vto',
    what: 'fixture: the control card declares VTO=0.65 while the contract still expects 0.5',
    fixture: { file: 'level1-control.card', from: 'vto=0.5 kp=200u', to: 'vto=0.65 kp=200u', count: 1 },
    expectCases: ['control_level1'],
  },
  {
    id: 'card_bsim3_k1_on',
    what: 'fixture: K1 returns to the reduced BSIM3 card, re-introducing the bulk-charge factor (~-21 % on the recovered transconductance)',
    fixture: { file: 'bsim3-longchannel.card', from: 'k1=0 k2=0', to: 'k1=0.6 k2=0', count: 1 },
    expectCases: ['bsim3_longchannel'],
  },
  {
    id: 'card_param_name_repaired',
    what: 'fixture: the misspelling is corrected (pdibl1 -> pdiblc1), so the card now loads and means what it says, and the refusal assertion must fail',
    fixture: { file: 'reject-param-name.card', from: 'pdibl1=0', to: 'pdiblc1=0', count: 1 },
    expectCases: ['reject_param_name'],
  },
  {
    id: 'expect_library_tt',
    what: 'contract: the slow-corner case is told to expect the TYPICAL corner VTO (0.58 -> 0.5), so a channel that ignores the selector must go red',
    contract: { from: '"vto": 0.58, "kp": 1.7e-4', to: '"vto": 0.5, "kp": 1.7e-4', count: 1 },
    expectCases: ['shipped_library_ss'],
  },
];

const contractText = readFileSync(CONTRACT, 'utf8');
const suite = mkdtempSync(join(tmpdir(), 'intake-negctl-'));
let allGood = true;

/** Rewrite a mutant driver's path constants: real repo for the engine, temp for its inputs. */
function rehome(text, extra) {
  let out = text
    .replace("resolve(HERE, '..')", JSON.stringify(REPO_ROOT))
    .replace("'scripts/model-card-intake.json'", JSON.stringify(extra.contractPath))
    .replace("join(HERE, 'model-card-fixtures')", JSON.stringify(extra.fixturesPath))
    .replace("join(REPO_ROOT, 'model-card-intake-result.json')", JSON.stringify(extra.resultPath));
  return out;
}

try {
  for (const m of MUTATIONS) {
    // ---- build the mutant's inputs -------------------------------------
    const dir = join(suite, m.id);
    mkdirSync(dir, { recursive: true });

    let contractHere = contractText;
    if (m.contract) {
      const hits = contractHere.split(m.contract.from).length - 1;
      if (hits !== m.contract.count) {
        console.log(`[SETUP-ERROR] ${m.id}: expected ${m.contract.count} occurrence(s) of ${JSON.stringify(m.contract.from)} in the contract, found ${hits}`);
        allGood = false;
        continue;
      }
      contractHere = contractHere.split(m.contract.from).join(m.contract.to);
    }
    const contractPath = join(dir, 'contract.json');
    writeFileSync(contractPath, contractHere, 'utf8');

    // Copy every fixture, applying this mutant's edit to the one it names.
    const fixturesPath = join(dir, 'fixtures');
    mkdirSync(fixturesPath, { recursive: true });
    for (const f of readdirFixtures()) {
      let text = readFileSync(join(FIXTURES, f), 'utf8');
      if (m.fixture && m.fixture.file === f) {
        if (m.fixture.rewrite !== undefined) {
          text = m.fixture.rewrite;
        } else {
          const hits = text.split(m.fixture.from).length - 1;
          if (hits !== m.fixture.count) {
            console.log(`[SETUP-ERROR] ${m.id}: expected ${m.fixture.count} occurrence(s) of ${JSON.stringify(m.fixture.from)} in ${f}, found ${hits}`);
            allGood = false;
            text = null;
          } else {
            text = text.split(m.fixture.from).join(m.fixture.to);
          }
        }
      }
      if (text !== null) writeFileSync(join(fixturesPath, f), text, 'utf8');
    }

    // ---- build and validate the mutant driver --------------------------
    const driverPath = join(dir, 'mutant.mjs');
    writeFileSync(driverPath, rehome(readFileSync(SRC, 'utf8'), {
      contractPath, fixturesPath, resultPath: join(dir, 'result.json'),
    }), 'utf8');

    try {
      execFileSync(process.execPath, ['--check', driverPath], { stdio: 'pipe' });
    } catch (e) {
      console.log(`[SETUP-ERROR] ${m.id}: the rehomed driver does not parse: ${String(e.stderr || e).slice(0, 300)}`);
      allGood = false;
      continue;
    }

    if (STATIC_ONLY) {
      console.log(`[OK] mutant ${m.id}: harness built and parsed (--static-only, not run)`);
      console.log(`     intent : ${m.what}`);
      continue;
    }

    // ---- run it --------------------------------------------------------
    let out = '', code = 0;
    const only = (m.onlyCases ?? m.expectCases).join(',');
    try {
      out = execFileSync(process.execPath, [driverPath, '--verbose', '--only=' + only],
        { encoding: 'utf8', maxBuffer: 1 << 26 });
    } catch (e) {
      out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
      code = (e && e.status) != null ? e.status : -1;
    }

    const failedCases = [...out.matchAll(/^\[FAIL\] (\S+)/gm)].map((x) => x[1]);
    const passedCases = [...out.matchAll(/^\[PASS\] (\S+)/gm)].map((x) => x[1]);
    const summary = (out.match(/cases=\d+ assertions=\d+ failures=\d+/) || ['<no summary>'])[0];
    const detail = out.split('\n').filter((l) => /^\s+BAD/.test(l)).map((l) => l.trim()).slice(0, 2);
    const caughtAll = m.expectCases.every((c) => failedCases.includes(c));
    const missedPass = (m.expectPass ?? []).filter((c) => !passedCases.includes(c));
    const ok = code === 1 && caughtAll && missedPass.length === 0;
    if (!ok) allGood = false;

    console.log(`[${ok ? 'OK' : 'BAD'}] mutant ${m.id}: exit=${code}  ${summary}`);
    console.log(`       intent : ${m.what}`);
    console.log(`       caught : ${failedCases.length ? failedCases.join(', ') : 'NOTHING'}`);
    if (missedPass.length) console.log(`       expected to stay green, but did not: ${missedPass.join(', ')}`);
    for (const d of detail) console.log(`       red    : ${d}`);
  }
} finally {
  try { rmSync(suite, { recursive: true, force: true }); } catch { /* best effort */ }
}

function readdirFixtures() {
  return execFileSync(process.execPath, ['-e',
    `process.stdout.write(require('node:fs').readdirSync(${JSON.stringify(FIXTURES)}).filter(f=>f.endsWith('.card')).join('\\n'))`],
    { encoding: 'utf8' }).split('\n').filter(Boolean);
}

console.log(allGood
  ? `\nmodel-card-intake negative-control: PASS -- every mutant was caught, the channel is not vacuous${STATIC_ONLY ? ' (static-only: mutants were built and parsed, not run)' : ''}`
  : '\nmodel-card-intake negative-control: FAIL -- a mutant survived or an anchor moved; the channel may have a blind spot');
process.exit(allGood ? 0 : 1);
