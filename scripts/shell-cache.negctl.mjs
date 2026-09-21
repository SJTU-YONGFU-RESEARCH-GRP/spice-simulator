#!/usr/bin/env node
/**
 * Prove the shell-cache token check is not vacuous.
 *
 * scripts/check-artifacts.mjs check 13 asserts that the constant sw.js opens its
 * cache under describes THIS tree. A check like that is only as good as the
 * mutants it kills: one that compared the constant with itself, or that only
 * asked whether the token had changed, would pass on every tree -- including a
 * tree carrying a hand-patch that no returning client could ever receive, which
 * is the exact defect it exists to catch.
 *
 * So this driver takes a copy of the artifact, re-introduces one defect at a
 * time, and requires the guard to name it -- and to name it for its own reason,
 * not as a side effect of some other check breaking.
 *
 *   control                    the copy, untouched                    -> PASS
 *   served-asset-patched       bytes change inside a chunk whose
 *                              filename keeps its content hash        -> stale
 *   token-chosen-not-derived   the constant is set to a plausible
 *                              value by hand instead of derived       -> stale
 *   declaration-removed        the constant is deleted outright       -> undeclared
 *   activate-filter-narrowed   activate() retires keys on a prefix
 *                              the cache it opens does not match      -> prefix-absent
 *   payload-dir-added          ENGINE_PAYLOAD_DIRS gains a directory
 *                              without any file changing              -> stale
 *   precache-member-dropped    shellUrls() loses a member without any
 *                              file changing                        -> stale
 *   install-cache-renamed      install() fills a cache whose name
 *                              lies outside the prefix activate()
 *                              retires, while the declaration and
 *                              the retirement filter both stay
 *                              correct                            -> runtime only
 *   engine-payload-patched     a model card (models/*.lib) is
 *                              patched; only the ENGINE_PAYLOAD_DIRS
 *                              rule brings it into scope            -> stale
 *   non-served-file-added      a file this worker can never be
 *                              asked for is added               -> still clean
 *
 * Two channels, and neither contains the other
 * ---------------------------------------------
 * The static channel reads the tree. The runtime channel (precache-weight.mjs)
 * launches a browser, lets the worker install, and compares the cache the
 * browser REALLY opened against the name this tree derives. Both are needed,
 * and two cases below pin down why:
 *
 *   - a patched asset is invisible to a warm client -- it caches by URL, and the
 *     declared name still matches the declared constant -- yet it is the defect
 *     that matters most, and only the static channel reads the bytes;
 *   - activate-filter-narrowed is invisible at runtime too: the worker still
 *     installs and still stores the shell, it just never retires an old one.
 *     That case therefore REQUIRES the runtime channel to PASS -- the honest
 *     statement that the retirement rule is static-only;
 *   - install-cache-renamed is invisible to the static channel: the constant and
 *     both declarations are untouched, so the tree hashes to exactly what the
 *     constant says. What changes is which cache install() opens -- which no
 *     amount of reading sw.js can see, and which the browser reports at once.
 *
 * The two channels share one derivation (scripts/shell-cache.mjs) but not one
 * observation: the static channel reads bytes, the runtime channel reads the
 * cache list of a live worker.
 *
 * Anchors are regexes wherever the text contains a derived token, because a
 * literal would have to be re-edited after every change to the artifact -- a
 * test that has to be maintained in step with the thing it tests.
 *
 * Usage
 *   node scripts/shell-cache.negctl.mjs [--require] [--keep] [--static-only] [--only=<id>]
 *
 * Exit codes
 *   0  every case behaved as required (or no browser, and not --require)
 *   1  a mutant survived, or the control failed
 *   2  setup error (site/ missing, a mutation anchor not unique)
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SITE = join(REPO_ROOT, 'site');
const GUARD = join(HERE, 'check-artifacts.mjs');
const WEIGHT = join(HERE, 'precache-weight.mjs');
const ACCEPT = join(HERE, 'known-deviations.json');

const argv = process.argv.slice(2);
const has = (n) => argv.some((a) => a === '--' + n);
const REQUIRE = has('require');
const KEEP = has('keep');
const STATIC_ONLY = has('static-only');
const ONLY = (argv.find((a) => a.startsWith('--only=')) ?? '').slice('--only='.length);

if (!existsSync(join(SITE, 'sw.js'))) {
  console.error('shell-cache.negctl: no site/sw.js -- run from the repository');
  process.exit(2);
}
for (const p of [GUARD, WEIGHT]) {
  if (!existsSync(p)) { console.error('shell-cache.negctl: missing ' + p); process.exit(2); }
}

const SW = 'sw.js';
const CACHE_DECL = /const CACHE = "icm-static-shell-[0-9a-f]{12}";/;
const ENTRY = 'assets/index-7P_aude7.js';

// Each case: an exact edit against the committed bytes, plus what each channel
// must say about the result. `null` means "no finding expected"; 'pass'/'caught'
// describe the runtime channel. Anchors are verified before anything is touched.
const CASES = [
  {
    id: 'control',
    why: 'the committed artifact, unmodified',
    edits: [],
    staticExpect: null,
    runtimeExpect: 'pass',
  },
  {
    id: 'served-asset-patched',
    why: 'bytes change inside a chunk whose filename still promises the old content hash',
    edits: [{ file: ENTRY, append: '\n// hand-patch that kept its filename\n' }],
    staticExpect: 'shell-cache-stale',
    runtimeExpect: 'caught',
  },
  {
    id: 'token-chosen-not-derived',
    why: 'the constant is set by hand to a plausible value instead of being derived',
    edits: [{
      file: SW,
      re: CACHE_DECL,
      to: 'const CACHE = "icm-static-shell-000000000000";',
    }],
    staticExpect: 'shell-cache-stale',
    runtimeExpect: 'caught',
  },
  {
    id: 'declaration-removed',
    why: 'the constant is deleted, so the worker has no cache to open',
    edits: [{ file: SW, re: CACHE_DECL, to: '' }],
    staticExpect: 'shell-cache-undeclared',
    runtimeExpect: 'caught',
  },
  {
    id: 'activate-filter-narrowed',
    why: 'activate() retires keys on a prefix the cache it opens does not match, so no old shell is ever dropped',
    edits: [{
      file: SW,
      from: 'key.startsWith("icm-static-shell-")',
      to: 'key.startsWith("icm-static-shell-old-")',
    }],
    staticExpect: 'shell-cache-prefix-absent',
    // The worker still installs and still stores the shell; what breaks is the
    // retirement of a PREVIOUS token, which a fresh profile cannot show.
    runtimeExpect: 'pass',
  },
  {
    id: 'payload-dir-added',
    why: 'a directory joins ENGINE_PAYLOAD_DIRS while no file changes, so the cache holds more than the token describes',
    edits: [{
      file: SW,
      from: 'const ENGINE_PAYLOAD_DIRS = ["vendor/", "models/"];',
      to: 'const ENGINE_PAYLOAD_DIRS = ["vendor/", "models/", "sim/"];',
    }],
    staticExpect: 'shell-cache-stale',
    runtimeExpect: 'caught',
  },
  {
    id: 'precache-member-dropped',
    why: 'shellUrls() loses a member while no file changes, so the install payload no longer matches the token',
    edits: [{
      file: SW,
      from: '    new URL("icon-192.png", scope).toString(),\n',
      to: '',
    }],
    staticExpect: 'shell-cache-stale',
    runtimeExpect: 'caught',
  },
  {
    id: 'install-cache-renamed',
    why: 'install() fills a cache whose name is outside the prefix activate() retires, so the shell it creates can never be dropped -- and every static signal stays green',
    edits: [{
      file: SW,
      from: 'caches.open(CACHE).then((cache) => cache.addAll(shellUrls()))',
      to: 'caches.open("shell-" + CACHE).then((cache) => cache.addAll(shellUrls()))',
    }],
    // The declaration is untouched and the declarations that feed the token are
    // untouched, so the guard sees nothing. Only a browser can show that the
    // cache install() really opened is not the one the tree derives -- and that
    // one is invisible to activate(), which retires on the prefix.
    staticExpect: null,
    runtimeExpect: 'caught',
  },
  {
    id: 'engine-payload-patched',
    why: 'a model card is patched; no extension a resource tag uses would bring it into scope, so this rests on the ENGINE_PAYLOAD_DIRS rule alone',
    edits: [{ file: 'models/cmos.lib', append: '\n* hand-patch that kept its filename\n' }],
    staticExpect: 'shell-cache-stale',
    runtimeExpect: 'caught',
  },
  {
    id: 'non-served-file-added',
    why: 'a file this worker can never be asked for is added, so nothing a client holds can go stale and the token must NOT move',
    edits: [{ create: 'README.txt', content: 'not served by any route this worker has\n' }],
    // The counterpart of every other case: it pins the SCOPE. If the derivation
    // ever widened back to "every file in the tree", this case would go red --
    // and so would every harness that writes a scratch file into the tree it
    // inspects, which is how the widening was found in the first place.
    staticExpect: null,
    runtimeExpect: 'pass',
  },
];

const selected = ONLY ? CASES.filter((c) => c.id === ONLY) : CASES;
if (selected.length === 0) {
  console.error('shell-cache.negctl: --only=' + ONLY + ' matches no case; have: ' + CASES.map((c) => c.id).join(', '));
  process.exit(2);
}

/** How many times an edit's anchor matches in the committed file. */
function anchorCount(file, edit) {
  const src = readFileSync(join(SITE, file), 'utf8');
  if (edit.re) {
    const flags = edit.re.flags.includes('g') ? edit.re.flags : edit.re.flags + 'g';
    const hits = src.match(new RegExp(edit.re.source, flags));
    return hits ? hits.length : 0;
  }
  return src.split(edit.from).length - 1;
}

