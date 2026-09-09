import { transient } from "./transient.js";
import { evalFourier } from "./fourier.js";
import { freqPoints } from "./ac.js";
import { sourceAc } from "../netlist/parser.js";

/**
 * Large-signal harmonic distortion sweep (TRAN + Fourier).
 *
 * .disto [V(out[,ref])] dec|lin|oct N fstart fstop
 *
 * Drives V/I sources that have AC mag with SIN(0, |ac|, f) at each frequency,
 * runs a short TRAN (≈3 periods), extracts HD2/HD3/THD of the output.
 */
export function distoAnalysis(circuit, { onProgress, signal } = {}) {
  const analysis = circuit.analysis?.type === "disto" ? circuit.analysis : null;
  if (!analysis) throw new Error("No .disto directive in netlist");

  const outNode = analysis.outNode || "out";
  const refNode = analysis.refNode || "0";
  const sigName =
    refNode === "0" || refNode === outNode
      ? `v(${outNode})`
      : `v(${outNode},${refNode})`;

  const drivers = circuit.devices.filter(
    (d) => (d.type === "V" || d.type === "I") && (sourceAc(d).mag || 0) > 0
  );
  if (!drivers.length) {
    throw new Error(".disto: need at least one V/I source with AC magnitude");
  }

  const freqs = freqPoints(analysis);
  const series = {
    hd2: [],
    hd3: [],
    thd: [],
    [`db(${sigName})`]: [],
  };

  const saved = drivers.map((d) => ({
    d,
    value: d.value,
    waveform: d.waveform,
  }));

  try {
    for (let i = 0; i < freqs.length; i++) {
      if (signal?.aborted) {
        return pack(freqs.slice(0, i), series, analysis, outNode, true);
      }
      const f = freqs[i];
      const T = 1 / f;
      for (const { d } of saved) {
        const mag = Math.abs(sourceAc(d).mag);
        d.waveform = {
          type: "sin",
          vo: 0,
          va: mag,
          freq: f,
          td: 0,
          theta: 0,
          phase: sourceAc(d).phase || 0,
        };
        d.value = 0;
      }

      const nPer = 40;
      const nCycles = 3;
      const tstep = T / nPer;
      const tstop = T * nCycles;
      const tran = transient(circuit, {
        tstep,
        tstop,
        adaptive: false,
        signal,
      });

      // Build differential series if needed
      let ys = tran.series[sigName] || tran.series[sigName.toLowerCase()];
      if (!ys && refNode !== "0") {
        const a = tran.series[`v(${outNode})`];
        const b = tran.series[`v(${refNode})`];
        if (a && b) {
          ys = a.map((v, k) => v - b[k]);
          tran.series[sigName] = ys;
        }
      }
      if (!ys) {
        // fallback: first voltage that isn't a driver node
        const key = Object.keys(tran.series).find((k) => k.startsWith("v("));
        if (!key) throw new Error(`.disto: output ${sigName} not in TRAN result`);
        ys = tran.series[key];
        tran.series[sigName] = ys;
      }

      const [four] = evalFourier(
        tran,
        [{ freq: f, signals: [sigName] }],
        { nharm: 5 }
      );
      if (four?.error) throw new Error(four.error);
      const h1 = four.harmonics[1]?.mag || 0;
      const h2 = four.harmonics[2]?.mag || 0;
      const h3 = four.harmonics[3]?.mag || 0;
      series.hd2.push(h1 > 1e-30 ? h2 / h1 : 0);
      series.hd3.push(h1 > 1e-30 ? h3 / h1 : 0);
      series.thd.push(four.thd || 0);
      series[`db(${sigName})`].push(20 * Math.log10(Math.max(h1, 1e-30)));

      onProgress?.((i + 1) / freqs.length);
    }
  } finally {
    for (const s of saved) {
      s.d.value = s.value;
      s.d.waveform = s.waveform;
    }
  }

  return pack(freqs, series, analysis, outNode, false);
}

function pack(freqs, series, analysis, outNode, aborted) {
  return {
    times: freqs,
    series,
    aborted,
    xScale: "log",
    xUnit: "Hz",
    points: freqs.length,
    analysis: "disto",
    outNode,
    variation: analysis.variation,
  };
}
