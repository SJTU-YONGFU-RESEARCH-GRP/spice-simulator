#!/usr/bin/env node
/**
 * The shell cache token: derive it from the artifact, and optionally write it.
 *
 * Why this file exists
 * --------------------
 * site/sw.js opens its cache under a constant it calls CACHE. The upstream
 * build injects a digest there -- the source comment says so: "Replaced by the
 * Vite build with a digest of the emitted index.html. This changes when its
 * content-hashed application asset graph changes." That injection is what makes
 * a deploy able to retire a stale shell: activate() deletes every
 * "icm-static-shell-*" cache except the current one, so changing the constant is
 * the only mechanism that removes a copy a returning client already holds.
 *
 * This repository does not run that build. site/ is a committed artifact and
 * every repair is a hand-patch that KEEPS the filename -- which is precisely the
 * case the content hash in that filename is supposed to make impossible. The
 * static route is cache-first with no revalidation:
 *
 *     caches.match(event.request).then((cached) => cached ?? fetch(...))
 *
 * so a hand-patched App-*.js is invisible to every returning client for as long
 * as the constant lives. Nothing in the build, the workflow, or check-artifacts
 * noticed: the constant had become a value a human had to remember to edit.
 *
 * What the token covers
 * ---------------------
 * Two things, and nothing else:
 *
 *   1. the bytes of every file these routes could STORE -- which is not the
 *      same as every file in the tree. A file the worker can never be asked
 *      for cannot make a stored copy stale, and hashing it would make this
 *      check fail on changes that cannot affect any client (a scratch file a
 *      test wrote into the tree, a licence text nobody fetches). The three ways
 *      a file can enter this cache are enumerated in isCovered();
 *   2. the two declarations that decide WHICH URLs it stores: the shellUrls()
 *      precache list, and ENGINE_PAYLOAD_DIRS on the runtime route. A change
 *      here changes the cache's contents or its policy without changing any
 *      file, which is why the 2026-09-20 runtime-cache repair had to bump the
 *      constant even though the only file it edited was sw.js.
 *
 * Everything else about the worker -- route logic, comments, the shape of the
 * put call -- is deliberately out of scope. Comments in particular must be: the
 * constant's own history is written in a comment block in sw.js, and if that
 * block were covered, every bump would require another bump.
 *
 * The digest is over content only, never mtimes, so it is identical for any
 * copy of the same tree. Over-approximation is the safe direction *within* this
 * scope: a needless bump costs one shell re-download, a missed one costs every
 * returning visitor the fix, permanently.
 *
 * Usage
 *   node scripts/shell-cache.mjs [--site=<dir>] [--check] [--write] [--json=<file>]
 *
 *   --site=<dir>   Tree to inspect. Default: <repo>/site
 *   --check        Default. Print the derived token and compare it with sw.js.
 *   --write        Rewrite the constant in <site>/sw.js to the derived token.
 *   --json=<file>  Also write the derivation as JSON.
 *
 * Exit codes
 *   0  the tree and the declared constant agree
 *   1  they disagree (stale token), or the declaration is unusable
 *   2  usage or IO error (including a --write whose anchor is not unique)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** activate() drops every cache whose key starts with this. */
export const SHELL_CACHE_PREFIX = 'icm-static-shell-';
const TOKEN_LEN = 12;
const TOKEN_RE = '[0-9a-f]{' + TOKEN_LEN + '}';

// Capture the token only. The prefix is part of the anchor, not of the value.
const CACHE_DECL = new RegExp('const\\s+CACHE\\s*=\\s*"' + SHELL_CACHE_PREFIX + '(' + TOKEN_RE + ')"');
const CACHE_DECL_ANCHOR = new RegExp('const CACHE = "' + SHELL_CACHE_PREFIX + TOKEN_RE + '";');
// Every one of these is iterated with String.prototype.matchAll(), which throws
// a TypeError unless the regex is global. A `while ((m = re.exec(..)))` loop
// over a non-global regex never advances lastIndex and spins forever instead --
// which is how this file first hung its own test run.
const SHELL_URL = /new URL\(\s*"([^"]*)"\s*,\s*scope\s*\)/g;
const PAYLOAD_DIRS = /const\s+ENGINE_PAYLOAD_DIRS\s*=\s*\[([^\]]*)\]/;
const STRING_LITERAL = /["']([^"']+)["']/g;
const ACTIVATE_FILTER = /\.startsWith\(\s*"([^"]+)"\s*\)/g;

