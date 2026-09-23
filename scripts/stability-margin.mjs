#!/usr/bin/env node
/**
 * Drive the panel and read a stability margin off the rendered page.
 *
 * scripts/stability-margin.oracle.mjs proves the EVALUATOR is numerically right
 * by extracting it from the shipped bytes and checking it against closed forms.
 * That is necessary and not sufficient. It cannot see whether the record the
 * evaluator returns is ever rendered, whether the unit reaches the screen, or
 * whether the row is reachable at all. An evaluator that computes a perfect
 * 87.3 deg phase margin, splices it into a list nobody draws, and is measured
 * only by the oracle, is a green pipeline with nothing on the other end.
 *
 * So this harness supplies the second channel, and it is careful about what it
 * can and cannot witness:
 *
 *   observed  the DOM. The rows the product actually draws for the two metrics,
 *             read as columns: the label, the formatted value, the status.
 *
 *   NOT       the numbers. Nothing on the page carries the run's raw complex
 *             response in a form an independent script can re-derive: the client
 *             reads result.json out of the worker's virtual filesystem and
 *             validates it in place, so any second margin computed here would
 *             have to come back through the same code. Numeric correctness is
 *             therefore the ORACLE's claim, made against closed forms and an
 *             independently written crossing search -- and this harness says so
 *             rather than manufacturing an agreement out of shared code.
 *
 * What that leaves is the claim the oracle cannot make, and it is not a small
 * one: the record the evaluator returns is DRAWN, under the metric's own name,
 * with the metric's own unit or with a reason beside it. An evaluator that
 * computes a perfect 87.3 deg phase margin, splices it into a list nobody
 * draws, and passes the oracle, is a green pipeline with nothing on the other
 * end.
 *
 * Two failure modes this harness has to survive, both of which it has already
 * been through once:
 *
 *   - Accusing the product of a defect that belongs to the reader. The panel's
 *     value column carries the formatted number AND its unit in one cell, and
 *     the head reads "Measurement" -- which does not contain "metric". A reader
 *     matching on /metric/ and looking for a separate unit column finds no
 *     table, and then reports... a pass. A row that could not be PARSED is
 *     reported as unparsed, never as absent.
 *   - Passing when it observed nothing. With no rows read and no expectation to
 *     disagree with, this harness used to print PASS. Every claim below is a
 *     hard requirement now.
 *
 * Usage
 *   node scripts/stability-margin.mjs [options]
 *
 *   --site=<dir>        Artifact to read and serve (default <repo>/site).
 *   --url=<url>         Drive an already-running deployment instead of starting
 *                       the preview server.
 *   --no-server         Do not start the preview server (requires --url).
 *   --port=<n>          Preview server port when starting one (default: random).
 *   --example=<id>      Which built-in lab to drive (default: the first whose
 *                       payload declares an AC setup).
 *   --fixture=<mode>    Serve a copy of the tree with a margin made DEFINED, so
 *                       the available-value branch of this harness is reached
 *                       instead of skipped. `center-magnitude` shifts each AC
 *                       magnitude curve so it is centred on 0 dB and must cross
 *                       it. The VALUE produced is a fixture (see the note by the
 *                       implementation); the claim is only that a defined margin
 *                       is drawn, under its own unit, and is counted.
 *   --timeout-ms=<n>    Deadline for one run (default 90000).
 *   --require           Fail (exit 1) if no browser is available. Default: skip.
 *
 * Exit codes
 *   0  pass (or skipped because no browser and not --require)
 *   1  a margin row was not drawn, was drawn in a shape no reader can trust, or
 *      was drawn under the wrong unit -- i.e. the rendered channel disagrees
 *      with what the artifact says it produced
 *   2  setup error -- the artifact did not offer what this harness needs to run
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const has = (n) => argv.some((a) => a === '--' + n);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};
const SITE = resolve(REPO_ROOT, opt('site', 'site'));
const WANT_EXAMPLE = opt('example', null);
const TIMEOUT_MS = Number(opt('timeout-ms', '90000'));
const NO_SERVER = has('no-server');
const REQUIRE = has('require');
const RESULT = join(REPO_ROOT, 'stability-margin-result.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const die = (msg, code = 2) => {
  console.error('stability-margin: SETUP ERROR -- ' + msg);
  process.exit(code);
};

if (!existsSync(join(SITE, 'assets'))) die('not an artifact tree: ' + SITE);

// --- optional fixture: make a margin DEFINED --------------------------------
//
// On the shipped artifact every margin this lab can produce is `unavailable`:
// its AC response never crosses 0 dB. So the ordinary run exercises only the
// refusal branch below. The branch that reads a VALUE, splits it from its unit
// and checks the unit is therefore never executed -- and a harness that cannot
// reach a branch is exactly the kind of green this repository keeps finding.
//
// --fixture=center-magnitude makes it reachable. It copies the tree, shifts
// each AC magnitude curve by -(max+min)/2 dB so the curve is centred on 0 dB and
// must cross it, and re-derives the shell-cache token so the copy is as
// self-consistent as a tree this repository would ship.
//
// What this mode does NOT do is vouch for the number. The offset is applied by
// the harness, so the value that appears is a fixture value. The oracle owns
// numeric correctness; this mode owns only "a DEFINED margin is drawn, under its
// own unit, and the panel counts it".
const FIXTURE = opt('fixture', null);
let SERVED_SITE = SITE;
let fixtureDir = null;
if (FIXTURE) {
  if (FIXTURE !== 'center-magnitude') die('unknown --fixture=' + FIXTURE + ' (expected center-magnitude)');
  fixtureDir = mkdtempSync(join(tmpdir(), 'stability-margin-fixture-'));
  const dst = join(fixtureDir, 'site');
  cpSync(SITE, dst, { recursive: true });
  // Locate the chunk by the sweep it shares with the evaluator, not by name:
  // chunk names carry a content hash and there are eight `src-*.js` files.
  const ANCHOR = 'l.push(t==null||n==null?null:Math.atan2(n,t)*180/Math.PI)}';
  const INJECTION = ANCHOR
    + '{const _f=c.filter(Number.isFinite);const _mx=Math.max(..._f),_mn=Math.min(..._f);'
    + 'const _off=-(_mx+_mn)/2;for(let _di=0;_di<c.length;_di++)if(c[_di]!=null)c[_di]+=_off}';
  let patched = 0;
  for (const f of readdirSync(join(dst, 'assets'))) {
    if (!f.endsWith('.js')) continue;
    const p = join(dst, 'assets', f);
    const text = readFileSync(p, 'utf8');
    const hits = text.split(ANCHOR).length - 1;
    if (hits === 0) continue;
    if (hits !== 1) die('the margin sweep anchor appears ' + hits + ' times in ' + f + ', so the fixture cannot be applied unambiguously');
    writeFileSync(p, text.replace(ANCHOR, INJECTION), 'utf8');
    patched++;
  }
  if (patched !== 1) die('expected exactly one chunk to carry the margin sweep, found ' + patched);
  const { shellCacheState, writeShellCacheToken } = await import('./shell-cache.mjs');
  writeShellCacheToken(dst, shellCacheState(dst).token);
  SERVED_SITE = dst;
  console.log('stability-margin: fixture=' + FIXTURE + '  copied to ' + dst);
}

// --- which lab to drive -----------------------------------------------------
//
// Read out of the artifact rather than written down: the catalog and each
// payload's setup list are in the shipped chunks, and a lab whose payload
// declares an AC analysis (a `.ac` directive in its testbench) is the one that
// can produce a Bode plot, which is the only kind of run that has a margin.
const assetsDir = join(SERVED_SITE, 'assets');
const chunkText = (name) => {
  const p = join(assetsDir, name);
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
};

function findExampleWithAc() {
  // The catalog binds each id to a payload accessor. Rather than re-parse the
  // minified accessors, ask each shipped JS chunk for catalog entries and then
  // look for an `ac` analysis directive in the same chunk.
  const catalog = [];
  for (const f of readdirSync(assetsDir)) {
    if (!f.endsWith('.js')) continue;
    const text = chunkText(f);
    const re = /\{id:`([a-z0-9-]+)`,name:`([^`]*)`[^}]*requiresUnlock:!(0|1)/g;
    for (const m of text.matchAll(re)) catalog.push({ id: m[1], name: m[2], file: f, text });
  }
  const withAc = [];
  for (const e of catalog) {
    const hasAc = /\.ac\b/.test(e.text) || /analysis:`ac`/.test(e.text) || /kind:`ac`/.test(e.text);
    if (hasAc) withAc.push(e);
  }
  return { catalog, withAc };
}

const { catalog, withAc } = findExampleWithAc();
if (!catalog.length) die('no catalog entries found in ' + assetsDir);
const target = WANT_EXAMPLE
  ? catalog.find((e) => e.id === WANT_EXAMPLE)
  : withAc[0];
if (!target) {
  die(WANT_EXAMPLE
    ? '--example=' + WANT_EXAMPLE + ' is not a catalog id (' + catalog.map((e) => e.id).join(', ') + ')'
    : 'no catalog entry appears to declare an AC setup, so no lab here can produce a Bode plot');
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
    console.error('stability-margin: no browser available and --require was set; install Chrome or drop --require');
    process.exit(1);
  }
  console.log('stability-margin: SKIP (no browser found; install Chrome/Chromium or pass --require)');
  process.exit(0);
}

function deriveBase() {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const p = new URL(pkg.homepage).pathname.replace(/\/?$/, '/');
    return p.startsWith('/') ? p : '/' + p;
  } catch { return '/'; }
}
const BASE = deriveBase();
const PREFIX = BASE.replace(/\/?$/, '/');

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
  if (NO_SERVER) die('--no-server requires --url');
  const port = Number(opt('port', String(9100 + Math.floor(Math.random() * 200))));
  server = spawn(process.execPath, [join(HERE, 'serve-local.mjs'), '--port=' + port, '--base=' + BASE, '--cache=public', '--site=' + SERVED_SITE],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  server.stderr.on('data', (d) => { err += d.toString(); });
  // PREFIX already ends in '/', so appending another one produces
  // "<base>//?example=..." and a router that has to tolerate the empty segment
  // before it will open the lab. One trailing slash, not two.
  if (!(await waitForServer('http://127.0.0.1:' + port + PREFIX, 15000))) {
    try { server.kill(); } catch {}
    die('preview server did not come up; stderr=' + err.slice(0, 600));
  }
  TARGET_URL = 'http://127.0.0.1:' + port + PREFIX;
}

const profile = mkdtempSync(join(tmpdir(), 'stability-margin-'));
const DP = 9700 + Math.floor(Math.random() * 200);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DP}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-default-apps',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--window-size=1600,1000', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

// --- page probes ------------------------------------------------------------
//
// Everything below is read off the rendered page, and nothing is computed from
// the chunk: the chunk's evaluator is half of what is under test, so a number
// derived from it would agree with itself.
const READY_JS = `({
  path: location.pathname + location.search,
  openedExample: /Opened example:/.test(document.body ? document.body.innerText : ''),
  runButton: !!document.querySelector('button.simulation-run-button'),
})`;

const OPEN_SIM_JS = `(function () {
  const b = [...document.querySelectorAll('button,[role=button],[role=tab]')].find((e) =>
    /analog simulation/i.test([e.getAttribute('title'), e.getAttribute('aria-label'), e.textContent].filter(Boolean).join(' ')));
  if (!b) return 'no-toggle';
  if (b.getAttribute('aria-expanded') === 'true' || document.querySelector('button.simulation-run-button')) return 'already-open';
  b.click();
  return 'clicked';
})()`;

const CHIP_JS = `(function () {
  const chip = document.querySelector('.simulation-status-chip');
  return chip ? { cls: chip.className, text: (chip.textContent || '').trim() } : null;
})()`;

const CLICK_RUN_JS = `(function () {
  const b = [...document.querySelectorAll('button.simulation-run-button')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (!b.length) return 'missing';
  if (b.length > 1) return 'ambiguous:' + b.length;
  b[0].click();
  return 'clicked';
})()`;

/**
 * The rendered measurement rows.
 *
 * Read as columns, because the panel draws one table per output with a
 * "Measurement" head and a "Value" head, and the value cell carries the
 * formatted number AND its unit together ("95.88 deg"). Splitting the number
 * from its trailing unit token is what makes the unit check meaningful: a phase
 * margin printed against the output's unit has the same number in the same cell
 * and "V" where "deg" belongs.
 *
 * Two traps, both of which this reader has already fallen into:
 *
 *   - /metric/ does not match "Measurement". The first version required a head
 *     matching /metric/ and a separate unit column, matched no table at all, and
 *     fell through to the text scan below -- which is why the fallback exists,
 *     and why a fallback row is `unparsed` rather than absent. A reader that
 *     cannot read the page must not be mistaken for a page with nothing on it.
 *   - `data-status` on the row is the panel's own attribute; it is recorded but
 *     the status is derived from the value text, because that is what a reader
 *     of the panel sees.
 */
