import { dcOp, linearizeAt, passiveValue } from "./circuit.js";
import { stampAcSystem, freqPoints } from "./ac.js";
import {
  solveComplex,
  copyCMat,
  copyCVec,
  czeroVec,
  cabs,
} from "./matrix.js";

const K_BOLTZ = 1.380649e-23;
const Q_E = 1.60217662e-19;

function ni(index, node) {
  if (node === "0") return -1;
  return index.nodeIndex.get(node) ?? -1;
}

function outVoltage(index, x, outNode, refNode) {
  const vo = outNode === "0" ? { re: 0, im: 0 } : x[index.nodeIndex.get(outNode)];
  const vr = refNode === "0" ? { re: 0, im: 0 } : x[index.nodeIndex.get(refNode)];
  if (!vo) return { re: 0, im: 0 };
  return { re: vo.re - (vr?.re || 0), im: vo.im - (vr?.im || 0) };
}

/** |H| from unit current nA→nB to differential output. */
function transferCurrentToOut(Ytemplate, index, nA, nB, outNode, refNode) {
  const Y = copyCMat(Ytemplate);
  const rhs = czeroVec(index.n);
  const a = ni(index, nA);
  const b = ni(index, nB);
  if (a >= 0) rhs[a].re -= 1;
  if (b >= 0) rhs[b].re += 1;
  const x = solveComplex(Y, rhs);
  return cabs(outVoltage(index, x, outNode, refNode));
}

/** Flicker current PSD: kf * |I|^af / f^ef  (ef default 1). */
function flickerPsd(kf, af, I, f, ef = 1) {
  if (!(kf > 0) || f <= 0) return 0;
  const a = Math.abs(I);
  if (a < 1e-30) return 0;
  return (kf * Math.pow(a, af)) / Math.pow(f, ef);
}

/** Trapezoidal ∫ dens^2 df → total mean-square; return RMS. */
export function integrateNoiseRms(freqs, dens) {
  if (!freqs?.length || freqs.length !== dens.length) return 0;
  let acc = 0;
  for (let i = 1; i < freqs.length; i++) {
    const df = freqs[i] - freqs[i - 1];
    if (df <= 0) continue;
    const p0 = dens[i - 1] * dens[i - 1];
    const p1 = dens[i] * dens[i];
    acc += 0.5 * (p0 + p1) * df;
  }
  return Math.sqrt(Math.max(acc, 0));
}

/**
 * .noise V(out[,ref]) src dec|lin|oct N fstart fstop
 * Uses circuit.options.tempC (default 27°C).
 * Model flicker: .model … D/NPN/NMOS (Kf=… Af=…)
 */
