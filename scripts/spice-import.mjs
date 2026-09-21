#!/usr/bin/env node
/**
 * Can a user actually get a SPICE netlist into this deployment, and what happens
 * to its `.include` lines when they do?
 *
 * The File menu ships a real control for this:
 *
 *   <label class="file-import">Import SPICE…
 *     <input data-testid="spice-files" type="file" multiple
 *            accept=".spi,.cir,.sp,.inc,.lib" onChange=…s(e.currentTarget.files)>
 *
 * It is a plain multi-file input -- not `webkitdirectory` (that attribute does
 * not occur anywhere in this build) and not `showDirectoryPicker()`. So the only
 * way a user can hand files over is a flattened list: `File.webkitRelativePath`
 * is empty for files chosen this way, and `importSpiceFiles` falls back to
 * `e.name`. Directory structure cannot survive the trip.
 *
 * That matters because the resolver is written as if it could. `Kl()` normalises
 * a path and returns null the moment `..` would climb above the root; `Jl()` then
 * resolves `dirname(source)` + requested and rejects anything outside the source
 * root as SPICE_SOURCE_INCLUDE_DENIED. With flattened names `dirname(entry)` is
 * empty, so *any* `../`-relative include is denied before the file list is even
 * consulted -- including the spelling both shipped teaching libraries instruct
 * the user to write:
 *
 *   cap.lib    line 2:  * Shared by netlists via:  .include ../models/cap.lib
 *   opamp.lib  line 2:  * Shared by netlists via:  .include ../models/opamp.lib
 *
 * Read statically that is a claim, and a claim about a code path I have not run
 * is worth nothing here. This script drives the shipped control in a real
 * browser, through the real file chooser, and records what the product says for
 * each spelling.
 *
 * What the first run of this script measured, before any repair (2026-09-22,
 * Chrome, the committed tree): `plain` imported and `bare-name` imported, while
 * `header-form` was refused with SPICE_SOURCE_INCLUDE_DENIED -- "Include escapes
 * the selected source root or is not local: ../models/cap.lib" -- and
 * `bare-unselected` was refused with SPICE_SOURCE_INCLUDE_MISSING. So both
 * shipped teaching libraries were unreachable from an import for a user
 * following their own headers, and a bare-name include worked only if the user
 * also had the .lib file and selected it in the same dialog. The libraries ship
 * inside the artifact and the site offers no download for them, so in practice
 * neither worked.
 *
 * Two edits in scripts/import-libs.json close that gap, both in Ql():
 *
 *   import-lib-pool        the shipped libraries join the pool handed to Zl(),
 *                          so an include the user cannot supply still resolves.
 *                          Offered rather than merged, so Zl() itself decodes,
 *                          hashes and ids them: no field here is invented. A
 *                          name the selection already carries is skipped, so a
 *                          file the user supplied always wins.
 *   import-include-basename  when Jl() refuses a *relative* include -- which it
 *                          always does for ../, because a flat selection has no
 *                          root to climb from -- retry it by filename against
 *                          the pool. Absolute and URL includes are still refused
 *                          before this runs.
 *
 * The contract this script now pins:
 *
 *   plain            a netlist with no includes imports          -> must import
 *   bare-name        `.include cap.lib`, cap.lib selected        -> must import
 *   header-form      `.include ../models/cap.lib`, cap selected  -> must import
 *   bare-unselected  `.include cap.lib`, nothing selected        -> must import
 *   unknown-library  a library this build does not ship          -> must refuse
 *   absolute-include `/usr/share/cap.lib`, which is not local    -> must refuse
 *
 * The last two are the scoping controls, and they are the reason this is a check
 * rather than a demonstration: a fallback that resolved everything would pass
 * the first four. `absolute-include` deliberately names a basename the pool
 * holds, so relaxing the local-only rule turns it green and this script red.
 *
 * Drivability is asserted rather than assumed. A file input cannot be populated
 * from page script, so the harness opens the real chooser (`<label>` click under
 * a user gesture) with interception on, and requires Chrome to report
 * `Page.fileChooserOpened`. Only then does it set the files, by the node Chrome
 * named. If no chooser event arrives the harness falls back to addressing the
 * input by selector and says so in its report, because a silent fallback would
 * hide the one fact that makes every later assertion meaningful.
 *
 * Expectations about *shape* come from the artifact's bytes: the control's
 * accept list, the diagnostics vocabulary, the entry-selection rule and the
 * success wording. Expectations about *outcome per spelling* are claims named in
 * the fixture table below, each with its reason, and the report prints claim and
 * observation side by side.
 *
 * Usage
 *   node scripts/spice-import.mjs [options]
 *
 *   --site=<dir>       Artifact to read and serve (default <repo>/site).
 *   --url=<url>        Drive an already-running deployment (then --site is read
 *                      only statically).
 *   --no-server        Do not start the preview server (requires --url).
 *   --port=<n>         Preview server port when starting one (default: random).
 *   --base=<path>      Deployed base when starting the server (default: package.json).
 *   --only=a,b         Run only these fixtures. Branch coverage then warns instead
 *                      of failing.
 *   --timeout-ms=<n>   Deadline for one import to reach an outcome (default 45000).
 *   --require          Fail (exit 1) if no browser is available. Default: skip (exit 0).
 *   --keep             Keep the temp fixture directory and say where it is.
 *
 * Exit codes
 *   0  every fixture behaved as claimed (or skipped: no browser, no --require)
 *   1  a claim was not met, or the control could not be driven
 *   2  usage / setup error (artifact shape changed, unreadable input declaration)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (name) => argv.some((a) => a === '--' + name);

if (has('help') || has('h')) {
  console.log('usage: node scripts/spice-import.mjs [--site=dir] [--url=...] [--no-server] [--port=n] [--only=a,b] [--timeout-ms=n] [--require] [--keep]');
  process.exit(0);
}

const REQUIRE = has('require');
const KEEP = has('keep');
const NO_SERVER = has('no-server');
const SITE = resolve(opt('site', join(REPO_ROOT, 'site')));
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(opt('timeout-ms', '45000'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- static channel: what the artifact promises -----------------------------
/**
 * Read the Import SPICE control out of the shipped bytes. If the input stops
 * being a plain multi-file picker, every fixture below changes meaning, so this
 * refuses to guess: it returns the declaration it found and the caller checks it.
 */