const MARGIN_ROWS_JS = `(function () {
  const WANT = [
    { metric: 'phase-margin', re: /phase[\\s_-]*margin/i },
    { metric: 'gain-margin', re: /gain[\\s_-]*margin/i },
  ];
  const rows = [];
  for (const t of [...document.querySelectorAll('table')]) {
    const head = [...t.querySelectorAll('thead th, tr:first-child th, tr:first-child td')]
      .map((c) => (c.textContent || '').trim().toLowerCase());
    const mIdx = head.findIndex((h) => /measurement|metric/.test(h));
    const vIdx = head.findIndex((h) => /value/.test(h));
    if (mIdx < 0 || vIdx < 0) continue;
    for (const tr of [...t.querySelectorAll('tbody tr')]) {
      const cells = [...tr.querySelectorAll('td')].map((c) => (c.textContent || '').trim());
      if (cells.length <= Math.max(mIdx, vIdx)) continue;
      const label = cells[mIdx];
      const hit = WANT.find((w) => w.re.test(label));
      if (!hit) continue;
      const raw = cells[vIdx];
      rows.push({
        metric: hit.metric,
        label,
        value: raw,
        status: /^unavailable\\b/i.test(raw) ? 'unavailable'
          : (/^\\s*-?[\\d.]/.test(raw) ? 'available' : 'unparsed'),
        how: 'table',
        rowStatus: tr.getAttribute('data-status') || null,
      });
    }
  }
  // A text-level hit means the product DID render this metric's name; it just is
  // not in the table shape this reader reads. Reported as unparsed rather than
  // as absent, so a layout drift is not dressed up as a product defect.
  if (!rows.length) {
    const text = document.body ? document.body.innerText : '';
    for (const w of WANT) {
      if (!w.re.test(text)) continue;
      rows.push({ metric: w.metric, label: w.metric, value: null, status: 'unparsed', how: 'text', rowStatus: null });
    }
  }
  return rows;
})()`;

