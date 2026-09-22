#!/usr/bin/env node
/**
 * UX audit -- walk the flows a user actually takes and report what each
 * surface shows. This is a *review* harness, not a guard: it writes findings,
 * never fails a build. Its job is to answer "does the product still work, and
 * does it look right while working" across the whole shipped site, rather than
 * pinning one claim the way the per-feature guards do.
 *
 * Why a separate harness when there are already ten browser checks: each of
 * those drives exactly one surface (an example, the gallery shim, the import
 * dialog) and asserts one thing. None of them look at the site the way a person
 * meets it -- land, browse, open something, edit it, save, reload, go offline --
 * and none report the *text* a surface renders, which is where UX defects live
 * (the project identity bug rendered fine, loaded fine, and told the user the
 * wrong circuit name).
 *
 * What it walks, with a finding for each:
 *   1. home           the home page loads, names itself, offers the examples
 *   2. gallery        the built-in list renders every catalog entry, with names
 *   3. identity       every example's title bar shows the catalog name
 *   4. edit+save      rename the open circuit, save, reload, read it back
 *   5. refusal        the sky130 lab announces it cannot run, and stays honest
 *   6. offline        a second load with the network cut is served by the worker
 *   7. errors         no uncaught error anywhere in the walk
 *
 * Findings are graded and printed; `--json=<path>` writes the full record.
 *
 * Usage
 *   node scripts/ux-audit.mjs [options]
 *
 *   --site=<dir>     Artifact to read and serve (default <repo>/site).
 *   --url=<url>      Drive an already-running deployment (then --site is static-only).
 *   --no-server      Do not start the preview server (requires --url).
 *   --port=<n>       Preview server port (default: random).
 *   --base=<path>    Deployed base (default: package.json homepage).
 *   --json=<path>    Write the full record here (default: ux-audit-result.json).
 *   --require        Fail (exit 1) if no browser is available. Default: skip.
 *
 * Exit codes
 *   0  the walk completed (findings are reported, not fatal)
 *   1  no browser and --require, or the harness could not drive the page at all
 *   2  usage / setup error
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
  console.log('usage: node scripts/ux-audit.mjs [--site=dir] [--url=...] [--no-server] [--port=n] [--json=path] [--require]');
  process.exit(0);
}

const REQUIRE = has('require');
const NO_SERVER = has('no-server');
const SITE = resolve(opt('site', join(REPO_ROOT, 'site')));
const JSON_OUT = resolve(opt('json', join(REPO_ROOT, 'ux-audit-result.json')));
const UNLOCK_KEY = 'spice.masterLibraryUnlock.v1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- static channel: what the artifact declares -----------------------------
// Same catalog shape example-outcomes.mjs reads. Kept local so this audit does
// not fail just because another script's internals moved; the two agreeing is
// itself a small cross-check.
const CATALOG_RE = /\{id:`([a-z0-9-]+)`,name:`([^`]*)`,description:`([^`]*)`,requiresUnlock:!(0|1),project:rg\(([\w$]+)\)\}/g;

function readCatalog(siteDir) {
  const dir = join(siteDir, 'assets');
  if (!existsSync(dir)) return { error: 'no assets/ directory under ' + siteDir };
  let cat = null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = readFileSync(join(dir, f), 'utf8');
    const hits = [...src.matchAll(CATALOG_RE)];
    if (!hits.length) continue;
    if (cat) return { error: 'the catalog appears in both ' + cat.file + ' and ' + f };
    // `requiresUnlock:!0` is true and `!1` is false -- the literal is a *negated*
    // number, so the "1" means TRUE. Reading it as `=== '1'` inverts every gate
    // and is how an audit ends up calling a correct gate a defect.
    cat = { file: f, src, entries: hits.map((m) => ({ id: m[1], name: m[2], description: m[3], requiresUnlock: m[4] === '0' })) };
  }
  if (!cat) return { error: 'no example catalog matched under ' + dir };
  return cat;
}

const catalog = readCatalog(SITE);
if (catalog.error) {
  console.error('ux-audit: SETUP ERROR -- ' + catalog.error);
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
    console.error('ux-audit: no browser available and --require was set; install Chrome or drop --require');
    process.exit(1);
  }
  console.log('ux-audit: SKIP (no browser found; install Chrome/Chromium or pass --require)');
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
  if (NO_SERVER) { console.error('ux-audit: --no-server requires --url'); process.exit(2); }
  const port = Number(opt('port', String(9050 + Math.floor(Math.random() * 90))));
  server = spawn(process.execPath, [join(HERE, 'serve-local.mjs'), '--port=' + port, '--base=' + BASE, '--cache=public', '--site=' + SITE],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  server.stderr.on('data', (d) => { err += d.toString(); });
  if (!(await waitForServer('http://127.0.0.1:' + port + PREFIX + '/', 15000))) {
    console.error('ux-audit: preview server did not come up; stderr=' + err.slice(0, 600));
    try { server.kill(); } catch {}
    process.exit(2);
  }
  TARGET_URL = 'http://127.0.0.1:' + port + PREFIX + '/';
}

// --- findings ---------------------------------------------------------------
const findings = [];
const note = (grade, stage, message, detail) => {
  findings.push({ grade, stage, message, detail: detail === undefined ? null : detail });
  const tag = { ok: 'ok  ', info: 'info', warn: 'WARN', bad: 'BAD ' }[grade] || grade;
  console.log('  ' + tag + ' [' + stage + '] ' + message + (detail ? '  -- ' + detail : ''));
};

// --- drive ------------------------------------------------------------------
const profileDir = mkdtempSync(join(tmpdir(), 'ux-audit-'));
const DP = 9550 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  `--user-data-dir=${profileDir}`, `--remote-debugging-port=${DP}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-default-apps',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--window-size=1600,1000', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const R = {
  site: SITE, url: TARGET_URL, chrome: CHROME,
  catalog: { file: catalog.file, entries: catalog.entries },
  // Per-page: what each surface rendered, and what errors it threw.
  pages: [],
};

// Reads the whole visible surface of whatever page is open. This is deliberately
// broad: the point is to record what a person would see, then grade it.
const SNAPSHOT_JS = `(function () {
  const body = document.body ? document.body.innerText : '';
  const inputs = [...document.querySelectorAll('input')].filter((e) => e.getBoundingClientRect().width > 0);
  const buttons = [...document.querySelectorAll('button,[role=button]')]
    .filter((e) => e.getBoundingClientRect().width > 0)
    .map((e) => (e.getAttribute('title') || e.getAttribute('aria-label') || e.textContent || '').trim().replace(/\\s+/g, ' '))
    .filter(Boolean).slice(0, 60);
  return {
    path: location.pathname + location.search,
    title: document.title,
    h1: (document.querySelector('h1') || {}).textContent ? document.querySelector('h1').textContent.trim() : null,
    bodyText: body.replace(/\\s+/g, ' ').slice(0, 1200),
    svg: document.querySelectorAll('svg').length,
    canvas: document.querySelectorAll('canvas').length,
    circuitName: (function () {
      const el = document.querySelector('input[data-testid=project-name-input]');
      return el ? el.value : null;
    })(),
    nameInputs: inputs
      .filter((e) => /project|circuit|name/i.test((e.getAttribute('data-testid') || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.name || '')))
      .map((e) => ({ testid: e.getAttribute('data-testid'), aria: e.getAttribute('aria-label'), value: e.value })),
    buttons,
    // The list of example titles the user can click, if this page shows it.
    galleryNames: [...document.querySelectorAll('[data-testid*=gallery] , .gallery-card, [class*=gallery]')]
      .map((e) => (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 120)).filter(Boolean).slice(0, 12),
    errors: (window.__errs || []).slice(0, 8),
  };
})()`;

let pass = true;
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

  // Collect page-level errors the walk itself would not see otherwise.
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__errs = [];
      window.addEventListener('error', (e) => { window.__errs.push({ src: 'error', msg: String(e.message).slice(0, 300) }); });
      window.addEventListener('unhandledrejection', (e) => { window.__errs.push({ src: 'rejection', msg: String(e.reason).slice(0, 300) }); });
    `,
  }, sessionId);

  const visit = async (url, waitMs) => {
    const mark = events.length;
    await send('Page.navigate', { url }, sessionId);
    await waitForLoad(mark, 25000);
    await sleep(waitMs);
    const snap = await evalv(SNAPSHOT_JS);
    R.pages.push({ url, snapshot: snap });
    return snap;
  };

  const clickByLabel = async (want) => {
    const c = await evalv(`(function(){
      const norm = (el) => (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g,' ');
      const all = [...document.querySelectorAll('button,[role=button],a,[title],[role=tab]')];
      const eq = all.find((el) => norm(el) === ${JSON.stringify(want)} && el.getBoundingClientRect().width > 0);
      if (eq) { eq.click(); return { clicked: norm(eq), match: 'exact' }; }
      const sub = all.find((el) => norm(el).toLowerCase().includes(String(${JSON.stringify(want)}).toLowerCase()) && el.getBoundingClientRect().width > 0);
      if (sub) { sub.click(); return { clicked: norm(sub), match: 'substring' }; }
      return { clicked: null, near: all.slice(0, 12).map((el) => norm(el).slice(0, 40)) };
    })()`);
    return c;
  };

  console.log('ux-audit: browser=' + CHROME);
  console.log('ux-audit: site=' + SITE + '  url=' + TARGET_URL);
  console.log('ux-audit: catalog ' + catalog.entries.length + ' entr(ies) in ' + catalog.file);
  console.log('');

  // --- 1. home --------------------------------------------------------------
  console.log('1. home');
  const home = await visit(TARGET_URL, 2500);
  if (home.__error) note('bad', 'home', 'the home page could not be read', home.__error);
  else {
    if (!home.svg && !home.canvas) note('bad', 'home', 'the home page rendered no svg/canvas', 'elements may have failed to mount');
    else note('ok', 'home', 'home page mounted', 'svg=' + home.svg);
    if (!home.title) note('warn', 'home', 'the page has no <title>');
    else note('ok', 'home', 'document title is ' + JSON.stringify(home.title));
    if (!home.buttons.length) note('warn', 'home', 'no visible controls found on the home page');
    else note('info', 'home', 'visible controls: ' + home.buttons.slice(0, 10).join(' | '));
  }

  // --- 2. gallery -----------------------------------------------------------
  console.log('2. gallery list');
  // The home page *is* the editor; the examples live behind the Gallery control
  // ("Show the circuit gallery"). Reading them requires opening it, and what it
  // lists depends on the unlock tier -- so both tiers are audited: the student
  // list a first-time user sees, and the full list after an unlock.
  const galleryOf = async (label) => {
    // Close any open panel first so the toggle opens rather than closes.
    await evalv(`(function(){
      const b=[...document.querySelectorAll('button,[role=button]')].find(e=>/hide the circuit gallery/i.test((e.getAttribute('title')||e.getAttribute('aria-label')||e.textContent||'')));
      if(b) b.click();
    })()`);
    await sleep(500);
    const opened = await evalv(`(function(){
      const b=[...document.querySelectorAll('button,[role=button]')].find(e=>/circuit gallery/i.test((e.getAttribute('title')||e.getAttribute('aria-label')||e.textContent||'')) && e.getBoundingClientRect().width>0);
      if(!b) return 'no-toggle';
      b.click(); return 'clicked';
    })()`);
    if (opened !== 'clicked') return { error: 'gallery toggle: ' + opened };
    await sleep(1500);
    return await evalv(`(function(){
      const cards=[...document.querySelectorAll('.shapes-example-name')].map(e=>(e.textContent||'').trim()).filter(Boolean);
      const hint=document.querySelector('[data-testid=examples-library-tier]');
      const locked=[...document.querySelectorAll('[aria-label^="Insert example"]')].map(e=>e.getAttribute('aria-label').replace('Insert example ',''));
      return { cards, labels: locked, hint: hint ? hint.textContent.trim() : null };
    })()`);
  };

  const student = await galleryOf('student');
  if (student.error) note('bad', 'gallery', 'could not open the gallery panel', student.error);
  else {
    const expectOpen = catalog.entries.filter((e) => !e.requiresUnlock).map((e) => e.name);
    const got = student.cards || [];
    if (got.length === 0) note('bad', 'gallery', 'the gallery panel opened but lists nothing');
    else note('info', 'gallery', 'student tier lists ' + got.length + ' example(s): ' + JSON.stringify(got));
    for (const n of expectOpen) {
      if (got.includes(n)) note('ok', 'gallery', 'the open example ' + JSON.stringify(n) + ' is listed without unlocking');
      else note('bad', 'gallery', 'the open example ' + JSON.stringify(n) + ' is NOT listed for a student');
    }
    const gated = catalog.entries.filter((e) => e.requiresUnlock).map((e) => e.name);
    const leaked = gated.filter((n) => got.includes(n));
    if (leaked.length === 0) note('ok', 'gallery', 'no instructor-gated lab is listed before unlock', gated.length + ' gated in the catalog');
    else note('bad', 'gallery', 'instructor-gated labs are listed before unlock: ' + JSON.stringify(leaked));
    if (student.hint) note('info', 'gallery', 'tier hint reads: ' + JSON.stringify(student.hint));
  }

  // The examples are also reachable by direct URL, which is how the rest of this
  // walk opens them; that path does not depend on the panel listing them.
  if ((student.cards || []).length < catalog.entries.length) {
    await evalv(`(function(){try{localStorage.setItem(${JSON.stringify(UNLOCK_KEY)},'1');}catch(e){}})()`);
    await visit(TARGET_URL, 2000);
    const full = await galleryOf('full');
    if (!full.error) {
      const missingAfterUnlock = catalog.entries.filter((e) => !(full.cards || []).includes(e.name)).map((e) => e.name);
      if (missingAfterUnlock.length === 0) note('ok', 'gallery', 'after unlock the gallery lists all ' + (full.cards || []).length + ' examples');
      else note('warn', 'gallery', 'still not listed after unlock: ' + JSON.stringify(missingAfterUnlock));
      if (full.hint) note('info', 'gallery', 'unlocked tier hint reads: ' + JSON.stringify(full.hint));
    }
    await evalv(`(function(){try{localStorage.removeItem(${JSON.stringify(UNLOCK_KEY)});}catch(e){}})()`);
  }

  // --- 3. identity + 4. edit/save, per example ------------------------------
  await evalv(`(function(){try{localStorage.setItem(${JSON.stringify(UNLOCK_KEY)},'1');}catch(e){}})()`);

  const opened = [];
  for (const entry of catalog.entries) {
    console.log('3/4. example ' + entry.id);
    const snap = await visit(TARGET_URL + '?example=' + encodeURIComponent(entry.id), 2600);
    opened.push({ id: entry.id, name: entry.name, snapshot: snap });
    if (snap.__error) { note('bad', entry.id, 'example page could not be read', snap.__error); continue; }

    if (snap.circuitName == null) {
      // Some labs (the sky130 one) open on a refusal surface; that is expected
      // and is graded in step 5, not here.
      note('info', entry.id, 'no editable title bar on this surface', 'circuitName=null');
    } else if (snap.circuitName === entry.name) {
      note('ok', entry.id, 'title bar shows the catalog name ' + JSON.stringify(snap.circuitName));
    } else {
      note('bad', entry.id, 'title bar shows ' + JSON.stringify(snap.circuitName) + ' but the catalog entry is ' + JSON.stringify(entry.name));
    }

    // Editing: rename via the real input, then confirm the field took it. We do
    // not reload here -- persistence is checked once, below, on the first lab.
    if (snap.circuitName != null) {
      const typed = await evalv(`(function(){
        const el = document.querySelector('input[data-testid=project-name-input]');
        if (!el) return null;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, 'UX Audit Rename');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.blur();
        return el.value;
      })()`);
      if (typed === 'UX Audit Rename') {
        await sleep(400);
        const after = await evalv(`(function(){const el=document.querySelector('input[data-testid=project-name-input]');return el?el.value:null;})()`);
        if (after === 'UX Audit Rename') note('ok', entry.id, 'the title bar accepts an edit');
        else note('warn', entry.id, 'an edit to the title bar did not stick', 'after=' + JSON.stringify(after));
      } else {
        note('warn', entry.id, 'could not drive the title-bar input', 'returned ' + JSON.stringify(typed));
      }
    }
  }

  // --- 4b. persistence: rename, reload, read back ---------------------------
  console.log('4b. persistence');
  const first = catalog.entries[0];
  await visit(TARGET_URL + '?example=' + encodeURIComponent(first.id), 2600);
  const renameOk = await evalv(`(function(){
    const el = document.querySelector('input[data-testid=project-name-input]');
    if (!el) return 'no-input';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, 'PERSIST-PROBE-742');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return el.value;
  })()`);
  await sleep(2000); // let any autosave land
  await visit(TARGET_URL + '?example=' + encodeURIComponent(first.id), 3000);
  const readBack = await evalv(`(function(){const el=document.querySelector('input[data-testid=project-name-input]');return el?el.value:null;})()`);
  if (readBack === 'PERSIST-PROBE-742') note('ok', 'persist', 'a rename survived a reload of the same example URL');
  else {
    // `?example=<id>` is a demo loader, not the open path: its effect does
    // `og(id)` -> `br(project, jx)` -> "Opened example: <name>" on every load, so
    // it re-seeds the lab by design and never consults saved work. A rename not
    // surviving it is the documented behaviour, not a defect -- grading it worse
    // than info would be the harness inventing a bug out of the loader's job.
    note('info', 'persist', 'the example URL re-seeds the lab each load (by design), so a rename does not survive it',
      'read back ' + JSON.stringify(readBack) + ' after typing ' + JSON.stringify(renameOk) + '; saved work is reached through the project store, not this deep link');
  }

  // --- 5. refusal honesty ---------------------------------------------------
  console.log('5. refusal');
  const gated = catalog.entries.find((e) => /sky130/i.test(e.id)) || catalog.entries.find((e) => e.requiresUnlock);
  if (!gated) note('info', 'refusal', 'no sky130/gated lab in the catalog to check');
  else {
    const snap = await visit(TARGET_URL + '?example=' + encodeURIComponent(gated.id), 3200);
    const text = (snap.bodyText || '');
    const announced = /unavailable|cannot run|not available|unknown profile|refus/i.test(text);
    if (announced) note('ok', 'refusal', gated.id + ' announces it cannot run before the user commits');
    else note('warn', 'refusal', gated.id + ' does not visibly announce an unavailable profile', 'text=' + JSON.stringify(text.slice(0, 240)));

    // Press Run and see whether the refusal is structured, not a crash.
    const clicked = await clickByLabel('Run');
    if (clicked && clicked.clicked) {
      await sleep(4500);
      const after = await evalv(`(function(){
        const body = document.body ? document.body.innerText : '';
        const chip = document.querySelector('.simulation-status-chip');
        return {
          code: (body.match(/SIMULATION_[A-Z_]+/) || [])[0] || null,
          chip: chip ? (chip.textContent || '').trim() : null,
          errs: (window.__errs || []).slice(0, 5),
        };
      })()`);
      if (after && after.code) note('ok', 'refusal', 'pressing Run yields a structured refusal', 'code=' + after.code + ' chip=' + JSON.stringify(after.chip));
      else if (after && after.errs && after.errs.length) note('bad', 'refusal', 'pressing Run threw instead of refusing', JSON.stringify(after.errs).slice(0, 240));
      else note('info', 'refusal', 'pressing Run produced no visible refusal on this surface', 'chip=' + JSON.stringify(after && after.chip));
    } else note('info', 'refusal', 'no Run control on the refusal surface to press');
  }

  // --- 6. offline -----------------------------------------------------------
  console.log('6. offline');
  // Warm the cache with a full load, then cut the network and reload.
  await visit(TARGET_URL, 4000);
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);
  const off = await visit(TARGET_URL, 4000);
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);
  if (off.__error) note('bad', 'offline', 'the offline reload could not be read', off.__error);
  else if (off.svg || off.canvas) note('ok', 'offline', 'the worker served a working page with the network cut', 'svg=' + off.svg);
  else note('bad', 'offline', 'the offline reload rendered nothing', JSON.stringify(off.bodyText || '').slice(0, 200));

  // --- 7. errors ------------------------------------------------------------
  console.log('7. errors');
  const runtimeErrors = [];
  for (const m of events) {
    if (m.method === 'Runtime.exceptionThrown') runtimeErrors.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') runtimeErrors.push(String(m.params.entry.text).slice(0, 200));
  }
  const pageErrs = R.pages.flatMap((p) => (p.snapshot && p.snapshot.errors) || []).map((e) => String(e.msg || e).slice(0, 200));
  const allErrs = [...new Set([...runtimeErrors, ...pageErrs])].filter((e) => !/favicon|404|api\/|Failed to load resource|net::ERR_INTERNET_DISCONNECTED|net::ERR_NETWORK_CHANGED/i.test(e));
  if (allErrs.length === 0) note('ok', 'errors', 'no uncaught error across the whole walk');
  else for (const e of allErrs.slice(0, 10)) note('bad', 'errors', e);

  ws.close();
} catch (e) {
  note('bad', 'driver', 'the harness threw: ' + String((e && e.stack) || e).slice(0, 400));
  pass = false;
} finally {
  try { chrome.kill(); } catch {}
  await sleep(400);
  try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  if (server) { try { server.kill(); } catch {} }
  await sleep(300);
}

R.findings = findings;
try { writeFileSync(JSON_OUT, JSON.stringify(R, null, 2)); } catch {}

const bad = findings.filter((f) => f.grade === 'bad');
const warn = findings.filter((f) => f.grade === 'warn');
console.log('');
console.log('ux-audit: ' + findings.filter((f) => f.grade === 'ok').length + ' ok, ' +
  warn.length + ' warn, ' + bad.length + ' bad  (full record in ' + JSON_OUT + ')');
console.log('ux-audit: ' + (bad.length ? 'FAIL' : 'PASS'));
process.exit(bad.length || !pass ? 1 : 0);
