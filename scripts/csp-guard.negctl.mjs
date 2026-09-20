#!/usr/bin/env node
/**
 * Negative control for the shell Content-Security-Policy (S5).
 *
 * scripts/check-artifacts.mjs check 11 makes four kinds of claim, and a claim
 * nobody has tried to falsify is not evidence. So each one is handed a tree that
 * violates exactly that claim, built by copying the REAL artifact and changing
 * one thing -- which matters most for the inline-script rule, because its whole
 * point is re-deriving a hash from the committed bytes:
 *
 *   presence      a document that carries no policy            -> csp-missing
 *   agreement     a policy edited by hand in the artifact      -> csp-drift
 *                 two shells with two different policies       -> csp-inconsistent
 *   shape         'unsafe-eval' / 'unsafe-inline' in script-src,
 *                 a scheme-wide source in style-src            -> csp-source-forbidden
 *                 a directive dropped outright                -> csp-directive-missing
 *                 an empty shellDocuments list                -> csp-vacuous
 *   derivation    the inline script edited without updating
 *                 the policy (the hash must be recomputed)    -> csp-inline-unhashed
 *   allowlist     an origin in script-src that the outbound
 *                 manifest does not classify                  -> csp-unclassified-origin
 *
 * The 'shape' cases keep the artifact and the manifest in step, so that ONLY the
 * shape rule can fire -- otherwise csp-drift would mask whether the rule under
 * test works at all. The 'agreement' cases do the opposite on purpose.
 *
 * Assertions are read out of the guard's --json output rather than its prose, so
 * a reworded message cannot make a mutant look caught. Every case must produce
 * its expected key; the control case must produce none.
 *
 * Nothing here writes to site/ or to any tracked file: the tree is a throwaway
 * copy under the system temp directory and the manifests are written beside it.
 *
 * Usage
 *   node scripts/csp-guard.negctl.mjs [--json=<file>]
 *
 * Exit codes: 0 every case behaved as required, 1 a mutant survived, 2 usage or
 * IO error.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');
const CHECK = join(HERE, 'check-artifacts.mjs');
const SITE = join(REPO_ROOT, 'site');
const MANIFEST = join(HERE, 'shell-csp.json');
const ACCEPT = join(HERE, 'known-deviations.json');

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith('--' + name + '='));
  return hit === undefined ? fallback : hit.slice(name.length + 3);
};
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/csp-guard.negctl.mjs [--json=<file>]');
  process.exit(0);
}

for (const [label, p] of [['site', SITE], ['manifest', MANIFEST]]) {
  if (!existsSync(p)) {
    console.error('csp-guard.negctl: ' + label + ' not found: ' + p);
    process.exit(2);
  }
}

const base = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const DOCS = ['index.html', '404.html'];
const pristine = {};
for (const f of DOCS) pristine[f] = readFileSync(join(SITE, f), 'utf8');

const CSP_META = /<meta\s+http-equiv=(["'])Content-Security-Policy\1\s+content=(["'])([\s\S]*?)\2\s*\/?>/i;
const META_TAG = (policy) =>
  '<meta http-equiv="Content-Security-Policy" content="' + policy + '" />';
const policyOf = (html) => CSP_META.exec(html)?.[3] ?? null;
/** Replace the policy in a document, refusing to no-op. */
const setPolicy = (html, next) => {
  if (!CSP_META.test(html)) throw new Error('no policy in this document to replace');
  return html.replace(CSP_META, META_TAG(next));
};
/** Rewrite one directive's source list, refusing to no-op. */
const withDirective = (policy, name, sources) => {
  const bits = policy.split(';').map((s) => s.trim()).filter(Boolean);
  let hit = false;
  const next = bits.map((b) => {
    const [head, ...rest] = b.split(/\s+/);
    if (head !== name) return b;
    hit = true;
    return [head, ...(sources === null ? rest.filter((s) => s !== '') : sources)].join(' ');
  });
  if (!hit) throw new Error('directive ' + name + ' not present, so this case would test nothing');
  return next.join('; ');
};
/** The sources of one directive, so a case can ADD one rather than guess them. */
const sourcesOf = (policy, name) => {
  const bit = policy.split(';').map((s) => s.trim()).find((b) => b.startsWith(name + ' '));
  return bit === undefined ? null : bit.split(/\s+/).slice(1);
};

