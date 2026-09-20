#!/usr/bin/env node
/**
 * Runtime proof that the published shell ships a Content-Security-Policy, that
 * the policy is ENFORCED, and that it does not break the editor.
 *
 * Why this exists
 *   site/index.html and site/404.html are committed build artifacts whose editor
 *   sources are not in any public repository. Everything the browser is allowed
 *   to load is therefore decided by two hand-maintained HTML files. Without a
 *   policy the page trusts every origin with the same authority as its own: an
 *   injected <script src> from anywhere executes inside the editor's origin,
 *   next to a WASM engine and the user's locally stored projects.
 *
 *   A policy is only worth shipping if two things are true, and a static check
 *   can prove neither:
 *     1. It is enforced -- the browser actually refuses what it does not name.
 *     2. It does not break the application -- every resource the editor needs is
 *        still permitted.
 *
 *   Both are behavioural properties, so this test measures them in a real
 *   browser: it loads the deployed shell, opens an example circuit, runs an
 *   analog simulation, and requires zero CSP violations along the way.
 *
 * Why a zero is trustworthy here
 *   "No violations were reported" is worthless if the reporter is blind, so this
 *   test refuses to report a pass until the collector has proved it can see a
 *   violation. In --self-test mode it serves the same artifact with two
 *   deliberate violations added (an inline <script> with no matching hash, and a
 *   script from an origin the policy does not name) and requires all three of:
 *     * the violations ARE observed (the collector works),
 *     * the injected code NEVER ran (the policy is enforced, not decorative),
 *     * the editor still works (the added violation is what was detected, not a
 *       side effect of a broken page).
 *   Only then is the same collector trusted to certify the clean run.
 *
 * What it does NOT prove
 *   Coverage is the paths it drives: boot, the ?example= deep link, the analog
 *   simulation and the render that follows. Paths it does not drive (PDF or PNG
 *   export, project import, the gallery, dialogs) are same-origin chunks, which
 *   `script-src 'self'` already covers; the residual exposure is a lazily
 *   reached blob:/data: load in one of those paths, which is why those two
 *   schemes are allowlisted for image, font, media, frame, worker and connect.
 *
 * Usage
 *   node scripts/csp-conformance.mjs [options]
 *
 *   --site=<dir>      Artifact tree to serve. Default <repo>/site
 *   --base=<path>     Deployed base. Default derived from package.json homepage
 *   --port=<n>        Preview server port (default: random)
 *   --example=<id>    Example circuit to open (default: common-source-amplifier)
 *   --steps=<a,b>     Click sequence by exact label (default: Analog simulation,Run)
 *   --csp=<policy>    Serve a scratch copy with THIS policy instead of the one
 *                     committed in the artifact. Used to derive the policy; the
 *                     artifact itself is never modified.
 *   --self-test       Negative control described above.
 *   --boot=<ms>       Wait after first navigation (default 20000)
 *   --step=<ms>       Wait after each click (default 6000)
 *   --settle=<ms>     Wait after the last click (default 60000)
 *   --require         Fail (exit 1) when no browser is available. Default: skip.
 *   --json=<file>     Write the full trace here.
 *
 * Exit codes
 *   0  pass (or skipped: no browser and not --require)
 *   1  a violation was seen, the policy was not enforced, or the editor broke
 *   2  usage / setup error
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  console.log('usage: node scripts/csp-conformance.mjs [--site=<dir>] [--base=<path>] [--port=<n>] ' +
    '[--example=<id>] [--steps=A,B] [--csp=<policy>] [--self-test] [--require] [--json=<file>]');
  process.exit(0);
}

const REQUIRE = has('require');
const SELF_TEST = has('self-test');
const POLICY_ARG = opt('csp', null);
const SITE = resolve(opt('site', join(REPO_ROOT, 'site')));
const EXAMPLE = opt('example', 'common-source-amplifier');
const STEPS = (opt('steps', 'Analog simulation,Run')).split(',').map((s) => s.trim()).filter(Boolean);
const BOOT_MS = Number(opt('boot', '20000'));
const STEP_MS = Number(opt('step', '6000'));
const SETTLE_MS = Number(opt('settle', '60000'));

if (!existsSync(SITE) || !statSync(SITE).isDirectory()) {
  console.error('csp-conformance: site directory not found: ' + SITE);
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
    console.error('csp-conformance: no browser available and --require was set');
    process.exit(1);
  }
  console.log('csp-conformance: SKIP (no browser found; install Chrome/Chromium or pass --require)');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- reading the policy out of the artifact ---------------------------------
// The policy lives in a meta tag, so a rebuild that drops it silently returns
// the page to trusting every origin. Both shell documents carry it; they are
// byte-identical today, and the guard asserts they stay in step.
// A policy value is full of single quotes ('self', 'sha256-...'), so the quoted
// value must be read with a backreference rather than with [^"'] -- an
// exclusion set of both quote characters stops at the first `'self'` and reports
// a shell that has a policy as one that has none.
const CSP_META = /<meta\s+http-equiv=(["'])Content-Security-Policy\1\s+content=(["'])([\s\S]*?)\2\s*\/?>/i;
const NONCE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i;
const CHARSET_META = /<meta\s+charset=["'][^"']*["']\s*\/?>/i;

const policyOf = (html) => {
  const m = CSP_META.exec(html);
  return m ? m[3] : null;
};
/** The text a CSP `sha256-` source for an inline script is computed over. */
const inlineScriptOf = (html) => {
  const m = NONCE_SCRIPT.exec(html);
  return m ? m[1] : null;
};
const sha256B64 = (text) => createHash('sha256').update(text, 'utf8').digest('base64');

