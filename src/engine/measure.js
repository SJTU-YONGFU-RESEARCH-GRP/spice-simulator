import { parseNumber } from "../units.js";

/**
 * Parse .meas / .measure lines from netlist text.
 * Supported:
 *   .meas tran name MAX|MIN|PP|AVG|RMS v(out) [FROM=t1 TO=t2]
 *   .meas tran name AT|FIND v(out) AT=1m
 *   .meas tran name WHEN v(out)=2.5 [RISE=n|FALL=n|CROSS=n]
 *   .meas tran name TRIG v(in)=1 RISE=1 TARG v(out)=1 RISE=1
 *   .meas ac name FIND db(v(out)) AT=1k
 */
export function parseMeasures(text) {
  const list = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    const semi = line.indexOf(";");
    if (semi >= 0) line = line.slice(0, semi).trim();
    const low = line.toLowerCase();
    if (!low.startsWith(".meas")) continue;

    const trig = parseTrigTargMeasure(line);
    if (trig) {
      list.push(trig);
      continue;
    }

    const when = parseWhenMeasure(line);
    if (when) {
      list.push(when);
      continue;
    }

    const parts = line.split(/\s+/);
    let i = 1;
    let analysis = "tran";
    if (/^(tran|ac|dc|noise|op)$/i.test(parts[i])) {
      analysis = parts[i].toLowerCase();
      i++;
    }
    const name = parts[i++];
    const type = (parts[i++] || "").toUpperCase();
    const signal = parts[i++];
    if (!name || !type || !signal) {
      throw new Error(`.meas needs name TYPE signal: ${raw}`);
    }
    let at = null;
    let from = null;
    let to = null;
    for (; i < parts.length; i++) {
      const kv = parts[i].split("=");
      if (kv.length !== 2) continue;
      const k = kv[0].toUpperCase();
      const v = parseNumber(kv[1]);
      if (k === "AT") at = v;
      else if (k === "FROM") from = v;
      else if (k === "TO") to = v;
    }
    if (type === "AT" || type === "FIND") {
      if (at == null) throw new Error(`.meas ${type} needs AT=value`);
    }
    list.push({
      analysis,
      name,
      type,
      signal: signal.toLowerCase(),
      at,
      from,
      to,
    });
  }
  return list;
}

/** .meas [tran] name WHEN v(out)=2.5 RISE=1 */
function parseWhenMeasure(line) {
  const m =
    /^\.meas(?:ure)?\s+(?:(tran|ac|dc|noise|op)\s+)?(\S+)\s+WHEN\s+(\S+)\s*=\s*(\S+)(.*)$/i.exec(
      line
    );
  if (!m) return null;
  const analysis = (m[1] || "tran").toLowerCase();
  const name = m[2];
  const signal = m[3].toLowerCase();
  const level = parseNumber(m[4]);
  const edge = parseEdgeFlags(m[5] || "");
  return {
    analysis,
    name,
    type: "WHEN",
    signal,
    level,
    ...edge,
  };
}

/**
 * .meas tran td TRIG v(in)=2.5 RISE=1 TARG v(out)=2.5 RISE=1
 */
function parseTrigTargMeasure(line) {
  const m =
    /^\.meas(?:ure)?\s+(?:(tran|ac|dc|noise|op)\s+)?(\S+)\s+TRIG\s+(\S+)\s*=\s*(\S+)(.*)$/i.exec(
      line
    );
  if (!m) return null;
  const rest = m[5] || "";
  const tm = /\bTARG\s+(\S+)\s*=\s*(\S+)(.*)$/i.exec(rest);
  if (!tm) throw new Error(`.meas TRIG needs TARG …: ${line}`);
  const trigRest = rest.slice(0, tm.index);
  const analysis = (m[1] || "tran").toLowerCase();
  const trigEdge = parseEdgeFlags(trigRest);
  const targEdge = parseEdgeFlags(tm[3] || "");
  return {
    analysis,
    name: m[2],
    type: "TRIG",
    trig: {
      signal: m[3].toLowerCase(),
      level: parseNumber(m[4]),
      ...trigEdge,
    },
    targ: {
      signal: tm[1].toLowerCase(),
      level: parseNumber(tm[2]),
      ...targEdge,
    },
  };
}

function parseEdgeFlags(rest) {
  let rise = null;
  let fall = null;
  let cross = null;
  const re = /(RISE|FALL|CROSS)\s*=\s*([^\s]+)/gi;
  let km;
  while ((km = re.exec(rest))) {
    const k = km[1].toUpperCase();
    const n = Math.max(1, Math.round(parseNumber(km[2])));
    if (k === "RISE") rise = n;
    else if (k === "FALL") fall = n;
    else cross = n;
  }
  if (rise == null && fall == null && cross == null) cross = 1;
  return { rise, fall, cross };
}

/**
 * Evaluate measures against a sim result { times, series, analysis? }.
 */
