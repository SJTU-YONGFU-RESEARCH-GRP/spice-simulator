import { parseNumber } from "../units.js";

/**
 * Parse .four lines:
 *   .four 1k v(out)
 *   .four 1k v(out) v(in)
 */
export function parseFours(text) {
  const list = [];
  for (const raw of (text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const semi = line.indexOf(";");
    if (semi >= 0) line = line.slice(0, semi).trim();
    if (!line.toLowerCase().startsWith(".four")) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 3) throw new Error(".four needs freq and at least one signal");
    const freq = parseNumber(parts[1]);
    if (!(freq > 0)) throw new Error(".four frequency must be > 0");
    const signals = parts.slice(2).map((s) => s.toLowerCase());
    list.push({ freq, signals });
  }
  return list;
}

/**
 * SPICE-like Fourier of the last fundamental period of a TRAN result.
 * Returns [{ signal, freq, harmonics: [{ n, mag, phaseDeg, freq }], thd }]
 */
export function evalFourier(tranResult, specs, opts = {}) {
  const nharm = opts.nharm ?? 9;
  const times = tranResult?.times;
  const series = tranResult?.series;
  if (!times?.length || !series) throw new Error(".four needs a TRAN waveform");

  const out = [];
  for (const spec of specs) {
    const T = 1 / spec.freq;
    const tEnd = times[times.length - 1];
    const tStart = tEnd - T;
    if (tStart < times[0] - T * 1e-9) {
      throw new Error(
        `.four ${spec.freq}: need at least one period in TRAN (tstop >= 1/f)`
      );
    }
    for (const sig of spec.signals) {
      const ys = resolveSeries(series, sig);
      if (!ys) {
        out.push({ signal: sig, freq: spec.freq, error: `signal ${sig} not found` });
        continue;
      }
      const harmonics = correlate(times, ys, tStart, tEnd, spec.freq, nharm);
      const fund = harmonics[1]?.mag || 0;
      let thd = 0;
      if (fund > 1e-30) {
        let acc = 0;
        for (let n = 2; n <= nharm; n++) acc += (harmonics[n].mag || 0) ** 2;
        thd = Math.sqrt(acc) / fund;
      }
      out.push({
        signal: sig,
        freq: spec.freq,
        harmonics,
        thd,
        tStart,
        tEnd,
      });
    }
  }
  return out;
}

function resolveSeries(series, signal) {
  const key = signal.toLowerCase();
  if (series[key]) return series[key];
  for (const k of Object.keys(series)) {
    if (k.toLowerCase() === key) return series[k];
  }
  return null;
}

function correlate(times, ys, tStart, tEnd, f0, nharm) {
  const T = tEnd - tStart;
  const harmonics = [];
  for (let n = 0; n <= nharm; n++) {
    let cSum = 0;
    let sSum = 0;
    let wSum = 0;
    for (let i = 1; i < times.length; i++) {
      const tA = times[i - 1];
      const tB = times[i];
      if (tB <= tStart || tA >= tEnd) continue;
      const a = Math.max(tA, tStart);
      const b = Math.min(tB, tEnd);
      if (b <= a) continue;
      const u0 = (a - tA) / (tB - tA || 1);
      const u1 = (b - tA) / (tB - tA || 1);
      const yA = ys[i - 1] * (1 - u0) + ys[i] * u0;
      const yB = ys[i - 1] * (1 - u1) + ys[i] * u1;
      const dt = b - a;
      const tm = 0.5 * (a + b);
      const ym = 0.5 * (yA + yB);
      if (n === 0) {
        cSum += ym * dt;
        wSum += dt;
      } else {
        const w = 2 * Math.PI * n * f0;
        cSum += ym * Math.cos(w * tm) * dt;
        sSum += ym * Math.sin(w * tm) * dt;
        wSum += dt;
      }
    }
    if (n === 0) {
      const mag = wSum > 0 ? cSum / T : 0;
      harmonics.push({ n: 0, mag, phaseDeg: 0, freq: 0 });
    } else {
      const ck = (2 / T) * cSum;
      const sk = (2 / T) * sSum;
      const mag = Math.hypot(ck, sk);
      let phaseDeg = (Math.atan2(sk, ck) * 180) / Math.PI;
      harmonics.push({ n, mag, phaseDeg, freq: n * f0 });
    }
  }
  return harmonics;
}