const tree = mkdtempSync(join(tmpdir(), 'csp-negctl-'));
const manifestPath = join(tree, 'shell-csp.scratch.json');
const jsonPath = join(tree, 'guard.json');
cpSync(SITE, tree, { recursive: true });

/**
 * Run the guard over the scratch tree.
 *
 * @param {{mutate?: (name: string, html: string) => string|null, manifest?: object}} spec
 *        `mutate` returns replacement HTML, or null to leave the document alone.
 */
function runGuard(spec) {
  for (const f of DOCS) {
    const html = spec.mutate ? spec.mutate(f, pristine[f]) : null;
    writeFileSync(join(tree, f), html ?? pristine[f], 'utf8');
  }
  for (const f of spec.remove ?? []) rmSync(join(tree, f), { force: true });
  writeFileSync(manifestPath, JSON.stringify(spec.manifest ?? base, null, 2), 'utf8');
  // Remove last case's report first. Reading a path that the guard may not have
  // written would hand back the PREVIOUS case's findings, and a stale finding
  // list looks exactly like a caught mutant -- which is how five cases passed
  // silently the first time this ran.
  try { rmSync(jsonPath, { force: true }); } catch { /* fine */ }
  const r = spawnSync(process.execPath, [
    CHECK, '--site=' + tree, '--accept=' + ACCEPT, '--csp=' + manifestPath, '--json=' + jsonPath,
  ], { cwd: REPO_ROOT, encoding: 'utf8' });
  let parsed = null;
  let readError = null;
  if (existsSync(jsonPath)) {
    try { parsed = JSON.parse(readFileSync(jsonPath, 'utf8')); } catch (e) { readError = String(e.message); }
  } else {
    readError = 'the guard wrote no report (it exited ' + r.status + ')';
  }
  return {
    status: r.status,
    findings: parsed?.shellCsp?.findings ?? null,
    readError,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  };
}

const cases = [];
const caseOf = (name, description, expect, spec) => cases.push({ name, description, expect, spec });

// --- control: the artifact as committed must be accepted ---------------------
caseOf('control', 'the committed artifact, unmodified', [], {});

// --- presence ---------------------------------------------------------------
caseOf('meta-removed', 'index.html carries no policy',
  ['csp-missing:index.html'],
  { mutate: (f, html) => (f === 'index.html' ? html.replace(CSP_META, '') : null) });
caseOf('doc-absent', '404.html has been deleted from the tree',
  ['csp-document-absent:404.html'],
  { remove: ['404.html'] });

// --- agreement --------------------------------------------------------------
caseOf('drift-both', 'both documents carry a policy that is not the manifest\'s',
  ['csp-drift:index.html', 'csp-drift:404.html'],
  {
    mutate: (f, html) => setPolicy(html, withDirective(policyOf(html), 'media-src', ["'self'", 'data:'])),
  });
caseOf('inconsistent-shells', '404.html carries a different policy than index.html',
  ['csp-inconsistent:404.html'],
  {
    mutate: (f, html) => (f === '404.html'
      ? setPolicy(html, withDirective(policyOf(html), 'media-src', ["'self'", 'data:']))
      : null),
  });

