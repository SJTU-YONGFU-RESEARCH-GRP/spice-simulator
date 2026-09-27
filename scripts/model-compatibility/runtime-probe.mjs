import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnostic } from './parser.mjs';

export const VENDOR = fileURLToPath(new URL('../../site/vendor/ngspice.js', import.meta.url));
const WORKER = fileURLToPath(new URL('./probe-worker.mjs', import.meta.url));

export function buildProbe(model, context = [], card = model.source) {
  if (!['NMOS', 'PMOS'].includes(model.type)) throw new Error('No probe for ' + model.type);
  const sign = model.type === 'PMOS' ? -1 : 1;
  return ['Model compatibility DC probe', 'VDS d 0 ' + sign, 'VGS g 0 0',
    `Mprobe d g 0 0 ${model.name} W=10u L=1u`, ...context, card,
    `.dc VGS 0 ${sign * 1.8} ${sign * 0.1}`, '.end', ''].join('\n');
}

function importantLines(lines) {
  return lines.flatMap(line => String(line).split(/\r?\n/))
    .map(line => line.trim()).filter(line => /error|warning|fatal|strtod|invalid|unknown|unrecognized|ignored|not found|failed|can't|cannot|unsupported/i.test(line));
}

export function classifyEngine(result) {
  if (result.toolError) return { status: 'TOOL_ERROR', failureKind: 'engine-setup', diagnostics: [diagnostic('ENGINE_SETUP_001', 'error', 'Engine worker could not initialize.', { evidence: result.toolError })] };
  const evidence = [...new Set(importantLines([...(result.stdout ?? []), ...(result.stderr ?? []), result.exception ?? '']))].sort();
  const parsed = result.parsed;
  const vars = parsed?.variables ?? [], points = parsed?.points ?? [];
  const validResult = !!result.rawPresent && /DC transfer/i.test(parsed?.plotname ?? '') &&
    ['v(d)', 'v(g)', 'i(vds)'].every(name => vars.some(v => v.name.toLowerCase() === name)) &&
    points.length === 19 && points.every(point => point.length === vars.length && point.every(v => String(v).trim() !== '' && Number.isFinite(Number(v))));
  const parseFailure = evidence.some(line => /strtod|unknown parameter|unrecognized|syntax error|parse error|unknown model|could not find.*model|no such model/i.test(line));
  const hardError = evidence.some(line => /\berror\b|fatal|invalid argument|failed|can't|cannot|not found/i.test(line));
  const failed = result.exitStatus !== 0 || !!result.exception || hardError || !validResult;
  const failureKind = failed ? parseFailure ? 'engine-parse' : hardError || result.exception || result.exitStatus !== 0 ? 'engine-runtime' : 'no-result' : null;
  const diagnostics = evidence.map(line => diagnostic(parseFailure ? 'ENGINE_PARSE_002' : failed ? 'ENGINE_RUNTIME_001' : 'ENGINE_WARNING_001', failed ? 'error' : 'warning', 'ngspice diagnostic.', { evidence: line }));
  if (failed && !diagnostics.length) diagnostics.push(diagnostic(validResult ? 'ENGINE_RUNTIME_001' : 'ENGINE_RESULT_001', 'error', validResult ? 'Engine returned failure status.' : 'No complete finite DC rawfile/result.'));
  return { status: failed ? 'RUNTIME_FAILURE' : evidence.length ? 'WARNING' : 'PASS', failureKind,
    exitStatus: result.exitStatus, exception: result.exception, rawPresent: !!result.rawPresent, validResult,
    stdout: importantLines(result.stdout ?? []), stderr: importantLines(result.stderr ?? []),
    pointCount: points.length, variables: vars.map(v => v.name), diagnostics };
}

export function probeDeck(deck, { vendor = VENDOR, timeout = 15000, files = {}, spawn = spawnSync } = {}) {
  const child = spawn(process.execPath, [WORKER], { input: JSON.stringify({ deck, files, vendor }), encoding: 'utf8', timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  if (child.error || child.status !== 0) {
    const timedOut = child.error?.code === 'ETIMEDOUT';
    return { status: timedOut ? 'RUNTIME_FAILURE' : 'TOOL_ERROR', failureKind: timedOut ? 'timeout' : 'worker-error', diagnostics: [diagnostic(timedOut ? 'ENGINE_TIMEOUT_001' : 'ENGINE_SETUP_001', 'error', timedOut ? 'Engine probe exceeded timeout.' : 'Engine worker failed.', { evidence: child.error?.code ?? `Worker exit ${child.status}` })] };
  }
  const payload = /(?:^|\n)MODEL_PROBE_RESULT=(.*)(?:\n|$)/.exec(child.stdout ?? '');
  try {
    if (!payload) throw new Error('Missing worker result marker');
    const result = JSON.parse(payload[1]);
    result.stderr = [...(result.stderr ?? []), child.stderr ?? ''];
    return classifyEngine(result);
  } catch (error) {
    return { status: 'TOOL_ERROR', failureKind: 'worker-protocol', diagnostics: [diagnostic('ENGINE_SETUP_002', 'error', 'Invalid worker response.', { evidence: error.message })] };
  }
}

export function probeModel(model, context = [], options = {}, card = model.source) {
  return { ...probeDeck(buildProbe(model, context, card), options), mode: 'isolated-model-card' };
}