/**
 * Extensions a resource-tag request can carry.
 *
 * The static route stores a same-origin response when request.destination is
 * one of script/style/image/font/manifest, and the destination is decided by
 * the URL's extension. So this set -- and nothing wider -- is what that route
 * can ever put in the cache.
 */
const SERVABLE_EXT = new Set([
  '.js', '.mjs', '.cjs', '.css', '.html', '.htm', '.webmanifest',
  '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

/** Every regular file under dir, as POSIX relative paths. */
function collectFiles(dir, base, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, rel, out);
    else if (entry.isFile()) out.push({ rel, full, bytes: statSync(full).size });
  }
}

/**
 * Can this worker's routes ever store this file?
 *
 * Three ways in, and the list is meant to be exhaustive:
 *
 *   1. install() names it. `./` resolves to index.html; any other member is
 *      named literally, which is how an extensionless target would be covered;
 *   2. a resource tag requests it -- a script, stylesheet, image, font or the
 *      manifest, decided by extension;
 *   3. it lies under an ENGINE_PAYLOAD_DIRS prefix, which the runtime route
 *      matches by path because the engine arrives by fetch() with an empty
 *      destination. This is what brings models/*.json into scope, and they must
 *      be in scope: the engine reads them offline out of this cache.
 *
 * Anything else -- a licence text, a release manifest nobody fetches, a scratch
 * file a test wrote into the tree -- cannot become stale in a client's cache, so
 * hashing it would only make this check fail on changes that reach no one.
 */
function isCovered(rel, named, payloadDirs) {
  if (named.has(rel)) return true;
  if (SERVABLE_EXT.has(extname(rel).toLowerCase())) return true;
  return payloadDirs.some((d) => rel.startsWith(d) && rel.length > d.length);
}

/**
 * Derive the token, and report how it compares with what sw.js declares.
 *
 * Returns { status, findings, notes, token, declared, treeDigest, declDigest,
 *           files, treeFiles, bytes, precache, payloadDirs, activatePrefix }.
 */
