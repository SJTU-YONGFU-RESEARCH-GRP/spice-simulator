#!/usr/bin/env node
/**
 * Repair the outbound surface of the committed site/ artifact.
 *
 * Two defects, both in the artifact rather than in a source tree, because the
 * editor sources that produce site/ are not in any public repository
 * (docs/REPO_LAYOUT.md:17). Like scripts/patch-jsx-callsites.mjs, this is the
 * repeatable and reviewable way to produce a correct artifact until that
 * checkout is available, and scripts/check-artifacts.mjs check 9 fails any tree
 * that regresses -- so a rebuild cannot quietly undo it.
 *
 *   1. bug-report-link (B7 / P1-5)
 *      The product's only feedback control prefills a public GitHub issue; its
 *      own label says "Report a bug publicly on GitHub" and its body template
 *      warns the issue will be public. The URL pointed at
 *      SJTU-YONGFU-RESEARCH-GRP/spice-simulator-lab, which is private by design
 *      (docs/REPO_LAYOUT.md), so every anonymous visitor got a 404. Re-pointed
 *      at the public repository that hosts this deploy, whose issues are on.
 *
 *   2. ngspice-cdn-integrity (S4 / P1-3)
 *      The browser executor prefers the self-hosted engine and falls back to
 *      cdn.jsdelivr.net. The fallback fetched a third-party script and executed
 *      it in the application's origin with no integrity check at all: whatever
 *      the CDN returned became code in the page. The pin is the SHA-256 of
 *      site/vendor/ngspice.js, which is byte-identical to what the CDN serves,
 *      so the fallback is now verified against the engine we already ship and
 *      refuses to execute on mismatch. The app's own Rt() helper
 *      (globalThis.crypto.subtle.digest) does the hashing -- no new capability,
 *      and it works in every browser the app targets rather than only where
 *      fetch(url, {integrity}) is honoured.
 *
 * Nothing here is hard-coded into the script: every anchor, replacement and pin
 * value comes from scripts/outbound-manifest.json, so the manifest is the one
 * place to change and the guard re-derives the same facts.
 *
 * Safety rails:
 *   1. Every anchor must occur EXACTLY ONCE in its file. String#replace() is
 *      not global, so a single-occurrence miss would otherwise write a patch
 *      somewhere other than where it was meant to go, or look like it applied
 *      while changing nothing. An ambiguous or absent anchor exits 3.
 *   2. A repair declares `requires`: a string that must already be in the file
 *      for the injected code to work (here, the hashing helper). A tree where
 *      that string is gone is reported, never patched -- injecting a call to a
 *      function that no longer exists would turn a missing check into a
 *      crash-on-fallback.
 *   3. A repair is skipped when its replacement is already present and its
 *      anchor is gone, which makes the script idempotent.
 *   4. After patching, every replacement is re-counted as exactly one. A write
 *      only happens when all of a file's edits are in a consistent state.
 *
 * Usage
 *   node scripts/patch-outbound.mjs [--site=<dir>] [--manifest=<file>] [--check]
 *
 *   --site=<dir>       Tree to repair. Default: <repo>/site
 *   --manifest=<file>  Manifest to read. Default: scripts/outbound-manifest.json
 *   --check            Report only; write nothing.
 *
 * Exit codes: 0 nothing to repair (or all repaired), 1 findings under --check,
 * 2 usage or IO error, 3 an anchor is missing or ambiguous.
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

/** Occurrences of `needle` in `text`. */
function count(text, needle) {
  let n = 0;
  let at = 0;
  for (;;) {
    const i = text.indexOf(needle, at);
    if (i === -1) return n;
    n += 1;
    at = i + needle.length;
  }
}

