#!/usr/bin/env node
/**
 * Prove the offline-simulation test is not vacuous.
 *
 * scripts/offline-sim.mjs asserts that a simulation completes with the network
 * off and the HTTP cache disabled. A test like that is only as good as the
 * mutants it kills: if it passed on a worker that caches nothing, it would be
 * reporting the browser's HTTP cache and calling it the worker's work.
 *
 * So this driver takes a copy of the artifact, re-introduces one defect at a
 * time into site/sw.js, and requires offline-sim to fail each time -- and to
 * fail with the diagnosis, not with a setup crash.
 *
 *   control            the copy, untouched                     -> must PASS
 *   clone-in-callback  the response is cloned inside the
 *                      caches.open() callback again, past the
 *                      point where respondWith() took the body -> must FAIL
 *   engine-not-routed  the runtime route matches on
 *                      request.destination only, so the engine
 *                      (which arrives by fetch(), destination
 *                      "") is never seen by the worker          -> must FAIL
 *
 * Each mutation must match exactly once in sw.js; if the source has moved on,
 * that is a SETUP-ERROR and a loud exit 2 rather than a silent pass.
 *
 * Both verification channels are exercised against the same mutants, because
 * they have to agree: scripts/offline-sim.mjs reproduces the user-visible
 * failure (no simulation offline), and check-artifacts.mjs check 12 reads the
 * source and must name the same defect. A static check that stays green on a
 * mutant the runtime check kills is a check that proves nothing, and the
 * reverse is a check nobody can afford to run.
 *
 * Usage
 *   node scripts/sw-cache.negctl.mjs [--require] [--keep] [--static-only]
 *
 * Exit codes
 *   0  every case behaved as required (or no browser, and not --require)
 *   1  a mutant survived, or the control failed
 *   2  setup error (site/ or sw.js missing, a mutation anchor not unique)
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SITE = join(REPO_ROOT, 'site');
const SW = join(SITE, 'sw.js');
const OFFLINE_SIM = join(HERE, 'offline-sim.mjs');
const GUARD = join(HERE, 'check-artifacts.mjs');

const argv = process.argv.slice(2);
const has = (n) => argv.some((a) => a === '--' + n);
const REQUIRE = has('require');
const KEEP = has('keep');
// Skip the browser channel and check only that check 12 names the defect. Used
// where a browser is not available; the full run is what CI should do.
const STATIC_ONLY = has('static-only');

if (!existsSync(SW)) { console.error('sw-cache.negctl: no site/sw.js -- run from the repository'); process.exit(2); }
if (!existsSync(OFFLINE_SIM)) { console.error('sw-cache.negctl: no scripts/offline-sim.mjs'); process.exit(2); }

// --- the mutations ----------------------------------------------------------
// Each is an exact edit against the committed bytes plus a claim about how many
// times it should match. Re-introducing the original defect is the honest way
// to test a fix: it does not depend on a commit hash that history may move.
const MUTATIONS = [
  {
    id: 'clone-in-callback',
    why: 'the response is cloned inside the caches.open() callback again, after respondWith() has taken the body',
    expectFailure: /not in Cache Storage after a simulation/,
    expectStatic: 'sw-clone-after-await',
    find: '            const copy = response.clone();\n            void caches.open(CACHE).then((cache) => cache.put(event.request, copy));',
    replace: '            void caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));',
  },
  {
    id: 'engine-not-routed',
    why: 'the runtime route matches on request.destination only, so the fetch()-delivered engine is never seen',
    expectFailure: /not in Cache Storage after a simulation/,
    expectStatic: 'sw-engine-unrouted',
    find: '(isStaticAsset(event.request) || isEnginePayload(event.request)) &&',
    replace: 'isStaticAsset(event.request) &&',
  },
];

const pristine = readFileSync(SW, 'utf8');

// Verify every anchor before touching anything, so the run never gets halfway.
for (const m of MUTATIONS) {
  const n = pristine.split(m.find).length - 1;
  if (n !== 1) {
    console.error('sw-cache.negctl: SETUP-ERROR -- anchor for "' + m.id + '" matches ' + n + ' time(s) in site/sw.js, expected 1.');
    console.error('  the worker source has changed; update the mutation for this case.');
    process.exit(2);
  }
}

const tmp = mkdtempSync(join(tmpdir(), 'sw-negctl-'));
const TMP_SITE = join(tmp, 'site');
const results = [];

/** The finding keys check 12 reports for the tree currently at TMP_SITE. */
function staticKeys() {
  const jsonPath = join(tmp, 'guard.json');
  spawnSync(process.execPath, [GUARD, '--site=' + TMP_SITE, '--json=' + jsonPath], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  try {
    const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const sw = j.serviceWorkerCache;
    return sw && Array.isArray(sw.findings) ? sw.findings.map((f) => f.key) : [];
  } catch (e) {
    return ['<unreadable guard output: ' + String(e.message).slice(0, 120) + '>'];
  }
}

function runCase(id, description, expectFail) {
  const diagnosed = MUTATIONS.find((m) => m.id === id);
  const rec = { id, description, expectFail };
  let bad = false;

  // channel 1: the guard reads the source and must name this defect
  const keys = staticKeys();
  rec.staticKeys = keys;
  if (expectFail) {
    rec.staticOk = keys.some((k) => k.startsWith(diagnosed.expectStatic));
    if (!rec.staticOk) bad = true;
  } else {
    rec.staticOk = keys.length === 0;
    if (!rec.staticOk) bad = true;
  }

  // channel 2: the browser must fail the same way, for the same reason
  if (STATIC_ONLY) {
    rec.runtime = 'skipped';
    rec.ok = !bad;
    const tag = bad ? 'BAD' : (expectFail ? 'caught' : 'ok');
    console.log('  ' + id + ': ' + tag + ' (static) -- ' + description +
      (bad ? '  [check 12 keys: ' + (keys.join(', ') || 'none') + ']' : ''));
    results.push(rec);
    return rec;
  }

  const r = spawnSync(process.execPath, [OFFLINE_SIM, '--site=' + TMP_SITE, '--require'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const output = String(r.stdout || '') + String(r.stderr || '');
  const code = r.status;
  if (/offline-sim: SKIP/.test(output)) {
    rec.runtime = 'skip';
    rec.ok = false; rec.skip = true;
    results.push(rec);
    console.log('  ' + id + ': SKIP -- no browser, so this case is inconclusive');
    return rec;
  }
  if (expectFail) {
    const caught = code === 1 && diagnosed.expectFailure.test(output);
    rec.runtime = caught ? 'caught' : (code === 0 ? 'survived' : 'exit ' + code);
    if (!caught) bad = true;
  } else {
    const passed = code === 0 && /offline-sim: PASS/.test(output);
    rec.runtime = passed ? 'pass' : 'exit ' + code;
    if (!passed) bad = true;
  }

  rec.ok = !bad;
  const tag = bad ? 'BAD' : (expectFail ? 'caught' : 'ok');
  console.log('  ' + id + ': ' + tag + ' -- ' + description);
  if (bad) {
    console.log('    check 12 keys: ' + (keys.join(', ') || 'none'));
    console.log('    ---- offline-sim output (tail) ----');
    for (const line of output.split(/\r?\n/).filter(Boolean).slice(-14)) console.log('    ' + line);
  }
  results.push(rec);
  return rec;
}

try {
  console.log('sw-cache.negctl: copying site/ to a scratch tree');
  cpSync(SITE, TMP_SITE, { recursive: true });

  // control first: if there is no browser, the whole run is inconclusive and we
  // must say SKIP rather than report a pile of "caught" mutants.
  writeFileSync(join(TMP_SITE, 'sw.js'), pristine);
  const control = runCase('control', 'the committed artifact, unmodified', false);
  if (control.skip) {
    console.log('sw-cache.negctl: SKIP (no browser available; pass --require to fail instead)');
    process.exit(REQUIRE ? 1 : 0);
  }

  for (const m of MUTATIONS) {
    writeFileSync(join(TMP_SITE, 'sw.js'), pristine.replace(m.find, m.replace));
    runCase(m.id, m.why, true);
    writeFileSync(join(TMP_SITE, 'sw.js'), pristine);
  }
} finally {
  if (KEEP) console.log('sw-cache.negctl: kept scratch tree at ' + tmp);
  else { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
}

const bad = results.filter((r) => !r.ok && !r.skip);
console.log('');
console.log('sw-cache.negctl: ' + results.length + ' case(s), ' + (results.length - bad.length) + ' as required');
writeFileSync(join(REPO_ROOT, 'sw-cache-negctl-result.json'), JSON.stringify({ cases: results }, null, 2));
if (bad.length) {
  console.log('sw-cache.negctl: FAIL (' + bad.map((b) => b.id).join(', ') + ')');
  process.exit(1);
}
console.log('sw-cache.negctl: PASS (every defect re-introduced into the worker was caught)');
process.exit(0);