// --- the derivation rule ----------------------------------------------------
caseOf('inline-edited', 'the inline theme script gained a byte; the policy did not follow',
  ['csp-inline-unhashed:index.html@'],
  {
    mutate: (f, html) => (f !== 'index.html' ? null : html.replace(
      /(<script>)(\s*try \{)/,
      (m, open, body) => open + ' ' + body)),
  });

// --- shape ------------------------------------------------------------------
for (const [id, directive, extra] of [
  ['script-eval-allowed', 'script-src', "'unsafe-eval'"],
  ['script-inline-allowed', 'script-src', "'unsafe-inline'"],
  ['script-wildcard', 'script-src', '*'],
  ['style-scheme-wide', 'style-src', 'https:'],
]) {
  caseOf(id, 'the artifact AND the manifest allow ' + extra + ' in ' + directive,
    ['csp-source-forbidden:' + directive + ':' + extra],
    {
      mutate: (f, html) => setPolicy(html, withDirective(policyOf(html), directive,
        [...sourcesOf(policyOf(html), directive), extra])),
      // Keep the manifest in step so csp-drift cannot mask the shape rule.
      manifest: null, // filled in below, once the mutated policy is known
    });
}

caseOf('directive-dropped', 'object-src is gone from both documents',
  ['csp-directive-missing:object-src'],
  {
    mutate: (f, html) => setPolicy(html,
      policyOf(html).split(';').map((s) => s.trim()).filter((s) => !s.startsWith('object-src')).join('; ')),
    manifest: null,
  });

caseOf('documents-empty', 'the manifest requires no document to carry a policy',
  ['csp-vacuous'],
  { manifest: { ...base, shellDocuments: [] } });

// --- the allowlist rule -----------------------------------------------------
caseOf('origin-unclassified', 'script-src names an origin the outbound manifest never audited',
  ['csp-unclassified-origin:https://evil.example'],
  {
    mutate: (f, html) => setPolicy(html,
      policyOf(html).replace('blob: https://cdn.jsdelivr.net', 'blob: https://cdn.jsdelivr.net https://evil.example')),
    manifest: null,
  });

// The shape cases need a manifest whose `policy` equals the mutated artifact,
// otherwise csp-drift fires too and the case no longer isolates its own rule.
// Rebuild them now from the pristine documents.
for (const c of cases) {
  if (c.spec.manifest !== null || c.spec.mutate === undefined) continue;
  const mutated = c.spec.mutate('index.html', pristine['index.html']);
  if (mutated === null) throw new Error(c.name + ': case mutates nothing, so it tests nothing');
  const policy = policyOf(mutated);
  if (policy === null) throw new Error(c.name + ': mutation removed the policy, so it tests the wrong rule');
  c.spec.manifest = { ...base, policy, repairs: [] };
}

// --- run --------------------------------------------------------------------
const R = { cases: [], survived: [], failed: [] };
let pass = true;
try {
  for (const c of cases) {
    const r = runGuard(c.spec);
    const keys = (r.findings ?? []).map((f) => f.key);
    const entry = { case: c.name, description: c.description, expect: c.expect, got: keys, status: r.status };
    R.cases.push(entry);

    if (r.findings === null) {
      R.failed.push(c.name + ': ' + r.readError);
      pass = false;
      console.log('  ' + c.name + ': DRIVER FAILED (' + r.readError + ')');
      for (const line of (r.stdout + r.stderr).split('\n').slice(-6)) console.log('      | ' + line);
      continue;
    }
    const missing = c.expect.filter((e) => !keys.some((k) => k.startsWith(e)));
    if (c.expect.length === 0) {
      if (keys.length === 0 && r.status === 0) {
        console.log('  ' + c.name + ': ok (clean, as required)');
      } else {
        R.failed.push(c.name + ': control was not clean: ' + JSON.stringify(keys.slice(0, 4)));
        pass = false;
        console.log('  ' + c.name + ': CONTROL NOT CLEAN ' + JSON.stringify(keys.slice(0, 4)));
      }
      continue;
    }
    if (missing.length === 0) {
      console.log('  ' + c.name + ': caught -> ' + c.expect.length + '/' + c.expect.length +
        ' expected finding(s) present, guard exit ' + r.status);
      continue;
    }
    R.survived.push({ case: c.name, missing, got: keys });
    pass = false;
    console.log('  ' + c.name + ': MUTANT SURVIVED -- expected ' + JSON.stringify(missing) +
      ' but the guard reported ' + JSON.stringify(keys.slice(0, 6)));
  }
} finally {
  try { rmSync(tree, { recursive: true, force: true, maxRetries: 3 }); } catch { /* locked */ }
}

R.passed = pass;
const outPath = opt('json', null);
if (outPath) { try { writeFileSync(outPath, JSON.stringify(R, null, 2)); } catch { /* best effort */ } }

console.log('');
console.log('csp-guard.negctl: ' + cases.length + ' case(s), ' +
  (cases.length - R.survived.length - R.failed.length) + ' as required, ' +
  R.survived.length + ' mutant(s) survived, ' + R.failed.length + ' driver failure(s)');
if (pass) {
  console.log('csp-guard.negctl: PASS (every rule in check 11 was falsified by a mutant and caught)');
  process.exit(0);
}
console.log('csp-guard.negctl: FAIL' + (outPath ? ' (trace in ' + outPath + ')' : ''));
process.exit(1);
