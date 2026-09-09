import { parseNumber } from "../units.js";
import { expandParams } from "./params.js";
import { expandSubcircuits } from "./subckt.js";
import { compileExpr } from "../engine/expr.js";

/**
 * Netlist grammar:
 *   R/C/L/V/I/D/M/Q/E/G/F/H/S/W/B · K coupling · X subckt
 *   V/I: DC · AC · PULSE(...) · SIN(...) · PWL(...) · EXP(...)
 *   B: V=expr | I=expr  (behavioral)
 *   .param · .func · .subckt/.ends · {param}
 *   .tran / .ac / .dc / .disto / .ic / .nodeset / .option / .model / .end
 */

export function parseNetlist(text) {
  const expanded = expandParams(text);
  text = expandSubcircuits(expanded.text);

  const devices = [];
  const models = new Map();
  const ic = new Map();
  const nodeset = new Map();
  let analysis = {
    type: "tran",
    tstep: 1e-5,
    tstop: 1e-3,
    uic: false,
    adaptive: false,
    method: "trap",
  };
  const nodes = new Set(["0"]);
  const params = expanded.params;
  const options = {
    tempC: 27,
    tnom: 27,
    reltol: 1e-3,
    abstol: 1e-6,
    vntol: 1e-6,
    gmin: 1e-12,
    maxIter: 80,
    method: null, // null → follow .tran / default trap
    gminSteps: 8,
    srcSteps: 10,
  };

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    if (!line || line.startsWith("*") || line.startsWith(";")) continue;

    const semi = line.indexOf(";");
    if (semi >= 0) line = line.slice(0, semi).trim();
    if (!line) continue;

    const parts = tokenize(line);
    const head = parts[0];
    const cmd = head.toLowerCase();

    if (cmd.startsWith(".")) {
      if (cmd === ".end") break;
      if (cmd === ".param") continue;
      if (cmd === ".subckt" || cmd === ".ends") continue; // expanded already
      if (cmd === ".tran") {
        if (parts.length < 3) throw new Error(`.tran needs tstep tstop (line ${i + 1})`);
        const flags = parts.slice(3);
        const uic = flags.some((p) => p.toUpperCase() === "UIC");
        const adaptive = flags.some((p) => p.toUpperCase() === "ADAPTIVE");
        let tmax;
        for (const p of flags) {
          if (/^(UIC|ADAPTIVE)$/i.test(p)) continue;
          tmax = parseNumber(p);
          break;
        }
        analysis = {
          type: "tran",
          tstep: parseNumber(parts[1]),
          tstop: parseNumber(parts[2]),
          ...(tmax !== undefined ? { tmax } : {}),
          uic,
          adaptive,
          method: options.method || "trap",
        };
        continue;
      }
      if (cmd === ".ac") {
        if (parts.length < 5) throw new Error(`.ac needs variation N fstart fstop (line ${i + 1})`);
        const variation = parts[1].toLowerCase();
        if (!["dec", "oct", "lin"].includes(variation)) {
          throw new Error(`.ac variation must be dec|oct|lin (line ${i + 1})`);
        }
        analysis = {
          type: "ac",
          variation,
          n: parseNumber(parts[2]),
          fstart: parseNumber(parts[3]),
          fstop: parseNumber(parts[4]),
        };
        continue;
      }
      if (cmd === ".disto") {
        // .disto [V(out[,ref])] dec|lin|oct N fstart fstop
        let p = 1;
        let outNode = "out";
        let refNode = "0";
        const vm = parts[1] && /^V\(([^)]+)\)$/i.exec(parts[1]);
        if (vm) {
          const ends = vm[1].split(",").map((s) => s.trim());
          outNode = normalizeNode(ends[0]);
          refNode = normalizeNode(ends[1] || "0");
          p = 2;
        }
        if (parts.length < p + 4) {
          throw new Error(`.disto needs [V(out)] variation N fstart fstop (line ${i + 1})`);
        }
        const variation = parts[p].toLowerCase();
        if (!["dec", "oct", "lin"].includes(variation)) {
          throw new Error(`.disto variation must be dec|oct|lin (line ${i + 1})`);
        }
        analysis = {
          type: "disto",
          outNode,
          refNode,
          variation,
          n: parseNumber(parts[p + 1]),
          fstart: parseNumber(parts[p + 2]),
          fstop: parseNumber(parts[p + 3]),
        };
        continue;
      }
      if (cmd === ".pz") {
        // .pz [V(out[,ref]) [src]]
        let outNode = "out";
        let refNode = "0";
        let src = null;
        if (parts[1]) {
          const vm = /^V\(([^)]+)\)$/i.exec(parts[1]);
          if (vm) {
            const ends = vm[1].split(",").map((s) => s.trim());
            outNode = normalizeNode(ends[0]);
            refNode = normalizeNode(ends[1] || "0");
          }
        }
        if (parts[2]) src = parts[2];
        analysis = { type: "pz", outNode, refNode, src };
        continue;
      }
      if (cmd === ".mc") {
        // .mc runs [seed=N]
        if (parts.length < 2) throw new Error(`.mc needs run count (line ${i + 1})`);
        let runs = parseNumber(parts[1]);
        let seed = 1;
        for (let k = 2; k < parts.length; k++) {
          const m = /^seed\s*=\s*(.+)$/i.exec(parts[k]);
          if (m) seed = Math.round(parseNumber(m[1]));
        }
        if (!(runs >= 2)) throw new Error(`.mc runs must be ≥ 2 (line ${i + 1})`);
        analysis = { type: "mc", runs: Math.floor(runs), seed };
        continue;
      }
      if (cmd === ".op") {
        analysis = { type: "dc", uic: false };
        continue;
      }
      if (cmd === ".dc") {
        // .dc
        // .dc src start stop step
        // .dc src1 start1 stop1 step1 src2 start2 stop2 step2
        if (parts.length >= 9) {
          analysis = {
            type: "dc",
            uic: false,
            sweep: {
              src: parts[1],
              start: parseNumber(parts[2]),
              stop: parseNumber(parts[3]),
              step: parseNumber(parts[4]),
              nested: {
                src: parts[5],
                start: parseNumber(parts[6]),
                stop: parseNumber(parts[7]),
                step: parseNumber(parts[8]),
              },
            },
          };
        } else if (parts.length >= 5) {
          analysis = {
            type: "dc",
            uic: false,
            sweep: {
              src: parts[1],
              start: parseNumber(parts[2]),
              stop: parseNumber(parts[3]),
              step: parseNumber(parts[4]),
            },
          };
        } else {
          analysis = { type: "dc", uic: false };
        }
        continue;
      }
      if (cmd === ".tf") {
        // .tf V(out[,ref]) src
        if (parts.length < 3) {
          throw new Error(`.tf needs V(out) src (line ${i + 1})`);
        }
        const vtok = parts[1];
        const vm = /^V\(([^)]+)\)$/i.exec(vtok);
        if (!vm) throw new Error(`.tf output must look like V(out) or V(a,b) (line ${i + 1})`);
        const ends = vm[1].split(",").map((s) => s.trim());
        const outNode = normalizeNode(ends[0]);
        const refNode = normalizeNode(ends[1] || "0");
        const srcName = parts[2];
        analysis = { type: "tf", outNode, refNode, srcName };
        nodes.add(outNode);
        nodes.add(refNode);
        continue;
      }
      if (cmd === ".temp") {
        if (parts.length < 2) throw new Error(`.temp needs a value (line ${i + 1})`);
        options.tempC = parseNumber(parts[1]);
        continue;
      }
      if (cmd === ".option" || cmd === ".options") {
        applyOptionLine(options, analysis, line, i + 1);
        continue;
      }
      if (cmd === ".noise") {
        // .noise V(out[,ref]) src dec|lin|oct N fstart fstop
        if (parts.length < 6) {
          throw new Error(`.noise needs V(out) src variation N fstart fstop (line ${i + 1})`);
        }
        const vtok = parts[1];
        const vm = /^V\(([^)]+)\)$/i.exec(vtok);
        if (!vm) throw new Error(`.noise output must look like V(out) or V(a,b) (line ${i + 1})`);
        const ends = vm[1].split(",").map((s) => s.trim());
        const outNode = normalizeNode(ends[0]);
        const refNode = normalizeNode(ends[1] || "0");
        const srcName = parts[2];
        const variation = parts[3].toLowerCase();
        if (!["dec", "oct", "lin"].includes(variation)) {
          throw new Error(`.noise variation must be dec|oct|lin (line ${i + 1})`);
        }
        analysis = {
          type: "noise",
          outNode,
          refNode,
          srcName,
          variation,
          n: parseNumber(parts[4]),
          fstart: parseNumber(parts[5]),
          fstop: parseNumber(parts[6]),
        };
        nodes.add(outNode);
        nodes.add(refNode);
        continue;
      }
      if (cmd === ".ic") {
        const rest = line.slice(3);
        const re = /V\(([^)]+)\)\s*=\s*([^\s]+)/gi;
        let m;
        while ((m = re.exec(rest))) {
          ic.set(normalizeNode(m[1]), parseNumber(m[2]));
        }
        continue;
      }
      if (cmd === ".nodeset") {
        const rest = line.slice(8);
        const re = /V\(([^)]+)\)\s*=\s*([^\s]+)/gi;
        let m;
        while ((m = re.exec(rest))) {
          nodeset.set(normalizeNode(m[1]), parseNumber(m[2]));
        }
        continue;
      }
      if (cmd === ".model") {
        const name = parts[1];
        let typeTok = parts[2] || "D";
        // Tokenizer may glue "D(Is=…)" into one token — peel type letter/word.
        const typeM = /^(D|NPN|PNP|NMOS|PMOS|SW|CSW|R|C)/i.exec(typeTok);
        const type = (typeM ? typeM[1] : typeTok.replace(/\(.*$/, "") || "D").toUpperCase();
        const modelParams = {};
        // Params from full line so parenthesized forms still parse
        const nameIdx = line.toLowerCase().indexOf(String(name).toLowerCase());
        const rest =
          nameIdx >= 0 ? line.slice(nameIdx + String(name).length) : line;
        const paramRe = /(\w+)\s*=\s*([^\s=()]+)/gi;
        let m;
        while ((m = paramRe.exec(rest))) {
          modelParams[m[1].toLowerCase()] = parseNumber(m[2]);
        }
        models.set(name.toUpperCase(), { type, params: modelParams });
        continue;
      }
      // Handled outside parser / ignored
      if (
        cmd === ".meas" ||
        cmd === ".measure" ||
        cmd === ".include" ||
        cmd === ".inc" ||
        cmd === ".lib" ||
        cmd === ".step" ||
        cmd === ".four" ||
        cmd === ".print" ||
        cmd === ".func"
      ) {
        continue;
      }
      throw new Error(`Unsupported directive ${head} (line ${i + 1})`);
    }

    const kind = head[0].toUpperCase();
    const name = head;

    if (kind === "R" || kind === "C" || kind === "L") {
      if (parts.length < 4) throw new Error(`${name}: need n+ n- value (line ${i + 1})`);
      const n1 = normalizeNode(parts[1]);
      const n2 = normalizeNode(parts[2]);
      nodes.add(n1);
      nodes.add(n2);
      const extras = parseKvParams(parts.slice(4));
      const d = {
        type: kind,
        name,
        n1,
        n2,
        value: parseNumber(parts[3]),
        tc1: extras.tc1 ?? 0,
        tc2: extras.tc2 ?? 0,
      };
      if (extras.ic !== undefined) d.ic = extras.ic;
      if ((kind === "L" || kind === "C") && extras.rser !== undefined) {
        d.rser = Math.max(0, extras.rser);
      }
      if (extras.lot !== undefined) d.lot = extras.lot;
      else if (extras.dev !== undefined) d.lot = extras.dev;
      devices.push(d);
      continue;
    }

    if (kind === "K") {
      // Kname L1 L2 coeff
      if (parts.length < 4) throw new Error(`${name}: need L1 L2 k (line ${i + 1})`);
      const l1 = parts[1];
      const l2 = parts[2];
      const k = parseNumber(parts[3]);
      if (!(Math.abs(k) < 1 + 1e-12)) {
        throw new Error(`${name}: |k| must be < 1 (line ${i + 1})`);
      }
      devices.push({ type: "K", name, l1, l2, k });
      continue;
    }

    if (kind === "V" || kind === "I") {
      if (parts.length < 4) throw new Error(`${name}: need n+ n- value (line ${i + 1})`);
      const n1 = normalizeNode(parts[1]);
      const n2 = normalizeNode(parts[2]);
      nodes.add(n1);
      nodes.add(n2);
      devices.push({ type: kind, name, n1, n2, ...parseSource(parts.slice(3), i + 1) });
      continue;
    }

    if (kind === "D") {
      if (parts.length < 3) throw new Error(`${name}: need n+ n- [model] (line ${i + 1})`);
      const n1 = normalizeNode(parts[1]);
      const n2 = normalizeNode(parts[2]);
      nodes.add(n1);
      nodes.add(n2);
      devices.push({ type: "D", name, n1, n2, model: (parts[3] || "DDEFAULT").toUpperCase() });
      continue;
    }

    if (kind === "E" || kind === "G") {
      // E/G name n+ n- nc+ nc- gain
      if (parts.length < 6) {
        throw new Error(`${name}: need n+ n- nc+ nc- gain (line ${i + 1})`);
      }
      const n1 = normalizeNode(parts[1]);
      const n2 = normalizeNode(parts[2]);
      const nc1 = normalizeNode(parts[3]);
      const nc2 = normalizeNode(parts[4]);
      const gain = parseNumber(parts[5]);
      nodes.add(n1);
      nodes.add(n2);
      nodes.add(nc1);
      nodes.add(nc2);
      devices.push({ type: kind, name, n1, n2, nc1, nc2, gain });
      continue;
    }

    if (kind === "F" || kind === "H") {
      // F/H name n+ n- Vnam gain  (current through Vnam)
      if (parts.length < 5) {
        throw new Error(`${name}: need n+ n- Vname gain (line ${i + 1})`);
      }
      const n1 = normalizeNode(parts[1]);
      const n2 = normalizeNode(parts[2]);
      const vname = parts[3];
      const gain = parseNumber(parts[4]);
      nodes.add(n1);
      nodes.add(n2);
      devices.push({ type: kind, name, n1, n2, vname, gain });
      continue;
    }

    if (kind === "S") {
      // Sname n+ n- nc+ nc- model
      if (parts.length < 5) {
        throw new Error(`${name}: need n+ n- nc+ nc- model (line ${i + 1})`);
      }
      const n1 = normalizeNode(parts[1]);
      const n2 = normalizeNode(parts[2]);
      const nc1 = normalizeNode(parts[3]);
      const nc2 = normalizeNode(parts[4]);
      const modelName = (parts[5] || "SW").toUpperCase();
      nodes.add(n1);
      nodes.add(n2);
      nodes.add(nc1);
      nodes.add(nc2);
      devices.push({ type: "S", name, n1, n2, nc1, nc2, model: modelName });
      continue;
    }

    if (kind === "W") {
      // Wname n+ n- Vnam model  (control = current through Vnam)
      if (parts.length < 5) {
        throw new Error(`${name}: need n+ n- Vname model (line ${i + 1})`);
      }
      const n1 = normalizeNode(parts[1]);
      const n2 = normalizeNode(parts[2]);
      const vname = parts[3];
      const modelName = (parts[4] || "CSW").toUpperCase();
      nodes.add(n1);
      nodes.add(n2);
      devices.push({ type: "W", name, n1, n2, vname, model: modelName });
      continue;
    }

    if (kind === "B") {
      // Bname n+ n- V=expr | I=expr
      if (parts.length < 4) {
        throw new Error(`${name}: need n+ n- V=expr|I=expr (line ${i + 1})`);
      }
      const n1 = normalizeNode(parts[1]);
      const n2 = normalizeNode(parts[2]);
      nodes.add(n1);
      nodes.add(n2);
      const rest = line.slice(line.toLowerCase().indexOf(parts[0].toLowerCase()) + parts[0].length);
      const bm = /\b([vi])\s*=\s*(.+)$/i.exec(rest);
      if (!bm) throw new Error(`${name}: need V=expr or I=expr (line ${i + 1})`);
      const btype = bm[1].toUpperCase(); // V | I
      const exprSrc = bm[2].trim();
      let compiled;
      try {
        compiled = compileExpr(exprSrc);
      } catch (e) {
        throw new Error(`${name}: bad expression — ${e.message} (line ${i + 1})`);
      }
      for (const nn of compiled.nodes) nodes.add(normalizeNode(nn));
      devices.push({
        type: "B",
        name,
        n1,
        n2,
        btype,
        expr: exprSrc,
        compiled,
      });
      continue;
    }

    if (kind === "Q") {
      // Qname nc nb ne [ns] model
      if (parts.length < 5) throw new Error(`${name}: need nc nb ne [ns] model (line ${i + 1})`);
      const nc = normalizeNode(parts[1]);
      const nb = normalizeNode(parts[2]);
      const ne = normalizeNode(parts[3]);
      let ns = ne;
      let modelName;
      if (parts.length >= 6 && !parts[4].includes("=")) {
        ns = normalizeNode(parts[4]);
        modelName = parts[5].toUpperCase();
      } else {
        modelName = parts[4].toUpperCase();
      }
      nodes.add(nc);
      nodes.add(nb);
      nodes.add(ne);
      nodes.add(ns);
      devices.push({ type: "Q", name, nc, nb, ne, ns, model: modelName });
      continue;
    }

    if (kind === "M") {
      if (parts.length < 5) throw new Error(`${name}: need nd ng ns [nb] model (line ${i + 1})`);
      const nd = normalizeNode(parts[1]);
      const ng = normalizeNode(parts[2]);
      const ns = normalizeNode(parts[3]);
      let idx = 4;
      let nb = ns;
      let modelName;
      const maybeModel = parts[4].toUpperCase();
      if (parts.length >= 6 && !parts[4].includes("=") && !parts[5].includes("=")) {
        nb = normalizeNode(parts[4]);
        modelName = parts[5].toUpperCase();
        idx = 6;
      } else if (!parts[4].includes("=")) {
        modelName = maybeModel;
        idx = 5;
      } else {
        throw new Error(`${name}: missing model name (line ${i + 1})`);
      }
      nodes.add(nd);
      nodes.add(ng);
      nodes.add(ns);
      nodes.add(nb);
      let w;
      let l;
      for (let p = idx; p < parts.length; p++) {
        const kv = parts[p].split("=");
        if (kv.length === 2) {
          const key = kv[0].toUpperCase();
          if (key === "W") w = parseNumber(kv[1]);
          if (key === "L") l = parseNumber(kv[1]);
        }
      }
      devices.push({ type: "M", name, nd, ng, ns, nb, model: modelName, w, l });
      continue;
    }

    throw new Error(`Unknown device ${name} (line ${i + 1})`);
  }

  if (![...models.values()].some((m) => m.type === "D")) {
    models.set("DDEFAULT", {
      type: "D",
      params: { is: 1e-14, n: 1, vt: 0.026 },
    });
  }
  if (![...models.values()].some((m) => m.type === "NMOS")) {
    models.set("NMOS", { type: "NMOS", params: { vto: 0.7, kp: 2e-5, lambda: 0.01 } });
  }
  if (![...models.values()].some((m) => m.type === "PMOS")) {
    models.set("PMOS", { type: "PMOS", params: { vto: -0.7, kp: 2e-5, lambda: 0.01 } });
  }
  if (![...models.values()].some((m) => m.type === "NPN")) {
    models.set("NPN", { type: "NPN", params: { is: 1e-15, bf: 100, br: 1, vaf: 50 } });
  }
  if (![...models.values()].some((m) => m.type === "PNP")) {
    models.set("PNP", { type: "PNP", params: { is: 1e-15, bf: 100, br: 1, vaf: 50 } });
  }

  return { devices, models, analysis, ic, nodeset, nodes: [...nodes], params, options };
}

