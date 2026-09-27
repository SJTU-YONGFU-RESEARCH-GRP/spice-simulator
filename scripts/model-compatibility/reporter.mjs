import { createHash } from 'node:crypto';
import { CAPABILITIES } from './rules.mjs';

export const hash = content => createHash('sha256').update(content).digest('hex');
export const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
export function stableJSON(value) {
  const order = item => Array.isArray(item) ? item.map(order) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort(compare).map(key => [key, order(item[key])])) : item;
  return JSON.stringify(order(value), null, 2) + '\n';
}

export function buildReport(rows, engine = null, controls = []) {
  rows.sort((a, b) => compare(a.file, b.file) || a.line - b.line || compare(a.model ?? '', b.model ?? ''));
  const summary = { files: new Set(rows.map(r => r.file)).size, models: rows.filter(r => r.model !== null).length,
    staticCompatible: rows.filter(r => r.static === 'PASS').length,
    runtimeCompatible: rows.filter(r => r.runtime.status === 'PASS').length,
    runtimeCompletedWithWarnings: rows.filter(r => r.runtime.status === 'WARNING').length,
    warnings: rows.filter(r => r.diagnostics.some(d => d.severity === 'warning')).length,
    incompatible: rows.filter(r => ['INVALID', 'UNSUPPORTED'].includes(r.static) || r.runtime.status === 'RUNTIME_FAILURE').length,
    toolErrors: rows.filter(r => r.runtime.status === 'TOOL_ERROR' || r.localization?.interrupted).length,
    runtimeSkipped: rows.filter(r => r.runtime.status === 'NOT_RUN').length };
  const controlToolErrors = controls.some(c => c.runtime.status === 'TOOL_ERROR');
  const exitCode = summary.toolErrors || controlToolErrors ? 3 : summary.incompatible || controls.some(c => c.runtime.status === 'RUNTIME_FAILURE') ? 2 : summary.warnings ? 1 : 0;
  const capabilityMatrix = CAPABILITIES.flatMap(cap => cap.levels.map(level => {
    const evidence = controls.filter(c => c.level === level);
    return { level, family: cap.family, upstream: cap.upstream, shippedWasm: !evidence.length ? 'UNVERIFIED'
      : evidence.every(c => ['PASS', 'WARNING'].includes(c.runtime.status)) ? 'PROBE_VERIFIED' : 'NOT_VERIFIED', evidence };
  }));
  return { schemaVersion: 1, scope: 'Isolated model-card DC smoke probes; not numerical accuracy or complete library validation.', engine, capabilityMatrix, summary, exitCode, rows };
}

export function terminalReport(report, verbose = false) {
  const headings = ['Model', 'Family', 'Level', 'Static', 'Runtime', 'Diagnostic'];
  const entries = report.rows.map(row => [row.file + (row.model ? ':' + row.model : ''), row.family, String(row.level ?? '-'), row.static, row.runtime.status,
    [...new Set(row.diagnostics.map(d => d.code))].join(',') || '-']);
  const widths = headings.map((h, i) => Math.max(h.length, ...entries.map(e => e[i].length)));
  const format = row => row.map((v, i) => v.padEnd(widths[i])).join(' | ').trimEnd();
  const lines = ['SPICE Model Compatibility Report', format(headings), widths.map(w => '-'.repeat(w)).join('-+-'), ...entries.map(format), '', JSON.stringify(report.summary), `Exit code: ${report.exitCode}`];
  for (const row of report.rows) {
    if (row.localization) lines.push(`${row.model}: ${row.localization.status}; confidence=${row.localization.confidence}; suspected=${row.localization.suspectedParameters.map(p => p.name + '=' + p.value).join(',') || 'none'}`);
    if (verbose) for (const d of row.diagnostics) lines.push(`  ${d.code}: ${d.parameter ?? ''} ${d.message} ${d.evidence ?? ''}`);
  }
  return lines.join('\n');
}
