import {
  buildIndex,
  solveNonlinear,
  nodeVoltage,
  branchCurrent,
  dcOp,
  applyNodeset,
} from "./circuit.js";
import { zeroVec } from "./matrix.js";
import { formatStepLabel } from "../netlist/step.js";

/**
 * Sweep points for .dc src start stop incr
 */
export function dcSweepPoints(start, stop, step) {
  if (!Number.isFinite(start) || !Number.isFinite(stop) || !Number.isFinite(step)) {
    throw new Error(".dc start/stop/step must be numbers");
  }
  if (step === 0) throw new Error(".dc step must be non-zero");
  const pts = [];
  const eps = Math.abs(step) * 1e-9 + 1e-15;
  if (step > 0) {
    if (stop < start) throw new Error(".dc: with positive step, stop must be ≥ start");
    for (let v = start; v <= stop + eps; v += step) pts.push(v);
  } else {
    if (stop > start) throw new Error(".dc: with negative step, stop must be ≤ start");
    for (let v = start; v >= stop - eps; v += step) pts.push(v);
  }
  if (!pts.length) pts.push(start);
  if (pts.length >= 2) pts[pts.length - 1] = stop;
  return pts;
}

/**
 * DC operating point or source sweep.
 * analysis.sweep = { src, start, stop, step, nested? }
 * Nested: primary src is X-axis; nested src → overlaid curves `sig@Nsrc=val`.
 */
export function dcAnalysis(circuit, { onProgress, signal } = {}) {
  const sweep = circuit.analysis?.sweep;
  if (!sweep) return dcOpAsResult(circuit);
  if (sweep.nested) return dcNestedSweep(circuit, sweep, { onProgress, signal });
  return dcSingleSweep(circuit, sweep, { onProgress, signal });
}

function dcSingleSweep(circuit, sweep, { onProgress, signal } = {}) {
  const src = findSweepSource(circuit, sweep.src);
  const points = dcSweepPoints(sweep.start, sweep.stop, sweep.step);
  const index = buildIndex(circuit);
  if (index.n === 0) throw new Error("No unknowns — add nodes other than ground");

  const origValue = src.value;
  const origWf = src.waveform;
  src.waveform = null;

  const times = [];
  const series = {};
  let x0 = null;
  let lastIter = 0;
  let lastNodes = null;
  let lastCurrents = null;

  try {
    for (let i = 0; i < points.length; i++) {
      if (signal?.aborted) {
        return packSweep(times, series, sweep, lastNodes, lastCurrents, lastIter, true);
      }
      const sol = solveAt(circuit, index, src, points[i], x0);
      x0 = sol.x;
      lastIter = sol.iterations;
      lastNodes = sol.nodes;
      lastCurrents = sol.currents;
      times.push(points[i]);
      appendOpToSeries(series, sol.nodes, sol.currents);
      onProgress?.((i + 1) / points.length);
    }
  } finally {
    src.value = origValue;
    src.waveform = origWf;
  }

  return packSweep(times, series, sweep, lastNodes, lastCurrents, lastIter, false);
}