export function evalMeasures(measures, result, analysisType) {
  const out = [];
  const times = result.times || [];
  const series = result.series || {};
  const kind = (analysisType || result.analysis || "tran").toLowerCase();

  for (const m of measures) {
    if (m.analysis !== kind && !(kind === "op" && m.analysis === "dc")) {
      if (!(m.analysis === "dc" && kind === "dc")) continue;
    }

    if (m.type === "TRIG") {
      try {
        const tTrig = findWhen(m.trig, times, needSignal(series, m.trig.signal, m.name));
        const tTarg = findWhen(m.targ, times, needSignal(series, m.targ.signal, m.name));
        const value = tTarg - tTrig;
        out.push({
          name: m.name,
          type: m.type,
          signal: `${m.trig.signal}→${m.targ.signal}`,
          value,
          markT: tTarg,
          markT2: tTrig,
          ok: true,
        });
      } catch (e) {
        out.push({ name: m.name, error: e.message || String(e), ok: false });
      }
      continue;
    }

    const ys = resolveSignal(series, m.signal);
    if (!ys) {
      out.push({ name: m.name, error: `signal ${m.signal} not found`, ok: false });
      continue;
    }
    try {
      const value = compute(m, times, ys);
      const markT =
        m.type === "WHEN"
          ? value
          : m.type === "AT" || m.type === "FIND"
            ? m.at
            : null;
      out.push({
        name: m.name,
        type: m.type,
        signal: m.signal,
        value,
        markT: Number.isFinite(markT) ? markT : null,
        ok: true,
      });
    } catch (e) {
      out.push({ name: m.name, error: e.message || String(e), ok: false });
    }
  }
  return out;
}

function needSignal(series, signal, owner) {
  const ys = resolveSignal(series, signal);
  if (!ys) throw new Error(`${owner}: signal ${signal} not found`);
  return ys;
}

function resolveSignal(series, signal) {
  const key = signal.toLowerCase();
  if (series[key]) return series[key];
  for (const k of Object.keys(series)) {
    if (k.toLowerCase() === key) return series[k];
  }
  return null;
}

function windowIndices(times, ys, from, to) {
  const outT = [];
  const outY = [];
  for (let i = 0; i < ys.length; i++) {
    const t = times[i] ?? i;
    if (from != null && t < from) continue;
    if (to != null && t > to) continue;
    outT.push(t);
    outY.push(ys[i]);
  }
  return { times: outT, ys: outY };
}

function compute(m, times, ys) {
  const type = m.type.toUpperCase();
  if (type === "WHEN") return findWhen(m, times, ys);

  let tt = times;
  let yy = ys;
  if (m.from != null || m.to != null) {
    const w = windowIndices(times, ys, m.from, m.to);
    tt = w.times;
    yy = w.ys;
    if (!yy.length) throw new Error(`empty window FROM/TO`);
  }

  if (type === "MAX") return Math.max(...yy.filter(Number.isFinite));
  if (type === "MIN") return Math.min(...yy.filter(Number.isFinite));
  if (type === "PP") {
    const finite = yy.filter(Number.isFinite);
    return Math.max(...finite) - Math.min(...finite);
  }
  if (type === "AVG") {
    const finite = yy.filter(Number.isFinite);
    return finite.reduce((a, b) => a + b, 0) / (finite.length || 1);
  }
  if (type === "RMS") {
    if (tt.length === yy.length && tt.length > 1) {
      let acc = 0;
      let dur = 0;
      for (let i = 1; i < tt.length; i++) {
        const dt = tt[i] - tt[i - 1];
        if (dt <= 0) continue;
        const y0 = yy[i - 1];
        const y1 = yy[i];
        if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
        acc += 0.5 * (y0 * y0 + y1 * y1) * dt;
        dur += dt;
      }
      return Math.sqrt(acc / (dur || 1));
    }
    const finite = yy.filter(Number.isFinite);
    return Math.sqrt(finite.reduce((a, b) => a + b * b, 0) / (finite.length || 1));
  }
  if (type === "AT" || type === "FIND") {
    const t = m.at;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs(times[i] - t);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return ys[best];
  }
  throw new Error(`unsupported .meas type ${m.type}`);
}

function findWhen(m, times, ys) {
  const level = m.level;
  if (!Number.isFinite(level)) throw new Error("WHEN needs a numeric level");
  let riseN = 0;
  let fallN = 0;
  let crossN = 0;
  const wantRise = m.rise != null;
  const wantFall = m.fall != null;
  const wantCross = m.cross != null && !wantRise && !wantFall;

  for (let i = 1; i < times.length; i++) {
    const y0 = ys[i - 1];
    const y1 = ys[i];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue;
    const t0 = times[i - 1];
    const t1 = times[i];
    if (t1 <= t0) continue;

    const crossedUp = y0 < level && y1 >= level;
    const crossedDn = y0 > level && y1 <= level;
    if (!crossedUp && !crossedDn) continue;

    const frac = (level - y0) / (y1 - y0 || 1e-30);
    const tHit = t0 + frac * (t1 - t0);

    if (crossedUp) {
      riseN++;
      crossN++;
      if (wantRise && riseN === m.rise) return tHit;
      if (wantCross && crossN === m.cross) return tHit;
    }
    if (crossedDn) {
      fallN++;
      crossN++;
      if (wantFall && fallN === m.fall) return tHit;
      if (wantCross && crossN === m.cross) return tHit;
    }
  }
  const kind = wantRise ? `RISE=${m.rise}` : wantFall ? `FALL=${m.fall}` : `CROSS=${m.cross}`;
  throw new Error(`WHEN ${m.signal}=${level} ${kind} not found`);
}
