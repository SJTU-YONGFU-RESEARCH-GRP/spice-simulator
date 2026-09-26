#!/usr/bin/env node
/**
 * Prove that check 16 (and the browser harness) are not vacuous.
 *
 * check 16 claims a stack of specific things about the gallery shim: both
 * insertions are present, the dispatch is WIRED rather than merely defined, the
 * dispatch sits before the /api/ early return that would otherwise swallow it,
 * an entry id is shape-checked before it becomes a path segment, the shim never
 * writes Cache Storage, and the JSON it emits still carries the keys the shipped
 * client reads. A guard like that can be green for reasons that have nothing to
 * do with the artifact being right -- a scope that misses the file, a `find` that
 * stopped matching so the loop body never ran, a value compared against itself.
 * The only way to tell a working guard from a lucky one is to break the thing it
 * guards, one way at a time, and require it to say the specific thing it is
 * supposed to say.
 *
 * Two of the cases are controls in the other direction:
 *
 *   control          an unmutated patched copy must produce NO finding and pass
 *                    BOTH browser cases, or the mutant results below mean
 *                    nothing;
 *   unpatched-tree   a copy with the manifest reversed, so the feature is absent
 *                    entirely, must fail -- this is the case that rules out a
 *                    check that would also pass on a tree that never had the
 *                    shim. It is built here rather than read from site/, which
 *                    ships patched.
 *
 * The mutants, and the reason each was chosen:
 *
 *   dispatch-removed      the route is gone. The blunt case: the four endpoints
 *                         are 404s again and the panel is dark.
 *   route-after-api-return  THE case this check exists for. Every string the
 *                         shim consists of is still present exactly once -- a
 *                         text search finds a perfectly healthy shim -- while the
 *                         dispatch now sits behind `if (isSameOriginApi(...))
 *                         return;`, which returns for every /api/ path. Defined
 *                         but unreachable. Nothing but an ordered assertion (or
 *                         a browser) can see it.
 *   list-key-renamed      the shim stops writing `entries` while still emitting
 *                         `total`. Only the populated tree goes red: on the
 *                         shipped tree the panel is dark by design, so nothing
 *                         observable changes there, and a mutant that took both
 *                         cases down would not tell that apart from a shim that
 *                         broke outright.
 *   preview-root-renamed  only the card image path moves. The list, the facets
 *                         and the click-through all still work; only the image
 *                         404s -- which is exactly the half a list-only test
 *                         misses.
 *   id-guard-in-path      the path parameter stops being shape-checked. Static
 *                         only, and declared as such: no fixture asks for an id
 *                         with a slash in it, so neither browser case can
 *                         observe this rule. The static assertion is its
 *                         control; the browser is honest about not covering it.
 *   shim-touches-cache    a Cache Storage access appears in the region that must
 *                         only answer. Static only, for the same reason.
 *   manifest-drops-key    the manifest under-declares a key the client reads.
 *                         The drift assertion has to work in this direction too.
 *   manifest-vacuous      a manifest with no contract would let every rule pass
 *                         silently while verifying nothing.
 *
 * Mutations are anchored on the bytes the patcher writes, and every anchor must
 * occur exactly `count` times -- a mutation that silently matched nothing would
 * turn into a case that "passes" because nothing changed.
 *
 * `exact` cases declare the COMPLETE set of finding keys their mutation must
 * produce, so a surgical mutation that tripped three unrelated rules fails here
 * too: a check that fires on everything is as useless as one that fires on
 * nothing. `unpatched-tree` asserts a subset plus `absent`, because "the feature
 * is absent" legitimately trips most of the check and the point there is which
 * keys must NOT appear.
 *
 * Usage
 *   node scripts/gallery-shim.negctl.mjs [--only=<id,...>] [--static-only]
 *                                        [--require] [--keep] [--json=<file>]
 *
 *   --static-only  Run check 16 against each mutant and skip the browser. This
 *                  is the CI-fast gate: it catches a repair that has been undone
 *                  or fenced away. The runtime half is what catches a shim whose
 *                  bytes are right and whose behaviour is not.
 *
 * Exit codes: 0 every case behaved, 1 a case did not, 2 setup error.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const SITE = join(REPO_ROOT, 'site');
const GUARD = join(HERE, 'check-artifacts.mjs');
const HARNESS = join(HERE, 'gallery-shim.mjs');
const MANIFEST = join(HERE, 'gallery-shim.json');
const RESULT = join(REPO_ROOT, 'gallery-shim-result.json');

const argv = process.argv.slice(2);
const has = (n) => argv.some((a) => a === '--' + n);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith('--' + n + '='));
  return hit ? hit.slice(n.length + 3) : d;
};
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const STATIC_ONLY = has('static-only');
const REQUIRE = has('require');
const KEEP = has('keep');
const JSON_OUT = opt('json', null);

// The bytes the patcher writes, quoted once so every mutation below reads as a
// statement about the artifact rather than as a pile of escapes.
const DISPATCH =
  '  if (isGalleryApi(event.request)) {\n' +
  '    event.respondWith(galleryApiResponse(event.request));\n' +
  '    return;\n' +
  '  }\n\n';
const API_RETURN = '  if (isSameOriginApi(event.request)) return;';
const ENTRY_EMIT = '        entries: list.map(galleryEntryView),';
const PREVIEW_URL = '"gallery/" + id + "/preview.svg"';
const ID_GUARD = 'if (!match || !GALLERY_ID.test(match[1])) {';
const HANDLER_HEAD = 'function galleryApiResponse(request) {\n  const url = new URL(request.url);';

const CASES = [
  {
    id: 'control',
    why: 'an unmutated patched tree must be clean and pass both browser cases, or nothing below is evidence',
    edits: [],
    exact: [],
    runtime: { red: [], green: ['shipped', 'fixture'] },
  },
  {
    id: 'unpatched-tree',
    why: 'the tree with the manifest reversed, where the shim does not exist at all',
    unpatched: true,
    expect: [
      'gallery-shim-marker:helpers', 'gallery-shim-marker:dispatch', 'gallery-shim-not-routed',
      'gallery-shim-id-guard-drift', 'gallery-shim-id-unguarded', 'gallery-shim-asset-path',
      'gallery-shim-contract-drift:preview.svg',
      'gallery-shim-shape-missing:entries', 'gallery-shim-shape-missing:nextCursor',
      'gallery-shim-shape-missing:total', 'gallery-shim-shape-missing:tags',
      'gallery-shim-shape-missing:projectText', 'gallery-shim-shape-missing:entry',
      'gallery-shim-shape-missing:ownerUserId',
    ],
    absent: [
      'gallery-shim-not-answering', 'gallery-shim-handler-missing', 'gallery-shim-route-after-api-return',
      'gallery-shim-caches', 'gallery-shim-contract-vacuous',
    ],
    runtime: null,  // observable behaviour is identical to dispatch-removed; not worth a second browser run
  },
  {
    id: 'dispatch-removed',
    why: 'the route is gone, so all four endpoints are 404s again and the panel is dark',
    edits: [['sw.js', DISPATCH, '']],
    exact: ['gallery-shim-marker:dispatch', 'gallery-shim-not-routed'],
    runtime: { red: ['shipped', 'fixture'], green: [] },
  },
  {
    id: 'route-after-api-return',
    why: 'every string is present and the dispatch now sits behind the /api/ early return -- defined, wired to respondWith, and unreachable',
    edits: [['sw.js', DISPATCH + API_RETURN, API_RETURN + '\n\n' + DISPATCH.trimEnd()]],
    exact: ['gallery-shim-route-after-api-return'],
    runtime: { red: ['shipped', 'fixture'], green: [] },
  },
  {
    id: 'list-key-renamed',
    why: 'the list stops emitting `entries` while still reporting `total`, so only a populated tree can notice',
    edits: [['sw.js', ENTRY_EMIT, ENTRY_EMIT.replace('entries:', 'items:')]],
    exact: ['gallery-shim-shape-missing:entries'],
    runtime: { red: ['fixture'], green: ['shipped'] },
  },
  {
    id: 'preview-root-renamed',
    why: 'only the card image path moves; the list, the facets and the click-through all keep working',
    edits: [['sw.js', PREVIEW_URL, PREVIEW_URL.replace('"gallery/"', '"gallery-assets/"')]],
    exact: ['gallery-shim-asset-path'],
    runtime: { red: ['fixture'], green: ['shipped'] },
  },
  {
    id: 'id-guard-in-path',
    why: 'the path parameter stops being shape-checked, so an id of `../..` would be joined into a URL',
    edits: [['sw.js', ID_GUARD, 'if (!match) {']],
    exact: ['gallery-shim-id-unguarded'],
    runtime: null,  // declared: no fixture supplies a hostile id, so neither browser case observes this rule
  },
  {
    id: 'shim-touches-cache',
    why: 'a Cache Storage access appears in the region that must only answer',
    edits: [['sw.js', HANDLER_HEAD,
      'function galleryApiResponse(request) {\n' +
      '  void caches.open("gallery-shim").then((c) => c.put(new URL("gallery/index.json", scopeUrl()).toString(), new Response("{}")));\n' +
      '  const url = new URL(request.url);']],
    exact: ['gallery-shim-caches'],
    runtime: null,  // declared: the check is about a containment invariant, not about something a fixture can see
  },
  {
    id: 'manifest-drops-key',
    why: 'the manifest under-declares a key the shipped client reads, so the comparison has to work in this direction too',
    manifest: [['      "entries",\n', '']],
    exact: ['gallery-shim-contract-drift:entries'],
    runtime: null,  // the artifact is untouched; only the manifest moved
  },
  {
    id: 'manifest-vacuous',
    why: 'a manifest with no contract would let every rule below pass silently while verifying nothing',
    manifest: [['"contract": {', '"contractX": {']],
    exact: ['gallery-shim-contract-vacuous'],
    runtime: null,
  },
];

// --- setup ------------------------------------------------------------------
const die = (msg) => { console.error('gallery-shim.negctl: ' + msg); process.exit(2); };
if (!existsSync(MANIFEST)) die('missing ' + MANIFEST);
if (!existsSync(GUARD)) die('missing ' + GUARD);
if (!existsSync(join(SITE, 'sw.js'))) die('not a patched site tree: ' + SITE);

const work = mkdtempSync(join(tmpdir(), 'gallery-negctl-'));
const copy = join(work, 'site');
console.log('gallery-shim.negctl: building a copy of the patched tree in ' + copy);
try {
  cpSync(SITE, copy, { recursive: true });
} catch (e) {
  die('cannot copy the artifact: ' + e.message);
}

// The manifest and the committed tree must agree, or every case below is testing
// a tree this script only assumes is patched. Both repairs here are INSERTIONS,
// so the anchor is deliberately kept: `replace` ends with `find` and patchedness
// is "the replace is present exactly once, and the marker it declares is present
// exactly once". (Asserting "find occurs 0 times" would be asserting the wrong
// shape -- it is true only for a substitution, and it is what a substitution
// patch's own manifest declares through `replace` consuming `find`.)
let manifestText;
try { manifestText = readFileSync(MANIFEST, 'utf8'); }
catch (e) { die('cannot read the manifest: ' + e.message); }
let manifestJson;
try { manifestJson = JSON.parse(manifestText); }
catch (e) { die('cannot parse the manifest: ' + e.message); }

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

let editsChecked = 0;
for (const repair of manifestJson.repairs ?? []) {
  const path = join(copy, repair.file);
  if (!existsSync(path)) die('the manifest names ' + repair.file + ', which the tree does not have');
  const text = readFileSync(path, 'utf8');
  for (const [i, edit] of (repair.edits ?? []).entries()) {
    const seenReplace = count(text, edit.replace);
    if (seenReplace !== 1) {
      die('the tree does not look patched for ' + repair.id + ' edit #' + i + ': its `replace` occurs ' +
        seenReplace + ' time(s), expected 1. Re-run the patcher, or the cases below are not about a patched tree.');
    }
    if (repair.marker) {
      const seenMarker = count(text, repair.marker);
      if (seenMarker !== 1) {
        die('the tree does not look patched for ' + repair.id + ': its marker ' +
          JSON.stringify(repair.marker) + ' occurs ' + seenMarker + ' time(s), expected 1');
      }
      if (!edit.replace.includes(edit.find)) {
        die(repair.id + ' is not the insertion shape this driver assumes: its `replace` does not contain its `find`');
      }
    } else if (count(text, edit.find) !== 0) {
      die('the tree does not look patched for ' + repair.id + ' edit #' + i +
        ': a substitution should have consumed its `find`, which still occurs');
    }
    editsChecked += 1;
  }
}
console.log('gallery-shim.negctl: the manifest and the tree agree (' + editsChecked + ' edit(s) applied)');

// The unpatched tree is materialised by reversing the manifest -- each edit's
// `replace` swapped back to its `find`. The count is asserted: a reverse that
// matched nothing would leave the case testing a patched tree again, which is
// exactly the silent failure this construction exists to remove.
const UNPATCHED = join(work, 'unpatched-site');
{
  try { cpSync(copy, UNPATCHED, { recursive: true }); }
  catch (e) { die('cannot copy for the unpatched tree: ' + e.message); }
  let reversed = 0;
  for (const repair of manifestJson.repairs ?? []) {
    const path = join(UNPATCHED, repair.file);
    let text = readFileSync(path, 'utf8');
    for (const [i, edit] of (repair.edits ?? []).entries()) {
      const seen = count(text, edit.replace);
      if (seen !== 1) {
        die('cannot reverse ' + repair.id + ' edit #' + i + ': the patched form occurs ' +
          seen + ' time(s), so the unpatched tree is not what this case assumes');
      }
      text = text.split(edit.replace).join(edit.find);
      reversed += 1;
    }
    writeFileSync(path, text, 'utf8');
  }
  console.log('gallery-shim.negctl: unpatched tree built by reversing ' + reversed + ' edit(s)');
}

// --- the static channel -----------------------------------------------------
/** check 16's finding keys for a given tree and manifest. */
function staticFindings(siteDir, manifestPath, tag) {
  const out = join(work, 'guard-' + tag + '.json');
  try {
    execFileSync(process.execPath,
      [GUARD, '--site=' + siteDir, '--gallery=' + manifestPath, '--json=' + out],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  } catch { /* findings make the guard exit 1, which is the ordinary case here */ }
  if (!existsSync(out)) return { error: 'the guard wrote no json' };
  let blob;
  try { blob = JSON.parse(readFileSync(out, 'utf8')); }
  catch (e) { return { error: 'unreadable guard json: ' + e.message }; }
  rmSync(out, { force: true });
  const section = blob.galleryShim;
  if (!section) return { error: 'the guard reported no galleryShim section' };
  return { status: section.status, keys: (section.findings ?? []).map((f) => f.key) };
}

// --- the runtime channel ----------------------------------------------------
/** Which of the two browser cases came out how, and whether they got that far. */
function runtimeOutcome(treeDir, tag) {
  const args = [HARNESS, '--site=' + treeDir];
  if (REQUIRE) args.push('--require');
  let out = '';
  try {
    out = execFileSync(process.execPath, args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 });
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '');
  }
  if (/SKIP \(no browser/.test(out) || /no Chrome\/Edge found/.test(out)) {
    return { skipped: true, out };
  }
  if (!existsSync(RESULT)) return { error: 'the harness wrote no result file', out };
  let json;
  try { json = JSON.parse(readFileSync(RESULT, 'utf8')); }
  catch (e) { return { error: 'unreadable harness result: ' + e.message, out }; }
  const cases = new Map((json.cases ?? []).map((c) => [c.id, c]));
  if (cases.size !== 2) return { error: 'the harness reported ' + cases.size + ' case(s), expected 2', out };
  return { cases, out };
}

