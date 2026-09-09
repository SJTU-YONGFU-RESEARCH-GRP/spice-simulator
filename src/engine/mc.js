import { dcOp } from "./circuit.js";

/** Mulberry32 PRNG → [0,1). */
function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller normal. */
function randn(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * .mc runs [seed=N]
 * Perturbs R/C/L with lot=/dev= (relative σ), runs DC each time.
 * X axis = run index; series = node voltages (+ stats on result).
 */
export function mcAnalysis(circuit, { onProgress, signal } = {}) {
  const analysis = circuit.analysis?.type === "mc" ? circuit.analysis : null;
  if (!analysis) throw new Error("No .mc directive in netlist");

  const varied = circuit.devices.filter(
    (d) => (d.type === "R" || d.type === "C" || d.type === "L") && d.lot > 0
  );
  if (!varied.length) {
    throw new Error(".mc: mark at least one R/C/L with lot=… or dev=… (e.g. lot=10%)");
  }

  for (const d of varied) {
    if (d._baseValue == null) d._baseValue = d.value;
  }

  const runs = analysis.runs;
  const rng = mulberry32(analysis.seed ?? 1);
  const times = [];
  const series = {};
  let lastNodes = null;
  let failed = 0;

  try {
    for (let r = 0; r < runs; r++) {
      if (signal?.aborted) break;
      for (const d of varied) {
        d.value = d._baseValue * (1 + d.lot * randn(rng));
        if (!(d.value > 0)) d.value = d._baseValue * 1e-6;
      }
      try {
        const dc = dcOp(circuit);
        lastNodes = dc.nodes;
        times.push(r + 1);
        for (const [name, v] of Object.entries(dc.nodes)) {
          if (name === "0") continue;
          const key = `v(${name})`;
          if (!series[key]) series[key] = [];
          // pad if previous runs failed
          while (series[key].length < times.length - 1) series[key].push(NaN);
          series[key].push(v);
        }
      } catch {
        failed++;
      }
      onProgress?.((r + 1) / runs);
    }
  } finally {
    for (const d of varied) {
      d.value = d._baseValue;
      delete d._baseValue;
    }
  }

  if (!times.length) throw new Error(`.mc: all ${runs} runs failed to converge`);

  const stats = {};
  for (const [key, ys] of Object.entries(series)) {
    const vals = ys.filter((v) => Number.isFinite(v));
    if (!vals.length) continue;
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const varr =
      vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, vals.length - 1);
    stats[key] = {
      mean,
      std: Math.sqrt(varr),
      min: Math.min(...vals),
      max: Math.max(...vals),
      n: vals.length,
    };
  }

  return {
    analysis: "mc",
    times,
    series,
    stats,
    failed,
    runs,
    seed: analysis.seed ?? 1,
    varied: varied.map((d) => ({ name: d.name, lot: d.lot })),
    dc: lastNodes
      ? { nodes: lastNodes, currents: {}, iterations: 0 }
      : undefined,
    xScale: "lin",
    xUnit: "",
    points: times.length,
  };
}