function readImportControl(siteDir) {
  const dir = join(siteDir, 'assets');
  if (!existsSync(dir)) return { error: 'no assets/ directory under ' + siteDir };
  const chunks = new Map();
  for (const f of readdirSync(dir)) if (f.endsWith('.js')) chunks.set(f, readFileSync(join(dir, f), 'utf8'));

  let found = null;
  for (const [file, src] of chunks) {
    const at = src.indexOf('spice-files');
    if (at < 0) continue;
    if (found) return { error: 'the spice-files control appears in both ' + found.file + ' and ' + file };
    const win = src.slice(Math.max(0, at - 60), at + 260);
    const accept = /accept:`([^`]+)`/.exec(win);
    const toggle = { file, src, window: win };
    toggle.accept = accept ? accept[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
    toggle.multiple = /multiple:!0/.test(win);
    toggle.isFileInput = /type:`file`/.test(win);
    // `webkitdirectory` is what would preserve directory structure; its absence
    // is the premise of the header-form claim, so assert its absence rather than
    // assume it.
    toggle.anyDirectoryInput = /webkitdirectory/.test(src);
    found = toggle;
  }
  if (!found) return { error: 'no control carries data-testid="spice-files" in ' + [...chunks.keys()].join(', ') };

  // The diagnostics vocabulary, so the runtime channel can recognise a refusal
  // as the product's own words instead of matching a phrase the harness invented.
  const codes = new Set();
  for (const src of chunks.values()) for (const m of src.matchAll(/SPICE_SOURCE_[A-Z_]+/g)) codes.add(m[0]);
  const dirCodes = new Set();
  for (const src of chunks.values()) for (const m of src.matchAll(/SPICE_IMPORT_[A-Z_]+/g)) dirCodes.add(m[0]);

  // Entry selection: which files the user may nominate as the netlist to open.
  let entryRule = null;
  for (const src of chunks.values()) {
    const m = /\/([^/]*cir\|sp\|spi[^/]*)\//.exec(src.replace(/\\\\/g, '\\'));
    if (m) { entryRule = m[0]; break; }
  }
  // Success / in-progress wording, so "it worked" is read from the product.
  let successRe = null, busyText = null;
  for (const src of chunks.values()) {
    const m = /`Imported \$\{[^`]*\}`/.exec(src) || /Imported \$\{[^}]*\} Documents/.exec(src);
    if (m && !successRe) successRe = String(m[0]);
    const b = /`?Importing SPICE sources`?/.exec(src);
    if (b && !busyText) busyText = 'Importing SPICE sources';
  }
  return { control: found, codes: [...codes].sort(), dirCodes: [...dirCodes].sort(), entryRule, successRe, busyText, chunks };
}

