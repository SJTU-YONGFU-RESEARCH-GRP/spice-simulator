#!/usr/bin/env node
/**
 * Model-card intake: run model cards through the SHIPPED engine and ask two
 * questions of each one -- does it load at all, and are the numbers it produces
 * the numbers it declares?
 *
 * Why this exists
 * ---------------
 * The deploy ships one model library (`site/models/cmos.lib`) and a schematic
 * editor whose users are expected to bring their own model cards. Nothing in the
 * tree ever checked that a card a user brings is (a) loadable by this engine and
 * (b) faithful to its own parameters. Both failures are real and both are
 * silent-or-opaque:
 *
 *   - A card written in the HSPICE/Spectre comment dialect (`+ VTO = 0.7 ; ...`)
 *     dies in the parameter tokenizer with `strtod: Invalid argument`. Every
 *     card in the lab's own spice_model_collections repository is written that
 *     way, so the collection it points users at does not load here at all --
 *     including its LEVEL-1 card, for a model this engine certainly supports.
 *   - A misspelled parameter name produces the IDENTICAL message, so the two
 *     mistakes cannot be told apart from the diagnostic.
 *   - An out-of-range value produces a different, clearer one
 *     (`Fatal: Pclm = 0 is not positive.`).
 *
 * None of these reach the product as anything but a failed run.
 *
 * The second question is the one `docs/VERIFICATION.md` records as open
 * ("BSIM3/4 absolute accuracy is currently unproven"). It is answerable without
 * any internal knowledge of BSIM: in strong inversion and at CONSTANT Vds a
 * MOSFET obeys
 *
 *     Id = 1/2 * KP * (W/L) * (Vgs - VTO)^2 * (1 + LAMBDA*Vds)
 *
 * so sqrt(Id) is a straight line in Vgs whose intercept is the threshold and
 * whose slope gives the transconductance parameter. Recovering those two numbers
 * from the engine's own transfer curve and holding them against what the card
 * declares turns "is BSIM3 accurate" into a measurement.
 *
 * The two halves are deliberately in one channel because they share the only
 * thing that makes either meaningful: a control whose answer is exact. A
 * LEVEL-1 card has a closed form, so its recovery must be exact; and a card that
 * FAILS to load must never be reported as passing. Those two properties are what
 * the negative control mutates.
 *
 * What the cases actually police
 * ------------------------------
 *   shipped_library_*   the artifact's OWN library. cmos.lib declares
 *                       nmos_rvt VTO={0.5+0.08*__cn_sel} and
 *                       KP={200u-30u*__cn_sel}; this re-derives both from the
 *                       engine's behaviour at each corner, so a library edit
 *                       that breaks the declared spread or a selector that
 *                       stops being honoured is caught by behaviour, not text.
 *   control_level1      a plain LEVEL-1 card carrying the SAME nonzero LAMBDA
 *                       the library uses. Exact by construction; if it is not
 *                       exact, the extraction is at fault and every other case
 *                       is void.
 *   bsim3_longchannel   BSIM3 with every second-order switch off.
 *   bsim4_longchannel   the same for BSIM4 -- which is NOT equally reducible.
 *   reject_*            three cards the engine must refuse, each for its own
 *                       recorded reason.
 *
 * Scope note. The corner ORDERING (ss < tt < ff) is already covered by
 * `numeric-crosscheck.mjs` (corner_shifts_every_device); this channel does not
 * repeat it. What is new here is parameter RECOVERY and intake CLASSIFICATION.
 *
 * Usage
 *   node scripts/model-card-intake.mjs [--site=<dir>] [--json] [--verbose]
 *                                      [--only=<name,...>] [--require]
 *
 * Exit codes
 *   0  every case behaved as declared
 *   1  a case drifted, or a card that must be refused was accepted
 *   2  setup error (engine missing, contract unreadable, --require unmet)
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

// ---------------------------------------------------------------- arguments

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return dflt;
  const eq = hit.indexOf('=');
  return eq < 0 ? true : hit.slice(eq + 1);
};

const SITE = resolve(REPO_ROOT, String(opt('site', 'site')));
const CONTRACT_PATH = resolve(REPO_ROOT, String(opt('contract', 'scripts/model-card-intake.json')));
const AS_JSON = !!opt('json', false);
const VERBOSE = !!opt('verbose', false);
const REQUIRE = !!opt('require', false);
const ONLY = String(opt('only', '')).split(',').map((s) => s.trim()).filter(Boolean);
const RUN_SPEC = opt('run', null);
// Per-case ceiling. A deck that never returns (the engine waiting on a stdin
// nothing will write to, or a sweep that will not converge) must fail THIS case
// with a named timeout rather than wedge the whole job: the first CI run of this
// channel spent 8 minutes producing no output at all, which is exactly the
// failure this bound turns into a diagnosable one.
const CASE_TIMEOUT_MS = Number(opt('timeout-ms', 150000));

const VENDOR = join(SITE, 'vendor', 'ngspice.js');
const RESULT_PATH = join(REPO_ROOT, 'model-card-intake-result.json');
const FIXTURES = join(HERE, 'model-card-fixtures');

// ------------------------------------------------------- child: one deck

/**
 * One deck per process: the emscripten runtime is not re-entrant (see
 * scripts/numeric-crosscheck.mjs, which established this). The parent re-execs
 * this file with --run=<specfile> for each case.
 */