function tokenize(line) {
  // Normalize "foo ( bar )" → "foo(bar)" but keep a space after ")" when needed
  const normalized = line
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ") ")
    .replace(/,\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const out = [];
  let cur = "";
  let depth = 0;
  for (const ch of normalized) {
    if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** key=value tokens after a device value (tc1, tc2, lot, …). */
function parseKvParams(parts) {
  const out = {};
  for (const p of parts) {
    const m = /^([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(p);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const raw = m[2];
    if (key === "lot" || key === "dev") {
      out[key] = parseLot(raw);
    } else {
      out[key] = parseNumber(raw);
    }
  }
  return out;
}

function parseLot(raw) {
  if (typeof raw === "number") return Math.abs(raw);
  const s = String(raw).trim();
  if (/%\s*$/.test(s)) return Math.abs(parseNumber(s.replace(/%\s*$/, ""))) / 100;
  return Math.abs(parseNumber(s));
}

function parseSource(parts, lineNo) {
  let value = 0;
  let waveform = null;
  let acMag = 0;
  let acPhase = 0;

  const isWaveTok = (p) =>
    p && /^(PULSE|SIN|SINE|PWL|EXP)\(/i.test(p);

  let i = 0;
  while (i < parts.length) {
    const tok = parts[i].toUpperCase();
    if (tok === "DC") {
      value = parseNumber(parts[++i]);
      i++;
    } else if (tok === "AC") {
      acMag = parseNumber(parts[++i]);
      i++;
      if (
        i < parts.length &&
        !/^(DC|AC|PULSE|SIN|SINE|PWL|EXP)/i.test(parts[i]) &&
        !isWaveTok(parts[i])
      ) {
        const maybe = parts[i];
        if (!isNaN(parseFloat(maybe)) || /^[+-]?\d/.test(maybe)) {
          acPhase = parseNumber(maybe);
          i++;
        }
      }
    } else if (tok.startsWith("PULSE(")) {
      const inner = parts[i].slice(6, parts[i].endsWith(")") ? -1 : undefined);
      const args = inner.split(/[\s,]+/).filter(Boolean);
      if (args.length < 2) throw new Error(`PULSE needs at least v1 v2 (line ${lineNo})`);
      const [v1, v2, td = "0", tr = "0", tf = "0", pw = "1e9", per = "1e9"] = args;
      value = parseNumber(v1);
      waveform = {
        type: "pulse",
        v1: parseNumber(v1),
        v2: parseNumber(v2),
        td: parseNumber(td),
        tr: parseNumber(tr) || 1e-12,
        tf: parseNumber(tf) || 1e-12,
        pw: parseNumber(pw),
        per: parseNumber(per),
      };
      i++;
    } else if (tok.startsWith("SIN(") || tok.startsWith("SINE(")) {
      // SIN(VO VA FREQ [TD [THETA [PHASE]]])
      const open = parts[i].indexOf("(");
      const inner = parts[i].slice(open + 1, parts[i].endsWith(")") ? -1 : undefined);
      const args = inner.split(/[\s,]+/).filter(Boolean);
      if (args.length < 3) {
        throw new Error(`SIN needs vo va freq (line ${lineNo})`);
      }
      const [vo, va, freq, td = "0", theta = "0", phase = "0"] = args;
      const f = parseNumber(freq);
      if (!(f > 0)) throw new Error(`SIN frequency must be > 0 (line ${lineNo})`);
      value = parseNumber(vo); // DC / bias = offset
      waveform = {
        type: "sin",
        vo: parseNumber(vo),
        va: parseNumber(va),
        freq: f,
        td: parseNumber(td),
        theta: parseNumber(theta),
        phase: parseNumber(phase),
      };
      i++;
    } else if (tok.startsWith("PWL(")) {
      // PWL(t1 v1 t2 v2 …)
      const inner = parts[i].slice(4, parts[i].endsWith(")") ? -1 : undefined);
      const args = inner.split(/[\s,]+/).filter(Boolean);
      if (args.length < 2 || args.length % 2 !== 0) {
        throw new Error(`PWL needs t/v pairs (line ${lineNo})`);
      }
      const pts = [];
      for (let k = 0; k < args.length; k += 2) {
        pts.push({ t: parseNumber(args[k]), v: parseNumber(args[k + 1]) });
      }
      pts.sort((a, b) => a.t - b.t);
      for (let k = 1; k < pts.length; k++) {
        if (pts[k].t < pts[k - 1].t) {
          throw new Error(`PWL times must be non-decreasing (line ${lineNo})`);
        }
      }
      value = pts[0].v;
      waveform = { type: "pwl", pts };
      i++;
    } else if (tok.startsWith("EXP(")) {
      // EXP(v1 v2 td1 tau1 [td2 [tau2]])
      const inner = parts[i].slice(4, parts[i].endsWith(")") ? -1 : undefined);
      const args = inner.split(/[\s,]+/).filter(Boolean);
      if (args.length < 4) {
        throw new Error(`EXP needs v1 v2 td1 tau1 [td2 tau2] (line ${lineNo})`);
      }
      const v1 = parseNumber(args[0]);
      const v2 = parseNumber(args[1]);
      const td1 = parseNumber(args[2]);
      const tau1 = parseNumber(args[3]) || 1e-12;
      const td2 = args[4] != null ? parseNumber(args[4]) : td1;
      const tau2 = args[5] != null ? parseNumber(args[5]) || 1e-12 : tau1;
      value = v1;
      waveform = { type: "exp", v1, v2, td1, tau1, td2, tau2 };
      i++;
    } else {
      // plain DC number as first token
      value = parseNumber(parts[i]);
      i++;
    }
  }

  const phaseRad = (acPhase * Math.PI) / 180;
  return {
    value,
    waveform,
    ac: { mag: acMag, phase: acPhase, re: acMag * Math.cos(phaseRad), im: acMag * Math.sin(phaseRad) },
  };
}

function normalizeNode(n) {
  const s = String(n);
  if (s === "gnd" || s === "GND" || s === "ground") return "0";
  return s;
}

export function sourceValue(device, t, mode = "tran") {
  if (mode === "dc" || mode === "ac" || !device.waveform) return device.value;
  const wt = String(device.waveform?.type || "").toLowerCase();
  if (wt === "pulse") return evalPulse(device.waveform, t);
  if (wt === "sin" || wt === "sine") return evalSin(device.waveform, t);
  if (wt === "pwl") return evalPwl(device.waveform, t);
  if (wt === "exp") return evalExp(device.waveform, t);
  return device.value;
}

export function sourceAc(device) {
  return device.ac || { mag: 0, phase: 0, re: 0, im: 0 };
}

function evalPulse(w, t) {
  if (t < w.td) return w.v1;
  const per = w.per > 0 ? w.per : Infinity;
  let tau = t - w.td;
  if (Number.isFinite(per) && per > 0) tau = tau % per;

  if (tau < w.tr) return w.v1 + (w.v2 - w.v1) * (tau / w.tr);
  tau -= w.tr;
  if (tau < w.pw) return w.v2;
  tau -= w.pw;
  if (tau < w.tf) return w.v2 + (w.v1 - w.v2) * (tau / w.tf);
  return w.v1;
}

/** SPICE SIN(VO VA FREQ TD THETA PHASE): damped sine after delay. */
function evalSin(w, t) {
  if (t < w.td) return w.vo;
  const tau = t - w.td;
  const damp = w.theta ? Math.exp(-w.theta * tau) : 1;
  const phaseRad = ((w.phase || 0) * Math.PI) / 180;
  return w.vo + w.va * damp * Math.sin(2 * Math.PI * w.freq * tau + phaseRad);
}

/** Piecewise-linear: hold ends, interpolate between corners. */
function evalPwl(w, t) {
  const pts = w.pts;
  if (!pts?.length) return 0;
  if (t <= pts[0].t) return pts[0].v;
  if (t >= pts[pts.length - 1].t) return pts[pts.length - 1].v;
  for (let i = 1; i < pts.length; i++) {
    if (t <= pts[i].t) {
      const a = pts[i - 1];
      const b = pts[i];
      const u = (t - a.t) / (b.t - a.t || 1);
      return a.v + u * (b.v - a.v);
    }
  }
  return pts[pts.length - 1].v;
}

/** SPICE EXP(v1 v2 td1 tau1 td2 tau2). */
function evalExp(w, t) {
  const { v1, v2, td1, tau1, td2, tau2 } = w;
  if (t < td1) return v1;
  if (t < td2) {
    return v1 + (v2 - v1) * (1 - Math.exp(-(t - td1) / tau1));
  }
  return (
    v1 +
    (v2 - v1) * (1 - Math.exp(-(t - td1) / tau1)) +
    (v1 - v2) * (1 - Math.exp(-(t - td2) / tau2))
  );
}

/**
 * Parse `.option key=val …` / bare flags into circuit.options (+ analysis.method).
 */
function applyOptionLine(options, analysis, line, lineNo) {
  const body = line.replace(/^\.options?\s*/i, "");
  const re = /(\w+)\s*(?:=\s*([^\s=]+))?/gi;
  let m;
  let any = false;
  while ((m = re.exec(body))) {
    any = true;
    const key = m[1].toLowerCase();
    const raw = m[2];
    if (key === "temp") {
      if (raw == null) throw new Error(`.option ${key} needs a value (line ${lineNo})`);
      options.tempC = parseNumber(raw);
    } else if (key === "tnom") {
      if (raw == null) throw new Error(`.option tnom needs a value (line ${lineNo})`);
      options.tnom = parseNumber(raw);
    } else if (key === "reltol") {
      if (raw == null) throw new Error(`.option reltol needs a value (line ${lineNo})`);
      options.reltol = parseNumber(raw);
    } else if (key === "abstol") {
      if (raw == null) throw new Error(`.option abstol needs a value (line ${lineNo})`);
      options.abstol = parseNumber(raw);
    } else if (key === "vntol" || key === "voltol") {
      if (raw == null) throw new Error(`.option ${key} needs a value (line ${lineNo})`);
      options.vntol = parseNumber(raw);
    } else if (key === "gmin") {
      if (raw == null) throw new Error(`.option gmin needs a value (line ${lineNo})`);
      options.gmin = parseNumber(raw);
    } else if (key === "gminsteps") {
      if (raw == null) throw new Error(`.option gminsteps needs a value (line ${lineNo})`);
      options.gminSteps = Math.max(0, Math.round(parseNumber(raw)));
    } else if (key === "srcsteps") {
      if (raw == null) throw new Error(`.option srcsteps needs a value (line ${lineNo})`);
      options.srcSteps = Math.max(0, Math.round(parseNumber(raw)));
    } else if (key === "itl1" || key === "itlmax" || key === "maxiter") {
      if (raw == null) throw new Error(`.option ${key} needs a value (line ${lineNo})`);
      options.maxIter = Math.max(1, Math.round(parseNumber(raw)));
    } else if (key === "method") {
      if (raw == null) throw new Error(`.option method needs a value (line ${lineNo})`);
      const v = raw.toLowerCase();
      let meth;
      if (v === "gear" || v === "be" || v === "backward") meth = "be";
      else if (v === "trap" || v === "trapezoidal" || v === "trapezoid") meth = "trap";
      else throw new Error(`.option method must be trap|gear (line ${lineNo})`);
      options.method = meth;
      if (analysis?.type === "tran") analysis.method = meth;
    }
    // Unknown keys ignored (SPICE-compatible soft parse)
  }
  if (!any) throw new Error(`.option needs key=value pairs (line ${lineNo})`);
}
