import { parseNumber } from "../units.js";

/**
 * Parse .step directives.
 * Supported:
 *   .step param Rload list 1k 2k 5k
 *   .step param Rload lin 1k 10k 5
 *   .step param Rload dec 1k 1Meg 3
 *   .step lin Rload 1k 10k 5
 *   .step dec Rload 1k 1Meg 3
 * Returns null if none, or { param, values }.
 */
export function parseSteps(text) {
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const semi = line.indexOf(";");
    if (semi >= 0) line = line.slice(0, semi).trim();
    const low = line.toLowerCase();
    if (!low.startsWith(".step")) continue;

    const parts = line.split(/\s+/);
    // parts[0]=.step
    let i = 1;
    if (parts[i]?.toLowerCase() === "param") i++;

    let mode = null;
    if (/^(lin|dec|oct|list)$/i.test(parts[i])) {
      mode = parts[i++].toLowerCase();
    }

    const param = parts[i++];
    if (!param) throw new Error(".step needs a parameter name");

    // Allow ".step param Rload list 1k 2k" (mode after name)
    if (!mode && /^(lin|dec|oct|list)$/i.test(parts[i])) {
      mode = parts[i++].toLowerCase();
    }
    mode = mode || "list";

    const rest = parts.slice(i);
    if (!rest.length) throw new Error(`.step ${param}: need values`);

    let values;
    if (mode === "list") {
      values = rest.map((t) => parseNumber(t));
    } else if (mode === "lin") {
      if (rest.length < 3) throw new Error(".step lin needs start stop npoints");
      const start = parseNumber(rest[0]);
      const stop = parseNumber(rest[1]);
      const n = Math.max(2, Math.floor(parseNumber(rest[2])));
      values = [];
      for (let k = 0; k < n; k++) values.push(start + ((stop - start) * k) / (n - 1));
    } else if (mode === "dec") {
      if (rest.length < 3) throw new Error(".step dec needs start stop points_per_decade");
      const start = parseNumber(rest[0]);
      const stop = parseNumber(rest[1]);
      const ppd = Math.max(1, Math.floor(parseNumber(rest[2])));
      if (!(start > 0 && stop >= start)) throw new Error(".step dec needs start>0");
      const decades = Math.log10(stop / start);
      const total = Math.max(2, Math.floor(decades * ppd) + 1);
      values = [];
      for (let k = 0; k < total; k++) {
        values.push(start * Math.pow(10, (decades * k) / (total - 1)));
      }
    } else if (mode === "oct") {
      if (rest.length < 3) throw new Error(".step oct needs start stop points_per_octave");
      const start = parseNumber(rest[0]);
      const stop = parseNumber(rest[1]);
      const ppo = Math.max(1, Math.floor(parseNumber(rest[2])));
      if (!(start > 0 && stop >= start)) throw new Error(".step oct needs start>0");
      const octaves = Math.log2(stop / start);
      const total = Math.max(2, Math.floor(octaves * ppo) + 1);
      values = [];
      for (let k = 0; k < total; k++) {
        values.push(start * Math.pow(2, (octaves * k) / (total - 1)));
      }
    } else {
      throw new Error(`.step: unknown mode ${mode}`);
    }

    return { param: param.toLowerCase(), values };
  }
  return null;
}

/**
 * Inject/override `.param name=value` so braces expand to the stepped value.
 */
export function applyStepParam(text, param, value) {
  const name = String(param);
  const line = `.param ${name}=${formatNum(value)}`;
  const lines = text.split(/\r?\n/);
  let replaced = false;
  const out = lines.map((raw) => {
    const t = raw.trim();
    if (!t.toLowerCase().startsWith(".param")) return raw;
    // Replace assignment for this name if present
    const re = new RegExp(`\\b${name}\\s*=`, "i");
    if (!re.test(t)) return raw;
    replaced = true;
    // rewrite only this param's assignment; keep others on same line
    return raw.replace(
      new RegExp(`(\\b${name}\\s*=\\s*)([^\\s=]+)`, "i"),
      `$1${formatNum(value)}`
    );
  });
  if (!replaced) {
    let idx = 0;
    while (idx < out.length) {
      const t = out[idx].trim();
      if (t === "" || t.startsWith("*")) {
        idx++;
        continue;
      }
      break;
    }
    out.splice(idx, 0, line);
  }
  return out.join("\n");
}

export function formatStepLabel(v) {
  const a = Math.abs(v);
  if (a === 0) return "0";
  const fmt = (x) => {
    const s = Number(x.toPrecision(4));
    return String(s);
  };
  if (a >= 1e6) return `${fmt(v / 1e6)}Meg`;
  if (a >= 1e3) return `${fmt(v / 1e3)}k`;
  if (a >= 1) return fmt(v);
  if (a >= 1e-3) return `${fmt(v / 1e-3)}m`;
  if (a >= 1e-6) return `${fmt(v / 1e-6)}u`;
  if (a >= 1e-9) return `${fmt(v / 1e-9)}n`;
  if (a >= 1e-12) return `${fmt(v / 1e-12)}p`;
  return v.toExponential(3);
}

function formatNum(v) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(8);
  return String(Number(v.toPrecision(12)));
}

/** Interpolate ys@fromTimes onto toTimes. */
export function resampleSeries(fromTimes, ys, toTimes) {
  const out = new Array(toTimes.length);
  let j = 0;
  for (let i = 0; i < toTimes.length; i++) {
    const t = toTimes[i];
    while (j < fromTimes.length - 2 && fromTimes[j + 1] < t) j++;
    const t0 = fromTimes[j];
    const t1 = fromTimes[Math.min(j + 1, fromTimes.length - 1)];
    const y0 = ys[j];
    const y1 = ys[Math.min(j + 1, ys.length - 1)];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) {
      out[i] = y0;
      continue;
    }
    const u = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
    out[i] = y0 * (1 - u) + y1 * u;
  }
  return out;
}