const withPolicy = (html, policy) => {
  const meta = '<meta http-equiv="Content-Security-Policy" content="' + policy + '" />';
  if (CSP_META.test(html)) return html.replace(CSP_META, meta);
  if (!CHARSET_META.test(html)) throw new Error('no <meta charset> to anchor the policy after');
  return html.replace(CHARSET_META, (m) => m + '\n    ' + meta);
};

// --- work out what to serve --------------------------------------------------
const shellPath = join(SITE, 'index.html');
if (!existsSync(shellPath)) {
  console.error('csp-conformance: no index.html in ' + SITE);
  process.exit(2);
}
const shellHtml = readFileSync(shellPath, 'utf8');
const committedPolicy = policyOf(shellHtml);

let POLICY = POLICY_ARG ?? committedPolicy;
let SERVE_DIR = SITE;
let scratch = null;

if (POLICY_ARG || SELF_TEST) {
  if (!POLICY) {
    console.error('csp-conformance: ' + (POLICY_ARG
      ? '--csp= was given as an empty policy'
      : '--self-test needs a policy; the artifact has no CSP meta and --csp= was not given'));
    process.exit(2);
  }
  scratch = mkdtempSync(join(tmpdir(), 'csp-site-'));
  cpSync(SITE, scratch, { recursive: true });
  for (const f of ['index.html', '404.html']) {
    const p = join(scratch, f);
    if (!existsSync(p)) continue;
    let html = withPolicy(readFileSync(p, 'utf8'), POLICY);
    if (SELF_TEST) {
      // Two violations the policy must refuse. The first is inline with no hash,
      // and it records whether it ever executed; the second comes from an origin
      // the policy does not name.
      html = html.replace('</head>',
        '    <script>window.__cspBypassRan = true;</script>\n' +
        '    <script src="https://unpkg.com/csp-conformance-selftest@0.0.1/index.js"></script>\n' +
        '  </head>');
    }
    writeFileSync(p, html);
  }
  SERVE_DIR = scratch;
}

if (!POLICY) {
  console.log('csp-conformance: no Content-Security-Policy meta in ' + shellPath);
  console.log('csp-conformance: FAIL (the shell ships no policy)');
  process.exit(1);
}

// --- preview server ----------------------------------------------------------
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
const serverPort = Number(opt('port', String(8700 + Math.floor(Math.random() * 300))));
const server = spawn(
  process.execPath,
  [join(HERE, 'serve-local.mjs'), '--port=' + serverPort, '--base=' + BASE, '--site=' + SERVE_DIR],
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
  console.error('csp-conformance: preview server did not come up; stderr=' + serverErr.slice(0, 600));
  try { server.kill(); } catch { /* gone */ }
  process.exit(2);
}

const cleanupScratch = () => {
  if (!scratch) return;
  try {
    for (const f of ['index.html', '404.html']) {
      const p = join(scratch, f);
      if (existsSync(p)) { try { statSync(p); } catch { /* ignore */ } }
    }
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  } catch { /* best effort */ }
};

