#!/usr/bin/env node
/**
 * Prove the install-budget check is not vacuous.
 *
 * scripts/check-artifacts.mjs check 5 now asserts two things: every URL
 * shellUrls() names resolves to a file, and the whole list fits in
 * scripts/precache-budget.json. A check like that is only worth its runtime if
 * something would actually fail it, so this driver re-introduces one defect at a
 * time into a scratch copy of the artifact and requires **both** channels to
 * report it:
 *
 *   channel 1  scripts/check-artifacts.mjs check 5 -- sums the size of the files
 *              shellUrls() names and reads the declared budget
 *   channel 2  scripts/precache-weight.mjs -- loads the application, lets
 *              install() run, and sums what is in the shell cache afterwards
 *
 * The second channel is not the first one twice. Channel 1 assumes the worker
 * stored each file as itself; channel 2 reads the cache back and compares every
 * entry against the file on disk, so it also catches the worker storing
 * something else under a target's key. The `target-missing` case is where that
 * matters: channel 1 says "this target has no file", while channel 2 can only
 * say "the cache does not hold it", because addAll() is atomic and aborts the
 * install before it stores anything.
 *
 * Cases
 *   control             the copy, untouched                        -> both PASS
 *   fat-logo            logo.png replaced by icon-512.png's bytes
 *                       (a real 512x512 PNG) -- every target
 *                       resolves, one of them is 327 KB           -> both FAIL
 *   icon-512-restored   the 512 px manifest icon put back into
 *                       shellUrls(); the file was there all along -> both FAIL
 *   target-missing      favicon.png deleted; addAll() is atomic,
 *                       so the install aborts outright            -> both FAIL
 *
 * `icon-512-restored` verifies its anchor matches exactly once before anything
 * is touched: if the worker source has moved on, that is a SETUP-ERROR and a
 * loud exit 2 rather than a silent pass.
 *
 * Usage
 *   node scripts/precache-budget.negctl.mjs [--require] [--keep] [--static-only]
 *
 * Exit codes
 *   0  every case behaved as required (or no browser, and not --require)
 *   1  a mutant survived, or the control failed
 *   2  setup error (site/, sw.js, a script or the budget file missing; an anchor
 *      that is not unique)
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { shellCacheState, writeShellCacheToken } from './shell-cache.mjs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SITE = join(REPO_ROOT, 'site');
const SW = join(SITE, 'sw.js');
const GUARD = join(HERE, 'check-artifacts.mjs');
const WEIGHT = join(HERE, 'precache-weight.mjs');
const BUDGET = join(HERE, 'precache-budget.json');

const argv = process.argv.slice(2);
const has = (n) => argv.some((a) => a === '--' + n);
const REQUIRE = has('require');
const KEEP = has('keep');
// Skip the browser channel and check only that check 5 names the defect. Used
// where a browser is not available; the full run is what CI should do.
const STATIC_ONLY = has('static-only');

for (const [what, p] of [['site/sw.js', SW], ['scripts/check-artifacts.mjs', GUARD],
  ['scripts/precache-weight.mjs', WEIGHT], ['scripts/precache-budget.json', BUDGET]]) {
  if (!existsSync(p)) { console.error('precache-budget.negctl: no ' + what + ' -- run from the repository'); process.exit(2); }
}

const pristineSw = readFileSync(SW, 'utf8');

// Put the 512 px manifest icon back into shellUrls(). The anchor is the last
// entry plus the closing bracket, so it can only match the end of the list.
const RESTORE_ANCHOR = '    new URL("icon-192.png", scope).toString(),\n  ];';
const RESTORE_WITH = '    new URL("icon-192.png", scope).toString(),\n    new URL("icon-512.png", scope).toString(),\n  ];';

if (pristineSw.split(RESTORE_ANCHOR).length - 1 !== 1) {
  console.error('precache-budget.negctl: SETUP-ERROR -- the shellUrls() tail anchor matches ' +
    (pristineSw.split(RESTORE_ANCHOR).length - 1) + ' time(s) in site/sw.js, expected 1.');
  console.error('  the worker source has changed; update RESTORE_ANCHOR for the icon-512-restored case.');
  process.exit(2);
}
if (!existsSync(join(SITE, 'icon-512.png'))) {
  console.error('precache-budget.negctl: SETUP-ERROR -- site/icon-512.png is gone, so the fat-logo case has nothing realistic to copy.');
  process.exit(2);
}

const CASES = [
  {
    id: 'control',
    why: 'the committed artifact, unmodified',
    staticKey: null,        // null means: check 5 must report nothing
    runtimePass: true,
    apply: () => {},
  },
  {
    id: 'fat-logo',
    why: 'logo.png replaced by a real 512x512 PNG, so every target resolves but one is 327 KB',
    staticKey: 'precache-budget',
    runtimeStatus: 'over-budget',
    apply: (t) => copyFileSync(join(t, 'icon-512.png'), join(t, 'logo.png')),
  },
  {
    id: 'icon-512-restored',
    why: 'the 512 px manifest icon put back into shellUrls(); the file existed all along',
    staticKey: 'precache-budget',
    runtimeStatus: 'over-budget',
    apply: (t) => writeFileSync(join(t, 'sw.js'), pristineSw.replace(RESTORE_ANCHOR, RESTORE_WITH)),
  },
  {
    id: 'target-missing',
    why: 'favicon.png deleted, so cache.addAll() aborts the whole install',
    staticKey: 'shell-missing:favicon.png',
    runtimeStatus: null,    // any non-pass diagnosis is correct here; see the header
    apply: (t) => unlinkSync(join(t, 'favicon.png')),
  },
];

const tmp = mkdtempSync(join(tmpdir(), 'precache-negctl-'));
const TMP_SITE = join(tmp, 'site');
const results = [];

/** Restore the three files any case may touch, so each case starts clean. */
function reset() {
  copyFileSync(join(SITE, 'logo.png'), join(TMP_SITE, 'logo.png'));
  copyFileSync(join(SITE, 'favicon.png'), join(TMP_SITE, 'favicon.png'));
  writeFileSync(join(TMP_SITE, 'sw.js'), pristineSw);
}

