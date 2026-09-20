#!/usr/bin/env node
/**
 * Prove the service worker can run a simulation offline.
 *
 * Static checks can read site/sw.js and agree that it looks right, but the
 * worker's caching only happens at runtime and nothing in this repository ever
 * exercised it -- every other harness serves the artifact with
 * "Cache-Control: no-store" for preview convenience, and the worker explicitly
 * declines to store a no-store response. So the worker's caching paths were
 * untested, and they were in fact broken: every put on the runtime route threw
 * "Response body is already used" because the response was cloned inside the
 * caches.open() callback, after respondWith() had already taken the body. The
 * rejection went to a fire-and-forget promise, so it was invisible; the only
 * entries the cache ever held were the six install() precached through
 * shellUrls(). Offline simulation still appeared to work, because it was
 * quietly leaning on the browser's own HTTP cache for a 7 MB body -- a ten
 * minute window with an eviction policy nobody here controls.
 *
 * This test asserts the thing the worker exists to provide, in the one
 * configuration where only the worker can provide it: the network is off and
 * the HTTP cache is disabled (on the page AND on the worker, so the worker
 * cannot quietly re-fetch), so anything that renders can only have come from
 * Cache Storage.
 *
 * Usage
 *   node scripts/offline-sim.mjs [options]
 *
 *   --url=<url>     Load this URL instead of starting a preview server.
 *   --no-server     Do not start the preview server (requires --url).
 *   --port=<n>      Preview server port when starting one (default: random).
 *   --base=<path>   Deployed base when starting the server (default: package.json).
 *   --site=<dir>    Artifact to serve (default <repo>/site). A copy with a
 *                   mutated sw.js is how the negative control exercises this.
 *   --example=<id>  Example circuit to load (default: common-source-amplifier).
 *   --require       Fail (exit 1) if no browser is available. Default: skip (exit 0).
 *
 * Exit codes
 *   0  pass (or skipped because no browser and not --require)
 *   1  the offline simulation did not complete
 *   2  usage / setup error
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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
  console.log('usage: node scripts/offline-sim.mjs [--url=...] [--no-server] [--port=...] [--example=id] [--require]');
  process.exit(0);
}

const REQUIRE = has('require');
const NO_SERVER = has('no-server');
const EXAMPLE = opt('example', 'common-source-amplifier');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    console.error('offline-sim: no browser available and --require was set; install Chrome or drop --require');
    process.exit(1);
  }
  console.log('offline-sim: SKIP (no browser found; install Chrome/Chromium or pass --require)');
  process.exit(0);
}

// --- preview server ---------------------------------------------------------
// --cache=public is not a detail. The worker refuses to store a response whose
// Cache-Control says no-store, so under the default preview headers it would
// cache nothing and this test could not tell a working worker from a broken one.
function deriveBase() {
  const explicit = opt('base', null);
  if (explicit) return explicit.startsWith('/') ? explicit : '/' + explicit;
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    const p = new URL(pkg.homepage).pathname.replace(/\/?$/, '/');
    return p.startsWith('/') ? p : '/' + p;
  } catch {
    return '/';
  }
}

async function waitForServer(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch {}
    await sleep(300);
  }
  return false;
}

let server = null;
const BASE = deriveBase();
const PREFIX = BASE.replace(/\/?$/, '');
let TARGET_URL = opt('url', null);
if (!TARGET_URL) {
  if (NO_SERVER) { console.error('offline-sim: --no-server requires --url'); process.exit(2); }
  const port = Number(opt('port', String(8900 + Math.floor(Math.random() * 90))));
  const siteArg = opt('site', null);
  const serverArgs = [join(HERE, 'serve-local.mjs'), '--port=' + port, '--base=' + BASE, '--cache=public'];
  if (siteArg) serverArgs.push('--site=' + resolve(siteArg));
  server = spawn(process.execPath, serverArgs, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  server.stderr.on('data', (d) => { err += d.toString(); });
  if (!(await waitForServer('http://127.0.0.1:' + port + PREFIX + '/', 15000))) {
    console.error('offline-sim: preview server did not come up; stderr=' + err.slice(0, 600));
    try { server.kill(); } catch {}
    process.exit(2);
  }
  TARGET_URL = 'http://127.0.0.1:' + port + PREFIX + '/';
}
const ORIGIN = new URL(TARGET_URL).origin;

// --- browser ----------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'offline-sim-'));
const DP = 9400 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DP}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-default-apps',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--window-size=1600,1000', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const CLICK_JS = (want) => `(function(){
  const norm = (el) => (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g,' ');
  const all = [...document.querySelectorAll('button,[role=button],a,[title],[role=tab]')];
  const eq = all.find((el) => norm(el) === ${JSON.stringify(want)} && el.getBoundingClientRect().width > 0);
  if (eq) { eq.click(); return norm(eq); }
  const sub = all.find((el) => norm(el).toLowerCase().includes(String(${JSON.stringify(want)}).toLowerCase()) && el.getBoundingClientRect().width > 0);
  if (sub) { sub.click(); return norm(sub); }
  return null;
})()`;

const PROBE_JS = `({
  elements: document.querySelectorAll('*').length,
  svg: document.querySelectorAll('svg').length,
  controller: navigator.serviceWorker.controller ? 'controlled' : 'uncontrolled',
  text: (document.body ? document.body.innerText : '').slice(0, 4000),
})`;

// The engine is the only thing here that a browser cannot invent: vendor/ngspice.js
// is 6.88 MB of base64 WASM, and models/ holds the device cards the netlist needs.
const CACHE_PROBE = `(async () => {
  const names = await caches.keys();
  const urls = [];
  for (const n of names) {
    const c = await caches.open(n);
    for (const k of await c.keys()) urls.push(k.url.replace(location.origin, ''));
  }
  return { names: names.length, total: urls.length, engine: urls.filter((u) => /\\/vendor\\/ngspice\\.js$/.test(u)), models: urls.filter((u) => /\\/models\\//.test(u)) };
})()`;

const R = {
  url: TARGET_URL, example: EXAMPLE, chrome: CHROME,
  warmup: null, cacheAfterWarmup: null,
  offlineLoad: null, offlineAfterRun: null, offlineCache: null,
  offlineFailures: [], swErrors: [],
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
    if (!m.method) return;
    events.push(m);
    // Attach to the worker so its HTTP cache can be disabled too. Disabling it
    // on the page alone would leave this test able to pass on the browser's
    // cache alone, which is the very dependency being ruled out.
    if (m.method === 'Target.attachedToTarget' && /service_worker|worker/i.test(m.params.targetInfo.type)) {
      send('Network.enable', {}, m.params.sessionId)
        .then(() => send('Network.setCacheDisabled', { cacheDisabled: true }, m.params.sessionId))
        .catch(() => {});
      send('Runtime.enable', {}, m.params.sessionId).catch(() => {});
      send('Log.enable', {}, m.params.sessionId).catch(() => {});
    }
  };
  await send('Target.setDiscoverTargets', { discover: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  await send('Page.enable', {}, sessionId);
  await send('Network.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  const evalv = async (expr, session) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, session ?? sessionId);
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text };
    return r.result?.value;
  };
  const trackFailures = (from, label) => {
    const names = new Map();
    for (let i = from; i < events.length; i++) {
      const m = events[i];
      if (m.method === 'Network.requestWillBeSent') names.set(m.params.requestId, m.params.request.url.replace(ORIGIN, ''));
      else if (m.method === 'Network.loadingFailed') {
        const u = names.get(m.params.requestId) ?? '?';
        R.offlineFailures.push({ phase: label, url: u, error: m.params.errorText });
      }
    }
  };

  console.log('offline-sim: browser=' + CHROME);
  console.log('offline-sim: url=' + TARGET_URL + '  (server started with --cache=public)');

  // --- warm up: install the worker and cache everything a first simulation needs
  await send('Page.navigate', { url: TARGET_URL }, sessionId);
  // A worker does not control the page that registered it; reload once it is active.
  await sleep(4000);
  await evalv('navigator.serviceWorker.ready.then(() => true)').catch(() => {});
  await sleep(2000);
  await send('Page.navigate', { url: TARGET_URL + '?example=' + encodeURIComponent(EXAMPLE) }, sessionId);
  await sleep(12000);
  await evalv(CLICK_JS('Analog simulation'));
  await sleep(3000);
  await evalv(CLICK_JS('Run'));
  await sleep(50000);
  R.warmup = await evalv(PROBE_JS);
  R.cacheAfterWarmup = await evalv(CACHE_PROBE);
  console.log('offline-sim: warm-up  svg=' + R.warmup.svg + '  controller=' + R.warmup.controller +
    '  cached=' + R.cacheAfterWarmup.total + '  engine=' + R.cacheAfterWarmup.engine.length);

  if (R.warmup.controller !== 'controlled') fail('the service worker never took control of the page');
  if (!R.cacheAfterWarmup.engine.length) {
    fail('vendor/ngspice.js is not in Cache Storage after a simulation -- the worker cached nothing, ' +
      'so offline simulation can only be riding the browser HTTP cache');
  }
  if (!R.cacheAfterWarmup.models.length) fail('no models/ entry in Cache Storage after a simulation');

  // --- the real test: no network, and no HTTP cache to fall back on
  const from = events.length;
  await send('Network.setCacheDisabled', { cacheDisabled: true }, sessionId);
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 }, sessionId);
  await send('Page.reload', {}, sessionId);
  await sleep(12000);
  R.offlineLoad = await evalv(PROBE_JS);
  const beforeRun = R.offlineLoad.svg;
  await evalv(CLICK_JS('Analog simulation'));
  await sleep(3000);
  const clicked = await evalv(CLICK_JS('Run'));
  await sleep(45000);
  R.offlineAfterRun = await evalv(PROBE_JS);
  R.offlineCache = await evalv(CACHE_PROBE);
  trackFailures(from, 'offline');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId);

  console.log('offline-sim: offline  beforeRun svg=' + beforeRun + '  afterRun svg=' + R.offlineAfterRun.svg + '  clicked=' + JSON.stringify(clicked));

  if (R.offlineLoad.elements < 100) fail('the editor did not render offline at all (elements=' + R.offlineLoad.elements + ')');
  if (!clicked) fail('the Run control was not reachable offline');
  if (!(R.offlineAfterRun.svg > beforeRun)) {
    fail('offline simulation produced no new plots (svg ' + beforeRun + ' -> ' + R.offlineAfterRun.svg +
      '); the worker did not have the engine payload to serve');
  }
  const blocking = R.offlineFailures.filter((f) => !/\/api\//.test(f.url));
  if (blocking.length) {
    fail(blocking.length + ' offline request(s) failed that are not /api/: ' +
      blocking.slice(0, 3).map((f) => f.url + ' :: ' + f.error).join(' || '));
  }
  for (const m of events) {
    if (m.method === 'Runtime.exceptionThrown' && /serviceworker|sw\.js/i.test(String(m.params.exceptionDetails?.url ?? ''))) {
      R.swErrors.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text).slice(0, 300));
    }
  }
  for (const e of R.swErrors) fail('worker exception: ' + e);
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

const outPath = join(REPO_ROOT, 'offline-sim-result.json');
try { writeFileSync(outPath, JSON.stringify(R, null, 2)); } catch {}

if (pass) {
  console.log('offline-sim: PASS');
  process.exit(0);
} else {
  console.log('offline-sim: FAIL  (full trace in ' + outPath + ')');
  process.exit(1);
}