// --- browser -----------------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'csp-'));
const devtoolsPort = 9700 + Math.floor(Math.random() * 300);
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
 * `securitypolicyviolation` is the only channel that reports a violation as a
 * structured record rather than as prose, and it fires for meta-delivered
 * policies too. A script injected through CDP is not subject to the policy, so
 * the listener is guaranteed to be in place before the policy is parsed.
 * `__cspInstalled` proves it, so a clean run can never be an artefact of a
 * collector that failed to attach.
 */
const BOOTSTRAP = `
  (function () {
    window.__csp = [];
    window.__errs = [];
    window.__cspInstalled = false;
    try {
      document.addEventListener('securitypolicyviolation', function (e) {
        window.__csp.push({
          directive: e.effectiveDirective || e.violatedDirective || null,
          blockedURI: e.blockedURI || null,
          source: e.sourceFile ? (e.sourceFile + ':' + e.lineNumber) : null,
          sample: e.sample ? String(e.sample).slice(0, 200) : null,
          disposition: e.disposition || null,
        });
      });
      window.__cspInstalled = true;
    } catch (e) { window.__cspError = String(e); }
    window.addEventListener('error', function (e) {
      window.__errs.push({ src: 'error', msg: e.message,
        stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 700) : null });
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
        }).join(' | ').slice(0, 1000);
        window.__errs.push({ src: 'console.' + name, msg: flat });
        return orig.apply(null, arguments);
      };
    }
  })();
`;

const PROBE = `({
  installed: window.__cspInstalled === true,
  installError: window.__cspError || null,
  violations: (window.__csp || []),
  violationCount: (window.__csp || []).length,
  bypassRan: window.__cspBypassRan === true,
  elements: document.querySelectorAll('*').length,
  svg: document.querySelectorAll('svg').length,
  canvas: document.querySelectorAll('canvas').length,
  rootChildren: document.getElementById('root') ? document.getElementById('root').children.length : -1,
  errs: (window.__errs || []).slice(0, 25),
  text: (document.body ? document.body.innerText : '').slice(0, 3000),
})`;

const CLICK_JS = (want) => `(function(){
  const norm = (el) => (el.getAttribute('title') || el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\\s+/g,' ');
  const all = [...document.querySelectorAll('button,[role=button],a,[title],[role=tab]')];
  const eq = all.find((el) => norm(el) === ${JSON.stringify(want)} && el.getBoundingClientRect().width > 0);
  if (eq) { eq.click(); return { clicked: norm(eq), match: 'exact' }; }
  const sub = all.find((el) => norm(el).toLowerCase().includes(String(${JSON.stringify(want)}).toLowerCase()) && el.getBoundingClientRect().width > 0);
  if (sub) { sub.click(); return { clicked: norm(sub), match: 'substring' }; }
  return { clicked: null, near: all.filter((el) => norm(el).toLowerCase().includes(String(${JSON.stringify(want)}).toLowerCase())).slice(0, 12).map((el) => norm(el).slice(0, 50)) };
})()`;

const CRASH_TEXT = [
  'hit an unexpected problem',
  'Rendering stopped with an internal error',
  'Editor crashed during rendering',
];
/** Text Chrome prints when a policy blocks something, whatever the channel. */
const CSP_TEXT = /Content Security Policy|Refused to (load|execute|compile|create|apply|connect|frame|run|evaluate)/i;

/**
 * Blocks that are expected, understood, and deliberately NOT silenced.
 *
 * Adding 'unsafe-eval' would clear the last violation at the cost of the
 * directive that carries most of the policy's value, so the block stays and the
 * test learns its signature instead. This narrows the test's ALARM, never the
 * browser's ENFORCEMENT: eval is still refused, and anything that depended on it
 * would still fail. Nothing here depends on eval working.
 *
 * Only one such block was measured (2026-09-20), and it comes from the artifact
 * itself: `assets/src-aCByi2RB.js` is zod, whose `allowsEval()` is
 * `try { Function('') ; return true } catch { return false }`. Its being blocked
 * is the probe working as designed -- zod then takes its non-JIT path, which
 * `--self-test` plus the simulation-completion assertion confirm is still
 * correct. A whole-tree scan for `new Function` / `eval(` found no call anywhere
 * in the artifact outside that probe and core-js's unreachable globalThis
 * fallback.
 *
 * The entry is matched on directive, blocked URI AND source file, so neither a
 * second eval site appearing nor the probe moving to another chunk can pass
 * quietly.
 */