async function runEngine(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'intake-'));
  // .mjs so the copy is parsed as ESM wherever the temp dir lives.
  const modulePath = join(dir, 'ngspice.mjs');
  copyFileSync(spec.vendor, modulePath);
  const { default: createNgspiceModule } = await import(pathToFileURL(modulePath).href);

  const log = [];
  const mod = await createNgspiceModule({
    print: (s) => log.push(String(s)),
    printErr: (s) => log.push(String(s)),
  });

  const mkdirp = (p) => {
    let acc = '';
    for (const seg of p.split('/').filter(Boolean)) {
      acc += '/' + seg;
      try { mod.FS.mkdir(acc); } catch { /* exists */ }
    }
  };
  mkdirp('/proc/self');
  mkdirp('/usr/local/share/ngspice/scripts');
  // Without /proc/meminfo ngspice aborts with a misleading memory error.
  mod.FS.writeFile('/proc/meminfo', 'MemTotal:       16777216 kB\nMemFree:        8388608 kB\nMemAvailable:   8388608 kB\n');
  mod.FS.writeFile('/proc/self/statm', '0 0 0 0 0 0 0\n');
  mod.FS.writeFile('/usr/local/share/ngspice/scripts/spinit', 'set filetype=ascii\nset ngbehavior=lt\n');
  for (const [vpath, text] of spec.files ?? []) {
    mkdirp(vpath.slice(0, vpath.lastIndexOf('/')));
    mod.FS.writeFile(vpath, text);
  }
  mod.FS.writeFile('/circuit.cir', String(spec.deck).trim());
  try { mod.FS.unlink('/out.raw'); } catch { /* not there */ }
  mod.noExitRuntime = true;

  const argvOf = (list) => {
    const ptrs = list.map((s) => mod.stringToUTF8OnStack(s));
    const argvPtr = mod.stackAlloc((list.length + 1) * 4);
    for (let i = 0; i < ptrs.length; i++) mod.HEAP32[(argvPtr >> 2) + i] = ptrs[i];
    mod.HEAP32[(argvPtr >> 2) + ptrs.length] = 0;
    return { argc: list.length, argv: argvPtr };
  };
  try {
    const { argc, argv: a } = argvOf(['ngspice', '-b', '-r', '/out.raw', '/circuit.cir']);
    mod._main(argc, a); // Emscripten signals exit() by throwing; either way is an outcome
  } catch { /* exit */ }

  let raw = null;
  try { raw = mod.FS.readFile('/out.raw', { encoding: 'utf8' }); } catch { /* refused */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }

  const parsed = raw ? parseRaw(raw) : { variables: [], points: [] };
  // The log is bounded: it is carried back so the refusal classifier can read
  // the engine's own words, and the tail holds the diagnostics while the head is
  // just the banner. Nine unbounded logs is memory the runner does not need.
  return { produced: raw !== null, log: log.join('\n').slice(-8000), variables: parsed.variables, points: parsed.points };
}

/**
 * Child entry: run one deck, write the result to the spec's resultPath.
 *
 * The result goes to a FILE rather than to stdout. A child that writes a payload
 * to an async pipe and then calls process.exit() can have that write truncated,
 * and a truncated payload reaches the parent as invalid JSON -- i.e. as a failed
 * case, which is the wrong story. A file write has no such race.
 */
