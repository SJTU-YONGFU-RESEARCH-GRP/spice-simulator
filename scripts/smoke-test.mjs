#!/usr/bin/env node
/**
 * Runtime smoke test for the published editor artifact.
 *
 * The artifact guard (scripts/check-artifacts.mjs) proves the bundle's
 * references and shell are coherent, but it cannot see runtime behavior. A build
 * can pass every static check and still throw on first interaction -- the A7
 * defect (31 JSX call sites compiled to `(void 0)(`) shipped a site that loaded
 * fine on the home page yet crashed the whole editor the moment "Run" was
 * pressed, and the guard stayed green until a dedicated check was bolted on.
 *
 * This test closes that gap the only way that actually works: it loads the page
 * in a real (headless) browser, opens an example circuit, runs the simulation,
 * and asserts the engine produced results with no uncaught errors. It is the
 * automated form of the A7 browser verification.
 *
 * Usage
 *   node scripts/smoke-test.mjs [options]
 *
 *   --url=<url>       Load this exact URL instead of starting a server.
 *   --no-server       Do not start the preview server (requires --url).
 *   --port=<n>        Preview server port when starting one (default: random).
 *   --example=<id>    Example circuit id to load (default: common-source-amplifier).
 *   --steps=<a,b>     Click sequence by exact label (default: Analog simulation,Run).
 *   --require         Fail (exit 1) if no browser is available. Default: skip (exit 0).
 *   --base=<path>     Deployed base when starting the server (default: from package.json).
 *
 * Exit codes
 *   0  pass (or skipped because no browser and not --require)
 *   1  smoke failure
 *   2  usage / setup error (no server could be started, bad args)
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
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
  console.log('usage: node scripts/smoke-test.mjs [--url=...] [--no-server] [--port=...] [--example=id] [--steps=A,B] [--require]');
  process.exit(0);
}

const REQUIRE = has('require');
const NO_SERVER = has('no-server');
const EXAMPLE = opt('example', 'common-source-amplifier');
const STEPS = (opt('steps', 'Analog simulation,Run')).split(',').map((s) => s.trim()).filter(Boolean);
const BASE_ARG = opt('base', null);

// --- locate a browser -------------------------------------------------------
const CHROME = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => existsSync(p));

if (!CHROME) {
  if (REQUIRE) {
    console.error('smoke-test: no browser available and --require was set; install Chrome or drop --require');
    process.exit(1);
  }
  console.log('smoke-test: SKIP (no browser found; install Chrome/Chromium or pass --require)');
  process.exit(0);
}

// --- start the preview server (unless handed a URL) --------------------------
let server = null;
let BASE = BASE_ARG;
let PREFIX = '';
let TARGET_URL = opt('url', null);

function deriveBase() {
  if (BASE_ARG) return BASE_ARG.startsWith('/') ? BASE_ARG : '/' + BASE_ARG;
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const p = new URL(pkg.homepage).pathname.replace(/\/?$/, '/');
    return p.startsWith('/') ? p : '/' + p;
  } catch {
    return '/';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {}
    await sleep(300);
  }
  return false;
}

if (!TARGET_URL) {
  if (NO_SERVER) {
    console.error('smoke-test: --no-server requires --url');
    process.exit(2);
  }
  BASE = deriveBase();
  PREFIX = BASE.replace(/\/?$/, '');
  const port = Number(opt('port', String(8800 + Math.floor(Math.random() * 200))));
  const serveLocal = join(HERE, 'serve-local.mjs');
  server = spawn(process.execPath, [serveLocal, '--port=' + port, '--base=' + BASE], {
    cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d.toString(); });
  const ready = await waitForServer('http://127.0.0.1:' + port + PREFIX + '/', 15000);
  if (!ready) {
    console.error('smoke-test: preview server did not come up; stderr=' + serverErr.slice(0, 600));
    try { server.kill(); } catch {}
    process.exit(2);
  }
  TARGET_URL = 'http://127.0.0.1:' + port + PREFIX + '/?example=' + encodeURIComponent(EXAMPLE);
}

console.log('smoke-test: browser=' + CHROME);
console.log('smoke-test: url=' + TARGET_URL);
console.log('smoke-test: steps=' + JSON.stringify(STEPS));

// --- drive the browser ------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'smoke-'));
const R = {
  url: TARGET_URL, steps: STEPS, example: EXAMPLE,
  docStatus: null, requests: [], failed: [], exceptions: [], consoleErrors: [], trace: [],
};
const PORT = 9900 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-default-apps',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--metrics-recording-only',
  '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
  '--window-size=1600,1000', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const CLICK_JS = (want) => `(function(){
  const norm = (el) => (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g,' ');
  const all = [...document.querySelectorAll('button,[role=button],a,[title],[role=tab]')];
  const eq = all.find((el) => norm(el) === ${JSON.stringify(want)} && el.getBoundingClientRect().width > 0);
  if (eq) { eq.click(); return { clicked: norm(eq), match: 'exact', tag: eq.tagName.toLowerCase() }; }
  const sub = all.find((el) => norm(el).toLowerCase().includes(String(${JSON.stringify(want)}).toLowerCase()) && el.getBoundingClientRect().width > 0);
  if (sub) { sub.click(); return { clicked: norm(sub), match: 'substring', tag: sub.tagName.toLowerCase() }; }
  const near = all.filter((el) => norm(el).toLowerCase().includes(String(${JSON.stringify(want)}).toLowerCase()))
    .slice(0, 12).map((el) => el.tagName.toLowerCase() + ':' + norm(el).slice(0, 50));
  return { clicked: null, near };
})()`;

const PROBE_JS = `({
  elements: document.querySelectorAll('*').length,
  svg: document.querySelectorAll('svg').length,
  canvas: document.querySelectorAll('canvas').length,
  errs: (window.__errs || []).length,
  text: (document.body ? document.body.innerText : '').slice(0, 3000),
})`;

let pass = true;
const fail = (msg) => { pass = false; console.log('  FAIL: ' + msg); };

try {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/json/version'); if (r.ok) ver = await r.json(); } catch {}
    await sleep(250);
  }
  if (!ver) throw new Error('devtools never came up; stderr=' + chromeErr.slice(0, 600));

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0; const pending = new Map(); const events = [];
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params }; if (sessionId) msg.sessionId = sessionId;
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

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);

  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      window.__errs = [];
      window.addEventListener('error', (e) => { window.__errs.push({ src: 'error', msg: e.message, stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 900) : null }); });
      window.addEventListener('unhandledrejection', (e) => { window.__errs.push({ src: 'rejection', msg: String(e.reason), stack: e.reason && e.reason.stack ? String(e.reason.stack).slice(0, 900) : null }); });
      for (const name of ['error', 'warn']) {
        const orig = console[name].bind(console);
        console[name] = function (...args) {
          window.__errs.push({ src: 'console.' + name, msg: args.map((a) => {
            if (a instanceof Error) return a.name + ': ' + a.message + (a.stack ? '\\n' + a.stack.slice(0, 900) : '');
            return typeof a === 'string' ? a : (a && a.toString ? a.toString() : String(a));
          }).join(' | ').slice(0, 1600) });
          return orig(...args);
        };
      }
    `,
  }, sessionId);

  const evalv = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
    return r.result?.value;
  };

  await send('Page.navigate', { url: TARGET_URL }, sessionId);
  await sleep(20000); // first load pulls ~7 MB ngspice WASM
  const boot = await evalv(PROBE_JS);
  R.trace.push({ at: 'boot', probe: boot });

  for (const s of STEPS) {
    const c = await evalv(CLICK_JS(s));
    await sleep(6000);
    const p = await evalv(PROBE_JS);
    R.trace.push({ at: 'click:' + s, clicked: c, probe: { elements: p.elements, svg: p.svg, canvas: p.canvas, errs: p.errs } });
    if (!c || !c.clicked) {
      fail('could not click step "' + s + '" (near: ' + JSON.stringify(c && c.near) + ')');
    }
  }

  await sleep(60000); // let the simulation finish
  const settle = await evalv(`({
    elements: document.querySelectorAll('*').length,
    svg: document.querySelectorAll('svg').length,
    canvas: document.querySelectorAll('canvas').length,
    errs: (window.__errs || []).slice(0, 12),
    text: (document.body ? document.body.innerText : '').slice(0, 4000),
  })`);
  R.trace.push({ at: 'settle', probe: settle });

  for (const m of events) {
    if (m.method === 'Network.responseReceived') {
      R.requests.push({ status: m.params.response.status, url: m.params.response.url });
      if (m.params.response.url.endsWith('/?example=' + EXAMPLE) || m.params.response.url.endsWith(PREFIX + '/') || m.params.response.url.endsWith(PREFIX + '/?example=' + EXAMPLE)) {
        R.docStatus = m.params.response.status;
      }
    } else if (m.method === 'Network.loadingFailed') {
      R.failed.push({ type: m.params.type, error: m.params.errorText });
    } else if (m.method === 'Runtime.exceptionThrown') {
      R.exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      R.consoleErrors.push(m.params.entry.text);
    }
  }
  if (R.docStatus == null) R.docStatus = (boot && boot.elements > 0) ? 200 : null;
  ws.close();

  // --- assertions -----------------------------------------------------------
  if (!R.docStatus || R.docStatus >= 400) fail('page did not load (docStatus=' + R.docStatus + ')');

  const allErrs = [
    ...R.exceptions.map((e) => String(e)),
    ...R.consoleErrors.map((e) => String(e)),
    ...((settle && settle.errs) || []).map((e) => (e.msg ? String(e.msg) : String(e))),
  ];
  const voidErr = allErrs.find((e) => /void 0/i.test(e));
  if (voidErr) fail('runtime error mentioning "(void 0)": ' + voidErr.slice(0, 200));
  const realErrs = allErrs.filter((e) => !/favicon|404|api\/|Failed to load resource/i.test(e));
  if (realErrs.length > 0) fail(realErrs.length + ' uncaught error(s): ' + realErrs.slice(0, 3).join(' || ').slice(0, 400));

  const text = (settle && settle.text) || '';
  const ran = /finished|completed|simulation (was )?run/i.test(text);
  if (!ran) fail('simulation did not report completion (looked for "finished"/"completed" in page text)');
  const rendered = (settle && (settle.svg + settle.canvas)) || 0;
  if (rendered === 0) fail('no svg/canvas rendered after run (results surface missing)');

  console.log('  docStatus=' + R.docStatus + '  svg=' + (settle && settle.svg) + '  canvas=' + (settle && settle.canvas) + '  errors=' + realErrs.length);
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

const outPath = join(REPO_ROOT, 'smoke-result.json');
try { writeFileSync(outPath, JSON.stringify(R, null, 2)); } catch {}

if (pass) {
  console.log('smoke-test: PASS');
  process.exit(0);
} else {
  console.log('smoke-test: FAIL  (full trace in ' + outPath + ')');
  process.exit(1);
}
