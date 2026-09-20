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
 *  12. (meta)       Accepted deviations that matched nothing. Printed only when
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

function parseArgs(argv) {
  const out = {
    site: join(REPO_ROOT, 'site'), base: null, strict: false, json: null, accept: null,
    outbound: null, csp: null,
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

/** Check 5: every URL the service worker precaches must exist. */
function checkShellAssets(site) {
  const swPath = join(site, 'sw.js');
  if (!existsSync(swPath)) return { present: false, missing: [], listed: [] };

  const text = readFileSync(swPath, 'utf8');
  const listed = [];
  SW_SHELL.lastIndex = 0;
  let m;
  while ((m = SW_SHELL.exec(text)) !== null) {
    listed.push(m[1]);
  }

  const missing = [];
  for (const raw of listed) {
    const target = raw === './' ? 'index.html' : raw;
    if (!existsSync(join(site, target.split('/').join('\\')))) missing.push(raw);
  }
  return { present: true, missing, listed };
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
  for (const [flag, p] of [['--outbound', args.outbound], ['--csp', args.csp]]) {
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

  const shell = checkShellAssets(site);
  const shellList = shell.missing.map((raw) => ({
    key: 'shell-missing:' + raw, ref: raw,
    notes: ['cache.addAll() is atomic: one 404 aborts the whole install'],
  }));

  const jsxFactory = await checkJsxFactory(site);
  const gate = checkExampleGate(site);
  const jsxSites = checkJsxCallSites(site);
  const egress = checkOutboundEgress(site, outboundPath);
  const storage = checkStorageAccess(site);
  const csp = checkShellCsp(site, cspPath, outboundPath);
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
  if (!shell.present) {
    push('  --  no sw.js in this tree');
  } else if (shellList.length === 0) {
    push('  ok  all ' + shell.listed.length + ' precache targets exist');
  } else {
    push(...render(shellList, 'precache targets missing', null, accepted));
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

  if (stale.length > 0) {
    push('');
    push('12. stale accepted deviations');
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
      shellCsp: {
        manifest: cspPath,
        status: csp.status,
        documents: csp.documents,
        findings: csp.findings.map((f) => ({ key: f.key, ref: f.ref, notes: f.notes })),
        notes: csp.notes,
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
