/**
 * Uniform resample + Hann window + radix-2 real FFT → magnitude spectrum.
 */

export function spectrumFromTransient(times, seriesMap, selected, opts = {}) {
  const nWant = opts.nfft || 1024;
  if (!times?.length || times.length < 8) {
    throw new Error("FFT needs a TRAN waveform with enough points");
  }
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const dur = t1 - t0;
  if (!(dur > 0)) throw new Error("FFT needs non-zero time span");

  const n = nextPow2(Math.min(nWant, 4096));
  const dt = dur / n;
  const fs = 1 / dt;

  const freqs = [];
  const half = n / 2;
  for (let k = 0; k <= half; k++) freqs.push((k * fs) / n);

  const series = {};
  const names = selected?.length ? selected : Object.keys(seriesMap).slice(0, 3);
  for (const name of names) {
    const ys = seriesMap[name];
    if (!ys) continue;
    const uni = resample(times, ys, t0, dt, n);
    const win = hann(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = uni[i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    // coherent gain of Hann ≈ 0.5; scale to amplitude
    const scale = 2 / (n * 0.5);
    const mag = new Array(half + 1);
    for (let k = 0; k <= half; k++) {
      const m = Math.hypot(re[k], im[k]) * (k === 0 || k === half ? scale / 2 : scale);
      mag[k] = m;
    }
    series[`|${name}|`] = mag;
  }

  return {
    times: freqs,
    series,
    xScale: "log",
    xUnit: "Hz",
    analysis: "fft",
    fs,
    nfft: n,
  };
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return Math.max(16, p);
}

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1 || 1)));
  return w;
}

function resample(times, ys, t0, dt, n) {
  const out = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = t0 + i * dt;
    while (j < times.length - 2 && times[j + 1] < t) j++;
    const t0s = times[j];
    const t1s = times[Math.min(j + 1, times.length - 1)];
    const y0 = ys[j];
    const y1 = ys[Math.min(j + 1, ys.length - 1)];
    const u = t1s === t0s ? 0 : (t - t0s) / (t1s - t0s);
    out[i] = y0 * (1 - u) + y1 * u;
  }
  return out;
}

/** In-place Cooley–Tukey radix-2 FFT */
export function fftInPlace(re, im) {
  const n = re.length;
  if (n !== im.length || (n & (n - 1)) !== 0) {
    throw new Error("FFT length must be power of 2");
  }
  // bit-reverse
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
        const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;
        const nWRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nWRe;
      }
    }
  }
}
