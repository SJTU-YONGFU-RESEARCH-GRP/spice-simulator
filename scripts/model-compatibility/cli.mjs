import { readFileSync, readdirSync, lstatSync, statSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, join, dirname, extname } from 'node:path';
import { parseModels, diagnostic } from './parser.mjs';
import { analyzeModel, CAPABILITIES } from './rules.mjs';
import { probeModel, VENDOR } from './runtime-probe.mjs';
import { localizeFailure } from './failure-localizer.mjs';
import { buildReport, hash, compare, stableJSON, terminalReport } from './reporter.mjs';

export function scanFiles(input) {
  const info = lstatSync(input);
  if (info.isSymbolicLink()) return [];
  if (info.isFile()) return [input];
  return readdirSync(input).sort(compare).flatMap(name => {
    const path = join(input, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) return [];
    return stat.isDirectory() ? scanFiles(path) : /\.(lib|mod|model|sp|cir|spice|ngspice)$/i.test(extname(path)) ? [path] : [];
  });
}

export function analyzeSource(source, file, { runtime = false, localize = true, probe = probeModel, maxProbes = 64 } = {}) {
  const parsed = parseModels(source);
  if (!parsed.models.length) return [{ file, sourceSha256: hash(source), model: null, line: 0, family: '-', level: null,
    static: parsed.diagnostics.some(d => d.severity === 'error') ? 'INVALID' : 'WARNING',
    dependencies: parsed.dependencies, diagnostics: parsed.diagnostics, runtime: { status: 'NOT_RUN', reason: 'No model cards' } }];
  return parsed.models.map(model => {
    const analysis = analyzeModel(model, parsed);
    const row = { file, sourceSha256: hash(source), model: model.name, type: model.type, line: model.line,
      level: analysis.effectiveLevel, declaredLevel: model.levelText, version: model.version,
      parameterCount: model.parameterCount, parameterNames: model.parameterNames, parameters: model.parameters,
      dependencies: parsed.dependencies, family: analysis.family, static: analysis.status,
      diagnostics: [...analysis.diagnostics], runtime: { status: 'NOT_RUN', reason: runtime ? 'Static rejection or unresolved context' : 'Runtime not requested' } };
    if (runtime && !['INVALID', 'UNSUPPORTED'].includes(analysis.status) && !parsed.dependencies.length && !model.scoped) {
      row.runtime = probe(model, parsed.context);
      row.diagnostics.push(...row.runtime.diagnostics);
      if (localize && row.runtime.status === 'RUNTIME_FAILURE') {
        row.localization = localizeFailure(model, row.runtime, card => probe(model, parsed.context, {}, card), { maxProbes });
        row.localization.reproduction = { command: `node scripts/model-compatibility.mjs ${JSON.stringify(file)} --runtime --verbose`,
          note: 'Re-runs original card and deterministic reduction. Reduced .model card is embedded in this report.' };
      }
    }
    return row;
  });
}

export function probeCapabilities() {
  return CAPABILITIES.flatMap(cap => cap.levels.flatMap(level => ['NMOS', 'PMOS'].map(type => {
    const version = cap.family === 'BSIM3' ? ' VERSION=3.3.0' : cap.family === 'BSIM4' ? ' VERSION=4.8.1' : '';
    const model = parseModels(`.model capability ${type} LEVEL=${level}${version}`).models[0];
    return { level, type, card: model.source, runtime: probeModel(model) };
  })));
}

export function parseArgs(args) {
  const options = { runtime: false, localize: true, json: false, verbose: false, output: 'model-compatibility-report.json' };
  let input;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--runtime') options.runtime = true;
    else if (arg === '--no-localize') options.localize = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--help') options.help = true;
    else if (arg === '--output') { options.output = args[++i]; if (!options.output || options.output.startsWith('--')) throw new Error('--output requires a path'); }
    else if (arg.startsWith('-')) throw new Error('Unknown option: ' + arg);
    else if (input) throw new Error('Only one input file or directory is accepted');
    else input = arg;
  }
  return { input: input ?? 'site/models', ...options };
}

function rejectInputOverwrite(files, output) {
  let target;
  try { target = statSync(output, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const targetPath = realpathSync(output);
  // Follow the filesystem's identity rules, including case aliases and links.
  const aliasesInput = files.some(file => {
    const input = statSync(file, { bigint: true });
    return realpathSync(file) === targetPath ||
      (input.ino !== 0n && input.dev === target.dev && input.ino === target.ino);
  });
  if (aliasesInput) throw new Error('Report output must not overwrite an input file');
}

export function main(args = process.argv.slice(2)) {
  try {
    const options = parseArgs(args);
    if (options.help) {
      console.log('Usage: node scripts/model-compatibility.mjs [file-or-directory] [--runtime] [--no-localize] [--json] [--verbose] [--output path]\nExit: 0 clean, 1 warnings, 2 incompatible/invalid/runtime failure, 3 tool error.\nDefault: static scan; JSON report saved to ignored model-compatibility-report.json.');
      return 0;
    }
    const files = scanFiles(resolve(options.input));
    if (!files.length) throw new Error('No model files found');
    rejectInputOverwrite(files, options.output);
    const engine = options.runtime ? { path: 'site/vendor/ngspice.js', sha256: hash(readFileSync(VENDOR)), behavior: 'lt', host: 'Node', fixture: 'DC 0..1.8V, signed by polarity; W=10u L=1u' } : null;
    const rows = files.flatMap(file => analyzeSource(readFileSync(file, 'utf8'), relative(process.cwd(), file).replaceAll('\\', '/'), options));
    const report = buildReport(rows, engine, options.runtime ? probeCapabilities() : []);
    mkdirSync(dirname(resolve(options.output)), { recursive: true });
    writeFileSync(options.output, stableJSON(report));
    console.log(options.json ? stableJSON(report).trimEnd() : terminalReport(report, options.verbose));
    return report.exitCode;
  } catch (error) {
    console.error(stableJSON({ status: 'TOOL_ERROR', exitCode: 3, diagnostics: [diagnostic('TOOL_001', 'error', error.message)] }).trimEnd());
    return 3;
  }
}
