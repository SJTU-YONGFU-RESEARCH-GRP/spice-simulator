import { zeros, zeroVec, solve, copyMat, copyVec } from "./matrix.js";
import { sourceValue } from "../netlist/parser.js";
import { mosParams, mosEval, mosCaps, mosIntNodes } from "./mosfet.js";
import { bjtParams, bjtEval, stampBjt, bjtCaps, bjtIntNodes } from "./bjt.js";
import { switchParams, switchIsOn, isSwitchModel } from "./switch.js";
import { evalExpr } from "./expr.js";
import { diodeParams, diodeEval, diodeRsNode, diodeCapacitance } from "./diode.js";

/**
 * Build node/branch index map.
 * Unknowns: [v_n1, v_n2, ..., i_V1, i_L1, ...]  (ground node 0 omitted)
 */
export function buildIndex(circuit) {
  const nodeSet = new Set(circuit.nodes.filter((n) => n !== "0"));
  for (const d of circuit.devices) {
    if (d.type === "D") {
      const model = circuit.models.get(d.model) || circuit.models.get("DDEFAULT");
      const { Rs } = diodeParams(model);
      if (Rs > 0) nodeSet.add(diodeRsNode(d));
    } else if (d.type === "C" && (d.rser ?? 0) > 0) {
      nodeSet.add(capEsrNode(d));
    } else if (d.type === "M") {
      const model = circuit.models.get(d.model);
      if (model) {
        const params = mosParams(model, d);
        const n = mosIntNodes(d, params);
        if (n.rd) nodeSet.add(n.rd.mid);
        if (n.rs) nodeSet.add(n.rs.mid);
      }
    } else if (d.type === "Q") {
      const model = circuit.models.get(d.model) || circuit.models.get("NPN");
      if (model) {
        const params = bjtParams(model);
        const n = bjtIntNodes(d, params);
        if (n.rc) nodeSet.add(n.rc.mid);
        if (n.rb) nodeSet.add(n.rb.mid);
        if (n.re) nodeSet.add(n.re.mid);
      }
    }
  }
  const nodeNames = [...nodeSet];
  const nodeIndex = new Map();
  nodeNames.forEach((n, i) => nodeIndex.set(n, i));

  const branchDevices = circuit.devices.filter(
    (d) =>
      d.type === "V" ||
      d.type === "L" ||
      d.type === "E" ||
      d.type === "H" ||
      (d.type === "B" && d.btype === "V")
  );
  const branchIndex = new Map();
  branchDevices.forEach((d, i) => branchIndex.set(d.name, nodeNames.length + i));

  return {
    n: nodeNames.length + branchDevices.length,
    nodeNames,
    nodeIndex,
    branchIndex,
    branchDevices,
  };
}

/** Internal node between Rser and C: n1 — Rser — #esr — C — n2 */
export function capEsrNode(d) {
  return `${d.name}#esr`;
}

/** Capacitor terminals with optional ESR: returns { a, b, rserNode? }. C is between a–b. */
export function capNodes(d) {
  const rser = Math.max(0, d.rser ?? 0);
  if (rser > 0) {
    return { a: capEsrNode(d), b: d.n2, rser: { n1: d.n1, mid: capEsrNode(d), r: rser } };
  }
  return { a: d.n1, b: d.n2, rser: null };
}

function ni(index, node) {
  if (node === "0") return -1;
  const i = index.nodeIndex.get(node);
  if (i === undefined) throw new Error(`Unknown node ${node}`);
  return i;
}

/** Branch index of controlling voltage source for F/H. */
function ctrlBranch(index, vname, owner) {
  const want = String(vname).toUpperCase();
  for (const [name, idx] of index.branchIndex) {
    if (String(name).toUpperCase() === want) return idx;
  }
  // also allow matching device that is V-type only — branchIndex already V/L/E/H
  throw new Error(`${owner}: controlling source '${vname}' not found (need a V device)`);
}

function stampG(G, i, j, g) {
  if (i >= 0) G[i][i] += g;
  if (j >= 0) G[j][j] += g;
  if (i >= 0 && j >= 0) {
    G[i][j] -= g;
    G[j][i] -= g;
  }
}

function stampCurrent(rhs, i, j, iVal) {
  if (i >= 0) rhs[i] -= iVal;
  if (j >= 0) rhs[j] += iVal;
}

