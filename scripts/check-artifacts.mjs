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
 *   9. (meta)       Accepted deviations that matched nothing. Printed only when
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
  const out = { site: join(REPO_ROOT, 'site'), base: null, strict: false, json: null, accept: null };
  for (const arg of argv) {
    // An empty value would silently resolve to the current directory and scan
    // the wrong tree, which looks like a real finding rather than a typo.
    if (arg.endsWith('=')) return { error: arg + ' needs a value' };
    if (arg.startsWith('--site=')) out.site = resolve(REPO_ROOT, arg.slice('--site='.length));
    else if (arg.startsWith('--base=')) out.base = arg.slice('--base='.length);
    else if (arg === '--strict') out.strict = true;
    else if (arg.startsWith('--accept=')) out.accept = resolve(REPO_ROOT, arg.slice('--accept='.length));
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
  const brace = text.indexOf('{', at + header.length);
  if (brace === -1) return { error: 'function ' + name + '() has no body' };
  const span = balancedSpan(text, brace);
  if (span.error) return span;
  return { text: text.slice(at, span.end + 1), at, end: span.end };
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
    jsxSites.findings,
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

  if (stale.length > 0) {
    push('');
    push('9. stale accepted deviations');
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
      shellMissing: shell.missing,
      acceptedKeys: [...matched],
      staleAcceptances: stale.map((s) => s.ref),
      findings,
      known,
    }, null, 2), 'utf8');
  }

  return findings === 0 ? 0 : 1;
}

process.exit(await main());
