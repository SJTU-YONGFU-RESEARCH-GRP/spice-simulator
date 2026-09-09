import {
  dcOp,
  linearizeAt,
  passiveValue,
  capNodes,
} from "./circuit.js";
import {
  czeros,
  czeroVec,
  solveComplex,
  copyCMat,
  copyCVec,
  cabs,
  carg,
} from "./matrix.js";
import { sourceAc } from "../netlist/parser.js";

function ni(index, node) {
  if (node === "0") return -1;
  return index.nodeIndex.get(node) ?? -1;
}

function ctrlBranch(index, vname, owner) {
  const want = String(vname).toUpperCase();
  for (const [name, idx] of index.branchIndex) {
    if (String(name).toUpperCase() === want) return idx;
  }
  throw new Error(`${owner}: controlling source '${vname}' not found (need a V device)`);
}

function stampYG(Y, i, j, g) {
  // real conductance
  if (i >= 0) {
    Y[i][i].re += g;
  }
  if (j >= 0) {
    Y[j][j].re += g;
  }
  if (i >= 0 && j >= 0) {
    Y[i][j].re -= g;
    Y[j][i].re -= g;
  }
}

function stampYC(Y, i, j, c, omega) {
  // jωC
  const b = omega * c;
  if (i >= 0) Y[i][i].im += b;
  if (j >= 0) Y[j][j].im += b;
  if (i >= 0 && j >= 0) {
    Y[i][j].im -= b;
    Y[j][i].im -= b;
  }
}

function stampMosY(Y, gm, gds, d, g, s) {
  if (d >= 0) {
    Y[d][d].re += gds;
    if (g >= 0) Y[d][g].re += gm;
    if (s >= 0) Y[d][s].re -= gm + gds;
  }
  if (s >= 0) {
    if (d >= 0) Y[s][d].re -= gds;
    if (g >= 0) Y[s][g].re -= gm;
    Y[s][s].re += gm + gds;
  }
}

function stampBjtY(Y, q, c, b, e) {
  const { gpi, gmu, gmF, gmR, go } = q;
  const gcc = gmR + gmu + go;
  const gcb = gmF - gmR - gmu;
  const gce = -(gmF + go);
  const gbc = -gmu;
  const gbb = gpi + gmu;
  const gbe = -gpi;
  const add = (i, j, g) => {
    if (i >= 0 && j >= 0) Y[i][j].re += g;
  };
  add(c, c, gcc);
  add(c, b, gcb);
  add(c, e, gce);
  add(b, c, gbc);
  add(b, b, gbb);
  add(b, e, gbe);
  add(e, c, -(gcc + gbc));
  add(e, b, -(gcb + gbb));
  add(e, e, -(gce + gbe));
}

