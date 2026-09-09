import {
  dcOp,
  linearizeAt,
  passiveValue,
  capNodes,
  stampSystem,
} from "./circuit.js";
import { zeros, copyMat, solve, eigenvaluesReal } from "./matrix.js";

function ni(index, node) {
  if (node === "0") return -1;
  return index.nodeIndex.get(node) ?? -1;
}

function stampC(C, i, j, c) {
  if (!(c > 0)) return;
  if (i >= 0) C[i][i] += c;
  if (j >= 0) C[j][j] += c;
  if (i >= 0 && j >= 0) {
    C[i][j] -= c;
    C[j][i] -= c;
  }
}

/** Dynamic C matrix (C, L, K, device caps at bias). */
export function buildCMatrix(circuit, index, lin) {
  const n = index.n;
  const C = zeros(n);

  for (const d of circuit.devices) {
    if (d.type === "C") {
      const { a, b } = capNodes(d);
      stampC(C, ni(index, a), ni(index, b), passiveValue(d, circuit));
    } else if (d.type === "L") {
      const k = index.branchIndex.get(d.name);
      if (k != null) C[k][k] += passiveValue(d, circuit);
    } else if (d.type === "K") {
      const La = circuit.devices.find(
        (x) => x.type === "L" && String(x.name).toUpperCase() === String(d.l1).toUpperCase()
      );
      const Lb = circuit.devices.find(
        (x) => x.type === "L" && String(x.name).toUpperCase() === String(d.l2).toUpperCase()
      );
      if (!La || !Lb) continue;
      const k1 = index.branchIndex.get(La.name);
      const k2 = index.branchIndex.get(Lb.name);
      if (k1 == null || k2 == null) continue;
      const M = d.k * Math.sqrt(passiveValue(La, circuit) * passiveValue(Lb, circuit));
      C[k1][k2] += M;
      C[k2][k1] += M;
    }
  }

  for (const d of lin.diodes || []) {
    if (d.Cj > 0) stampC(C, ni(index, d.n1), ni(index, d.n2), d.Cj);
  }
  for (const m of lin.mosfets || []) {
    if (m.cgs > 0) stampC(C, ni(index, m.ng), ni(index, m.ns), m.cgs);
    if (m.cgd > 0) stampC(C, ni(index, m.ng), ni(index, m.nd), m.cgd);
  }
  for (const q of lin.bjts || []) {
    if (q.cbe > 0) stampC(C, ni(index, q.nb), ni(index, q.ne), q.cbe);
    if (q.cbc > 0) stampC(C, ni(index, q.nb), ni(index, q.nc), q.cbc);
  }

  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += Math.abs(C[i][j]);
    if (s < 1e-30) C[i][i] += 1e-18;
  }
  return C;
}

/**
 * .pz — poles of linearized (G + sC) at DC bias.
 * Zeros not computed yet (empty list).
 */
export function pzAnalysis(circuit) {
  const analysis = circuit.analysis?.type === "pz" ? circuit.analysis : null;
  if (!analysis) throw new Error("No .pz directive in netlist");

  const dc = dcOp(circuit);
  const { index, x } = dc;
  const lin = linearizeAt(circuit, index, x);

  const { G } = stampSystem(circuit, index, {
    mode: "dc",
    t: 0,
    xGuess: x,
  });
  const Cm = buildCMatrix(circuit, index, lin);
  const n = index.n;

  // A = -C⁻¹ G  →  poles = eig(A)
  const A = zeros(n);
  for (let j = 0; j < n; j++) {
    const gj = G.map((row) => row[j]);
    let y;
    try {
      y = solve(copyMat(Cm), gj.slice());
    } catch {
      y = gj;
    }
    for (let i = 0; i < n; i++) A[i][j] = -y[i];
  }

  const raw = eigenvaluesReal(A);
  const poles = raw
    .map((p) => {
      const sigma = p.re;
      const omega = p.im;
      const fHz = Math.abs(omega) / (2 * Math.PI);
      const wn = Math.hypot(sigma, omega);
      const Q =
        wn > 1e-30 && Math.abs(sigma) > 1e-30 ? wn / (2 * Math.abs(sigma)) : null;
      return { re: sigma, im: omega, fHz, Q, wn };
    })
    .filter((p) => Number.isFinite(p.re) && Number.isFinite(p.im))
    .filter((p) => {
      const m = Math.hypot(p.re, p.im);
      return m > 1e-6 && m < 1e12;
    })
    .sort((a, b) => Math.hypot(a.re, a.im) - Math.hypot(b.re, b.im));

  return {
    analysis: "pz",
    times: [],
    series: {},
    poles,
    zeros: [],
    dc,
    outNode: analysis.outNode,
    points: poles.length,
  };
}