async function runOne(specPath) {
  let result;
  let resultPath = null;
  try {
    const spec = JSON.parse(readFileSync(specPath, 'utf8'));
    resultPath = spec.resultPath;
    result = await runEngine(spec);
  } catch (e) {
    result = { produced: false, log: 'engine driver threw: ' + String((e && e.stack) || e), variables: [], points: [] };
  }
  if (resultPath) {
    try { writeFileSync(resultPath, JSON.stringify(result)); } catch { /* the parent reports the missing file */ }
  }
  process.exit(0);
}

/** ASCII rawfile -> variable names + rows of cell strings. */
function parseRaw(raw) {
  const lines = raw.split('\n');
  const body = lines.slice(lines.findIndex((l) => l.startsWith('Values:')) + 1);
  const names = [];
  for (const line of lines) {
    const m = line.match(/^\s+(\d+)\s+(\S+)\s+\S+\s*$/);
    if (m && line.startsWith('\t')) names.push(m[2]);
  }
  const cells = body.map((l) => l.replace(/^\s*\d+\t/, '').trim()).filter((t) => /^[-+0-9.eE]+$/.test(t));
  const rows = [];
  const w = names.length || 1;
  for (let i = 0; i + w <= cells.length; i += w) rows.push(cells.slice(i, i + w));
  return { variables: names, points: rows };
}

if (RUN_SPEC) {
  runOne(String(RUN_SPEC));
}

// -------------------------------------------------------------- parent mode

if (!existsSync(VENDOR)) {
  console.error(`model-card-intake: engine not found at ${VENDOR} (use --site=<dir>)`);
  process.exit(2);
}
if (!existsSync(CONTRACT_PATH)) {
  console.error(`model-card-intake: contract not found at ${CONTRACT_PATH}`);
  process.exit(2);
}

const contract = JSON.parse(readFileSync(CONTRACT_PATH, 'utf8'));
const CFG = contract.contract;