/**
 * The panel's own count of what it drew.
 *
 * The summary line reads "<n> values · <m> unavailable". A margin row that is
 * drawn but not counted means the summary and the tables disagree about what the
 * run produced -- the same kind of silent disagreement that let the first
 * version of this patch discard every measurement while looking healthy.
 */
const PANEL_COUNTS_JS = `(function () {
  const panel = document.querySelector('.simulation-measurement-results');
  if (!panel) return null;
  const text = panel.textContent || '';
  const v = /(\\d+)\\s+values?/.exec(text);
  const u = /(\\d+)\\s+unavailable/.exec(text);
  return {
    values: v ? Number(v[1]) : null,
    unavailable: u ? Number(u[1]) : null,
    tables: panel.querySelectorAll('table').length,
  };
})()`;

// --- CDP --------------------------------------------------------------------
const R = {
  site: SERVED_SITE, url: TARGET_URL, chrome: CHROME, example: target.id, exampleName: target.name,
  fixture: FIXTURE, observed: null, rendered: null, panelCounts: null, errors: [], pass: true,
};
let pass = true;
const fail = (msg) => { pass = false; console.log('  FAIL: ' + msg); };

let ver = null;
for (let i = 0; i < 60 && !ver; i++) {
  try { const r = await fetch('http://127.0.0.1:' + DP + '/json/version'); if (r.ok) ver = await r.json(); } catch {}
  await sleep(250);
}
if (!ver) {
  try { chrome.kill(); } catch {}
  if (server) { try { server.kill(); } catch {} }
  die('devtools never came up; stderr=' + chromeErr.slice(0, 600));
}

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