export function stampAcSystem(circuit, index, lin, omega) {
  const n = index.n;
  const Y = czeros(n);
  const rhs = czeroVec(n);

  for (const d of circuit.devices) {
    if (d.type === "R") {
      stampYG(Y, ni(index, d.n1), ni(index, d.n2), 1 / passiveValue(d, circuit));
    } else if (d.type === "C") {
      const { a, b, rser } = capNodes(d);
      if (rser) stampYG(Y, ni(index, rser.n1), ni(index, rser.mid), 1 / rser.r);
      stampYC(Y, ni(index, a), ni(index, b), passiveValue(d, circuit), omega);
    } else if (d.type === "L") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const k = index.branchIndex.get(d.name);
      // v = jωL i  →  v_a - v_b - jωL i = 0
      if (a >= 0) {
        Y[a][k].re += 1;
        Y[k][a].re += 1;
      }
      if (b >= 0) {
        Y[b][k].re -= 1;
        Y[k][b].re -= 1;
      }
      Y[k][k].im -= omega * passiveValue(d, circuit);
      const rser = Math.max(0, d.rser ?? 0);
      if (rser > 0) Y[k][k].re -= rser;
    } else if (d.type === "K") {
      // handled after L loop
    } else if (d.type === "V") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const k = index.branchIndex.get(d.name);
      const ac = sourceAc(d);
      if (a >= 0) {
        Y[a][k].re += 1;
        Y[k][a].re += 1;
      }
      if (b >= 0) {
        Y[b][k].re -= 1;
        Y[k][b].re -= 1;
      }
      rhs[k].re += ac.re;
      rhs[k].im += ac.im;
    } else if (d.type === "B") {
      // linearized in lin.behavioral pass below
    } else if (d.type === "I") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const ac = sourceAc(d);
      if (a >= 0) {
        rhs[a].re -= ac.re;
        rhs[a].im -= ac.im;
      }
      if (b >= 0) {
        rhs[b].re += ac.re;
        rhs[b].im += ac.im;
      }
    } else if (d.type === "E") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const c1 = ni(index, d.nc1);
      const c2 = ni(index, d.nc2);
      const k = index.branchIndex.get(d.name);
      if (a >= 0) {
        Y[a][k].re += 1;
        Y[k][a].re += 1;
      }
      if (b >= 0) {
        Y[b][k].re -= 1;
        Y[k][b].re -= 1;
      }
      if (c1 >= 0) Y[k][c1].re -= d.gain;
      if (c2 >= 0) Y[k][c2].re += d.gain;
    } else if (d.type === "G") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const c1 = ni(index, d.nc1);
      const c2 = ni(index, d.nc2);
      const g = d.gain;
      if (a >= 0) {
        if (c1 >= 0) Y[a][c1].re += g;
        if (c2 >= 0) Y[a][c2].re -= g;
      }
      if (b >= 0) {
        if (c1 >= 0) Y[b][c1].re -= g;
        if (c2 >= 0) Y[b][c2].re += g;
      }
    } else if (d.type === "F") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const kc = ctrlBranch(index, d.vname, d.name);
      const g = d.gain;
      if (a >= 0) Y[a][kc].re += g;
      if (b >= 0) Y[b][kc].re -= g;
    } else if (d.type === "H") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const k = index.branchIndex.get(d.name);
      const kc = ctrlBranch(index, d.vname, d.name);
      if (a >= 0) {
        Y[a][k].re += 1;
        Y[k][a].re += 1;
      }
      if (b >= 0) {
        Y[b][k].re -= 1;
        Y[k][b].re -= 1;
      }
      Y[k][kc].re -= d.gain;
    }
  }

  // Mutual inductance: v1 += jωM i2
  for (const d of circuit.devices) {
    if (d.type !== "K") continue;
    const La = circuit.devices.find(
      (x) => x.type === "L" && String(x.name).toUpperCase() === String(d.l1).toUpperCase()
    );
    const Lb = circuit.devices.find(
      (x) => x.type === "L" && String(x.name).toUpperCase() === String(d.l2).toUpperCase()
    );
    if (!La || !Lb) {
      throw new Error(`${d.name}: coupled inductors '${d.l1}', '${d.l2}' not found`);
    }
    const k1 = index.branchIndex.get(La.name);
    const k2 = index.branchIndex.get(Lb.name);
    if (k1 == null || k2 == null) continue;
    const M = d.k * Math.sqrt(passiveValue(La, circuit) * passiveValue(Lb, circuit));
    Y[k1][k2].im -= omega * M;
    Y[k2][k1].im -= omega * M;
  }

  for (const d of lin.diodes) {
    stampYG(Y, ni(index, d.n1), ni(index, d.n2), d.Gd);
    if (d.Cj > 0) stampYC(Y, ni(index, d.n1), ni(index, d.n2), d.Cj, omega);
    if (d.rs) stampYG(Y, ni(index, d.rs.mid), ni(index, d.rs.n2), d.rs.g);
  }
  for (const m of lin.mosfets) {
    stampMosY(Y, m.gm, m.gds, ni(index, m.nd), ni(index, m.ng), ni(index, m.ns));
    if (m.cgs > 0) stampYC(Y, ni(index, m.ng), ni(index, m.ns), m.cgs, omega);
    if (m.cgd > 0) stampYC(Y, ni(index, m.ng), ni(index, m.nd), m.cgd, omega);
    if (m.rd) stampYG(Y, ni(index, m.rd.ext), ni(index, m.rd.mid), 1 / m.rd.r);
    if (m.rs) stampYG(Y, ni(index, m.rs.ext), ni(index, m.rs.mid), 1 / m.rs.r);
  }
  for (const q of lin.bjts || []) {
    stampBjtY(Y, q, ni(index, q.nc), ni(index, q.nb), ni(index, q.ne));
    if (q.cbe > 0) stampYC(Y, ni(index, q.nb), ni(index, q.ne), q.cbe, omega);
    if (q.cbc > 0) stampYC(Y, ni(index, q.nb), ni(index, q.nc), q.cbc, omega);
    if (q.rc) stampYG(Y, ni(index, q.rc.ext), ni(index, q.rc.mid), 1 / q.rc.r);
    if (q.rb) stampYG(Y, ni(index, q.rb.ext), ni(index, q.rb.mid), 1 / q.rb.r);
    if (q.re) stampYG(Y, ni(index, q.re.ext), ni(index, q.re.mid), 1 / q.re.r);
  }
  for (const s of lin.switches || []) {
    stampYG(Y, ni(index, s.n1), ni(index, s.n2), s.g);
  }
  for (const b of lin.behavioral || []) {
    const a = ni(index, b.n1);
    const c = ni(index, b.n2);
    if (b.btype === "I") {
      // i = sum df/dv_j * v_j  (AC)
      for (const p of b.partials) {
        const j = ni(index, p.node);
        if (j < 0) continue;
        if (a >= 0) Y[a][j].re += p.df;
        if (c >= 0) Y[c][j].re -= p.df;
      }
    } else {
      const k = index.branchIndex.get(b.name);
      if (k == null) continue;
      if (a >= 0) {
        Y[a][k].re += 1;
        Y[k][a].re += 1;
      }
      if (c >= 0) {
        Y[c][k].re -= 1;
        Y[k][c].re -= 1;
      }
      // v(n1)-v(n2) - sum (df/dv_j)*v_j = 0
      for (const p of b.partials) {
        const j = ni(index, p.node);
        if (j >= 0) Y[k][j].re -= p.df;
      }
    }
  }

  // gmin
  for (let i = 0; i < index.nodeNames.length; i++) {
    Y[i][i].re += 1e-12;
  }

  return { Y, rhs };
}