/** Run one deck spec through a fresh engine process. */
async function drive(spec) {
  const dir = mkdtempSync(join(tmpdir(), 'intake-spec-'));
  try {
    const specPath = join(dir, 'spec.json');
    const resultPath = join(dir, 'result.json');
    writeFileSync(specPath, JSON.stringify({ vendor: VENDOR, resultPath, ...spec }));
    try {
      // Awaited, not blocking. The first CI run of this channel used
      // execFileSync, which stops the event loop for the whole case: Node cannot
      // drain stdout while the loop is blocked, so eight minutes of per-case
      // progress sat in a buffer and died with the process, leaving a log that
      // said nothing but "exit code 143".
      await execFileAsync(process.execPath, [fileURLToPath(import.meta.url), '--run=' + specPath],
        { encoding: 'utf8', maxBuffer: 1 << 26, timeout: CASE_TIMEOUT_MS, killSignal: 'SIGKILL' });
    } catch (e) {
      const timedOut = !!(e && (e.signal || e.killed));
      const detail = timedOut
        ? `the engine child was killed after ${CASE_TIMEOUT_MS} ms -- the same deck returns in seconds elsewhere, so reaching this bound means a HANG, not a slow sweep`
        : String((e && e.stderr) || e).slice(-2000);
      return { produced: false, log: `driver failure: ${detail}\n` + String((e && e.stdout) || ''), variables: [], points: [] };
    }
    try {
      return JSON.parse(readFileSync(resultPath, 'utf8'));
    } catch (e) {
      return { produced: false, log: 'driver produced no readable result file: ' + String(e), variables: [], points: [] };
    }
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Map the engine's own diagnostics onto a reason class, so a refusal is
 * reported for WHY it happened rather than merely that it did. Two classes are
 * distinguished because the engine distinguishes exactly two: a tokenizer
 * failure (which covers both a foreign comment dialect and a misspelled
 * parameter -- they are indistinguishable from this side), and a parameter
 * value the model's own checker refuses.
 */
function refusalReason(log) {
  if (/not positive|parameter checking/i.test(log)) return 'parameter-range';
  if (/strtod/i.test(log)) return 'token-syntax';
  if (/circuit not parsed|Error on line/i.test(log)) return 'parse';
  return 'unknown';
}

/** sqrt(Id) vs Vgs in strong inversion is a line: intercept -> VTO, slope -> KP. */
function recover(run, keepFrom, lambda) {
  const vi = run.variables.findIndex((v) => v === 'v(g)');
  const ii = run.variables.findIndex((v) => v === 'i(vds)');
  if (vi < 0 || ii < 0) return null;
  const pts = run.points
    .map((r) => ({ vg: Number(r[vi]), id: -Number(r[ii]) }))
    .filter((d) => Number.isFinite(d.vg) && Number.isFinite(d.id) && d.id > 0);
  if (pts.length < 6) return null;
  // Drop the low end. Every model smooths its way in from threshold, so the
  // square law is only the operative law in deep strong inversion.
  const u = pts.slice(Math.floor(pts.length * keepFrom)).map((d) => [d.vg, Math.sqrt(d.id)]);
  if (u.length < 5) return null;
  const n = u.length, sx = u.reduce((s, p) => s + p[0], 0), sy = u.reduce((s, p) => s + p[1], 0);
  const sxx = u.reduce((s, p) => s + p[0] * p[0], 0), sxy = u.reduce((s, p) => s + p[0] * p[1], 0);
  const m = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  const vto = -((sy - m * sx) / n) / m;
  const wl = CFG.geometry.wl;
  const kp = (2 * m * m) / (wl * (1 + lambda * CFG.recovery.vds));
  return { vto, kp, points: u.length };
}

/** The fixed-Vds / swept-Vgs deck every recovery case shares. */
function recoveryDeck({ card, device, include, corner }) {
  const r = CFG.recovery;
  const lines = [
    '* model-card-intake recovery: fixed Vds, swept Vgs',
    `VDS d 0 ${r.vds}`,
    'VG g 0 0',
    `M1 d g 0 0 ${device} ${CFG.geometry.spice}`,
  ];
  if (include) {
    lines.push(`.include "${include}"`);
    if (corner !== undefined) lines.push(`.param __cn_sel=${corner}`);
  }
  if (card) lines.push(...card.trim().split('\n'));
  lines.push(`.dc VG ${r.vgsFrom} ${r.vgsTo} ${r.step}`, '.end', '');
  return lines.join('\n');
}

const libraryText = () => readFileSync(join(SITE, 'models', CFG.library.file), 'utf8');

const rows = [];
let assertions = 0, failures = 0;

const IN_ACTIONS = !!process.env.GITHUB_ACTIONS;
/** GitHub workflow-command escaping: %, CR and LF all have to be encoded. */
const cmdEscape = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function record(name, what, checks, elapsedMs) {
  const bad = checks.filter((c) => !c.ok);
  assertions += checks.length;
  failures += bad.length;
  rows.push({ name, what, passed: bad.length === 0, checks, elapsedMs });
  const mark = bad.length ? '[FAIL]' : '[PASS]';
  // Elapsed time on every line, and resident memory alongside it under
  // --verbose: the two numbers that make a resource problem visible in the log
  // instead of inferable from a duration in the run summary.
  console.log(`${mark} ${name}  ${(elapsedMs / 1000).toFixed(1)}s${VERBOSE ? `  rss ${(process.memoryUsage().rss / 1048576).toFixed(0)}MB` : ''}`);
  if (VERBOSE || bad.length) {
    for (const c of checks) console.log(`       ${c.ok ? 'ok  ' : 'BAD '} ${c.label}${c.ok ? '' : `  <- ${c.detail ?? ''}`}`);
  }
  if (bad.length && IN_ACTIONS) {
    // Emitted as an ANNOTATION, not merely as a log line. A step's log requires
    // repository permissions to read; the checks API that carries annotations
    // does not. So the reason a case failed stays readable by anyone reviewing
    // the branch, which is the same reason the channel writes its result file.
    const detail = bad.slice(0, 2).map((c) => `${c.label}${c.detail ? ` <- ${c.detail}` : ''}`).join(' | ');
    console.log(`::error::${name}: ${cmdEscape(detail).slice(0, 800)}`);
  }
}

for (const c of contract.cases) {
  if (ONLY.length && !ONLY.includes(c.name)) continue;
  const t0 = Date.now();
  console.log(`[start] ${c.name}`);

  if (c.kind === 'recover') {
    const card = c.card ? readFileSync(join(FIXTURES, c.card), 'utf8') : null;
    const run = await drive({
      deck: recoveryDeck({
        card, device: c.device, include: c.include ? CFG.library.include : null, corner: c.corner,
      }),
      files: c.include ? [[CFG.library.include, libraryText()]] : [],
    });

    const checks = [];
    if (!run.produced) {
      checks.push({ ok: false, label: 'the card must load', detail: `refused (${refusalReason(run.log)}): ` + run.log.split('\n').filter((l) => /strtod|Fatal|Error/i.test(l)).slice(0, 2).join(' | ') });
    } else {
      const got = recover(run,
        c.recovery?.keepFrom ?? CFG.recovery.keepFrom,
        // The channel holds Vds constant, so channel-length modulation enters as
        // a constant factor on the slope and can be divided out -- but ONLY the
        // factor the card under test actually has. Dividing by the LEVEL-1
        // library's 0.05 on a card whose pclm is 1e-12 reports its KP 7.5 % low,
        // which is exactly what the channel did until a run exposed the ratio.
        c.recovery?.lambda ?? CFG.recovery.lambda);
      if (!got) {
        checks.push({ ok: false, label: 'the transfer curve must be recoverable', detail: `${run.points.length} point(s) in the rawfile` });
      } else {
        // A tolerance may carry an absolute floor as well as a relative one.
        // The BSIM cases need it: their recovered threshold is a measurement
        // that legitimately sits tens of mV from the declared VTH0, so the
        // claim there is an absolute band, not a ratio.
        const delta = (g, d, tol) => {
          const limit = Math.abs(d) * tol.rel + (tol.abs ?? 0);
          return { d: Math.abs(g - d), limit, ok: Math.abs(g - d) <= limit };
        };
        const v = delta(got.vto, c.declared.vto, c.tol.vto);
        const k = delta(got.kp, c.declared.kp, c.tol.kp);
        checks.push({
          ok: v.ok,
          label: `VTO recovered ${got.vto.toFixed(6)} vs declared ${c.declared.vto} (delta ${v.d.toExponential(2)} <= ${v.limit.toExponential(2)})`,
        });
        checks.push({
          ok: k.ok,
          label: `KP  recovered ${got.kp.toExponential(6)} vs declared ${c.declared.kp.toExponential(6)} (delta ${k.d.toExponential(2)} <= ${k.limit.toExponential(2)})`,
        });
      }
    }
    record(c.name, c.what, checks, Date.now() - t0);
    continue;
  }

  if (c.kind === 'refuse') {
    const card = readFileSync(join(FIXTURES, c.card), 'utf8');
    const run = await drive({ deck: recoveryDeck({ card, device: 'n1' }), files: [] });
    const reason = refusalReason(run.log);
    record(c.name, c.what, [
      { ok: !run.produced, label: 'the card must be REFUSED (a card that loads while meaning something else is the failure this guards)', detail: 'it loaded' },
      { ok: reason === c.expectReason, label: `refusal reason is "${c.expectReason}" (got "${reason}")` },
    ], Date.now() - t0);
    continue;
  }

  record(c.name, c.what, [{ ok: false, label: `unknown case kind "${c.kind}"` }], Date.now() - t0);
}

// ------------------------------------------------------------------ report

const summary = `cases=${rows.length} assertions=${assertions} failures=${failures}`;
console.log(`\n${summary}`);
if (failures) {
  const names = rows.filter((r) => !r.passed).map((r) => r.name).join(', ');
  console.log('FAILED cases: ' + names);
  if (IN_ACTIONS) console.log(`::error::${cmdEscape(`model-card-intake ${summary} -- ${names}`)}`);
}

try {
  writeFileSync(RESULT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    engine: 'site/vendor/ngspice.js',
    contract: CONTRACT_PATH.slice(REPO_ROOT.length + 1).replace(/\\/g, '/'),
    cases: rows, assertions, failures,
  }, null, 2) + '\n');
} catch { /* a report is not worth failing over */ }

if (AS_JSON) process.stdout.write(JSON.stringify({ cases: rows, assertions, failures }) + '\n');

if (REQUIRE && rows.length === 0) {
  console.error('model-card-intake: --require was given but no case ran');
  process.exitCode = 2;
} else {
  // exitCode rather than exit(): process.exit() can drop buffered stdout, and
  // the whole point of the rebuilt channel is that its log survives the run.
  process.exitCode = failures ? 1 : 0;
}
