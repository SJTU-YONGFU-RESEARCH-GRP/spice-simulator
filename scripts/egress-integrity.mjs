#!/usr/bin/env node
/**
 * Runtime proof that the shipped ngspice CDN fallback verifies its payload.
 *
 * check 9 in scripts/check-artifacts.mjs asserts that the repaired *text* is in
 * the artifact. That is a statement about a string, not about behaviour: a
 * repair that is present but non-functional -- a renamed helper, a comparison
 * that never runs, a throw that is caught and ignored upstream -- would satisfy
 * it. This script closes that gap the same way check 6 closes it for the JSX
 * runtime: by lifting the functions out of the shipped chunk and running them.
 *
 * What is asserted, in the artifact's own code:
 *
 *   pin-is-engine   hashing site/vendor/ngspice.js with the chunk's own hash
 *                   helper yields the pinned value. If this ever fails, the
 *                   fallback is dead in a way nothing else notices: the
 *                   self-hosted engine would still work, so the failure would
 *                   only appear for a user whose local asset is missing.
 *   pin-correct     a payload whose hash matches the pin loads and evaluates.
 *   pin-mismatch    a tampered payload throws AND is never evaluated. The
 *                   payload sets a global as a side effect, and the global must
 *                   still be unset afterwards -- refusing to run the code is the
 *                   whole point of the check, and "it threw" alone would not
 *                   prove that.
 *   pin-absent      the self-hosted path passes no pin and must keep working.
 *
 * Nothing is re-implemented: `Rt` and `Dt` are read out of site/assets/ at run
 * time by brace-balanced extraction, given stub URL/Blob/fetch bindings, and
 * imported as a real module. The only stubs are the browser APIs Node lacks
 * (object URLs) and the network.
 *
 * Usage
 *   node scripts/egress-integrity.mjs [--site=<dir>] [--manifest=<file>] [--json=<file>]
 *
 * Exit codes: 0 every assertion held, 1 an assertion failed, 2 usage or IO
 * error, 3 the functions could not be located in the artifact.
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/**
 * The `{...}` span starting at `at`, skipping comments and string literals. A
 * minified chunk is one enormous line, so counting braces by character alone
 * reads a `{` inside a template literal as structure.
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

/** Verbatim source of the single `function <name>(` in this text, header included. */
function functionSpan(text, name) {
  const header = 'function ' + name + '(';
  const at = text.indexOf(header);
  if (at === -1) return { error: 'function ' + name + '() is not in this chunk' };
  if (text.indexOf(header, at + header.length) !== -1) {
    return { error: 'function ' + name + '() appears more than once' };
  }
  // `async` sits before the header, so searching for the header alone drops it
  // -- and a body containing `await` is then a syntax error rather than a
  // function. Both functions this script lifts are async.
  const start = text.slice(Math.max(0, at - 6), at) === 'async ' ? at - 6 : at;
  const brace = text.indexOf('{', at + header.length);
  if (brace === -1) return { error: 'function ' + name + '() has no body' };
  const span = balancedSpan(text, brace);
  if (span.error) return span;
  return { text: text.slice(start, span.end + 1) };
}

function parseArgs(argv) {
  const out = { site: join(REPO_ROOT, 'site'), manifest: join(HERE, 'outbound-manifest.json'), json: null };
  for (const a of argv) {
    if (a.endsWith('=')) return { error: a + ' needs a value' };
    if (a.startsWith('--site=')) out.site = resolve(REPO_ROOT, a.slice('--site='.length));
    else if (a.startsWith('--manifest=')) out.manifest = resolve(REPO_ROOT, a.slice('--manifest='.length));
    else if (a.startsWith('--json=')) out.json = a.slice('--json='.length);
    else return { error: 'unknown argument: ' + a };
  }
  return out;
}

/**
 * Build a module that hosts the extracted functions with the browser APIs Node
 * lacks. Everything is read from `globalThis.__egress`, so one module instance
 * serves every case and the stubs stay outside the code under test.
 */
