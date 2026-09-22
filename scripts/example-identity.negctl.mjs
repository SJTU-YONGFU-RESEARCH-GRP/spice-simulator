#!/usr/bin/env node
/**
 * Negative control for the example-identity assertion in example-outcomes.mjs.
 *
 * The check has two halves and each needs its own mutation, because a tree can
 * regress in either of two ways:
 *
 *   1. data   -- a payload keeps the factory placeholder. Mutate one payload's
 *                id back to `project-main`. The STATIC half must catch this even
 *                though the resolver would mask it at runtime, because the
 *                stored identity is the data bug and the resolver is only a
 *                display guard.
 *   2. render -- the resolver stops overwriting the name from the catalog.
 *                Revert og() to hand the stored name straight through. The
 *                RUNTIME half must catch this. To isolate the render path the
 *                payload is mutated to a *wrong but non-placeholder* name, so
 *                the static half stays quiet and only the rendered title bar
 *                disagrees with the catalog.
 *
 * A third mutation closes the obvious hole in the assertion itself: rename every
 * payload to the SAME wrong string. A check written as "payload name must differ
 * from the catalog name" would pass that tree; a check written as "the rendered
 * name must equal the catalog name" fails it. That difference is the point.
 *
 * Both halves are run through both channels (--static-only and a real browser),
 * and the control's own baseline must be green before any mutation is trusted:
 * a harness that is already red proves nothing about a mutation.
 *
 * Usage
 *   node scripts/example-identity.negctl.mjs [--static-only] [--site=<dir>] [--require]
 *
 *   --static-only  Exercise only the mutations the static channel can see; the
 *                  runtime mutations are reported as not exercised rather than
 *                  scored green.
 *   --require      Fail (exit 2) if no browser is available. Default: the
 *                  runtime mutations are reported as skipped and the run still
 *                  judges the static ones.
 *
 * Exit codes: 0 every exercised mutation was caught, 1 a mutation escaped,
 * 2 setup error (including no browser under --require).
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const h = argv.find((a) => a.startsWith('--' + n + '=')); return h ? h.slice(n.length + 3) : d; };
const STATIC_ONLY = argv.includes('--static-only');
const REQUIRE = argv.includes('--require');
const SITE = resolve(opt('site', join(REPO_ROOT, 'site')));
const CHUNK = 'assets/App-D0jgYDVz.js';

// The runtime mutations need a browser. Detect it here rather than letting
// example-outcomes skip silently: a control that reports "caught" for a mutation
// nothing exercised would be the same vacuous green this file exists to catch.
const HAS_BROWSER = [
  process.env.CHROME_BIN, process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium',
].filter(Boolean).some((p) => existsSync(p));
if (REQUIRE && !HAS_BROWSER) {
  console.error('example-identity.negctl: no browser available and --require was set; the runtime mutations cannot be judged');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(HERE, 'example-identity.json'), 'utf8'));

// The unpatched tree is synthesised by reversing the manifest, exactly as the
// other controls do -- pointing at the working tree would quietly turn this into
// "patched vs patched" the moment the manifest is applied, and that failure only
// appears after the fact.
function unpatchedText() {
  let s = readFileSync(join(SITE, CHUNK), 'utf8');
  let undone = 0;
  for (const r of manifest.repairs) {
    for (const e of r.edits) {
      const n = s.split(e.replace).length - 1;
      if (n === 1) { s = s.replace(e.replace, e.find); undone++; }
    }
  }
  return { text: s, undone };
}

const MUTATIONS = [
  {
    id: 'payload-id-reverted-to-placeholder',
    half: 'static',
    apply(text) {
      return text.replace(
        'externalSubcircuitDefinitions:[],id:`two-stage-op-amp`,name:`Two-Stage Op Amp`,schemaVersion:47',
        'externalSubcircuitDefinitions:[],id:`project-main`,name:`Two-Stage Op Amp`,schemaVersion:47');
    },
    why: 'a payload stores the factory placeholder id again; the static half must report it',
  },
  {
    id: 'resolver-stops-overwriting-the-name',
    half: 'runtime',
    apply(text) {
      // Revert og() to the pre-repair body AND give the payload a wrong-but-real
      // name, so only the rendered title bar can reveal the regression.
      const a = text.replace(
        'if(!t || t.requiresUnlock && !dg()) return null;\n  let n=structuredClone(t.project);\n  n.name=t.name;\n  return n;',
        'return !t || t.requiresUnlock && !dg() ? null : structuredClone(t.project);');
      const b = a.replace(
        'externalSubcircuitDefinitions:[],id:`two-stage-op-amp`,name:`Two-Stage Op Amp`,schemaVersion:47',
        'externalSubcircuitDefinitions:[],id:`two-stage-op-amp`,name:`A Different Lab`,schemaVersion:47');
      return b;
    },
    why: 'the resolver hands the stored name through; the rendered title bar must disagree with the catalog and the runtime half must catch it',
  },
  {
    id: 'every-payload-renamed-to-one-wrong-string',
    half: 'runtime',
    apply(text) {
      let s = text;
      for (const e of manifest.contract.examples) {
        s = s.replace(
          'id:`' + e.catalogId + '`,name:`' + e.catalogName + '`,schemaVersion:47',
          'id:`' + e.catalogId + '`,name:`New Circuit`,schemaVersion:47');
      }
      return s;
    },
    why: 'all payloads renamed to the same wrong string; a "differs from catalog" rule would pass, the rendered-name assertion must fail',
  },
];

const mutations = MUTATIONS;
const run = (args) => new Promise((res) => {
  const p = spawn(process.execPath, [join(HERE, 'example-outcomes.mjs'), ...args], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d.toString(); });
  p.stderr.on('data', (d) => { out += d.toString(); });
  p.on('close', (code) => res({ code, out }));
});

// --- baseline: the unpatched tree is the control this control needs ---------
const { text: baseline, undone } = unpatchedText();
if (undone !== manifest.repairs.reduce((n, r) => n + r.edits.length, 0)) {
  console.error(`example-identity.negctl: SETUP ERROR -- reversing the manifest undid ${undone} edit(s), expected ${manifest.repairs.reduce((n, r) => n + r.edits.length, 0)}; the site tree is not in the state this control assumes`);
  process.exit(2);
}
if (baseline === readFileSync(join(SITE, CHUNK), 'utf8')) {
  console.error('example-identity.negctl: SETUP ERROR -- reversing the manifest produced the patched tree unchanged; nothing to compare against');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'exid-negctl-'));
let ok = true;
const results = [];

try {
  for (const m of mutations) {
    const dir = join(tmp, 'site-' + m.id);
    cpSync(SITE, dir, { recursive: true });
    const before = readFileSync(join(dir, CHUNK), 'utf8');
    const after = m.apply(before);
    if (after === before) {
      console.error(`example-identity.negctl: SETUP ERROR -- mutation ${m.id} changed nothing; the anchor it targets is gone`);
      process.exit(2);
    }
    writeFileSync(join(dir, CHUNK), after);

    const args = ['--site=' + dir, '--timeout-ms=60000'];
    if (STATIC_ONLY && m.half === 'static') args.push('--static-only');
    const r = await run(args);
    const caught = r.code !== 0;
    // A runtime mutation cannot be judged by the static channel, and it cannot
    // be judged at all without a browser, so either way it is recorded as not
    // exercised rather than scored green. Reporting "caught" for something
    // nothing ran would be the vacuous pass this file exists to catch.
    const skipped = (STATIC_ONLY && m.half === 'runtime') || (m.half === 'runtime' && !HAS_BROWSER);
    results.push({ id: m.id, half: m.half, caught, skipped, code: r.code });
    if (skipped) {
      const reason = STATIC_ONLY ? '--static-only' : 'no browser';
      console.log(`  ... ${m.id.padEnd(46)} [${m.half}] not exercised (${reason})`);
    } else {
      console.log(`  ${caught ? 'ok  ' : 'ESCAPED'} ${m.id.padEnd(46)} [${m.half}] exit=${r.code}`);
      const line = r.out.split('\n').find((l) => /FAIL:|fail|FAILURE/i.test(l) && l.trim());
      if (line) console.log(`        ${line.trim().slice(0, 200)}`);
      if (!caught) {
        ok = false;
        console.log(r.out.split('\n').slice(-18).join('\n'));
      }
    }
  }
} finally {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log();
const judged = results.filter((r) => !r.skipped);
console.log(`example-identity.negctl: ${judged.filter((r) => r.caught).length}/${judged.length} mutation(s) caught` + (STATIC_ONLY ? ' (static-only)' : ''));
if (!ok) { console.log('example-identity.negctl: FAIL -- a mutation escaped the check it was built to defeat'); process.exit(1); }
console.log('example-identity.negctl: PASS');
process.exit(0);
