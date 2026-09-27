import { diagnostic } from './parser.mjs';

export function renderCard(model, parameters) {
  return `.model ${model.name} ${model.type}\n` + parameters.map(p => `+ ${p.name}=${p.value}`).join('\n');
}

// Same broad error class alone is insufficient: preserve a concrete diagnostic signature.
export function failureSignature(result) {
  if (result.status !== 'RUNTIME_FAILURE') return null;
  const evidence = result.diagnostics.map(d => d.evidence ?? '').join('\n');
  if (/strtod.*invalid argument/i.test(evidence)) return 'engine-parse:strtod-invalid-argument';
  return result.failureKind + ':' + result.diagnostics.map(d => d.code + ':' + (d.evidence ?? d.message)).join('|');
}

export function localizeFailure(model, original, probe, { maxProbes = 64 } = {}) {
  const signature = failureSignature(original);
  const base = model.parameters.filter(p => p.name === 'LEVEL');
  const candidates = model.parameters.filter(p => p.name !== 'LEVEL');
  let probes = 0, exhausted = false, interrupted = false;
  const cache = new Map();
  const run = parameters => {
    const ordered = [...base, ...parameters].sort((a, b) => a.index - b.index);
    const card = renderCard(model, ordered);
    if (cache.has(card)) return cache.get(card);
    if (probes >= maxProbes) { exhausted = true; return null; }
    probes++;
    const result = probe(card);
    if (result.status === 'TOOL_ERROR') interrupted = true;
    cache.set(card, result);
    return result;
  };
  const outcome = (status, message, subset = [], extra = {}) => ({ status, confidence: 'low', probes, interrupted, budgetExhausted: exhausted,
    diagnostic: diagnostic('LOCALIZE_001', 'warning', message), signature,
    suspectedParameters: subset.map(p => ({ name: p.name, value: p.value, index: p.index })), ...extra });
  if (!signature || original.failureKind === 'timeout') return outcome('INCONCLUSIVE', 'Failure is not eligible for parameter localization.');
  const baseline = run([]);
  if (!baseline || !['PASS', 'WARNING'].includes(baseline.status)) return outcome('INCONCLUSIVE', 'LEVEL-only baseline does not run; cannot attribute failure to parameters.', [], { evidence: { baseline } });
  const full = run(candidates);
  if (!full || failureSignature(full) !== signature) return outcome('INCONCLUSIVE', 'Normalized card does not reproduce the original failure; source formatting or context may matter.', [], { evidence: { baseline, normalized: full } });
  let subset = candidates, partitions = 2;
  while (subset.length > 1 && !exhausted && !interrupted) {
    const size = Math.ceil(subset.length / partitions);
    let reduced = false;
    for (let start = 0; start < subset.length; start += size) {
      const complement = subset.filter((_, i) => i < start || i >= start + size);
      const result = run(complement);
      if (result && failureSignature(result) === signature) {
        subset = complement; partitions = Math.max(2, partitions - 1); reduced = true; break;
      }
      if (exhausted || interrupted) break;
    }
    if (!reduced) { if (partitions >= subset.length) break; partitions = Math.min(subset.length, partitions * 2); }
  }
  const failing = run(subset);
  const controls = subset.map((p, i) => ({ removed: p.name, result: run(subset.filter((_, j) => j !== i)) }));
  const minimal = !exhausted && !interrupted && controls.every(c => ['PASS', 'WARNING'].includes(c.result?.status));
  return outcome('LOCALIZED', 'Reproducing subset found; attribution is conditional on this deck, engine and fixed LEVEL.', subset,
    { confidence: minimal ? 'high' : 'medium', oneMinimal: minimal, budgetExhausted: exhausted, interrupted,
      card: renderCard(model, [...base, ...subset].sort((a, b) => a.index - b.index)),
      evidence: { baseline, failing, removalControls: controls },
      limitation: 'Not a unique root cause or a globally smallest subset; other independent failures may remain.' });
}