const ACCEPTED_BLOCKS = [
  {
    directive: 'script-src',
    blockedURI: 'eval',
    sourceFile: 'src-aCByi2RB.js',
    why: "zod's allowsEval() feature probe; caught by zod itself, which then uses its interpreter path",
  },
];
/**
 * The same block, as prose, if Chrome chooses to log it instead of (or as well
 * as) reporting it on the document. Kept separate from the structured matcher
 * because a log line carries no source file to pin it to a chunk.
 */
const ACCEPTED_LOG = /Refused to evaluate a string as JavaScript/i;

const isAcceptedBlock = (v) => ACCEPTED_BLOCKS.some((a) =>
  a.directive === v.directive &&
  a.blockedURI === v.blockedURI &&
  (!a.sourceFile || String(v.source || '').includes(a.sourceFile)));

function partition(violations) {
  const accepted = [];
  const unexplained = [];
  for (const v of violations) (isAcceptedBlock(v) ? accepted : unexplained).push(v);
  return { accepted, unexplained };
}

const R = {
  site: SITE, served: SERVE_DIR, base: BASE, browser: CHROME,
  mode: SELF_TEST ? 'self-test' : (POLICY_ARG ? 'csp-override' : 'committed'),
  policy: POLICY, passes: [], domViolations: [], logViolations: [], acceptedBlocks: [],
  exceptions: [], consoleErrors: [],
};
let pass = true;
const fail = (msg) => { pass = false; console.log('  FAIL: ' + msg); };