/** Controlled current Idc + gm*(vg-vs) + gds*(vd-vs) into drain, out of source. */
function stampMos(G, rhs, id, gm, gds, d, g, s) {
  // Id = Ieq + gm*vgs + gds*vds  with Ieq = Id - gm*vgs - gds*vds (evaluated at guess)
  // KCL: +Id at drain, -Id at source
  if (d >= 0) {
    if (d >= 0) G[d][d] += gds;
    if (g >= 0) G[d][g] += gm;
    if (s >= 0) G[d][s] -= gm + gds;
  }
  if (s >= 0) {
    if (d >= 0) G[s][d] -= gds;
    if (g >= 0) G[s][g] -= gm;
    if (s >= 0) G[s][s] += gm + gds;
  }
  // rhs handles Ieq portion via stampCurrent after computing Ieq
  return id; // caller stamps Ieq
}
/** Scale R/C/L by tc1/tc2 vs circuit temperature. */
export function passiveValue(d, circuit) {
  const T = circuit.options?.tempC ?? 27;
  const Tnom = circuit.options?.tnom ?? 27;
  const dT = T - Tnom;
  const tc1 = d.tc1 ?? 0;
  const tc2 = d.tc2 ?? 0;
  const scale = 1 + tc1 * dT + tc2 * dT * dT;
  const v = d.value * scale;
  if (!(v > 0)) throw new Error(`${d.name}: value at temp must be > 0`);
  return v;
}

/**
 * Stamp the MNA system for one iteration / timestep.
 * opts: { mode, dt, t, state, xGuess, gmin, method: 'trap'|'be' }
 */
export function stampSystem(circuit, index, opts = {}) {
  const {
    mode = "dc",
    dt = 1e-6,
    t = 0,
    state = {},
    xGuess = null,
    method = "trap",
    sourceScale = 1,
  } = opts;
  const n = index.n;
  const G = zeros(n);
  const rhs = zeroVec(n);
  const trap = method === "trap" && mode === "tran";

  const volt = (node) => {
    const i = ni(index, node);
    if (i < 0) return 0;
    return xGuess ? xGuess[i] : 0;
  };

  for (const d of circuit.devices) {
    if (d.type === "R") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      stampG(G, a, b, 1 / passiveValue(d, circuit));
    } else if (d.type === "I") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      stampCurrent(rhs, a, b, sourceValue(d, t, mode) * sourceScale);
    } else if (d.type === "B") {
      stampBehavioral(circuit, index, G, rhs, d, volt, t, mode);
    } else if (d.type === "V") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const k = index.branchIndex.get(d.name);
      const vVal = sourceValue(d, t, mode) * sourceScale;
      if (a >= 0) {
        G[a][k] += 1;
        G[k][a] += 1;
      }
      if (b >= 0) {
        G[b][k] -= 1;
        G[k][b] -= 1;
      }
      rhs[k] += vVal;
    } else if (d.type === "E") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const c1 = ni(index, d.nc1);
      const c2 = ni(index, d.nc2);
      const k = index.branchIndex.get(d.name);
      if (a >= 0) {
        G[a][k] += 1;
        G[k][a] += 1;
      }
      if (b >= 0) {
        G[b][k] -= 1;
        G[k][b] -= 1;
      }
      if (c1 >= 0) G[k][c1] -= d.gain;
      if (c2 >= 0) G[k][c2] += d.gain;
    } else if (d.type === "G") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const c1 = ni(index, d.nc1);
      const c2 = ni(index, d.nc2);
      const g = d.gain;
      if (a >= 0) {
        if (c1 >= 0) G[a][c1] += g;
        if (c2 >= 0) G[a][c2] -= g;
      }
      if (b >= 0) {
        if (c1 >= 0) G[b][c1] -= g;
        if (c2 >= 0) G[b][c2] += g;
      }
    } else if (d.type === "F") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const kc = ctrlBranch(index, d.vname, d.name);
      const g = d.gain;
      if (a >= 0) G[a][kc] += g;
      if (b >= 0) G[b][kc] -= g;
    } else if (d.type === "H") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const k = index.branchIndex.get(d.name);
      const kc = ctrlBranch(index, d.vname, d.name);
      if (a >= 0) {
        G[a][k] += 1;
        G[k][a] += 1;
      }
      if (b >= 0) {
        G[b][k] -= 1;
        G[k][b] -= 1;
      }
      G[k][kc] -= d.gain;
    } else if (d.type === "S" || d.type === "W") {
      stampSwitch(circuit, index, G, d, volt, state, xGuess);
    } else if (d.type === "L") {
      const a = ni(index, d.n1);
      const b = ni(index, d.n2);
      const k = index.branchIndex.get(d.name);
      const Lval = passiveValue(d, circuit);
      const rser = Math.max(0, d.rser ?? 0);
      if (mode === "dc") {
        if (a >= 0) {
          G[a][k] += 1;
          G[k][a] += 1;
        }
        if (b >= 0) {
          G[b][k] -= 1;
          G[k][b] -= 1;
        }
        if (rser > 0) G[k][k] -= rser;
      } else {
        const iPrev = state.iL?.get(d.name) ?? 0;
        const vPrev = state.vL?.get(d.name) ?? 0;
        const Heq = trap ? (2 * Lval) / dt : Lval / dt;
        const Veq = trap ? Heq * iPrev + vPrev : Heq * iPrev;
        if (a >= 0) {
          G[a][k] += 1;
          G[k][a] += 1;
        }
        if (b >= 0) {
          G[b][k] -= 1;
          G[k][b] -= 1;
        }
        G[k][k] -= Heq + rser;
        rhs[k] -= Veq;
      }
    } else if (d.type === "D") {
      stampDiode(circuit, index, G, rhs, d, volt, { mode, dt, state, trap });
    } else if (d.type === "M") {
      stampMosfet(circuit, index, G, rhs, d, volt, { mode, dt, state, trap });
    } else if (d.type === "Q") {
      stampBipolar(circuit, index, G, rhs, d, volt, { mode, dt, state, trap });
    }
  }

  if (mode !== "dc") {
    stampMutualL(circuit, index, G, rhs, state, dt, trap);
  }

  for (const d of circuit.devices) {
    if (d.type !== "C") continue;
    const { a: na, b: nb, rser } = capNodes(d);
    if (rser) {
      // ESR always present (DC + TRAN)
      stampG(G, ni(index, rser.n1), ni(index, rser.mid), 1 / rser.r);
    }
    if (mode === "dc") continue;
    const a = ni(index, na);
    const b = ni(index, nb);
    const Cval = passiveValue(d, circuit);
    const vPrev = state.vC?.get(d.name) ?? 0;
    const iPrev = state.iC?.get(d.name) ?? 0;
    const Geq = trap ? (2 * Cval) / dt : Cval / dt;
    const Ieq = trap ? Geq * vPrev + iPrev : Geq * vPrev;
    stampG(G, a, b, Geq);
    stampCurrent(rhs, a, b, -Ieq);
  }

  const gmin = opts.gmin ?? circuit.options?.gmin ?? 1e-12;
  for (let i = 0; i < index.nodeNames.length; i++) {
    G[i][i] += gmin;
  }

  return { G, rhs };
}