/** Apply one edit to the scratch copy. The caller has already verified it applies cleanly. */
function applyEdit(siteDir, edit) {
  if (edit.create) { writeFileSync(join(siteDir, edit.create), edit.content); return; }
  const p = join(siteDir, edit.file);
  const s = readFileSync(p, 'utf8');
  if (edit.append) { writeFileSync(p, s + edit.append); return; }
  if (edit.re) { writeFileSync(p, s.replace(edit.re, edit.to)); return; }
  writeFileSync(p, s.split(edit.from).join(edit.to));
}

// Verify every edit applies cleanly against the committed bytes before touching
// anything, so the run never gets halfway through and leaves a half-mutated tree
// behind -- and so a case can never "pass" because its mutation silently did
// nothing.
for (const c of CASES) {
  for (const e of c.edits) {
    if (e.create) {
      if (existsSync(join(SITE, e.create))) {
        console.error('shell-cache.negctl: SETUP-ERROR -- "' + c.id + '" creates ' + e.create +
          ', which already exists in site/; that case would test nothing.');
        process.exit(2);
      }
      continue;
    }
    if (e.append) continue;
    const n = anchorCount(e.file, e);
    if (n !== 1) {
      console.error('shell-cache.negctl: SETUP-ERROR -- anchor for "' + c.id + '" matches ' + n + ' time(s) in ' + e.file + ', expected 1.');
      console.error('  the artifact has moved on; update the mutation for this case.');
      console.error('  anchor: ' + JSON.stringify(String(e.re ?? e.from).slice(0, 120)));
      process.exit(2);
    }
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'shell-cache-negctl-'));
const TMP_SITE = join(scratch, 'site');
const results = [];