export function freqPoints(analysis) {
  const { variation, n, fstart, fstop } = analysis;
  if (!(fstart > 0 && fstop >= fstart)) throw new Error(".ac: need fstart > 0 and fstop >= fstart");
  const pts = [];
  if (variation === "lin") {
    const count = Math.max(2, Math.floor(n));
    for (let i = 0; i < count; i++) {
      pts.push(fstart + ((fstop - fstart) * i) / (count - 1));
    }
  } else if (variation === "oct") {
    const octaves = Math.log2(fstop / fstart);
    const per = Math.max(1, Math.floor(n));
    const total = Math.max(2, Math.floor(octaves * per) + 1);
    for (let i = 0; i < total; i++) {
      pts.push(fstart * Math.pow(2, (octaves * i) / (total - 1)));
    }
  } else {
    // dec
    const decades = Math.log10(fstop / fstart);
    const per = Math.max(1, Math.floor(n));
    const total = Math.max(2, Math.floor(decades * per) + 1);
    for (let i = 0; i < total; i++) {
      pts.push(fstart * Math.pow(10, (decades * i) / (total - 1)));
    }
  }
  return pts;
}

/**
 * AC small-signal sweep. Returns magnitude (dB) and phase series vs frequency (Hz).
 */
export function acAnalysis(circuit, { onProgress, signal } = {}) {
  const analysis = circuit.analysis?.type === "ac" ? circuit.analysis : null;
  if (!analysis) throw new Error("No .ac directive in netlist");

  const dc = dcOp(circuit);
  const index = dc.index;
  const lin = linearizeAt(circuit, index, dc.x);
  const freqs = freqPoints(analysis);

  const series = {};
  for (const name of index.nodeNames) {
    series[`db(v(${name}))`] = [];
    series[`ph(v(${name}))`] = [];
  }

  for (let i = 0; i < freqs.length; i++) {
    if (signal?.aborted) {
      return {
        times: freqs.slice(0, i),
        series,
        aborted: true,
        dc,
        xScale: "log",
        xUnit: "Hz",
      };
    }
    const f = freqs[i];
    const omega = 2 * Math.PI * f;
    const { Y, rhs } = stampAcSystem(circuit, index, lin, omega);
    const x = solveComplex(copyCMat(Y), copyCVec(rhs));

    for (const name of index.nodeNames) {
      const v = { re: x[index.nodeIndex.get(name)].re, im: x[index.nodeIndex.get(name)].im };
      const mag = cabs(v);
      const db = 20 * Math.log10(Math.max(mag, 1e-30));
      const ph = (carg(v) * 180) / Math.PI;
      series[`db(v(${name}))`].push(db);
      series[`ph(v(${name}))`].push(ph);
    }
    if (onProgress && i % 4 === 0) onProgress((i + 1) / freqs.length);
  }

  // Unwrap phase so Bode plots stay continuous across ±180°
  for (const name of index.nodeNames) {
    unwrapPhaseDeg(series[`ph(v(${name}))`]);
  }

  return {
    times: freqs,
    series,
    aborted: false,
    dc,
    xScale: "log",
    xUnit: "Hz",
    points: freqs.length,
  };
}

/** Continuity unwrap for degree arrays (in place). */
export function unwrapPhaseDeg(arr) {
  if (!arr?.length) return arr;
  for (let i = 1; i < arr.length; i++) {
    let d = arr[i] - arr[i - 1];
    while (d > 180) {
      arr[i] -= 360;
      d -= 360;
    }
    while (d < -180) {
      arr[i] += 360;
      d += 360;
    }
  }
  return arr;
}
