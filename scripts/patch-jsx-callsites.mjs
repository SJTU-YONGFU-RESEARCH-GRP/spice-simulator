#!/usr/bin/env node
/**
 * Repair JSX call sites that the bundler emitted as `(void 0)(`.
 *
 * Background (2026-09-19, artifact defect A7).
 * The committed site/ tree ships a development JSX transform. 31 call sites
 * across three chunks came out of it as
 *
 *     (void 0)(T, "div", { ... }, key, isStatic, {fileName, lineNumber}, this)
 *
 * instead of
 *
 *     (0, T.jsxDEV)(T, "div", { ... }, key, isStatic, {fileName, lineNumber}, this)
 *
 * i.e. the factory expression was folded to `undefined` while its arguments
 * were left in place. `(void 0)(...)` is not callable, so the first render of
 * any of those branches throws `TypeError: (void 0) is not a function`. The
 * largest cluster (28 of 31) sits in the simulation surface, which is why
 * pressing Run took the whole application down instead of merely failing a
 * panel.
 *
 * Why a repair script and not a rebuild: the editor source that emits this
 * transform is not public (docs/REPO_LAYOUT.md:17). The real fix is a build
 * config change in that private checkout. Until then this script is the
 * repeatable, reviewable way to produce a working artifact, and
 * scripts/check-artifacts.mjs check 8 fails any tree that still has the
 * defect -- so a future rebuild that regresses cannot pass the guard.
 *
 * Safety rails. Every rewrite is conditional:
 *   1. The factory to restore is *derived from the file itself* -- the
 *      identifier whose `.jsxDEV` the file's other, intact call sites use.
 *      Nothing is hard-coded, so the script cannot paste a factory into a
 *      chunk that never had one. (That identifier is a local binding, not an
 *      import: the runtime chunk exports a factory, `export{n as t}`, and each
 *      chunk does `import{t as e}from"./jsx-dev-runtime-*.js"` then
 *      `var T = e()`. Which is exactly why the bundler could fold it to
 *      `void 0` without breaking a single import statement.)
 *   2. A call site is rewritten only when it provably is a JSX site: the
 *      argument list must carry the dev-transform signature (a
 *      `{fileName: ..., lineNumber: ...}` source object near the tail). A
 *      `(void 0)(` that does not match is left alone AND counted, so a
 *      legitimate occurrence can never be silently rewritten.
 *   3. If no factory can be derived for a file, the file is left untouched and
 *      the run exits 3. Repairing by guesswork is worse than not repairing.
 *
 * Usage
 *   node scripts/patch-jsx-callsites.mjs [--site=<dir>] [--check]
 *
 *   --site=<dir>  Tree to repair. Default: <repo>/site
 *   --check       Report only; write nothing.
 *
 * Exit codes: 0 nothing to repair (or all repaired), 1 findings under --check,
 * 2 usage/IO error, 3 a file needs repair but no factory could be derived.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

// The literal the bundler emitted in place of the factory.
const BROKEN = '(void 0)(';

// Intact dev-transform call sites: `(0, ns.jsxDEV)(` -- and the looser form
// `ns.jsxDEV(` in case a future build drops the comma operator.
const FACTORY = /\b([A-Za-z_$][\w$]*)\.jsxDEV\b/g;

// Dev-transform only: the last argument is a source location object.
const JSX_SHAPE = /\{fileName:\s*[A-Za-z_$][\w$]*\s*,\s*lineNumber:\s*\d+/;

/** Every .js file under root, as absolute paths. */
function jsFiles(root) {
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

/**
 * The identifier a chunk uses for `.jsxDEV` -- the local binding produced by
 * the runtime factory, e.g. `var T = e()`. Taken from the chunk's own intact
 * call sites. Most frequent wins; a tie is a hard error because it means the
 * chunk has two runtimes and we must not pick one for it.
 */
function deriveNamespace(text) {
  const counts = new Map();
  for (const m of text.matchAll(FACTORY)) {
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  if (counts.size === 0) return { ns: null, counts };
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    return { ns: null, counts, ambiguous: ranked.slice(0, 2).map((r) => r[0]) };
  }
  return { ns: ranked[0][0], counts };
}

function scan(text) {
  const hits = [];
  let at = 0;
  for (;;) {
    const i = text.indexOf(BROKEN, at);
    if (i === -1) break;
    const tail = text.slice(i, i + 400);
    hits.push({ at: i, jsx: JSX_SHAPE.test(tail) });
    at = i + BROKEN.length;
  }
  return hits;
}

function main() {
  const argv = process.argv.slice(2);
  let site = join(REPO_ROOT, 'site');
  let check = false;
  for (const a of argv) {
    if (a.startsWith('--site=')) site = a.slice('--site='.length);
    else if (a === '--check') check = true;
    else {
      console.error('unknown argument: ' + a);
      console.error('usage: node scripts/patch-jsx-callsites.mjs [--site=<dir>] [--check]');
      return 2;
    }
  }
  if (!existsSync(site) || !statSync(site).isDirectory()) {
    console.error('site directory not found: ' + site);
    return 2;
  }

  const rel = (p) => p.slice(site.length + 1).split('\\').join('/');
  const lines = ['JSX call-site repair (' + (check ? 'check only' : 'write') + ')', '  site = ' + site, ''];
  let broken = 0;
  let rewritten = 0;
  let nonJsx = 0;
  let unresolved = 0;
  const unresolvedFiles = [];

  for (const p of jsFiles(site)) {
    const text = readFileSync(p, 'utf8');
    const hits = scan(text);
    if (hits.length === 0) continue;
    const jsxHits = hits.filter((h) => h.jsx);
    const others = hits.length - jsxHits.length;
    broken += hits.length;
    nonJsx += others;

    const { ns, counts, ambiguous } = deriveNamespace(text);
    if (jsxHits.length > 0 && !ns) {
      unresolved += jsxHits.length;
      unresolvedFiles.push(rel(p) +
        (ambiguous ? ' (ambiguous factories: ' + ambiguous.join(', ') + ')' : ' (no jsxDEV factory in file)'));
      continue;
    }

    if (!check && jsxHits.length > 0) {
      let out = '';
      let at = 0;
      for (const h of jsxHits) {
        out += text.slice(at, h.at) + `(0,${ns}.jsxDEV)(`;
        at = h.at + BROKEN.length;
      }
      out += text.slice(at);
      writeFileSync(p, out, 'utf8');
    }
    rewritten += jsxHits.length;

    const seen = [...counts.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, v]) => k + '=' + v).join(' ');
    lines.push('  ' + rel(p));
    lines.push('      call sites: ' + hits.length +
      '  jsx-shaped: ' + jsxHits.length +
      '  left alone: ' + others);
    if (jsxHits.length > 0) {
      lines.push('      factory: (0,' + ns + '.jsxDEV)   [' + (seen || 'none') + ']');
    }
  }

  if (broken === 0) {
    lines.push('  ok  no `(void 0)(` call site in this tree');
  }
  for (const f of unresolvedFiles) {
    lines.push('  FAIL ' + f + ': cannot derive the factory, file untouched');
  }

  lines.push('');
  lines.push('RESULT: ' + broken + ' broken call site(s), ' + rewritten +
    ' ' + (check ? 'would be repaired' : 'repaired') + ', ' + nonJsx +
    ' left alone (not jsx-shaped), ' + unresolved +
    ' unresolved' + (check ? '   [--check: nothing written]' : ''));
  console.log(lines.join('\n'));

  if (unresolved > 0) return 3;
  if (check && broken > 0) return 1;
  return 0;
}

process.exit(main());