function stampDiode(circuit, index, G, rhs, d, volt, opts = {}) {
  const model = circuit.models.get(d.model) || circuit.models.get("DDEFAULT");
  const params = diodeParams(model);
  const cathode = d.n2;
  const mid = params.Rs > 0 ? diodeRsNode(d) : cathode;
  const a = ni(index, d.n1);
  const b = ni(index, mid);
  const vd = volt(d.n1) - volt(mid);
  const { Id, Gd, vdUsed } = diodeEval(params, vd);
  const Ieq = Id - Gd * vdUsed;
  stampG(G, a, b, Gd);
  stampCurrent(rhs, a, b, Ieq);
  if (params.Rs > 0) {
    stampG(G, ni(index, mid), ni(index, cathode), 1 / params.Rs);
  }

  // Junction / diffusion capacitance (TRAN companion)
  const { mode, dt, state, trap } = opts;
  if (mode === "tran" && dt > 0) {
    const C = diodeCapacitance(params, vdUsed, Gd);
    if (C > 0) {
      const vPrev = state.vD?.get(d.name) ?? vdUsed;
      const iPrev = state.iDcap?.get(d.name) ?? 0;
      const Geq = trap ? (2 * C) / dt : C / dt;
      const IeqC = trap ? Geq * vPrev + iPrev : Geq * vPrev;
      stampG(G, a, b, Geq);
      stampCurrent(rhs, a, b, -IeqC);
    }
  }
}

function stampMosfet(circuit, index, G, rhs, d, volt, opts = {}) {
  const model = circuit.models.get(d.model);
  if (!model) throw new Error(`${d.name}: missing model ${d.model}`);
  const params = mosParams(model, d);
  const nodes = mosIntNodes(d, params);
  if (nodes.rd) stampG(G, ni(index, nodes.rd.ext), ni(index, nodes.rd.mid), 1 / nodes.rd.r);
  if (nodes.rs) stampG(G, ni(index, nodes.rs.ext), ni(index, nodes.rs.mid), 1 / nodes.rs.r);

  const vd = volt(nodes.nd);
  const vg = volt(nodes.ng);
  const vs = volt(nodes.ns);
  const { Id, gm, gds, region } = mosEval(params, vd, vg, vs);
  const di = ni(index, nodes.nd);
  const gi = ni(index, nodes.ng);
  const si = ni(index, nodes.ns);
  const vgs = vg - vs;
  const vds = vd - vs;
  const Ieq = Id - gm * vgs - gds * vds;
  stampMos(G, rhs, Id, gm, gds, di, gi, si);
  if (di >= 0) rhs[di] -= Ieq;
  if (si >= 0) rhs[si] += Ieq;

  const { mode, dt, state, trap } = opts;
  if (mode === "tran" && dt > 0) {
    const { cgs, cgd, cgb } = mosCaps(params, region);
    const cgsTot = cgs + cgb;
    stampCapBranch(G, rhs, gi, si, cgsTot, state.vMosGs?.get(d.name) ?? vgs, state.iMosGs?.get(d.name) ?? 0, dt, trap);
    stampCapBranch(G, rhs, gi, di, cgd, state.vMosGd?.get(d.name) ?? vg - vd, state.iMosGd?.get(d.name) ?? 0, dt, trap);
  }
}

