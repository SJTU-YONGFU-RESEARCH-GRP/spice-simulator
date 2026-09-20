#!/usr/bin/env node
/**
 * Serve site/ locally, mounted at the deployed base path.
 *
 * The artifact cannot be opened with file:// and it cannot be served from its
 * own root. Every URL index.html carries is root-absolute and already contains
 * the Pages project prefix:
 *
 *     <script type="module" src="/spice-simulator/assets/index-7P_aude7.js">
 *
 * Opening site/index.html directly resolves that against the file system root
 * (or against whatever the static server calls its root), so the browser asks
 * for something that does not exist and renders nothing. The base is part of
 * the contract, so a preview has to reproduce it.
 *
 * Usage
 *   node scripts/serve-local.mjs [options]
 *
 *   --port=<n>     Default 8080
 *   --base=<path>  Default derived from package.json "homepage"
 *   --site=<dir>   Default <repo>/site
 *
 * Notes
 *   - Cache-Control: no-store on purpose. The artifact registers a service
 *     worker that serves scripts cache-first; a preview that lets the browser
 *     cache anything is a preview of yesterday's files.
 *   - Unknown paths fall back to index.html only when the request looks like a
 *     document, so a missing .js still answers 404 instead of a HTML page that
 *     the browser would fail to parse as a module.
 */
import { createReadStream, existsSync, statSync, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : fallback;
};
if (argv.some((a) => a === '--help' || a === '-h')) {
  console.log('usage: node scripts/serve-local.mjs [--port=8080] [--base=/spice-simulator/] [--site=<dir>]');
  process.exit(0);
}

async function deriveBase() {
  try {
    const pkg = JSON.parse(await fs.readFile(join(REPO_ROOT, 'package.json'), 'utf8'));
    const path = new URL(pkg.homepage).pathname.replace(/\/?$/, '/');
    return path.startsWith('/') ? path : '/' + path;
  } catch {
    return '/';
  }
}

const site = resolve(flag('site', join(REPO_ROOT, 'site')));
const port = Number(flag('port', '8080'));
const base0 = flag('base', await deriveBase());
const BASE = (base0.startsWith('/') ? base0 : '/' + base0).replace(/\/?$/, '/');
const PREFIX = BASE.slice(0, -1); // "/spice-simulator"

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.lib': 'text/plain; charset=utf-8',
  '.model': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};

// Fail loudly on a wrong path. Without this a mistyped --site answers 404 for
// every request, which reads exactly like "the preview is broken".
if (!existsSync(site) || !statSync(site).isDirectory()) {
  console.error('site directory not found: ' + site);
  console.error('pass --site=<dir> if the artifact is not at <repo>/site');
  process.exit(2);
}
if (!existsSync(join(site, 'index.html'))) {
  console.error('no index.html in ' + site + ' -- this does not look like the built artifact');
  process.exit(2);
}

const server = createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request');
    return;
  }

  // Everything outside the deployed base is a 404, exactly as Pages would.
  if (pathname !== PREFIX && !pathname.startsWith(PREFIX + '/')) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 (outside ' + PREFIX + ')\n' + pathname);
    return;
  }

  let rel = pathname.slice(PREFIX.length); // "/assets/..." or ""
  if (rel === '' || rel === '/') rel = '/index.html';

  const abs = join(site, normalize(rel));
  if (!abs.startsWith(site)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403');
    return;
  }

  let target = abs;
  let st = null;
  try { st = statSync(target); } catch { st = null; }
  if (st && st.isDirectory()) {
    st = null;
    const index = join(target, 'index.html');
    try { st = statSync(index); } catch { st = null; }
    if (st) target = index;
  }

  if (!st || !st.isFile()) {
    const wantsDoc = (req.headers.accept ?? '').includes('text/html');
    let fallback = null;
    if (wantsDoc) {
      try { fallback = join(site, 'index.html'); statSync(fallback); } catch { fallback = null; }
    }
    if (fallback) {
      const size = statSync(fallback).size;
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': size,
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(fallback);
      stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
      res.on('error', () => { try { stream.destroy(); } catch { /* gone */ } });
      stream.pipe(res);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404\n' + pathname);
    console.log('  404  ' + pathname);
    return;
  }

  const type = TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  // A client that goes away mid-download (7 MB of ngspice WASM, a reload, a
  // cancelled navigation) aborts the socket. Without handling that the destroy
  // surfaces as an unhandled stream error and takes the whole preview server
  // down -- which looks like "the server randomly died".
  //
  // https://nodejs.org/api/stream.html: pipe() does not forward errors.
  const send = (file, size) => {
    res.writeHead(200, {
      'content-type': type,
      'content-length': size,
      'cache-control': 'no-store',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = createReadStream(file);
    stream.on('error', () => { try { res.destroy(); } catch { /* already gone */ } });
    res.on('error', () => { try { stream.destroy(); } catch { /* already gone */ } });
    req.on('aborted', () => { try { stream.destroy(); } catch { /* already gone */ } });
    stream.pipe(res);
  };
  send(target, st.size);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('port ' + port + ' is already in use -- pass --port=<other>');
    process.exit(1);
  }
  throw e;
});

server.listen(port, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + port + BASE;
  console.log('');
  console.log('  SPICE simulator preview');
  console.log('  serving  ' + site);
  console.log('  mounted  ' + BASE + '   (the base is part of the artifact: do not open site/index.html directly)');
  console.log('');
  console.log('  ' + url);
  console.log('  example circuit:  ' + url + '?example=common-source-amplifier');
  console.log('');
  console.log('  Ctrl+C to stop. First load pulls ~7 MB of ngspice WASM; /api/* 404s are expected');
  console.log('  (the deploy has no backend). If you have opened the site from this origin');
  console.log('  before, unregister the service worker in DevTools or use a fresh profile --');
  console.log('  it serves scripts cache-first.');
  console.log('');
});
