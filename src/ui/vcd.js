/**
 * Export TRAN results as IEEE Verilog VCD (real voltages as scaled integers).
 * timescale from median dt; values in microvolts (1e-6 V) by default.
 */

export function resultToVcd(result, opts = {}) {
  if (!result?.times?.length) return "";
  const scale = opts.scale ?? 1e6; // store as µV
  const unit = opts.unit ?? "uV";
  const times = result.times;
  const series = result.series;

  // Prefer node voltages
  let names = Object.keys(series).filter((n) => /^v\(/i.test(n));
  if (!names.length) names = Object.keys(series).slice(0, 16);

  let dt = 1e-9;
  if (times.length > 1) {
    const steps = [];
    for (let i = 1; i < Math.min(times.length, 64); i++) {
      const d = times[i] - times[i - 1];
      if (d > 0) steps.push(d);
    }
    steps.sort((a, b) => a - b);
    dt = steps[Math.floor(steps.length / 2)] || dt;
  }
  const ts = pickTimescale(dt);

  const idChars = "!\"#$%&'()*+,-./:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
  const ids = names.map((_, i) => idChars[i % idChars.length] + (i >= idChars.length ? String(i) : ""));

  const lines = [];
  lines.push(`$date ${new Date().toUTCString()} $end`);
  lines.push(`$version spice-simulator $end`);
  lines.push(`$timescale ${ts.value}${ts.unit} $end`);
  lines.push(`$scope module top $end`);
  names.forEach((n, i) => {
    const bits = 32;
    lines.push(`$var integer ${bits} ${ids[i]} ${sanitize(n)} $end`);
  });
  lines.push(`$upscope $end`);
  lines.push(`$enddefinitions $end`);

  let last = names.map(() => null);
  for (let ti = 0; ti < times.length; ti++) {
    const tTick = Math.round(times[ti] / ts.seconds);
    let changed = false;
    const updates = [];
    names.forEach((n, i) => {
      const v = Math.round((series[n][ti] ?? 0) * scale);
      if (last[i] !== v) {
        last[i] = v;
        changed = true;
        updates.push(`b${(v >>> 0).toString(2).padStart(32, "0")} ${ids[i]}`);
      }
    });
    if (ti === 0 || changed) {
      lines.push(`#${tTick}`);
      for (const u of updates) lines.push(u);
      // comment scale
      if (ti === 0) lines.push(`$comment values in ${unit} (scale ${scale}) $end`);
    }
  }
  return lines.join("\n") + "\n";
}

function sanitize(name) {
  return name.replace(/[^\w().]/g, "_");
}

function pickTimescale(dt) {
  const units = [
    [1, "s"],
    [1e-3, "ms"],
    [1e-6, "us"],
    [1e-9, "ns"],
    [1e-12, "ps"],
    [1e-15, "fs"],
  ];
  for (const [seconds, unit] of units) {
    if (dt >= seconds) {
      const value = Math.max(1, Math.round(dt / seconds));
      return { value, unit, seconds: value * seconds };
    }
  }
  return { value: 1, unit: "fs", seconds: 1e-15 };
}

export function downloadText(filename, text, mime = "text/plain") {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