function stampCapBranch(G, rhs, a, b, C, vPrev, iPrev, dt, trap) {
  if (!(C > 0) || !(dt > 0)) return;
  const Geq = trap ? (2 * C) / dt : C / dt;
  const Ieq = trap ? Geq * vPrev + iPrev : Geq * vPrev;
  stampG(G, a, b, Geq);
  stampCurrent(rhs, a, b, -Ieq);
}

function stampBipolar(circuit, index, G, rhs, d, volt, opts = {}) {
  const model = circuit.models.get(d.model) || circuit.models.get("NPN");
  if (!model) throw new Error(`${d.name}: missing model ${d.model}`);
  const params = bjtParams(model);
  const nodes = bjtIntNodes(d, params);
  if (nodes.rc) stampG(G, ni(index, nodes.rc.ext), ni(index, nodes.rc.mid), 1 / nodes.rc.r);
  if (nodes.rb) stampG(G, ni(index, nodes.rb.ext), ni(index, nodes.rb.mid), 1 / nodes.rb.r);
  if (nodes.re) stampG(G, ni(index, nodes.re.ext), ni(index, nodes.re.mid), 1 / nodes.re.r);

  const vc = volt(nodes.nc);
  const vb = volt(nodes.nb);
  const ve = volt(nodes.ne);
  const ev = bjtEval(params, vc, vb, ve);
  const ci = ni(index, nodes.nc);
  const bi = ni(index, nodes.nb);
  const ei = ni(index, nodes.ne);
  stampBjt(G, rhs, ci, bi, ei, vc, vb, ve, ev);

  const { mode, dt, state, trap } = opts;
  if (mode === "tran" && dt > 0) {
    const { cbe, cbc } = bjtCaps(params, ev.Vbe, ev.Vbc, ev.gmF);
    const vbePhys = vb - ve;
    const vbcPhys = vb - vc;
    stampCapBranch(
      G,
      rhs,
      bi,
      ei,
      cbe,
      state.vBjtBe?.get(d.name) ?? vbePhys,
      state.iBjtBe?.get(d.name) ?? 0,
      dt,
      trap
    );
    stampCapBranch(
      G,
      rhs,
      bi,
      ci,
      cbc,
      state.vBjtBc?.get(d.name) ?? vbcPhys,
      state.iBjtBc?.get(d.name) ?? 0,
      dt,
      trap
    );
  }
}

function makeExprCtx(circuit, index, volt, t) {
  return {
    time: t ?? 0,
    temper: circuit.options?.tempC ?? 27,
    v: (node) => {
      try {
        return volt(node);
      } catch {
        return 0;
      }
    },
  };
}

function evalBehavioral(circuit, d, volt, t) {
  const compiled = d.compiled;
  if (!compiled) throw new Error(`${d.name}: missing compiled expression`);
  const val = evalExpr(compiled, makeExprCtx(circuit, null, volt, t));
  return Number.isFinite(val) ? val : 0;
}

/** Numerical df/dv for AC linearization of B sources. */
export function behavioralPartials(circuit, d, volt, t = 0) {
  const h = 1e-6;
  const f0 = evalBehavioral(circuit, d, volt, t);
  const partials = [];
  const seen = new Set();
  for (const node of d.compiled?.nodes || []) {
    if (node === "0" || seen.has(node)) continue;
    seen.add(node);
    const v0 = volt(node);
    const voltP = (n) => (n === node ? v0 + h : volt(n));
    const f1 = evalBehavioral(circuit, d, voltP, t);
    partials.push({ node, df: (f1 - f0) / h });
  }
  return { f0, partials };
}

function stampBehavioral(circuit, index, G, rhs, d, volt, t, mode) {
  const a = ni(index, d.n1);
  const b = ni(index, d.n2);
  const val = evalBehavioral(circuit, d, volt, mode === "ac" ? 0 : t);
  if (d.btype === "I") {
    stampCurrent(rhs, a, b, val);
    return;
  }
  // Voltage behavioral: branch unknown like V
  const k = index.branchIndex.get(d.name);
  if (k == null) throw new Error(`${d.name}: missing branch index`);
  if (a >= 0) {
    G[a][k] += 1;
    G[k][a] += 1;
  }
  if (b >= 0) {
    G[b][k] -= 1;
    G[k][b] -= 1;
  }
  rhs[k] += val;
}