function dcNestedSweep(circuit, sweep, { onProgress, signal } = {}) {
  const primary = findSweepSource(circuit, sweep.src);
  const secondary = findSweepSource(circuit, sweep.nested.src);
  if (primary === secondary) {
    throw new Error(".dc nested sweep needs two different sources");
  }

  const xPts = dcSweepPoints(sweep.start, sweep.stop, sweep.step);
  const outerPts = dcSweepPoints(sweep.nested.start, sweep.nested.stop, sweep.nested.step);
  const index = buildIndex(circuit);
  if (index.n === 0) throw new Error("No unknowns — add nodes other than ground");

  const origP = { value: primary.value, waveform: primary.waveform };
  const origS = { value: secondary.value, waveform: secondary.waveform };
  primary.waveform = null;
  secondary.waveform = null;

  const times = xPts.slice();
  const series = {};
  let x0 = null;
  let lastIter = 0;
  let lastNodes = null;
  let lastCurrents = null;
  let aborted = false;
  const total = outerPts.length * xPts.length;
  let done = 0;

  try {
    for (const oval of outerPts) {
      secondary.value = oval;
      const tag = `${sweep.nested.src}=${formatStepLabel(oval)}`;
      const nodesBuf = {};
      const currBuf = {};

      for (const xval of xPts) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        const sol = solveAt(circuit, index, primary, xval, x0);
        x0 = sol.x;
        lastIter = sol.iterations;
        lastNodes = sol.nodes;
        lastCurrents = sol.currents;
        for (const [n, v] of Object.entries(sol.nodes)) {
          if (n === "0") continue;
          const k = `v(${n})`;
          if (!nodesBuf[k]) nodesBuf[k] = [];
          nodesBuf[k].push(v);
        }
        for (const [n, v] of Object.entries(sol.currents)) {
          const k = `i(${n})`;
          if (!currBuf[k]) currBuf[k] = [];
          currBuf[k].push(v);
        }
        done++;
        onProgress?.(done / total);
      }
      if (aborted) break;

      for (const [k, ys] of Object.entries(nodesBuf)) {
        series[`${k}@${tag}`] = ys;
      }
      for (const [k, ys] of Object.entries(currBuf)) {
        series[`${k}@${tag}`] = ys;
      }
    }
  } finally {
    primary.value = origP.value;
    primary.waveform = origP.waveform;
    secondary.value = origS.value;
    secondary.waveform = origS.waveform;
  }

  return {
    times,
    series,
    xScale: "lin",
    xUnit: sweep.src,
    analysis: "dc",
    sweep,
    nested: true,
    points: times.length,
    outerPoints: outerPts.length,
    aborted,
    dc: { nodes: lastNodes || {}, currents: lastCurrents || {}, iterations: lastIter },
  };
}

function solveAt(circuit, index, src, value, x0) {
  src.value = value;
  const guess = x0 || applyNodeset(circuit, index, zeroVec(index.n));
  const { x, iterations, converged } = solveNonlinear(circuit, index, {
    mode: "dc",
    t: 0,
    x0: guess,
  });
  if (!converged) {
    throw new Error(
      `DC sweep did not converge at ${src.name}=${value} after ${iterations} iterations`
    );
  }
  const nodes = {};
  for (const name of index.nodeNames) {
    nodes[name] = nodeVoltage(index, x, name);
  }
  nodes["0"] = 0;
  const currents = {};
  for (const d of index.branchDevices) {
    currents[d.name] = branchCurrent(index, x, d.name);
  }
  return { x, iterations, nodes, currents };
}

function appendOpToSeries(series, nodes, currents) {
  for (const [n, v] of Object.entries(nodes)) {
    if (n === "0") continue;
    const key = `v(${n})`;
    if (!series[key]) series[key] = [];
    series[key].push(v);
  }
  for (const [n, v] of Object.entries(currents)) {
    const key = `i(${n})`;
    if (!series[key]) series[key] = [];
    series[key].push(v);
  }
}

function packSweep(times, series, sweep, nodes, currents, iterations, aborted) {
  return {
    times,
    series,
    xScale: "lin",
    xUnit: sweep.src,
    analysis: "dc",
    sweep,
    points: times.length,
    aborted: !!aborted,
    dc: { nodes: nodes || {}, currents: currents || {}, iterations },
  };
}

function dcOpAsResult(circuit) {
  const dc = dcOp(circuit);
  const times = [0];
  const series = {};
  for (const [n, v] of Object.entries(dc.nodes)) {
    if (n === "0") continue;
    series[`v(${n})`] = [v];
  }
  for (const [n, v] of Object.entries(dc.currents || {})) {
    series[`i(${n})`] = [v];
  }
  return {
    times,
    series,
    xScale: "lin",
    xUnit: "s",
    analysis: "dc",
    points: 1,
    dc,
  };
}

function findSweepSource(circuit, name) {
  const want = String(name).toUpperCase();
  const d = circuit.devices.find(
    (x) => (x.type === "V" || x.type === "I") && String(x.name).toUpperCase() === want
  );
  if (!d) throw new Error(`.dc source '${name}' not found (need V or I device)`);
  return d;
}
