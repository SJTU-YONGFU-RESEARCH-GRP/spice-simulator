/**
 * Expression evaluator for behavioral B sources.
 * Numbers (with k/m/u/n/p/…), + - * / ^ **, ?: , && || comparisons,
 * sin cos tan exp ln log log10 abs sqrt min max pow u uramp,
 * v(node), v(n1,n2), time, temper, pi.
 */

const FUNCS = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  abs: Math.abs,
  sqrt: (x) => Math.sqrt(Math.max(0, x)),
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  u: (x) => (x >= 0 ? 1 : 0),
  uramp: (x) => (x > 0 ? x : 0),
};

const SUFFIX = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  x: 1e6,
  k: 1e3,
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
};

function normNode(n) {
  const s = String(n).trim();
  if (/^gnd$/i.test(s)) return "0";
  return s;
}

function tokenizeExpr(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (s.startsWith("**", i)) {
      out.push({ t: "**" });
      i += 2;
      continue;
    }
    if (
      s.startsWith("<=", i) ||
      s.startsWith(">=", i) ||
      s.startsWith("==", i) ||
      s.startsWith("!=", i) ||
      s.startsWith("&&", i) ||
      s.startsWith("||", i)
    ) {
      out.push({ t: s.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if ("+-*/^(),?:<>!".includes(c)) {
      out.push({ t: c });
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (j < s.length && /[eE]/.test(s[j])) {
        j++;
        if (j < s.length && /[+-]/.test(s[j])) j++;
        while (j < s.length && /[0-9]/.test(s[j])) j++;
      }
      let suf = "";
      if (s.slice(j, j + 3).toLowerCase() === "meg") {
        suf = "meg";
        j += 3;
      } else if (j < s.length && /[a-zA-Z]/.test(s[j])) {
        suf = s[j].toLowerCase();
        j++;
      }
      let v = Number(s.slice(i, j - suf.length));
      if (!Number.isFinite(v)) throw new Error(`bad number '${s.slice(i, j)}'`);
      if (suf) v *= SUFFIX[suf] ?? 1;
      out.push({ t: "num", v });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < s.length && /[A-Za-z0-9_:]/.test(s[j])) j++;
      out.push({ t: "id", v: s.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`bad character '${c}' in expression`);
  }
  return out;
}

/**
 * @param {string} src
 * @returns {{ eval: (ctx: {time?:number,temper?:number,v?:(n:string)=>number}) => number, nodes: string[] }}
 */
export function compileExpr(src) {
  const nodes = new Set();
  const tokens = tokenizeExpr(String(src || "").trim());
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];

  function parseTernary() {
    let a = parseOr();
    if (peek()?.t === "?") {
      take();
      const b = parseTernary();
      if (peek()?.t !== ":") throw new Error("ternary needs ':'");
      take();
      const c = parseTernary();
      return (ctx) => (a(ctx) ? b(ctx) : c(ctx));
    }
    return a;
  }
  function parseOr() {
    let a = parseAnd();
    while (peek()?.t === "||") {
      take();
      const b = parseAnd();
      const L = a;
      a = (ctx) => (L(ctx) || b(ctx) ? 1 : 0);
    }
    return a;
  }
  function parseAnd() {
    let a = parseCmp();
    while (peek()?.t === "&&") {
      take();
      const b = parseCmp();
      const L = a;
      a = (ctx) => (L(ctx) && b(ctx) ? 1 : 0);
    }
    return a;
  }
  function parseCmp() {
    let a = parseAdd();
    while (peek() && ["<", ">", "<=", ">=", "==", "!="].includes(peek().t)) {
      const op = take().t;
      const b = parseAdd();
      const L = a;
      a = (ctx) => {
        const x = L(ctx);
        const y = b(ctx);
        if (op === "<") return x < y ? 1 : 0;
        if (op === ">") return x > y ? 1 : 0;
        if (op === "<=") return x <= y ? 1 : 0;
        if (op === ">=") return x >= y ? 1 : 0;
        if (op === "==") return x === y ? 1 : 0;
        return x !== y ? 1 : 0;
      };
    }
    return a;
  }
  function parseAdd() {
    let a = parseMul();
    while (peek() && (peek().t === "+" || peek().t === "-")) {
      const op = take().t;
      const b = parseMul();
      const L = a;
      a = (ctx) => (op === "+" ? L(ctx) + b(ctx) : L(ctx) - b(ctx));
    }
    return a;
  }
  function parseMul() {
    let a = parsePow();
    while (peek() && (peek().t === "*" || peek().t === "/")) {
      const op = take().t;
      const b = parsePow();
      const L = a;
      a = (ctx) => {
        if (op === "*") return L(ctx) * b(ctx);
        const d = b(ctx);
        return L(ctx) / (d === 0 ? 1e-30 : d);
      };
    }
    return a;
  }
  function parsePow() {
    let a = parseUnary();
    if (peek() && (peek().t === "^" || peek().t === "**")) {
      take();
      const b = parsePow();
      const L = a;
      a = (ctx) => Math.pow(L(ctx), b(ctx));
    }
    return a;
  }
  function parseUnary() {
    if (peek()?.t === "+" || peek()?.t === "-") {
      const op = take().t;
      const a = parseUnary();
      return (ctx) => (op === "-" ? -a(ctx) : a(ctx));
    }
    if (peek()?.t === "!") {
      take();
      const a = parseUnary();
      return (ctx) => (a(ctx) ? 0 : 1);
    }
    return parsePrimary();
  }
  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error("unexpected end of expression");
    if (tok.t === "num") {
      take();
      const v = tok.v;
      return () => v;
    }
    if (tok.t === "(") {
      take();
      const a = parseTernary();
      if (peek()?.t !== ")") throw new Error("missing ')'");
      take();
      return a;
    }
    if (tok.t === "id") {
      take();
      const raw = tok.v;
      const name = raw.toLowerCase();
      if (peek()?.t === "(") {
        take();
        if (name === "v") {
          const n1tok = peek();
          if (n1tok?.t !== "id" && n1tok?.t !== "num") {
            throw new Error("v() needs node name");
          }
          take();
          let n2 = "0";
          if (peek()?.t === ",") {
            take();
            const n2tok = peek();
            if (n2tok?.t !== "id" && n2tok?.t !== "num") {
              throw new Error("v() second arg must be node name");
            }
            take();
            n2 = n2tok.t === "num" ? String(n2tok.v) : n2tok.v;
          }
          if (peek()?.t !== ")") throw new Error("missing ')' after v(");
          take();
          const a = normNode(n1tok.t === "num" ? String(n1tok.v) : n1tok.v);
          const b = normNode(n2);
          nodes.add(a);
          if (b !== "0") nodes.add(b);
          return (ctx) => (ctx.v?.(a) ?? 0) - (b === "0" ? 0 : ctx.v?.(b) ?? 0);
        }
        const args = [];
        if (peek()?.t !== ")") {
          args.push(parseTernary());
          while (peek()?.t === ",") {
            take();
            args.push(parseTernary());
          }
        }
        if (peek()?.t !== ")") throw new Error(`missing ')' after ${name}`);
        take();
        const fn = FUNCS[name];
        if (!fn) throw new Error(`unknown function ${name}`);
        return (ctx) => fn(...args.map((fnA) => fnA(ctx)));
      }
      if (name === "time") return (ctx) => ctx.time ?? 0;
      if (name === "temper" || name === "temp") return (ctx) => ctx.temper ?? 27;
      if (name === "pi") return () => Math.PI;
      if (name === "e") return () => Math.E;
      const node = normNode(raw);
      nodes.add(node);
      return (ctx) => ctx.v?.(node) ?? 0;
    }
    throw new Error(`unexpected token '${tok.t}'`);
  }

  if (!tokens.length) throw new Error("empty expression");
  const fn = parseTernary();
  if (i < tokens.length) throw new Error(`trailing tokens near '${tokens[i].t}'`);
  return { eval: fn, nodes: [...nodes] };
}

export function evalExpr(compiled, ctx) {
  return compiled.eval(ctx);
}