/** The shellCache finding keys the guard reports for the tree at TMP_SITE. */
function staticKeys() {
  const jsonPath = join(scratch, 'guard.json');
  const r = spawnSync(process.execPath, [GUARD, '--site=' + TMP_SITE, '--accept=' + ACCEPT, '--json=' + jsonPath], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 300000,
  });
  try {
    const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const sc = j.shellCache;
    if (!sc || !Array.isArray(sc.findings)) return { keys: ['<no shellCache block in the guard output>'], code: r.status };
    return { keys: sc.findings.map((f) => f.key), code: r.status, token: sc.token, declared: sc.declared };
  } catch (e) {
    return { keys: ['<unreadable guard output: ' + String(e.message).slice(0, 120) + '>'], code: r.status };
  }
}

/** The runtime channel: does the browser open the name this tree derives? */
function runtimeVerdict() {
  const r = spawnSync(process.execPath, [WEIGHT, '--site=' + TMP_SITE, '--require'], {
    cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000,
  });
  const output = String(r.stdout || '') + String(r.stderr || '');
  if (/precache-weight: SKIP/.test(output)) return { verdict: 'skip', output };
  return { verdict: r.status === 0 ? 'pass' : 'caught', output, code: r.status };
}

function runCase(c) {
  // Rebuild the scratch tree from the committed one, so no case can see another.
  rmSync(TMP_SITE, { recursive: true, force: true });
  cpSync(SITE, TMP_SITE, { recursive: true });
  for (const e of c.edits) applyEdit(TMP_SITE, e);

  const rec = { id: c.id, why: c.why, staticExpect: c.staticExpect, runtimeExpect: c.runtimeExpect };
  let bad = false;

  // channel 1: the guard reads the tree and must name this defect, or nothing
  const st = staticKeys();
  rec.staticKeys = st.keys;
  rec.staticCode = st.code;
  rec.staticToken = st.token;
  rec.staticDeclared = st.declared;
  rec.staticOk = c.staticExpect === null
    ? st.keys.length === 0
    : st.keys.some((k) => k.startsWith(c.staticExpect));
  if (!rec.staticOk) bad = true;

  // channel 2: the browser must open the cache this tree derives -- or, for the
  // rules the runtime cannot see, must still succeed
  if (STATIC_ONLY) {
    rec.runtime = 'skipped';
    rec.ok = !bad;
    console.log('  ' + c.id + ': ' + (bad ? 'BAD' : c.staticExpect === null ? 'ok' : 'caught') +
      ' (static only) -- ' + c.why + (bad ? '  [keys: ' + (st.keys.join(', ') || 'none') + ']' : ''));
    results.push(rec);
    return rec;
  }

  const rt = runtimeVerdict();
  if (rt.verdict === 'skip') {
    rec.runtime = 'skip';
    rec.skip = true;
    rec.ok = false;
    results.push(rec);
    console.log('  ' + c.id + ': SKIP -- no browser, so this case is inconclusive');
    return rec;
  }
  rec.runtime = rt.verdict;
  if (rt.verdict !== c.runtimeExpect) bad = true;

  rec.ok = !bad;
  console.log('  ' + c.id + ': ' + (bad ? 'BAD' : c.runtimeExpect === 'caught' ? 'caught' : 'ok') +
    ' -- ' + c.why);
  if (bad) {
    console.log('    static keys: ' + (st.keys.join(', ') || 'none') + '  (expected ' + (c.staticExpect ?? 'none') + ')');
    console.log('    runtime:     ' + rt.verdict + '  (expected ' + c.runtimeExpect + ')');
    for (const line of (rt.output || '').split(/\r?\n/).filter(Boolean).slice(-10)) console.log('    | ' + line);
  }
  results.push(rec);
  return rec;
}

try {
  console.log('shell-cache.negctl: copying site/ to a scratch tree');
  for (const c of selected) runCase(c);
} finally {
  if (KEEP) console.log('shell-cache.negctl: kept scratch tree at ' + scratch);
  else { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
}

const bad = results.filter((r) => !r.ok && !r.skip);
const skipped = results.filter((r) => r.skip);

if (skipped.length) {
  console.log('shell-cache.negctl: SKIP (' + skipped.length + ' case(s) inconclusive without a browser; pass --require to fail instead)');
  writeFileSync(join(REPO_ROOT, 'shell-cache-negctl-result.json'), JSON.stringify({ cases: results }, null, 2));
  process.exit(REQUIRE ? 1 : 0);
}

console.log('');
console.log('shell-cache.negctl: ' + results.length + ' case(s), ' + (results.length - bad.length) + ' as required');
writeFileSync(join(REPO_ROOT, 'shell-cache-negctl-result.json'), JSON.stringify({ cases: results }, null, 2));
if (bad.length) {
  console.log('shell-cache.negctl: FAIL (' + bad.map((b) => b.id).join(', ') + ')');
  process.exit(1);
}
console.log('shell-cache.negctl: PASS (every defect re-introduced into the token was caught)');
process.exit(0);
