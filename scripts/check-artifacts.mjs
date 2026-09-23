#!/usr/bin/env node
/**
 * Artifact guard for the Pages publish repository.
 *
 * site/ is a build artifact committed to git. The Pages workflow only asserts
 * that site/index.html and site/assets/ exist, then publishes whatever is
 * committed. Nothing verifies that the URLs the artifact asks for actually
 * resolve against the deployed base.
 *
 * Checks. The numbers are the printed section numbers; section 3 appears only
 * under --strict.
 *   1. escapedRefs  Root-absolute string literals that point outside the
 *                   deployed base while the very same file exists *inside* it.
 *                   Vite rewrites every URL it generates; it cannot rewrite a
 *                   literal that application code writes by hand.
 *   2. inBaseRefs   References that do carry the base prefix must resolve.
 *   3. externalRefs Root-absolute references that resolve to nothing in the
 *                   tree. --strict only: a static Pages deploy legitimately has
 *                   no backend behind /api/.
 *   4. jsxRuntime   A production build must not ship the development JSX
 *                   runtime (jsxDEV / jsx-dev-runtime).
 *   5. shellAssets  The service-worker shell list must exist on disk.
 *   6. jsxFactory   The JSX runtime chunk must actually *run*. Check 4 is a
 *                   name-and-presence test, and on 2026-09-09 this tree shipped
 *                   a chunk that passed it: the file existed, exported
 *                   `Fragment` and `jsxDEV`, and the value of `jsxDEV` was
 *                   `undefined` -- React's production stub for
 *                   `react/jsx-dev-runtime`. The site rendered nothing. Only
 *                   importing and calling the module can see that. A tree with
 *                   no jsx*runtime chunk at all is reported as "--  no chunk"
 *                   and does not fail: a build may legitimately inline it.
 *   7. exampleGate  The `requiresUnlock` library gate must hold on every route
 *                   to a Project, not only on the route that lists examples.
 *                   The resolver is lifted out of the bundle and run against
 *                   the bundle's own table. See checkExampleGate.
 *   8. jsxCallSites No JSX call site may be emitted as `(void 0)(` -- the
 *                   factory folded to undefined with its arguments left in
 *                   place. The file looks intact and the runtime chunk passes
 *                   check 6; only the branch that renders the broken site
 *                   fails. See checkJsxCallSites.
 *   9. outbound     Every http(s) URL literal in the tree must be classified in
 *                   scripts/outbound-manifest.json, no forbidden target may
 *                   appear, every declared repair must be present in the
 *                   artifact, and every integrity pin must still equal the hash
 *                   of the file it is derived from. This is the only check that
 *                   looks outward: it is what makes "site/ is a build artifact
 *                   nobody can rebuild" survivable, because a rebuild that adds,
 *                   drops or re-points a network target fails here instead of
 *                   reaching users. See checkOutboundEgress.
 *  10. storage      Every localStorage/sessionStorage access must sit inside a
 *                   try/catch. Reading the property throws outright when the
 *                   browser denies storage (Safari private mode, blocked site
 *                   data, a partitioned iframe), so an unguarded read is not a
 *                   lost preference -- it is a throw at that line. On
 *                   2026-09-20 six such reads sat in React initializers and the
 *                   error boundary replaced the whole editor with its crash
 *                   screen. See checkStorageAccess.
 *  11. shellCsp    The deploy shell must carry a Content-Security-Policy, and
 *                   the policy must still describe THIS artifact: both shell
 *                   documents hold the manifest's policy, every executable
 *                   inline script's hash is re-derived from the document's own
 *                   bytes, script-src may not gain 'unsafe-eval' or
 *                   'unsafe-inline', and every origin the policy names must
 *                   already be classified in the outbound manifest. This is the
 *                   only check that constrains what the page may load at all --
 *                   without it the shell names no origin and any injected script
 *                   runs with the editor's own authority. See checkShellCsp.
 *  12. swCache     The service worker's runtime cache must be able to store.
 *                   cache.put() has to receive a response cloned before
 *                   respondWith() took the body, and the engine payload --
 *                   which arrives by fetch(), with an empty request.destination
 *                   -- has to be routed by path rather than precached. Without
 *                   this the worker stores nothing and "offline simulation"
 *                   silently means "the browser's HTTP cache happened to have a
 *                   copy". See checkServiceWorkerCache.
 *  13. shellCache  The constant the worker opens its cache under must describe
 *                   THIS tree. Upstream's build derives it from the emitted
 *                   asset graph; in a committed artifact whose repairs keep
 *                   their filenames, nothing derives it, and the static route
 *                   is cache-first without revalidation -- so a stale constant
 *                   hides every hand-patch from every returning client for
 *                   good. Derived, not chosen: see scripts/shell-cache.mjs.
 *  14. cornerSweep The simulation profile must advertise a set of process
 *                   corners, the deck emitter must map each advertised corner to
 *                   a selector, and the model library must answer it. All three
 *                   are checked against the artifact's own bytes, and the
 *                   library's directive lines are compared against the ones the
 *                   repair declares, so the manifest and the tree cannot drift
 *                   apart in either direction. Without this the panel keeps
 *                   rendering a Process corner dropdown that changes nothing.
 *                   See checkCornerSweep.
 *  15. importLibs  A netlist imported through the File menu must be able to
 *                   resolve the model libraries this build ships. The control is
 *                   a flat multi-file picker, so a selection cannot express a
 *                   directory, while the include resolver refuses anything that
 *                   climbs above dirname(entry). What the browser cannot see is
 *                   checked here: that the text embedded in the chunk is still
 *                   the bytes of site/models/*.lib, that the injected pool is
 *                   actually CALLED rather than merely present, and that the
 *                   filename fallback is still fenced to relative paths and to
 *                   names the pool holds. See checkImportLibs.
 *  16. (meta)       Accepted deviations that matched nothing. Printed only when
 *                   there are any, and never silenceable.
 *
 * The rule in (1) is deliberately narrow: a reference is reported only when
 * stripping its leading slash yields a real file inside site/. That makes the
 * finding self-evidencing (the asset is demonstrably deployed one level away
 * from where the code looks for it) and keeps directories such as Emscripten
 * virtual-FS paths ("/models") from being reported.
 *
 * Usage
 *   node scripts/check-artifacts.mjs [options]
 *
 *   --site=<dir>   Directory to inspect. Default: <repo>/site
 *   --base=<path>  Deployed base URL path. Default: derived from package.json
 *                  "homepage" (its pathname, trailing slash ensured).
 *   --strict       Also report root-absolute references that resolve to nothing
 *                  in the tree (typically backend contracts).
 *   --accept=<file>  JSON list of findings that are known, attributable and
 *                  accepted, e.g. scripts/known-deviations.json. Accepted
 *                  entries are still printed, with their reason, but do not
 *                  fail the run. An entry that matches nothing IS a failure,
 *                  so the list cannot outlive the deviation it describes.
 *                  Default: scripts/known-deviations.json when it exists.
 *   --outbound=<file>  Manifest of audited outbound targets for check 9.
 *                  Default: scripts/outbound-manifest.json when it exists.
 *   --csp=<file>   Manifest of the deploy shell's Content-Security-Policy for
 *                  check 11. Default: scripts/shell-csp.json when it exists.
 *   --corner=<file>  Manifest of the process-corner selection for check 14.
 *                  Default: scripts/corner-sweep.json when it exists.
 *   --import=<file>  Manifest of the import-library repair for check 15.
 *                  Default: scripts/import-libs.json when it exists.
 *   --json=<file>  Also write findings as JSON.
 *
 * Exit codes: 0 clean or only accepted deviations, 1 findings, 2 usage or IO
 * error.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
// The derivation lives in one place so that the writer and the guard cannot
// disagree about what the token should be.
import { SHELL_CACHE_PREFIX, shellCacheState } from './shell-cache.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

// A static Pages deploy has no server, so these are expected to 404 until a
// backend is configured. They are reported only under --strict.
const EXTERNAL_PREFIXES = ['/api/'];

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.html', '.htm', '.css', '.webmanifest', '.json', '.svg',
]);

// Skip anything huge enough to be a bundled engine; not worth the scan time.
const MAX_BYTES = 8 * 1024 * 1024;

// A quoted literal that is root-absolute: one leading "/" (not "//"), then at
// least one path segment. The delimiter must match itself.
const LITERAL = /(["'`])(\/[A-Za-z0-9._~%+-]+(?:\/[A-Za-z0-9._~%+-]*)*)\1/g;

// CSS url() is very often unquoted -- url(/logo.png) -- which the
// quoted-literal pattern above cannot see. Group 1/2/3 are the three quoting
// styles (double, single, bare).
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s'"]+))\s*\)/g;

const SW_SHELL = /new URL\(\s*"([^"]*)"\s*,\s*scope\s*\)/g;
/** Bytes as KiB, one decimal. Used wherever a size is reported to a human. */
const kib = (bytes) => (bytes / 1024).toFixed(1);

function parseArgs(argv) {
  const out = {
    site: join(REPO_ROOT, 'site'), base: null, strict: false, json: null, accept: null,
    outbound: null, csp: null, precache: null, corner: null, import: null, gallery: null,
    margin: null,
  };
  for (const arg of argv) {
    // An empty value would silently resolve to the current directory and scan
    // the wrong tree, which looks like a real finding rather than a typo.
    if (arg.endsWith('=')) return { error: arg + ' needs a value' };
    if (arg.startsWith('--site=')) out.site = resolve(REPO_ROOT, arg.slice('--site='.length));
    else if (arg.startsWith('--base=')) out.base = arg.slice('--base='.length);
    else if (arg === '--strict') out.strict = true;
    else if (arg.startsWith('--accept=')) out.accept = resolve(REPO_ROOT, arg.slice('--accept='.length));
    else if (arg.startsWith('--outbound=')) out.outbound = resolve(REPO_ROOT, arg.slice('--outbound='.length));
    else if (arg.startsWith('--csp=')) out.csp = resolve(REPO_ROOT, arg.slice('--csp='.length));
    else if (arg.startsWith('--precache=')) out.precache = resolve(REPO_ROOT, arg.slice('--precache='.length));
    else if (arg.startsWith('--corner=')) out.corner = resolve(REPO_ROOT, arg.slice('--corner='.length));
    else if (arg.startsWith('--import=')) out.import = resolve(REPO_ROOT, arg.slice('--import='.length));
    else if (arg.startsWith('--gallery=')) out.gallery = resolve(REPO_ROOT, arg.slice('--gallery='.length));
    else if (arg.startsWith('--margin=')) out.margin = resolve(REPO_ROOT, arg.slice('--margin='.length));
    else if (arg.startsWith('--json=')) out.json = arg.slice('--json='.length);
    else return { error: 'unknown argument: ' + arg };
  }
  return out;
}

function deriveBase() {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
    if (!pkg.homepage) return null;
    const path = new URL(pkg.homepage).pathname;
    return path.endsWith('/') ? path : path + '/';
  } catch {
    return null;
  }
}

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const slash = (p) => p.split('\\').join('/');

// Sort [key, value] entry pairs by key. Plain Array#sort stringifies the pair,
// which happens to work but is not what is meant.
const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

function readText(path) {
  if (statSync(path).size > MAX_BYTES) return null;
  return readFileSync(path, 'utf8');
}

/**
 * Check 1 + 2 (+ 3, which is reported only under --strict): base-prefix
 * discipline.
 *
 * For every root-absolute literal:
 *   - if it already carries the base, strip the base and require the target to
 *     exist inside the site tree;
 *   - otherwise it points outside the deploy root. Report it only when the
 *     literal body names a real file inside the tree, which proves the asset
 *     ships somewhere the request will never reach.
 */
function checkBaseRefs(site, base, strict) {
  const escaped = new Map();
  const missing = new Map();
  const external = new Map();
  let scanned = 0;
  let bytes = 0;

  for (const path of walk(site)) {
    if (!TEXT_EXT.has(extname(path).toLowerCase())) continue;
    const text = readText(path);
    if (text === null) continue;
    scanned += 1;
    bytes += text.length;
    const rel = slash(path.slice(site.length + 1));

    const consider = (ref, index) => {
      if (EXTERNAL_PREFIXES.some((p) => ref.startsWith(p))) return;

      const note = rel + ' @' + index;
      const unbracket = (map, key) => {
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(note);
      };

      // With base "/", every root-absolute string "carries the base", and the
      // great majority of them are not URLs at all: Emscripten virtual-FS
      // paths (/proc/self, /usr/local/share/ngspice/scripts), PDF name objects
      // (/FlateDecode, /XObject), ngspice deck paths (/circuit.cir, /out.raw).
      // Resolvability is only a meaningful test once the base names a
      // sub-path, where a literal beginning "/spice-simulator/" can only be a
      // deploy reference.
      if (ref.startsWith(base)) {
        if (base === '/') return;
        const inner = ref.slice(base.length);
        if (inner === '') return;
        if (!existsSync(join(site, inner.split('/').join('\\')))) unbracket(missing, ref);
        return;
      }

      // Root-absolute without the base prefix.
      const body = ref.slice(1).split('/').join('\\');
      const target = join(site, body);
      if (existsSync(target) && statSync(target).isFile()) unbracket(escaped, ref);
      else if (strict) unbracket(external, ref);
    };

    LITERAL.lastIndex = 0;
    let m;
    while ((m = LITERAL.exec(text)) !== null) consider(m[2], m.index);

    if (extname(path).toLowerCase() === '.css') {
      CSS_URL.lastIndex = 0;
      let u;
      while ((u = CSS_URL.exec(text)) !== null) {
        const ref = u[1] ?? u[2] ?? u[3] ?? '';
        if (ref.startsWith('/') && !ref.startsWith('//')) consider(ref, u.index);
      }
    }
  }

  return { escaped, missing, external, scanned, bytes };
}

/** Check 4: production builds emit jsx-runtime, never jsx-dev-runtime. */
function checkJsxRuntime(site) {
  const devFiles = [];
  const referencing = new Map();

  for (const path of walk(site)) {
    const rel = slash(path.slice(site.length + 1));
    if (/^jsx-dev-runtime-.*\.js$/.test(rel.split('/').pop())) devFiles.push(rel);
    if (!TEXT_EXT.has(extname(path).toLowerCase())) continue;
    const text = readText(path);
    if (text === null) continue;
    if (!text.includes('jsx-dev-runtime')) continue;
    if (!referencing.has(rel)) referencing.set(rel, []);
    referencing.get(rel).push(text.split('jsx-dev-runtime').length - 1);
  }

  return { devFiles, referencing };
}

/**
 * Check 5: every URL the service worker precaches must exist, and the whole
 * precache must fit in the install budget.
 *
 * The second half matters as much as the first. install() runs
 * cache.addAll(shellUrls()) before the worker can serve anything, and addAll()
 * is atomic: every first-time visitor downloads the entire list before the
 * editor is usable offline, and one member that fails to fetch aborts the whole
 * install. The list is therefore a fixed up-front cost, and its size is a design
 * decision -- so the budget in scripts/precache-budget.json is the record of
 * what that decision was, and this check is what notices when a rebuild quietly
 * undoes it (site/ is a committed build product; the original 558x558 logo and
 * the 512 px manifest icon come back with any rebuild).
 *
 * Sizes are taken from the files on disk rather than from the wire: that is what
 * the cache stores, and it is the conservative number, since the deploy
 * compresses text while the images are already compressed.
 */
function checkShellAssets(site, budgetPath) {
  const swPath = join(site, 'sw.js');
  if (!existsSync(swPath)) {
    return {
      present: false, missing: [], listed: [], sizes: [],
      total: 0, budget: null, overBudget: false,
    };
  }

  const text = readFileSync(swPath, 'utf8');
  const listed = [];
  SW_SHELL.lastIndex = 0;
  let m;
  while ((m = SW_SHELL.exec(text)) !== null) {
    listed.push(m[1]);
  }

  const missing = [];
  const sizes = [];
  let total = 0;
  for (const raw of listed) {
    const target = raw === './' ? 'index.html' : raw;
    const p = join(site, target.split('/').join('\\'));
    if (!existsSync(p)) { missing.push(raw); continue; }
    const bytes = statSync(p).size;
    sizes.push({ raw, bytes });
    total += bytes;
  }

  let budget = null;
  if (budgetPath && existsSync(budgetPath)) {
    try {
      const declared = JSON.parse(readFileSync(budgetPath, 'utf8')).maxBytes;
      if (typeof declared === 'number' && declared > 0) budget = declared;
    } catch {
      budget = null;
    }
  }

  return {
    present: true, missing, listed, sizes, total, budget,
    overBudget: budget !== null && total > budget,
  };
}

/**
 * Check 6: import the JSX runtime chunk and call its factory.
 *
 * Why this cannot be a string test: the broken artifact of 2026-09-09 contained
 * the literal text `e.jsxDEV=void 0` *and* exported `Fragment` -- a scan for
 * "does jsxDEV exist" passes, and the app white-screens. So the only honest
 * assertion is behavioural.
 *
 * Three things must be replicated from the artifact rather than assumed:
 *   1. the chunk is ESM with a .js extension, so Node parses it as CJS and
 *      rejects `import` -- it has to be staged as .mjs, along with its
 *      relative imports, or the import fails for a reason that has nothing to
 *      do with the code under test;
 *   2. it is bundled with rolldown's `__commonJS` helper, which exports a
 *      **lazy factory function**, not the module object. `mod.t` is a function
 *      and `Object.keys(mod.t)` is empty; `mod.t()` yields { Fragment, jsxDEV }.
 *   3. the ref lives in `props`. react-dom's `coerceRef` reads
 *      `element.props.ref` and nothing else, so a factory that mirrors the ref
 *      onto the element but strips it from props silently detaches every ref
 *      in the application.
 */
const JSX_CHUNK = /^jsx.*runtime.*\.js$/;

