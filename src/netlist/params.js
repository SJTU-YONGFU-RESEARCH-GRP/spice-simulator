import { parseNumber } from "../units.js";

/**
 * Expand .param definitions and replace {name} / {expr} in the netlist text.
 * Also expands .func name(args) {body} calls (inlined, non-recursive defs).
 *
 * Supports: .param Rload=1k Cval=1u
 *           R1 in out {Rload}
 *           .func clamp(x,lo,hi) {max(lo,min(hi,x))}
 *           B1 out 0 V=clamp(v(in),-1,1)
 */
export function expandParams(text) {
  const withFuncs = expandFuncs(text);
  const params = new Map();
  const outLines = [];

  for (const raw of withFuncs.split(/\r?\n/)) {
    let line = raw;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith(";")) {
      outLines.push(line);
      continue;
    }

    let code = line;
    const semi = code.indexOf(";");
    const comment = semi >= 0 ? code.slice(semi) : "";
    if (semi >= 0) code = code.slice(0, semi);

    const parts = code.trim().split(/\s+/);
    if (parts[0]?.toLowerCase() === ".param") {
      const rest = code.trim().slice(6);
      const re = /(\w+)\s*=\s*([^\s=]+)/g;
      let m;
      while ((m = re.exec(rest))) {
        const name = m[1];
        const rawVal = m[2];
        params.set(name.toLowerCase(), resolveExpr(rawVal, params));
      }
      outLines.push(line);
      continue;
    }

    const replaced = code.replace(/\{([^{}]+)\}/g, (_, expr) => {
      const v = resolveExpr(expr.trim(), params);
      return formatNum(v);
    });
    outLines.push(replaced + comment);
  }

  return { text: outLines.join("\n"), params };
}

/**
 * Collect .func defs and inline calls elsewhere.
 * .func name(a,b) {a+b}   or   .func name(a,b)=a+b
 */
export function expandFuncs(text) {
  const funcs = new Map(); // name -> { args: string[], body: string }
  const kept = [];

  for (const raw of text.split(/\r?\n/)) {
    let line = raw;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("*") || trimmed.startsWith(";")) {
      kept.push(line);
      continue;
    }
    let code = line;
    const semi = code.indexOf(";");
    const comment = semi >= 0 ? code.slice(semi) : "";
    if (semi >= 0) code = code.slice(0, semi);
    const low = code.trim().toLowerCase();
    if (low.startsWith(".func")) {
      const def = parseFuncDef(code.trim());
      if (def) funcs.set(def.name, { args: def.args, body: def.body });
      kept.push(`* ${code.trim()}${comment}`);
      continue;
    }
    kept.push(line);
  }

  if (!funcs.size) return kept.join("\n");

  return kept
    .map((line) => {
      const t = line.trim();
      if (!t || t.startsWith("*") || t.startsWith(";")) return line;
      if (t.toLowerCase().startsWith(".func")) return line;
      let code = line;
      const semi = code.indexOf(";");
      const comment = semi >= 0 ? code.slice(semi) : "";
      if (semi >= 0) code = code.slice(0, semi);
      const expanded = inlineFuncs(code, funcs);
      return expanded + comment;
    })
    .join("\n");
}

function parseFuncDef(line) {
  // .func name(a,b) {body}  |  .func name(a,b)=body
  const m =
    /^\.func\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*(?:\{([\s\S]*)\}|=\s*(.+))\s*$/i.exec(
      line
    );
  if (!m) throw new Error(`.func syntax: .func name(args) {expr} — got ${line}`);
  const name = m[1].toLowerCase();
  const args = m[2]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.toLowerCase());
  const body = (m[3] ?? m[4] ?? "").trim();
  if (!body) throw new Error(`.func ${name}: empty body`);
  return { name, args, body };
}

function inlineFuncs(code, funcs) {
  let out = code;
  // Iterate to allow nested / sequential calls (defs themselves are not recursive)
  for (let pass = 0; pass < 16; pass++) {
    let changed = false;
    for (const [fname, def] of funcs) {
      const re = new RegExp(`\\b${fname}\\s*\\(`, "gi");
      let m;
      const chunks = [];
      let last = 0;
      let localChanged = false;
      while ((m = re.exec(out))) {
        const open = m.index + m[0].length - 1;
        const close = findMatchingParen(out, open);
        if (close < 0) break;
        const argStr = out.slice(open + 1, close);
        const argVals = splitArgs(argStr);
        if (argVals.length !== def.args.length) {
          throw new Error(
            `.func ${fname} expects ${def.args.length} arg(s), got ${argVals.length}`
          );
        }
        let body = def.body;
        for (let i = 0; i < def.args.length; i++) {
          const arg = def.args[i];
          body = body.replace(new RegExp(`\\b${arg}\\b`, "gi"), `(${argVals[i]})`);
        }
        chunks.push(out.slice(last, m.index), `(${body})`);
        last = close + 1;
        re.lastIndex = close + 1;
        localChanged = true;
      }
      if (localChanged) {
        chunks.push(out.slice(last));
        out = chunks.join("");
        changed = true;
      }
    }
    if (!changed) break;
  }
  return out;
}

function findMatchingParen(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitArgs(s) {
  const out = [];
  let cur = "";
  let depth = 0;
  for (const ch of s) {
    if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
      cur += ch;
    } else if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function resolveExpr(expr, params) {
  const e = expr.trim();
  if (/^[a-zA-Z_]\w*$/.test(e)) {
    const key = e.toLowerCase();
    if (!params.has(key)) {
      return parseNumber(e);
    }
    return params.get(key);
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?(Meg|[tTgGkKmMuUnNpPfF])?$/.test(e)) {
    return parseNumber(e);
  }
  let js = e.replace(/(\d+\.?\d*|\.\d+)(Meg|[tTgGkKmMuUnNpPfF])/gi, (m) =>
    String(parseNumber(m))
  );
  js = js.replace(/[a-zA-Z_]\w*/g, (id) => {
    const key = id.toLowerCase();
    if (params.has(key)) return `(${params.get(key)})`;
    throw new Error(`Unknown .param '${id}' in {${expr}}`);
  });
  if (!/^[\d\s.+\-*/()eE]+$/.test(js)) {
    throw new Error(`Unsafe .param expression {${expr}}`);
  }
  // eslint-disable-next-line no-new-func
  const v = Function(`"use strict"; return (${js});`)();
  if (!Number.isFinite(v)) throw new Error(`Bad .param expression {${expr}}`);
  return v;
}

function formatNum(v) {
  if (!Number.isFinite(v)) return String(v);
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(6);
  return String(Number(v.toPrecision(10)));
}
