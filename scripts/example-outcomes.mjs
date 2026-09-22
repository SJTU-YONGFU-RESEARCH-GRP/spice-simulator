#!/usr/bin/env node
/**
 * Every built-in example must either run, or say why it cannot.
 *
 * The gallery ships five labs and the browser executor advertises one process
 * profile (`edu-cmos-ngspice-wasm-v1`). Two of the five declare simulation
 * setups; one of those two declares a profile the executor does not advertise
 * (`sky130-core-continuous-ngspice46-v1` -- sky130 is delivered as a server-side
 * container, and a static Pages deployment has no hosted executor to consume
 * it). So one built-in lab cannot run here, by construction. The question is
 * whether the product *says so*, and this script pins both halves down:
 *
 *   before the run  the Setup panel renders the declared profile as
 *                   "<id> (unavailable)" (the `W ? `${z} (unavailable)` : ...`
 *                   branch in the simulation surface), so a user can tell
 *                   without pressing anything;
 *   on Run          the refusal lands at `prepare`, before a deck reaches the
 *                   engine, and surfaces as a structured problem
 *                   (SIMULATION_PROFILE_UNKNOWN, stage `prepare`) in the app's
 *                   own Console tab. Nothing executes: the status chip stays
 *                   idle and no plot appears.
 *
 * Both outcomes are asserted, and so is the ordinary one: a setup whose profile
 * *is* advertised must actually complete and render plots. A harness that could
 * only recognise success could not tell an honest refusal from a dead run, so
 * the full sweep requires both branches to appear and says so loudly when the
 * artifact stops offering it one of them.
 *
 * Expectations are computed from the artifact, not written down here: the
 * catalog, each example's declared setup list, and the executor's advertised
 * profiles are read out of the shipped chunks. The runtime channel then reads
 * the page the product renders. The two are independent, so agreement between
 * them is evidence rather than a tautology -- and if the catalog and the
 * payloads ever disagree, the mismatch shows up as a failure naming both sides.
 *
 * The unlock flag is written straight into localStorage instead of being typed
 * into the passphrase dialog. That reproduces the state a course user is
 * already in; it does not test the gate (A6 covers the gate, and the passphrase
 * exists here only as a SHA-256).
 *
 * Usage
 *   node scripts/example-outcomes.mjs [options]
 *
 *   --site=<dir>        Artifact to read and serve (default <repo>/site). A copy
 *                       with a mutated chunk is how the negative control
 *                       exercises this.
 *   --url=<url>         Drive an already-running deployment instead of starting
 *                       the preview server (then --site is only read statically).
 *   --no-server         Do not start the preview server (requires --url).
 *   --port=<n>          Preview server port when starting one (default: random).
 *   --base=<path>       Deployed base when starting the server (default: package.json).
 *   --examples=a,b      Run only these catalog ids. Branch coverage is then
 *                       reported as a warning rather than a failure.
 *   --timeout-ms=<n>    Deadline for one example to reach an outcome (default 60000).
 *   --require           Fail (exit 1) if no browser is available. Default: skip (exit 0).
 *
 * Exit codes
 *   0  pass (or skipped because no browser and not --require)
 *   1  at least one example behaved in a way the artifact does not claim
 *   2  usage / setup error (no browser with --require, unreadable catalog, a
 *      Run control that cannot be clicked, or a status chip that was not idle
 *      before the run)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
  console.log('usage: node scripts/example-outcomes.mjs [--site=dir] [--url=...] [--no-server] [--port=n] [--examples=a,b] [--timeout-ms=n] [--require]');
  process.exit(0);
}

const REQUIRE = has('require');
const NO_SERVER = has('no-server');
const SITE = resolve(opt('site', join(REPO_ROOT, 'site')));
const ONLY = (opt('examples', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(opt('timeout-ms', '60000'));
const READY_MS = Number(opt('ready-ms', '30000'));
const UNLOCK_KEY = 'spice.masterLibraryUnlock.v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- static channel: what the artifact declares -----------------------------
function readChunks(siteDir) {
  const dir = join(siteDir, 'assets');
  if (!existsSync(dir)) return { error: 'no assets/ directory under ' + siteDir };
  const out = new Map();
  for (const f of readdirSync(dir)) if (f.endsWith('.js')) out.set(f, readFileSync(join(dir, f), 'utf8'));
  if (!out.size) return { error: 'no .js chunks under ' + dir };
  return { chunks: out };
}

// The five catalog entries carry id, name, description, unlock flag and a
// reference to a project literal, in that order and nowhere else.
const CATALOG_RE = /\{id:`([a-z0-9-]+)`,name:`([^`]*)`,description:`([^`]*)`,requiresUnlock:!(0|1),project:rg\(([\w$]+)\)\}/g;
// One `var A={...},B={...}`,...`` chain holds the project literals; each slice
// runs to the next binder, and the catalog array bounds the last one.
const PROFILE_RE = /profileId:`([^`]+)`/g;

function analyse(chunks) {
  let cat = null;
  for (const [file, src] of chunks) {
    const hits = [...src.matchAll(CATALOG_RE)];
    if (!hits.length) continue;
    if (cat) return { error: 'the example catalog appears in both ' + cat.file + ' and ' + file };
    cat = { file, src, hits: hits.map((m) => ({ id: m[1], name: m[2], requiresUnlock: m[4] === '0', v: m[5] })) };
  }
  if (!cat) return { error: 'no example catalog matched in ' + [...chunks.keys()].join(', ') };

  const catalogStart = cat.src.indexOf('{id:`' + cat.hits[0].id + '`,name:`');
  const marks = cat.hits.map((e) => {
    const a = cat.src.indexOf('var ' + e.v + '={');
    const b = cat.src.indexOf(',' + e.v + '={');
    return { v: e.v, at: a >= 0 ? a : b };
  }).sort((x, y) => x.at - y.at);
  if (marks.some((m) => m.at < 0)) return { error: 'a catalog entry points at a project binder that is not defined' };
  for (let i = 0; i < marks.length; i++) if (i + 1 < marks.length && marks[i + 1].at <= marks[i].at) return { error: 'project binders are not ordered' };

  const byVar = new Map();
  for (let i = 0; i < marks.length; i++) {
    const to = i + 1 < marks.length ? marks[i + 1].at : catalogStart;
    const slice = cat.src.slice(marks[i].at, to);
    const setups = /simulationSetups:(\[\]|\[\{)/.exec(slice);
    if (!setups) return { error: 'project ' + marks[i].v + ' has no simulationSetups field' };
    if ((slice.match(/simulationSetups:/g) || []).length !== 1) return { error: 'project ' + marks[i].v + ' slice contains more than one simulationSetups field' };
    const payload = /id:`([^`]*)`,name:`([^`]*)`?(?:,schemaVersion:\d+)?,simulationSetups:/.exec(slice);
    byVar.set(marks[i].v, {
      setups: setups[1] === '[]' ? 0 : 1, // only "declares a lab or does not" is asserted
      profiles: [...new Set([...slice.matchAll(PROFILE_RE)].map((m) => m[1]))],
      payloadId: payload ? payload[1] : null,
      payloadName: payload ? payload[2] : null,
    });
  }

  // The executor advertises its profiles from `capabilities()`; the ids are
  // held in minified binders, so resolve them.
  let advertised = null;
  for (const [file, src] of chunks) {
    const m = /profiles:\[\{id:(\w+),label:`[^`]*`,corners:\[([^\]]*)\],devices:(\w+)\}/.exec(src);
    if (!m) continue;
    const decl = new RegExp('var ' + m[1] + '=`([^`]+)`').exec(src);
    if (!decl) return { error: 'advertised profile binder ' + m[1] + ' does not resolve to a literal' };
    advertised = {
      file,
      ids: [decl[1]],
      corners: m[2].split(',').map((s) => s.trim().replace(/`/g, '')).filter(Boolean),
    };
    break;
  }
  if (!advertised) return { error: 'no executor capability declaration (profiles:[{id:...}]) found' };

  const entries = cat.hits.map((e) => {
    const p = byVar.get(e.v);
    if (!p) return { error: 'no project payload for ' + e.id };
    const unadvertised = p.profiles.filter((x) => !advertised.ids.includes(x));
    return {
      id: e.id, name: e.name, requiresUnlock: e.requiresUnlock,
      payloadId: p.payloadId, payloadName: p.payloadName,
      setups: p.setups, declaredProfiles: p.profiles, unadvertised,
      // Advertising a profile is a promise that decks for it will run; a setup
      // that names one the executor does not advertise can only be refused.
      expectation: p.setups === 0 ? 'no-lab' : unadvertised.length ? 'refuse' : 'complete',
    };
  });
  return { catalogFile: cat.file, advertised, entries };
}

// The project factory in this build is `function pl(e,t,n='document-main')`:
// it stamps whatever (id, name) its caller supplies. A payload that kept the
// factory's placeholder identity names a lab the user did not open -- the title
// bar renders the project's own name, so 'New Circuit' is what a user reads
// after choosing 'Two-Stage Op Amp'. Three of the five payloads shipped that
// way. The placeholder is the failure, so it is named here rather than inferred:
// a check that only looked for a mismatch anywhere would pass on a tree where
// every payload had been renamed to the same wrong string.
const PLACEHOLDER_ID = 'project-main';
const PLACEHOLDER_NAME = 'New Circuit';
function identityOf(entry) {
  const problems = [];
  if (entry.payloadId === PLACEHOLDER_ID) problems.push('stored id is the factory placeholder ' + JSON.stringify(PLACEHOLDER_ID));
  if (entry.payloadName === PLACEHOLDER_NAME) problems.push('stored name is the factory placeholder ' + JSON.stringify(PLACEHOLDER_NAME));
  if (!entry.payloadId) problems.push('no project id could be read out of its payload');
  if (!entry.payloadName) problems.push('no project name could be read out of its payload');
  return { ok: problems.length === 0, problems };
}

const chunks = readChunks(SITE);
if (chunks.error) {
  console.error('example-outcomes: SETUP ERROR -- ' + chunks.error);
  process.exit(2);
}
const analysis = analyse(chunks.chunks);
if (analysis.error) {
  console.error('example-outcomes: SETUP ERROR -- ' + analysis.error);
  console.error('  the shipped shape changed; update the regexes in analyse() and re-derive them before trusting this check');
  process.exit(2);
}
const TARGETS = ONLY.length ? analysis.entries.filter((e) => ONLY.includes(e.id)) : analysis.entries;
if (!TARGETS.length) {
  console.error('example-outcomes: SETUP ERROR -- --examples matched nothing from ' + JSON.stringify(analysis.entries.map((e) => e.id)));
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
    console.error('example-outcomes: no browser available and --require was set; install Chrome or drop --require');
    process.exit(1);
  }
  console.log('example-outcomes: SKIP (no browser found; install Chrome/Chromium or pass --require)');
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

let server = null;
let TARGET_URL = opt('url', null);
if (!TARGET_URL) {
  if (NO_SERVER) { console.error('example-outcomes: --no-server requires --url'); process.exit(2); }
  const port = Number(opt('port', String(8950 + Math.floor(Math.random() * 90))));
  server = spawn(process.execPath, [join(HERE, 'serve-local.mjs'), '--port=' + port, '--base=' + BASE, '--cache=public', '--site=' + SITE],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  server.stderr.on('data', (d) => { err += d.toString(); });
  if (!(await waitForServer('http://127.0.0.1:' + port + PREFIX + '/', 15000))) {
    console.error('example-outcomes: preview server did not come up; stderr=' + err.slice(0, 600));
    try { server.kill(); } catch {}
    process.exit(2);
  }
  TARGET_URL = 'http://127.0.0.1:' + port + PREFIX + '/';
}
const ORIGIN = new URL(TARGET_URL).origin;

const profile = mkdtempSync(join(tmpdir(), 'example-outcomes-'));
const DP = 9450 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DP}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-default-apps',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--window-size=1600,1000', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

// Everything below is read off the rendered page. Parsing the warning out of the
// chunk would be circular: the warning is the thing under test.
const READY_JS = `({
  path: location.pathname + location.search,
  runButton: !!document.querySelector('button.simulation-run-button'),
  openedExample: /Opened example:/.test(document.body ? document.body.innerText : ''),
  // The title bar names the open circuit through this control. Reading it is
  // how the check tells whether the identity the payload stored reached the
  // user, which is the whole point: the stored value is invisible until the
  // product renders it.
  circuitName: (function () {
    const el = document.querySelector('input[data-testid=project-name-input]');
    return el ? el.value : null;
  })(),
  announced: [...document.querySelectorAll('[role=alert],[role=status],[aria-live]')].map((e) => (e.innerText || '').trim()).filter(Boolean).slice(0, 6),
  text: (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 200),
})`;

const SURFACE_JS = `(function () {
  const chip = document.querySelector('.simulation-status-chip');
  const sels = [...document.querySelectorAll('select')];
  const sel = sels.find((e) => (e.getAttribute('aria-label') || e.name || '') === 'profileId');
  const selected = sel && sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent.trim() : null;
  // A setup can be unrunnable two ways: the profile is not advertised, or the
  // corner it asks for is not one the selected profile offers. Both are
  // announced the same way, and both must be announced.
  const unavailableControls = sels
    .filter((e) => e.selectedIndex >= 0 && /\\(unavailable\\)/.test(e.options[e.selectedIndex].textContent || ''))
    .map((e) => ({ label: e.getAttribute('aria-label') || e.name || '', value: e.value, text: e.options[e.selectedIndex].textContent.trim() }));
  return {
    chip: chip ? chip.className : null,
    chipText: chip ? (chip.textContent || '').trim() : null,
    hasProfileSelect: !!sel,
    profileId: sel ? sel.value : null,
    profileLabel: selected,
    unavailableControls,
    runButton: !!document.querySelector('button.simulation-run-button'),
    svg: document.querySelectorAll('svg').length,
  };
})()`;

const OUTCOME_JS = `(function () {
  const chip = document.querySelector('.simulation-status-chip');
  const body = document.body ? document.body.innerText : '';
  return {
    chip: chip ? chip.className : null,
    chipText: chip ? (chip.textContent || '').trim() : null,
    code: (body.match(/SIMULATION_[A-Z_]+/) || [])[0] || null,
    stage: (body.match(/\\b(prepare|start|read|export)\\s*\\u00b7/) || [])[0] || null,
    svg: document.querySelectorAll('svg').length,
    attention: /needs attention/i.test(body),
  };
})()`;

const CLICK_JS = `(function () {
  const b = [...document.querySelectorAll('button.simulation-run-button')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!b.length) return 'missing';
  if (b.length > 1) return 'ambiguous:' + b.length;
  b[0].click();
  return 'clicked';
})()`;

// Some labs open with the simulation surface already showing and some do not,
// so the panel is opened only when its run control is absent. Clicking the
// toggle blind would just as often close a panel that was already open.
const OPEN_SIM_JS = `(function () {
  const b = [...document.querySelectorAll('button,[role=button],[role=tab]')].find((e) =>
    /analog simulation/i.test([e.getAttribute('title'), e.getAttribute('aria-label'), e.textContent].filter(Boolean).join(' ')));
  if (!b) return 'no-toggle';
  if (b.getAttribute('aria-expanded') === 'true' || document.querySelector('button.simulation-run-button')) return 'already-open';
  b.click();
  return 'clicked';
})()`;

const R = {
  site: SITE, url: TARGET_URL, chrome: CHROME, timeoutMs: TIMEOUT_MS,
  advertised: analysis.advertised,
  entries: analysis.entries,
  targets: TARGETS.map((t) => t.id),
  examples: [], branches: null, errors: [],
};
let pass = true;
const fail = (msg) => { pass = false; console.log('  FAIL: ' + msg); };

try {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    try { const r = await fetch('http://127.0.0.1:' + DP + '/json/version'); if (r.ok) ver = await r.json(); } catch {}
    await sleep(250);
  }
  if (!ver) throw new Error('devtools never came up; stderr=' + chromeErr.slice(0, 600));

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0; const pending = new Map(); const events = [];
  const send = (m, p = {}, s) => new Promise((res, rej) => {
    const msg = { id: ++id, method: m, params: p }; if (s) msg.sessionId = s;
    pending.set(msg.id, { res, rej }); ws.send(JSON.stringify(msg));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.rej(new Error(m.method + ' ' + JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method) events.push(m);
  };
  await send('Target.setDiscoverTargets', { discover: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  for (const d of ['Page', 'Network', 'Runtime', 'Log']) await send(d + '.enable', {}, sessionId);

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

  const setupError = async (msg, rec) => {
    console.error('example-outcomes: SETUP ERROR -- ' + msg);
    R.errors.push({ id: rec?.id, kind: msg });
    try { chrome.kill(); } catch {}
    if (server) { try { server.kill(); } catch {} }
    writeFileSync(join(REPO_ROOT, 'example-outcomes-result.json'), JSON.stringify(R, null, 2));
    process.exit(2);
  };

  console.log('example-outcomes: browser=' + CHROME);
  console.log('example-outcomes: site=' + SITE + '  url=' + TARGET_URL);
  console.log('example-outcomes: advertised profile(s) ' + JSON.stringify(analysis.advertised.ids) +
    ' with corners ' + JSON.stringify(analysis.advertised.corners) + '  (declared in ' + analysis.advertised.file + ')');
  for (const e of analysis.entries) {
    console.log('  ' + (TARGETS.includes(e) ? '*' : ' ') + e.id.padEnd(44) + ' setups=' + (e.setups ? 'yes' : 'no ') +
      ' profiles=' + JSON.stringify(e.declaredProfiles) + ' -> ' + e.expectation +
      (e.unadvertised.length ? ' (' + JSON.stringify(e.unadvertised) + ' not advertised)' : ''));
  }

  // Boot once, then unlock, so the gated labs resolve. See the header: this
  // reproduces a course user's state rather than testing the passphrase gate.
  await send('Page.navigate', { url: TARGET_URL }, sessionId);
  await waitForLoad(0, 20000);
  await sleep(1200);
  const unlocked = await evalv(`(function(){try{localStorage.setItem(${JSON.stringify(UNLOCK_KEY)},'1');return localStorage.getItem(${JSON.stringify(UNLOCK_KEY)});}catch(e){return 'failed:'+e.message;}})()`);
  if (unlocked !== '1') console.log('example-outcomes: note -- could not set the unlock flag (' + JSON.stringify(unlocked) + '); gated examples may not open');

  for (const entry of TARGETS) {
    const rec = {
      id: entry.id, name: entry.name, requiresUnlock: entry.requiresUnlock, expectation: entry.expectation,
      declared: { setups: entry.setups, profiles: entry.declaredProfiles, unadvertised: entry.unadvertised, payloadId: entry.payloadId, payloadName: entry.payloadName },
      url: TARGET_URL + '?example=' + encodeURIComponent(entry.id),
      surface: null, outcome: null, observed: null, ms: 0,
    };
    const t0 = Date.now();
    const from = events.length;
    await send('Page.navigate', { url: rec.url }, sessionId);
    await waitForLoad(from, 20000);

    // Readiness must be established on the *new* document. Checking the query
    // string is what stops a poll from latching onto the page we came from.
    const want = '?example=' + entry.id;
    let ready = await poll(async () => {
      const r = await evalv(READY_JS);
      if (!r || r.__error) return null;
      if (!r.path.endsWith(want)) return null;
      if (!r.openedExample) return null;
      return r;
    }, READY_MS, 600);
    if (!ready) {
      const why = await evalv(READY_JS);
      rec.outcome = 'not-opened';
      R.examples.push(rec);
      fail(entry.id + ': listed in the catalog but ?example=' + entry.id + ' never opened it within ' + READY_MS + 'ms; ' +
        'openedExample=' + (why && why.openedExample) + ' announced=' + JSON.stringify(why && why.announced) +
        ' text=' + JSON.stringify(why && why.text));
      continue;
    }

    // The catalog name is what the user picked, so it is what the title bar must
    // show. The stored identity is repaired by scripts/example-identity.json and
    // the resolver now overwrites it from the catalog, so the two agree by
    // construction -- this asserts the construction holds, on the rendered page
    // rather than in the chunk, because a stored-only fix would leave the
    // placeholder visible and a resolver-only fix would leave the data wrong.
    rec.circuitName = ready.circuitName;
    rec.staticIdentity = identityOf(entry);
    if (!rec.staticIdentity.ok) {
      fail(entry.id + ': its stored project identity is a placeholder: ' + rec.staticIdentity.problems.join('; ') +
        ' (payload id=' + JSON.stringify(entry.payloadId) + ' name=' + JSON.stringify(entry.payloadName) + ')');
    }
    if (ready.circuitName !== entry.name) {
      fail(entry.id + ': the title bar shows ' + JSON.stringify(ready.circuitName) + ' but the catalog entry the user opened is ' +
        JSON.stringify(entry.name) + ' -- the name a user reads must be the one they chose');
    }

    // Reveal the simulation surface if it is not already showing. When the
    // payload declares no setups there is nothing to wait for, so the deadline
    // is short: eight seconds of hoping is not a check.
    let surface = await evalv(SURFACE_JS);
    if (!surface.runButton) {
      rec.panelToggle = await evalv(OPEN_SIM_JS);
      await poll(async () => {
        const s = await evalv(SURFACE_JS);
        return s.runButton ? s : null;
      }, entry.expectation === 'no-lab' ? 2500 : 8000, 400);
      surface = await evalv(SURFACE_JS);
    }
    rec.surface = surface;

    if (!/simulation-status-idle/.test(surface.chip || '')) {
      // Without a known idle starting point the outcome poll cannot tell a new
      // result from a stale one, so this is a setup error rather than a pass.
      await setupError(entry.id + ' status chip was ' + JSON.stringify(surface.chip + ' ' + surface.chipText) + ' before the run', rec);
    }

    if (entry.expectation === 'no-lab') {
      rec.outcome = 'no-lab';
      // The static claim is "this payload declares no setups". The runtime must
      // agree: nothing to run, and no profile to choose.
      if (surface.runButton) fail(entry.id + ': declares no simulation setups, yet the simulation surface offers a Run control');
      if (surface.hasProfileSelect) fail(entry.id + ': declares no simulation setups, yet the surface shows a profile selector (' + JSON.stringify(surface.profileLabel) + ')');
      R.examples.push(rec);
      console.log('  ok  ' + entry.id.padEnd(44) + ' no-lab     runButton=' + surface.runButton + ' profileSelect=' + surface.hasProfileSelect +
        ' identity=' + JSON.stringify(ready.circuitName) +
        '  (payload ' + JSON.stringify(entry.payloadId) + ')  ' + (Date.now() - t0) + 'ms');
      continue;
    }

    if (!surface.runButton) {
      rec.outcome = 'no-run-control';
      R.examples.push(rec);
      fail(entry.id + ': declares ' + entry.declaredProfiles.length + ' profile(s) across its setups but no Run control appeared (panel toggle -> ' + rec.panelToggle + ')');
      continue;
    }
    // The declared environment has to reach the screen before the user presses
    // anything, and it has to be the profile the payload actually asked for.
    const marks = surface.unavailableControls ?? [];
    const profileMark = marks.find((m) => m.label === 'profileId');
    if (entry.expectation === 'refuse') {
      if (!surface.hasProfileSelect) fail(entry.id + ': its profile is not advertised, so the surface must show the declared profile as unavailable; no profile selector appeared');
      else {
        if (!profileMark) fail(entry.id + ': profile ' + JSON.stringify(surface.profileLabel) + ' is not advertised, yet it is not marked "(unavailable)"');
        if (!entry.unadvertised.includes(surface.profileId)) fail(entry.id + ': the surface selected profile ' + JSON.stringify(surface.profileId) + ', but the payload declares ' + JSON.stringify(entry.declaredProfiles));
      }
    } else if (marks.length) {
      fail(entry.id + ': every declared profile is advertised, yet the surface warns before the run: ' + JSON.stringify(marks));
    }

    const clicked = await evalv(CLICK_JS);
    if (clicked !== 'clicked') await setupError(entry.id + ' Run control not clickable (' + clicked + ')', rec);

    // An outcome is either the chip leaving idle (a run started and ended) or a
    // structured refusal code appearing (no run existed to start).
    const hit = await poll(async () => {
      const r = await evalv(OUTCOME_JS);
      if (!r || r.__error) return null;
      if (/simulation-status-idle/.test(r.chip || '') && !r.code) return null;
      return r;
    }, TIMEOUT_MS, 500);
    let observed = hit;
    if (hit) { await sleep(1200); observed = await evalv(OUTCOME_JS); }
    rec.observed = observed;
    rec.ms = Date.now() - t0;

    // Three different things get confused for each other here. An uncaught
    // exception is a defect. A console error is a message. A request that came
    // back >= 400 is neither -- and /api/ is out of scope, because this is a
    // static site with no backend and the app is built to carry on without it.
    const exceptions = [], logErrors = [], failedRequests = [];
    const reqUrl = new Map();
    for (let i = from; i < events.length; i++) {
      const m = events[i];
      if (m.method === 'Network.requestWillBeSent' && m.params.requestId) reqUrl.set(m.params.requestId, m.params.request.url);
      else if (m.method === 'Runtime.exceptionThrown') exceptions.push(String(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text).slice(0, 240));
      else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') logErrors.push({ text: String(m.params.entry.text).slice(0, 160), url: String(m.params.entry.url ?? '').replace(ORIGIN, '') });
      else if (m.method === 'Network.loadingFailed') failedRequests.push({ url: (reqUrl.get(m.params.requestId) ?? '?').replace(ORIGIN, ''), error: m.params.errorText });
      else if (m.method === 'Network.responseReceived' && m.params.response && m.params.response.status >= 400) failedRequests.push({ url: String(m.params.response.url).replace(ORIGIN, ''), error: 'HTTP ' + m.params.response.status });
    }
    rec.exceptions = exceptions;
    rec.failedRequests = failedRequests.filter((f) => !/\/api\//.test(f.url));
    rec.consoleErrors = logErrors.filter((e) => !/\/api\//.test(e.url) && !/\/api\//.test(e.text));

    if (!observed) {
      rec.outcome = 'no-outcome';
      fail(entry.id + ': Run produced no outcome within ' + TIMEOUT_MS + 'ms (chip stayed ' + JSON.stringify(surface.chip) + '); a run that neither finishes nor explains itself is the failure this asserts against');
    } else if (entry.expectation === 'refuse') {
      rec.outcome = 'refused';
      if (!observed.code) fail(entry.id + ': the profile was marked unavailable before the run, but the refusal carried no SIMULATION_* code');
      if (observed.svg !== surface.svg) fail(entry.id + ': refused, yet the plot count moved (' + surface.svg + ' -> ' + observed.svg + '); something executed before the refusal');
      if (!observed.attention) fail(entry.id + ': refused, but the UI never said it needed attention');
    } else {
      const completed = /simulation-status-finished/.test(observed.chip || '') && /finished\s*·\s*completed/.test(observed.chipText || '');
      rec.outcome = completed ? 'completed' : 'failed';
      if (!completed) fail(entry.id + ': its profile is advertised, so it must complete; got chip=' + JSON.stringify(observed.chip) + ' text=' + JSON.stringify(observed.chipText) + ' code=' + JSON.stringify(observed.code));
      if (!(observed.svg > surface.svg)) fail(entry.id + ': completed without rendering anything (svg ' + surface.svg + ' -> ' + observed.svg + ')');
      if (observed.code) fail(entry.id + ': completed but left a problem code in the UI (' + observed.code + ')');
    }
    if (exceptions.length) fail(entry.id + ': ' + exceptions.length + ' uncaught error(s): ' + exceptions.slice(0, 2).join(' || '));
    if (rec.failedRequests.length) fail(entry.id + ': ' + rec.failedRequests.length + ' request(s) failed that are not /api/: ' + JSON.stringify(rec.failedRequests.slice(0, 3)));
    if (rec.consoleErrors.length) fail(entry.id + ': ' + rec.consoleErrors.length + ' console error(s) naming a non-/api/ resource: ' + JSON.stringify(rec.consoleErrors.slice(0, 3)));
    R.examples.push(rec);
    console.log('  ' + (['completed', 'refused', 'no-lab'].includes(rec.outcome) ? 'ok  ' : 'BAD ') + entry.id.padEnd(44) + ' ' +
      String(rec.outcome).padEnd(10) + ' expected=' + entry.expectation.padEnd(8) +
      ' profile=' + JSON.stringify(surface.profileLabel) + ' warned=' + JSON.stringify(marks.map((m) => m.label)) +
      ' identity=' + JSON.stringify(ready.circuitName) +
      ' svg=' + surface.svg + '->' + (observed ? observed.svg : '?') +
      ' code=' + JSON.stringify(observed ? observed.code : null) + ' stage=' + JSON.stringify(observed ? observed.stage : null) + '  ' + rec.ms + 'ms');
  }

  const tally = { complete: 0, refuse: 0, 'no-lab': 0 };
  for (const e of R.examples) if (e.outcome === 'completed') tally.complete++; else if (e.outcome === 'refused') tally.refuse++; else if (e.outcome === 'no-lab') tally['no-lab']++;
  R.branches = tally;
  console.log('example-outcomes: ' + tally.complete + ' completed, ' + tally.refuse + ' refused, ' + tally['no-lab'] + ' with no lab to run, of ' + R.examples.length);
  // A one-branch run cannot tell an honest refusal from a harness that cannot
  // see success, so the full sweep insists on both.
  const cover = (ok, msg) => { if (!ONLY.length && !ok) fail(msg); else if (ONLY.length && !ok) console.log('  WARNING: ' + msg + ' (focused run)'); };
  cover(tally.complete > 0, 'no example completed -- this harness cannot tell an honest refusal from a broken run');
  cover(tally.refuse > 0, 'no example refused -- the unavailable-profile path went untested here');
  ws.close();
} catch (e) {
  R.fatal = String((e && e.stack) || e);
  fail('driver threw: ' + R.fatal.slice(0, 400));
} finally {
  try { chrome.kill(); } catch {}
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  if (server) { try { server.kill(); } catch {} }
  await sleep(300);
}

const outPath = join(REPO_ROOT, 'example-outcomes-result.json');
try { writeFileSync(outPath, JSON.stringify(R, null, 2)); } catch {}

if (pass) {
  console.log('example-outcomes: PASS');
  process.exit(0);
} else {
  console.log('example-outcomes: FAIL  (full trace in ' + outPath + ')');
  process.exit(1);
}