function stageForImport(chunkPath, depDir, staging) {
  const REL_IMPORT = /(\bfrom\s*|\bimport\s*)("|')(\.\/[^"']+?)\.js\2/g;
  const staged = new Set();
  const missingDeps = [];
  const copy = (src, name) => {
    if (staged.has(name)) return;
    staged.add(name);
    let text = readFileSync(src, 'utf8');
    const deps = [];
    text = text.replace(REL_IMPORT, (m, kw, quote, spec) => {
      const base = spec.replace(/^\.\//, '');
      deps.push(base);
      return kw + quote + './' + base + '.mjs' + quote;
    });
    writeFileSync(join(staging, name), text, 'utf8');
    for (const dep of deps) {
      const found = [join(depDir, dep + '.js'), join(dirname(src), dep + '.js')]
        .find((p) => existsSync(p));
      if (found) copy(found, dep + '.mjs');
      else missingDeps.push(dep);
    }
  };
  copy(chunkPath, 'entry.mjs');
  return { missingDeps, entry: join(staging, 'entry.mjs') };
}

/** Reaches through the rolldown lazy-factory export shape to the factory. */
function findFactory(mod) {
  const call = (v) => { try { return typeof v === 'function' ? v() : undefined; } catch { return undefined; } };
  const named = (obj) => {
    if (!obj || typeof obj !== 'object') return null;
    for (const key of ['jsxDEV', 'jsx', 'jsxs']) if (typeof obj[key] === 'function') return obj[key];
    return null;
  };
  return named(mod)
    ?? named(call(mod.t))
    ?? named(mod.t)
    ?? named(call(mod.default))
    ?? named(mod.default)
    ?? named(call(mod.default && mod.default.t));
}

async function checkJsxFactory(site) {
  const assetsDir = join(site, 'assets');
  const fallback = existsSync(assetsDir) ? assetsDir : site;
  const chunks = [];
  for (const path of walk(site)) {
    const name = path.split(/[\\/]/).pop();
    if (JSX_CHUNK.test(name)) chunks.push(path);
  }

  const results = [];
  for (const chunk of chunks) {
    const rel = slash(chunk.slice(site.length + 1));
    const staging = mkdtempSync(join(tmpdir(), 'artifact-guard-jsx-'));
    let staged;
    try {
      staged = stageForImport(chunk, fallback, staging);
    } catch (e) {
      results.push({ rel, failures: ['staging failed: ' + e.message] });
      continue;
    }
    let mod;
    try {
      mod = await import(pathToFileURL(staged.entry).href);
    } catch (e) {
      results.push({ rel, failures: ['not importable: ' + e.message], missingDeps: staged.missingDeps });
      continue;
    }

    const factory = findFactory(mod);
    if (typeof factory !== 'function') {
      results.push({
        rel,
        failures: ['no callable jsx factory exported -- this is the 2026-09-09 ' +
          'white-screen shape (React ships a jsxDEV = void 0 stub for production)'],
        missingDeps: staged.missingDeps,
      });
      continue;
    }

    const failures = [];
    const REF = {};
    let element;
    try {
      element = factory('div', { ref: REF, children: 'x' }, undefined);
    } catch (e) {
      failures.push('factory threw on ordinary arguments: ' + e.message);
    }
    if (element) {
      if (!element.props || element.props.ref !== REF) {
        failures.push('ref is not preserved on props -- react-dom coerceRef reads ' +
          'element.props.ref only, so every ref in the app detaches');
      }
      if (element.$$typeof !== Symbol.for('react.transitional.element')) {
        failures.push('element $$typeof is not the transitional element symbol');
      }
      if (element.props && element.props.children !== 'x') {
        failures.push('children were lost from props');
      }
      const keyed = factory('div', { key: 'from-config' }, 'from-argument');
      if (!keyed || keyed.key !== 'from-config') {
        failures.push('config.key does not override the argument key');
      }
    }
    results.push({ rel, failures, missingDeps: staged.missingDeps });
  }
  return results;
}

const APP_CHUNK = /^App-.*\.js$/;
const EXAMPLE_ENTRY =
  /\{id:`([^`]+)`,name:`([^`]*)`,description:`[^`]*`,requiresUnlock:(!0|!1),project:/g;
const UNLOCK_KEY_LITERAL = /`(spice\.masterLibraryUnlock[^`]*)`/;
const GATE_READER = /requiresUnlock\s*&&\s*!\s*([A-Za-z_$][\w$]*)\s*\(/;
const GET_ITEM = /getItem\(\s*([A-Za-z_$][\w$]*)\s*\)/;

/**
 * The `{...}` span starting at `at`, skipping comments and string literals.
 *
 * A minified bundle is one enormous line, so a locator that counts braces by
 * character alone reads the `{` inside a template literal as structure. These
 * two spans are short, but they are the only thing standing between the check
 * and a silent misread.
 */
function balancedSpan(text, at) {
  let depth = 0;
  let mode = 'code';
  for (let i = at; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (mode === 'code') {
      if (c === '/' && next === '/') { mode = 'line'; i += 1; continue; }
      if (c === '/' && next === '*') { mode = 'block'; i += 1; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = c; continue; }
      if (c === '{') depth += 1;
      else if (c === '}') {
        depth -= 1;
        if (depth === 0) return { text: text.slice(at, i + 1), end: i };
      }
      continue;
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (c === '*' && next === '/') { mode = 'code'; i += 1; } continue; }
    if (c === '\\') { i += 1; continue; }
    if (c === mode) mode = 'code';
  }
  return { error: 'unbalanced braces while reading the enclosing span' };
}

/**
 * Verbatim source of the single `function <name>(` in this bundle, header
 * included: the caller has to be able to evaluate it, not just read its body.
 */
function functionSpan(text, name) {
  const header = 'function ' + name + '(';
  const at = text.indexOf(header);
  if (at === -1) return { error: 'function ' + name + '() is not in this bundle' };
  if (text.indexOf(header, at + header.length) !== -1) {
    return { error: 'function ' + name + '() appears more than once' };
  }
  // `async` sits before the header, so searching for the header alone drops it
  // and an awaited body then reads as a syntax error. Nothing this check
  // currently lifts is async; taking the keyword anyway keeps a future async
  // resolver from failing with a message about reserved words.
  const start = text.slice(Math.max(0, at - 6), at) === 'async ' ? at - 6 : at;
  const brace = text.indexOf('{', at + header.length);
  if (brace === -1) return { error: 'function ' + name + '() has no body' };
  const span = balancedSpan(text, brace);
  if (span.error) return span;
  return { text: text.slice(start, span.end + 1), at: start, end: span.end };
}

/**
 * Check 7: the example-library unlock gate has to actually gate.
 *
 * The fork added `requiresUnlock` to its bundled example list and hid the
 * locked entries from the panel that lists them. The panel is not the only way
 * in: `?example=<id>` is handled by a boot effect that resolves an id straight
 * to a Project. A gate enforced where examples are *listed* cannot cover a path
 * that never lists them, and on 2026-09-19 a locked lab opened from a URL with
 * no passphrase. The same trap applies to any caller added later.
 *
 * A string test cannot tell a working gate from a plausible-looking one, so
 * this check runs the gate instead of reading it:
 *   - the example table supplies the real ids and the real lock flags;
 *   - the id -> Project accessor and the persisted-state reader are lifted
 *     verbatim out of the bundle with `balancedSpan`, then evaluated in a
 *     sandbox whose only inputs are that table and a stubbed localStorage.
 * Then nothing stored must refuse a locked example, the stored unlock key must
 * admit it, an unlocked example must resolve either way, and every returned
 * Project must be a copy rather than the table's own object.
 *
 * Every identifier is discovered from this bundle, so a rename reports itself
 * instead of quietly skipping the check. Names are minified and will change on
 * the next build; the finding is then the correct answer, not a false alarm.
 */
function checkExampleGate(site) {
  const chunks = [];
  for (const path of walk(site)) {
    if (APP_CHUNK.test(path.split(/[\\/]/).pop())) chunks.push(path);
  }
  if (chunks.length === 0) return { status: 'absent', chunks: 0, findings: [] };

  const findings = [];
  for (const chunk of chunks) {
    const rel = slash(chunk.slice(site.length + 1));
    const notes = [];
    const fail = (why) => findings.push({ key: 'example-gate:' + rel, ref: rel, notes: [why, ...notes] });

    let text;
    try {
      text = readFileSync(chunk, 'utf8');
    } catch (e) {
      fail('unreadable: ' + e.message);
      continue;
    }

    const table = /var ([A-Za-z_$][\w$]*)=\[\{id:`/.exec(text);
    if (!table) {
      fail('no bundled example table (var <name> = [{ id: `...` }) in this chunk');
      continue;
    }
    const tableVar = table[1];

    EXAMPLE_ENTRY.lastIndex = 0;
    const entries = [];
    let em;
    while ((em = EXAMPLE_ENTRY.exec(text)) !== null) {
      entries.push({ id: em[1], name: em[2], locked: em[3] === '!0' });
    }
    const locked = entries.filter((e) => e.locked).map((e) => e.id);
    const open = entries.filter((e) => !e.locked).map((e) => e.id);
    notes.push('table ' + tableVar + ': ' + entries.length + ' example(s), ' +
      locked.length + ' locked, ' + open.length + ' open');

    // The resolver is whichever named function reads the example table. The
    // boot effect also calls table.find(), but it is an arrow function passed to
    // useEffect -- not a declaration -- so scanning declarations separates the
    // one function that maps id -> Project from the call site that uses it.
    const resolvers = [];
    const FN = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    let fm;
    while ((fm = FN.exec(text)) !== null) {
      const brace = text.indexOf('{', fm.index + fm[0].length);
      if (brace === -1) continue;
      const span = balancedSpan(text, brace);
      if (span.error) continue;
      const hit = text.indexOf(tableVar + '.find(', fm.index);
      if (hit !== -1 && hit <= span.end) resolvers.push({ name: fm[1], at: fm.index });
    }
    if (resolvers.length === 0) {
      fail('no function resolves an id against ' + tableVar + ' into a Project');
      continue;
    }
    if (resolvers.length > 1) {
      fail('more than one function reads ' + tableVar + ': ' +
        resolvers.map((r) => r.name).join(', '));
      continue;
    }
    const accessorName = resolvers[0].name;

    const accessor = functionSpan(text, accessorName);
    if (accessor.error) {
      fail(accessorName + '() could not be read: ' + accessor.error);
      continue;
    }

    const gate = GATE_READER.exec(accessor.text);
    if (!gate) {
      fail(accessorName + '() does not consult requiresUnlock: the gate is not ' +
        'enforced where an id becomes a Project, so any caller that does not ' +
        'filter the list first -- ?example=<id> among them -- opens a locked lab');
      continue;
    }
    const readerName = gate[1];
    const reader = functionSpan(text, readerName);
    if (reader.error) {
      fail(accessorName + '() gates on ' + readerName + '(), but ' + reader.error);
      continue;
    }
    const keyVar = GET_ITEM.exec(reader.text)?.[1];
    const keyLiteral = UNLOCK_KEY_LITERAL.exec(text)?.[1];
    if (!keyVar || !keyLiteral) {
      fail('cannot tell which storage key ' + readerName + '() reads');
      continue;
    }
    notes.push('gate: ' + accessorName + '() -> ' + readerName + '() -> ' +
      keyVar + ' = "' + keyLiteral + '"');

    const model = entries.map((e) => ({
      id: e.id, name: e.name, requiresUnlock: e.locked, project: { marker: e.id },
    }));
    const shipped = new Map(model.map((e) => [e.id, e.project]));

    let sandbox;
    try {
      sandbox = new Function(
        tableVar, 'structuredClone', keyVar, 'lg', 'globalThis',
        accessor.text + '\n' + reader.text + '\nreturn ' + accessorName + ';');
      // One call proves the sandbox builds at all; a missing identifier in the
      // extracted source surfaces here rather than as five identical probes.
      sandbox(model, structuredClone, keyLiteral, false,
        { localStorage: { getItem: () => null } });
    } catch (e) {
      fail('the extracted gate is not evaluable: ' + e.message);
      continue;
    }

    const probe = (stored, id) => {
      try {
        const resolve = sandbox(model, structuredClone, keyLiteral, false,
          { localStorage: { getItem: () => stored } });
        const value = resolve(id);
        if (value === null || value === undefined) return { kind: 'null' };
        if (value.marker === id) return { kind: 'project', value };
        return { kind: 'neither a Project nor null' };
      } catch (e) {
        return { kind: 'threw ' + e.message };
      }
    };

    if (locked.length === 0) {
      fail('no example carries requiresUnlock: true -- the gate has nothing to enforce');
      continue;
    }
    if (open.length === 0) {
      fail('every example is locked -- a gate that denies everything proves nothing');
      continue;
    }

    const cases = [
      { stored: null, ids: locked, want: 'null',
        why: 'a locked example must not open with nothing stored' },
      { stored: '0', ids: locked, want: 'null',
        why: 'the stored denial must deny' },
      { stored: '1', ids: locked, want: 'project',
        why: 'the stored unlock must admit the example' },
      { stored: null, ids: open, want: 'project',
        why: 'requiresUnlock: false must stay open to everyone' },
      { stored: '1', ids: ['no-such-example'], want: 'null',
        why: 'an unknown id must resolve to nothing' },
    ];

    for (const c of cases) {
      for (const id of c.ids) {
        const got = probe(c.stored, id);
        if (got.kind !== c.want) {
          fail(c.why + ' -- ' + JSON.stringify(id) + ' resolved to ' + got.kind +
            ' with ' + (c.stored === null ? 'nothing stored' : '"' + c.stored + '" stored'));
          break;
        }
        if (c.want === 'project' && got.value === shipped.get(id)) {
          fail('the resolver handed out the table\'s own Project object for ' +
            JSON.stringify(id) + ' instead of a copy');
          break;
        }
      }
    }
  }
  return { status: 'checked', chunks: chunks.length, findings };
}

/**
 * Check 8: no JSX call site may be compiled to `(void 0)(`.
 *
 * On 2026-09-19 the shipped artifact contained 31 call sites emitted as
 *
 *     (void 0)(T, "div", { ... }, key, isStatic, {fileName, lineNumber}, this)
 *
 * -- the factory expression folded to `undefined` while its seven arguments
 * were left in place. Nothing about the file looks broken: the import is
 * intact, the runtime chunk exports a working factory (check 6 passes), and
 * the site's landing page renders, because 1900-odd sibling call sites in the
 * very same file are fine. The 31 broken ones sit in branches that render
 * later -- 28 of them in the simulation surface, so pressing Run threw
 * `TypeError: (void 0) is not a function` and took the application down.
 *
 * This check looks for the emitted shape directly. A `(void 0)(` whose
 * arguments carry the dev-transform source object is reported as a JSX site;
 * any other `(void 0)(` is reported too, because there is no callable value
 * that this expression could legitimately be -- but it is counted separately
 * so the two can never be confused.
 *
 * Repair: scripts/patch-jsx-callsites.mjs.
 */
const VOID_CALL = '(void 0)(';
const JSX_SOURCE_OBJECT = /\{fileName:\s*[A-Za-z_$][\w$]*\s*,\s*lineNumber:\s*\d+/;

function jsFilesUnder(root) {
  const out = [];
  (function walk(dir) {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (extname(e.name) === '.js') out.push(p);
    }
  })(root);
  return out.sort();
}

function checkJsxCallSites(site) {
  const findings = [];
  let scanned = 0;
  // Scope: assets/ only. JSX call sites are emitted by the bundler, so they can
  // only appear in application chunks. Scanning the whole tree would also read
  // hand-maintained files such as sw.js, whose *comments* legitimately quote the
  // string -- and there is no safe way to strip comments from a single-line
  // minified chunk without also cutting code.
  const assets = join(site, 'assets');
  if (!existsSync(assets)) return { scanned: 0, findings, noAssets: true };
  for (const path of jsFilesUnder(assets)) {
    const text = readText(path);
    if (text === null) continue;
    scanned++;
    const rel = slash(path.slice(site.length + 1));
    let jsx = 0;
    let other = 0;
    let at = 0;
    for (;;) {
      const i = text.indexOf(VOID_CALL, at);
      if (i === -1) break;
      if (JSX_SOURCE_OBJECT.test(text.slice(i, i + 400))) jsx++;
      else other++;
      at = i + VOID_CALL.length;
    }
    if (jsx === 0 && other === 0) continue;
    const notes = [];
    if (jsx > 0) {
      notes.push(jsx + ' JSX call site(s) emitted as (void 0)( -- the first render of that' +
        ' branch throws TypeError: (void 0) is not a function');
      notes.push('repair: node scripts/patch-jsx-callsites.mjs');
    }
    if (other > 0) {
      notes.push(other + ' further (void 0)( call(s) without the dev-transform signature --' +
        ' also uncallable, but not provably JSX');
    }
    findings.push({ key: 'jsx-void0:' + rel, ref: rel, notes });
  }
  return { scanned, findings };
}

/**
 * Check 9: the artifact's outbound surface is audited, classified, and still
 * repaired.
 *
 * Why this check exists. site/ is a build artifact committed to git and its
 * editor sources are not in any public repository, so there is no build step a
 * reviewer can read. The tree nonetheless decides which third-party hosts the
 * browser talks to and, on the ngspice fallback, executes whatever that host
 * returns inside the application's origin. Two hand analyses of this tree
 * disagreed with it in both directions -- a URL that looked like an unpinned
 * load point turned out to be a console.error() hint string, and a target that
 * looked unverified turned out to carry its own SRI -- which is the argument for
 * a mechanical inventory rather than a reading.
 *
 * Four assertions:
 *   a. Nothing listed under "forbidden" may appear. For B7 this is the
 *      regression detector: the product's only feedback control pointed at a
 *      private repository, so anonymous visitors got a 404.
 *   b. Every http(s) URL literal in the tree must be classified in the manifest.
 *      A rebuild that adds a host, re-points a CDN, or inlines a new URL fails
 *      here before it can be published, instead of being reviewed by nobody.
 *   c. Every declared repair must actually be present in the artifact. This is
 *      what makes the repairs durable: the guard re-reads the shipped bytes, so
 *      a rebuild that reverts one is a finding rather than a silent regression.
 *   d. Every integrity pin that carries `mustEqual` is re-derived from that file
 *      and compared with the pinned value. The pin is not a frozen constant --
 *      it must equal the hash of the engine this repository actually ships, so
 *      replacing that engine fails the build until the pin is re-derived.
 *
 * `reachable: false` entries are not dead weight: they are the record that a URL
 * was read in context and ruled out, which is the part that stops the next
 * reader from re-deriving the same wrong conclusion.
 */
const EGRESS_URL =
  /https?:\/\/(?:localhost|[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+)(?::\d+)?[A-Za-z0-9._~:/?#@!&+=%-]*/g;

/** Occurrences of `needle` in `text`. String#split keeps this honest. */
function countOf(text, needle) {
  if (needle === '') return 0;
  return text.split(needle).length - 1;
}

function collectOutbound(site) {
  const found = new Map();
  let scanned = 0;
  for (const path of walk(site)) {
    if (!TEXT_EXT.has(extname(path).toLowerCase())) continue;
    const text = readText(path);
    if (text === null) continue;
    scanned += 1;
    const rel = slash(path.slice(site.length + 1));
    // Bundles also carry JSON-escaped URLs ("https:\/\/host\/x").
    const body = text.split('\\/').join('/');
    EGRESS_URL.lastIndex = 0;
    let m;
    while ((m = EGRESS_URL.exec(body)) !== null) {
      if (!found.has(m[0])) found.set(m[0], new Set());
      found.get(m[0]).add(rel + '@' + m.index);
    }
  }
  return { found, scanned };
}

function checkOutboundEgress(site, manifestPath) {
  const out = { status: 'checked', scanned: 0, declared: 0, present: 0, findings: [], notes: [] };
  if (manifestPath === null || !existsSync(manifestPath)) {
    out.status = 'unavailable';
    out.notes.push('no outbound manifest (pass --outbound=<file> to enable this check)');
    return out;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    out.status = 'unreadable';
    out.notes.push('cannot parse ' + manifestPath + ': ' + e.message);
    return out;
  }

  const targets = manifest.targets ?? [];
  const byUrl = new Map(targets.map((t) => [t.url, t]));
  const banned = new Map((manifest.forbidden ?? []).map((f) => [f.url, f]));
  const repairs = manifest.repairs ?? [];
  out.declared = targets.length;

  const { found, scanned } = collectOutbound(site);
  out.scanned = scanned;

  for (const [url, entry] of banned) {
    const at = found.get(url);
    if (!at) continue;
    out.findings.push({
      key: 'egress-forbidden:' + url, ref: url,
      notes: [
        entry.why ?? 'listed under "forbidden" in the outbound manifest',
        ...(entry.tracked ? ['tracked: ' + entry.tracked] : []),
        'seen at ' + [...at].sort().join(', '),
      ],
    });
  }

  for (const [url, at] of found) {
    if (byUrl.has(url) || banned.has(url)) continue;
    const sites = [...at].sort();
    out.findings.push({
      key: 'egress-undeclared:' + url, ref: url,
      notes: [
        'no entry in the outbound manifest -- classify it as namespace, doc-only, ' +
        'user-link, remote-script, self-reference or forbidden before publishing',
        'seen at ' + sites.slice(0, 6).join(', ') +
          (sites.length > 6 ? ' (+' + (sites.length - 6) + ' more)' : ''),
      ],
    });
  }

  for (const repair of repairs) {
    const path = join(site, repair.file.split('/').join('\\'));
    const label = repair.id + ' [' + repair.file + ']';
    if (!existsSync(path)) {
      out.findings.push({
        key: 'egress-repair-absent:' + repair.id, ref: label,
        notes: ['the file this repair applies to is not in this tree'],
      });
      continue;
    }
    const text = readFileSync(path, 'utf8');
    const pin = repair.pinFrom ? byUrl.get(repair.pinFrom)?.integrity?.hex ?? null : null;
    const edits = repair.edits ?? [{ find: repair.find, replace: repair.replace }];
    for (const [i, edit] of edits.entries()) {
      const want = (edit.replace ?? '').split('{PIN}').join(pin ?? '');
      if (want !== '' && countOf(text, want) === 1) continue;
      out.findings.push({
        key: 'egress-repair-lost:' + repair.id + '#' + i,
        ref: label + ' edit #' + i,
        notes: [
          'the repaired form is not in this artifact: ' + (repair.why ?? 'declared in the outbound manifest'),
          'repair: node scripts/patch-outbound.mjs',
        ],
      });
    }
  }

  for (const t of targets) {
    const integ = t.integrity;
    if (!integ || !integ.mustEqual) continue;
    const source = resolve(REPO_ROOT, integ.mustEqual);
    if (!existsSync(source)) {
      out.findings.push({
        key: 'egress-pin-source:' + t.url, ref: integ.mustEqual,
        notes: ['the file this integrity pin is derived from is not in the repository'],
      });
      continue;
    }
    const actual = createHash('sha256').update(readFileSync(source)).digest('hex');
    if (actual === integ.hex) {
      out.notes.push('pin re-derived: sha256:' + actual.slice(0, 16) + '... == ' +
        integ.mustEqual + ' (and the declared repairs embed the same value)');
      continue;
    }
    out.findings.push({
      key: 'egress-pin-drift:' + t.url, ref: integ.mustEqual,
      notes: [
        'the artifact and its pin have diverged: ' + integ.mustEqual + ' hashes to ' + actual,
        'but the manifest pins ' + integ.hex,
        'update the manifest pin, then re-run node scripts/patch-outbound.mjs',
      ],
    });
  }

  const absent = targets.filter((t) => !found.has(t.url));
  out.present = targets.length - absent.length;
  if (absent.length > 0) {
    out.notes.push(absent.length + ' declared target(s) absent from this tree: ' +
      absent.map((t) => t.url).join(', '));
  }
  return out;
}

/**
 * A reference to the Web Storage APIs. Both spellings matter: `window.localStorage`
 * and the bare `localStorage`, because a bare read as an argument -- `Jy(localStorage)`
 * -- throws at the argument before the callee is ever entered.
 */
const STORAGE_REF =
  /\b(?:window|globalThis|document|self)\s*\.\s*(localStorage|sessionStorage)\b|(?<![\w.$/*'"`\\])(localStorage|sessionStorage)\b/g;

/**
 * Check 10: every storage access sits inside a try/catch.
 *
 * `window.localStorage` is not a plain object property. In Safari private mode,
 * with site data blocked, or inside a partitioned iframe, *reading the property
 * itself* throws a SecurityError -- there is no value to test for. So the only
 * safe shape is a read inside a try whose catch covers it, which is what the
 * editor already does in thirty of its thirty-six storage reads.
 *
 * On 2026-09-20 the six that did not were the ones that mattered: three
 * localStorage reads and three sessionStorage reads, all evaluated inside React
 * `useState`/`useEffect` during the first render. With storage denied they threw
 * during render, the error boundary caught it, and the entire editor was
 * replaced by "The editor hit an unexpected problem" (42 elements, no SVG, no
 * UI). The home page and every `?example=` deep link were both dead.
 *
 * This check is deliberately about shape, not about the six known sites: any
 * future unguarded read anywhere in the tree fails, and scripts/storage-resilience.mjs
 * proves the same property by loading the page in a real browser with the
 * getters replaced by throwing ones. Neither check can pass by reading a string.
 *
 * `indexedDB` is not covered here on purpose: the one user of it in this tree
 * already does `let r = e.idbFactory ?? globalThis.indexedDB; if (!r) throw ...`,
 * so a denied IndexedDB is a handled error rather than a raw throw.
 */
function checkStorageAccess(site) {
  const out = { scanned: 0, refs: 0, findings: [] };
  for (const path of walk(site)) {
    if (!TEXT_EXT.has(extname(path).toLowerCase())) continue;
    const text = readText(path);
    if (text === null) continue;
    out.scanned += 1;
    const rel = slash(path.slice(site.length + 1));

    // Ranges of every `try {...}` whose block is immediately followed by
    // `catch`. Only those can absorb a throw; a bare `try { } finally {}` cannot.
    const guarded = [];
    const tryRe = /\btry\s*\{/g;
    let t;
    while ((t = tryRe.exec(text)) !== null) {
      const brace = text.indexOf('{', t.index);
      const span = balancedSpan(text, brace);
      if (span.error) {
        // Cannot certify the region, so say so rather than report its
        // references as unguarded -- a false accusation is worse than a
        // "could not check".
        out.findings.push({
          key: 'storage-unanalyzable:' + rel + '@' + t.index,
          ref: rel + '@' + t.index,
          notes: ['a try block did not brace-balance, so the areas it covers could not be certified'],
        });
        continue;
      }
      if (/^\s*catch\b/.test(text.slice(span.end + 1))) guarded.push([brace, span.end]);
    }

    STORAGE_REF.lastIndex = 0;
    let m;
    while ((m = STORAGE_REF.exec(text)) !== null) {
      out.refs += 1;
      const at = m.index;
      if (guarded.some(([a, b]) => at >= a && at <= b)) continue;
      out.findings.push({
        key: 'storage-unguarded:' + rel + '@' + at,
        ref: rel + '@' + at,
        notes: [
          'reads ' + m[0] + ' outside any try/catch',
          'when the browser denies storage the read throws, so this line throws',
          'wrap it in try/catch and fall back to the same default, or route it ' +
            "through the file's existing safe accessor (an optional chain does " +
            'NOT help: the property getter throws before "?" applies)',
          'context: ' + text.slice(Math.max(0, at - 70), at + 70).split('\n').join(' '),
        ],
      });
    }
  }
  return out;
}

/**
 * A Content-Security-Policy delivered as a meta tag. The quoted value is read
 * with a backreference rather than with `[^"']*`: a policy is full of single
 * quotes ('self', 'sha256-...'), and an exclusion set of both quote characters
 * stops at the first one, making a shell that HAS a policy read as one that has
 * none.
 */
const CSP_META_TAG =
  /<meta\s+http-equiv=(["'])Content-Security-Policy\1\s+content=(["'])([\s\S]*?)\2\s*\/?>/i;
/** Every inline <script>, with its attribute string, so its type can be read. */
const INLINE_SCRIPT_TAG = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
const SCRIPT_TYPE_ATTR = /\btype\s*=\s*(["'])([^"']*)\1/i;
// A data block (application/ld+json and friends) is never executed, so
// script-src does not cover it and its hash must not be demanded.
const JS_SCRIPT_TYPE = /^(?:|module|text\/javascript|application\/javascript)$/i;
const POLICY_ORIGIN = /https?:\/\/[A-Za-z0-9.-]+(?::\d+)?/g;

function parsePolicy(policy) {
  const map = new Map();
  for (const part of policy.split(';')) {
    const bits = part.trim().split(/\s+/).filter(Boolean);
    if (bits.length === 0) continue;
    map.set(bits[0].toLowerCase(), bits.slice(1));
  }
  return map;
}

/**
 * Check 11: the deploy shell carries a Content-Security-Policy, and the policy
 * still describes this artifact.
 *
 * index.html and 404.html are committed build products, and they decide every
 * origin the page may load from. Until 2026-09-20 they named none, which makes
 * the editor's origin -- a WASM engine, the user's locally stored projects, a
 * service worker -- equally available to any script that manages to get
 * injected from anywhere. A policy is the only control in this artifact that
 * constrains that, and it is exactly the kind of control a rebuild silently
 * deletes, so it is guarded here.
 *
 * Three things are asserted, and the third is what stops the check from being a
 * string comparison:
 *
 *   1. Both shell documents carry the policy, and it is the manifest's policy.
 *      A hand-edit to either document is a finding, not a silent divergence.
 *   2. The policy still contains what makes it worth having: 'none' where
 *      nothing is needed, 'self' where the app's own chunks are, and NOT
 *      'unsafe-eval' or 'unsafe-inline' in script-src -- the two concessions
 *      that would turn it into decoration. Those are read from the manifest,
 *      so the shape of the policy is declared in one place.
 *   3. Every inline script on the page is hash-approved by the policy, and that
 *      hash is RE-DERIVED FROM THE DOCUMENT'S BYTES on every run. Editing the
 *      inline theme bootstrap without updating the policy would leave the page
 *      blocked at the first script and render nothing; the check fails first and
 *      prints the corrected policy. This is the same "re-derive, never trust a
 *      copy" rule that check 9 applies to the engine pin.
 *
 * A fourth rule is what keeps the allowlist honest: every origin the policy
 * names must already be classified in the outbound manifest. Adding an origin to
 * the policy is therefore not a way to make a finding go away -- it fails until
 * someone classifies that origin outbound.
 */
function checkShellCsp(site, cspManifestPath, outboundManifestPath) {
  const out = { status: 'checked', documents: [], findings: [], notes: [] };
  if (cspManifestPath === null || !existsSync(cspManifestPath)) {
    out.status = 'unavailable';
    out.notes.push('no shell-csp manifest (pass --csp=<file> to enable this check)');
    return out;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(cspManifestPath, 'utf8'));
  } catch (e) {
    out.status = 'unreadable';
    out.notes.push('cannot parse ' + cspManifestPath + ': ' + e.message);
    return out;
  }

  const documents = manifest.shellDocuments ?? [];
  if (documents.length === 0) {
    // An empty document list would make every rule below vacuous while still
    // printing "ok", which is the failure mode this guard exists to prevent.
    out.findings.push({
      key: 'csp-vacuous', ref: slash(cspManifestPath.slice(REPO_ROOT.length + 1)),
      notes: ['shellDocuments is empty, so no document is required to carry a policy'],
    });
    return out;
  }

  const classified = [];
  if (outboundManifestPath && existsSync(outboundManifestPath)) {
    try {
      for (const t of JSON.parse(readFileSync(outboundManifestPath, 'utf8')).targets ?? []) {
        classified.push(t.url);
      }
    } catch { /* check 9 reports an unreadable outbound manifest */ }
  }

  const policiesSeen = [];
  for (const file of documents) {
    const path = join(site, file.split('/').join('\\'));
    if (!existsSync(path)) {
      // A declared shell document that is not here cannot be carrying a policy.
      // Reported, never skipped: a tree that lost its 404 page should say so
      // rather than leave the policy unverified on that half of the shell.
      out.findings.push({
        key: 'csp-document-absent:' + file, ref: file,
        notes: [
          'the manifest declares this shell document, and it is not in this tree',
          'so nothing here verifies that it carries a policy',
        ],
      });
      continue;
    }
    const html = readFileSync(path, 'utf8');
    const m = CSP_META_TAG.exec(html);
    if (!m) {
      out.findings.push({
        key: 'csp-missing:' + file, ref: file,
        notes: [
          'this document carries no Content-Security-Policy, so the page trusts every origin',
          'repair: node scripts/patch-outbound.mjs --manifest=scripts/shell-csp.json',
        ],
      });
      continue;
    }
    const policy = m[3];
    policiesSeen.push({ file, policy });
    out.documents.push({ file, length: policy.length });

    if (policy !== manifest.policy) {
      out.findings.push({
        key: 'csp-drift:' + file, ref: file,
        notes: [
          'the policy in the artifact is not the policy in the manifest, so one was edited by hand',
          'in the artifact: ' + policy,
          'in the manifest: ' + (manifest.policy ?? '(absent)'),
        ],
      });
    }

    // Every executable inline script needs its own hash, or the browser refuses
    // it and the page loads with that script missing.
    INLINE_SCRIPT_TAG.lastIndex = 0;
    let s;
    while ((s = INLINE_SCRIPT_TAG.exec(html)) !== null) {
      const [, attrs, body] = s;
      const typeAttr = SCRIPT_TYPE_ATTR.exec(attrs);
      if (typeAttr && !JS_SCRIPT_TYPE.test(typeAttr[2].trim())) continue;
      const hash = createHash('sha256').update(body, 'utf8').digest('base64');
      const source = "'sha256-" + hash + "'";
      if (policy.includes(source)) {
        out.notes.push('inline script hash re-derived from ' + file + ': ' + source +
          ' (' + Buffer.byteLength(body, 'utf8') + ' bytes)');
        continue;
      }
      out.findings.push({
        key: 'csp-inline-unhashed:' + file + '@' + s.index, ref: file + '@' + s.index,
        notes: [
          'an executable inline script is not approved by the policy, so the browser refuses it',
          'its hash is ' + source + ' (' + Buffer.byteLength(body, 'utf8') + ' bytes)',
          'policy with the correction:\n' + policy.replace(/('sha256-[^']*'|$)/, source),
        ],
      });
    }
  }

  if (policiesSeen.length > 1) {
    const first = policiesSeen[0];
    for (const other of policiesSeen.slice(1)) {
      if (other.policy === first.policy) continue;
      out.findings.push({
        key: 'csp-inconsistent:' + other.file, ref: other.file,
        notes: [
          'this shell document does not carry the same policy as ' + first.file,
          'two shells for one site means the laxer one is the real policy',
        ],
      });
    }
  }

  const policy = policiesSeen[0]?.policy;
  if (policy === undefined) return out;
  const directives = parsePolicy(policy);

  for (const name of manifest.requiredDirectives ?? []) {
    if (directives.has(name)) continue;
    out.findings.push({
      key: 'csp-directive-missing:' + name, ref: name,
      notes: ['the policy has no ' + name + ' directive, so it falls back to default-src'],
    });
  }

  for (const [name, required] of Object.entries(manifest.requiredSources ?? {})) {
    const have = directives.get(name);
    if (have === undefined) continue; // already reported by requiredDirectives
    for (const source of required) {
      if (have.includes(source)) continue;
      const replacement = "'sha256-…'";
      out.findings.push({
        key: 'csp-source-missing:' + name + ':' + source, ref: name + ' ' + source,
        notes: [
          name + ' does not allow ' + source +
            (source === replacement ? ', so the inline script is refused' : ''),
        ],
      });
    }
  }

  for (const [name, forbidden] of Object.entries(manifest.forbiddenSources ?? {})) {
    const have = directives.get(name);
    if (have === undefined) continue;
    for (const source of forbidden) {
      if (!have.includes(source)) continue;
      out.findings.push({
        key: 'csp-source-forbidden:' + name + ':' + source, ref: name + ' ' + source,
        notes: [
          name + ' allows ' + source + ', which is the concession the policy exists to avoid',
          'this usually means it was added to silence a violation rather than to fix one -- ' +
            'see scripts/csp-conformance.mjs, which reports what is blocked and why',
        ],
      });
    }
  }

  POLICY_ORIGIN.lastIndex = 0;
  let o;
  const seen = new Set();
  while ((o = POLICY_ORIGIN.exec(policy)) !== null) {
    const origin = o[0];
    if (seen.has(origin)) continue;
    seen.add(origin);
    if (classified.some((u) => u.startsWith(origin))) {
      out.notes.push('origin ' + origin + ' is classified in the outbound manifest');
      continue;
    }
    out.findings.push({
      key: 'csp-unclassified-origin:' + origin, ref: origin,
      notes: [
        'the policy names this origin but the outbound manifest classifies nothing at it, ' +
          'so the allowlist is wider than the audit',
        'classify it in scripts/outbound-manifest.json first, with evidence',
      ],
    });
  }
  return out;
}

/**
 * Check 12: the service worker's cache contract.
 *
 * This worker shipped for a long time with two defects that no static reading
 * would notice, because both of them looked right:
 *
 *   1. Every `cache.put()` on the runtime route passed `response.clone()`
 *      evaluated **inside** the `caches.open(...).then(...)` callback. By then
 *      `respondWith()` had handed the original body to the client, so the clone
 *      threw "Response body is already used". The promise was fire-and-forget,
 *      so the rejection went nowhere and the route stored nothing -- ever. The
 *      only entries the cache held were the six install() precached.
 *   2. The route matched on `request.destination`. The engine arrives through
 *      fetch(), whose destination is the empty string, so the worker never saw
 *      the 6.88 MB payload it exists to cache.
 *
 * Together those left offline simulation leaning on the browser's HTTP cache
 * for a 7 MB body. The runtime half of that is scripts/offline-sim.mjs, which
 * reproduces the user-visible failure; this is the cheap static half, and both
 * are falsified by the same mutations in scripts/sw-cache.negctl.mjs.
 *
 * What is asserted here is the *shape* the defect needs, not the presence of a
 * string: the response handed to cache.put() must be a binding created by a
 * `.clone()`, taken before the async boundary. Both halves are required, so
 * neither "clone inside the callback" nor "drop the clone" passes.
 */
const SW_PAYLOAD_DIRS = /const\s+ENGINE_PAYLOAD_DIRS\s*=\s*\[([^\]]*)\]/;
const SW_STRING_LITERAL = /["']([^"']+)["']/g;
const SW_ENGINE_PREDICATE = 'isEnginePayload(event.request)';

/** Text between the parens of the call opening at `open` (index of "("). */
function callArgs(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return text.slice(open + 1, i); }
  }
  return null;
}

// --------------------------------------------------------------------------
// 14. corner sweep
// --------------------------------------------------------------------------
// The capability blob. `id:` and `devices:` hold identifiers rather than
// literals -- the minifier lifts both out -- so this captures the names and the
// check resolves them; only the corner list is an inline literal, which is the
// one that has to be compared with what the manifest declares.
const PROFILE_CORNERS = /profiles:\[\{id:([A-Za-z_$][\w$]*),label:`[^`]*`,corners:\[([^\]]*)\],devices:([A-Za-z_$][\w$]*)\}/;
const SELECTOR_MAP = /c===`([^`]+)`\?(-?\d+):/g;
const SELECTOR_EMIT = /\.param ([A-Za-z_][A-Za-z0-9_]*)=\$\{v\}/g;
const TICKED = /`([^`]+)`/g;

/**
 * A process corner has to be closed on both sides: the profile the panel reads
 * must offer the corners, and the library must actually move when one is
 * selected. Either half alone looks exactly like a working feature -- the
 * dropdown still renders, the run still completes, and the executor still
 * advertises "corner" among its sweep axes -- which is why nothing here is
 * taken on trust. The corner list is parsed out of the capability blob, the
 * name-to-selector map is parsed out of the deck emitter, and the library's
 * directive lines are compared against the ones the repair itself declares, so
 * the manifest cannot drift away from the artifact in either direction.
 *
 * The model numbers are the one thing declared rather than derived, for the
 * same reason check 11 declares the policy: an artifact whose editor sources
 * are not public has nowhere else to state what the library is meant to hold,
 * and a hand edit there should show up as a line a reviewer reads.
 */
function checkCornerSweep(site, manifestPath) {
  const out = { status: 'checked', corners: [], devices: [], findings: [], notes: [] };
  if (manifestPath === null || !existsSync(manifestPath)) {
    out.status = 'unavailable';
    out.notes.push('no corner manifest (pass --corner=<file> to enable this check)');
    return out;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    out.status = 'unreadable';
    out.notes.push('cannot parse ' + manifestPath + ': ' + e.message);
    return out;
  }
  const ref = slash(manifestPath.slice(REPO_ROOT.length + 1));
  const contract = manifest.contract ?? {};
  const corners = contract.corners;
  const typical = contract.typicalCorner;
  const selectors = contract.selectors;
  if (!Array.isArray(corners) || corners.length < 2 || typeof typical !== 'string' ||
      selectors === null || typeof selectors !== 'object') {
    // An empty or absent contract would make every rule below vacuous while
    // still printing "ok", which is the failure mode this guard exists for.
    out.findings.push({
      key: 'corner-contract-vacuous', ref,
      notes: ['the manifest declares no usable corner contract, so nothing here would be verified'],
    });
    return out;
  }
  out.corners = corners;
  out.typical = typical;
  if (!corners.includes(typical)) {
    out.findings.push({
      key: 'corner-typical-not-declared', ref,
      notes: [
        'typicalCorner ' + JSON.stringify(typical) + ' is not among corners ' + JSON.stringify(corners),
        'the panel selects corners[0] by default and the library implements the typical corner with its',
        'declared default selector, so a contract that separates them describes a default nobody gets',
      ],
    });
  }

  const countOcc = (text, needle) => {
    let n = 0;
    let at = 0;
    for (;;) {
      const i = text.indexOf(needle, at);
      if (i === -1) return n;
      n += 1;
      at = i + needle.length;
    }
  };
  const readAt = (rel) => {
    const path = join(site, rel.split('/').join('\\'));
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };

  // --- 0. applicability. This check reasons about the *deploy artifact*, and a
  //        tree that carries neither half of the feature is not it -- the
  //        negative controls for other checks build two-file trees under the
  //        system temp directory, and reporting nine findings against a stub
  //        would make every one of them fail for a reason that has nothing to do
  //        with what it tests. The gate is deliberately "does this tree claim
  //        the feature at all?" and NOT "is the file present?": the failure this
  //        check exists for is exactly *controls present, library gone*, so an
  //        absent library must be reported, not skipped. A tree is about corners
  //        when the capability blob parses (an empty `corners:[]` still counts,
  //        which is what keeps the unpatched artifact reviewable) or when the
  //        library the manifest names exists.
  const capProbe = readAt(contract.capabilityFile ?? '');
  const libProbe = readAt(contract.libraryFile ?? '');
  if (!(capProbe !== null && PROFILE_CORNERS.test(capProbe)) && libProbe === null) {
    out.status = 'absent';
    out.notes.push('this tree carries neither the corner controls nor the corner library');
    return out;
  }

  // --- 1. the repairs themselves. A rebuild is the single most likely way for
  //        this feature to disappear, and a tree with the capability but not the
  //        library (or the reverse) is worse than one with neither: the control
  //        still lights up and still does nothing.
  for (const repair of manifest.repairs ?? []) {
    const text = readAt(repair.file);
    if (text === null) {
      out.findings.push({
        key: 'corner-repair-file-absent:' + repair.id, ref: repair.file,
        notes: ['this repair targets a file that is not in this tree'],
      });
      continue;
    }
    for (const [i, edit] of (repair.edits ?? []).entries()) {
      const n = countOcc(text, edit.replace);
      if (n === 1) continue;
      out.findings.push({
        key: 'corner-repair-missing:' + repair.id + '#' + i, ref: repair.file,
        notes: [
          n === 0
            ? 'repair ' + repair.id + ' edit #' + i + ' is not present in the artifact'
            : 'repair ' + repair.id + ' edit #' + i + ' appears ' + n +
              ' times, so the tree is neither repaired nor repairable',
          'apply with: node scripts/patch-outbound.mjs --manifest=' + ref,
        ],
      });
    }
  }

  // --- 2. what the profile advertises, parsed out of the capability object.
  const capText = readAt(contract.capabilityFile ?? '');
  if (capText === null) {
    out.findings.push({
      key: 'corner-capability-file-absent', ref: String(contract.capabilityFile),
      notes: ['the chunk that advertises the profile is not in this tree'],
    });
  } else {
    const blob = PROFILE_CORNERS.exec(capText);
    if (blob === null) {
      out.findings.push({
        key: 'corner-capability-missing', ref: contract.capabilityFile,
        notes: ['no profile blob matching id/label/corners/devices, so nothing advertises corners at all'],
      });
    } else {
      const advertised = [...blob[2].matchAll(TICKED)].map((m) => m[1]);
      out.corners = advertised;
      const binder = new RegExp('(?:^|[,;{])\\s*' + blob[3] + '\\s*=\\s*\\[([^\\]]*)\\]');
      const dev = binder.exec(capText);
      out.devices = dev === null ? [] : [...dev[1].matchAll(TICKED)].map((m) => m[1]);
      if (dev === null) {
        out.findings.push({
          key: 'corner-devices-unresolved', ref: contract.capabilityFile,
          notes: ['profiles[0].devices is the identifier ' + JSON.stringify(blob[3]) +
            ' and no single array literal binds it, so the device list cannot be checked'],
        });
      }
      if (advertised.join(',') !== corners.join(',')) {
        out.findings.push({
          key: 'corner-capability-mismatch', ref: contract.capabilityFile,
          notes: [
            'the artifact advertises ' + JSON.stringify(advertised) +
              ', the manifest declares ' + JSON.stringify(corners),
            'order matters: corners[0] is what the panel selects before the user touches anything',
          ],
        });
      }
      if (advertised[0] !== undefined && advertised[0] !== typical) {
        out.findings.push({
          key: 'corner-capability-default-not-typical', ref: contract.capabilityFile,
          notes: [
            'the panel defaults to corners[0] = ' + JSON.stringify(advertised[0]) +
              ', which is not the typical corner ' + JSON.stringify(typical),
          ],
        });
      }

      // --- 3. the emitter: which corner name maps to which number, and which
      //        parameter the deck writes.
      //
      // Two scans, deliberately independent. The parameter name is a whole-file
      // match, so it is checked whether or not the emission needle below still
      // matches -- renaming the parameter is exactly the case where the needle
      // stops matching, and reporting only "the emitter changed" would leave the
      // reason unstated. The name-to-number map has to be scoped, because the
      // bundle contains other `x===\`y\`?1:` ternaries (an analysis selector
      // among them) and a whole-file scan would report those as corners. That
      // scope is a window around the emission, so it is only meaningful while
      // the emission itself is found; when it is not, corner-emitter-missing
      // already fails the check and the map below is not consulted.
      const emitted = [...capText.matchAll(SELECTOR_EMIT)].map((m) => m[1]);
      if (emitted.length !== 1 || emitted[0] !== contract.selectorParam) {
        out.findings.push({
          key: 'corner-selector-param-mismatch', ref: contract.capabilityFile,
          notes: ['the deck writes ' + JSON.stringify(emitted) + ', the manifest declares the parameter ' +
            JSON.stringify(contract.selectorParam) + ' -- a name the library has never heard of would make',
            'ngspice ignore the selector and report nothing at all'],
        });
      }

      const emitNeedle = contract.emitterNeedle;
      const at = emitNeedle ? capText.indexOf(emitNeedle) : -1;
      if (at < 0) {
        out.findings.push({
          key: 'corner-emitter-missing', ref: contract.capabilityFile,
          notes: ['the deck emitter no longer contains the declared selector emission',
            JSON.stringify(emitNeedle ?? '(no emitterNeedle in the manifest)')],
        });
      } else {
        const window = capText.slice(Math.max(0, at - 400), at + emitNeedle.length);
        const mapped = new Map();
        for (const m of window.matchAll(SELECTOR_MAP)) {
          if (!mapped.has(m[1])) mapped.set(m[1], Number(m[2]));
        }
        for (const name of corners) {
          if (name === typical) {
            if (mapped.has(name)) {
              out.findings.push({
                key: 'corner-selector-typical-mapped', ref: contract.capabilityFile,
                notes: ['the typical corner is mapped to a selector, so the default run would emit a',
                  'selector line too and every existing deck would change'],
              });
            }
            continue;
          }
          if (!mapped.has(name)) {
            out.findings.push({
              key: 'corner-selector-missing:' + name, ref: contract.capabilityFile,
              notes: ['the profile advertises ' + JSON.stringify(name) + ' and the emitter has no selector for it,',
                'so choosing it would produce the typical deck -- a control that lights up and does nothing'],
            });
            continue;
          }
          if (mapped.get(name) !== selectors[name]) {
            out.findings.push({
              key: 'corner-selector-value:' + name, ref: contract.capabilityFile,
              notes: ['the emitter maps ' + name + ' to ' + mapped.get(name) +
                ', the manifest declares ' + selectors[name]],
            });
          }
        }
        for (const name of mapped.keys()) {
          if (!corners.includes(name)) {
            out.findings.push({
              key: 'corner-selector-extra:' + name, ref: contract.capabilityFile,
              notes: ['the emitter can select ' + JSON.stringify(name) + ', which no profile advertises'],
            });
          }
        }
      }
      if (contract.descriptorNeedle && !capText.includes(contract.descriptorNeedle)) {
        out.findings.push({
          key: 'corner-descriptor-missing', ref: contract.capabilityFile,
          notes: ['the prepared-deck descriptor no longer carries environment.corner into the include branch,',
            'so the corner the panel sends is dropped before any deck is assembled'],
        });
      }
      if (contract.reportNeedle && !capText.includes(contract.reportNeedle)) {
        out.findings.push({
          key: 'corner-report-missing', ref: contract.capabilityFile,
          notes: ['the run record no longer names the corner, so three corner-swept runs export three',
            'records that differ only by an opaque deck hash'],
        });
      }
    }
  }

  // --- 4. the library. Compared against the directive lines the repair itself
  //        declares, so the manifest is the single place either side is written
  //        and a hand edit shows up as a mismatch rather than passing.
  const libText = readAt(contract.libraryFile ?? '');
  if (libText === null) {
    out.findings.push({
      key: 'corner-library-absent', ref: String(contract.libraryFile),
      notes: ['the model library is not in this tree'],
    });
  } else {
    const libRepair = (manifest.repairs ?? []).find((r) => r.file === contract.libraryFile);
    const declared = libRepair
      ? libRepair.edits.flatMap((e) => e.replace.split('\n'))
        .map((l) => l.trim()).filter((l) => /^\.(?:model|param)\s/.test(l))
      : null;
    const actual = libText.split('\n').map((l) => l.trim()).filter((l) => /^\.(?:model|param)\s/.test(l));
    if (declared === null || declared.length === 0) {
      out.findings.push({
        key: 'corner-library-repair-absent', ref,
        notes: ['the manifest declares no repair for ' + contract.libraryFile +
          ', so there is nothing to compare the library against'],
      });
    } else if (declared.join('\n') !== actual.join('\n')) {
      let first = 0;
      while (first < declared.length && declared[first] === actual[first]) first += 1;
      out.findings.push({
        key: 'corner-library-drift', ref: contract.libraryFile,
        notes: [
          'the library\'s directive lines are not the ones the repair declares (' +
            declared.length + ' declared, ' + actual.length + ' in the artifact)',
          'first difference at line ' + first + ': declared ' + JSON.stringify(declared[first] ?? null) +
            ', artifact ' + JSON.stringify(actual[first] ?? null),
        ],
      });
    }
    // The device list the profile advertises has to be something the library
    // declares a model for. A corner sweep over a device the library never
    // defined fails inside the engine, where the panel cannot explain it.
    for (const name of out.devices) {
      if (!new RegExp('^\\.model\\s+' + name + '\\s', 'm').test(libText)) {
        out.findings.push({
          key: 'corner-device-unmodelled:' + name, ref: contract.libraryFile,
          notes: ['the profile advertises device ' + JSON.stringify(name) + ' and the library declares no model for it'],
        });
      }
    }
  }

  return out;
}

// 15. import library reachability
//
// The File menu's Import SPICE control is a plain multi-file picker, and that is
// the only channel files can enter this deployment through (webkitdirectory
// occurs nowhere in the build), so a selection arrives with an empty
// webkitRelativePath and the importer falls back to File.name. The include
// resolver, however, is written as though a directory structure were available:
// Jl() refuses anything that climbs above dirname(entry), which for a flat name
// is empty. So the spelling cap.lib and opamp.lib both instruct their readers to
// write -- `.include ../models/<lib>` -- is refused before the file pool is even
// consulted.
//
// scripts/import-libs.json closes that with two edits: the shipped libraries join
// the pool Ql() hands to Zl(), and a relative include whose strict resolution
// failed is retried by filename against that pool. What is checked here is the
// part a browser run cannot see: that the text embedded in the chunk is still
// the text in site/models/, that the injected code is actually CALLED rather
// than merely present, and that the fallback is still fenced to relative paths
// and to names the pool holds. The behaviour itself -- four spellings importing,
// two controls refusing -- is scripts/spice-import.mjs.
function checkImportLibs(site, manifestPath) {
  const out = { status: 'checked', libraries: [], findings: [], notes: [] };
  if (!manifestPath) {
    out.status = 'absent';
    out.notes.push('no import manifest (pass --import=<file> to enable this check)');
    return out;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    out.status = 'absent';
    out.notes.push('cannot read the import manifest: ' + e.message);
    return out;
  }
  const contract = manifest.contract ?? {};
  const ref = manifestPath.replace(REPO_ROOT, '').replace(/^[\\/]/, '');
  const repairs = manifest.repairs ?? [];
  if (!contract.chunk || !Array.isArray(contract.libraries) || !contract.libraries.length || !repairs.length) {
    out.status = 'absent';
    out.notes.push('the import manifest declares no usable contract, so nothing here would be verified');
    return out;
  }
  const chunkPath = join(site, String(contract.chunk).split('/').join('\\'));
  if (!existsSync(chunkPath)) {
    out.status = 'absent';
    out.notes.push('no ' + contract.chunk + ' in this tree');
    return out;
  }
  const chunk = readFileSync(chunkPath, 'utf8');

  // Applicability. The negative controls for other checks build two-file trees,
  // and a check that reads the import chunk unconditionally would report every
  // one of them as broken. The gate is "does this tree carry the feature at
  // all": the Import SPICE control is the thing the repair exists for, and it is
  // present whether or not the repair has been applied -- so a tree that has the
  // control and not the repair is still checked, and reports it.
  if (!chunk.includes('spice-files')) {
    out.status = 'absent';
    out.notes.push('this tree carries no Import SPICE control, so it has no import to make reachable');
    return out;
  }

  const count = (text, needle) => {
    let n = 0;
    let at = 0;
    for (;;) {
      const i = text.indexOf(needle, at);
      if (i === -1) return n;
      n += 1;
      at = i + needle.length;
    }
  };

  // --- 1. both repairs are in place ------------------------------------------
  for (const repair of repairs) {
    const label = repair.id ?? '(unnamed)';
    const file = join(site, String(repair.file).split('/').join('\\'));
    if (!existsSync(file)) {
      out.findings.push({ key: 'import-repair-file-absent:' + label, ref: String(repair.file), notes: ['the file this repair edits is not in this tree'] });
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const markers = repair.marker ? [repair.marker] : (repair.edits ?? []).map((e) => e.marker).filter(Boolean);
    if (!markers.length) {
      out.findings.push({ key: 'import-repair-unmarked:' + label, ref: String(repair.file), notes: ['the repair declares no marker, so its presence cannot be established from the artifact'] });
      continue;
    }
    for (const marker of markers) {
      const n = count(text, marker);
      if (n !== 1) {
        out.findings.push({
          key: 'import-repair-missing:' + label, ref: String(repair.file),
          notes: ['marker ' + JSON.stringify(marker) + ' occurs ' + n + ' time(s); expected exactly 1',
            'an artifact with the control but without this repair refuses includes naming a library the user cannot supply'],
        });
      }
    }
  }

  // --- 2. the injected code is called, not merely present --------------------
  //
  // "Present in the artifact" and "reached at runtime" are different claims, and
  // only the second one matters. An earlier draft of this repair added the
  // definitions and forgot to rewire the call; the chunk looked patched and
  // nothing changed. This is the assertion that catches that shape.
  if (!chunk.includes('function builtinSourceFiles(') || !chunk.includes('builtinSourceFiles(e)')) {
    out.findings.push({
      key: 'import-pool-not-called', ref: contract.chunk,
      notes: ['the pool is either undefined or defined and never handed to Zl(), so an unselected include still cannot resolve'],
    });
  } else if (!/Zl\(\[\.\.\.e,\.\.\.builtinSourceFiles\(e\)\]\)/.test(chunk)) {
    out.findings.push({
      key: 'import-pool-call-shape', ref: contract.chunk,
      notes: ['builtinSourceFiles is called, but not as Zl([...e, ...builtinSourceFiles(e)]) -- confirm the pool still reaches the decoder'],
    });
  }

  // --- 3. the embedded text is the text in this tree ------------------------
  //
  // The manifest carries a copy of site/models/*.lib. A copy that drifts is
  // worse than no copy: the import would resolve to a library the artifact does
  // not ship, and every other check would still pass.
  const poolMatch = /var BUILTIN_SOURCE_LIBS=(\[[\s\S]*?\]);function builtinSourceFiles/.exec(chunk);
  if (chunk.includes('var BUILTIN_SOURCE_LIBS=') && !poolMatch) {
    out.findings.push({ key: 'import-pool-unparsable', ref: contract.chunk, notes: ['the embedded library array is not in the shape this check reads, so it cannot be compared with the tree'] });
  }
  const embedded = new Map();
  if (poolMatch) {
    let parsed = null;
    try { parsed = JSON.parse(poolMatch[1]); } catch (e) { parsed = null; }
    if (!Array.isArray(parsed)) {
      out.findings.push({ key: 'import-pool-unparsable', ref: contract.chunk, notes: ['the embedded library array does not parse as JSON'] });
    } else {
      for (const entry of parsed) if (entry && typeof entry.name === 'string') embedded.set(entry.name, String(entry.text ?? ''));

      for (const decl of contract.libraries) {
        const libPath = join(site, 'models', String(decl.name).split('/').join('\\'));
        if (!existsSync(libPath)) {
          out.findings.push({ key: 'import-lib-missing:' + decl.name, ref: 'models/' + decl.name, notes: ['the manifest says this build ships this library; the tree does not have it'] });
          continue;
        }
        const bytes = readFileSync(libPath);
        const digest = createHash('sha256').update(bytes).digest('hex');
        out.libraries.push({ name: decl.name, bytes: bytes.length, sha256: digest });

        if (decl.sha256 && decl.sha256 !== digest) {
          out.findings.push({
            key: 'import-manifest-drift:' + decl.name, ref: ref,
            notes: ['the manifest pins sha256:' + String(decl.sha256).slice(0, 12) + ' and models/' + decl.name +
              ' hashes to ' + digest.slice(0, 12) + '; re-derive the manifest from this tree'],
          });
        }
        if (!embedded.has(decl.name)) {
          out.findings.push({
            key: 'import-pool-not-declaring:' + decl.name, ref: contract.chunk,
            notes: ['models/' + decl.name + ' ships in this tree but is not in the imported pool, so a netlist including it still fails'],
          });
          continue;
        }
        const text = embedded.get(decl.name);
        if (Buffer.from(text, 'utf8').compare(bytes) !== 0) {
          const a = Buffer.from(text, 'utf8');
          let first = 0;
          while (first < Math.min(a.length, bytes.length) && a[first] === bytes[first]) first += 1;
          out.findings.push({
            key: 'import-lib-drift:' + decl.name, ref: contract.chunk,
            notes: ['the text embedded in ' + contract.chunk + ' is not the bytes of models/' + decl.name +
              ' (' + a.length + ' vs ' + bytes.length + ' bytes)',
              'first difference at byte ' + first],
          });
        }
      }
      for (const name of embedded.keys()) {
        if (!contract.libraries.some((l) => l.name === name)) {
          out.findings.push({ key: 'import-pool-undeclared:' + name, ref: contract.chunk, notes: ['the pool carries a library the manifest does not declare, so this check cannot say what it should contain'] });
        }
      }
    }
  }

  // --- 4. the fallback is fenced -------------------------------------------
  //
  // Two fences, both load-bearing. The local-only test is what keeps a non-local
  // include refused -- `absolute-include` in the runtime harness is written
  // against exactly this, naming a basename the pool holds. `r.files.has(ir)` is
  // what keeps the fallback a lookup rather than an invention: it can only
  // resolve to a file the pool or the selection actually holds.
  if (!chunk.includes('includeBasenameFallback')) {
    out.findings.push({
      key: 'import-fallback-missing', ref: contract.chunk,
      notes: ['a relative include refused by Jl() has no filename fallback, so the spelling the shipped libraries teach is still refused'],
    });
  } else {
    if (!chunk.includes('[a-z]:[\\\\/])/iu.test(includeBasenameFallback)')) {
      out.findings.push({
        key: 'import-fallback-unguarded', ref: contract.chunk,
        notes: ['the fallback no longer tests that the requested path is relative, so a non-local include could resolve against the shipped pool',
          'that turns the "not local" rule into a filename lookup and makes /usr/share/<shipped lib> importable'],
      });
    }
    if (!chunk.includes('r.files.has(ir)')) {
      out.findings.push({
        key: 'import-fallback-unscoped', ref: contract.chunk,
        notes: ['the fallback no longer requires the name to be in the pool or the selection, so it can resolve an include to nothing'],
      });
    }
  }

  return out;
}

/**
 * 16. static gallery shim.
 *
 * The Gallery panel reads four origin-root endpoints and only a server can
 * answer them, so on a static deploy its fetches fail, the client degrades to
 * null and the gallery section never renders. scripts/gallery-shim.json routes
 * those four to files committed under <scope>gallery/, which makes the panel
 * usable read-only.
 *
 * This is the half a browser cannot see. scripts/gallery-shim.mjs drives the
 * panel and reports what the product does; a browser run cannot tell a route
 * that is wired from one that is merely defined, cannot see whether the id used
 * as a path segment was shape-checked before it was joined to a path, and
 * cannot see whether the shim quietly became a cache. Each of those is asserted
 * here, and the last shape assertion tracks the shipped client so the manifest
 * cannot drift away from the keys the panel actually reads.
 */
function checkGalleryShim(site, manifestPath) {
  const out = { status: 'checked', routes: [], findings: [], notes: [] };
  if (!manifestPath) {
    out.status = 'absent';
    out.notes.push('no gallery manifest (pass --gallery=<file> to enable this check)');
    return out;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    out.status = 'vacuous';
    out.findings.push({
      key: 'gallery-shim-manifest-unreadable', ref: String(manifestPath),
      notes: ['cannot read the gallery manifest (' + e.message + '), so nothing here would be verified'],
    });
    return out;
  }
  const contract = manifest.contract ?? {};
  const repairs = manifest.repairs ?? [];
  if (!contract.file || !contract.apiPrefix || !contract.idPattern || !contract.markers || !repairs.length) {
    // A manifest that names no contract would let every rule below pass while
    // verifying nothing -- the same trap check 14 calls a vacuous contract. It
    // is reported as a finding rather than a note so it cannot be mistaken for
    // "this tree has nothing to check".
    out.status = 'vacuous';
    out.findings.push({
      key: 'gallery-shim-contract-vacuous', ref: String(manifestPath),
      notes: ['the gallery manifest declares no usable contract (file/apiPrefix/idPattern/markers/repairs), so nothing here would be verified'],
    });
    return out;
  }
  const swPath = join(site, String(contract.file).split('/').join('\\'));
  if (!existsSync(swPath)) {
    out.status = 'absent';
    out.notes.push('no ' + contract.file + ' in this tree');
    return out;
  }

  // Applicability, by the same rule as check 15: gate on whether this tree
  // declares the FEATURE, not on whether a file this check likes is missing.
  // The gallery client chunk is the panel that needs a server; a tree without
  // it has no gallery for a route to serve, and a tree with it and no route is
  // exactly the defect this check exists to report.
  const assetsDir = join(site, 'assets');
  const chunkNames = existsSync(assetsDir) ? readdirSync(assetsDir) : [];
  const clientName = chunkNames.find((f) => /^gallery-client-.*\.js$/.test(f));
  if (!clientName) {
    out.status = 'absent';
    out.notes.push('this tree carries no gallery client chunk, so it has no gallery for a route to serve');
    return out;
  }
  const sw = readFileSync(swPath, 'utf8');
  const client = readFileSync(join(assetsDir, clientName), 'utf8');
  const appText = chunkNames
    .filter((f) => /^App-.*\.js$/.test(f))
    .map((f) => readFileSync(join(assetsDir, f), 'utf8'))
    .join('');
  const ref = String(contract.file);
  const count = (text, needle) => {
    let n = 0;
    let at = 0;
    for (;;) {
      const i = text.indexOf(needle, at);
      if (i === -1) return n;
      n += 1;
      at = i + needle.length;
    }
  };

  out.routes = Array.isArray(contract.routes) ? contract.routes : [];
  out.assetRoot = String(contract.assetRoot ?? '');
  out.apiPrefix = String(contract.apiPrefix);

  // --- 1. both insertions are in place --------------------------------------
  for (const [name, marker] of Object.entries(contract.markers)) {
    const n = count(sw, String(marker));
    if (n !== 1) {
      out.findings.push({
        key: 'gallery-shim-marker:' + name, ref,
        notes: ['marker ' + JSON.stringify(marker) + ' occurs ' + n + ' time(s); expected exactly 1',
          'without it the endpoint this repair answers stays a 404 and the panel stays dark'],
      });
    }
  }

  // --- 2. the route is WIRED, not merely defined -----------------------------
  //
  // The same failure shape check 15 was written for: an injected definition that
  // nothing calls. Here it has a second form. The fetch listener returns early
  // for every /api/ path on purpose (that branch leaves a revisioned API to its
  // own HTTP policy), so a dispatch placed AFTER it is dead code that every
  // string test would still find.
  const dispatch = 'if (isGalleryApi(event.request)) {';
  const apiReturn = 'if (isSameOriginApi(event.request)) return;';
  const iDispatch = sw.indexOf(dispatch);
  const iApiReturn = sw.indexOf(apiReturn);
  if (iDispatch === -1) {
    out.findings.push({
      key: 'gallery-shim-not-routed', ref,
      notes: ['the handlers are present but nothing dispatches to them, so the four endpoints are still unrouted'],
    });
  } else {
    if (!sw.includes('event.respondWith(galleryApiResponse(event.request))')) {
      out.findings.push({
        key: 'gallery-shim-not-answering', ref,
        notes: ['the dispatch does not respondWith(galleryApiResponse(...)); the worker saw the request and declined to answer it'],
      });
    }
    if (count(sw, 'function galleryApiResponse(') !== 1) {
      out.findings.push({
        key: 'gallery-shim-handler-missing', ref,
        notes: ['galleryApiResponse is dispatched but not defined exactly once'],
      });
    }
    if (iApiReturn !== -1 && iDispatch > iApiReturn) {
      out.findings.push({
        key: 'gallery-shim-route-after-api-return', ref,
        notes: ['the gallery dispatch sits after the isSameOriginApi early return, which returns for every /api/ path',
          'the route is then unreachable while its text is all present -- this is the defect a string test cannot see'],
      });
    }
  }

  // --- 3. the id is shape-checked before it becomes a path segment ----------
  //
  // An entry id arrives from a network response and is joined into a same-origin
  // URL. Without the guard, an id of `../../etc` climbs out of gallery/.
  if (!sw.includes('/' + contract.idPattern + '/i')) {
    out.findings.push({
      key: 'gallery-shim-id-guard-drift', ref,
      notes: ['the declared id pattern ' + JSON.stringify(contract.idPattern) + ' is not the one in the artifact',
        'the manifest and the tree must agree on the shape that keeps an id from being a path'],
    });
  }
  if (count(sw, 'GALLERY_ID.test(') < 2) {
    out.findings.push({
      key: 'gallery-shim-id-unguarded', ref,
      notes: ['the id pattern is tested fewer than twice; both the index entries AND the path parameter must be checked'],
    });
  }
  for (const segment of ['"gallery/" + id + "/preview.svg"', '"gallery/" + id + "/project.json"']) {
    if (!sw.includes(segment)) {
      out.findings.push({
        key: 'gallery-shim-asset-path', ref,
        notes: ['cannot find ' + segment + '; if the asset path changed, the guard assertions above no longer cover what is joined'],
      });
    }
  }

  // --- 4. it ANSWERS; it does not cache -------------------------------------
  //
  // The branch it sits in front of exists so that revisioned preview URLs are
  // never served stale out of the build-scoped shell cache. A shim that stored
  // them would defeat exactly that -- and from the outside it would look right
  // until a revision changed.
  const iHelpers = sw.indexOf(String(contract.markers.helpers ?? ''));
  const iListener = sw.indexOf('self.addEventListener("fetch"');
  if (iHelpers !== -1 && iListener !== -1 && iHelpers < iListener) {
    const region = sw.slice(iHelpers, iListener);
    if (/caches\./.test(region) || /cache\.put\(/.test(region)) {
      out.findings.push({
        key: 'gallery-shim-caches', ref,
        notes: ['the shim region touches Cache Storage, but it sits in front of the branch that keeps /api/* out of the shell cache',
          'storing a revisioned preview would serve the old image under the new name'],
      });
    }
  }

  // --- 5. the JSON still carries the keys the shipped client reads ----------
  //
  // The key must be WRITTEN where a response is built, not merely present
  // somewhere in the region. `entries:` renamed to `items:` leaves the identifier
  // `entries` all over the index reader, so a substring test over a 5 KB region
  // stays green while the client reads an empty list -- the same shape of
  // vacuity this check exists to catch, one level down. So the object literals
  // passed to galleryJson() are collected and each declared key has to be a
  // property name in one of them.
  const declared = new Set([
    ...(contract.listShape ?? []),
    ...(contract.tagsShape ?? []),
    ...(contract.detailShape ?? []),
  ]);
  const shimRegion = iHelpers !== -1 && iListener !== -1 && iHelpers < iListener
    ? sw.slice(iHelpers, iListener)
    : sw;
  const emitted = [];
  for (let at = 0; ;) {
    const i = shimRegion.indexOf('galleryJson({', at);
    if (i === -1) break;
    const open = i + 'galleryJson('.length;
    let depth = 0;
    let end = -1;
    for (let j = open; j < shimRegion.length; j++) {
      if (shimRegion[j] === '{') depth++;
      else if (shimRegion[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) { emitted.push(null); break; }
    emitted.push(shimRegion.slice(open, end + 1));
    at = end + 1;
  }
  const isPropertyName = (key) => {
    const re = new RegExp('(^|[{,\\s])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[:,}]');
    return emitted.some((literal) => literal !== null && re.test(literal));
  };
  for (const key of declared) {
    if (!isPropertyName(key)) {
      out.findings.push({
        key: 'gallery-shim-shape-missing:' + key, ref,
        notes: ['the manifest declares ' + JSON.stringify(key) + ' in the response, but no object literal passed to galleryJson() writes it',
          'the client reads this key, so a response without it is a response the panel cannot use',
          emitted.length ? 'galleryJson() literals found: ' + emitted.length : 'no galleryJson() literal found in the shim region at all'],
      });
    }
  }
  const reads = [];
  if (client.includes('entries??[]')) reads.push({ key: 'entries', where: clientName });
  if (client.includes('nextCursor')) reads.push({ key: 'nextCursor', where: clientName });
  if (client.includes('.total')) reads.push({ key: 'total', where: clientName });
  if (client.includes('.tags??[]')) reads.push({ key: 'tags', where: clientName });
  if (appText.includes('projectText')) reads.push({ key: 'projectText', where: 'the App chunk' });
  if (client.includes('preview.svg')) reads.push({ key: 'preview.svg', where: clientName });
  for (const r of reads) {
    const ok = r.key === 'preview.svg' ? shimRegion.includes('preview.svg') : declared.has(r.key);
    if (!ok) {
      out.findings.push({
        key: 'gallery-shim-contract-drift:' + r.key, ref,
        notes: [r.where + ' reads ' + JSON.stringify(r.key) + ' from these endpoints, but the manifest does not declare it',
          'the client moved; re-derive the manifest contract from the new chunk rather than from this file'],
      });
    }
  }

  return out;
}

/**
 * 17. built-in example project identity.
 *
 * The project factory is `function pl(e,t,n='document-main')`: it stamps the
 * (id, name) its caller passes. Three of the five shipped labs stored the
 * factory's placeholder identity (`project-main` / `New Circuit`) instead of
 * their own, and the title bar renders the project's own name -- so a user who
 * deliberately opened "Two-Stage Op Amp" read "New Circuit" as the circuit they
 * were editing. scripts/example-identity.json repairs the stored identity and
 * makes the catalog's name authoritative at the id -> project boundary.
 *
 * This check is the half that does not need a browser: it reads the catalog and
 * each payload out of the shipped chunk and refuses a placeholder. The rendered
 * half lives in scripts/example-outcomes.mjs, which drives the page and asserts
 * the title bar shows the catalog name -- the two halves are independent, which
 * is why agreement between them is evidence rather than a tautology. A
 * data-only fix would leave the resolver able to hand a future payload's
 * placeholder through; a resolver-only fix would leave the stored data wrong.
 */
function checkExampleIdentity(site) {
  const out = { status: 'checked', examples: [], findings: [], notes: [] };

  // Applicability gates on whether this tree DECLARES the feature (a catalog
  // that binds project literals), not on whether the identity manifest exists.
  // A tree without the catalog has no examples whose identity could be wrong;
  // a tree with it and a payload still holding the placeholder is exactly the
  // defect. Gating on the manifest instead would switch this check off on any
  // tree that had not been repaired yet, which is when it is needed most.
  const assetsDir = join(site, 'assets');
  if (!existsSync(assetsDir)) {
    out.status = 'absent';
    out.notes.push('no assets/ directory in this tree');
    return out;
  }

  const CATALOG_RE = /\{id:`([a-z0-9-]+)`,name:`([^`]*)`,description:`([^`]*)`,requiresUnlock:!(0|1),project:rg\(([\w$]+)\)\}/g;
  let src = null, catalogFile = null, hits = null;
  for (const f of readdirSync(assetsDir)) {
    if (!f.endsWith('.js')) continue;
    const text = readFileSync(join(assetsDir, f), 'utf8');
    const m = [...text.matchAll(CATALOG_RE)];
    if (!m.length) continue;
    if (hits) {
      out.status = 'vacuous';
      out.findings.push({
        key: 'example-catalog-duplicated', ref: f,
        notes: ['the example catalog also appears in ' + catalogFile + ', so which one the product uses cannot be determined'],
      });
      return out;
    }
    src = text; catalogFile = f; hits = m;
  }
  if (!hits) {
    out.status = 'absent';
    out.notes.push('no built-in example catalog in this tree');
    return out;
  }

  // The project literals sit in one `var A={...},B={...}` chain. Locate each
  // bound variable's slice so the identity read here is the one the catalog
  // entry actually points at, not a nearby payload.
  const catalogStart = src.indexOf('{id:`' + hits[0][1] + '`,name:`');
  const marks = hits.map((e) => {
    const v = e[5];
    const a = src.indexOf('var ' + v + '={');
    const b = src.indexOf(',' + v + '={');
    return { v, at: a >= 0 ? a : b };
  }).sort((x, y) => x.at - y.at);
  if (marks.some((m) => m.at < 0) || catalogStart < 0) {
    out.status = 'vacuous';
    out.findings.push({
      key: 'example-catalog-unresolvable', ref: catalogFile,
      notes: ['a catalog entry points at a project binder that could not be located, so its identity was not read'],
    });
    return out;
  }

  const PLACEHOLDER_ID = 'project-main';
  const PLACEHOLDER_NAME = 'New Circuit';

  for (let i = 0; i < marks.length; i++) {
    const to = i + 1 < marks.length ? marks[i + 1].at : catalogStart;
    const slice = src.slice(marks[i].at, to);
    const entry = hits.find((e) => e[5] === marks[i].v);
    if (!entry) continue;
    const [catalogId, catalogName] = [entry[1], entry[2]];
    const payload = /id:`([^`]*)`,name:`([^`]*)`?(?:,schemaVersion:\d+)?,simulationSetups:/.exec(slice);
    const rec = {
      catalogId, catalogName, var: marks[i].v,
      payloadId: payload ? payload[1] : null,
      payloadName: payload ? payload[2] : null,
    };
    out.examples.push(rec);

    if (!payload) {
      out.findings.push({
        key: 'example-identity-unreadable', ref: catalogFile,
        notes: ['example ' + catalogId + ' (binder ' + marks[i].v + ') has no readable project id/name before simulationSetups, so its identity cannot be checked'],
      });
      continue;
    }
    if (rec.payloadId === PLACEHOLDER_ID) {
      out.findings.push({
        key: 'example-identity-placeholder-id', ref: catalogFile,
        notes: ['example ' + catalogId + ' still stores the project factory placeholder id ' + JSON.stringify(PLACEHOLDER_ID) +
          ' (name ' + JSON.stringify(rec.payloadName) + '); the title bar renders the stored name, so the user reads a lab they did not open'],
      });
    }
    if (rec.payloadName === PLACEHOLDER_NAME) {
      out.findings.push({
        key: 'example-identity-placeholder-name', ref: catalogFile,
        notes: ['example ' + catalogId + ' still stores the project factory placeholder name ' + JSON.stringify(PLACEHOLDER_NAME) +
          ' (id ' + JSON.stringify(rec.payloadId) + '); choosing this lab shows ' + JSON.stringify(PLACEHOLDER_NAME) + ' as the circuit name'],
      });
    }
  }

  return out;
}

/**
 * 18. stability margins (phase margin / gain margin).
 *
 * The Bode plot already carries every quantity a stability margin is made of:
 * an AC output is stored as a pair of arrays (values, imaginary), and the
 * plotting layer already derives magnitudeDb and phaseDeg from exactly those
 * two arrays. What the product never did was read a margin off them -- the user
 * could see the curve cross 0 dB and had to estimate the phase there by eye.
 * scripts/stability-margin.json adds the two readings as automatic
 * measurements.
 *
 * Five claims. The first three are structural, and the third is the one whose
 * failure is silent and total:
 *
 *   1. The evaluator is present (marker occurs exactly once).
 *
 *   2. It is CALLED, not merely defined. This is the shape that has bitten this
 *      repository before: the definitions land, the bytes and hashes change,
 *      --check reports success, and behaviour is byte-for-byte identical
 *      because nothing ever invokes them. So the splice expression is asserted
 *      as a call shape, not as a set of names being present.
 *
 *   3. The two new metric names are members of the CLOSED metric enum in the
 *      artifact schema, in BOTH the available and the unavailable variant. A
 *      schema that enumerates its metrics rejects any result file carrying an
 *      unknown one, and it rejects the file WHOLE: the panel then falls back to
 *      "Full result files are unavailable or invalid" and every measurement
 *      disappears, not just the margin. So the symptom of this mistake is a
 *      build that looks broken, which is how it was found -- by comparing the
 *      patched tree against the unpatched one at runtime, not by reading code.
 *      The enum is written twice because an undefined margin still travels
 *      through the unavailable variant on its way to the panel.
 *
 *   4. The evaluator keeps the five properties that make the number correct.
 *      Each of these was a real defect on the way here, and each fails as a
 *      plausible-looking number rather than as a crash:
 *        - the phase is UNWRAPPED before use (else the +/-180 wrap reads as a
 *          360 degree jump),
 *        - crossings are found against a LEVEL, not against zero (a sign test
 *          reads the wrap as a crossing and reports a gain margin for a phase
 *          that merely passed through 0),
 *        - the phase margin is measured relative to the loop's OWN static phase
 *          (against absolute -180 an inverting loop reads 275 degrees, and its
 *          instability is missed by a full 180),
 *        - only AC analyses qualify (a noise analysis has no loop),
 *        - `evidence` is the schema's own aggregate, not an invented shape.
 *
 *   5. The metrics do NOT appear in the AUTHORING tables in the surface chunk.
 *      That is a decision, asserted so it cannot be undone by accident: margin
 *      is automatic-only. The setup editor validates its own method kind
 *      against a closed union with no margin member, so offering the option
 *      would let a user save a setup the authoring schema cannot build -- an
 *      option that is offered and then fails. This rule is what makes a
 *      "helpful" re-add show up.
 *
 * On the shape of the metric tests: the schema members are counted as exact
 * occurrences of the patched enum, and the authoring leak is tested as a quoted
 * object KEY rather than as a substring. That distinction was earned -- a
 * substring test on this very check stayed green when a key was renamed,
 * because the identifier still occurred elsewhere in the file.
 *
 * Numerics are not re-derived here. scripts/stability-margin.oracle.mjs
 * extracts this evaluator from the shipped bytes and checks it against closed
 * forms and an independently written crossing search;
 * scripts/stability-margin.mjs drives the panel in a browser and reads the
 * rendered ROWS, which is the one claim this check cannot make -- that what it
 * verified is actually drawn. This check is the static half: it is cheap, it
 * never opens a browser, and it fails loudly if the evaluator was defined but
 * the splice, the schema member or one of the five properties above was lost.
 * scripts/stability-margin.negctl.mjs breaks each of them in turn and requires
 * this check to say the specific thing it is supposed to say.
 */
function checkStabilityMargin(site, manifestPath) {
  const out = { status: 'checked', metrics: [], findings: [], notes: [] };
  if (!manifestPath) {
    out.status = 'absent';
    out.notes.push('no stability-margin manifest (pass --margin=<file> to enable this check)');
    return out;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    out.status = 'absent';
    out.notes.push('cannot read the stability-margin manifest: ' + e.message);
    return out;
  }
  const contract = manifest.contract ?? {};
  const repairs = manifest.repairs ?? [];
  const executorRel = contract.executorFile;
  const surfaceRel = contract.surfaceFile;
  const schemaRel = contract.schemaFile;
  const ref = slash(manifestPath.slice(REPO_ROOT.length + 1));
  if (!executorRel || !surfaceRel || !schemaRel || !repairs.length || !contract.marginFunction || !contract.autoSummaryAnchor) {
    // A manifest whose contract does not describe a verifiable repair would let
    // every rule below pass while checking nothing, and it would print "ok" --
    // which is the failure mode this guard exists for. So this is a finding,
    // not a quiet 'absent'.
    out.status = 'vacuous';
    out.findings.push({
      key: 'margin-contract-vacuous', ref,
      notes: ['the manifest declares no usable stability-margin contract (executorFile, surfaceFile, schemaFile, marginFunction, autoSummaryAnchor, repairs), so nothing here would be verified'],
    });
    return out;
  }

  const pathOf = (rel) => join(site, String(rel).split('/').join('\\'));
  const executorPath = pathOf(executorRel);
  const surfacePath = pathOf(surfaceRel);
  const schemaPath = pathOf(schemaRel);

  // A tree missing a chunk this check reads is not a tree that fails the check
  // -- it is a tree the check cannot speak about. Reporting the missing file as
  // a finding would make this check fire on every synthetic two-file tree the
  // OTHER negative controls build, which is the cross-noise rule 17 forbids.
  // The gate that decides "is this the product at all" is the automatic summary
  // builder below; the rest is only "can I read what I need".
  for (const [rel, p] of [[executorRel, executorPath], [surfaceRel, surfacePath], [schemaRel, schemaPath]]) {
    if (!existsSync(p)) {
      out.status = 'absent';
      out.notes.push('no ' + rel + ' in this tree');
      return out;
    }
  }
  const executor = readFileSync(executorPath, 'utf8');
  const surface = readFileSync(surfacePath, 'utf8');
  const schema = readFileSync(schemaPath, 'utf8');

  // Applicability. The gate is whether this tree DECLARES the feature -- it
  // builds its automatic measurement summaries in the executor -- not whether
  // the manifest exists, not whether the margin function is already there, and
  // not whether some file this check happens to like is missing. Gating on the
  // margin function would switch the check off in precisely the state it exists
  // to catch: an artifact whose margin code was dropped. The anchor survives
  // patching (the evaluator is injected in front of it), so it is the same
  // declaration in a patched and an unpatched tree.
  if (!executor.includes(String(contract.autoSummaryAnchor))) {
    out.status = 'absent';
    out.notes.push('this tree carries no automatic measurement builder, so it has no summary list for a margin to join');
    return out;
  }

  const count = (text, needle) => {
    let n = 0;
    let at = 0;
    for (;;) {
      const i = text.indexOf(needle, at);
      if (i === -1) return n;
      n += 1;
      at = i + needle.length;
    }
  };

  // --- 1. every repair is present, marker exactly once ----------------------
  for (const repair of repairs) {
    const label = repair.id ?? '(unnamed)';
    const rel = String(repair.file);
    const file = join(site, rel.split('/').join('\\'));
    if (!existsSync(file)) {
      out.findings.push({
        key: 'margin-repair-file-absent:' + label, ref: rel,
        notes: ['the file this repair edits is not in this tree'],
      });
      continue;
    }
    const text = readFileSync(file, 'utf8');
    const markers = repair.marker ? [repair.marker] : (repair.edits ?? []).map((e) => e.marker).filter(Boolean);
    if (!markers.length) {
      out.findings.push({
        key: 'margin-repair-unmarked:' + label, ref: rel,
        notes: ['the repair declares no marker, so its presence cannot be established from the artifact'],
      });
      continue;
    }
    for (const marker of markers) {
      const n = count(text, marker);
      if (n !== 1) {
        out.findings.push({
          key: 'margin-repair-missing:' + label, ref: rel,
          notes: ['marker ' + JSON.stringify(marker) + ' occurs ' + n + ' time(s); expected exactly 1',
            'without it the Bode plot still draws, but no margin is ever reported beside it'],
        });
      }
    }
  }

  // --- 2. the evaluator is CALLED ------------------------------------------
  //
  // The splice expression names the margin function between the automatic
  // summaries and the authored rules. Testing the whole expression rather than
  // the function name is the point: a definition that nothing invokes changes
  // the bytes and changes no behaviour.
  const marginFn = String(contract.marginFunction);
  const fnName = /function\s+([\w$]+)\s*\(/.exec(marginFn)?.[1] ?? null;
  if (!executor.includes(marginFn)) {
    out.findings.push({
      key: 'margin-evaluator-absent', ref: executorRel,
      notes: ['the evaluator entry point ' + JSON.stringify(marginFn) + ' is not defined in the artifact, so no margin is computed'],
    });
  } else if (!fnName) {
    out.findings.push({
      key: 'margin-evaluator-unparsable', ref: executorRel,
      notes: ['the declared entry point is not in the shape this check reads, so its call site cannot be derived'],
    });
  } else {
    const splice = String(contract.marginSplice ?? '');
    if (!splice) {
      out.findings.push({
        key: 'margin-splice-undeclared', ref: executorRel,
        notes: ['the manifest declares an evaluator but no splice expression, so nothing establishes that it is invoked'],
      });
    } else if (!executor.includes(splice)) {
      out.findings.push({
        key: 'margin-splice-missing', ref: executorRel,
        notes: ['the splice ' + JSON.stringify(splice) + ' is absent: the evaluator is defined and never called, so the measurement list is unchanged',
          'this is a definition-only patch -- bytes and hashes differ while the reported measurements do not'],
      });
    }
  }

  // --- 3. the metrics pass the artifact schema ------------------------------
  //
  // The load-bearing agreement, and the only one whose failure takes the whole
  // panel down with it. The schema enumerates the metric names it accepts and
  // is written TWICE -- once for the available variant and once for the
  // unavailable one -- so both have to carry the new members. A margin that is
  // refused still travels through the unavailable variant on its way to the
  // panel, so extending only the first would break every refusal.
  const enumPatched = String(contract.schemaMetricEnumPatched ?? '');
  const enumBase = String(contract.schemaMetricEnum ?? '');
  const wantEnums = Number(contract.schemaEnumOccurrences ?? 2);
  if (!enumPatched) {
    out.findings.push({
      key: 'margin-schema-enum-undeclared', ref,
      notes: ['the manifest declares no patched metric enum, so nothing establishes that the new metrics are admissible to the result schema'],
    });
  } else {
    const got = count(schema, enumPatched);
    if (got !== wantEnums) {
      out.findings.push({
        key: 'margin-schema-enum:' + got + '-of-' + wantEnums, ref: schemaRel,
        notes: ['the patched metric enum occurs ' + got + ' time(s); expected exactly ' + wantEnums + ' (one per schema variant)',
          'the schema rejects any result file carrying a metric it does not enumerate, and it rejects the file WHOLE,',
          'so this is not a missing margin row: it is every measurement disappearing behind',
          '"Full result files are unavailable or invalid"'],
      });
    }
    if (enumBase && count(schema, enumBase) !== 0) {
      out.findings.push({
        key: 'margin-schema-enum-unpatched', ref: schemaRel,
        notes: ['the pre-patch metric enum still occurs in this schema, so at least one variant was left unextended: ' + JSON.stringify(enumBase)],
      });
    }
  }

  // --- 4. the metrics are emitted with the right shape ----------------------
  //
  // The emit call pins the metric, the label and the unit in one needle. The
  // unit matters on its own: the record factory's default is the output's unit
  // (a volt or an amp), so a margin that inherits it renders as "90.57 V" --
  // populated, and wrong.
  for (const kind of ['phase', 'gain']) {
    const metric = String(contract[kind + 'MarginMetric'] ?? '');
    const unit = String(contract[kind + 'MarginUnit'] ?? '');
    const emit = String(contract[kind + 'MarginEmit'] ?? '');
    if (!metric) continue;
    out.metrics.push({ metric, unit });
    if (!emit) {
      out.findings.push({
        key: 'margin-emit-undeclared:' + metric, ref,
        notes: ['the manifest declares no emit call for ' + JSON.stringify(metric) + ', so its metric/label/unit cannot be confirmed'],
      });
    } else if (!executor.includes(emit)) {
      out.findings.push({
        key: 'margin-emit-missing:' + metric, ref: executorRel,
        notes: ['no record is emitted as ' + JSON.stringify(emit),
          'the spelling of the metric, its label and its unit is part of the contract: a rename of any of the three changes what the panel says, and the unit defaults to the output unit (volts or amps) if it is dropped'],
      });
    }
  }

  // --- 5. the evaluator keeps the properties that make the number correct ----
  //
  // Each of these was a real defect on the way here, and each fails as a
  // plausible-looking number rather than as a crash -- 275 degrees of phase
  // margin on a loop that is in fact unstable, or a gain margin quoted for a
  // phase that only passed through 0 degrees.
  const properties = [
    ['crossing-search', contract.crossingNeedle, 'the crossing search is gone, so no margin can be read off the curves'],
    ['phase-formula', contract.phaseFormulaNeedle,
      'the margin has to be derived from the same phase the plot draws (atan2 of the imaginary over the real part, in degrees)'],
    ['magnitude-formula', contract.magnitudeFormulaNeedle,
      'the margin has to be derived from the same magnitude the plot draws (20 log10, with the same clamp floor), or the margin belongs to a different curve than the one on screen'],
    ['level-test', contract.levelTestNeedle,
      'crossings have to be found against a LEVEL, not against zero: a sign test reads the +/-180 wrap as a crossing and reports a gain margin for a phase that only passed through 0 degrees'],
    ['unwrap', contract.unwrapNeedle,
      'the phase has to be unwrapped before use, or the +/-180 wrap reads as a 360 degree jump and every later comparison is meaningless'],
    ['static-phase', contract.staticPhaseNeedle,
      'the loop\'s own static phase has to be derived, because that is what the margin is measured relative to'],
    ['phase-reference', contract.phaseReferenceNeedle,
      'the phase margin has to be measured relative to the loop\'s own static phase: against absolute -180 an inverting loop reads 180 degrees high and its instability is missed by a full 180'],
    ['ac-only', contract.acOnlyNeedle,
      'only an AC analysis has a loop; a noise analysis must not produce margins'],
    ['evidence-shape', contract.evidenceShapeNeedle,
      'evidence has to be the schema\'s own aggregate, not an invented shape, or the record fails validation'],
    ['record-factory', contract.recordFactoryNeedle,
      'the record factory is gone, so neither row of a margin pair can be built'],
    ['refusal-record', contract.unavailableNeedle,
      'a margin that cannot be defined has to be emitted as an unavailable record carrying the reason it was given -- never as a missing row, never as a zero, and never as a row that renders "Unavailable" and stops there'],
  ];
  for (const [label, needle, why] of properties) {
    const text = String(needle ?? '');
    if (!text) {
      out.findings.push({
        key: 'margin-property-undeclared:' + label, ref,
        notes: ['the manifest declares no needle for the ' + label + ' property, so it cannot be confirmed from the artifact'],
      });
    } else if (!executor.includes(text)) {
      out.findings.push({
        key: 'margin-property-missing:' + label, ref: executorRel,
        notes: [why + '; expected ' + JSON.stringify(text)],
      });
    }
  }

  // --- 6. the metrics are offered for AUTHORING nowhere ---------------------
  //
  // A negative claim, and a deliberate one: margin is automatic-only. The setup
  // editor validates its method kind against a closed union that has no margin
  // member, so an entry in these tables would let a user build a setup the
  // authoring schema cannot load -- an option that is offered and then fails.
  // Only a POSITIVE sighting is reported, so a surface whose tables cannot be
  // read produces no finding about a leak that cannot exist.
  const kindTable = /ne=\{([^}]*)\};/.exec(surface);
  const selector = /function\s+D\(e\)\{[^}]*\}/.exec(surface);
  for (const kind of ['phase', 'gain']) {
    const metric = String(contract[kind + 'MarginMetric'] ?? '');
    if (!metric || (!kindTable && !selector)) continue;
    const inKinds = kindTable ? kindTable[1].includes('"' + metric + '":') : false;
    const inSelector = selector ? selector[0].includes('`' + metric + '`') : false;
    if (inKinds || inSelector) {
      out.findings.push({
        key: 'margin-authoring-leak:' + metric, ref: surfaceRel,
        notes: ['the authoring tables in this chunk offer ' + JSON.stringify(metric) +
          ' (label table: ' + inKinds + ', method selector: ' + inSelector + ')',
          'the setup editor validates against a closed method union with no margin member, so a setup built from this option cannot be loaded',
          'margin is automatic-only by design; the automatic path is what makes it reachable'],
      });
    }
  }

  // --- 7. the plot still draws the curve the margin is measured on ----------
  //
  // phaseDeg and magnitudeDb are computed by the surface chunk, once per point,
  // for the Bode plot. The evaluator computes the same two quantities from the
  // same two arrays for the margin. Nothing shares code between them, so a
  // change to either one moves the margin off the curve the user is reading,
  // and the failure is a plausible-looking number rather than an error. Section
  // 4 pins the evaluator's half; this pins the surface's.
  for (const [name, needle] of [
    ['phase', contract.surfacePhaseExpr],
    ['magnitude', contract.surfaceMagnitudeExpr],
  ]) {
    const text = String(needle ?? '');
    if (!text) {
      out.findings.push({
        key: 'margin-surface-undeclared:' + name, ref,
        notes: ['the manifest declares no surface ' + name + ' expression, so the curve the margin is measured on cannot be confirmed'],
      });
    } else if (!surface.includes(text)) {
      out.findings.push({
        key: 'margin-surface-drift:' + name, ref: surfaceRel,
        notes: ['the surface no longer computes its ' + name + ' this way: ' + JSON.stringify(text),
          'the margin and the plotted curve would then be derived from different quantities, so the crossing a user reads off the plot is not the crossing the margin was taken at'],
      });
    }
  }

  return out;
}

function checkServiceWorkerCache(site) {
  const swPath = join(site, 'sw.js');
  if (!existsSync(swPath)) {
    return { status: 'absent', findings: [], notes: ['no sw.js in this tree'], dirs: [] };
  }
  const text = readFileSync(swPath, 'utf8');
  const findings = [];
  const dirs = [];

  // --- every cache.put() must receive a clone bound before the async boundary
  const PUT = /cache\.put\(/g;
  let m;
  let puts = 0;
  while ((m = PUT.exec(text)) !== null) {
    puts++;
    const open = m.index + m[0].length - 1;
    const args = callArgs(text, open);
    if (args === null) {
      findings.push({
        key: 'sw-put-unparsable:' + puts, ref: 'sw.js',
        notes: ['could not read the arguments of cache.put() #' + puts],
      });
      continue;
    }
    const parts = args.split(',');
    const response = parts.slice(1).join(',').trim();
    if (response.includes('.clone()')) {
      findings.push({
        key: 'sw-clone-after-await:' + puts, ref: 'sw.js',
        notes: [
          'cache.put() argument #' + puts + ' clones the response inline: `' + response.slice(0, 60) + '`',
          'respondWith() has already taken that body by the time this callback runs, so the clone throws',
          'and -- because the promise is fire-and-forget -- the route stores nothing at all',
        ],
      });
      continue;
    }
    if (!/^[A-Za-z_$][\w$]*$/.test(response)) {
      findings.push({
        key: 'sw-put-not-a-clone:' + puts, ref: 'sw.js',
        notes: ['cache.put() argument #' + puts + ' is not a binding, so it is not a clone: `' + response.slice(0, 60) + '`'],
      });
      continue;
    }
    const bound = new RegExp('const\\s+' + response + '\\s*=\\s*[^;]*?\\.clone\\(\\)');
    if (!bound.test(text)) {
      findings.push({
        key: 'sw-put-not-a-clone:' + puts, ref: 'sw.js',
        notes: [
          'cache.put() argument #' + puts + ' (`' + response + '`) is never bound to a .clone()',
          'storing the response the client is also being handed consumes its body',
        ],
      });
    }
  }
  if (puts === 0) {
    findings.push({
      key: 'sw-no-cache-put', ref: 'sw.js',
      notes: ['sw.js never calls cache.put(): the runtime route cannot cache anything'],
    });
  }

  // --- the engine payload must be routed, and must not be precached
  const decl = SW_PAYLOAD_DIRS.exec(text);
  if (!decl) {
    findings.push({
      key: 'sw-payload-undeclared', ref: 'sw.js',
      notes: [
        'no ENGINE_PAYLOAD_DIRS in sw.js',
        'the engine arrives by fetch() with an empty destination, so a route that matches on',
        'destination alone never sees it and it stays outside this cache',
      ],
    });
  } else {
    SW_STRING_LITERAL.lastIndex = 0;
    let d;
    while ((d = SW_STRING_LITERAL.exec(decl[1])) !== null) dirs.push(d[1]);
    if (dirs.length === 0) {
      findings.push({ key: 'sw-payload-empty', ref: 'sw.js', notes: ['ENGINE_PAYLOAD_DIRS lists nothing'] });
    }
    for (const dir of dirs) {
      const full = join(site, dir.split('/').join('\\'));
      let nonEmpty = false;
      try { nonEmpty = statSync(full).isDirectory() && readdirSync(full).length > 0; } catch { nonEmpty = false; }
      if (!nonEmpty) {
        findings.push({
          key: 'sw-payload-dir-missing:' + dir, ref: dir,
          notes: ['declared as engine payload but no non-empty ' + dir + ' in this tree'],
        });
      }
    }
    // Precaching the payload would make every visitor download it before asking
    // to simulate anything -- the reason it lives on the runtime route instead.
    const precached = [];
    SW_SHELL.lastIndex = 0;
    let s;
    while ((s = SW_SHELL.exec(text)) !== null) precached.push(s[1].replace(/^\.\//, ''));
    for (const dir of dirs) {
      const hit = precached.find((p) => p.startsWith(dir));
      if (hit) {
        findings.push({
          key: 'sw-payload-precached:' + dir, ref: hit,
          notes: [
            'shellUrls() precaches ' + hit + ', which is inside the engine payload directory ' + dir,
            'cache.addAll() is atomic, so this also makes the whole install depend on the engine',
          ],
        });
      }
    }
    if (!text.includes(SW_ENGINE_PREDICATE)) {
      findings.push({
        key: 'sw-engine-unrouted', ref: 'sw.js',
        notes: [
          'ENGINE_PAYLOAD_DIRS is declared but the fetch handler never asks ' + SW_ENGINE_PREDICATE,
          'the declaration is inert and the engine is uncached',
        ],
      });
    }
  }

  return {
    status: 'checked',
    findings,
    notes: [puts + ' cache.put() site(s), ' + dirs.length + ' engine payload dir(s)'],
    dirs,
  };
}

/**
 * Render a keyed finding list, separating accepted deviations from live ones.
 *
 * An accepted entry is deliberately still printed. The point of the list is
 * that a known deviation stays visible and attributable -- a suppressed check
 * that stops mentioning what it suppresses is worse than no check.
 */
function render(list, label, hint, accepted) {
  const known = list.filter(accepted);
  const live = list.filter((f) => !accepted(f));
  const lines = [];
  if (known.length > 0) {
    lines.push('  ok  ' + label + ': ' + known.length + ' known deviation(s) accepted');
    for (const f of [...known].sort((a, b) => (a.key < b.key ? -1 : 1))) {
      lines.push('    ' + f.ref + '   <- accepted: ' + f.accepted.reason +
        ' [' + (f.accepted.tracked ?? 'untracked') + ']');
    }
  }
  if (live.length === 0) {
    if (known.length === 0) lines.push('  ok  ' + label + ': none');
    return lines;
  }
  lines.push('  FAIL  ' + label + ' (' + live.length + ')');
  for (const f of [...live].sort((a, b) => (a.key < b.key ? -1 : 1))) {
    lines.push('    ' + f.ref);
    if (hint) lines.push('      ' + hint);
    for (const note of f.notes.slice(0, 8)) lines.push('      at ' + note);
  }
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    return 2;
  }

  // A manifest that was asked for by name and is not there is a usage error, not
  // a quiet "check skipped". Otherwise deleting the manifest would be a way to
  // silence the check that reads it -- the check would print "--" where it used
  // to print "ok", and nothing would fail.
  for (const [flag, p] of [['--outbound', args.outbound], ['--csp', args.csp],
    ['--precache', args.precache], ['--corner', args.corner], ['--import', args.import]]) {
    if (p !== null && !existsSync(p)) {
      console.error(flag + ' was given but the file does not exist: ' + p);
      return 2;
    }
  }

  const site = args.site;
  if (!existsSync(site) || !statSync(site).isDirectory()) {
    console.error('site directory not found: ' + site);
    return 2;
  }

  const base = args.base ?? deriveBase() ?? '/';
  const normalised = base.endsWith('/') ? base : base + '/';

  const out = [];
  const push = (...lines) => out.push(...lines);

  push('artifact guard');
  push('  site = ' + site);
  push('  base = ' + normalised);

  const defaultAccept = join(REPO_ROOT, 'scripts', 'known-deviations.json');
  const acceptPath = args.accept ?? (existsSync(defaultAccept) ? defaultAccept : null);
  let acceptEntries = [];
  if (acceptPath) {
    try {
      acceptEntries = JSON.parse(readFileSync(acceptPath, 'utf8')).accepted ?? [];
    } catch (e) {
      console.error('cannot read accepted-deviations file: ' + e.message);
      return 2;
    }
  }
  push('  accepted = ' + (acceptPath ?? 'none') + ' (' + acceptEntries.length + ' entry)');

  const defaultOutbound = join(REPO_ROOT, 'scripts', 'outbound-manifest.json');
  const outboundPath = args.outbound ?? (existsSync(defaultOutbound) ? defaultOutbound : null);
  push('  outbound = ' + (outboundPath ?? 'none'));

  const defaultCsp = join(REPO_ROOT, 'scripts', 'shell-csp.json');
  const cspPath = args.csp ?? (existsSync(defaultCsp) ? defaultCsp : null);
  push('  csp      = ' + (cspPath ?? 'none'));

  const defaultPrecache = join(REPO_ROOT, 'scripts', 'precache-budget.json');
  const precachePath = args.precache ?? (existsSync(defaultPrecache) ? defaultPrecache : null);
  push('  precache = ' + (precachePath ?? 'none'));

  const defaultCorner = join(REPO_ROOT, 'scripts', 'corner-sweep.json');
  const cornerPath = args.corner ?? (existsSync(defaultCorner) ? defaultCorner : null);
  push('  corner   = ' + (cornerPath ?? 'none'));
  const defaultImport = join(REPO_ROOT, 'scripts', 'import-libs.json');
  const importPath = args.import ?? (existsSync(defaultImport) ? defaultImport : null);
  push('  import   = ' + (importPath ?? 'none'));
  const defaultGallery = join(REPO_ROOT, 'scripts', 'gallery-shim.json');
  const galleryPath = args.gallery ?? (existsSync(defaultGallery) ? defaultGallery : null);
  push('  gallery  = ' + (galleryPath ?? 'none'));
  const defaultMargin = join(REPO_ROOT, 'scripts', 'stability-margin.json');
  const marginPath = args.margin ?? (existsSync(defaultMargin) ? defaultMargin : null);
  push('  margin   = ' + (marginPath ?? 'none'));

  const refs = checkBaseRefs(site, normalised, args.strict);
  push('  scanned ' + refs.scanned + ' text files, ' + (refs.bytes / 1024).toFixed(0) + ' KiB');
  push('');

  // A finding key is what an accepted-deviations entry matches on. Keys are
  // specific (one per reference, one per referencing file) so that accepting
  // one deviation can never mask a different one.
  const keyed = (prefix, map) => [...map.entries()].map(([ref, notes]) => ({
    key: prefix + ref, ref, notes: [...notes].sort(),
  }));
  const escapedList = keyed('escaped:', refs.escaped);
  const missingList = keyed('missing:', refs.missing);
  const externalList = keyed('external:', refs.external);

  const jsx = checkJsxRuntime(site);
  const jsxList = [
    ...jsx.devFiles.map((f) => ({
      key: 'jsx-dev-file:' + f, ref: f,
      notes: ['a production build emits jsx-runtime, not jsx-dev-runtime'],
    })),
    ...[...jsx.referencing.entries()].sort(byKey).map(([rel, counts]) => ({
      key: 'jsx-ref:' + rel, ref: rel,
      notes: ['references jsx-dev-runtime (' + counts.join('+') + ' occurrence)'],
    })),
  ];

  const shell = checkShellAssets(site, precachePath);
  const shellList = [
    ...shell.missing.map((raw) => ({
      key: 'shell-missing:' + raw, ref: raw,
      notes: ['cache.addAll() is atomic: one 404 aborts the whole install'],
    })),
    ...(shell.overBudget
      ? [{
        key: 'precache-budget', ref: 'shellUrls()',
        notes: [
          'the install payload is ' + kib(shell.total) + ' KiB, over the ' +
            kib(shell.budget) + ' KiB budget in ' +
            (precachePath ? slash(precachePath.slice(REPO_ROOT.length + 1)) : '(no budget file)'),
          'cache.addAll() is atomic and runs before the worker serves anything, so ' +
            'every first-time visitor downloads all of it before the editor works offline',
          'largest members: ' + [...shell.sizes]
            .sort((a, b) => b.bytes - a.bytes).slice(0, 3)
            .map((s) => s.raw + ' ' + kib(s.bytes) + ' KiB').join(', '),
        ],
      }]
      : []),
  ];

  const jsxFactory = await checkJsxFactory(site);
  const gate = checkExampleGate(site);
  const jsxSites = checkJsxCallSites(site);
  const egress = checkOutboundEgress(site, outboundPath);
  const storage = checkStorageAccess(site);
  const csp = checkShellCsp(site, cspPath, outboundPath);
  const swcache = checkServiceWorkerCache(site);
  const shellCache = shellCacheState(site);
  const corner = checkCornerSweep(site, cornerPath);
  const importLibs = checkImportLibs(site, importPath);
  const gallery = checkGalleryShim(site, galleryPath);
  const exampleIdentity = checkExampleIdentity(site);
  const margins = checkStabilityMargin(site, marginPath);
  const jsxFactoryList = jsxFactory
    .filter((r) => r.failures.length > 0)
    .map((r) => ({
      key: 'jsx-factory:' + r.rel, ref: r.rel,
      notes: [
        ...r.failures,
        ...(r.missingDeps && r.missingDeps.length
          ? ['unresolved relative import(s): ' + r.missingDeps.join(', ')]
          : []),
      ],
    }));

  // Match every accept entry against the live keys. An entry ending in "*"
  // covers a whole class; an entry that matches nothing becomes a finding of
  // its own, so an acceptance cannot quietly outlive its deviation.
  const matched = new Set();
  const lists = [
    escapedList, missingList, externalList, jsxList, shellList, jsxFactoryList,
    jsxSites.findings, egress.findings, storage.findings, csp.findings,
    swcache.findings, shellCache.findings, corner.findings, importLibs.findings,
    gallery.findings, exampleIdentity.findings, margins.findings,
  ];
  for (const list of lists) {
    for (const f of list) {
      const hit = acceptEntries.find((e) =>
        (e.key.endsWith('*') ? f.key.startsWith(e.key.slice(0, -1)) : e.key === f.key));
      if (hit) {
        f.accepted = hit;
        matched.add(hit.key);
      }
    }
  }
  const stale = acceptEntries
    .filter((e) => !matched.has(e.key))
    .map((e) => ({
      key: 'stale-acceptance:' + e.key, ref: e.key,
      notes: ['nothing in this tree matches it any more -- delete the entry'],
    }));
  const accepted = (f) => f.accepted !== undefined;

  push('1. references escaping the deployed base');
  push('   (the named file exists inside site/, so the request must be missing a base prefix)');
  push(...render(escapedList, 'escaped references',
    'deployed at ' + normalised + '<name>, requested at /<name>', accepted));
  push('');
  push('2. references carrying the base that do not resolve');
  push(...render(missingList, 'unresolvable in-base references', null, accepted));

  if (args.strict) {
    push('');
    push('3. other root-absolute references (strict mode)');
    push(...render(externalList, 'unresolved root-absolute references', null, accepted));
  }

  push('');
  push('4. JSX runtime');
  push(...render(jsxList, 'jsx-dev-runtime findings', null, accepted));

  push('');
  push('5. service-worker shell assets');
  push('   (every URL shellUrls() names exists, and the atomic install payload fits its budget)');
  if (!shell.present) {
    push('  --  no sw.js in this tree');
  } else if (shellList.length === 0) {
    push('  ok  all ' + shell.listed.length + ' precache targets exist; ' +
      kib(shell.total) + ' KiB of ' + (shell.budget === null ? 'an unstated' : kib(shell.budget) + ' KiB') +
      ' budget');
    for (const s of shell.sizes) {
      push('      ' + String(s.bytes).padStart(8) + ' B  ' + s.raw);
    }
  } else {
    push(...render(shellList, 'precache findings', null, accepted));
    for (const s of shell.sizes) {
      push('      ' + String(s.bytes).padStart(8) + ' B  ' + s.raw);
    }
  }

  push('');
  push('6. JSX runtime chunk is executable');
  push('   (imported and called; a jsxDEV of void 0 passes every string test)');
  if (jsxFactory.length === 0) {
    push('  --  no jsx*runtime chunk in this tree');
  } else if (jsxFactoryList.length === 0) {
    push('  ok  ' + jsxFactory.length + ' chunk(s) imported and exercised');
  } else {
    push(...render(jsxFactoryList, 'JSX runtime chunks that do not work', null, accepted));
  }

  push('');
  push('7. example-library unlock gate');
  push('   (the id -> Project resolver is lifted out of the bundle and run)');
  if (gate.status === 'absent') {
    push('  --  no App-*.js chunk in this tree');
  } else if (gate.findings.length === 0) {
    push('  ok  ' + gate.chunks + ' chunk(s): a locked example needs the stored unlock');
  } else {
    push(...render(gate.findings, 'the unlock gate does not hold', null, () => false));
  }

  push('');
  push('8. JSX call sites compiled to (void 0)');
  push('   (a factory folded to undefined; imports and check 6 stay green)');
  if (jsxSites.noAssets) {
    push('  --  no assets/ in this tree');
  } else if (jsxSites.scanned === 0) {
    push('  --  no .js in this tree');
  } else if (jsxSites.findings.length === 0) {
    push('  ok  ' + jsxSites.scanned + ' chunk(s): every call site has its factory');
  } else {
    push(...render(jsxSites.findings, 'uncallable JSX call sites',
      'the first render of the affected branch throws TypeError', accepted));
  }

  push('');
  push('9. outbound egress');
  push('   (every network target in this tree is classified in ' +
    (outboundPath ? slash(outboundPath.slice(REPO_ROOT.length + 1)) : 'no manifest') +
    ', and every declared repair is present)');
  if (egress.status !== 'checked') {
    push('  --  ' + egress.notes.join('; '));
  } else if (egress.findings.length === 0) {
    push('  ok  ' + egress.declared + ' declared target(s), ' + egress.present +
      ' present, none forbidden, every declared repair in place');
    for (const n of egress.notes) push('      ' + n);
  } else {
    push(...render(egress.findings, 'outbound findings', null, accepted));
    for (const n of egress.notes) push('      ' + n);
  }

  push('');
  push('10. storage access resilience');
  push('   (reading localStorage/sessionStorage throws outright when the browser ' +
    'denies storage, so every read needs a try/catch around it)');
  if (storage.scanned === 0) {
    push('  --  no text files in this tree');
  } else if (storage.findings.length === 0) {
    push('  ok  ' + storage.refs + ' storage reference(s) in ' + storage.scanned +
      ' file(s), every one inside a try/catch');
  } else {
    push(...render(storage.findings, 'unguarded storage access',
      'the first render of the affected branch throws and the error boundary ' +
      'replaces the editor', accepted));
  }

  push('');
  push('11. shell Content-Security-Policy');
  push('   (both shell documents must carry the policy, the policy must still be the ' +
    'manifest\'s, every inline script\'s hash is re-derived from the document, and no ' +
    'origin may be named that the outbound manifest does not classify)');
  if (csp.status !== 'checked') {
    push('  --  ' + csp.notes.join('; '));
  } else if (csp.findings.length === 0) {
    push('  ok  ' + csp.documents.length + ' shell document(s) carry an enforced policy');
    for (const n of csp.notes) push('      ' + n);
  } else {
    push(...render(csp.findings, 'shell policy findings', null, accepted));
    for (const n of csp.notes.slice(0, 6)) push('      ' + n);
  }

  push('');
  push('12. service worker cache contract');
  push('   (the response stored by cache.put() must be a clone taken before respondWith() ' +
    'takes the body, and the engine payload -- which arrives by fetch(), with an empty ' +
    'destination -- must be routed on the runtime path rather than precached at install)');
  if (swcache.status !== 'checked') {
    push('  --  ' + swcache.notes.join('; '));
  } else if (swcache.findings.length === 0) {
    push('  ok  ' + swcache.notes.join('; '));
  } else {
    push(...render(swcache.findings, 'service worker cache findings',
      'the worker caches nothing, so offline simulation depends on the browser HTTP cache', accepted));
  }

  push('');
  push('13. shell cache invalidation token');
  push('   (the constant sw.js opens its cache under must describe THIS tree: upstream\'s build ' +
    'derives it from the emitted asset graph, a committed artifact whose repairs keep their ' +
    'filenames has nothing left to derive it from, and the static route is cache-first with no ' +
    'revalidation -- so a stale constant hides every hand-patch from every returning client)');
  if (shellCache.status !== 'checked') {
    push('  --  ' + shellCache.notes.join('; '));
  } else if (shellCache.findings.length === 0) {
    push('  ok  ' + SHELL_CACHE_PREFIX + shellCache.token + ' covers ' + shellCache.files +
      ' file(s) / ' + kib(shellCache.bytes) + ' KiB, ' + shellCache.precache.length +
      ' precache item(s), ' + shellCache.payloadDirs.length + ' payload dir(s)');
    for (const n of shellCache.notes.slice(1)) push('      ' + n);
  } else {
    push(...render(shellCache.findings, 'shell cache findings',
      'a returning client keeps the copy it already has, so the repair never reaches it', accepted));
    for (const n of shellCache.notes.slice(0, 2)) push('      ' + n);
  }

  push('');
  push('14. process corner selection');
  push('   (the profile the panel reads must advertise the corners, the deck emitter must map each of ' +
    'them to a selector, and the model library must answer that selector -- a tree with the controls ' +
    'but not the library offers three corners that all return the typical answer)');
  if (corner.status !== 'checked') {
    push('  --  ' + corner.notes.join('; '));
  } else if (corner.findings.length === 0) {
    push('  ok  ' + corner.corners.length + ' corner(s) ' + JSON.stringify(corner.corners) +
      ' over ' + corner.devices.length + ' device(s), typical=' + JSON.stringify(corner.typical) +
      ', selector emitted for ' + corner.corners.filter((c) => c !== corner.typical).join('/'));
  } else {
    push(...render(corner.findings, 'corner findings',
      'the corner controls exist but do not change the answer', accepted));
  }

  push('');
  push('15. import library reachability');
  push('   (the File menu\'s Import SPICE control is a flat multi-file picker, so a selection cannot ' +
    'express a directory -- the include resolver still has to answer the libraries this build ships. ' +
    'A tree with the control but without the pool refuses .include ../models/<lib>, which is what ' +
    'cap.lib and opamp.lib both instruct their readers to write)');
  if (importLibs.status !== 'checked') {
    push('  --  ' + importLibs.notes.join('; '));
  } else if (importLibs.findings.length === 0) {
    push('  ok  ' + importLibs.libraries.length + ' library(ies) ' +
      JSON.stringify(importLibs.libraries.map((l) => l.name)) + ' reachable from an import, text and hash derived from models/');
  } else {
    push(...render(importLibs.findings, 'import findings',
      'the control exists but an include naming a shipped library cannot be resolved', accepted));
  }

  push('');
  push('16. static gallery shim');
  push('   (the Gallery panel reads four origin-root endpoints that only a server answers, so on a static ' +
    'deploy its fetches fail and the section never renders. A worker registered at scope /spice-simulator/ ' +
    'still observes those requests -- scope decides which clients it controls, not which of their requests ' +
    'it sees -- and scripts/gallery-shim.json routes them to files under <scope>gallery/. A tree with the ' +
    'panel but no route leaves the panel dark; a route defined after the /api/ early return is dark with ' +
    'every one of its strings still present)');
  if (gallery.findings.length > 0) {
    push(...render(gallery.findings, 'gallery findings',
      'the Gallery panel exists but the endpoints it reads stay a 404', accepted));
  } else if (gallery.status !== 'checked') {
    push('  --  ' + gallery.notes.join('; '));
  } else {
    push('  ok  ' + gallery.routes.length + ' route(s) ' + JSON.stringify(gallery.routes) +
      ' answered from ' + JSON.stringify(gallery.assetRoot) + ', id shape-checked before it is joined into a path, ' +
      'answers only (writes no Cache Storage)');
  }

  if (exampleIdentity.findings.length > 0) {
    push('');
    push('17. built-in example identity');
    push(...render(exampleIdentity.findings, 'example identity findings', null, accepted));
  } else if (exampleIdentity.status === 'checked') {
    push('');
    push('17. built-in example identity');
    push('  ok  ' + exampleIdentity.examples.length + ' example(s) carry their own project id/name, ' +
      'none stores the factory placeholder (project-main / New Circuit)');
  } else {
    push('');
    push('17. built-in example identity');
    push('  --  ' + exampleIdentity.notes.join('; '));
  }

  if (stale.length > 0) {
    push('');
    push('18. stability margins');
    push(...render(margins.findings, 'stability margin findings', null, accepted));
  } else {
    push('');
    push('18. stability margins');
    push('   (the evaluator must be CALLED, not merely defined; both metric names must be members of the');
    push('    artifact schema\'s CLOSED metric enum in BOTH variants -- a result file carrying a metric the');
    push('    schema does not enumerate is discarded whole, and the panel then shows no measurements at all;');
    push('    each row must be emitted with its own unit; a refusal must carry its reason; the five');
    push('    properties that make the number correct must hold; the margin must be measured on the same');
    push('    curve the plot draws; and neither AUTHORING table may offer the metrics, because the setup');
    push('    schema\'s method union cannot represent them)');
    if (margins.status === 'checked' && margins.findings.length === 0) {
      push('  ok  ' + margins.metrics.length + ' metric(s) [' +
        margins.metrics.map((m) => m.metric + ' (' + m.unit + ')').join(', ') +
        ']: evaluator called, both schema variants admit them, emitted with their own units, refusal carries its reason, five correctness properties intact, plotted curve unchanged, authoring tables untouched');
    } else {
      push('  --  ' + margins.notes.join('; '));
    }
  }

  if (stale.length > 0) {
    push('');
    push('19. stale accepted deviations');
    push(...render(stale, 'accepted entries that matched nothing', null, () => false));
  }

  const flat = lists.flat();
  const known = flat.filter(accepted).length;
  const findings = flat.filter((f) => !accepted(f)).length + stale.length +
    gate.findings.length;

  push('');
  push('RESULT: ' + (findings === 0 ? 'clean' : findings + ' finding(s)') +
    (known > 0 ? '   (' + known + ' known deviation(s) accepted)' : ''));

  console.log(out.join('\n'));

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({
      site,
      base: normalised,
      scanned: refs.scanned,
      acceptedDeviationsFile: acceptPath,
      escaped: [...refs.escaped].map(([ref, notes]) => ({ ref, at: [...notes] })),
      missing: [...refs.missing].map(([ref, notes]) => ({ ref, at: [...notes] })),
      external: [...refs.external].map(([ref, notes]) => ({ ref, at: [...notes] })),
      jsxDevRuntimeFiles: jsx.devFiles,
      jsxDevRuntimeRefs: [...jsx.referencing].map(([file, counts]) => ({ file, counts })),
      jsxFactoryChunks: jsxFactory.map((r) => ({ chunk: r.rel, failures: r.failures })),
      exampleGate: gate.findings.map((f) => ({ chunk: f.ref, notes: f.notes })),
      jsxVoid0CallSites: jsxSites.findings.map((f) => ({ chunk: f.ref, notes: f.notes })),
      storageUnguarded: storage.findings.map((f) => ({ ref: f.ref, notes: f.notes })),
      shellMissing: shell.missing,
      serviceWorkerShell: {
        budgetBytes: shell.budget,
        totalBytes: shell.total,
        overBudget: shell.overBudget,
        targets: shell.sizes,
        findings: shellList.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
      },
      shellCsp: {
        manifest: cspPath,
        status: csp.status,
        documents: csp.documents,
        findings: csp.findings.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
        notes: csp.notes,
      },
      serviceWorkerCache: {
        status: swcache.status,
        dirs: swcache.dirs,
        findings: swcache.findings.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
        notes: swcache.notes,
      },
      shellCache: {
        status: shellCache.status,
        token: shellCache.token ?? null,
        declared: shellCache.declared ?? null,
        activatePrefix: shellCache.activatePrefix ?? null,
        treeDigest: shellCache.treeDigest ?? null,
        declDigest: shellCache.declDigest ?? null,
        files: shellCache.files ?? 0,
        bytes: shellCache.bytes ?? 0,
        precache: shellCache.precache ?? [],
        payloadDirs: shellCache.payloadDirs ?? [],
        findings: shellCache.findings.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
        notes: shellCache.notes,
      },
      cornerSweep: {
        manifest: cornerPath,
        status: corner.status,
        corners: corner.corners,
        typical: corner.typical,
        devices: corner.devices,
        findings: corner.findings.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
        notes: corner.notes,
      },
      importLibs: {
        manifest: importPath,
        status: importLibs.status,
        libraries: importLibs.libraries,
        findings: importLibs.findings.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
        notes: importLibs.notes,
      },
      galleryShim: {
        manifest: galleryPath,
        status: gallery.status,
        apiPrefix: gallery.apiPrefix ?? null,
        assetRoot: gallery.assetRoot ?? null,
        routes: gallery.routes,
        findings: gallery.findings.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
        notes: gallery.notes,
      },
      exampleIdentity: {
        status: exampleIdentity.status,
        examples: exampleIdentity.examples,
        findings: exampleIdentity.findings.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
        notes: exampleIdentity.notes,
      },
      stabilityMargin: {
        manifest: marginPath,
        status: margins.status,
        metrics: margins.metrics,
        findings: margins.findings.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
        notes: margins.notes,
      },
      outbound: {
        manifest: outboundPath,
        status: egress.status,
        declared: egress.declared,
        present: egress.present,
        findings: egress.findings.map((f) => ({ key: f.key, url: f.ref, notes: f.notes })),
        notes: egress.notes,
      },
      acceptedKeys: [...matched],
      staleAcceptances: stale.map((s) => s.ref),
      findings,
      known,
    }, null, 2), 'utf8');
  }

  return findings === 0 ? 0 : 1;
}

process.exit(await main());