// --- run --------------------------------------------------------------------
const results = [];
let bad = 0;
let runtimeSkipped = false;

for (const c of CASES) {
  if (ONLY.length && !ONLY.includes(c.id)) continue;
  const saved = new Map();
  let manifestBase = null;
  // Only ever restore inside the copy. A key that is not a path under it is a
  // sentinel that leaked into a path->text map, and writing it would drop a file
  // in the repository root under a nonsense name.
  const restore = () => {
    for (const [p, t] of saved) {
      if (!p.startsWith(copy)) continue;
      try { writeFileSync(p, t, 'utf8'); } catch {}
    }
  };
  let setup = null;
  let manifestPath = MANIFEST;
  try {
    for (const [file, find, replace, n] of c.edits ?? []) {
      const path = join(copy, file);
      const text = readFileSync(path, 'utf8');
      const seen = count(text, find);
      if (seen !== (n ?? 1)) {
        setup = 'anchor for ' + file + ' occurs ' + seen + ' time(s), expected ' + (n ?? 1) +
          ': ' + JSON.stringify(find.slice(0, 80));
        break;
      }
      saved.set(path, text);
      writeFileSync(path, text.split(find).join(replace), 'utf8');
    }
    if (setup === null) {
      // The manifest text is held in `manifestBase`, not smuggled into `saved`:
      // `saved` is a path -> text map and its restore loop writes every entry
      // back to disk, so a sentinel key in there lands as a file literally named
      // `__manifest__` in the repository root. (It did, once.)
      for (const [find, replace] of c.manifest ?? []) {
        const text = manifestBase ?? readFileSync(MANIFEST, 'utf8');
        manifestBase = text;
        const seen = count(text, find);
        if (seen !== 1) { setup = 'manifest anchor occurs ' + seen + ' time(s): ' + JSON.stringify(find); break; }
        const path = join(work, 'manifest-' + c.id + '.json');
        writeFileSync(path, text.split(find).join(replace), 'utf8');
        manifestPath = path;
      }
    }
    if (setup !== null) throw new Error(setup);

    // The mutation must actually have changed the tree, or this case would
    // "pass" because nothing was mutated.
    if ((c.edits ?? []).length) {
      const path = join(copy, (c.edits[0][0]));
      const after = readFileSync(path, 'utf8');
      if (after === saved.get(path)) throw new Error('the mutation changed nothing');
    }

    const site = c.unpatched ? UNPATCHED : copy;
    const got = staticFindings(site, manifestPath, c.id);
    if (got.error) throw new Error(got.error);

    const uniq = [...new Set(got.keys)].sort();
    let staticOk;
    if (c.exact) {
      const want = [...new Set(c.exact)].sort();
      const missing = want.filter((k) => !uniq.includes(k));
      const extra = uniq.filter((k) => !want.includes(k));
      staticOk = missing.length === 0 && extra.length === 0;
      if (!staticOk) {
        if (missing.length) console.log('        check 16 expected but absent: ' + JSON.stringify(missing));
        if (extra.length) console.log('        check 16 fired for an unrelated reason: ' + JSON.stringify(extra));
      }
    } else {
      const missing = (c.expect ?? []).filter((k) => !uniq.includes(k));
      const present = (c.absent ?? []).filter((k) => uniq.includes(k));
      staticOk = missing.length === 0 && present.length === 0;
      if (!staticOk) {
        if (missing.length) console.log('        check 16 expected but absent: ' + JSON.stringify(missing));
        if (present.length) console.log('        check 16 must not fire: ' + JSON.stringify(present));
      }
    }

    // --- the runtime half ---
    let runtimeOk = true;
    let runtimeNote = 'n/a';
    if (STATIC_ONLY) {
      runtimeNote = 'skipped (--static-only)';
    } else if (c.runtime === null) {
      runtimeNote = 'declared n/a';
    } else {
      const run = runtimeOutcome(site, c.id);
      if (run.skipped) {
        if (REQUIRE) throw new Error('no browser and --require was set');
        runtimeSkipped = true;
        runtimeNote = 'skipped (no browser)';
      } else if (run.error) {
        throw new Error('runtime: ' + run.error);
      } else {
        const wrongRed = (c.runtime.red ?? []).filter((id) => run.cases.get(id)?.ok !== false);
        const wrongGreen = (c.runtime.green ?? []).filter((id) => run.cases.get(id)?.ok !== true);
        // A case that dies in setup (no worker, no panel) also reports ok=false.
        // Requiring the panel to have opened separates "the shim was wrong" from
        // "the harness never got as far as the shim".
        const bailed = (c.runtime.red ?? []).filter((id) => !run.cases.get(id)?.panel);
        runtimeOk = wrongRed.length === 0 && wrongGreen.length === 0 && bailed.length === 0;
        if (wrongRed.length) console.log('        browser: expected these cases to fail, they did not: ' + JSON.stringify(wrongRed));
        if (wrongGreen.length) console.log('        browser: expected these cases to pass, they did not: ' + JSON.stringify(wrongGreen));
        if (bailed.length) console.log('        browser: these cases went red before reaching the panel: ' + JSON.stringify(bailed));
        runtimeNote = 'red=' + JSON.stringify(c.runtime.red ?? []) + ' green=' + JSON.stringify(c.runtime.green ?? []);
      }
    }

    const ok = staticOk && runtimeOk;
    if (!ok) bad += 1;
    results.push({
      id: c.id, why: c.why, ok, staticOk, runtimeOk,
      keys: uniq, exact: c.exact ?? null, expect: c.expect ?? null, absent: c.absent ?? null,
      status: got.status, runtime: runtimeNote,
    });
    console.log('  ' + (ok ? 'ok  ' : 'BAD ') + c.id.padEnd(22) + 'static=' + JSON.stringify(uniq) +
      (runtimeNote === 'n/a' ? '' : '  runtime{' + runtimeNote + '}'));
  } catch (e) {
    bad += 1;
    results.push({ id: c.id, why: c.why, ok: false, setup: String((e && e.message) || e) });
    console.log('  BAD ' + c.id.padEnd(22) + 'SETUP ERROR: ' + String((e && e.message) || e));
  } finally {
    restore();
  }
}

if (JSON_OUT) {
  writeFileSync(resolve(REPO_ROOT, JSON_OUT), JSON.stringify({
    copy, only: ONLY, staticOnly: STATIC_ONLY, results, failures: bad,
  }, null, 2), 'utf8');
}

if (runtimeSkipped) {
  console.log('gallery-shim.negctl: NOTE -- the browser half was skipped (no Chrome/Edge on this host); ' +
    'the static half ran in full');
}

if (!KEEP) {
  try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); } catch {}
} else {
  console.log('gallery-shim.negctl: kept ' + work);
}

const ran = results.length;
console.log('gallery-shim.negctl: ' + (ran - bad) + '/' + ran + ' case(s) behaved');
if (bad > 0) {
  console.log('gallery-shim.negctl: FAIL -- at least one mutation was not caught for its own stated reason');
  process.exit(1);
}
if (ran === 0) {
  console.log('gallery-shim.negctl: FAIL -- no case ran');
  process.exit(2);
}
console.log('gallery-shim.negctl: PASS');
process.exit(0);
