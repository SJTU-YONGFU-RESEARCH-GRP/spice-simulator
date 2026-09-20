#!/usr/bin/env node
/**
 * Runtime proof that the published editor survives a browser that denies storage.
 *
 * Why this exists
 *   `window.localStorage` is not just a bag of strings: in Safari private mode,
 *   with site data blocked, or inside a partitioned iframe, reading the property
 *   THROWS a SecurityError. Any code that touches it outside a try/catch fails at
 *   the point of the read. On 2026-09-20 the editor chunk was found to have six
 *   such reads -- three `localStorage` and three `sessionStorage`, all inside
 *   React `useState`/`useEffect` -- while the other thirty reads in the same file
 *   were guarded. With storage denied the throw happened during render, React's
 *   error boundary took over, and the entire editor was replaced by
 *   "The editor hit an unexpected problem" (42 elements, no SVG, app gone).
 *
 *   scripts/check-artifacts.mjs check 10 catches that statically. This catches it
 *   the way a user would: it loads the real page in a real browser with storage
 *   denied and asserts the editor actually renders.
 *
 * How the denial is produced
 *   Page.addScriptToEvaluateOnNewDocument installs a snippet that runs before any
 *   page script on every new document and shadows the window's storage accessors
 *   with getters that throw. Shadowing the property (rather than deleting data)
 *   is what makes it fail like a real denied-storage browser: the throw happens
 *   on access, which is exactly the failure mode the guards have to survive.
 *
 * Usage
 *   node scripts/storage-resilience.mjs [options]
 *
 *   --site=<dir>      Artifact tree to serve. Default <repo>/site
 *   --base=<path>     Deployed base. Default derived from package.json homepage
 *   --port=<n>        Preview server port (default: random)
 *   --example=<id>    Also load ?example=<id> (default: common-source-amplifier;
 *                     pass --example= to skip the deep-link pass)
 *   --require         Fail (exit 1) when no browser is available. Default: skip.
 *   --json=<file>     Write the full trace here.
 *
 * Exit codes
 *   0  pass (or skipped: no browser and not --require)
 *   1  the artifact crashed, or the denial did not take effect
 *   2  usage / setup error
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const has = (name) => argv.some((a) => a === '--' + name);

if (has('help') || has('h')) {
  console.log('usage: node scripts/storage-resilience.mjs [--site=<dir>] [--base=<path>] [--port=<n>] [--example=<id>] [--require] [--json=<file>]');
  process.exit(0);
}

const REQUIRE = has('require');
const SITE = resolve(opt('site', join(REPO_ROOT, 'site')));
const EXAMPLE = opt('example', 'common-source-amplifier');

if (!existsSync(SITE) || !statSync(SITE).isDirectory()) {
  console.error('storage-resilience: site directory not found: ' + SITE);
  process.exit(2);
}

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
    console.error('storage-resilience: no browser available and --require was set');
    process.exit(1);
  }
  console.log('storage-resilience: SKIP (no browser found; install Chrome/Chromium or pass --require)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deriveBase() {
  const explicit = opt('base', null);
  if (explicit) return explicit.startsWith('/') ? explicit : '/' + explicit;
  try {
    const p = new URL(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).homepage).pathname;
    const withSlash = p.replace(/\/?$/, '/');
    return withSlash.startsWith('/') ? withSlash : '/' + withSlash;
  } catch {
    return '/';
  }
}

const BASE = deriveBase();
const PREFIX = BASE.replace(/\/?$/, '');

// --- preview server ---------------------------------------------------------
const serverPort = Number(opt('port', String(8600 + Math.floor(Math.random() * 300))));
const server = spawn(
  process.execPath,
  [join(HERE, 'serve-local.mjs'), '--port=' + serverPort, '--base=' + BASE, '--site=' + SITE],
  { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
);
let serverErr = '';
server.stderr.on('data', (d) => { serverErr += d.toString(); });

async function waitForServer(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* not yet */ }
    await sleep(300);
  }
  return false;
}

const homeUrl = 'http://127.0.0.1:' + serverPort + PREFIX + '/';
if (!(await waitForServer(homeUrl, 15000))) {
  console.error('storage-resilience: preview server did not come up; stderr=' + serverErr.slice(0, 600));
  try { server.kill(); } catch { /* gone */ }
  process.exit(2);
}

// --- browser ----------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'storage-'));
const devtoolsPort = 9600 + Math.floor(Math.random() * 300);
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  '--user-data-dir=' + profile, '--remote-debugging-port=' + devtoolsPort,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-default-apps',
  '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--metrics-recording-only',
  '--disable-features=Translate,BackForwardCache,AcceptCHFrame,MediaRouter,OptimizationHints',
  '--window-size=1600,1000', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

/**
 * Installed before any page script on every new document.
 *
 * The getters throw with a DOMException named SecurityError, which is what a
 * denied-storage browser does, so any unguarded read in the artifact fails here
 * exactly as it would for that user. `__storageDenialActive` proves the shadow
 * is in place, so a pass can never be an artefact of the patch not applying.
 */
const DENIAL = `
  (function () {
    window.__errs = [];
    window.addEventListener('error', function (e) {
      window.__errs.push({ src: 'error', msg: e.message,
        stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 900) : null });
    });
    window.addEventListener('unhandledrejection', function (e) {
      window.__errs.push({ src: 'rejection', msg: String(e.reason) });
    });
    for (const name of ['error', 'warn']) {
      const orig = console[name].bind(console);
      console[name] = function () {
        const flat = Array.prototype.map.call(arguments, function (a) {
          if (a instanceof Error) return a.name + ': ' + a.message;
          return typeof a === 'string' ? a : (a && a.toString ? a.toString() : String(a));
        }).join(' | ').slice(0, 1200);
        window.__errs.push({ src: 'console.' + name, msg: flat });
        return orig.apply(null, arguments);
      };
    }
    const denied = function () {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    try {
      Object.defineProperty(window, 'localStorage', { configurable: true, get: denied });
      Object.defineProperty(window, 'sessionStorage', { configurable: true, get: denied });
      window.__storageDenialActive = true;
    } catch (e) {
      window.__storageDenialActive = false;
      window.__storageDenialError = String(e);
    }
  })();
`;

