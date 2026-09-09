/**
 * Parse .print lines and return signal names for the given analysis.
 *   .print tran v(out) i(R1)
 *   .print dc i(V1) v(a)
 *   .print ac v(out)
 *   .print v(out)          // any analysis
 */
export function parsePrint(text, analysisType = null) {
  const signals = [];
  const seen = new Set();
  const want = analysisType ? String(analysisType).toLowerCase() : null;

  for (const raw of String(text || "").split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const semi = line.indexOf(";");
    if (semi >= 0) line = line.slice(0, semi).trim();
    if (!line.toLowerCase().startsWith(".print")) continue;

    const parts = line.split(/\s+/).filter(Boolean);
    // parts[0]=.print
    let i = 1;
    let scope = null;
    if (parts[i] && /^(tran|dc|ac|noise|tf|op)$/i.test(parts[i])) {
      scope = parts[i++].toLowerCase();
      if (scope === "op") scope = "dc";
    }
    if (want && scope && scope !== want) continue;

    for (; i < parts.length; i++) {
      let tok = parts[i].replace(/,$/, "");
      if (!tok) continue;
      // normalize v(out) / V(OUT) / db(v(out))
      const key = tok.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push(tok);
    }
  }
  return signals;
}

/** Map prefer tokens onto actual series keys (case-insensitive). */
export function matchSeriesNames(series, prefer) {
  if (!prefer?.length || !series) return [];
  const names = Object.keys(series);
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const out = [];
  for (const p of prefer) {
    const pl = String(p).toLowerCase();
    const hit = lower.get(pl);
    if (hit && !out.includes(hit)) out.push(hit);
    // nested / stepped overlays: i(Vds) → i(Vds)@Vgs=1 …
    for (const n of names) {
      const nl = n.toLowerCase();
      if ((nl === pl || nl.startsWith(pl + "@")) && !out.includes(n)) out.push(n);
    }
  }
  return out;
}