export function shellCacheState(site) {
  const swPath = join(site, 'sw.js');
  if (!existsSync(swPath)) {
    return { status: 'absent', findings: [], notes: ['no sw.js in this tree'] };
  }
  const swText = readFileSync(swPath, 'utf8');
  const findings = [];

  // --- 1. the declarations. They are read first because they also decide which
  //        files are in scope, not only what the token's second half is.
  const precache = [...swText.matchAll(SHELL_URL)].map((m) => m[1]);
  if (precache.length === 0) {
    findings.push({
      key: 'shell-cache-inventory-empty', ref: 'sw.js',
      notes: [
        'shellUrls() names nothing, so install() caches no shell and the derived token describes an empty policy',
        'the worker would then only ever hold whatever the runtime route happens to fetch',
      ],
    });
  }
  const decl = PAYLOAD_DIRS.exec(swText);
  const payloadDirs = decl ? [...decl[1].matchAll(STRING_LITERAL)].map((d) => d[1]) : [];
  const declDigest = sha256(JSON.stringify({ precache, payloadDirs }));

  // --- 2. the bytes those declarations let this worker store
  const named = new Set(
    precache.map((p) => p.replace(/^\.\//, '') || 'index.html').filter((p) => !p.endsWith('/')),
  );
  const all = [];
  collectFiles(site, '', all);
  const inTree = all.filter((f) => f.rel !== 'sw.js');
  const covered = inTree
    .filter((f) => isCovered(f.rel, named, payloadDirs))
    .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    .map((f) => ({ rel: f.rel, bytes: f.bytes, sha: sha256(readFileSync(f.full)) }));
  const outside = inTree.filter((f) => !isCovered(f.rel, named, payloadDirs));
  const bytes = covered.reduce((n, f) => n + f.bytes, 0);
  const manifest = covered.map((f) => f.sha + '  ' + f.rel).join('\n') + '\n';
  const treeDigest = sha256(manifest);

  const token = sha256(treeDigest + '\n' + declDigest).slice(0, TOKEN_LEN);

  // --- 3. compare with the constant, and with the prefix activate() filters on
  const declared = (CACHE_DECL.exec(swText) ?? [])[1] ?? null;
  const declaredKey = declared === null ? null : SHELL_CACHE_PREFIX + declared;

  // Which literal does activate() retire keys on? Do not assume source order:
  // this file holds more than one `.startsWith("<literal>")` call (the
  // cache-key filter, and the /api/ exclusion in isSameOriginApi). Take the
  // literals that are a prefix of the key actually being opened, and require
  // exactly one -- an ambiguous tree is reported, never guessed at.
  const filterLiterals = [...swText.matchAll(ACTIVATE_FILTER)].map((f) => f[1]);
  const prefixCandidates = declaredKey === null
    ? []
    : filterLiterals.filter((l) => declaredKey.startsWith(l));
  const activatePrefix = prefixCandidates.length === 1 ? prefixCandidates[0] : null;

  if (declared === null) {
    findings.push({
      key: 'shell-cache-undeclared', ref: 'sw.js',
      notes: [
        'sw.js declares no `const CACHE = "' + SHELL_CACHE_PREFIX + '<12 hex>"`',
        'without it the worker cannot open a cache, and activate() cannot tell a stale shell from the current one',
      ],
    });
  } else if (declared !== token) {
    findings.push({
      key: 'shell-cache-stale:' + declared, ref: 'sw.js',
      notes: [
        'sw.js declares ' + declaredKey + ', but the artifact hashes to ' + SHELL_CACHE_PREFIX + token,
        covered.length + ' of ' + inTree.length + ' file(s) are inside this worker\'s routes (' +
        bytes + ' B), plus ' + precache.length + ' precache item(s) and ' +
        payloadDirs.length + ' engine payload dir(s)',
        'every same-origin script, style, font and image is served cache-first without revalidation,',
        'so a returning client keeps the copy it already has until this constant changes -- a',
        'hand-patch that keeps its filename is otherwise invisible to it for good',
        'fix: node scripts/shell-cache.mjs --write',
      ],
    });
  }

  if (declared !== null && prefixCandidates.length === 0) {
    findings.push({
      key: 'shell-cache-prefix-absent', ref: 'sw.js',
      notes: [
        'no .startsWith("<literal>") call names a prefix of the cache key ' + declaredKey,
        'the deletion of every ' + SHELL_CACHE_PREFIX + '* cache but the current one is the whole',
        'mechanism that retires a stale shell, so without it every bump leaks a full copy of the artifact',
      ],
    });
  } else if (prefixCandidates.length > 1) {
    findings.push({
      key: 'shell-cache-prefix-ambiguous:' + prefixCandidates.length, ref: 'sw.js',
      notes: [
        prefixCandidates.length + ' .startsWith("<literal>") calls are prefixes of ' + declaredKey +
        ': ' + JSON.stringify(prefixCandidates),
        'which one activate() retires keys on cannot be established from this tree',
      ],
    });
  }

  return {
    status: 'checked',
    findings,
    notes: [
      covered.length + ' of ' + inTree.length + ' file(s) / ' + bytes + ' B are inside this ' +
      'worker\'s routes, ' + precache.length + ' precache item(s), ' + payloadDirs.length +
      ' payload dir(s)',
      outside.length === 0
        ? 'nothing in the tree falls outside those routes'
        : outside.length + ' file(s) fall outside them and are not hashed: ' +
          outside.slice(0, 4).map((f) => f.rel).join(', ') + (outside.length > 4 ? ', ...' : ''),
      'tree ' + treeDigest.slice(0, TOKEN_LEN) + ', declarations ' + declDigest.slice(0, TOKEN_LEN),
      'derived ' + SHELL_CACHE_PREFIX + token + ', declared ' +
        (declared === null ? '(none)' : SHELL_CACHE_PREFIX + declared),
    ],
    token,
    declared,
    activatePrefix,
    treeDigest,
    declDigest,
    files: covered.length,
    treeFiles: inTree.length,
    outside: outside.map((f) => f.rel),
    bytes,
    precache,
    payloadDirs,
  };
}

/** Rewrite the constant in <site>/sw.js. Returns the previous token, or throws. */
export function writeShellCacheToken(site, token) {
  const swPath = join(site, 'sw.js');
  const before = readFileSync(swPath, 'utf8');
  const hits = before.split(CACHE_DECL_ANCHOR).length - 1;
  if (hits !== 1) {
    const err = new Error('the CACHE declaration matches ' + hits + ' time(s) in ' + swPath + ', expected 1');
    err.setup = true;
    throw err;
  }
  const next = before.replace(CACHE_DECL_ANCHOR, 'const CACHE = "' + SHELL_CACHE_PREFIX + token + '";');
  writeFileSync(swPath, next);
  return { previous: (CACHE_DECL.exec(before) ?? [])[1] ?? null, path: swPath };
}

// --- CLI --------------------------------------------------------------------
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv.slice(2);
  const siteArg = argv.find((a) => a.startsWith('--site='));
  const site = siteArg ? resolve(REPO_ROOT, siteArg.slice('--site='.length)) : join(REPO_ROOT, 'site');
  const jsonArg = argv.find((a) => a.startsWith('--json='));
  const write = argv.includes('--write');

  if (!existsSync(site)) {
    console.error('shell-cache: no such tree: ' + site);
    process.exit(2);
  }

  let state = shellCacheState(site);
  if (state.status !== 'checked') {
    console.error('shell-cache: ' + state.notes.join('; '));
    process.exit(2);
  }

  // Write first, then report on what the tree now says. Reporting the
  // pre-write snapshot would print STALE and exit 1 immediately after a
  // successful repair, which reads as a failure.
  if (write) {
    if (state.declared === state.token) {
      console.log('shell-cache: already current, nothing written');
    } else {
      let r;
      try {
        r = writeShellCacheToken(site, state.token);
      } catch (e) {
        console.error('shell-cache: SETUP-ERROR -- ' + e.message);
        console.error('  the declaration in sw.js has changed shape; update this script.');
        process.exit(2);
      }
      console.log('shell-cache: wrote ' + SHELL_CACHE_PREFIX + state.token +
        ' into ' + r.path + ' (was ' + (r.previous === null ? '(none)' : SHELL_CACHE_PREFIX + r.previous) + ')');
      state = shellCacheState(site);
      // The write fixes exactly one finding class. Anything else still live --
      // an ambiguous filter, an empty shellUrls() -- is not this command's job.
      for (const note of state.notes) console.log('shell-cache: ' + note);
    }
  } else {
    for (const note of state.notes) console.log('shell-cache: ' + note);
  }

  if (jsonArg) {
    writeFileSync(resolve(REPO_ROOT, jsonArg.slice('--json='.length)), JSON.stringify({
      site,
      token: state.token,
      declared: state.declared,
      activatePrefix: state.activatePrefix,
      treeDigest: state.treeDigest,
      declDigest: state.declDigest,
      files: state.files,
      bytes: state.bytes,
      precache: state.precache,
      payloadDirs: state.payloadDirs,
      findings: state.findings.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
    }, null, 2), 'utf8');
  }

  const live = state.findings.length;
  if (live) {
    console.log('');
    for (const f of state.findings) {
      console.log('  ' + f.key + '  (' + f.ref + ')');
      for (const n of f.notes) console.log('      ' + n);
    }
    console.log('');
    console.log('shell-cache: STALE (' + live + ' finding(s))');
    process.exit(1);
  }
  console.log('shell-cache: PASS (the declared constant describes this tree)');
  process.exit(0);
}