function stampSwitch(circuit, index, G, d, volt, state, xGuess) {
  const model = circuit.models.get(d.model) || {
    type: d.type === "W" ? "CSW" : "SW",
    params: {},
  };
  if (model.type && !isSwitchModel(model.type)) {
    throw new Error(`${d.name}: model ${d.model} must be SW or CSW`);
  }
  const params = switchParams(model);
  let ctrl;
  if (d.type === "W") {
    const bname = resolveBranchName(index, d.vname);
    if (!index.branchIndex.has(bname)) {
      throw new Error(`${d.name}: controlling source '${d.vname}' not found (need a V device)`);
    }
    ctrl = xGuess ? branchCurrent(index, xGuess, bname) : 0;
    if (!Number.isFinite(ctrl)) ctrl = 0;
  } else {
    ctrl = volt(d.nc1) - volt(d.nc2);
  }
  const prevOn = state.swOn?.get(d.name);
  const on = switchIsOn(params, ctrl, prevOn);
  const g = 1 / (on ? params.ron : params.roff);
  stampG(G, ni(index, d.n1), ni(index, d.n2), g);
}

function resolveBranchName(index, vname) {
  const want = String(vname).toUpperCase();
  for (const name of index.branchIndex.keys()) {
    if (String(name).toUpperCase() === want) return name;
  }
  return vname;
}

function findInductor(circuit, name) {
  const want = String(name).toUpperCase();
  return circuit.devices.find(
    (d) => d.type === "L" && String(d.name).toUpperCase() === want
  );
}

/** Add M cross-coupling between inductor branches for TRAN. */
function stampMutualL(circuit, index, G, rhs, state, dt, trap) {
  for (const d of circuit.devices) {
    if (d.type !== "K") continue;
    const La = findInductor(circuit, d.l1);
    const Lb = findInductor(circuit, d.l2);
    if (!La || !Lb) {
      throw new Error(`${d.name}: coupled inductors '${d.l1}', '${d.l2}' not found`);
    }
    if (La === Lb) throw new Error(`${d.name}: cannot couple an inductor to itself`);
    const k1 = index.branchIndex.get(La.name);
    const k2 = index.branchIndex.get(Lb.name);
    if (k1 == null || k2 == null) continue;
    const M = d.k * Math.sqrt(passiveValue(La, circuit) * passiveValue(Lb, circuit));
    const Rm = trap ? (2 * M) / dt : M / dt;
    const i1p = state.iL?.get(La.name) ?? 0;
    const i2p = state.iL?.get(Lb.name) ?? 0;
    // v1 … - Rm * i2 = … - Rm * i2p  (and symmetric)
    G[k1][k2] -= Rm;
    G[k2][k1] -= Rm;
    rhs[k1] -= Rm * i2p;
    rhs[k2] -= Rm * i1p;
  }
}

export function nodeVoltage(index, x, node) {
  if (node === "0") return 0;
  const i = index.nodeIndex.get(node);
  return i === undefined ? NaN : x[i];
}

export function branchCurrent(index, x, name) {
  const i = index.branchIndex.get(name);
  return i === undefined ? NaN : x[i];
}

export function solveOnce(circuit, index, opts) {
  const { G, rhs } = stampSystem(circuit, index, opts);
  return solve(copyMat(G), copyVec(rhs));
}

export function solveNonlinear(circuit, index, opts = {}) {
  const maxIter = opts.maxIter ?? circuit.options?.maxIter ?? 80;
  const tol = opts.tol ?? circuit.options?.vntol ?? 1e-6;
  let x = opts.x0 ? opts.x0.slice() : zeroVec(index.n);

  for (let iter = 0; iter < maxIter; iter++) {
    let xNew;
    try {
      xNew = solveOnce(circuit, index, {
        ...opts,
        xGuess: x,
        gmin: opts.gmin ?? circuit.options?.gmin,
      });
    } catch {
      return { x, iterations: iter + 1, converged: false };
    }
    let maxDiff = 0;
    for (let i = 0; i < x.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(xNew[i] - x[i]));
    }
    // Damped update if step is huge (helps stiff NR)
    let alpha = 1;
    if (maxDiff > 5) alpha = 5 / maxDiff;
    for (let i = 0; i < x.length; i++) {
      x[i] = x[i] + alpha * (xNew[i] - x[i]);
    }
    if (maxDiff * alpha < tol) return { x, iterations: iter + 1, converged: true };
  }
  return { x, iterations: maxIter, converged: false };
}

/**
 * DC operating point with automatic Gmin stepping then source stepping on failure.
 */