function parseArgs(argv) {
  const out = {
    site: join(REPO_ROOT, 'site'),
    manifest: join(HERE, 'outbound-manifest.json'),
    check: false,
  };
  for (const a of argv) {
    if (a.endsWith('=')) return { error: a + ' needs a value' };
    if (a.startsWith('--site=')) out.site = resolve(REPO_ROOT, a.slice('--site='.length));
    else if (a.startsWith('--manifest=')) out.manifest = resolve(REPO_ROOT, a.slice('--manifest='.length));
    else if (a === '--check') out.check = true;
    else return { error: 'unknown argument: ' + a };
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(args.error);
    console.error('usage: node scripts/patch-outbound.mjs [--site=<dir>] [--manifest=<file>] [--check]');
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
  const repairs = (manifest.repairs ?? []).map((r) => ({
    ...r,
    // A repair is either one anchor/replacement pair or a list of them; the
    // manifest stays readable and the patcher only has to understand one shape.
    edits: r.edits ?? (r.find !== undefined ? [{ find: r.find, replace: r.replace }] : null),
  }));
  const malformed = repairs.filter((r) => !Array.isArray(r.edits) || r.edits.length === 0);
  if (malformed.length > 0) {
    console.error('manifest repair(s) with no edits: ' + malformed.map((r) => r.id).join(', '));
    return 2;
  }
  const targets = manifest.targets ?? [];

  const lines = [
    'outbound repair (' + (args.check ? 'check only' : 'write') + ')',
    '  site     = ' + args.site,
    '  manifest = ' + args.manifest,
    '',
  ];

  let pending = 0;
  let applied = 0;
  let broken = 0;
  const problems = [];
  const touched = [];

  for (const repair of repairs) {
    const path = join(args.site, repair.file.split('/').join('\\'));
    const label = repair.id + ' [' + repair.file + ']';
    if (!existsSync(path)) {
      problems.push(label + ': file not in this tree');
      broken += 1;
      continue;
    }
    const text = readFileSync(path, 'utf8');

    // The injected code calls into the file's own helpers. If those are gone --
    // a new build renamed them -- the anchors below are stale too, and guessing
    // is worse than stopping.
    if (repair.requires && count(text, repair.requires) === 0) {
      problems.push(label + ': requires "' + repair.requires + '" (the helper the injected ' +
        'code calls), which is not in this file -- anchors must be re-derived from the new build');
      broken += 1;
      continue;
    }

    let pin = null;
    if (repair.pinFrom) {
      const target = targets.find((t) => t.url === repair.pinFrom);
      pin = target?.integrity?.hex ?? null;
      if (pin === null) {
        problems.push(label + ': pinFrom ' + repair.pinFrom + ' has no integrity.hex in the manifest');
        broken += 1;
        continue;
      }
    }

    // Resolve every edit before touching the file, so a file is never left
    // half-patched.
    const resolved = [];
    let unusable = false;
    for (const [i, edit] of repair.edits.entries()) {
      const find = edit.find.split('{PIN}').join(pin ?? '');
      const replace = edit.replace.split('{PIN}').join(pin ?? '');
      const nFind = count(text, find);
      const nReplace = count(text, replace);
      const nReplaceFind = count(replace, find);
      if (nReplace === 1 && nFind === 0) {
        resolved.push({ i, find, replace, state: 'already applied' });
        continue;
      }
      if (nFind === 1) {
        resolved.push({ i, find, replace, state: 'to apply' });
        continue;
      }
      // A replacement that contains its own anchor would keep matching after
      // the write, so the idempotence test above could never be satisfied.
      const note = nFind === 0
        ? 'anchor not found'
        : 'anchor is not unique (' + nFind + ' occurrences)' +
          (nReplaceFind > 0 ? '; note the replacement contains the anchor, so it can never settle' : '');
      problems.push(label + ' edit #' + i + ': ' + note + ' -- ' + JSON.stringify(find.slice(0, 90)) + '...');
      unusable = true;
    }
    if (unusable) {
      broken += 1;
      continue;
    }

    const todo = resolved.filter((r) => r.state === 'to apply');
    if (todo.length === 0) {
      lines.push('  ok  ' + label + ': already applied');
      applied += 1;
      continue;
    }
    pending += todo.length;

    let out = text;
    for (const r of todo) out = out.split(r.find).join(r.replace);
    // Re-count: every replacement must now be exactly one.
    const bad = todo.filter((r) => count(out, r.replace) !== 1);
    if (bad.length > 0) {
      problems.push(label + ': post-condition failed, file left untouched (edit #' +
        bad.map((r) => r.i).join(', #') + ')');
      broken += 1;
      continue;
    }

    lines.push('  ' + label);
    for (const r of resolved) lines.push('      edit #' + r.i + ': ' + r.state);
    lines.push('      why: ' + repair.why);
    if (pin) lines.push('      pin: sha256:' + pin);
    const sha = createHash('sha256').update(Buffer.from(out, 'utf8')).digest('hex');
    lines.push('      new sha256: ' + sha);
    lines.push('      sw.js CACHE value (first 12 hex): ' + sha.slice(0, 12));

    if (args.check) {
      lines.push('      [--check: nothing written]');
    } else {
      writeFileSync(path, out, 'utf8');
      touched.push({ file: repair.file, sha });
    }
    applied += 1;
  }

  for (const p of problems) lines.push('  FAIL ' + p);

  lines.push('');
  lines.push('RESULT: ' + repairs.length + ' repair(s), ' + applied + ' ok, ' +
    pending + ' edit(s) ' + (args.check ? 'pending' : 'written') + ', ' + broken +
    ' unusable' + (args.check ? '   [--check: nothing written]' : ''));
  console.log(lines.join('\n'));

  if (broken > 0) return 3;
  if (args.check && pending > 0) return 1;
  return 0;
}

process.exit(main());
