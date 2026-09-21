#!/usr/bin/env node
/**
 * The install payload, measured in a browser.
 *
 * scripts/check-artifacts.mjs check 5 sums the byte size of every file
 * shellUrls() names, which is the static half of the answer. This is the
 * runtime half: load the application, let install() run, then read the shell
 * cache back out and add up what is actually in it.
 *
 * The two channels are not the same measurement twice. The static one assumes
 * the worker stored each file as itself. This one reads the cache, so it catches
 * the case where the worker stored something else: the preview server (and the
 * deploy) answers a missing asset with the single-page-application fallback, so
 * a shellUrls() entry that 404s would put index.html into the cache under a
 * .png key. Every entry is therefore compared against the file on disk as well
 * as summed.
 *
 * The budget comes from scripts/precache-budget.json -- the same file check 5
 * reads -- so the two channels cannot drift apart about the number.
 *
 * Usage
 *   node scripts/precache-weight.mjs [--site=<dir>] [--budget=<file>]
 *                                    [--require] [--keep]
 *
 * Exit codes
 *   0  the stored payload is within budget and every target matched its file
 *   1  over budget, a target missing from the cache, or a target stored as
 *      something other than its file
 *   2  setup error
 *   3  no browser available (unless --require, which turns it into a 1)
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SHELL_CACHE_PREFIX, shellCacheState } from './shell-cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const has = (n) => argv.some((a) => a === '--' + n);

const SITE = resolve(flag('site', join(REPO_ROOT, 'site')));
const BUDGET_FILE = resolve(flag('budget', join(REPO_ROOT, 'scripts', 'precache-budget.json')));
const REQUIRE = has('require');
const KEEP = has('keep');
const PORT = Number(flag('port', '8490'));

const SW = join(SITE, 'sw.js');
if (!existsSync(SW)) { console.error('precache-weight: no sw.js at ' + SW); process.exit(2); }
if (!existsSync(BUDGET_FILE)) { console.error('precache-weight: no budget file at ' + BUDGET_FILE); process.exit(2); }

let budget = null;
try {
  budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8')).maxBytes;
} catch (e) {
  console.error('precache-weight: cannot read the budget file: ' + e.message);
  process.exit(2);
}
if (typeof budget !== 'number' || budget <= 0) {
  console.error('precache-weight: the budget file has no usable maxBytes');
  process.exit(2);
}

// Read the shell list out of the worker with the same shape check 5 matches, so
// a target added to shellUrls() is measured here without a second edit.
const SW_SHELL = /new URL\(\s*"([^"]*)"\s*,\s*scope\s*\)/g;
const swText = readFileSync(SW, 'utf8');
const shellUrls = [];
let m;
while ((m = SW_SHELL.exec(swText)) !== null) shellUrls.push(m[1]);
if (shellUrls.length === 0) { console.error('precache-weight: sw.js names no precache targets'); process.exit(2); }

// Each target's size on disk, resolved the same way check 5 resolves it.
const disk = new Map();
for (const raw of shellUrls) {
  const file = raw === './' ? 'index.html' : raw;
  const p = join(SITE, file.split('/').join('\\'));
  disk.set(raw, existsSync(p) ? statSync(p).size : null);
}

const CHROME = [
  process.env.CHROME_BIN,
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean).find((p) => existsSync(p));

if (!CHROME) {
  console.log('precache-weight: SKIP (no browser found; pass --require to fail instead)');
  process.exit(REQUIRE ? 1 : 3);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = '/spice-simulator/';
const TARGET_URL = `http://127.0.0.1:${PORT}${BASE}`;

const server = spawn(process.execPath, [join(HERE, 'serve-local.mjs'), `--port=${PORT}`, `--site=${SITE}`, '--cache=public'], { stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = '';
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => { srvErr += d.toString(); });

let serverUp = false;
for (let i = 0; i < 80 && !serverUp; i++) {
  try { const r = await fetch(TARGET_URL); if (r.ok) serverUp = true; } catch {}
  if (!serverUp) await sleep(250);
}
if (!serverUp) {
  console.error('precache-weight: the preview server never answered' + (srvErr ? ' -- ' + srvErr.slice(0, 300) : ''));
  try { server.kill(); } catch {}
  process.exit(2);
}

// Confirm the server on this port is serving the tree we asked for. A leftover
// server from an earlier run would answer just as happily, and the whole point
// of this probe is to measure a specific tree -- so compare one byte length
// before trusting anything.
{
  const probePath = 'logo.png';
  const r = await fetch(TARGET_URL + probePath);
  const body = Buffer.from(await r.arrayBuffer());
  const expected = disk.get(probePath);
  if (!r.ok || body.length !== expected) {
    console.error('precache-weight: the server at ' + TARGET_URL + ' is not serving ' + SITE +
      ' (logo.png came back as ' + (r.ok ? body.length + ' B' : 'HTTP ' + r.status) +
      ', expected ' + expected + ' B) -- is another server holding port ' + PORT + '?');
    try { server.kill(); } catch {}
    process.exit(2);
  }
}

const profile = mkdtempSync(join(tmpdir(), 'precache-weight-'));
const DBG = PORT + 700;
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${DBG}`,
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--window-size=1280,900', 'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] });
let chromeErr = '';
chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

const result = { site: SITE, budgetBytes: budget, targets: [], notes: [] };

try {
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try { const r = await fetch(`http://127.0.0.1:${DBG}/json/version`); if (r.ok) ver = await r.json(); } catch {}
    if (!ver) await sleep(250);
  }
  if (!ver) throw new Error('no devtools endpoint: ' + chromeErr.slice(0, 300));

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('devtools websocket refused')); });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const msg = { id: ++id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    pending.set(msg.id, { res, rej });
    ws.send(JSON.stringify(msg));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
    }
  };
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  const evalv = async (expression, label = 'evaluate') => {
    // A probe that hangs is worse than a probe that fails: the case it exists to
    // report turns into a CI timeout with no diagnosis. navigator.serviceWorker
    // .ready is exactly such a promise -- when install() aborts it never settles
    // and never rejects, so awaiting it would block forever. Every page call is
    // therefore raced against a deadline.
    const r = await Promise.race([
      send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error('the page never answered ' + label + ' within 45s')), 45000)),
    ]);
    if (r.exceptionDetails) throw new Error('page threw in ' + label + ': ' + JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails).slice(0, 300));
    return r.result?.value;
  };

  await send('Page.navigate', { url: TARGET_URL }, sessionId);
  // Let the bundle boot and register the worker.
  await sleep(15000);
  result.registered = await evalv(`(async () => {
    try {
      return await Promise.race([
        navigator.serviceWorker.ready.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 8000)),
      ]);
    } catch { return false; }
  })()`, 'navigator.serviceWorker.ready');
  // One reload so the page is controlled by the worker that just installed.
  await send('Page.navigate', { url: TARGET_URL }, sessionId);
  await sleep(12000);

  result.controlled = await evalv(`!!navigator.serviceWorker.controller`);

  const measured = await evalv(`(async () => {
    const names = await caches.keys();
    const shellName = names.find((n) => n.startsWith('icm-static-shell-'));
    if (!shellName) return { error: 'no icm-static-shell-* cache', names };
    const cache = await caches.open(shellName);
    const keys = await cache.keys();
    const wanted = ${JSON.stringify(shellUrls.map((raw) => new URL(raw, `http://127.0.0.1:${PORT}${BASE}`).toString()))};
    const label = ${JSON.stringify(shellUrls)};
    const out = [];
    for (let i = 0; i < wanted.length; i++) {
      const r = await cache.match(wanted[i]);
      if (!r) { out.push({ raw: label[i], url: wanted[i], stored: null }); continue; }
      const blob = await r.blob();
      out.push({ raw: label[i], url: wanted[i], stored: blob.size, type: r.headers.get('content-type') || '' });
    }
    return { shellName, entries: keys.length, allKeys: keys.map((k) => k.url), targets: out };
  })()`);

  if (measured.error) throw new Error(measured.error + ' (' + (measured.names || []).join(', ') + ')');

  result.cacheName = measured.shellName;
  result.cacheEntries = measured.entries;
  result.allKeys = measured.allKeys;
  result.targets = measured.targets;

  // The runtime half of check 13. The static check proves the declared constant
  // describes this tree; this proves the cache the browser ACTUALLY opened is
  // that same one. Neither implies the other: a tree whose sw.js declared a
  // stale token would still have the browser open it faithfully, and a worker
  // that opened some other cache would satisfy every string test while serving
  // entries the guard never inspected.
  const derivedShell = shellCacheState(SITE);
  result.derivedCacheName = SHELL_CACHE_PREFIX + derivedShell.token;
  result.declaredCacheName = derivedShell.declared === null
    ? null
    : SHELL_CACHE_PREFIX + derivedShell.declared;

  let total = 0;
  let bad = 0;
  const problems = [];
  if (measured.shellName !== result.derivedCacheName) {
    bad++;
    problems.push('the browser opened cache "' + measured.shellName + '", but this tree derives "' +
      result.derivedCacheName + '" (declared ' + (result.declaredCacheName ?? '(none)') + ')');
  }
  if (!result.registered) {
    // install() aborted, so the shell cache is either absent or empty. Say so
    // first: it is the reason everything below will be missing.
    bad++;
    problems.push('the worker never activated, so install() aborted (addAll() is atomic)');
    console.log('precache-weight: the worker never reached the active state -- install() aborted');
    console.log('   (cache.addAll() is atomic, so one target that fails to fetch leaves the shell uninstalled)');
  }
  console.log('precache-weight: cache "' + measured.shellName + '" holds ' + measured.entries + ' entry(ies)' +
    (measured.shellName === result.derivedCacheName
      ? '  (matches scripts/shell-cache.mjs)'
      : '  <- NOT the derived name ' + result.derivedCacheName));
  console.log('');
  console.log('   stored B    disk B  target');
  for (const t of measured.targets) {
    const d = disk.get(t.raw);
    let tag = '';
    if (t.stored === null) { tag = '  <- NOT IN CACHE'; bad++; problems.push(t.raw + ' is not in the cache'); }
    else if (d === null) { tag = '  <- no file on disk'; bad++; problems.push(t.raw + ' has no file on disk'); }
    else if (t.stored !== d) {
      tag = '  <- stored ' + t.stored + ' B but the file is ' + d + ' B';
      bad++;
      problems.push(t.raw + ' was stored as ' + t.stored + ' B, not its ' + d + ' B file');
    }
    total += t.stored ?? 0;
    console.log(
      '  ' + String(t.stored ?? '-').padStart(8) + '  ' + String(d ?? '-').padStart(8) + '  ' + t.raw + tag,
    );
  }
  console.log('  ' + String(total).padStart(8) + '  ' + String('').padStart(8) + '  TOTAL');
  console.log('');
  console.log('precache-weight: ' + (total / 1024).toFixed(1) + ' KiB stored of a ' + (budget / 1024).toFixed(1) + ' KiB budget');

  result.totalBytes = total;
  result.overBudget = total > budget;

  if (bad) {
    console.log('precache-weight: FAIL (' + problems.slice(0, 4).join('; ') +
      (problems.length > 4 ? '; and ' + (problems.length - 4) + ' more' : '') + ')');
    result.status = 'mismatch';
    result.problems = problems;
  } else if (total > budget) {
    console.log('precache-weight: FAIL (over budget by ' + ((total - budget) / 1024).toFixed(1) + ' KiB)');
    result.status = 'over-budget';
  } else {
    console.log('precache-weight: PASS (every target stored as its own file, within budget)');
    result.status = 'pass';
  }
  ws.close();
} catch (e) {
  console.log('precache-weight: FAIL (' + String((e && e.message) || e) + ')');
  result.status = 'error';
  result.error = String((e && e.stack) || e);
} finally {
  try { chrome.kill(); } catch {}
  try { server.kill(); } catch {}
  await sleep(400);
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {}
}

writeFileSync(join(REPO_ROOT, 'precache-weight-result.json'), JSON.stringify(result, null, 2));
if (KEEP) console.log('precache-weight: scratch profile kept at ' + profile);
process.exit(result.status === 'pass' ? 0 : 1);