const staticc = readImportControl(SITE);
if (staticc.error) {
  console.error('spice-import: SETUP ERROR -- ' + staticc.error);
  process.exit(2);
}
if (!staticc.control.isFileInput || !staticc.control.multiple || !staticc.control.accept) {
  console.error('spice-import: SETUP ERROR -- the spice-files control is no longer a plain multi-file input; got ' +
    JSON.stringify({ accept: staticc.control.accept, multiple: staticc.control.multiple, isFileInput: staticc.control.isFileInput }));
  console.error('  every fixture below assumes a flattened multi-file selection; re-derive them before trusting this check');
  process.exit(2);
}
if (!staticc.codes.includes('SPICE_SOURCE_INCLUDE_DENIED') || !staticc.codes.includes('SPICE_SOURCE_INCLUDE_MISSING')) {
  console.error('spice-import: SETUP ERROR -- the include diagnostics vocabulary changed: ' + JSON.stringify(staticc.codes));
  process.exit(2);
}

// The shipped teaching libraries, used as fixture inputs. Read from the tree
// under test so the fixture is always the library the artifact actually ships.
const LIBS = {
  'cap.lib': readFileSync(join(SITE, 'models', 'cap.lib'), 'utf8'),
};
const CAP_HEADER_INSTRUCTION = /\.include (\S*cap\.lib)/.exec(LIBS['cap.lib']);

// --- fixtures ---------------------------------------------------------------
/**
 * Each fixture names a spelling a user could plausibly produce and the outcome
 * the product's own wiring implies. `expect` is a claim; the report prints it
 * next to the observation so a mismatch is legible.
 */
const FIXTURES = [
  {
    id: 'plain',
    why: 'a self-contained netlist, no includes: the channel itself must work',
    files: { 'divider.sp': 'Educational divider\nR1 in out 1k\nR2 out 0 1k\nV1 in 0 1\n.end\n' },
    expect: 'import',
    pattern: /Imported \d+ Documents/,
  },
  {
    id: 'bare-name',
    why: 'the include is a bare name and the library is selected beside it, so Kl() keeps it and the file list answers it',
    files: { 'lab.sp': 'Capacitor lab\n.include cap.lib\nXcout vref 0 cap_out c=200p\nR1 vref 0 1k\n.end\n', 'cap.lib': LIBS['cap.lib'] },
    expect: 'import',
    pattern: /Imported \d+ Documents/,
  },
  {
    id: 'header-form',
    why: 'exactly the spelling cap.lib\'s own header teaches; a flat selection has no root to climb from, so the filename is what is left to match on',
    files: { 'lab2.sp': 'Capacitor lab\n.include ../models/cap.lib\nXcout vref 0 cap_out c=200p\nR1 vref 0 1k\n.end\n', 'cap.lib': LIBS['cap.lib'] },
    expect: 'import',
    pattern: /Imported \d+ Documents/,
  },
  {
    id: 'bare-unselected',
    why: 'the bare name with the library not selected at all: the pool this build ships has to answer it, since the site offers no way to obtain the file',
    files: { 'lab3.sp': 'Capacitor lab\n.include cap.lib\nXcout vref 0 cap_out c=200p\nR1 vref 0 1k\n.end\n' },
    expect: 'import',
    pattern: /Imported \d+ Documents/,
  },
  {
    id: 'unknown-library',
    why: 'scoping control: a library this build does not ship, so the fallback must not have become "every include resolves"',
    files: { 'lab4.sp': 'Unknown library\n.include not-shipped-here.lib\nX1 a b 0 sub nobody_has\nR1 a 0 1k\n.end\n' },
    expect: 'refuse',
    pattern: /Include target was not selected or found/,
  },
  {
    id: 'absolute-include',
    why: 'scoping control: not a local path, and deliberately a basename the pool holds, so relaxing the local-only rule turns this green',
    files: { 'lab5.sp': 'Absolute include\n.include /usr/share/cap.lib\nXcout vref 0 cap_out c=200p\nR1 vref 0 1k\n.end\n' },
    expect: 'refuse',
    pattern: /Include escapes the selected source root/,
  },
];
const TARGETS = ONLY.length ? FIXTURES.filter((f) => ONLY.includes(f.id)) : FIXTURES;
if (!TARGETS.length) {
  console.error('spice-import: SETUP ERROR -- --only matched nothing from ' + JSON.stringify(FIXTURES.map((f) => f.id)));
  process.exit(2);
}