export function dcOp(circuit) {
  const index = buildIndex(circuit);
  if (index.n === 0) throw new Error("No unknowns — add nodes other than ground");
  let x0 = applyNodeset(circuit, index, zeroVec(index.n));
  const gTarget = circuit.options?.gmin ?? 1e-12;
  const gminSteps = circuit.options?.gminSteps ?? 8;
  const srcSteps = circuit.options?.srcSteps ?? 10;

  let last = solveNonlinear(circuit, index, { mode: "dc", t: 0, x0, gmin: gTarget });
  let method = "direct";
  let iterations = last.iterations;

  if (!last.converged && gminSteps > 0) {
    method = "gmin";
    const gStart = Math.max(gTarget, 1e-3);
    x0 = applyNodeset(circuit, index, zeroVec(index.n));
    let ok = true;
    for (let s = 0; s < gminSteps; s++) {
      const u = gminSteps === 1 ? 1 : s / (gminSteps - 1);
      const gmin = gStart * Math.pow(gTarget / gStart, u);
      last = solveNonlinear(circuit, index, {
        mode: "dc",
        t: 0,
        x0,
        gmin,
      });
      iterations += last.iterations;
      if (!last.converged) {
        ok = false;
        break;
      }
      x0 = last.x.slice();
    }
    if (ok) {
      last = solveNonlinear(circuit, index, { mode: "dc", t: 0, x0, gmin: gTarget });
      iterations += last.iterations;
    }
  }

  if (!last.converged && srcSteps > 0) {
    method = "srcstep";
    x0 = applyNodeset(circuit, index, zeroVec(index.n));
    let ok = true;
    for (let s = 0; s <= srcSteps; s++) {
      const scale = s / srcSteps;
      last = solveNonlinear(circuit, index, {
        mode: "dc",
        t: 0,
        x0,
        gmin: gTarget,
        sourceScale: scale,
      });
      iterations += last.iterations;
      if (!last.converged) {
        ok = false;
        break;
      }
      x0 = last.x.slice();
    }
    if (ok) {
      last = solveNonlinear(circuit, index, {
        mode: "dc",
        t: 0,
        x0,
        gmin: gTarget,
        sourceScale: 1,
      });
      iterations += last.iterations;
    }
  }

  if (!last.converged) {
    throw new Error(
      `DC did not converge after ${iterations} NR iterations (tried direct → gmin → source stepping). Try .nodeset / .option gminsteps/srcsteps.`
    );
  }

  const x = last.x;
  const nodes = {};
  for (const name of index.nodeNames) {
    nodes[name] = nodeVoltage(index, x, name);
  }
  nodes["0"] = 0;

  const currents = {};
  for (const d of index.branchDevices) {
    currents[d.name] = branchCurrent(index, x, d.name);
  }

  return { index, x, nodes, currents, iterations, method };
}

