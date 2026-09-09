/**
 * Compare current result to a golden run.
 * Returns per-signal max abs / rms error (interpolated onto current times).
 */

export function diffAgainstGolden(current, golden) {
  if (!current?.times?.length || !golden?.times?.length) {
    return { ok: false, error: "Need current and golden waveforms" };
  }
  const signals = Object.keys(current.series || {}).filter((k) => golden.series?.[k]);
  if (!signals.length) {
    return { ok: false, error: "No overlapping signals with golden" };
  }

  const rows = [];
  let worst = 0;
  let worstName = "";
  for (const name of signals) {
    const cur = current.series[name];
    const g = golden.series[name];
    let maxAbs = 0;
    let sumSq = 0;
    let n = 0;
    for (let i = 0; i < current.times.length; i++) {
      const t = current.times[i];
      const gv = interp(golden.times, g, t);
      const cv = cur[i];
      if (!Number.isFinite(gv) || !Number.isFinite(cv)) continue;
      const e = Math.abs(cv - gv);
      maxAbs = Math.max(maxAbs, e);
      sumSq += e * e;
      n++;
    }
    const rms = n ? Math.sqrt(sumSq / n) : 0;
    rows.push({ name, maxAbs, rms, samples: n });
    if (maxAbs > worst) {
      worst = maxAbs;
      worstName = name;
    }
  }

  return {
    ok: true,
    rows,
    worst,
    worstName,
    xUnit: current.xUnit || "s",
  };
}

function interp(times, ys, t) {
  if (!times.length) return NaN;
  if (t <= times[0]) return ys[0];
  if (t >= times[times.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo];
  const t1 = times[hi];
  const u = (t - t0) / (t1 - t0 || 1);
  return ys[lo] * (1 - u) + ys[hi] * u;
}

export function cloneResult(result) {
  return {
    times: result.times.slice(),
    series: Object.fromEntries(
      Object.entries(result.series).map(([k, v]) => [k, v.slice()])
    ),
    xScale: result.xScale,
    xUnit: result.xUnit,
    analysis: result.analysis,
  };
}