// --- browser ----------------------------------------------------------------
const CHROME = [
  process.env.CHROME_BIN, process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => existsSync(p));

if (!CHROME) {
  if (REQUIRE) {
    console.error('spice-import: no browser available and --require was set; install Chrome or drop --require');
    process.exit(1);
  }
  console.log('spice-import: SKIP (no browser found; install Chrome/Chromium or pass --require)');
  process.exit(0);
}

function deriveBase() {
  const explicit = opt('base', null);
  if (explicit) return explicit.startsWith('/') ? explicit : '/' + explicit;
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const p = new URL(pkg.homepage).pathname.replace(/\/?$/, '/');
    return p.startsWith('/') ? p : '/' + p;
  } catch { return '/'; }
}
const BASE = deriveBase();
const PREFIX = BASE.replace(/\/?$/, '');

async function waitForServer(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}

const work = mkdtempSync(join(tmpdir(), 'spice-import-'));
const fixturesDir = join(work, 'fixtures');

const R = {
  site: SITE, chrome: CHROME,
  control: {
    accept: staticc.control.accept,
    multiple: staticc.control.multiple,
    anyDirectoryInput: staticc.control.anyDirectoryInput,
    declaredIn: staticc.control.file,
  },
  libraryHeaderInstruction: CAP_HEADER_INSTRUCTION ? CAP_HEADER_INSTRUCTION[1] : null,
  diagnostics: staticc.codes,
  entryRule: staticc.entryRule,
  fixtures: [], errors: [],
};
let pass = true;
const fail = (msg) => { pass = false; console.log('  FAIL: ' + msg); };