const PROBE = `({
  denialActive: window.__storageDenialActive === true,
  localStorageThrows: (function () { try { void window.localStorage; return false; }
                                      catch (e) { return e.name; } })(),
  sessionStorageThrows: (function () { try { void window.sessionStorage; return false; }
                                       catch (e) { return e.name; } })(),
  elements: document.querySelectorAll('*').length,
  svg: document.querySelectorAll('svg').length,
  canvas: document.querySelectorAll('canvas').length,
  rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
  text: (document.body ? document.body.innerText : '').slice(0, 2500),
  errs: (window.__errs || []).slice(0, 20),
})`;

/** Copy a browser's crash surfaces the app renders when a render throws. */
const CRASH_TEXT = [
  'hit an unexpected problem',
  'Rendering stopped with an internal error',
  'Editor crashed during rendering',
];

const R = { site: SITE, base: BASE, browser: CHROME, passes: [], exceptions: [], consoleErrors: [] };
let pass = true;
const fail = (msg) => { pass = false; console.log('  FAIL: ' + msg); };

function inspect(label, probe) {
  R.passes.push({ label, probe: { ...probe, text: probe.text.slice(0, 400) } });
  if (!probe.denialActive) {
    fail(label + ': storage denial did not install (__storageDenialActive=' + probe.denialActive +
      (probe.denialError ? ', ' + probe.denialError : '') + ') -- the result would be meaningless');
    return;
  }
  if (probe.localStorageThrows !== 'SecurityError' || probe.sessionStorageThrows !== 'SecurityError') {
    fail(label + ': storage getters do not throw (localStorage=' + probe.localStorageThrows +
      ', sessionStorage=' + probe.sessionStorageThrows + ') -- the test is not testing denial');
    return;
  }
  const crash = CRASH_TEXT.find((t) => probe.text.includes(t));
  if (crash) fail(label + ': the editor rendered its crash screen ("' + crash + '")');
  if (probe.rootChildren <= 0) fail(label + ': #root is empty -- the app did not mount');
  const storageErrs = probe.errs.filter((e) => /SecurityError|insecure/i.test(e.msg));
  if (storageErrs.length > 0) {
    fail(label + ': ' + storageErrs.length + ' uncaught storage error(s): ' +
      storageErrs.map((e) => e.msg).slice(0, 2).join(' || ').slice(0, 300));
  }
  console.log('  ' + label + ': elements=' + probe.elements + ' svg=' + probe.svg +
    ' root=' + probe.rootChildren + ' errs=' + probe.errs.length);
}

try {
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    try { const r = await fetch('http://127.0.0.1:' + devtoolsPort + '/json/version'); if (r.ok) ver = await r.json(); } catch { /* not yet */ }
    await sleep(250);
  }
  if (!ver) throw new Error('devtools never came up; stderr=' + chromeErr.slice(0, 600));

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools websocket error')); });
  let id = 0;
  const pending = new Map();
  const events = [];
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(msg.id, { res, rej });
    ws.send(JSON.stringify(msg));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(m.method + ' ' + JSON.stringify(m.error))) : p.res(m.result);
      return;
    }
    if (m.method) events.push(m);
  };

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: DENIAL }, sessionId);

  const evalv = async (expr) => {
    const r = await send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) {
      return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text, denialActive: false };
    }
    return r.result?.value;
  };

  await send('Page.navigate', { url: homeUrl }, sessionId);
  await sleep(14000);
  inspect('home', await evalv(PROBE));

  if (EXAMPLE) {
    const deepUrl = homeUrl + '?example=' + encodeURIComponent(EXAMPLE);
    await send('Page.navigate', { url: deepUrl }, sessionId);
    await sleep(24000); // the deep link boots the editor and pulls the ~7 MB engine
    inspect('example:' + EXAMPLE, await evalv(PROBE));
  }

  for (const m of events) {
    if (m.method === 'Runtime.exceptionThrown') {
      R.exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      R.consoleErrors.push(m.params.entry.text);
    }
  }
  const hard = R.exceptions.filter((e) => !/favicon/i.test(String(e)));
  const hardConsole = R.consoleErrors.filter((e) => !/favicon|404|api\//i.test(String(e)));
  if (hard.length > 0) fail(hard.length + ' uncaught exception(s) reached DevTools: ' + String(hard[0]).slice(0, 300));
  if (hardConsole.length > 0) fail(hardConsole.length + ' console error(s): ' + String(hardConsole[0]).slice(0, 300));
  ws.close();
} catch (e) {
  R.fatal = String((e && e.stack) || e);
  fail('driver threw: ' + R.fatal.slice(0, 400));
} finally {
  try { chrome.kill(); } catch { /* gone */ }
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked */ }
  try { server.kill(); } catch { /* gone */ }
  await sleep(200);
}

const outPath = opt('json', null);
if (outPath) { try { writeFileSync(outPath, JSON.stringify(R, null, 2)); } catch { /* best effort */ } }

if (pass) {
  console.log('storage-resilience: PASS (editor renders with localStorage and sessionStorage denied)');
  process.exit(0);
}
console.log('storage-resilience: FAIL' + (outPath ? ' (trace in ' + outPath + ')' : ''));
process.exit(1);