function harnessSource(hashSrc, loaderSrc, hashName, loaderName) {
  return `const H = () => globalThis.__egress;
const e = (fn) => fn();
const Blob = class { constructor(parts) { H().text = parts.join(''); } };
const URL = {
  createObjectURL: () => H().materialize(H().text),
  revokeObjectURL: () => {},
};
const fetch = async () => ({ ok: true, status: 200, text: async () => H().payload });
${hashSrc}
${loaderSrc}
export { ${hashName}, ${loaderName} };
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    console.error('usage: node scripts/egress-integrity.mjs [--site=<dir>] [--manifest=<file>] [--json=<file>]');
    return 2;
  }
  if (!existsSync(args.site) || !statSync(args.site).isDirectory()) {
    console.error('site directory not found: ' + args.site);
    return 2;
  }
  if (!existsSync(args.manifest)) {
    console.error('manifest not found: ' + args.manifest);
    return 2;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(args.manifest, 'utf8'));
  } catch (e) {
    console.error('cannot read manifest: ' + e.message);
    return 2;
  }

  const repair = (manifest.repairs ?? []).find((r) => r.runtimeProbe);
  if (!repair) {
    console.error('no repair in the manifest declares a runtimeProbe');
    return 2;
  }
  const probe = repair.runtimeProbe;
  const pin = (manifest.targets ?? []).find((t) => t.url === repair.pinFrom)?.integrity?.hex ?? null;
  if (!pin) {
    console.error('repair ' + repair.id + ' has no pin to probe (check pinFrom / integrity.hex)');
    return 2;
  }

  const chunkPath = join(args.site, repair.file);
  if (!existsSync(chunkPath)) {
    console.error('chunk not found: ' + chunkPath);
    return 2;
  }
  const chunk = readFileSync(chunkPath, 'utf8');

  const hashSrc = functionSpan(chunk, probe.hash);
  const loaderSrc = functionSpan(chunk, probe.loader);
  for (const [label, src] of [[probe.hash, hashSrc], [probe.loader, loaderSrc]]) {
    if (src.error) {
      console.error('cannot lift ' + label + '() out of ' + repair.file + ': ' + src.error);
      console.error('the artifact was rebuilt: re-derive the names in scripts/outbound-manifest.json');
      return 3;
    }
  }
  if (!chunk.includes(probe.marker)) {
    console.error('the fail-closed branch is not in ' + repair.file +
      ' (marker not found: ' + probe.marker + ')');
    return 3;
  }

  const work = mkdtempSync(join(tmpdir(), 'egress-integrity-'));
  const modulePath = join(work, 'harness.mjs');
  writeFileSync(modulePath, harnessSource(hashSrc.text, loaderSrc.text, probe.hash, probe.loader), 'utf8');
  console.log('egress integrity probe -- functions lifted from ' + repair.file);
  console.log('  harness = ' + modulePath);
  console.log('');

  const sha256hex = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
  const materialize = (text) => {
    const p = join(work, 'payload-' + sha256hex(text).slice(0, 8) + '.mjs');
    writeFileSync(p, text, 'utf8');
    return pathToFileURL(p).href;
  };

  let api;
  try {
    api = await import(pathToFileURL(modulePath).href);
  } catch (e) {
    console.error('the extracted functions do not compile as a module: ' + e.message);
    console.error('harness: ' + modulePath);
    const src = readFileSync(modulePath, 'utf8');
    src.split('\n').forEach((line, i) => {
      if (i < 6 || i >= src.split('\n').length - 2) console.error('  [' + i + '] ' + line.slice(0, 220));
    });
    return 3;
  }
  const loader = api[probe.loader];
  const hash = api[probe.hash];
  if (typeof loader !== 'function' || typeof hash !== 'function') {
    console.error('the extracted module does not export ' + probe.loader + '() / ' + probe.hash + '()');
    return 3;
  }

  const PWNED = Symbol.for('egress-integrity.pwned');
  const results = [];
  const record = (id, ok, detail) => {
    results.push({ id, ok, detail });
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + id + '  ' + detail);
  };

  // 1. The pin must be the hash of the engine this repository ships, computed by
  //    the artifact's own helper -- otherwise the fallback is silently dead.
  const vendorRel = (manifest.targets ?? [])
    .find((t) => t.url === repair.pinFrom)?.integrity?.mustEqual ?? 'site/vendor/ngspice.js';
  const vendorPath = resolve(REPO_ROOT, vendorRel);
  if (!existsSync(vendorPath)) {
    record('pin-is-engine', false, vendorRel + ' is missing');
  } else {
    const vendor = readFileSync(vendorPath, 'utf8');
    const actual = await hash(vendor);
    record('pin-is-engine', actual === pin,
      actual === pin
        ? 'Rt(vendor) == pinned sha256 (' + actual.slice(0, 16) + '...)'
        : 'Rt(vendor) = ' + actual + ' but the artifact pins ' + pin);
  }

  const call = async (payload, usePin) => {
    globalThis.__egress = { payload, text: null, materialize };
    const target = 'https://cdn.example.invalid/ngspice.js';
    // The loader returns the module's default export, not the namespace: it
    // ends in `.default`, which is how the executor gets the ngspice factory.
    return usePin ? loader(target, pin) : loader(target);
  };

  // 2. A payload that matches the pin must load and evaluate.
  {
    const payload = 'export default "engine-ok";\n';
    const goodPin = sha256hex(payload);
    globalThis.__egress = { payload, text: null, materialize };
    try {
      const got = await loader('https://cdn.example.invalid/ngspice.js', goodPin);
      record('pin-correct', got === 'engine-ok',
        got === 'engine-ok' ? 'the matching payload loaded and evaluated'
          : 'loaded but the default export was ' + JSON.stringify(got));
    } catch (e) {
      record('pin-correct', false, 'the matching payload threw: ' + e.message);
    }
  }

  // 3. A tampered payload must be refused, and above all must not run.
  {
    const payload = 'globalThis[Symbol.for("egress-integrity.pwned")] = true;\nexport default "tampered";\n';
    delete globalThis[PWNED];
    let threw = null;
    try {
      await call(payload, true);
    } catch (e) {
      threw = e;
    }
    const ran = globalThis[PWNED] === true;
    delete globalThis[PWNED];
    const markerOk = typeof threw?.message === 'string' && threw.message.includes(probe.marker);
    record('pin-mismatch', threw !== null && !ran && markerOk,
      threw === null
        ? 'a tampered payload was accepted'
        : ran
          ? 'the tampered payload was executed before the mismatch was raised'
          : markerOk
            ? 'refused with the pinned-hash error, payload never evaluated'
            : 'refused, but not by the expected branch: ' + threw.message);
  }

  // 4. The self-hosted path passes no pin and must be unaffected.
  {
    const payload = 'export default "local-ok";\n';
    try {
      const got = await call(payload, false);
      record('pin-absent', got === 'local-ok',
        got === 'local-ok' ? 'an unpinned load still works' : 'loaded but the default export was ' + JSON.stringify(got));
    } catch (e) {
      record('pin-absent', false, 'the unpinned load threw: ' + e.message);
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log('RESULT: ' + (results.length - failed.length) + '/' + results.length +
    ' assertion(s) held   [functions lifted from ' + repair.file + ']');

  if (args.json) {
    writeFileSync(args.json, JSON.stringify({
      chunk: repair.file,
      pin,
      probe: { loader: probe.loader, hash: probe.hash, marker: probe.marker },
      assertions: results,
      failed: failed.map((f) => f.id),
    }, null, 2), 'utf8');
  }

  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
