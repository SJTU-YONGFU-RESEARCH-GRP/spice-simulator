import {
  dcOp,
  linearizeAt,
  nodeVoltage,
  branchCurrent,
} from "./circuit.js";
import { stampAcSystem } from "./ac.js";
import { solveComplex, copyCMat, copyCVec } from "./matrix.js";

/**
 * .tf V(out[,ref]) src
 * Small-signal DC transfer function, input Z, output Z (SPICE-like).
 */
export function tfAnalysis(circuit) {
  const analysis = circuit.analysis?.type === "tf" ? circuit.analysis : null;
  if (!analysis) throw new Error("No .tf directive in netlist");

  const { outNode, refNode, srcName } = analysis;
  const src = circuit.devices.find(
    (d) => d.name.toUpperCase() === String(srcName).toUpperCase()
  );
  if (!src || (src.type !== "V" && src.type !== "I")) {
    throw new Error(`.tf source '${srcName}' must be a V or I device`);
  }

  const dc = dcOp(circuit);
  const { index, x } = dc;
  const lin = linearizeAt(circuit, index, x);

  const savedAc = [];
  for (const d of circuit.devices) {
    if (d.type === "V" || d.type === "I") {
      savedAc.push([d, d.ac]);
    }
  }

  const setSources = (activeName, mag) => {
    for (const d of circuit.devices) {
      if (d.type !== "V" && d.type !== "I") continue;
      const on = d.name.toUpperCase() === String(activeName).toUpperCase();
      const m = on ? mag : 0;
      d.ac = { mag: m, phase: 0, re: m, im: 0 };
    }
  };

  const restoreAc = () => {
    for (const [d, ac] of savedAc) d.ac = ac;
  };

  try {
    // --- Transfer + Zin: drive source with unit stimulus ---
    setSources(srcName, 1);
    const { Y, rhs } = stampAcSystem(circuit, index, lin, 0);
    const xf = solveComplex(copyCMat(Y), copyCVec(rhs));

    const vOut = complexNodeDiff(index, xf, outNode, refNode);
    const transfer = vOut.re; // ω=0 → real

    let zin = NaN;
    if (src.type === "V") {
      const iin = branchCurrent(index, realPart(xf), src.name);
      // SPICE: current out of + terminal; Zin = Vin / (-I) with our MNA sign
      zin = Math.abs(iin) > 1e-30 ? 1 / -iin : Infinity;
    } else {
      // Current source drive: Zin = Vacross / I
      const vSrc = complexNodeDiff(index, xf, src.n1, src.n2).re;
      zin = vSrc; // I=1
    }

    // --- Zout: zero independent sources, inject 1A into out ---
    setSources("__none__", 0);
    const stamped = stampAcSystem(circuit, index, lin, 0);
    const Y2 = stamped.Y;
    const rhs2 = stamped.rhs;
    const oi = nodeIndex(index, outNode);
    const ri = nodeIndex(index, refNode);
    // Inject +1A into out (return through ref) → positive Rout for passives
    if (oi >= 0) rhs2[oi].re += 1;
    if (ri >= 0) rhs2[ri].re -= 1;
    const xo = solveComplex(copyCMat(Y2), copyCVec(rhs2));
    const zout = complexNodeDiff(index, xo, outNode, refNode).re;

    return {
      analysis: "tf",
      transfer,
      zin,
      zout,
      outNode,
      refNode,
      srcName: src.name,
      srcType: src.type,
      dc,
      // minimal plot payload so UI still works
      times: [0],
      series: {
        tf: [transfer],
        zin: [zin],
        zout: [zout],
      },
      xScale: "lin",
      xUnit: "",
    };
  } finally {
    restoreAc();
  }
}

function nodeIndex(index, node) {
  if (node === "0") return -1;
  return index.nodeIndex.get(node) ?? -1;
}

function complexNodeDiff(index, x, a, b) {
  const ia = nodeIndex(index, a);
  const ib = nodeIndex(index, b);
  const va = ia >= 0 ? x[ia] : { re: 0, im: 0 };
  const vb = ib >= 0 ? x[ib] : { re: 0, im: 0 };
  return { re: va.re - vb.re, im: va.im - vb.im };
}

function realPart(x) {
  return x.map((c) => c.re);
}
