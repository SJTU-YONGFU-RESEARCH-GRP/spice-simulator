/** Parse SPICE-style numbers: 1k, 4.7u, 10Meg, 5m, 1e-3 */
export function parseNumber(raw) {
  const s = String(raw).trim();
  if (!s) throw new Error(`Empty number`);

  const m = s.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(Meg|[tTgGkKmMuUnNpPfF])?(.*)$/);
  if (!m) throw new Error(`Bad number: ${raw}`);

  let value = parseFloat(m[1]);
  const suffix = m[2] || "";
  const rest = (m[3] || "").toLowerCase();

  const scale = {
    T: 1e12,
    t: 1e12,
    G: 1e9,
    g: 1e9,
    Meg: 1e6,
    k: 1e3,
    K: 1e3,
    m: 1e-3,
    u: 1e-6,
    U: 1e-6,
    n: 1e-9,
    N: 1e-9,
    p: 1e-12,
    P: 1e-12,
    f: 1e-15,
    F: 1e-15,
  };

  if (suffix) {
    // Ambiguous: "m" can be milli or start of "meg" — Meg already matched
    value *= scale[suffix];
  }

  // Ignore unit letters like V, A, Ohm, s, F, H
  if (rest && !/^[vVaAoOhHmMsSfF]+$/.test(rest) && rest !== "ohm" && rest !== "ohms") {
    // allow empty / common units only
  }

  return value;
}

export function formatEng(value, digits = 4) {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return "0";

  const abs = Math.abs(value);
  const units = [
    [1e12, "T"],
    [1e9, "G"],
    [1e6, "Meg"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "u"],
    [1e-9, "n"],
    [1e-12, "p"],
    [1e-15, "f"],
  ];

  for (const [scale, suffix] of units) {
    if (abs >= scale) {
      const n = value / scale;
      return `${Number(n.toPrecision(digits))}${suffix}`;
    }
  }
  return value.toExponential(digits - 1);
}