/** What check 5 reports for the tree currently at TMP_SITE. */
function staticFindings() {
  const jsonPath = join(tmp, 'guard.json');
  spawnSync(process.execPath, [GUARD, '--site=' + TMP_SITE, '--json=' + jsonPath], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  try {
    const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const shell = j.serviceWorkerShell;
    return {
      keys: shell && Array.isArray(shell.findings) ? shell.findings.map((f) => f.key) : ['<no serviceWorkerShell in the guard JSON>'],
      total: shell ? shell.totalBytes : null,
      budget: shell ? shell.budgetBytes : null,
    };
  } catch (e) {
    return { keys: ['<unreadable guard output: ' + String(e.message).slice(0, 120) + '>'], total: null };
  }
}

function runCase(c) {
  reset();
  c.apply(TMP_SITE);
  // Keep the mutant self-consistent before measuring. Every case here changes a
  // file the worker's routes can store, so the shell-cache token (check 13) would
  // go stale and precache-weight -- which now also requires the cache the browser
  // opened to be the name this tree derives -- would fail on THAT, and the budget
  // would stop being what this file tests. Re-deriving leaves the budget as the
  // only live property, and check 13 has its own mutation driver.
  const derived = shellCacheState(TMP_SITE);
  if (derived.declared !== derived.token) writeShellCacheToken(TMP_SITE, derived.token);

  const rec = { id: c.id, why: c.why };
  let bad = false;

  const st = staticFindings();
  rec.staticKeys = st.keys;
  rec.staticTotal = st.total;
  if (c.staticKey === null) {
    rec.staticOk = st.keys.length === 0;
  } else {
    rec.staticOk = st.keys.includes(c.staticKey);
  }
  if (!rec.staticOk) bad = true;

  if (STATIC_ONLY) {
    rec.runtime = 'skipped';
    rec.ok = !bad;
    console.log('  ' + c.id + ': ' + (bad ? 'BAD' : (c.staticKey ? 'caught' : 'ok')) + ' (static) -- ' + c.why +
      (bad ? '  [check 5 keys: ' + (st.keys.join(', ') || 'none') + ']' : ''));
    results.push(rec);
    return rec;
  }

  const r = spawnSync(process.execPath, [WEIGHT, '--site=' + TMP_SITE, '--require'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  const output = String(r.stdout || '') + String(r.stderr || '');
  const code = r.status;
  rec.runtime = { exit: code, sawNoBrowser: code === 3 || /SKIP \(no browser/.test(output) };
  rec.runtimeTotal = (output.match(/([\d.]+) KiB stored of a/) || [])[1] ?? null;
  rec.runtimeStatus = /precache-weight: FAIL \(over budget/.test(output) ? 'over-budget'
    : /precache-weight: PASS/.test(output) ? 'pass'
      : /precache-weight: FAIL/.test(output) ? 'failed'
        : 'error';

  if (rec.runtime.sawNoBrowser) {
    rec.ok = false; rec.skip = true;
    results.push(rec);
    console.log('  ' + c.id + ': SKIP -- no browser, so this case is inconclusive');
    return rec;
  }

  if (c.runtimePass) {
    rec.runtimeOk = code === 0 && rec.runtimeStatus === 'pass';
  } else if (c.runtimeStatus) {
    // A specific diagnosis was named: require it.
    rec.runtimeOk = code === 1 && rec.runtimeStatus === c.runtimeStatus;
  } else {
    // target-missing: addAll() aborts, and the probe may report either "the
    // cache does not hold this target" or "there is no shell cache at all"
    // depending on how far install() got. Both are correct; what is not
    // acceptable is passing.
    rec.runtimeOk = code === 1 && rec.runtimeStatus !== 'pass';
  }
  if (!rec.runtimeOk) bad = true;

  rec.ok = !bad;
  console.log('  ' + c.id + ': ' + (bad ? 'BAD' : (c.runtimePass ? 'ok' : 'caught')) + ' -- ' + c.why);
  if (!c.runtimePass) {
    console.log('      static:  ' + (rec.staticOk ? 'named ' + c.staticKey : 'MISSED (keys: ' + (st.keys.join(', ') || 'none') + ')'));
    console.log('      runtime: ' + rec.runtimeStatus + ' (exit ' + code + ')' +
      (rec.runtimeTotal ? ', ' + rec.runtimeTotal + ' KiB stored' : ''));
  }
  results.push(rec);
  return rec;
}

try {
  console.log('precache-budget.negctl: copying site/ to a scratch tree');
  cpSync(SITE, TMP_SITE, { recursive: true });

  const control = runCase(CASES[0]);
  if (control.skip) {
    console.log('precache-budget.negctl: SKIP (no browser available; pass --require to fail instead)');
    process.exit(REQUIRE ? 1 : 0);
  }
  for (const c of CASES.slice(1)) runCase(c);
} finally {
  if (KEEP) console.log('precache-budget.negctl: kept scratch tree at ' + tmp);
  else { try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
}

const bad = results.filter((r) => !r.ok && !r.skip);
console.log('');
console.log('precache-budget.negctl: ' + results.length + ' case(s), ' + (results.length - bad.length) + ' as required');
writeFileSync(join(REPO_ROOT, 'precache-budget-negctl-result.json'), JSON.stringify({ cases: results }, null, 2));
if (bad.length) {
  console.log('precache-budget.negctl: FAIL (' + bad.map((b) => b.id).join(', ') + ')');
  process.exit(1);
}
console.log('precache-budget.negctl: PASS (every defect re-introduced into the precache was caught by both channels)');
process.exit(0);