let server = null;
let chrome = null;
let profile = null;
try {
  let TARGET_URL = opt('url', null);
  if (!TARGET_URL) {
    if (NO_SERVER) { console.error('spice-import: --no-server requires --url'); process.exit(2); }
    const port = Number(opt('port', String(9300 + Math.floor(Math.random() * 90))));
    server = spawn(process.execPath, [join(HERE, 'serve-local.mjs'), '--port=' + port, '--base=' + BASE, '--cache=public', '--site=' + SITE],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    server.stderr.on('data', (d) => { err += d.toString(); });
    if (!(await waitForServer('http://127.0.0.1:' + port + PREFIX + '/', 15000))) {
      console.error('spice-import: preview server did not come up; stderr=' + err.slice(0, 600));
      process.exit(2);
    }
    TARGET_URL = 'http://127.0.0.1:' + port + PREFIX + '/';
  }
  R.url = TARGET_URL;

  // --- write the fixtures ---------------------------------------------------
  mkdirSync(fixturesDir, { recursive: true });
  const fixturePaths = new Map();
  for (const f of FIXTURES) {
    const dir = join(fixturesDir, f.id);
    mkdirSync(dir, { recursive: true });
    const paths = [];
    for (const [name, text] of Object.entries(f.files)) {
      const p = join(dir, name);
      writeFileSync(p, text, 'utf8');
      paths.push(p);
    }
    // Entry first: the chooser hands the list over in the order given, and the
    // importer's "one unambiguous entry" rule should not be exercised by accident.
    fixturePaths.set(f.id, paths);
  }
  R.fixturesDir = fixturesDir;

  profile = mkdtempSync(join(tmpdir(), 'spice-import-profile-'));
  const DP = 9500 + Math.floor(Math.random() * 300);
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${DP}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-default-apps',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--window-size=1600,1000', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    try { const r = await fetch('http://127.0.0.1:' + DP + '/json/version'); if (r.ok) ver = await r.json(); } catch {}
    await sleep(250);
  }
  if (!ver) throw new Error('devtools never came up; stderr=' + chromeErr.slice(0, 600));

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0; const pending = new Map(); const events = []; const dialogs = [];
  const SEND_TIMEOUT_MS = Number(opt('send-timeout-ms', '20000'));
  // A CDP call that never settles must not be able to stall the run: an
  // unresolved promise reads as a hung harness, and a hung harness reports
  // nothing at all. A call with a deadline turns a stuck renderer into a
  // failure that names itself.
  const send = (m, p = {}, s, ms = SEND_TIMEOUT_MS) => new Promise((res, rej) => {
    const msg = { id: ++id, method: m, params: p }; if (s) msg.sessionId = s;
    const timer = setTimeout(() => {
      if (pending.delete(msg.id)) rej(new Error(m + ' did not settle within ' + ms + 'ms'));
    }, ms);
    pending.set(msg.id, {
      res: (v) => { clearTimeout(timer); res(v); },
      rej: (e) => { clearTimeout(timer); rej(e); },
    });
    ws.send(JSON.stringify(msg));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.method + ' ' + JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method) events.push(m);
    // Leaving a project with unsaved work raises the beforeunload prompt, and a
    // prompt nobody answers blocks the navigation: the next CDP call then never
    // settles and the run stalls with no failing assertion at all -- the one
    // shape of failure this harness cannot report. Accept whatever is asked so
    // navigation stays a step rather than a trap. The prompt is recorded, since
    // "the product asks before discarding" is itself a fact about it.
    if (m.method === 'Page.javascriptDialogOpening') {
      dialogs.push({ type: m.params.type, message: m.params.message });
      ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true }, sessionId }));
    }
  };
  await send('Target.setDiscoverTargets', { discover: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  for (const d of ['Page', 'Network', 'Runtime', 'Log', 'DOM']) await send(d + '.enable', {}, sessionId);

  const evalv = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 300) };
    return r.result?.value;
  };
  const poll = async (fn, deadlineMs, intervalMs) => {
    const end = Date.now() + deadlineMs;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(intervalMs);
    }
  };
  const waitForLoad = (fromIndex, deadlineMs) =>
    poll(() => events.slice(fromIndex).some((m) => m.method === 'Page.loadEventFired') || null, deadlineMs, 200);

  // Open the File menu (a native <details>; `open` is the property the browser
  // reads, and React's onToggle runs off the same attribute).
  const OPEN_MENU_JS = `(function () {
    const d = document.querySelector('details.command-menu');
    if (!d) return 'no-menu';
    const sum = d.querySelector('summary');
    if (!sum) return 'no-summary';
    d.open = true;
    return d.open ? 'open' : 'closed';
  })()`;

  // Click the label that wraps the control: a real chooser request, under a real
  // user gesture. Clicking the <input> itself is unreliable when it is hidden.
  const CLICK_IMPORT_JS = `(function () {
    const input = document.querySelector('[data-testid=spice-files]');
    if (!input) return 'no-input';
    const label = input.closest('label') || input;
    label.click();
    return 'clicked';
  })()`;

  // `innerText` sees only rendered text. A diagnostic that lands in a panel the
  // product has not painted -- or one it paints and hides -- would be invisible
  // to it, and "the harness could not see it" is not "the product did not say
  // it". Read both, and bound the size so a large imported project cannot make
  // the probe itself the expensive part.
  const TEXT_JS = `(function () {
    const b = document.body;
    const vis = b ? b.innerText : '';
    const all = b ? b.textContent : '';
    return {
      vis: String(vis).replace(/\\s+/g, ' ').slice(0, 6000),
      all: String(all).replace(/\\s+/g, ' ').slice(0, 40000),
      dialogs: document.querySelectorAll('[role=dialog],dialog').length,
    };
  })()`;

  console.log('spice-import: browser=' + CHROME);
  console.log('spice-import: site=' + SITE + '  url=' + TARGET_URL);
  console.log('spice-import: control accept=' + JSON.stringify(staticc.control.accept) +
    ' multiple=' + staticc.control.multiple + ' webkitdirectory=' + staticc.control.anyDirectoryInput);
  console.log('spice-import: library header instructs ' + JSON.stringify(CAP_HEADER_INSTRUCTION ? CAP_HEADER_INSTRUCTION[1] : null));
  for (const f of FIXTURES) {
    console.log('  ' + (TARGETS.includes(f) ? '*' : ' ') + f.id.padEnd(16) + ' expect=' + f.expect.padEnd(7) + ' ' + f.why);
  }

  for (const fx of TARGETS) {
    const rec = {
      id: fx.id, why: fx.why, expected: fx.expect, files: Object.keys(fx.files),
      droveBy: null, chooserMode: null, observed: null, outcome: null, message: null, ms: 0, steps: [],
    };
    const t0 = Date.now();
    const step = (s) => { rec.steps.push(s); };
    try {
      // Interception is turned off at the end of every fixture, but a fixture
      // that aborted early could have left it on; the state that matters is the
      // one this fixture runs under, so make it explicit rather than assume it.
      await send('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId, 5000).catch(() => {});
      const from = events.length;
      await send('Page.navigate', { url: TARGET_URL }, sessionId);
      await waitForLoad(from, 20000);
      await sleep(1000);
      step('loaded');

      const booted = await evalv(`({ menu: !!document.querySelector('details.command-menu'), input: !!document.querySelector('[data-testid=spice-files]') })`);
      if (!booted || booted.__error || !booted.input) {
        rec.outcome = 'no-control';
        R.fixtures.push(rec);
        fail(fx.id + ': the Import SPICE control is not in the DOM after boot (' + JSON.stringify(booted) + ')');
        continue;
      }
      rec.menu = await evalv(OPEN_MENU_JS);
      step('menu=' + rec.menu);

      const chooserFrom = events.length;
      await send('Page.setInterceptFileChooserDialog', { enabled: true }, sessionId);
      const clicked = await evalv(CLICK_IMPORT_JS);
      step('click=' + clicked);
      if (clicked !== 'clicked') {
        await send('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId);
        rec.outcome = 'not-drivable';
        R.fixtures.push(rec);
        fail(fx.id + ': could not click the Import SPICE label (' + clicked + ')');
        continue;
      }

      const files = fixturePaths.get(fx.id);
      const chooser = await poll(() => events.slice(chooserFrom).find((m) => m.method === 'Page.fileChooserOpened') || null, 5000, 100);
      if (chooser) {
        rec.droveBy = 'chooser-event';
        rec.chooserMode = chooser.params.mode ?? null;
        step('chooser=' + rec.chooserMode);
        await send('DOM.setFileInputFiles', { files, backendNodeId: chooser.params.backendNodeId }, sessionId);
      } else {
        // A silent fallback would hide the one fact the harness exists to
        // establish, so it is recorded and reported as such.
        rec.droveBy = 'selector-fallback';
        step('chooser=timeout');
        const { root } = await send('DOM.getDocument', { depth: -1 }, sessionId);
        const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '[data-testid=spice-files]' }, sessionId);
        if (!nodeId) {
          await send('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId);
          rec.outcome = 'not-drivable';
          R.fixtures.push(rec);
          fail(fx.id + ': no file-chooser event arrived and the input could not be addressed by selector');
          continue;
        }
        await send('DOM.setFileInputFiles', { files, nodeId }, sessionId);
      }
      step('files-set');
      await send('Page.setInterceptFileChooserDialog', { enabled: false }, sessionId);

      // Terminal outcome: the product's own words, either the success sentence
      // or one of the include diagnostics it declares.
      const pick = (t, re) => { const m = re.exec(t.vis) || re.exec(t.all); return m ? m[0] : null; };
      let last = null;
      const hit = await poll(async () => {
        const t = await evalv(TEXT_JS);
        if (!t || t.__error) return null;
        last = t;
        return pick(t, /Imported \d+ Documents and \d+ structural instances/) ? { kind: 'import', text: pick(t, /Imported \d+ Documents and \d+ structural instances/) }
          : pick(t, /Include escapes the selected source root or is not local[^]{0,120}/) ? { kind: 'deny', text: pick(t, /Include escapes the selected source root or is not local[^]{0,120}/) }
          : pick(t, /Include target was not selected or found[^]{0,120}/) ? { kind: 'missing', text: pick(t, /Include target was not selected or found[^]{0,120}/) }
          : pick(t, /Include (?:cycle|duplicate)[^]{0,120}/) ? { kind: 'cycle', text: pick(t, /Include (?:cycle|duplicate)[^]{0,120}/) }
          : pick(t, /Select one unambiguous[^]{0,140}/) ? { kind: 'ambiguous', text: pick(t, /Select one unambiguous[^]{0,140}/) }
          : pick(t, /SPICE import failed/) ? { kind: 'failed', text: 'SPICE import failed' }
          : null;
      }, TIMEOUT_MS, 400);
      rec.observed = hit;
      rec.outcome = hit ? hit.kind : 'no-outcome';
      rec.message = hit ? hit.text : null;
      if (!hit && last) rec.saw = (last.vis || '').slice(0, 400);
      rec.ms = Date.now() - t0;

      if (!hit) {
        fail(fx.id + ': the control was driven (' + rec.droveBy + ') but no outcome appeared within ' + TIMEOUT_MS + 'ms; the page said ' + JSON.stringify(rec.saw));
      } else {
        const got = hit.kind === 'import' ? 'import' : 'refuse';
        const want = fx.expect;
        const ok = got === want;
        if (!ok) fail(fx.id + ': claimed "' + want + '", observed "' + got + '" -- ' + JSON.stringify(hit.text));
        if (!fx.pattern.test(hit.text || '')) fail(fx.id + ': the message does not match the wording this artifact declares (' + JSON.stringify(hit.text) + ')');
        rec.verdict = ok ? 'as-claimed' : 'contradicted';
      }
      R.fixtures.push(rec);
      console.log('  ' + (rec.verdict === 'as-claimed' ? 'ok  ' : 'BAD ') + fx.id.padEnd(16) +
        ' expected=' + fx.expect.padEnd(7) + ' observed=' + String(rec.outcome).padEnd(9) +
        ' droveBy=' + String(rec.droveBy).padEnd(17) + JSON.stringify(rec.message) + '  ' + rec.ms + 'ms');
    } catch (e) {
      // One fixture that cannot be driven must not take the rest of the matrix
      // with it: the remaining rows are still evidence.
      rec.outcome = 'driver-error';
      rec.error = String((e && e.message) || e).slice(0, 300);
      rec.ms = Date.now() - t0;
      rec.steps.push('aborted');
      R.fixtures.push(rec);
      fail(fx.id + ': ' + rec.error + ' (steps ' + rec.steps.join(',') + ')');
      console.log('  BAD ' + fx.id.padEnd(16) + ' driver-error ' + rec.error);
    }
  }

  // Drivability is the premise of every claim above, so it is asserted on its own.
  R.dialogs = dialogs;
  // The list is capped for readability, but the count is the real one, so say so
  // rather than printing "4 dialog(s)" above a 3-element array.
  if (dialogs.length) console.log('  NOTE: the page raised ' + dialogs.length + ' dialog(s) while being driven: ' + JSON.stringify(dialogs.slice(0, 3)) + (dialogs.length > 3 ? '  (+' + (dialogs.length - 3) + ' more, truncated for display)' : ''));
  const drove = R.fixtures.filter((f) => f.droveBy === 'chooser-event').length;
  const fell = R.fixtures.filter((f) => f.droveBy === 'selector-fallback').length;
  R.drivability = { viaChooserEvent: drove, viaSelectorFallback: fell };
  if (fell) console.log('  NOTE: ' + fell + ' fixture(s) were driven by selector rather than a real chooser event; the chooser path is the one a user takes');
  if (!drove && fell) {
    fail('no fixture produced a file-chooser event -- the control did not behave as a file input a user can pick from');
  }

  const tally = { import: 0, refuse: 0 };
  const TERMINAL = ['import', 'deny', 'missing', 'cycle', 'ambiguous', 'failed'];
  for (const f of R.fixtures) if (f.outcome === 'import') tally.import++; else if (TERMINAL.includes(f.outcome)) tally.refuse++;
  R.branches = tally;
  console.log('spice-import: ' + tally.import + ' imported, ' + tally.refuse + ' refused, of ' + R.fixtures.length + ' fixture(s)');
  const cover = (ok, msg) => { if (!ok) (ONLY.length ? console.log('  WARNING: ' + msg + ' (focused run)') : fail(msg)); };
  cover(tally.import > 0, 'nothing imported -- a harness that cannot see success cannot tell a refusal from a broken channel');
  cover(tally.refuse > 0, 'nothing was refused -- the include diagnostics went unexercised here');
  ws.close();
} catch (e) {
  R.fatal = String((e && e.stack) || e);
  fail('driver threw: ' + R.fatal.slice(0, 400));
} finally {
  try { chrome && chrome.kill(); } catch {}
  await sleep(400);
  if (profile) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
  if (server) { try { server.kill(); } catch {} }
  await sleep(300);
  if (!KEEP && R.fixturesDir) { try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); delete R.fixturesDir; } catch {} }
}

const outPath = join(REPO_ROOT, 'spice-import-result.json');
try { writeFileSync(outPath, JSON.stringify(R, null, 2)); } catch {}

if (pass) {
  console.log('spice-import: PASS');
  process.exit(0);
} else {
  console.log('spice-import: FAIL  (full trace in ' + outPath + ')');
  process.exit(1);
}