export function noiseAnalysis(circuit, { onProgress, signal } = {}) {
  const analysis = circuit.analysis?.type === "noise" ? circuit.analysis : null;
  if (!analysis) throw new Error("No .noise directive in netlist");

  const { outNode, refNode, srcName, variation, n, fstart, fstop } = analysis;
  const tempC = circuit.options?.tempC ?? 27;
  const temp = tempC + 273.15;

  const dc = dcOp(circuit);
  const index = dc.index;
  const lin = linearizeAt(circuit, index, dc.x);
  const freqs = freqPoints({ variation, n, fstart, fstop });

  const kT = K_BOLTZ * temp;
  const series = {
    onoise: [],
    "onoise^2": [],
  };
  if (srcName) {
    series.inoise = [];
    series["inoise^2"] = [];
    series["db(gain)"] = [];
  }

  for (let fi = 0; fi < freqs.length; fi++) {
    if (signal?.aborted) {
      return {
        times: freqs.slice(0, fi),
        series,
        aborted: true,
        dc,
        xScale: "log",
        xUnit: "Hz",
        tempC,
      };
    }

    const f = freqs[fi];
    const omega = 2 * Math.PI * f;
    const { Y } = stampAcSystem(circuit, index, lin, omega);

    let outPsd = 0;

    // Resistor thermal
    for (const d of circuit.devices) {
      if (d.type !== "R") continue;
      const H = transferCurrentToOut(Y, index, d.n1, d.n2, outNode, refNode);
      outPsd += H * H * ((4 * kT) / passiveValue(d, circuit));
    }

    // Diode: shot + flicker
    for (const d of lin.diodes) {
      const Id = Math.abs(d.Id || 0);
      const H = transferCurrentToOut(Y, index, d.n1, d.n2, outNode, refNode);
      const H2 = H * H;
      if (Id > 1e-30) outPsd += H2 * (2 * Q_E * Id);
      outPsd += H2 * flickerPsd(d.kf, d.af ?? 1, Id, f);
    }

    // BJT: shot Ic/Ib + flicker on Ib
    for (const q of lin.bjts || []) {
      const Ic = Math.abs(q.Ic || 0);
      const Ib = Math.abs(q.Ib || 0);
      if (Ic > 1e-30) {
        const H = transferCurrentToOut(Y, index, q.nc, q.ne, outNode, refNode);
        outPsd += H * H * (2 * Q_E * Ic);
      }
      if (Ib > 1e-30) {
        const H = transferCurrentToOut(Y, index, q.nb, q.ne, outNode, refNode);
        const H2 = H * H;
        outPsd += H2 * (2 * Q_E * Ib);
        outPsd += H2 * flickerPsd(q.kf, q.af ?? 1, Ib, f);
      }
    }

    // MOSFET: channel thermal + flicker
    for (const m of lin.mosfets) {
      const gm = Math.abs(m.gm || 0);
      const Id = Math.abs(m.Id || 0);
      const H = transferCurrentToOut(Y, index, m.nd, m.ns, outNode, refNode);
      const H2 = H * H;
      if (gm > 1e-30) outPsd += H2 * ((8 / 3) * kT * gm);
      // SPICE-ish: Kf*Id^Af/(f*Cox*L^2) ≈ Kf*Id^Af/(f*L^2) with Cox folded into Kf
      const L = m.l || 1e-6;
      const flick = flickerPsd(m.kf, m.af ?? 1, Id, f) / (L * L);
      outPsd += H2 * flick;
    }

    const onoise = Math.sqrt(Math.max(outPsd, 0));
    series.onoise.push(onoise);
    series["onoise^2"].push(outPsd);

    if (srcName) {
      const src = circuit.devices.find((d) => d.name.toUpperCase() === srcName.toUpperCase());
      let gainMag = 0;
      if (src && src.type === "V") {
        const Yg = copyCMat(Y);
        const rhs = czeroVec(index.n);
        const k = index.branchIndex.get(src.name);
        if (k !== undefined) {
          rhs[k].re = 1;
          const x = solveComplex(Yg, rhs);
          gainMag = cabs(outVoltage(index, x, outNode, refNode));
        }
      } else if (src && src.type === "I") {
        gainMag = transferCurrentToOut(Y, index, src.n1, src.n2, outNode, refNode);
      }
      const gain2 = gainMag * gainMag;
      const inPsd = gain2 > 1e-60 ? outPsd / gain2 : 0;
      series.inoise.push(Math.sqrt(Math.max(inPsd, 0)));
      series["inoise^2"].push(inPsd);
      series["db(gain)"].push(20 * Math.log10(Math.max(gainMag, 1e-30)));
    }

    if (onProgress && fi % 4 === 0) onProgress((fi + 1) / freqs.length);
  }

  const totalOnoise = integrateNoiseRms(freqs, series.onoise);
  const totalInoise = series.inoise ? integrateNoiseRms(freqs, series.inoise) : null;

  return {
    times: freqs,
    series,
    aborted: false,
    dc,
    xScale: "log",
    xUnit: "Hz",
    points: freqs.length,
    analysis: "noise",
    outNode,
    refNode,
    srcName,
    tempC,
    totalOnoise,
    totalInoise,
  };
}
