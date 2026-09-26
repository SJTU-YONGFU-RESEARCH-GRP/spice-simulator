#!/usr/bin/env node
/**
 * Does the Gallery panel work on a static deploy?
 *
 * The panel reads four origin-root endpoints and only a server can answer them:
 *
 *   /api/gallery                       list  (+ ?author=, ?tags=, ?cursor=)
 *   /api/gallery/tags                  tag facets
 *   /api/gallery/<id>                  one entry, as { projectText, entry, ... }
 *   /api/gallery/<id>/preview.svg      the card image
 *
 * They live at the origin root, while this application is deployed under
 * /spice-simulator/ and its worker is registered with scope /spice-simulator/.
 * Reading that, the natural conclusion is that a worker cannot answer them at
 * all -- out of scope. That conclusion is wrong, and this script is how it was
 * falsified: a fetch made by a *controlled* page fires the fetch event
 * regardless of the request URL, and respondWith() is honoured for it. Scope
 * decides which clients a worker controls, not which of their requests it sees.
 * So "use the worker as a static API shim" is possible here after all.
 *
 * scripts/gallery-shim.json routes those four to files committed under
 * <scope>gallery/. This script drives the panel in a real browser and reports
 * what the product does, on two trees:
 *
 *   shipped   the committed site/, unmodified. The gallery must stay DARK --
 *             the built-in example card is what a student sees -- while the two
 *             list endpoints stop being 404s. A shim that lit the panel up here
 *             would be replacing the example list, not adding to it.
 *   fixture   a copy of site/ plus a two-entry gallery/. The panel must LIGHT:
 *             the search box and tag menu appear, the cards render, the preview
 *             image loads, and clicking a card opens the circuit through
 *             /api/gallery/<id> -- which is the half a list-only test would miss.
 *
 * The fixture's project payload is not hand-written: it is lifted out of the
 * shipped chunk and evaluated, the same way check 6 and 7 exercise the JSX
 * runtime and the unlock gate. A hand-rolled payload would test my reading of a
 * schema instead of the product's.
 *
 * Why the fixture is not shippable as default content: the panel renders
 * `showGallery ? galleryCards : builtinCards`, so ANY entry replaces the
 * built-in example list -- including whatever the instructor unlock reveals --
 * and this route has no unlock check, so listing the locked labs here would
 * bypass that gate instead. See the README.
 *
 * Usage
 *   node scripts/gallery-shim.mjs [--site=<dir>] [--only=shipped,fixture]
 *                                [--require] [--keep] [--json] [--timeout-ms=N]
 *
 * Exit codes: 0 pass, 1 assertion failed, 2 setup error (browser/server/tree).
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

const REQUIRE = has('require');
const KEEP = has('keep');
const NO_SERVER = has('no-server');
const SITE = resolve(opt('site', join(REPO_ROOT, 'site')));
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const TIMEOUT_MS = Number(opt('timeout-ms', '45000'));
const READY_MS = Number(opt('ready-ms', '25000'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the contract
// The expected URL set and shapes come from the shipped client, not from me.
function readGalleryContract(siteDir) {
  const dir = join(siteDir, 'assets');
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.js')) : [];
  const client = names.find((f) => /^gallery-client-/.test(f));
  if (!client) throw new Error('no gallery-client-*.js in this tree');
  const src = readFileSync(join(dir, client), 'utf8');

  const endpoints = new Set();
  for (const m of src.matchAll(/[`'"](\/api\/gallery[^`'"]*)[`'"]/g)) endpoints.add(m[1]);
  // The two detail calls live in the App chunk, not the client.
  const app = names.find((f) => /^App-/.test(f));
  const appSrc = app ? readFileSync(join(dir, app), 'utf8') : '';
  for (const m of appSrc.matchAll(/[`'"](\/api\/gallery\/[^`'"]*)[`'"]/g)) endpoints.add(m[1]);

  // Shapes the client actually reads back.
  const listKeys = ['entries', 'nextCursor', 'total'].filter((k) => src.includes('n.' + k) || src.includes('.' + k + '??'));
  return {
    client,
    endpoints: [...endpoints].sort(),
    readsListShape: /entries\?\?\[\]/.test(src),
    readsTagsShape: /\)\.tags\?\?\[\]/.test(src),
    readsProjectText: /u\.projectText|n\?\.projectText/.test(appSrc + src),
    listShape: listKeys,
  };
}

// ------------------------------------------------------- fixture project payload
// Lift `var Qh={...}` out of the App chunk and evaluate it. Braces inside
// strings and template literals must be skipped or the match ends early.
function liftExampleProject(siteDir) {
  const dir = join(siteDir, 'assets');
  const app = readdirSync(dir).filter((f) => f.endsWith('.js')).find((f) => /^App-/.test(f));
  const text = readFileSync(join(dir, app), 'utf8');
  const START = 'var Qh={';
  const at = text.indexOf(START);
  if (at === -1) return null;
  const open = at + START.length - 1;

  const matchBrace = (src, i) => {
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
      if (c === '"' || c === "'" || c === '`') {
        const q = c; i++;
        for (; i < src.length; i++) {
          if (src[i] === '\\') { i++; continue; }
          if (src[i] === q) break;
          if (q === '`' && src[i] === '$' && src[i + 1] === '{') i = matchBrace(src, i + 1);
        }
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return i; }
    }
    throw new Error('unbalanced payload literal');
  };

  const literal = text.slice(at, matchBrace(text, open) + 1).replace(/^var\s+Qh\s*=/, '');
  if (literal.includes('${')) throw new Error('payload literal interpolates; refusing to evaluate it');
  const value = new Function('return (' + literal + ')')();
  if (!value || typeof value.id !== 'string') throw new Error('payload did not evaluate to a project');
  return { id: value.id, name: value.name, json: JSON.stringify(value), documents: (value.documents ?? []).length };
}

const PREVIEW_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 96" width="160" height="96">' +
  '<rect width="160" height="96" fill="#f4f7f6"/>' +
  '<path d="M24 48h36M100 48h36" stroke="#1e3d36" stroke-width="2" fill="none"/>' +
  '<rect x="60" y="34" width="40" height="28" fill="none" stroke="#1e3d36" stroke-width="2"/>' +
  '<text x="80" y="88" font-family="sans-serif" font-size="9" fill="#1e3d36" text-anchor="middle">fixture</text>' +
  '</svg>';

const CHROME = [
  process.env.CHROME_BIN, process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean).find((p) => existsSync(p)) ?? null;

function deriveBase() {
  const explicit = opt('base', null);
  if (explicit) return explicit;
  for (const rel of ['package.json', '../package.json']) {
    const p = join(REPO_ROOT, rel);
    if (!existsSync(p)) continue;
    const m = /"homepage"\s*:\s*"([^"]+)"/.exec(readFileSync(p, 'utf8'));
    if (m) return new URL(m[1]).pathname;
  }
  return '/spice-simulator/';
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

// --------------------------------------------------------------- the two trees
const work = mkdtempSync(join(tmpdir(), 'gallery-shim-'));

function buildFixtureTree(project) {
  const dir = join(work, 'fixture-site');
  cpSync(SITE, dir, { recursive: true });
  const entries = [
    { id: 'common-source-amplifier', name: project.name, description: 'fixture: the shipped example, relisted', tags: ['amplifier', 'nmos'], previewRevision: 'fixture-1' },
    { id: 'fixture-second', name: 'Fixture Second', description: 'fixture: second entry, same payload', tags: ['amplifier', 'cmos'], previewRevision: 'fixture-2' },
  ];
  mkdirSync(join(dir, 'gallery'), { recursive: true });
  writeFileSync(join(dir, 'gallery', 'index.json'), JSON.stringify({ entries }, null, 2));
  for (const e of entries) {
    const d = join(dir, 'gallery', e.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'project.json'), project.json);
    writeFileSync(join(d, 'preview.svg'), PREVIEW_SVG);
  }
  return { dir, entries };
}

const CASES = [
  {
    id: 'shipped',
    label: 'committed tree, no gallery/ directory',
    tree: () => ({ dir: SITE, entries: [] }),
    expect: { lit: false, entries: 0 },
  },
  {
    id: 'fixture',
    label: 'copy of the tree plus a two-entry gallery/',
    tree: (project) => buildFixtureTree(project),
    expect: { lit: true, entries: 2 },
  },
];

const R = { site: SITE, base: BASE, chrome: CHROME, timeoutMs: TIMEOUT_MS, cases: [] };
let pass = true;
// `failures` is what makes the per-case verdict in the result file mean anything.
// `runCase` returns 0 whenever it reached the end of the case, and a case whose
// every assertion failed still reaches the end -- so "returned 0" is NOT the same
// statement as "behaved". The mutation suite reads the result file to decide which
// cases went red, and while those two were conflated it reported every mutant as
// having passed. Counting here, and diffing per case below, is the fix.
let failures = 0;
const fail = (msg) => { pass = false; failures += 1; console.log('  FAIL: ' + msg); };
const note = (msg) => console.log('  note: ' + msg);

async function main() {
  if (!CHROME) { console.error('gallery-shim: no Chrome/Edge found; pass none -- this check needs a browser'); return 2; }

  let contract;
  try { contract = readGalleryContract(SITE); } catch (e) {
    console.error('gallery-shim: ' + e.message); return 2;
  }
  R.contract = contract;
  console.log('gallery-shim: browser=' + CHROME);
  console.log('gallery-shim: site=' + SITE + '  base=' + BASE);
  console.log('gallery-shim: client contract, read off ' + contract.client + ':');
  for (const e of contract.endpoints) console.log('    ' + e);
  console.log('    reads list shape   : ' + contract.readsListShape);
  console.log('    reads tags shape   : ' + contract.readsTagsShape);
  console.log('    reads projectText  : ' + contract.readsProjectText);

  let project = null;
  try { project = liftExampleProject(SITE); } catch (e) { note('could not lift the example payload: ' + e.message); }
  if (!project) { console.error('gallery-shim: the fixture needs a real project payload; not found'); return 2; }
  console.log('gallery-shim: fixture payload lifted from the chunk: id=' + project.id +
    ' documents=' + project.documents + ' (' + project.json.length + ' B)');

  const targets = ONLY.length ? CASES.filter((c) => ONLY.includes(c.id)) : CASES;
  if (!targets.length) { console.error('gallery-shim: --only matched no case'); return 2; }
  // A focused run is for iterating; it must not be able to pass CI, where the
  // claim is about both trees.
  if (REQUIRE && targets.length !== CASES.length) {
    console.error('gallery-shim: --require refuses a focused run (' + targets.length + ' of ' + CASES.length + ' case(s))');
    return 2;
  }

  for (const c of targets) {
    console.log('\n== ' + c.id + ' -- ' + c.label + ' ==');
    const built = c.tree(project);
    const rec = { id: c.id, tree: built.dir, entries: built.entries.length, panel: null, api: [], announce: [], previewLoaded: null, errors: [] };
    const before = failures;
    const code = await runCase(c, built, rec);
    // behaved = reached the end AND raised nothing. `code === 0` alone is only
    // "reached the end"; see the note on `failures` above.
    rec.failures = failures - before;
    rec.ok = code === 0 && rec.failures === 0;
    R.cases.push(rec);
    if (!rec.ok) pass = false;
  }

  const outPath = join(REPO_ROOT, 'gallery-shim-result.json');
  writeFileSync(outPath, JSON.stringify(R, null, 2));

  console.log('\ngallery-shim: ' + R.cases.filter((c) => c.ok).length + ' of ' + R.cases.length + ' case(s) behaved as required');
  console.log('gallery-shim: ' + (pass ? 'PASS' : 'FAIL'));
  if (!KEEP) { try { rmSync(work, { recursive: true, force: true }); } catch {} }
  return pass ? 0 : 1;
}

async function runCase(c, built, rec) {
  let server = null;
  let TARGET_URL = opt('url', null);
  if (!TARGET_URL) {
    if (NO_SERVER) { console.error('gallery-shim: --no-server requires --url'); return 2; }
    const port = Number(opt('port', String(9600 + Math.floor(Math.random() * 90))));
    server = spawn(process.execPath, [join(HERE, 'serve-local.mjs'), '--port=' + port, '--base=' + BASE, '--cache=public', '--site=' + built.dir],
      { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    server.stderr.on('data', (d) => { err += d.toString(); });
    if (!(await waitForServer('http://127.0.0.1:' + port + PREFIX + '/', 15000))) {
      console.error('gallery-shim: preview server did not come up; stderr=' + err.slice(0, 500));
      try { server.kill(); } catch {}
      return 2;
    }
    TARGET_URL = 'http://127.0.0.1:' + port + PREFIX + '/';
  }

  const profile = mkdtempSync(join(tmpdir(), 'gallery-chrome-'));
  const DP = 9600 + Math.floor(Math.random() * 300);
  const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--mute-audio',
    '--user-data-dir=' + profile, '--remote-debugging-port=' + DP, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-default-apps', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--window-size=1600,1000', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let chromeErr = '';
  chrome.stderr.on('data', (d) => { chromeErr += d.toString(); });

  const cleanup = () => { try { chrome.kill(); } catch {} if (server) { try { server.kill(); } catch {} } };

  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) {
    try { const r = await fetch('http://127.0.0.1:' + DP + '/json/version'); if (r.ok) ver = await r.json(); } catch {}
    await sleep(250);
  }
  if (!ver) { console.error('gallery-shim: devtools never came up; stderr=' + chromeErr.slice(0, 500)); cleanup(); return 2; }

  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
  let id = 0; const pending = new Map(); const events = [];
  const SEND_TIMEOUT_MS = Number(opt('send-timeout-ms', '20000'));
  const send = (m, p = {}, s, ms = SEND_TIMEOUT_MS) => new Promise((res, rej) => {
    const msg = { id: ++id, method: m, params: p }; if (s) msg.sessionId = s;
    const to = setTimeout(() => { pending.delete(msg.id); rej(new Error('timeout ' + m)); }, ms);
    pending.set(msg.id, { res: (v) => { clearTimeout(to); res(v); }, rej: (e) => { clearTimeout(to); rej(e); } });
    ws.send(JSON.stringify(msg));
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(m.method + ' ' + JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === 'Page.javascriptDialogOpening') { ws.send(JSON.stringify({ id: ++id, method: 'Page.handleJavaScriptDialog', params: { accept: true }, sessionId })); return; }
    if (m.method) events.push(m);
  };
  await send('Target.setDiscoverTargets', { discover: true });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
  for (const d of ['Page', 'Network', 'Runtime', 'Log']) await send(d + '.enable', {}, sessionId);

  const evalv = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId);
    if (r.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 400) };
    return r.result?.value;
  };
  const poll = async (fn, deadlineMs, intervalMs) => {
    const end = Date.now() + deadlineMs;
    for (;;) { const v = await fn(); if (v) return v; if (Date.now() >= end) return null; await sleep(intervalMs); }
  };

  // The per-case verdict is set by the caller, which is the only place that can
  // tell "reached the end" from "behaved"; this only tears down.
  const finish = (code) => { cleanup(); return code; };

  // The worker has to be controlling before any of this means anything, and
  // `ready` is a promise that never settles on its own -- so it carries a
  // deadline rather than being allowed to hang the run.
  await send('Page.navigate', { url: TARGET_URL }, sessionId);
  await sleep(3000);
  const ready = await evalv(`Promise.race([navigator.serviceWorker.ready.then(()=>'ready'),new Promise(r=>setTimeout(()=>r('timeout'),${READY_MS}))])`);
  if (ready !== 'ready') { fail(c.id + ': the worker never reached ready (' + JSON.stringify(ready) + ')'); return finish(2); }
  await send('Page.navigate', { url: TARGET_URL }, sessionId);
  await sleep(3000);

  const control = await evalv('navigator.serviceWorker.controller ? navigator.serviceWorker.controller.scriptURL : null');
  if (!control) { fail(c.id + ': the page is not controlled by a worker, so nothing below is about the shim'); return finish(2); }
  console.log('  worker controlling: ' + control.replace(/^.*\//, ''));

  const from = events.length;
  const TOGGLE_JS = `(function(){
    const t = document.querySelector('[data-testid=examples-toggle]');
    if (!t) return { found: false };
    const out = { found: true, disabled: t.disabled === true, wasExpanded: t.getAttribute('aria-expanded') };
    if (t.disabled) return out;
    if (t.getAttribute('aria-expanded') !== 'true') t.click();
    out.label = (t.getAttribute('aria-label') || '').slice(0, 40);
    return out;
  })()`;
  const toggled = await evalv(TOGGLE_JS);
  if (!toggled || !toggled.found) { fail(c.id + ': no [data-testid=examples-toggle] to open the panel with'); return finish(2); }
  if (toggled.disabled) { fail(c.id + ': the gallery toggle is disabled, so the panel cannot be opened'); return finish(2); }
  console.log('  toggle: ' + JSON.stringify(toggled));

  const PANEL_JS = `(function(){
    const p = document.querySelector('[data-testid=examples-panel]');
    const builtin = [...document.querySelectorAll('[data-testid^="shapes-example-"]')];
    const gal = [...document.querySelectorAll('[data-testid^="gallery-example-"]')];
    const cnt = document.querySelector('[data-testid=examples-panel-count]');
    const img = gal.length ? gal[0].querySelector('img') : null;
    return {
      panelFound: !!p,
      open: p ? p.getAttribute('data-open') : null,
      builtin: builtin.length,
      gallery: gal.length,
      galleryIds: gal.map(b => b.getAttribute('data-testid').replace('gallery-example-','')),
      controls: !!document.querySelector('.examples-panel-controls'),
      search: !!document.querySelector('[data-testid=examples-panel-search]'),
      tagToggle: !!document.querySelector('[data-testid=examples-panel-tag-toggle]'),
      tags: [...document.querySelectorAll('.examples-panel-tag-option')].map(l => {
        const s = [...l.querySelectorAll('span')];
        return { tag: s[0] ? s[0].textContent.trim() : null, count: s[1] ? s[1].textContent.trim() : null };
      }),
      countText: cnt ? (cnt.textContent || '').trim() : null,
      previewSrc: img ? img.getAttribute('src') : null,
      previewLoaded: img ? (img.complete && img.naturalWidth > 0) : null,
    };
  })()`;

  // Opening the panel is not the same moment as the panel having data: the list
  // request starts on open and React renders the cards after it resolves. Reading
  // the DOM at `data-open=true` reports the pre-fetch state -- which is how the
  // first run of this script reported "0 gallery cards" on a fixture whose
  // preview requests had demonstrably gone out. So wait for the response first,
  // then let the render settle.
  const listSeen = await poll(
    () => events.slice(from).some((m) => m.method === 'Network.responseReceived' &&
      /\/api\/gallery(\?|$)/.test(m.params.response.url)) || null,
    15000, 250,
  );
  if (!listSeen) note(c.id + ': no /api/gallery response observed; reading the panel anyway');
  await sleep(1500);

  const panel = await poll(async () => {
    const v = await evalv(PANEL_JS);
    if (!v || v.__error) return null;
    return v.panelFound && v.open === 'true' ? v : null;
  }, 10000, 400);
  if (!panel) { fail(c.id + ': the examples panel never reported data-open=true'); return finish(1); }
  rec.panel = panel;
  console.log('  builtin=' + panel.builtin + ' gallery=' + panel.gallery + ' controls=' + panel.controls +
    ' search=' + panel.search + ' tagToggle=' + panel.tagToggle +
    ' count=' + JSON.stringify(panel.countText));

  // The tag options are rendered only while the tag menu is expanded, so a
  // snapshot of a collapsed panel reports no facets even when /api/gallery/tags
  // answered. Expand it the way a user would, then read.
  if (panel.tagToggle) {
    const expanded = await evalv(`(function(){
      const b = document.querySelector('[data-testid=examples-panel-tag-toggle]');
      if (!b) return 'no-toggle';
      if (b.getAttribute('aria-expanded') !== 'true') b.click();
      return 'ok';
    })()`);
    if (expanded !== 'ok') note(c.id + ': could not expand the tag menu (' + JSON.stringify(expanded) + ')');
    const facets = await poll(async () => {
      const v = await evalv(`[...document.querySelectorAll('.examples-panel-tag-option')].map((l) => {
        const s = [...l.querySelectorAll('span')];
        return { tag: s[0] ? s[0].textContent.trim() : null, count: s[1] ? s[1].textContent.trim() : null };
      })`);
      return Array.isArray(v) && v.length > 0 ? v : null;
    }, 8000, 300);
    panel.tags = facets ?? [];
    console.log('  tag facets: ' + JSON.stringify(panel.tags));
  }

  // Clicking a card is the half a list-only test cannot see: it goes
  // /api/gallery/<id> -> projectText -> parse -> open, and the product says so.
  if (built.entries.length > 0) {
    const loaded = await poll(async () => {
      const v = await evalv(`(function(){
        const c = document.querySelector('[data-testid^="gallery-example-"]');
        const i = c ? c.querySelector('img') : null;
        return i ? (i.complete && i.naturalWidth > 0) : null;
      })()`);
      return v === true ? true : null;
    }, 8000, 400);
    panel.previewLoaded = loaded === true;

    const CLICK_JS = `(function(){
      const vis = [...document.querySelectorAll('[data-testid^="gallery-example-"]')]
        .filter(b => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
      if (!vis.length) return 'no-visible-card';
      vis[0].click();
      return 'clicked:' + vis[0].getAttribute('data-testid');
    })()`;
    const clicked = await evalv(CLICK_JS);
    console.log('  card click: ' + JSON.stringify(clicked));
    const announcement = await poll(async () => {
      const text = await evalv(`(function(){
        const live = [...document.querySelectorAll('[role=status],[role=alert],[aria-live]')].map(e => (e.innerText||'').trim()).filter(Boolean);
        return live.join(' | ') + ' || ' + (document.body ? document.body.innerText : '').replace(/\\s+/g,' ');
      })()`);
      if (typeof text !== 'string') return null;
      const m = text.match(/(Place [^·|]{1,80} on the canvas|Opened gallery circuit: [^|]{1,80}|This gallery entry is unavailable)/);
      return m ? m[0].trim() : null;
    }, 12000, 500);
    rec.announce.push(announcement);
    console.log('  product said: ' + JSON.stringify(announcement));
    if (!announcement) fail(c.id + ': clicking a gallery card produced no recognisable outcome');
    else if (/unavailable/i.test(announcement)) fail(c.id + ': clicking a gallery card reported it unavailable: ' + announcement);
  }

  await sleep(600);
  rec.api = events.slice(from).filter((m) => m.method === 'Network.responseReceived')
    .map((m) => ({ url: m.params.response.url, status: m.params.response.status }))
    .filter((r) => /\/api\/gallery/.test(r.url));

  const listResponse = rec.api.find((r) => /\/api\/gallery(\?|$)/.test(r.url));
  const want = c.expect;

  if (!listResponse) {
    fail(c.id + ': the panel never requested /api/gallery, so the shim was not exercised');
  } else if (listResponse.status !== 200) {
    fail(c.id + ': /api/gallery answered ' + listResponse.status + ', expected 200 from the shim');
  }

  if (want.lit) {
    if (!panel.controls || !panel.search) fail(c.id + ': the gallery is populated but the search controls did not appear');
    if (panel.gallery !== want.entries) fail(c.id + ': ' + panel.gallery + ' gallery card(s) rendered, expected ' + want.entries);
    if (panel.builtin !== 0) fail(c.id + ': ' + panel.builtin + ' built-in card(s) still rendered; a populated gallery replaces them');
    if (!panel.tagToggle) fail(c.id + ': no tag menu, so /api/gallery/tags did not contribute facets');
    const amplifier = panel.tags.find((t) => t.tag === 'amplifier');
    if (!amplifier) fail(c.id + ': the tag facets do not include "amplifier", which both fixture entries carry');
    else if (amplifier.count !== '2') fail(c.id + ': tag "amplifier" reports count ' + JSON.stringify(amplifier.count) + ', expected "2"');
    if (panel.previewLoaded !== true) fail(c.id + ': the preview image did not load (previewLoaded=' + panel.previewLoaded + ')');
    if (panel.previewSrc && !/\/api\/gallery\/.+\/preview\.svg/.test(panel.previewSrc)) {
      fail(c.id + ': the card image is not the revisioned preview URL: ' + panel.previewSrc);
    }
  } else {
    if (panel.gallery !== 0) fail(c.id + ': the gallery rendered ' + panel.gallery + ' card(s) on a tree with no gallery/ directory');
    if (panel.controls || panel.search) fail(c.id + ': gallery controls appeared on a tree with no gallery/ directory');
    if (panel.builtin < 1) fail(c.id + ': the built-in example card is gone; the shipped tree must keep it');
    note('built-in card(s) still shown: ' + panel.builtin + ' -- the gallery is enabled but empty, which is the shipped state');
  }

  const otherApi = [...new Set(rec.api.map((r) => r.url.replace(/^https?:\/\/[^/]+/, '')))];
  console.log('  /api/gallery responses: ' + JSON.stringify(rec.api.map((r) => r.url.replace(/^https?:\/\/[^/]+/, '') + ' -> ' + r.status)));
  if (rec.api.some((r) => r.status >= 500)) fail(c.id + ': an /api/gallery request answered 5xx');

  return finish(0);
}

process.exit(await main());