const cleanup = () => {
  try { chrome.kill(); } catch {}
  if (server) { try { server.kill(); } catch {} }
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  if (fixtureDir) { try { rmSync(fixtureDir, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
};
const setupError = async (msg) => {
  console.error('stability-margin: SETUP ERROR -- ' + msg);
  R.errors.push({ kind: msg });
  writeFileSync(RESULT, JSON.stringify(R, null, 2), 'utf8');
  cleanup();
  process.exit(2);
};

const UNLOCK_KEY = 'spice-simulator:gallery-unlocked';

console.log('stability-margin: browser=' + CHROME);
console.log('stability-margin: site=' + SERVED_SITE + '  url=' + TARGET_URL);
console.log('stability-margin: example=' + target.id + ' (' + target.name + ')');

{
  const from0 = events.length;
  await send('Page.navigate', { url: TARGET_URL }, sessionId);
  await waitForLoad(from0, 20000);
  await sleep(1000);
  await evalv(`(function(){try{localStorage.setItem(${JSON.stringify(UNLOCK_KEY)},'1');}catch(e){}return 1;})()`);

  const url = TARGET_URL + '?example=' + encodeURIComponent(target.id);
  const from = events.length;
  await send('Page.navigate', { url }, sessionId);
  await waitForLoad(from, 20000);

  const want = '?example=' + target.id;
  const ready = await poll(async () => {
    const r = await evalv(READY_JS);
    if (!r || r.__error) return null;
    if (!r.path.endsWith(want)) return null;
    if (!r.openedExample) return null;
    return r;
  }, 30000, 600);
  if (!ready) await setupError('?example=' + target.id + ' never opened');

  let hasRun = ready.runButton;
  if (!hasRun) {
    await evalv(OPEN_SIM_JS);
    hasRun = await poll(async () => {
      const r = await evalv(READY_JS);
      return r && r.runButton ? r : null;
    }, 8000, 400);
  }
  if (!hasRun) await setupError('the simulation surface never offered a Run control for ' + target.id);

  const before = await evalv(CHIP_JS);
  if (!before || !/simulation-status-idle/.test(before.cls || '')) {
    await setupError('status chip was ' + JSON.stringify(before) + ' before the run, so a new result cannot be told from a stale one');
  }

  const clicked = await evalv(CLICK_RUN_JS);
  if (clicked !== 'clicked') await setupError('could not press Run: ' + JSON.stringify(clicked));

  // Two waits, in order, and the order is the point.
  //
  // The chip is `idle` BEFORE the run, and it can keep reading `idle` -- with
  // the text "Preparing…" -- after the click, while the engine is being brought
  // up. So `idle` is NOT a settled state. Accepting it lets this harness return
  // before the run has begun, read a panel that has not been drawn yet, and
  // blame the product for rendering nothing. It did exactly that on the first
  // synthetic tree: four failures logged against an application that had not
  // started. That is the same mistake as the /metric/ regex a few lines up --
  // a reader that cannot see must report that it cannot see, not that there is
  // nothing there.
  //
  // So: first the chip must LEAVE the pre-run state. A run that finishes faster
  // than one poll still satisfies this, because `finished` is also not `idle`.
  // Then it must reach a terminal state; `running` and `cancelling` are
  // transient and are waited through rather than read.
  const leftIdle = await poll(async () => {
    const c = await evalv(CHIP_JS);
    if (!c) return null;
    return /simulation-status-idle/.test(c.cls || '') ? null : c;
  }, TIMEOUT_MS, 300);
  if (!leftIdle) {
    const last = await evalv(CHIP_JS);
    await setupError('the run never left the pre-run state within ' + TIMEOUT_MS + 'ms, so no measurement was ever going to be drawn (last chip: ' + JSON.stringify(last) + ')');
  }
  const settled = /simulation-status-(finished|failed|error)/.test(leftIdle.cls || '')
    ? leftIdle
    : await poll(async () => {
        const c = await evalv(CHIP_JS);
        if (!c) return null;
        if (/simulation-status-(finished|failed|error)/.test(c.cls || '')) return c;
        return null;
      }, TIMEOUT_MS, 400);
  if (!settled) await setupError('the run did not settle within ' + TIMEOUT_MS + 'ms (last chip: ' + JSON.stringify(await evalv(CHIP_JS)) + ')');
  // A run that ended in failure draws no measurements, so the absence of a
  // margin row says nothing about the margin. Reported as a setup failure, not
  // as a product defect.
  if (/simulation-status-(failed|error)/.test(settled.cls || '')) {
    await setupError('the run ended as ' + JSON.stringify(settled.text) + ', so no AC data existed to measure; this harness needs a completed run');
  }
  R.chipAfter = settled;
  console.log('  run settled: ' + JSON.stringify(settled.text) + ' class=' + settled.cls);

  // The panel reports a problem next to the chip when the run needs attention.
  // That is not necessarily fatal to this harness -- a margin can still be
  // computed if the AC analysis produced data -- so it is recorded and the run
  // is allowed to proceed to the evidence channel, where the truth is.
  const attention = await evalv(`/needs attention/i.test(document.body ? document.body.innerText : '')`);
  R.needsAttention = attention === true;
  if (attention === true) console.log('  note: the panel says "Simulation needs attention" after the run');

  // --- the rendered channel ---
  const rows = await evalv(MARGIN_ROWS_JS);
  R.observed = rows;
  if (!Array.isArray(rows)) await setupError('could not read the measurement rows off the page: ' + JSON.stringify(rows));
  for (const r of rows) {
    console.log('  rendered: ' + JSON.stringify(r.label) + ' = ' + JSON.stringify(r.value) + ' status=' + r.status);
  }
  R.rendered = rows.map((r) => ({ metric: r.metric, label: r.label, value: r.value, status: r.status, how: r.how }));

  // 1. Something with the metric's name is on the page at all. This is the whole
  //    point of the channel: the oracle cannot see the screen, and a margin that
  //    is computed and never drawn passes every other check in this repository.
  if (!rows.length) {
    fail('no stability-margin row is rendered anywhere on the page, though the artifact computes one');
  } else if (!rows.some((r) => r.how === 'table')) {
    // Located by text but not in the table shape this reader reads: a fact about
    // the reader, not about the product, and it must not be reported as a pass.
    fail('the margin rows are on the page but not in the measurement-table shape this reader reads (layout drift?)');
  }

  // 1b. In fixture mode the value branch MUST have been taken, or this mode
  //     bought nothing: it exists precisely so that the unit check below runs at
  //     least once instead of being skipped on a tree where every margin is a
  //     refusal.
  if (FIXTURE && !rows.some((r) => r.how === 'table' && r.status === 'available')) {
    fail('--fixture=' + FIXTURE + ' should have made a margin DEFINED, but every margin row is still a refusal -- the value branch went unexercised');
  }

  // 2. Both metrics, and each row one of exactly two shapes.
  for (const spec of [
    { metric: 'phase-margin', unit: 'deg', unitRe: /^(deg|°|degree)s?$/i },
    { metric: 'gain-margin', unit: 'dB', unitRe: /^(db|decibel)s?$/i },
  ]) {
    const got = rows.filter((r) => r.metric === spec.metric && r.how === 'table');
    if (!got.length) {
      fail('no ' + spec.metric + ' row is rendered as a measurement, though the artifact computes one');
      continue;
    }
    for (const r of got) {
      if (r.status === 'available') {
        // A number has to be a number, and it has to be against the metric's own
        // unit. "90.57 V" has the right number in the right place and is wrong.
        const parsed = /^\s*(-?[\d.]+(?:[eE][+-]?\d+)?)\s*(.*?)\s*$/.exec(String(r.value));
        if (!parsed) {
          fail(spec.metric + ' renders ' + JSON.stringify(r.value) + ', which is not a number against a unit');
          continue;
        }
        if (!spec.unitRe.test(parsed[2])) {
          fail(spec.metric + ' renders unit ' + JSON.stringify(parsed[2]) + ', which is not ' + spec.unit);
        }
      } else if (r.status === 'unavailable') {
        // A refusal has to SAY something. "Unavailable" with no reason is a row
        // that tells the reader nothing about why their margin is missing.
        const reason = String(r.value).replace(/^\s*unavailable\s*[·:—-]?\s*/i, '').trim();
        if (reason.length < 15) fail(spec.metric + ' is unavailable and renders no reason: ' + JSON.stringify(r.value));
      } else {
        fail(spec.metric + ' renders ' + JSON.stringify(r.value) + ', which is neither a value nor a refusal');
      }
      // The output's unit on a margin is the failure this repository keeps
      // finding: populated, plausible, wrong.
      if (/^\s*-?[\d.]+\s*(v|mv|µv|uv|kv|a|ma|µa|ua|ka)\s*$/i.test(String(r.value))) {
        fail(spec.metric + ' renders against the output unit: ' + JSON.stringify(r.value));
      }
    }
  }

  // 3. The panel's own summary counts what it drew.
  const counts = await evalv(PANEL_COUNTS_JS);
  R.panelCounts = counts;
  const drawn = rows.filter((r) => r.how === 'table').length;
  if (counts) {
    console.log('  panel counts: ' + JSON.stringify(counts));
    if (Number.isFinite(counts.values) && counts.values < drawn) {
      fail('the panel counts ' + counts.values + ' measurement value(s) but draws ' + drawn + ' margin row(s)');
    }
    if (!Number.isFinite(counts.values)) {
      fail('could not read a value count out of the measurements panel: ' + JSON.stringify(counts));
    }
  } else {
    fail('the measurements panel is not on the page, so the margin rows cannot be part of it');
  }
}

R.pass = pass;
writeFileSync(RESULT, JSON.stringify(R, null, 2), 'utf8');
cleanup();

console.log('');
console.log('stability-margin: ' + (pass ? 'PASS' : 'FAIL') + '  (detail in stability-margin-result.json)');
process.exit(pass ? 0 : 1);