export function captureState(circuit, index, x, prev = {}, opts = {}) {
  const { dt = 1e-6, method = "trap" } = opts;
  const trap = method === "trap";
  const vC = new Map();
  const iC = new Map();
  const iL = new Map();
  const vL = new Map();
  const vD = new Map();
  const iDcap = new Map();
  const vMosGs = new Map();
  const iMosGs = new Map();
  const vMosGd = new Map();
  const iMosGd = new Map();
  const vBjtBe = new Map();
  const iBjtBe = new Map();
  const vBjtBc = new Map();
  const iBjtBc = new Map();
  const swOn = new Map(prev.swOn || []);

  for (const d of circuit.devices) {
    if (d.type === "C") {
      const { a: na, b: nb } = capNodes(d);
      const v = nodeVoltage(index, x, na) - nodeVoltage(index, x, nb);
      vC.set(d.name, v);
      const vPrev = prev.vC?.get(d.name) ?? v;
      const iPrev = prev.iC?.get(d.name) ?? 0;
      const Cval = passiveValue(d, circuit);
      const Geq = trap ? (2 * Cval) / dt : Cval / dt;
      const Ieq = trap ? Geq * vPrev + iPrev : Geq * vPrev;
      iC.set(d.name, Geq * v - Ieq);
    } else if (d.type === "L") {
      const i = branchCurrent(index, x, d.name);
      iL.set(d.name, i);
      const v = nodeVoltage(index, x, d.n1) - nodeVoltage(index, x, d.n2);
      vL.set(d.name, v);
    } else if (d.type === "D") {
      const model = circuit.models.get(d.model) || circuit.models.get("DDEFAULT");
      const params = diodeParams(model);
      const mid = params.Rs > 0 ? diodeRsNode(d) : d.n2;
      const vd = nodeVoltage(index, x, d.n1) - nodeVoltage(index, x, mid);
      const { Gd } = diodeEval(params, vd);
      const C = diodeCapacitance(params, vd, Gd);
      vD.set(d.name, vd);
      if (C > 0) {
        const vPrev = prev.vD?.get(d.name) ?? vd;
        const iPrev = prev.iDcap?.get(d.name) ?? 0;
        const Geq = trap ? (2 * C) / dt : C / dt;
        const Ieq = trap ? Geq * vPrev + iPrev : Geq * vPrev;
        iDcap.set(d.name, Geq * vd - Ieq);
      } else {
        iDcap.set(d.name, 0);
      }
    } else if (d.type === "M") {
      const model = circuit.models.get(d.model);
      if (model) {
        const params = mosParams(model, d);
        const nodes = mosIntNodes(d, params);
        const vd = nodeVoltage(index, x, nodes.nd);
        const vg = nodeVoltage(index, x, nodes.ng);
        const vs = nodeVoltage(index, x, nodes.ns);
        const { region } = mosEval(params, vd, vg, vs);
        const { cgs, cgd, cgb } = mosCaps(params, region);
        const cgsTot = cgs + cgb;
        const vgs = vg - vs;
        const vgd = vg - vd;
        vMosGs.set(d.name, vgs);
        vMosGd.set(d.name, vgd);
        const capI = (C, v, vPrevKey, iPrevKey) => {
          if (!(C > 0)) return 0;
          const vPrev = prev[vPrevKey]?.get(d.name) ?? v;
          const iPrev = prev[iPrevKey]?.get(d.name) ?? 0;
          const Geq = trap ? (2 * C) / dt : C / dt;
          const Ieq = trap ? Geq * vPrev + iPrev : Geq * vPrev;
          return Geq * v - Ieq;
        };
        iMosGs.set(d.name, capI(cgsTot, vgs, "vMosGs", "iMosGs"));
        iMosGd.set(d.name, capI(cgd, vgd, "vMosGd", "iMosGd"));
      }
    } else if (d.type === "Q") {
      const model = circuit.models.get(d.model) || circuit.models.get("NPN");
      if (model) {
        const params = bjtParams(model);
        const nodes = bjtIntNodes(d, params);
        const vc = nodeVoltage(index, x, nodes.nc);
        const vb = nodeVoltage(index, x, nodes.nb);
        const ve = nodeVoltage(index, x, nodes.ne);
        const ev = bjtEval(params, vc, vb, ve);
        const { cbe, cbc } = bjtCaps(params, ev.Vbe, ev.Vbc, ev.gmF);
        const vbe = vb - ve;
        const vbc = vb - vc;
        vBjtBe.set(d.name, vbe);
        vBjtBc.set(d.name, vbc);
        const capI = (C, v, vPrevKey, iPrevKey) => {
          if (!(C > 0)) return 0;
          const vPrev = prev[vPrevKey]?.get(d.name) ?? v;
          const iPrev = prev[iPrevKey]?.get(d.name) ?? 0;
          const Geq = trap ? (2 * C) / dt : C / dt;
          const Ieq = trap ? Geq * vPrev + iPrev : Geq * vPrev;
          return Geq * v - Ieq;
        };
        iBjtBe.set(d.name, capI(cbe, vbe, "vBjtBe", "iBjtBe"));
        iBjtBc.set(d.name, capI(cbc, vbc, "vBjtBc", "iBjtBc"));
      }
    } else if (d.type === "S") {
      const model = circuit.models.get(d.model) || { type: "SW", params: {} };
      const params = switchParams(model);
      const vc =
        nodeVoltage(index, x, d.nc1) - nodeVoltage(index, x, d.nc2);
      const on = switchIsOn(params, vc, prev.swOn?.get(d.name));
      swOn.set(d.name, on);
    } else if (d.type === "W") {
      const model = circuit.models.get(d.model) || { type: "CSW", params: {} };
      const params = switchParams(model);
      const iname = resolveBranchName(index, d.vname);
      const ic = branchCurrent(index, x, iname);
      const on = switchIsOn(params, Number.isFinite(ic) ? ic : 0, prev.swOn?.get(d.name));
      swOn.set(d.name, on);
    }
  }
  return { vC, iC, iL, vL, vD, iDcap, vMosGs, iMosGs, vMosGd, iMosGd, vBjtBe, iBjtBe, vBjtBc, iBjtBc, swOn };
}

export function applyNodeset(circuit, index, x) {
  if (!circuit.nodeset?.size) return x;
  for (const [node, v] of circuit.nodeset) {
    const i = index.nodeIndex.get(node);
    if (i !== undefined) x[i] = v;
  }
  return x;
}

