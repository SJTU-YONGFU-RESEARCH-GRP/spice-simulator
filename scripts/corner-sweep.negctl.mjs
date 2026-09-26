#!/usr/bin/env node
/**
 * Prove that check 14 is not vacuous.
 *
 * check 14 claims three things about the artifact: the profile advertises the
 * declared corners, the deck emitter maps each of them to a selector, and the
 * library answers that selector. A guard like that can go green for reasons
 * that have nothing to do with the artifact being right -- a scope that misses
 * the file, a `find` that stopped matching so the loop body never runs, a
 * derived value that is compared against itself. The only way to tell a working
 * guard from a lucky one is to break the thing it guards, one way at a time, and
 * require it to say the specific thing it is supposed to say.
 *
 * So every case here is a mutation of a REAL patched copy of the artifact, and
 * each one names the finding key it has to produce. Two of them are controls in
 * the other direction:
 *
 *   control            an unmutated patched copy must produce NO finding, or
 *                      the mutant results below mean nothing;
 *   unpatched-tree     a patched copy with the manifest reversed, so the feature
 *                      is absent entirely, must fail -- this is the case that
 *                      rules out a check that would also pass on a tree that
 *                      never had corners. It is built here rather than read from
 *                      site/, which ships patched.
 *
 * Each case also declares `absent`: keys that must NOT appear. Those are the
 * keys that would mean the check itself broke rather than the artifact (a
 * mutation that was supposed to be surgical tripping three unrelated rules), and
 * a check that fires on everything is as useless as one that fires on nothing.
 *
 * Mutations are anchored on the bytes the patcher writes, and every anchor must
 * occur exactly `count` times -- a mutation that silently matched nothing would
 * turn into a case that "passes" because nothing changed.
 *
 * Usage
 *   node scripts/corner-sweep.negctl.mjs [--only=<id,...>] [--keep] [--json=<file>]
 *
 * Exit codes: 0 every case behaved, 1 a case did not, 2 setup error.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const MANIFEST = join(HERE, 'corner-sweep.json');
const GUARD = join(HERE, 'check-artifacts.mjs');
const PATCHER = join(HERE, 'patch-outbound.mjs');
const SITE = join(REPO_ROOT, 'site');

const argv = process.argv.slice(2);
const has = (n) => argv.some((a) => a === '--' + n);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const KEEP = has('keep');
const JSON_OUT = opt('json', null);

const CHUNK = 'assets/src-CMkpkg0p.js';
const LIB = 'models/cmos.lib';

// The bytes the emitter writes, quoted once so every mutation below reads as a
// statement about the artifact rather than as a pile of escapes.
const EMIT_TAIL = 'return`.include ${n}\\n.param __cn_sel=${v}`';
const REPORT_NEEDLE = 'oe({directive:`include`,path:$,section:t.environment?.corner??null})';
const DESCRIPTOR = '{directive:`include`,path:t.modelLibrary.path,section:i.environment.corner??null}';

const CASES = [
  {
    id: 'control',
    why: 'an unmutated patched tree must be clean, or nothing below is evidence',
    expect: [],
  },
  {
    id: 'unpatched-tree',
    why: 'the committed tree, where the feature does not exist at all',
    unpatched: true,
    expect: ['corner-capability-mismatch', 'corner-repair-missing:corner-selector-emit#0', 'corner-descriptor-missing'],
    absent: ['corner-contract-vacuous'],
  },
  {
    id: 'corners-emptied',
    why: 'the profile stops advertising corners, leaving the panel inert again -- the exact defect this feature fixes',
    tree: [[CHUNK, 'corners:[`tt`,`ss`,`ff`],devices:Ft', 'corners:[],devices:Ft']],
    expect: ['corner-capability-mismatch'],
    absent: ['corner-descriptor-missing', 'corner-emitter-missing', 'corner-library-drift'],
  },
  {
    id: 'corners-reordered',
    why: 'the same three corners, but ss first -- the panel would default to a slow corner and every existing run would change',
    tree: [[CHUNK, 'corners:[`tt`,`ss`,`ff`]', 'corners:[`ss`,`ff`,`tt`]']],
    expect: ['corner-capability-mismatch', 'corner-capability-default-not-typical'],
    absent: ['corner-selector-missing:ss', 'corner-descriptor-missing'],
  },
  {
    id: 'selector-emission-dropped',
    why: 'the emitter stops writing the selector, so every corner returns the typical deck',
    tree: [[CHUNK, EMIT_TAIL, 'return`.include ${n}`']],
    expect: ['corner-repair-missing:corner-selector-emit#0', 'corner-emitter-missing', 'corner-selector-param-mismatch'],
    absent: ['corner-selector-missing:ss', 'corner-library-drift'],
  },
  {
    id: 'selector-value-wrong',
    why: 'ss is mapped to the typical selector, so a slow-corner run silently produces the typical answer',
    tree: [[CHUNK, 'let v=c===`ss`?1:', 'let v=c===`ss`?0:']],
    expect: ['corner-selector-value:ss', 'corner-repair-missing:corner-selector-emit#0'],
    absent: ['corner-selector-missing:ss', 'corner-capability-mismatch'],
  },
  {
    id: 'selector-extra',
    why: 'the emitter can select a corner no profile advertises',
    tree: [[CHUNK, 'let v=c===`ss`?1:', 'let v=c===`zz`?1:c===`ss`?1:']],
    expect: ['corner-selector-extra:zz'],
    absent: ['corner-selector-missing:ss', 'corner-selector-missing:ff'],
  },
  {
    id: 'typical-mapped',
    why: 'the typical corner gains a selector, so the default run stops being byte-identical to the deck this artifact produced before',
    tree: [
      [CHUNK, 'if(c===null||c===``||c===`tt`)return', 'if(c===null||c===``)return'],
      [CHUNK, 'let v=c===`ss`?1:', 'let v=c===`tt`?0:c===`ss`?1:'],
    ],
    expect: ['corner-selector-typical-mapped'],
    absent: ['corner-selector-missing:tt'],
  },
  {
    id: 'emitter-param-renamed',
    why: 'the deck writes a parameter the library has never heard of: ngspice would take the library default and report nothing',
    tree: [[CHUNK, '.param __cn_sel=${v}', '.param __cn_xx=${v}']],
    expect: ['corner-selector-param-mismatch', 'corner-repair-missing:corner-selector-emit#0'],
    absent: ['corner-library-drift'],
  },
  {
    id: 'descriptor-dropped',
    why: 'the corner the panel sends never reaches the prepared deck',
    tree: [[CHUNK, DESCRIPTOR, '{directive:`include`,path:t.modelLibrary.path}']],
    expect: ['corner-descriptor-missing', 'corner-repair-missing:corner-descriptor#0'],
    absent: ['corner-report-missing', 'corner-capability-mismatch'],
  },
  {
    id: 'report-dropped',
    why: 'the run record stops naming the corner, so three corner-swept runs export three indistinguishable records',
    tree: [[CHUNK, REPORT_NEEDLE, 'oe({directive:`include`,path:$})', 2]],
    expect: ['corner-report-missing',
      'corner-repair-missing:corner-report#1', 'corner-repair-missing:corner-report#2'],
    absent: ['corner-repair-missing:corner-report#0', 'corner-descriptor-missing'],
  },
  {
    id: 'library-base-moved',
    why: 'a base model value drifts, so the typical corner stops being the device set that shipped before',
    tree: [[LIB, 'VTO={0.5+0.08*__cn_sel}', 'VTO={0.55+0.08*__cn_sel}']],
    expect: ['corner-library-drift', 'corner-repair-missing:corner-library#0'],
    absent: ['corner-library-absent', 'corner-device-unmodelled:nmos_rvt'],
  },
  {
    id: 'device-unmodelled',
    why: 'the profile advertises a device the library declares no model for',
    tree: [[CHUNK, 'Ft=[`nmos_rvt`,', 'Ft=[`nmos_zzz`,`nmos_rvt`,']],
    expect: ['corner-device-unmodelled:nmos_zzz'],
    absent: ['corner-library-drift', 'corner-capability-mismatch'],
  },
  {
    id: 'manifest-declares-extra-corner',
    why: 'the manifest claims a corner the artifact does not have -- the comparison has to work in this direction too',
    manifest: [['    "corners": [\n      "tt",', '    "corners": [\n      "xx",\n      "tt",']],
    expect: ['corner-capability-mismatch', 'corner-selector-missing:xx'],
    absent: ['corner-contract-vacuous'],
  },
  {
    id: 'manifest-vacuous',
    why: 'a manifest with no contract would let every rule below pass silently while verifying nothing',
    manifest: [['"contract": {', '"contractX": {']],
    expect: ['corner-contract-vacuous'],
  },
];

// --- setup ------------------------------------------------------------------
const fail = (msg) => { console.error('corner-sweep.negctl: ' + msg); process.exit(2); };
if (!existsSync(MANIFEST)) fail('missing ' + MANIFEST);
if (!existsSync(GUARD)) fail('missing ' + GUARD);
if (!existsSync(join(SITE, 'index.html'))) fail('not a site tree: ' + SITE);

const work = mkdtempSync(join(tmpdir(), 'corner-negctl-'));
const copy = join(work, 'site');
console.log('corner-sweep.negctl: building a patched copy in ' + copy);
try {
  cpSync(SITE, copy, { recursive: true });
} catch (e) {
  fail('cannot copy the artifact: ' + e.message);
}
try {
  execFileSync(process.execPath, [PATCHER, '--site=' + copy, '--manifest=' + MANIFEST], { stdio: 'pipe' });
} catch (e) {
  fail('the manifest did not apply cleanly to the copy: ' + String((e && e.stdout) || e).slice(0, 500));
}

// The unpatched control must not read the working tree directly. This driver
// builds its patched copy by copying site/ and applying the manifest, which is
// only "a patched tree" while site/ is itself unpatched -- and site/ ships
// patched, because the feature is the deliverable. Pointing the case at SITE
// would then have compared a patched tree against a patched tree and quietly
// turned the one control that rules out a check passing on a featureless tree
// into a second copy of the control above. So the unpatched tree is
// materialised here by reversing the manifest -- each edit's `replace` swapped
// back to its `find` -- on a second copy. The count is asserted: a reverse that
// matched nothing would leave the case testing a patched tree again, which is
// exactly the silent failure this rewrite exists to remove.
const UNPATCHED = join(work, 'unpatched-site');
{
  let manifestText;
  try { manifestText = JSON.parse(readFileSync(MANIFEST, 'utf8')); }
  catch (e) { fail('cannot parse the manifest: ' + e.message); }
  try { cpSync(copy, UNPATCHED, { recursive: true }); }
  catch (e) { fail('cannot copy for the unpatched tree: ' + e.message); }
  for (const repair of manifestText.repairs ?? []) {
    const path = join(UNPATCHED, repair.file);
    let text = readFileSync(path, 'utf8');
    for (const [i, edit] of (repair.edits ?? []).entries()) {
      const seen = text.split(edit.replace).length - 1;
      if (seen !== 1) {
        fail('cannot reverse ' + repair.id + ' edit #' + i + ': the patched form occurs ' +
          seen + ' time(s) in the copy, so the unpatched tree is not what this case assumes');
      }
      text = text.split(edit.replace).join(edit.find);
    }
    writeFileSync(path, text, 'utf8');
  }
}

const count = (text, needle) => {
  let n = 0;
  let at = 0;
  for (;;) {
    const i = text.indexOf(needle, at);
    if (i === -1) return n;
    n += 1;
    at = i + needle.length;
  }
};

const guardKeys = (site, manifestPath) => {
  const out = join(work, 'guard-' + Math.random().toString(16).slice(2) + '.json');
  let stdout = '';
  try {
    stdout = execFileSync(process.execPath,
      [GUARD, '--site=' + site, '--corner=' + manifestPath, '--json=' + out],
      { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (e) {
    // Findings make the guard exit 1, which is the ordinary case here.
    stdout = String((e && e.stdout) || '');
  }
  if (!existsSync(out)) return { error: 'the guard wrote no json (stdout tail: ' + stdout.slice(-300) + ')' };
  const blob = JSON.parse(readFileSync(out, 'utf8'));
  rmSync(out, { force: true });
  return { section: blob.cornerSweep ?? {} };
};

// --- run --------------------------------------------------------------------
const results = [];
let bad = 0;
for (const c of CASES) {
  if (ONLY.length && !ONLY.includes(c.id)) continue;
  const saved = new Map();
  let manifestPath = MANIFEST;
  let setup = null;
  try {
    for (const [file, find, replace, n] of c.tree ?? []) {
      const path = join(copy, file);
      const text = readFileSync(path, 'utf8');
      saved.set(path, text);
      const seen = count(text, find);
      if (seen !== (n ?? 1)) {
        setup = 'anchor for ' + file + ' occurs ' + seen + ' time(s), expected ' + (n ?? 1) + ': ' + JSON.stringify(find.slice(0, 80));
        break;
      }
      writeFileSync(path, text.split(find).join(replace), 'utf8');
    }
    if (setup === null) {
      for (const [find, replace] of c.manifest ?? []) {
        const path = join(work, 'manifest-' + c.id + '.json');
        const text = saved.has('__manifest__') ? saved.get('__manifest__') : readFileSync(MANIFEST, 'utf8');
        saved.set('__manifest__', text);
        if (!(find instanceof RegExp)) {
          const seen = count(text, find);
          if (seen !== 1) { setup = 'manifest anchor occurs ' + seen + ' time(s): ' + JSON.stringify(find); break; }
        }
        writeFileSync(path, text.replace(find, replace), 'utf8');
        manifestPath = path;
      }
    }
    if (setup !== null) throw new Error(setup);

    const site = c.unpatched ? UNPATCHED : (c.site ?? copy);
    const got = guardKeys(site, manifestPath);
    if (got.error) { setup = got.error; throw new Error(setup); }
    const keys = (got.section.findings ?? []).map((f) => f.key);
    const missing = c.expect.filter((k) => !keys.includes(k));
    const present = (c.absent ?? []).filter((k) => keys.includes(k));
    const ok = missing.length === 0 && present.length === 0;
    if (!ok) bad += 1;
    results.push({
      id: c.id, why: c.why, ok, expect: c.expect, absent: c.absent ?? [], keys,
      missing, present, status: got.section.status, corners: got.section.corners,
    });
    console.log('  ' + (ok ? 'ok  ' : 'BAD ') + c.id.padEnd(30) + keys.length + ' finding(s)');
    if (!ok) {
      if (missing.length) console.log('        expected but absent: ' + JSON.stringify(missing));
      if (present.length) console.log('        must not appear: ' + JSON.stringify(present));
      console.log('        keys: ' + JSON.stringify(keys));
    }
  } catch (e) {
    bad += 1;
    results.push({ id: c.id, why: c.why, ok: false, setup: String((e && e.message) || e) });
    console.log('  BAD ' + c.id.padEnd(30) + ' SETUP ERROR: ' + String((e && e.message) || e));
  } finally {
    for (const [path, text] of saved) {
      if (path === '__manifest__') continue;
      try { writeFileSync(path, text, 'utf8'); } catch {}
    }
  }
}

if (JSON_OUT) {
  writeFileSync(resolve(REPO_ROOT, JSON_OUT), JSON.stringify({
    copy, only: ONLY, results, failures: bad,
  }, null, 2), 'utf8');
}

if (!KEEP) {
  try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); } catch {}
} else {
  console.log('corner-sweep.negctl: kept ' + work);
}

const ran = results.length;
console.log('corner-sweep.negctl: ' + (ran - bad) + '/' + ran + ' case(s) behaved');
if (bad > 0) {
  console.log('corner-sweep.negctl: FAIL -- at least one mutation was not caught for its own stated reason');
  process.exit(1);
}
if (ran === 0) {
  console.log('corner-sweep.negctl: FAIL -- no case ran');
  process.exit(2);
}
console.log('corner-sweep.negctl: PASS');
process.exit(0);