/** Assertions that must hold on every pass, in either mode. */
function inspect(label, probe) {
  R.passes.push({ label, probe: { ...probe, text: probe.text.slice(0, 400), errs: probe.errs.slice(0, 8) } });
  if (!probe.installed) {
    fail(label + ': the violation collector never installed (' + (probe.installError || 'no error reported') +
      ') -- a clean result would mean nothing');
    return;
  }
  const crash = CRASH_TEXT.find((t) => probe.text.includes(t));
  if (crash) fail(label + ': the editor rendered its crash screen ("' + crash + '")');
  if (probe.rootChildren <= 0) fail(label + ': #root is empty -- the app did not mount');
  const cspErrs = probe.errs.filter((e) => CSP_TEXT.test(String(e.msg)));
  const other = probe.errs.filter((e) => !CSP_TEXT.test(String(e.msg)) &&
    !/unpkg\.com|Failed to load resource|net::ERR/i.test(String(e.msg)));
  const seen = SELF_TEST ? [] : partition(probe.violations || []);
  console.log('  ' + label + ': violations=' + probe.violationCount +
    (SELF_TEST ? '' : ' (accepted=' + seen.accepted.length + ' unexplained=' + seen.unexplained.length + ')') +
    ' elements=' + probe.elements + ' svg=' + probe.svg + ' root=' + probe.rootChildren +
    ' errs=' + probe.errs.length + (cspErrs.length ? ' cspErrs=' + cspErrs.length : ''));
  if (SELF_TEST) {
    if (probe.violationCount === 0) {
      fail(label + ': the deliberate violation was NOT reported -- the collector is blind, so a clean run cannot be trusted');
    }
    if (probe.bypassRan) {
      fail(label + ': the injected inline script RAN -- the policy is present but not enforced');
    }
  } else {
    const { accepted, unexplained } = partition(probe.violations || []);
    if (accepted.length > 0) R.acceptedBlocks.push({ label, accepted });
    if (unexplained.length > 0) {
      fail(label + ': ' + unexplained.length + ' unexplained Content-Security-Policy violation(s): ' +
        JSON.stringify(unexplained.slice(0, 4)));
    }
  }
  if (other.length > 0) {
    fail(label + ': ' + other.length + ' unrelated uncaught error(s): ' +
      other.map((e) => String(e.msg)).slice(0, 3).join(' || ').slice(0, 300));
  }
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
  await send('Network.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Log.enable', {}, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: BOOTSTRAP }, sessionId);

  const evalv = async (expr) => {
    const r = await send('Runtime.evaluate',
      { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text, installed: false, errs: [], violationCount: 0, violations: [], text: '', elements: 0, svg: 0, canvas: 0, rootChildren: -1 };
    return r.result?.value;
  };

  await send('Page.navigate', { url: homeUrl }, sessionId);
  await sleep(BOOT_MS);
  inspect('home', await evalv(PROBE));

  const deepUrl = homeUrl + '?example=' + encodeURIComponent(EXAMPLE);
  await send('Page.navigate', { url: deepUrl }, sessionId);
  await sleep(BOOT_MS + 6000); // the deep link boots the editor and pulls the ~7 MB engine
  inspect('example:' + EXAMPLE, await evalv(PROBE));

  for (const s of STEPS) {
    const c = await evalv(CLICK_JS(s));
    await sleep(STEP_MS);
    if (!c || !c.clicked) fail('could not click step "' + s + '" (near: ' + JSON.stringify(c && c.near) + ')');
  }
  await sleep(SETTLE_MS);
  const settle = await evalv(PROBE);
  R.settle = { svg: settle.svg, canvas: settle.canvas, violationCount: settle.violationCount, text: settle.text.slice(0, 500) };

  for (const m of events) {
    if (m.method === 'Runtime.exceptionThrown') {
      R.exceptions.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    } else if (m.method === 'Log.entryAdded') {
      const text = m.params.entry.text || '';
      if (CSP_TEXT.test(text)) {
        if (ACCEPTED_LOG.test(text)) R.acceptedBlocks.push({ label: 'log', text: text.slice(0, 200) });
        else R.logViolations.push(text.slice(0, 300));
      } else if (m.params.entry.level === 'error') R.consoleErrors.push(text.slice(0, 300));
    }
  }
  ws.close();

  // --- assertions -----------------------------------------------------------
  if (settle.violationCount !== undefined) {
    R.domViolations = settle.violations || [];
  }
  if (SELF_TEST) {
    if (R.logViolations.length === 0 && (R.domViolations.length || 0) === 0) {
      fail('self-test: no violation reached DevTools either -- the collector is blind');
    }
    console.log('  self-test: domViolations=' + (R.domViolations.length || 0) +
      ' logViolations=' + R.logViolations.length + ' bypassRan=' + settle.bypassRan);
  } else {
    if (R.logViolations.length > 0) {
      fail(R.logViolations.length + ' unexplained policy violation(s) reported to DevTools: ' + String(R.logViolations[0]).slice(0, 240));
    }
    const left = partition(settle.violations || []);
    if (left.accepted.length > 0) R.acceptedBlocks.push({ label: 'final', accepted: left.accepted });
    if (left.unexplained.length > 0) {
      fail(left.unexplained.length + ' unexplained policy violation(s) in the final probe: ' +
        JSON.stringify(left.unexplained.slice(0, 4)));
    }
    console.log('  accepted blocks (policy still enforced, alarm narrowed): ' + JSON.stringify(R.acceptedBlocks));
    const rendered = (settle.svg || 0) + (settle.canvas || 0);
    if (rendered === 0) fail('no svg/canvas rendered after run (results surface missing)');
    if (!/finished|completed|simulation (was )?run/i.test(settle.text || '')) {
      fail('the simulation did not report completion -- the engine did not run under this policy');
    }
    const hard = R.exceptions.concat(R.consoleErrors).filter((e) => !CSP_TEXT.test(String(e)) &&
      !/unpkg\.com|favicon|404|api\/|Failed to load resource|net::ERR/i.test(String(e)));
    if (hard.length > 0) fail(hard.length + ' uncaught error(s) reached DevTools: ' + String(hard[0]).slice(0, 300));
  }
} catch (e) {
  R.fatal = String((e && e.stack) || e);
  fail('driver threw: ' + R.fatal.slice(0, 400));
} finally {
  try { chrome.kill(); } catch { /* gone */ }
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked */ }
  try { server.kill(); } catch { /* gone */ }
  await sleep(200);
  cleanupScratch();
}

const outPath = opt('json', null);
if (outPath) { try { writeFileSync(outPath, JSON.stringify(R, null, 2)); } catch { /* best effort */ } }

if (pass) {
  console.log('csp-conformance: PASS (' +
    (SELF_TEST
      ? 'the collector saw the deliberate violation and the policy refused to run it'
      : 'no violation while the editor booted, loaded an example and ran a simulation') + ')');
  process.exit(0);
}
console.log('csp-conformance: FAIL' + (outPath ? ' (trace in ' + outPath + ')' : ''));
process.exit(1);