export function applyIc(circuit, index, state, x) {
  for (const [node, v] of circuit.ic || []) {
    const i = index.nodeIndex.get(node);
    if (i !== undefined) x[i] = v;
  }

  if (circuit.analysis?.uic) {
    for (const d of circuit.devices) {
      if (d.type === "C") {
        if (d.ic !== undefined) {
          state.vC.set(d.name, d.ic);
          const { a, b } = capNodes(d);
          const ia = index.nodeIndex.get(a);
          const ib = index.nodeIndex.get(b);
          if (ia !== undefined && ib === undefined) x[ia] = d.ic;
          else if (ia !== undefined && ib !== undefined) x[ia] = x[ib] + d.ic;
        } else {
          const v1 = circuit.ic?.has(d.n1) ? circuit.ic.get(d.n1) : 0;
          const v2 = circuit.ic?.has(d.n2) ? circuit.ic.get(d.n2) : 0;
          state.vC.set(d.name, v1 - v2);
        }
        state.iC.set(d.name, 0);
      }
      if (d.type === "L") {
        state.iL.set(d.name, d.ic !== undefined ? d.ic : 0);
        state.vL.set(d.name, 0);
      }
    }
  }
  return { state, x };
}

/** Linearized device conductances at DC bias — used by AC. */
export function linearizeAt(circuit, index, x) {
  const lin = {
    diodes: [],
    mosfets: [],
    bjts: [],
    switches: [],
    behavioral: [],
  };
  const volt = (node) => nodeVoltage(index, x, node);

  for (const d of circuit.devices) {
    if (d.type === "B") {
      const { f0, partials } = behavioralPartials(circuit, d, volt, 0);
      lin.behavioral.push({
        name: d.name,
        n1: d.n1,
        n2: d.n2,
        btype: d.btype,
        f0,
        partials,
      });
    } else if (d.type === "D") {
      const model = circuit.models.get(d.model) || circuit.models.get("DDEFAULT");
      const params = diodeParams(model);
      const mid = params.Rs > 0 ? diodeRsNode(d) : d.n2;
      const vd = volt(d.n1) - volt(mid);
      const { Id, Gd } = diodeEval(params, vd);
      const Cj = diodeCapacitance(params, vd, Gd);
      lin.diodes.push({
        name: d.name,
        n1: d.n1,
        n2: mid,
        Gd,
        Id,
        Cj,
        rs: params.Rs > 0 ? { mid, n2: d.n2, g: 1 / params.Rs } : null,
        kf: model?.params?.kf ?? 0,
        af: model?.params?.af ?? 1,
      });
    } else if (d.type === "M") {
      const model = circuit.models.get(d.model);
      const params = mosParams(model, d);
      const nodes = mosIntNodes(d, params);
      const { Id, gm, gds, region } = mosEval(
        params,
        volt(nodes.nd),
        volt(nodes.ng),
        volt(nodes.ns)
      );
      const caps = mosCaps(params, region);
      lin.mosfets.push({
        name: d.name,
        nd: nodes.nd,
        ng: nodes.ng,
        ns: nodes.ns,
        gm,
        gds,
        Id: Math.abs(Id),
        cgs: caps.cgs + caps.cgb,
        cgd: caps.cgd,
        rd: nodes.rd,
        rs: nodes.rs,
        kf: model?.params?.kf ?? 0,
        af: model?.params?.af ?? 1,
        w: params.W,
        l: params.L,
      });
    } else if (d.type === "Q") {
      const model = circuit.models.get(d.model) || circuit.models.get("NPN");
      const params = bjtParams(model);
      const nodes = bjtIntNodes(d, params);
      const ev = bjtEval(params, volt(nodes.nc), volt(nodes.nb), volt(nodes.ne));
      const caps = bjtCaps(params, ev.Vbe, ev.Vbc, ev.gmF);
      lin.bjts.push({
        name: d.name,
        nc: nodes.nc,
        nb: nodes.nb,
        ne: nodes.ne,
        ...ev,
        cbe: caps.cbe,
        cbc: caps.cbc,
        rc: nodes.rc,
        rb: nodes.rb,
        re: nodes.re,
        kf: model?.params?.kf ?? 0,
        af: model?.params?.af ?? 1,
      });
    } else if (d.type === "S") {
      const model = circuit.models.get(d.model) || { type: "SW", params: {} };
      const params = switchParams(model);
      const vc = volt(d.nc1) - volt(d.nc2);
      const on = switchIsOn(params, vc, undefined);
      lin.switches.push({
        name: d.name,
        n1: d.n1,
        n2: d.n2,
        g: 1 / (on ? params.ron : params.roff),
      });
    } else if (d.type === "W") {
      const model = circuit.models.get(d.model) || { type: "CSW", params: {} };
      const params = switchParams(model);
      const iname = resolveBranchName(index, d.vname);
      const ic = branchCurrent(index, x, iname);
      const on = switchIsOn(params, Number.isFinite(ic) ? ic : 0, undefined);
      lin.switches.push({
        name: d.name,
        n1: d.n1,
        n2: d.n2,
        g: 1 / (on ? params.ron : params.roff),
      });
    }
  }
  return lin;
}
