/**
 * SVG schematic editor — places R/C/L/V/I/D/GND/FET/BJT/OPAMP/SW/CSW/K/NET/E/G/F/H/B, wires pins,
 * generates SPICE netlist into #netlist (preserves analysis directives).
 */

import { showContextMenu } from "./ctxmenu.js";

const PIN_R = 4;
const GRID = 10;

/** High-contrast schematic colors for Day / Night (HDL-aligned). */
function schematicPalette() {
  const root = document.documentElement;
  const dark = root.getAttribute("data-theme") === "dark";
  const css = (name, fallback) => {
    const v = getComputedStyle(root).getPropertyValue(name).trim();
    return v || fallback;
  };
  const accent = css("--accent", dark ? "#3d9e8c" : "#0f6b5c");
  const accentHover = css("--accent-hover", dark ? "#4db6a3" : "#0b5347");
  const ink = css("--ink", dark ? "#e8ebe6" : "#1c2421");
  const muted = css("--muted", dark ? "#8f9a94" : "#5c675f");
  const bg = css("--bg", dark ? "#121816" : "#f3efe6");
  const panel = css("--panel", dark ? "#1a221f" : "#fffdf8");
  const soft = css("--accent-soft", dark ? "#1a3330" : "#d7efe8");
  return {
    // Device outlines — strong on both themes
    symbol: dark ? accentHover : accentHover,
    symbolHi: dark ? accentHover : accent,
    fill: dark ? soft : soft,
    pinFill: dark ? panel : panel,
    wire: dark ? "#b7c4bc" : "#2f3b36",
    wireDim: muted,
    select: dark ? "#f2f5f0" : "#c23b22",
    selectSoft: dark ? "rgba(77,182,163,0.18)" : "rgba(15,107,92,0.14)",
    accent,
    accentHi: accentHover,
    label: dark ? "#c5d0c9" : "#1c2421",
    labelMuted: dark ? "#9aa89f" : "#4a564f",
    grid: dark ? "#3a4844" : "#b8aea0",
    bg,
    ink,
  };
}

const DEFAULTS = {
  R: "1k",
  C: "1u",
  L: "1m",
  V: "DC 5",
  I: "DC 1m",
  D: "DDEFAULT",
  NMOS: "NMOS W=10u L=1u",
  PMOS: "PMOS W=20u L=1u",
  NPN: "NPN",
  PNP: "PNP",
  OPAMP: "OPAMP",
  SW: "SW",
  CSW: "Vsense CSW",
  K: "L1 L2 0.9",
  NET: "out",
  E: "1000",
  G: "0.001",
  F: "Vsense 10",
  H: "Vsense 1000",
  B: "V=v(in)",
  GND: "",
};

/** Shared pin geometry for vertical 3-terminal semis (d/c top, g/b left, s/e bottom).
 *  All pin x/y must be integer multiples of GRID so rotated pins stay on-grid. */
const FET_PINS = [
  { id: "d", x: 0, y: -40, label: "D" },
  { id: "g", x: -40, y: 0, label: "G" },
  { id: "s", x: 0, y: 40, label: "S" },
];
const BJT_PINS = [
  { id: "c", x: 0, y: -40, label: "C" },
  { id: "b", x: -40, y: 0, label: "B" },
  { id: "e", x: 0, y: 40, label: "E" },
];

const DEVICE_PINS = {
  R: [
    { id: "a", x: -40, y: 0 },
    { id: "b", x: 40, y: 0 },
  ],
  C: [
    { id: "a", x: -30, y: 0 },
    { id: "b", x: 30, y: 0 },
  ],
  L: [
    { id: "a", x: -40, y: 0 },
    { id: "b", x: 40, y: 0 },
  ],
  V: [
    { id: "p", x: 0, y: -40, label: "+" },
    { id: "m", x: 0, y: 40, label: "−" },
  ],
  I: [
    { id: "p", x: 0, y: -40 },
    { id: "m", x: 0, y: 40 },
  ],
  D: [
    { id: "a", x: -30, y: 0, label: "A" },
    { id: "c", x: 30, y: 0, label: "K" },
  ],
  GND: [{ id: "g", x: 0, y: -20 }],
  M: FET_PINS, // legacy alias
  NMOS: FET_PINS,
  PMOS: FET_PINS,
  NPN: BJT_PINS,
  PNP: BJT_PINS,
  OPAMP: [
    { id: "plus", x: -40, y: -20, label: "+" },
    { id: "minus", x: -40, y: 20, label: "−" },
    { id: "out", x: 40, y: 0, label: "o" },
  ],
  // Voltage-controlled switch: channel a–b, control c1–c2
  SW: [
    { id: "a", x: -40, y: 0 },
    { id: "b", x: 40, y: 0 },
    { id: "c1", x: 0, y: -40, label: "c+" },
    { id: "c2", x: 0, y: 40, label: "c−" },
  ],
  // Current-controlled switch: channel only; Vname in value
  CSW: [
    { id: "a", x: -40, y: 0 },
    { id: "b", x: 40, y: 0 },
  ],
  // Mutual inductance label (no pins) — value = "L1 L2 k"
  K: [],
  // Net name tag — forces node name in generated netlist
  NET: [{ id: "n", x: 0, y: 0 }],
  // VCVS / VCCS: output a–b, sense c1–c2
  E: [
    { id: "a", x: 0, y: -40, label: "+" },
    { id: "b", x: 0, y: 40, label: "−" },
    { id: "c1", x: -40, y: -10, label: "+" },
    { id: "c2", x: -40, y: 10, label: "−" },
  ],
  G: [
    { id: "a", x: 0, y: -40, label: "+" },
    { id: "b", x: 0, y: 40, label: "−" },
    { id: "c1", x: -40, y: -10, label: "+" },
    { id: "c2", x: -40, y: 10, label: "−" },
  ],
  // CCCS / CCVS / B: channel only; control in value
  F: [
    { id: "a", x: 0, y: -40, label: "+" },
    { id: "b", x: 0, y: 40, label: "−" },
  ],
  H: [
    { id: "a", x: 0, y: -40, label: "+" },
    { id: "b", x: 0, y: 40, label: "−" },
  ],
  B: [
    { id: "a", x: 0, y: -40, label: "+" },
    { id: "b", x: 0, y: 40, label: "−" },
  ],
};

const FET_TYPES = new Set(["M", "NMOS", "PMOS"]);
const BJT_TYPES = new Set(["NPN", "PNP"]);

function isFet(type) {
  return FET_TYPES.has(type);
}
function isBjt(type) {
  return BJT_TYPES.has(type);
}
function isOpamp(type) {
  return type === "OPAMP";
}
function isSw(type) {
  return type === "SW";
}
function isCsw(type) {
  return type === "CSW";
}
function isK(type) {
  return type === "K";
}
function isNet(type) {
  return type === "NET";
}
function isEg(type) {
  return type === "E" || type === "G";
}
function isFh(type) {
  return type === "F" || type === "H";
}
function isBsrc(type) {
  return type === "B";
}
function spiceLetter(type) {
  if (isFet(type)) return "M";
  if (isBjt(type)) return "Q";
  if (isOpamp(type)) return "X";
  if (isSw(type)) return "S";
  if (isCsw(type)) return "W";
  if (isK(type)) return "K";
  if (isNet(type)) return "NET";
  if (type === "GND") return "GND";
  return type;
}

/** Map SPICE device line → schematic symbol type (NMOS/PMOS/NPN/PNP/OPAMP/…). */
function schematicTypeFromDevice(d) {
  if (d.kind === "M") {
    const model = String(d.parts[5] || "NMOS").toUpperCase();
    if (model.includes("PMOS") || model === "P") return "PMOS";
    return "NMOS";
  }
  if (d.kind === "Q") {
    const hasSub = d.parts.length >= 6 && !/=/.test(d.parts[4]);
    const model = String(d.parts[hasSub ? 5 : 4] || "NPN").toUpperCase();
    if (model.includes("PNP")) return "PNP";
    return "NPN";
  }
  if (d.kind === "X") {
    const sub = String(d.parts[d.parts.length - 1] || "").toUpperCase();
    if (sub === "OPAMP") return "OPAMP";
  }
  if (d.kind === "S") return "SW";
  if (d.kind === "W") return "CSW";
  if (d.kind === "K") return "K";
  return d.kind;
}

function firstToken(s) {
  return String(s || "")
    .trim()
    .split(/\s+/)[0];
}

/** Valid SPICE-ish node name for net labels. */
function sanitizeNetName(s) {
  const t = String(s || "")
    .trim()
    .split(/\s+/)[0];
  if (!t) return "";
  if (/^0$|^gnd$/i.test(t)) return "0";
  if (!/^[A-Za-z_][A-Za-z0-9_:$]*$/.test(t) && !/^[1-9][0-9]*$/.test(t)) {
    return t.replace(/[^A-Za-z0-9_:$]/g, "_") || "net";
  }
  return t;
}

/** Default .model lines for schematic-placed semis if missing from directives. */
function missingModelLines(components, existingDirs) {
  const have = new Set();
  for (const d of existingDirs) {
    const m = /^\.model\s+(\S+)/i.exec(d.trim());
    if (m) have.add(m[1].toUpperCase());
  }
  const out = [];
  const add = (name, line) => {
    const key = name.toUpperCase();
    if (have.has(key)) return;
    have.add(key);
    out.push(line);
  };
  for (const c of components) {
    if (c.type === "D") {
      const model = firstToken(c.value) || "DDEFAULT";
      add(model, `.model ${model} D (Is=1e-14 N=1)`);
    } else if (isFet(c.type)) {
      const model = firstToken(c.value) || c.type;
      if (c.type === "PMOS" || /PMOS/i.test(model)) {
        add(model, `.model ${model} PMOS (Vto=-0.7 Kp=50u Lambda=0.02)`);
      } else {
        add(model, `.model ${model} NMOS (Vto=0.7 Kp=50u Lambda=0.02)`);
      }
    } else if (isBjt(c.type)) {
      const model = firstToken(c.value) || c.type;
      if (c.type === "PNP" || /PNP/i.test(model)) {
        add(model, `.model ${model} PNP (Is=1e-15 Bf=100)`);
      } else {
        add(model, `.model ${model} NPN (Is=1e-15 Bf=100)`);
      }
    } else if (isSw(c.type)) {
      const model = firstToken(c.value) || "SW";
      add(model, `.model ${model} SW (Vt=0.5 Vh=0.1 Ron=1 Roff=1G)`);
    } else if (isCsw(c.type)) {
      const toks = String(c.value || "").trim().split(/\s+/);
      const model = toks[1] || "CSW";
      add(model, `.model ${model} CSW (It=1m Ih=0.1m Ron=1 Roff=1G)`);
    }
  }
  return out;
}

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

function snap(v) {
  return Math.round(v / GRID) * GRID;
}

/** Rotate local (x,y) by 0/90/180/270° (CW). */
function rotXY(x, y, deg) {
  const r = ((deg % 360) + 360) % 360;
  if (r === 90) return { x: -y, y: x };
  if (r === 180) return { x: -x, y: -y };
  if (r === 270) return { x: y, y: -x };
  return { x, y };
}

function pinLocal(pin, rot = 0) {
  return rotXY(pin.x, pin.y, rot || 0);
}

function manhattan(ax, ay, bx, by) {
  if (ax === bx || ay === by) return [{ x: ax, y: ay }, { x: bx, y: by }];
  const mx = snap((ax + bx) / 2);
  return [
    { x: ax, y: ay },
    { x: mx, y: ay },
    { x: mx, y: by },
    { x: bx, y: by },
  ];
}

/** Drop zero-length and collinear vertices from an orthogonal path. */
function simplifyOrtho(pts) {
  if (!pts?.length) return [];
  const out = [{ x: pts[0].x, y: pts[0].y }];
  for (let i = 1; i < pts.length; i++) {
    const p = { x: pts[i].x, y: pts[i].y };
    const prev = out[out.length - 1];
    if (p.x === prev.x && p.y === prev.y) continue;
    out.push(p);
  }
  let changed = true;
  while (changed && out.length >= 3) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1];
      const b = out[i];
      const c = out[i + 1];
      if ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y)) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Insert L-bends so every segment is horizontal or vertical. */
function ensureOrtho(pts) {
  if (!pts?.length) return [];
  const out = [{ x: pts[0].x, y: pts[0].y }];
  for (let i = 1; i < pts.length; i++) {
    const prev = out[out.length - 1];
    const q = { x: pts[i].x, y: pts[i].y };
    if (prev.x === q.x || prev.y === q.y) out.push(q);
    else out.push({ x: q.x, y: prev.y }, q);
  }
  return simplifyOrtho(out);
}

/**
 * Drag orthogonal segment `segIdx` toward cursor; pin endpoints stay fixed.
 * Returns a full point list (including pins).
 */
function dragOrthoSegment(basePts, segIdx, cursorX, cursorY) {
  const pts = basePts.map((p) => ({ x: p.x, y: p.y }));
  const n = pts.length;
  if (n < 2 || segIdx < 0 || segIdx >= n - 1) return pts;
  const a = pts[segIdx];
  const b = pts[segIdx + 1];
  const horiz = a.y === b.y;
  const only = n === 2;

  if (horiz) {
    const y = snap(cursorY);
    if (only) {
      if (y === a.y) return pts;
      return simplifyOrtho([pts[0], { x: pts[0].x, y }, { x: pts[1].x, y }, pts[1]]);
    }
    if (segIdx === 0) {
      return simplifyOrtho([
        pts[0],
        { x: pts[0].x, y },
        { x: pts[1].x, y },
        ...pts.slice(1),
      ]);
    }
    if (segIdx === n - 2) {
      return simplifyOrtho([
        ...pts.slice(0, -1),
        { x: pts[n - 2].x, y },
        { x: pts[n - 1].x, y },
        pts[n - 1],
      ]);
    }
    pts[segIdx].y = y;
    pts[segIdx + 1].y = y;
    return simplifyOrtho(pts);
  }

  const x = snap(cursorX);
  if (only) {
    if (x === a.x) return pts;
    return simplifyOrtho([pts[0], { x, y: pts[0].y }, { x, y: pts[1].y }, pts[1]]);
  }
  if (segIdx === 0) {
    return simplifyOrtho([
      pts[0],
      { x, y: pts[0].y },
      { x, y: pts[1].y },
      ...pts.slice(1),
    ]);
  }
  if (segIdx === n - 2) {
    return simplifyOrtho([
      ...pts.slice(0, -1),
      { x, y: pts[n - 2].y },
      { x, y: pts[n - 1].y },
      pts[n - 1],
    ]);
  }
  pts[segIdx].x = x;
  pts[segIdx + 1].x = x;
  return simplifyOrtho(pts);
}

function routeFromPoints(pts) {
  if (!pts || pts.length < 3) return [];
  return pts.slice(1, -1).map((p) => ({ x: p.x, y: p.y }));
}

/** Union-find */
class UF {
  constructor() {
    this.p = new Map();
  }
  add(x) {
    if (!this.p.has(x)) this.p.set(x, x);
  }
  find(x) {
    this.add(x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    let cur = x;
    while (cur !== r) {
      const n = this.p.get(cur);
      this.p.set(cur, r);
      cur = n;
    }
    return r;
  }
  union(a, b) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

function pinKey(cid, pinId) {
  return `${cid}:${pinId}`;
}

function normNode(n) {
  const s = String(n);
  if (s === "0" || s.toLowerCase() === "gnd" || s.toLowerCase() === "ground") return "0";
  return s;
}

function tokenizeLine(line) {
  const normalized = line
    .replace(/\s*\(\s*/g, "(")
    .replace(/\s*\)\s*/g, ")")
    .replace(/,\s*/g, " ");
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
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function extractDirectives(text) {
  const keep = [];
  for (const raw of (text || "").split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) continue;
    const low = t.toLowerCase();
    if (
      low.startsWith(".tran") ||
      low.startsWith(".ac") ||
      low.startsWith(".disto") ||
      low.startsWith(".pz") ||
      low.startsWith(".mc") ||
      low.startsWith(".noise") ||
      low.startsWith(".temp") ||
      low.startsWith(".dc") ||
      low.startsWith(".op") ||
      low.startsWith(".ic") ||
      low.startsWith(".nodeset") ||
      low.startsWith(".option") ||
      low.startsWith(".options") ||
      low.startsWith(".param") ||
      low.startsWith(".func") ||
      low.startsWith(".subckt") ||
      low.startsWith(".ends") ||
      low.startsWith(".model") ||
      low.startsWith(".meas") ||
      low.startsWith(".tf") ||
      low.startsWith(".step") ||
      low.startsWith(".four") ||
      low.startsWith(".print") ||
      low.startsWith(".include") ||
      low.startsWith(".inc") ||
      low.startsWith(".end")
    ) {
      keep.push(t);
    }
  }
  if (!keep.some((l) => l.toLowerCase().startsWith(".end"))) keep.push(".end");
  if (
    !keep.some((l) => {
      const x = l.toLowerCase();
      return (
        x.startsWith(".tran") ||
        x.startsWith(".ac") ||
        x.startsWith(".disto") ||
        x.startsWith(".pz") ||
        x.startsWith(".mc") ||
        x.startsWith(".dc") ||
        x.startsWith(".op") ||
        x.startsWith(".noise") ||
        x.startsWith(".tf")
      );
    })
  ) {
    keep.unshift(".tran 10u 5m");
  }
  return keep;
}

const SCH_LAYOUT_RE = /^\*\s*@sch-layout(\+)?\s*(.*)$/i;

/** Pull embedded schematic layout JSON from netlist comment lines. */
function extractSchLayout(text) {
  let json = "";
  let collecting = false;
  for (const raw of (text || "").split(/\r?\n/)) {
    const t = raw.trim();
    const m = SCH_LAYOUT_RE.exec(t);
    if (!m) {
      if (collecting) break;
      continue;
    }
    const cont = !!m[1];
    if (!cont && collecting) break;
    if (!cont) {
      json = m[2] || "";
      collecting = true;
    } else if (collecting) {
      json += m[2] || "";
    }
  }
  if (!json) return null;
  try {
    const layout = JSON.parse(json);
    return layout?.v === 1 ? layout : null;
  } catch {
    return null;
  }
}

function stripSchLayoutLines(text) {
  return (text || "")
    .split(/\r?\n/)
    .filter((l) => !SCH_LAYOUT_RE.test(l.trim()))
    .join("\n");
}

/** Embed layout as * @sch-layout comment chunks (before .end). */
function embedSchLayout(netlist, layout) {
  const base = stripSchLayoutLines(netlist).replace(/\s+$/, "");
  let json;
  try {
    json = JSON.stringify(layout);
  } catch {
    return base.endsWith("\n") ? base : `${base}\n`;
  }
  const chunk = 140;
  const layoutLines = [];
  for (let i = 0; i < json.length; i += chunk) {
    const slice = json.slice(i, i + chunk);
    layoutLines.push(i === 0 ? `* @sch-layout ${slice}` : `* @sch-layout+ ${slice}`);
  }
  const arr = base ? base.split(/\r?\n/) : [];
  const endIdx = arr.findIndex((l) => l.trim().toLowerCase().startsWith(".end"));
  if (endIdx >= 0) arr.splice(endIdx, 0, ...layoutLines);
  else arr.push(...layoutLines);
  return `${arr.join("\n")}\n`;
}

function symbolPaths(type, P) {
  const accent = P?.symbolHi || P?.accent || "#0f6b5c";
  const wire = P?.wire || "#2f3b36";
  switch (type) {
    case "R":
      return {
        body: `M -40 0 H -28 L -22 -10 L -10 10 L 2 -10 L 14 10 L 26 -10 L 28 0 H 40`,
        fill: false,
      };
    case "C":
      return {
        body: `M -30 0 H -10 M -10 -14 V 14 M 10 -14 V 14 M 10 0 H 30`,
        fill: false,
      };
    case "L":
      return {
        body: `M -40 0 H -28
          A 8 8 0 0 1 -12 0
          A 8 8 0 0 1 4 0
          A 8 8 0 0 1 20 0
          A 8 8 0 0 1 28 0
          H 40`,
        fill: false,
      };
    case "V":
      return {
        body: `M 0 -40 V -20 M 0 20 V 40`,
        circle: { cx: 0, cy: 0, r: 18 },
        marks: [
          { d: "M -5 -6 H 5 M 0 -11 V -1", stroke: accent },
          { d: "M -5 8 H 5", stroke: wire },
        ],
        fill: false,
      };
    case "I":
      return {
        body: `M 0 -40 V -20 M 0 20 V 40`,
        circle: { cx: 0, cy: 0, r: 18 },
        marks: [{ d: "M 0 10 V -8 M -5 -2 L 0 -10 L 5 -2", stroke: accent }],
        fill: false,
      };
    case "D":
      return {
        body: `M -30 0 H -10 M 10 0 H 30 M 10 -12 V 12`,
        poly: "-10,-12 -10,12 10,0",
        fill: true,
      };
    case "GND":
      return {
        body: `M 0 -20 V 0 M -14 0 H 14 M -9 6 H 9 M -4 12 H 4`,
        fill: false,
      };
    case "M":
    case "NMOS":
      // IEEE enhancement NMOS: insulated gate, arrow on source → channel
      return {
        body: `
          M 0 -40 V -16
          M 0 16 V 40
          M 0 -16 H -8 M 0 0 H -8 M 0 16 H -8
          M -8 -18 V 18
          M -16 -18 V 18
          M -40 0 H -16
        `,
        polys: [{ points: "0,8 -6,18 6,18", fill: true }],
        fill: false,
      };
    case "PMOS":
      // IEEE enhancement PMOS: gate bubble + arrow on source ← channel
      return {
        body: `
          M 0 -40 V -16
          M 0 16 V 40
          M 0 -16 H -8 M 0 0 H -8 M 0 16 H -8
          M -8 -18 V 18
          M -18 -18 V 18
          M -40 0 H -26
        `,
        circles: [{ cx: -22, cy: 0, r: 4 }],
        polys: [{ points: "0,24 -6,14 6,14", fill: true }],
        fill: false,
      };
    case "NPN":
      // Circle BJT, emitter arrow pointing out
      return {
        circle: { cx: 0, cy: 0, r: 22 },
        body: `
          M 0 -40 V -18
          M -40 0 H -10
          M -10 -16 V 16
          M -10 -8 L 10 -22
          M 10 -22 L 0 -40
          M -10 8 L 10 22
          M 10 22 L 0 40
        `,
        polys: [{ points: "2,18 12,28 14,16", fill: true }],
        fill: false,
      };
    case "PNP":
      // Circle BJT, emitter arrow pointing in
      return {
        circle: { cx: 0, cy: 0, r: 22 },
        body: `
          M 0 -40 V -18
          M -40 0 H -10
          M -10 -16 V 16
          M -10 -8 L 10 -22
          M 10 -22 L 0 -40
          M -10 8 L 10 22
          M 10 22 L 0 40
        `,
        polys: [{ points: "14,28 4,18 2,30", fill: true }],
        fill: false,
      };
    case "OPAMP":
      // Triangle amp: −/+ left, out right (outline); pins on GRID
      return {
        body: `
          M -40 -20 H -30
          M -40 20 H -30
          M 30 0 H 40
          M -30 -30 L 30 0 L -30 30 Z
        `,
        marks: [
          { d: "M -22 -20 H -14 M -18 -24 V -16", stroke: wire },
          { d: "M -22 20 H -14", stroke: wire },
        ],
        fill: false,
      };
    case "SW":
      // Channel with break + control stubs
      return {
        body: `
          M -40 0 H -20
          M 20 0 H 40
          M -20 0 L 10 -10
          M 0 -40 V -20
          M 0 20 V 40
        `,
        circles: [{ cx: -20, cy: 0, r: 2.5 }, { cx: 20, cy: 0, r: 2.5 }],
        fill: false,
      };
    case "CSW":
      return {
        body: `
          M -40 0 H -20
          M 20 0 H 40
          M -20 0 L 10 -10
        `,
        circles: [{ cx: -20, cy: 0, r: 2.5 }, { cx: 20, cy: 0, r: 2.5 }],
        marks: [{ d: "M -6 12 H 6 M 0 6 V 18", stroke: wire }],
        fill: false,
      };
    case "K":
      return {
        body: `
          M -22 -8 A 14 14 0 0 1 -22 8
          M 22 -8 A 14 14 0 0 0 22 8
          M -8 0 H 8
        `,
        fill: false,
      };
    case "NET":
      return {
        body: `
          M 0 0 H 30
          M 30 -10 L 40 0 L 30 10 Z
        `,
        fill: false,
      };
    case "E":
    case "G":
      return {
        body: `
          M 0 -40 V -20
          M 0 20 V 40
          M -40 -10 H -20
          M -40 10 H -20
          M 0 -20 L 20 0 L 0 20 L -20 0 Z
        `,
        marks:
          type === "E"
            ? [
                { d: "M -4 -6 H 4 M 0 -10 V -2", stroke: accent },
                { d: "M -4 6 H 4", stroke: wire },
              ]
            : [{ d: "M 0 8 V -6 M -4 0 L 0 -8 L 4 0", stroke: accent }],
        fill: false,
      };
    case "F":
    case "H":
      return {
        body: `
          M 0 -40 V -20
          M 0 20 V 40
          M 0 -20 L 20 0 L 0 20 L -20 0 Z
        `,
        marks:
          type === "H"
            ? [
                { d: "M -4 -6 H 4 M 0 -10 V -2", stroke: accent },
                { d: "M -4 6 H 4", stroke: wire },
              ]
            : [{ d: "M 0 8 V -6 M -4 0 L 0 -8 L 4 0", stroke: accent }],
        fill: false,
      };
    case "B":
      return {
        body: `
          M 0 -40 V -20
          M 0 20 V 40
          M 0 -20 L 20 0 L 0 20 L -20 0 Z
        `,
        marks: [{ d: "M -6 0 Q -2 -8 2 0 Q 6 8 10 0", stroke: accent }],
        fill: false,
      };
    default:
      return { body: "", fill: false };
  }
}

export class SchematicEditor {
  /**
   * @param {HTMLElement} root
   * @param {HTMLTextAreaElement} netlistEl
   * @param {{ onLog?: (msg: string) => void }} [opts]
   */
  constructor(root, netlistEl, opts = {}) {
    this.root = root;
    this.netlistEl = netlistEl;
    this.onLog = opts.onLog || (() => {});
    this.onPinProbe = opts.onPinProbe || null;
    this.components = [];
    this.wires = [];
    this.selComps = new Set();
    this.selWires = new Set();
    this.mode = "select"; // select | pan | place | wire
    this.placeType = null;
    this.wireStart = null; // { cid, pinId }
    this.wireDrag = null; // drag-to-wire: { a, moved }
    this.segDrag = null; // reshape wire: { wireId, segIndex, basePts }
    this.vertDrag = null; // drag corner: { wireId, vertIndex, basePts }
    this.drag = null;
    this.box = null; // rubber-band { x0,y0,x1,y1 } world coords
    this.counters = {
      R: 0,
      C: 0,
      L: 0,
      V: 0,
      I: 0,
      D: 0,
      M: 0,
      Q: 0,
      X: 0,
      S: 0,
      W: 0,
      K: 0,
      E: 0,
      G: 0,
      F: 0,
      H: 0,
      B: 0,
      NET: 0,
      GND: 0,
    };
    this.probes = {};
    this._syncing = false;
    this._undo = [];
    this._redo = [];
    this.view = { x: 0, y: 0, scale: 1 };
    this.pan = null;
    this._dragMoved = false;
    this._clipboard = null;
    this.hoverNet = null;
    this._spaceDown = false;
    this._pointers = new Map();
    this._pinch = null;
    this._longPress = null;
    this._suppressClick = false;
    this._buildDom();
    this._bind();
    this.render();
  }

  _buildDom() {
    this.root.innerHTML = "";
    this.root.classList.add("schematic-root");

    const toolbar = document.createElement("div");
    toolbar.className = "schematic-toolbar";

    // [id, label, placeType|null, hotkey]
    const tools = [
      ["select", "Select", null, "S"],
      ["pan", "Pan", null, "Space"],
      ["wire", "Wire", null, "W"],
      ["R", "R", "R", "1"],
      ["C", "C", "C", "2"],
      ["L", "L", "L", "3"],
      ["V", "V", "V", "4"],
      ["I", "I", "I", "5"],
      ["D", "D", "D", "6"],
      ["GND", "GND", "GND", "7"],
      ["NMOS", "nMOS", "NMOS", "8"],
      ["PMOS", "pMOS", "PMOS", "9"],
      ["NPN", "NPN", "NPN", "N"],
      ["PNP", "PNP", "PNP", "P"],
      ["OPAMP", "OA", "OPAMP", "O"],
      ["SW", "SW", "SW", "U"],
      ["CSW", "CSW", "CSW", "J"],
      ["K", "K", "K", "K"],
      ["NET", "Net", "NET", "L"],
      ["E", "E", "E", "E"],
      ["G", "G", "G", "G"],
      ["F", "F", "F", "F"],
      ["H", "H", "H", "H"],
      ["B", "B", "B", "B"],
    ];

    this.toolBtns = {};
    for (const [id, label, place, hotkey] of tools) {
      const b = document.createElement("button");
      b.type = "button";
      b.dataset.tool = id;
      const lab = document.createElement("span");
      lab.className = "tool-label";
      lab.textContent = label;
      b.appendChild(lab);
      if (hotkey) {
        const kbd = document.createElement("kbd");
        kbd.className = "tool-kbd";
        kbd.textContent = hotkey;
        b.appendChild(kbd);
      }
      b.title = place
        ? `Place ${place} · key ${hotkey}`
        : id === "wire"
          ? "Wire: tap pin → pin · key W"
          : id === "pan"
            ? "Pan view · hold Space + drag, or two-finger drag"
            : "Select / box / move · key S";
      b.addEventListener("click", () => {
        if (place) {
          this.mode = "place";
          this.placeType = place;
        } else {
          this.mode = id;
          this.placeType = null;
        }
        this.wireStart = null;
        this._updateToolUi();
      });
      toolbar.appendChild(b);
      this.toolBtns[id] = b;
    }

    const actions = document.createElement("div");
    actions.className = "schematic-actions";

    const mkAction = (label, title, fn, extraClass = "") => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sch-action" + (extraClass ? ` ${extraClass}` : "");
      btn.title = title;
      // Allow HTML-ish label with optional kbd via "Label|KEY"
      const [lab, key] = String(label).split("|");
      const span = document.createElement("span");
      span.textContent = lab;
      btn.appendChild(span);
      if (key) {
        const kbd = document.createElement("kbd");
        kbd.className = "tool-kbd";
        kbd.textContent = key;
        btn.appendChild(kbd);
      }
      btn.addEventListener("click", fn);
      return btn;
    };

    const btnRotate = mkAction("Rotate|R", "Rotate selected 90° (also right-click / long-press)", () =>
      this.rotateSelected()
    );
    const btnEdit = mkAction("Edit", "Edit selected value (double-tap)", () => this._editSelected());
    const btnDup = mkAction("Dup|Ctrl+D", "Duplicate selected", () => this.duplicateSelected());
    const btnDel = mkAction("Delete|Del", "Delete selected", () => this.deleteSelected(), "danger");
    const btnUndo = mkAction("Undo|Z", "Undo (Ctrl+Z)", () => this.undo());
    const btnRedo = mkAction("Redo|Y", "Redo (Ctrl+Y)", () => this.redo());
    const btnZoomOut = mkAction("−", "Zoom out", () => this._zoomCenter(0.9));
    const btnZoomIn = mkAction("+", "Zoom in", () => this._zoomCenter(1.111));
    const btnFit = mkAction("Fit|0", "Fit in view (Ctrl+0)", () => this.fitView());

    const btnSync = mkAction("→ Netlist", "Generate netlist from schematic", () => {
      this.syncToNetlist();
      this.onLog("Schematic → netlist");
    });
    const btnFrom = mkAction("← Netlist", "Parse netlist into schematic (restores @sch-layout if present)", () => {
      try {
        const restored = this.fromNetlist(this.netlistEl.value);
        this.onLog(
          restored
            ? "Netlist → schematic (restored saved layout)"
            : "Netlist → schematic (auto layout)"
        );
      } catch (e) {
        this.onLog(String(e.message || e));
      }
    });
    const btnSvg = mkAction("SVG", "Download schematic as SVG", () => this.exportSvg());
    const btnClear = mkAction("Clear", "Clear schematic", () => {
      this._pushHistory();
      this.components = [];
      this.wires = [];
      this._clearSelection();
      this.counters = {
        R: 0,
        C: 0,
        L: 0,
        V: 0,
        I: 0,
        D: 0,
        M: 0,
        Q: 0,
        X: 0,
        S: 0,
        W: 0,
        K: 0,
        E: 0,
        G: 0,
        F: 0,
        H: 0,
        B: 0,
        NET: 0,
        GND: 0,
      };
      this.render();
      this.syncToNetlist();
    });

    actions.append(
      btnRotate,
      btnEdit,
      btnDup,
      btnDel,
      btnUndo,
      btnRedo,
      btnZoomOut,
      btnZoomIn,
      btnFit,
      btnSync,
      btnFrom,
      btnSvg,
      btnClear
    );
    toolbar.appendChild(actions);

    const tips = document.createElement("div");
    tips.className = "schematic-tips";
    tips.setAttribute("role", "status");
    this.tipsEl = tips;

    const wrap = document.createElement("div");
    wrap.className = "schematic-canvas-wrap";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "schematic-svg");
    svg.setAttribute("tabindex", "0");

    wrap.appendChild(svg);
    this.root.append(toolbar, tips, wrap);
    this.svg = svg;
    this._updateToolUi();
  }

  _updateToolUi() {
    for (const [id, b] of Object.entries(this.toolBtns)) {
      const active =
        (this.mode === "place" && this.placeType === id) ||
        (this.mode !== "place" && this.mode === id);
      b.classList.toggle("active", !!active);
    }
    if (this.mode === "place") this.svg.style.cursor = "crosshair";
    else if (this.mode === "wire") this.svg.style.cursor = "cell";
    else if (this.mode === "pan" || this._spaceDown) this.svg.style.cursor = "grab";
    else this.svg.style.cursor = "default";
    this._updateTips();
  }

  _updateTips() {
    if (!this.tipsEl) return;
    const sel = this._hasSelection();
    let modeHint = "";
    if (this.mode === "place" && this.placeType) {
      modeHint = `Place ${this.placeType}: tap empty canvas · Esc cancel`;
    } else if (this.mode === "wire") {
      modeHint = "Wire: drag pin → pin, or click pin → pin · Esc cancel";
    } else if (this.mode === "pan") {
      modeHint = "Pan: drag canvas · or use Zoom ± / Fit";
    } else {
      modeHint = sel
        ? "Selected: drag segment or corner to reshape · Reset route in menu"
        : "Select · drag pin→pin to wire · drag wire segment/corner to reshape";
    }
    this.tipsEl.innerHTML = "";
    const main = document.createElement("span");
    main.className = "tips-main";
    main.textContent = modeHint;
    const keys = document.createElement("span");
    keys.className = "tips-keys";
    keys.innerHTML =
      "<kbd>R</kbd> rotate · <kbd>Del</kbd> delete · <kbd>Space</kbd> pan · pinch / two-finger drag · long-press menu";
    this.tipsEl.append(main, keys);
  }

  _editSelected() {
    const id = [...this.selComps][0];
    if (!id) {
      this.onLog("Select a component first");
      return;
    }
    const comp = this.components.find((c) => c.id === id);
    if (comp) this.editComponent(comp);
  }

  _zoomCenter(factor) {
    const rect = this.svg.getBoundingClientRect();
    this._zoomAt(factor, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  _zoomAt(factor, clientX, clientY) {
    const before = this._svgPoint({ clientX, clientY });
    const next = Math.min(4, Math.max(0.25, this.view.scale * factor));
    if (next === this.view.scale) return;
    this.view.scale = next;
    const after = this._svgPoint({ clientX, clientY });
    this.view.x += before.x - after.x;
    this.view.y += before.y - after.y;
    this.render();
  }

  _cancelLongPress() {
    if (this._longPress?.timer) clearTimeout(this._longPress.timer);
    this._longPress = null;
  }

  _startLongPress(e) {
    this._cancelLongPress();
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const cx = e.clientX;
    const cy = e.clientY;
    this._longPress = {
      x: cx,
      y: cy,
      pointerId: e.pointerId,
      timer: setTimeout(() => {
        this._longPress = null;
        this._suppressClick = true;
        // Cancel drag/box so menu doesn't fight the gesture
        this.drag = null;
        this.box = null;
        this.pan = null;
        this._onContextMenu({
          clientX: cx,
          clientY: cy,
          preventDefault() {},
          stopPropagation() {},
        });
      }, 480),
    };
  }

  _bind() {
    this.svg.addEventListener("pointerdown", (e) => this._onDown(e));
    this.svg.addEventListener("pointermove", (e) => this._onMove(e));
    this.svg.addEventListener("pointerup", (e) => this._onUp(e));
    this.svg.addEventListener("pointercancel", (e) => this._onUp(e));
    this.svg.addEventListener("dblclick", (e) => this._onDblClick(e));
    this.svg.addEventListener(
      "wheel",
      (e) => {
        if (!this.isVisible()) return;
        e.preventDefault();
        this._onWheel(e);
      },
      { passive: false }
    );
    this.svg.addEventListener("contextmenu", (e) => this._onContextMenu(e));
    this.svg.addEventListener("pointerleave", () => {
      if (this.drag || this.pan || this.box || this._pinch) return;
      if (this.hoverNet == null) return;
      this.hoverNet = null;
      this.render();
    });
    this.svg.addEventListener("lostpointercapture", () => {
      if (this.wireDrag) {
        if (this.wireDrag.moved) this.wireStart = null;
        this.wireDrag = null;
      }
      if (this.segDrag || this.vertDrag) {
        if (!this._dragMoved && this._undo.length) this._undo.pop();
        this.segDrag = null;
        this.vertDrag = null;
        this._dragMoved = false;
        this.syncToNetlist();
      }
      if (this.drag) {
        if (!this._dragMoved && this._undo.length) this._undo.pop();
        this.drag = null;
        this._dragMoved = false;
        this.syncToNetlist();
        this._updateToolUi();
      }
      if (this.pan) this.pan = null;
    });

    this._onKey = (e) => {
      if (!this.isVisible()) return;
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "TEXTAREA" || tag === "INPUT") return;
      const mod = e.ctrlKey || e.metaKey;
      if (e.code === "Space" && !mod) {
        if (!e.repeat) {
          this._spaceDown = true;
          this._updateToolUi();
        }
        e.preventDefault();
        return;
      }
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
        return;
      }
      if (mod && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        this.redo();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        this.deleteSelected();
      } else if (e.key === "Escape") {
        this.mode = "select";
        this.placeType = null;
        this.wireStart = null;
        this.wireDrag = null;
        this.segDrag = null;
        this.vertDrag = null;
        this.pan = null;
        this._updateToolUi();
        this.render();
      } else if (e.key === "r" || e.key === "R") {
        e.preventDefault();
        this.rotateSelected();
      } else if (e.key === "0" && mod) {
        e.preventDefault();
        this.fitView();
      } else if (mod && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        this.copySelected();
      } else if (mod && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        this.pasteClipboard();
      } else if (mod && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        this.duplicateSelected();
      } else if (!mod) {
        const hot = {
          w: "wire",
          s: "select",
          1: "R",
          2: "C",
          3: "L",
          4: "V",
          5: "I",
          6: "D",
          7: "GND",
          8: "NMOS",
          9: "PMOS",
          n: "NPN",
          p: "PNP",
          o: "OPAMP",
          u: "SW",
          j: "CSW",
          k: "K",
          l: "NET",
          e: "E",
          g: "G",
          f: "F",
          h: "H",
          b: "B",
        };
        const tool = hot[e.key];
        if (tool) {
          e.preventDefault();
          if (tool === "select" || tool === "wire") {
            this.mode = tool;
            this.placeType = null;
          } else {
            this.mode = "place";
            this.placeType = tool;
          }
          this.wireStart = null;
          this._updateToolUi();
        }
      }
    };
    this._onKeyUp = (e) => {
      if (e.code === "Space") {
        this._spaceDown = false;
        if (this.pan && !this._pinch) this.pan = null;
        this._updateToolUi();
      }
    };
    window.addEventListener("keydown", this._onKey);
    window.addEventListener("keyup", this._onKeyUp);

    this._ro = new ResizeObserver(() => {
      if (this.isVisible()) this.render();
    });
    this._ro.observe(this.root);
  }

  _snapshot() {
    return JSON.stringify({
      components: this.components,
      wires: this.wires,
      counters: this.counters,
    });
  }

  _pushHistory() {
    this._undo.push(this._snapshot());
    if (this._undo.length > 80) this._undo.shift();
    this._redo.length = 0;
  }

  _restore(snap) {
    const s = JSON.parse(snap);
    this.components = s.components;
    this.wires = s.wires;
    this.counters = s.counters;
    this._clearSelection();
    this.wireStart = null;
    this.wireDrag = null;
    this.segDrag = null;
    this.vertDrag = null;
    this.drag = null;
    this.box = null;
    this.pan = null;
    this.render();
    this.syncToNetlist();
  }

  undo() {
    if (!this._undo.length) return;
    this._redo.push(this._snapshot());
    this._restore(this._undo.pop());
    this.onLog("Schematic undo");
  }

  redo() {
    if (!this._redo.length) return;
    this._undo.push(this._snapshot());
    this._restore(this._redo.pop());
    this.onLog("Schematic redo");
  }

  _viewSize() {
    const w = Math.max(400, this.root.clientWidth || 400);
    const chrome = (this.root.querySelector(".schematic-toolbar")?.offsetHeight || 40) +
      (this.tipsEl?.offsetHeight || 0);
    const h = Math.max(280, (this.root.clientHeight || 320) - chrome);
    const scale = this.view.scale || 1;
    return { w, h, vw: w / scale, vh: h / scale, scale };
  }

  _onWheel(e) {
    const factor = e.deltaY > 0 ? 0.9 : 1.111;
    this._zoomAt(factor, e.clientX, e.clientY);
  }

  _pinchDist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _pinchCenter(a, b) {
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  _beginPinch() {
    const pts = [...this._pointers.values()];
    if (pts.length < 2) {
      this._pinch = null;
      return;
    }
    const [a, b] = pts;
    const mid = this._pinchCenter(a, b);
    const world = this._svgPoint({ clientX: mid.x, clientY: mid.y });
    this._pinch = {
      dist: this._pinchDist(a, b) || 1,
      scale: this.view.scale,
      worldX: world.x,
      worldY: world.y,
    };
    this.drag = null;
    this.box = null;
    this.pan = null;
    this._cancelLongPress();
  }

  _updatePinch() {
    if (!this._pinch) return;
    const pts = [...this._pointers.values()];
    if (pts.length < 2) return;
    const [a, b] = pts;
    const dist = this._pinchDist(a, b) || 1;
    const mid = this._pinchCenter(a, b);
    const next = Math.min(4, Math.max(0.25, this._pinch.scale * (dist / this._pinch.dist)));
    this.view.scale = next;
    const after = this._svgPoint({ clientX: mid.x, clientY: mid.y });
    this.view.x += this._pinch.worldX - after.x;
    this.view.y += this._pinch.worldY - after.y;
    this.render();
  }

  fitView() {
    const { w, h } = this._viewSize();
    if (!this.components.length) {
      this.view = { x: 0, y: 0, scale: 1 };
      this.render();
      return;
    }
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const c of this.components) {
      for (const p of DEVICE_PINS[c.type] || []) {
        const lp = pinLocal(p, c.rot);
        minX = Math.min(minX, c.x + lp.x);
        maxX = Math.max(maxX, c.x + lp.x);
        minY = Math.min(minY, c.y + lp.y);
        maxY = Math.max(maxY, c.y + lp.y);
      }
    }
    const pad = 60;
    const bw = Math.max(80, maxX - minX + pad * 2);
    const bh = Math.max(80, maxY - minY + pad * 2);
    const scale = Math.min(4, Math.max(0.25, Math.min(w / bw, h / bh)));
    this.view.scale = scale;
    this.view.x = minX - pad - (w / scale - bw) / 2;
    this.view.y = minY - pad - (h / scale - bh) / 2;
    this.render();
  }

  exportSvg() {
    this.render();
    const clone = this.svg.cloneNode(true);
    clone.removeAttribute("tabindex");
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n${clone.outerHTML}`;
    const blob = new Blob([xml], { type: "image/svg+xml;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `schematic-${Date.now()}.svg`;
    a.click();
    URL.revokeObjectURL(a.href);
    this.onLog("Downloaded schematic SVG");
  }

  isVisible() {
    return this.root.classList.contains("is-visible");
  }

  setVisible(v) {
    this.root.classList.toggle("is-visible", v);
    this.root.hidden = !v;
    if (v) {
      this.render();
      this.svg.focus({ preventScroll: true });
    }
  }

  _svgPoint(e) {
    // Manual viewBox mapping — more reliable than createSVGPoint/CTM during re-renders
    const rect = this.svg.getBoundingClientRect();
    const { vw, vh } = this._viewSize();
    const w = rect.width || 1;
    const h = rect.height || 1;
    return {
      x: this.view.x + ((e.clientX - rect.left) / w) * vw,
      y: this.view.y + ((e.clientY - rect.top) / h) * vh,
    };
  }

  _hitPin(x, y, tol = 14) {
    for (const c of this.components) {
      for (const pin of DEVICE_PINS[c.type] || []) {
        const lp = pinLocal(pin, c.rot);
        const px = c.x + lp.x;
        const py = c.y + lp.y;
        if ((px - x) ** 2 + (py - y) ** 2 <= tol * tol) {
          return { cid: c.id, pinId: pin.id, x: px, y: py };
        }
      }
    }
    return null;
  }

  _hitComp(x, y) {
    for (let i = this.components.length - 1; i >= 0; i--) {
      const c = this.components[i];
      const pins = DEVICE_PINS[c.type] || [];
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity;
      if (!pins.length) {
        minX = -24;
        maxX = 24;
        minY = -16;
        maxY = 16;
      } else {
        for (const p of pins) {
          const lp = pinLocal(p, c.rot);
          minX = Math.min(minX, lp.x);
          maxX = Math.max(maxX, lp.x);
          minY = Math.min(minY, lp.y);
          maxY = Math.max(maxY, lp.y);
        }
      }
      const pad = 14;
      if (
        x >= c.x + minX - pad &&
        x <= c.x + maxX + pad &&
        y >= c.y + minY - pad &&
        y <= c.y + maxY + pad
      ) {
        return c;
      }
    }
    return null;
  }

  _hitWire(x, y, tol = 10) {
    const hit = this._hitWireSeg(x, y, tol);
    return hit ? hit.wire : null;
  }

  /** @returns {{ wire, segIndex, pts } | null} */
  _hitWireSeg(x, y, tol = 10) {
    for (const w of this.wires) {
      const pts = this._wirePoints(w);
      for (let i = 0; i < pts.length - 1; i++) {
        if (distToSeg(x, y, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= tol) {
          return { wire: w, segIndex: i, pts };
        }
      }
    }
    return null;
  }

  _wirePoints(w) {
    const a = this._pinAbs(w.a.cid, w.a.pinId);
    const b = this._pinAbs(w.b.cid, w.b.pinId);
    if (!a || !b) return [];
    if (w.route?.length) {
      return ensureOrtho([
        { x: a.x, y: a.y },
        ...w.route.map((p) => ({ x: snap(p.x), y: snap(p.y) })),
        { x: b.x, y: b.y },
      ]);
    }
    return manhattan(a.x, a.y, b.x, b.y);
  }

  _setWireRoute(w, pts) {
    const route = routeFromPoints(pts);
    if (!route.length) delete w.route;
    else w.route = route;
  }

  _resetWireRoute(w) {
    if (!w) return;
    this._pushHistory();
    delete w.route;
    this.render();
    this.syncToNetlist();
  }

  /** Drop custom routes that touch any of the given component ids. */
  _clearRoutesTouching(cids) {
    const set = cids instanceof Set ? cids : new Set(cids);
    for (const w of this.wires) {
      if (!w.route?.length) continue;
      if (set.has(w.a.cid) || set.has(w.b.cid)) delete w.route;
    }
  }

  /** @returns {{ wire, vertIndex, pts } | null} */
  _hitWireVertex(x, y, tol = 8) {
    for (const w of this.wires) {
      if (!this.selWires.has(w.id) && !w.route?.length) continue;
      const pts = this._wirePoints(w);
      for (let i = 1; i < pts.length - 1; i++) {
        const dx = x - pts[i].x;
        const dy = y - pts[i].y;
        if (dx * dx + dy * dy <= tol * tol) {
          return { wire: w, vertIndex: i, pts };
        }
      }
    }
    return null;
  }

  _pinAbs(cid, pinId) {
    const c = this.components.find((x) => x.id === cid);
    if (!c) return null;
    const pin = (DEVICE_PINS[c.type] || []).find((p) => p.id === pinId);
    if (!pin) return null;
    const lp = pinLocal(pin, c.rot);
    return { x: c.x + lp.x, y: c.y + lp.y };
  }

  _clearSelection() {
    this.selComps.clear();
    this.selWires.clear();
  }

  _hasSelection() {
    return this.selComps.size > 0 || this.selWires.size > 0;
  }

  _compBounds(c) {
    const pins = DEVICE_PINS[c.type] || [];
    let minX = Infinity,
      maxX = -Infinity,
      minY = Infinity,
      maxY = -Infinity;
    for (const p of pins) {
      const lp = pinLocal(p, c.rot);
      minX = Math.min(minX, lp.x);
      maxX = Math.max(maxX, lp.x);
      minY = Math.min(minY, lp.y);
      maxY = Math.max(maxY, lp.y);
    }
    const pad = 14;
    return {
      x0: c.x + minX - pad,
      y0: c.y + minY - pad,
      x1: c.x + maxX + pad,
      y1: c.y + maxY + pad,
    };
  }

  _rectsOverlap(a, b) {
    return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
  }

  _normBox(box) {
    return {
      x0: Math.min(box.x0, box.x1),
      y0: Math.min(box.y0, box.y1),
      x1: Math.max(box.x0, box.x1),
      y1: Math.max(box.y0, box.y1),
    };
  }

  rotateSelected() {
    const ids = [...this.selComps];
    if (!ids.length) return;
    this._pushHistory();
    for (const id of ids) {
      const c = this.components.find((x) => x.id === id);
      if (!c || c.type === "GND") continue;
      c.rot = ((c.rot || 0) + 90) % 360;
    }
    // Absolute waypoints no longer match rotated pins
    this._clearRoutesTouching(ids);
    this.render();
    this.syncToNetlist();
  }

  copySelected() {
    const comps = this.components.filter((c) => this.selComps.has(c.id));
    if (!comps.length) return;
    this._clipboard = {
      comps: JSON.parse(JSON.stringify(comps)),
      // wires fully inside selection
      wires: this.wires
        .filter((w) => this.selComps.has(w.a.cid) && this.selComps.has(w.b.cid))
        .map((w) => JSON.parse(JSON.stringify(w))),
    };
    this.onLog(`Copied ${comps.length} part(s)`);
  }

  pasteClipboard() {
    if (!this._clipboard?.comps?.length) return;
    this._pushHistory();
    const idMap = new Map();
    const offset = GRID * 2;
    this._clearSelection();
    for (const src of this._clipboard.comps) {
      const c = JSON.parse(JSON.stringify(src));
      const nid = uid("c");
      idMap.set(src.id, nid);
      c.id = nid;
      c.name = this._nextName(c.type);
      c.x = snap((c.x || 0) + offset);
      c.y = snap((c.y || 0) + offset);
      this.components.push(c);
      this.selComps.add(nid);
    }
    for (const src of this._clipboard.wires || []) {
      const w = JSON.parse(JSON.stringify(src));
      w.id = uid("w");
      w.a.cid = idMap.get(w.a.cid);
      w.b.cid = idMap.get(w.b.cid);
      if (!w.a.cid || !w.b.cid) continue;
      if (w.route?.length) {
        w.route = w.route.map((p) => ({
          x: snap((p.x || 0) + offset),
          y: snap((p.y || 0) + offset),
        }));
      }
      this.wires.push(w);
    }
    // refresh clipboard offsets for repeated paste
    this._clipboard = {
      comps: this.components
        .filter((c) => this.selComps.has(c.id))
        .map((c) => JSON.parse(JSON.stringify(c))),
      wires: this.wires
        .filter((w) => this.selComps.has(w.a.cid) && this.selComps.has(w.b.cid))
        .map((w) => JSON.parse(JSON.stringify(w))),
    };
    this.render();
    this.syncToNetlist();
    this.onLog(`Pasted ${this.selComps.size} part(s)`);
  }

  duplicateSelected() {
    this.copySelected();
    this.pasteClipboard();
  }

  /** Dots where ≥3 wire path points coincide (T-junctions / stars). */
  _junctionPoints() {
    const counts = new Map();
    const add = (x, y) => {
      const k = `${snap(x)},${snap(y)}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    };
    for (const w of this.wires) {
      for (const p of this._wirePoints(w)) add(p.x, p.y);
    }
    const dots = [];
    for (const [k, n] of counts) {
      if (n < 3) continue;
      const [x, y] = k.split(",").map(Number);
      dots.push({ x, y });
    }
    return dots;
  }

  _nextName(type) {
    const letter = spiceLetter(type);
    this.counters[letter] = (this.counters[letter] || 0) + 1;
    const n = this.counters[letter];
    if (type === "GND") return `GND${n}`;
    if (type === "NMOS") return `Mn${n}`;
    if (type === "PMOS") return `Mp${n}`;
    if (type === "NPN") return `Qn${n}`;
    if (type === "PNP") return `Qp${n}`;
    if (type === "OPAMP") return `Xoa${n}`;
    if (type === "SW") return `S${n}`;
    if (type === "CSW") return `W${n}`;
    if (type === "K") return `K${n}`;
    if (type === "NET") return `N${n}`;
    return `${letter}${n}`;
  }

  _onDown(e) {
    // Only primary button for place/select/drag (keep middle for pan)
    if (e.button !== 0 && e.button !== 1) return;

    if (this._suppressClick) {
      this._suppressClick = false;
      return;
    }

    this.svg.setPointerCapture?.(e.pointerId);
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._pointers.size >= 2) {
      this._beginPinch();
      return;
    }

    this._startLongPress(e);

    const { x, y } = this._svgPoint(e);
    const sx = snap(x);
    const sy = snap(y);

    // Middle-click, Alt, Space, or Pan tool → pan
    if (
      e.button === 1 ||
      (e.button === 0 && (e.altKey || this._spaceDown || this.mode === "pan"))
    ) {
      this.pan = { mx: e.clientX, my: e.clientY, vx: this.view.x, vy: this.view.y };
      this.svg.style.cursor = "grabbing";
      return;
    }

    // In place / wire mode, still allow selecting & dragging existing parts
    const hitExisting = this._hitComp(x, y);

    if (this.mode === "place" && this.placeType && !hitExisting) {
      this._cancelLongPress();
      const type = this.placeType;
      this._pushHistory();
      const comp = {
        id: uid("c"),
        type,
        name: this._nextName(type),
        x: sx,
        y: sy,
        rot: 0,
        value: DEFAULTS[type] || "",
      };
      this.components.push(comp);
      this._clearSelection();
      this.selComps.add(comp.id);
      // Stay in place mode for rapid entry; Escape / Select to move
      this.render();
      this.syncToNetlist();
      this._updateTips();
      return;
    }

    // Probe pin (Ctrl/Cmd+click)
    {
      const pin = this._hitPin(x, y);
      if (pin && (e.ctrlKey || e.metaKey)) {
        this._cancelLongPress();
        const node = this.nodeOfPin(pin.cid, pin.pinId);
        this.onPinProbe?.({ cid: pin.cid, pinId: pin.pinId, node });
        return;
      }
      // Shift+click pin → start wire (click-click)
      if (pin && e.shiftKey) {
        this._cancelLongPress();
        this.mode = "wire";
        this.wireStart = { cid: pin.cid, pinId: pin.pinId };
        this.wireDrag = null;
        this._updateToolUi();
        this.render();
        return;
      }
      // Pin hit: drag-to-wire, or complete click-click wire
      if (pin && e.button === 0) {
        this._cancelLongPress();
        if (
          this.wireStart &&
          (this.wireStart.cid !== pin.cid || this.wireStart.pinId !== pin.pinId)
        ) {
          this._pushHistory();
          this.wires.push({
            id: uid("w"),
            a: { ...this.wireStart },
            b: { cid: pin.cid, pinId: pin.pinId },
          });
          this.wireStart = null;
          this.wireDrag = null;
          this._clearSelection();
          this.render();
          this.syncToNetlist();
          this._updateTips();
          return;
        }
        if (
          this.wireStart &&
          this.wireStart.cid === pin.cid &&
          this.wireStart.pinId === pin.pinId
        ) {
          this.wireStart = null;
          this.wireDrag = null;
          this.render();
          return;
        }
        // Start wire from this pin (drag to another pin, or click second pin)
        this.wireStart = { cid: pin.cid, pinId: pin.pinId };
        this.wireDrag = {
          a: { cid: pin.cid, pinId: pin.pinId },
          cx: e.clientX,
          cy: e.clientY,
          moved: false,
        };
        this.render(e);
        this._updateTips();
        return;
      }
    }

    // Drag wire corner handle → move vertex
    const wireVert = this._hitWireVertex(x, y);
    if (wireVert && e.button === 0) {
      this._cancelLongPress();
      const { wire: wireHit, vertIndex, pts } = wireVert;
      if (!this.selWires.has(wireHit.id)) {
        this._clearSelection();
        this.selWires.add(wireHit.id);
      }
      this._pushHistory();
      this._dragMoved = false;
      this.vertDrag = {
        wireId: wireHit.id,
        vertIndex,
        basePts: pts.map((p) => ({ x: p.x, y: p.y })),
      };
      this.svg.style.cursor = "grabbing";
      this.render();
      this._updateTips();
      return;
    }

    // Drag wire segment → reshape Manhattan route (jog)
    const wireSeg = this._hitWireSeg(x, y);
    if (wireSeg && e.button === 0) {
      this._cancelLongPress();
      const { wire: wireHit, segIndex, pts } = wireSeg;
      if (e.shiftKey) {
        if (this.selWires.has(wireHit.id)) this.selWires.delete(wireHit.id);
        else this.selWires.add(wireHit.id);
        this.selComps.clear();
        this.render();
        this._updateTips();
        return;
      }
      if (!this.selWires.has(wireHit.id)) {
        this._clearSelection();
        this.selWires.add(wireHit.id);
      }
      this._pushHistory();
      this._dragMoved = false;
      this.segDrag = {
        wireId: wireHit.id,
        segIndex,
        basePts: pts.map((p) => ({ x: p.x, y: p.y })),
      };
      this.svg.style.cursor = "grabbing";
      this.render();
      this._updateTips();
      return;
    }

    // select / drag components
    const comp = hitExisting || this._hitComp(x, y);
    if (comp) {
      // Clicking an existing part exits place mode so drag works
      if (this.mode === "place") {
        this.mode = "select";
        this.placeType = null;
        this._updateToolUi();
      }
      if (e.shiftKey) {
        if (this.selComps.has(comp.id)) this.selComps.delete(comp.id);
        else this.selComps.add(comp.id);
        this.selWires.clear();
      } else if (!this.selComps.has(comp.id)) {
        this._clearSelection();
        this.selComps.add(comp.id);
      }
      this._pushHistory();
      this._dragMoved = false;
      const origins = new Map();
      for (const id of this.selComps) {
        const c = this.components.find((z) => z.id === id);
        if (c) origins.set(id, { x: c.x, y: c.y });
      }
      // Snapshot routes that will translate with a rigid selection move
      const wireRoutes = new Map();
      for (const w of this.wires) {
        if (!w.route?.length) continue;
        if (origins.has(w.a.cid) && origins.has(w.b.cid)) {
          wireRoutes.set(
            w.id,
            w.route.map((p) => ({ x: p.x, y: p.y }))
          );
        }
      }
      this.drag = {
        ox: sx,
        oy: sy,
        origins,
        wireRoutes,
        pointerId: e.pointerId,
      };
      this.svg.style.cursor = "grabbing";
      this.render();
      this._updateTips();
      return;
    }

    // empty space + left drag → rubber-band (Alt/mid already handled as pan)
    if (e.button === 0) {
      this.wireStart = null;
      this.wireDrag = null;
      this.box = { x0: sx, y0: sy, x1: sx, y1: sy, additive: e.shiftKey };
      if (!e.shiftKey) this._clearSelection();
      this.svg.style.cursor = "crosshair";
    }
    this.render();
    this._updateTips();
  }

  _onMove(e) {
    if (this._pointers.has(e.pointerId)) {
      this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    }

    if (this._longPress) {
      const dx = e.clientX - this._longPress.x;
      const dy = e.clientY - this._longPress.y;
      if (dx * dx + dy * dy > 64) this._cancelLongPress();
    }

    if (this._pinch || this._pointers.size >= 2) {
      if (!this._pinch && this._pointers.size >= 2) this._beginPinch();
      this._updatePinch();
      return;
    }

    if (this.pan) {
      const rect = this.svg.getBoundingClientRect();
      const { vw, vh } = this._viewSize();
      const dx = ((e.clientX - this.pan.mx) * vw) / (rect.width || 1);
      const dy = ((e.clientY - this.pan.my) * vh) / (rect.height || 1);
      this.view.x = this.pan.vx - dx;
      this.view.y = this.pan.vy - dy;
      this.render();
      return;
    }

    if (this.wireDrag) {
      const dx = e.clientX - this.wireDrag.cx;
      const dy = e.clientY - this.wireDrag.cy;
      if (dx * dx + dy * dy > 36) this.wireDrag.moved = true;
      this.render(e);
      return;
    }

    if (this.vertDrag) {
      const { x, y } = this._svgPoint(e);
      const w = this.wires.find((z) => z.id === this.vertDrag.wireId);
      if (w) {
        const pts = this.vertDrag.basePts.map((p) => ({ x: p.x, y: p.y }));
        const i = this.vertDrag.vertIndex;
        if (i > 0 && i < pts.length - 1) {
          pts[i] = { x: snap(x), y: snap(y) };
          this._setWireRoute(w, ensureOrtho(pts));
          this._dragMoved = true;
          this._cancelLongPress();
        }
      }
      this.render();
      return;
    }

    if (this.segDrag) {
      const { x, y } = this._svgPoint(e);
      const w = this.wires.find((z) => z.id === this.segDrag.wireId);
      if (w) {
        const pts = dragOrthoSegment(
          this.segDrag.basePts,
          this.segDrag.segIndex,
          x,
          y
        );
        this._setWireRoute(w, pts);
        this._dragMoved = true;
        this._cancelLongPress();
      }
      this.render();
      return;
    }

    if (this.box) {
      const { x, y } = this._svgPoint(e);
      this.box.x1 = snap(x);
      this.box.y1 = snap(y);
      this.render();
      return;
    }
    if (this.drag) {
      const { x, y } = this._svgPoint(e);
      const dx = snap(x) - this.drag.ox;
      const dy = snap(y) - this.drag.oy;
      if (dx || dy) {
        this._dragMoved = true;
        this._cancelLongPress();
      }
      for (const [id, o] of this.drag.origins) {
        const c = this.components.find((z) => z.id === id);
        if (!c) continue;
        c.x = snap(o.x + dx);
        c.y = snap(o.y + dy);
      }
      // Keep custom jogs with a rigid multi-part move
      if (this.drag.wireRoutes) {
        for (const [wid, base] of this.drag.wireRoutes) {
          const w = this.wires.find((z) => z.id === wid);
          if (!w) continue;
          w.route = base.map((p) => ({ x: snap(p.x + dx), y: snap(p.y + dy) }));
        }
      }
      this.render();
      return;
    }

    // Hover net highlight (pin or wire)
    const { x, y } = this._svgPoint(e);
    let net = null;
    const pin = this._hitPin(x, y);
    if (pin) net = this.nodeOfPin(pin.cid, pin.pinId) ?? null;
    else {
      const wire = this._hitWire(x, y);
      if (wire) net = this.nodeOfPin(wire.a.cid, wire.a.pinId) ?? null;
    }
    const netChanged = net !== this.hoverNet;
    this.hoverNet = net;
    if (this.wireStart) this.render(e);
    else if (netChanged) this.render();
  }

  _onUp(e) {
    if (e?.pointerId != null) this._pointers.delete(e.pointerId);
    this._cancelLongPress();

    if (this._pointers.size < 2) this._pinch = null;
    else this._beginPinch();

    if (this.pan) {
      this.pan = null;
      this._updateToolUi();
      return;
    }

    if (this.segDrag || this.vertDrag) {
      if (!this._dragMoved && this._undo.length) this._undo.pop();
      this.segDrag = null;
      this.vertDrag = null;
      this._dragMoved = false;
      this._updateToolUi();
      this.syncToNetlist();
      this.render();
      return;
    }

    if (this.wireDrag) {
      const { x, y } = this._svgPoint(e);
      const end = this._hitPin(x, y, 16);
      const a = this.wireDrag.a;
      const moved = this.wireDrag.moved;
      this.wireDrag = null;
      if (
        moved &&
        end &&
        (end.cid !== a.cid || end.pinId !== a.pinId)
      ) {
        this._pushHistory();
        this.wires.push({
          id: uid("w"),
          a: { ...a },
          b: { cid: end.cid, pinId: end.pinId },
        });
        this.wireStart = null;
        this._clearSelection();
        this.render();
        this.syncToNetlist();
        this._updateTips();
        return;
      }
      if (moved) {
        // Dragged to empty space — cancel rubber-band
        this.wireStart = null;
      }
      // Unmoved click: keep wireStart for click→click second pin
      this.render();
      this._updateTips();
      return;
    }

    if (this.box) {
      const nb = this._normBox(this.box);
      const additive = this.box.additive;
      const tiny = Math.abs(this.box.x1 - this.box.x0) < 4 && Math.abs(this.box.y1 - this.box.y0) < 4;
      this.box = null;
      if (!tiny) {
        if (!additive) this._clearSelection();
        for (const c of this.components) {
          if (this._rectsOverlap(nb, this._compBounds(c))) this.selComps.add(c.id);
        }
        for (const w of this.wires) {
          const pts = this._wirePoints(w);
          for (const p of pts) {
            if (p.x >= nb.x0 && p.x <= nb.x1 && p.y >= nb.y0 && p.y <= nb.y1) {
              this.selWires.add(w.id);
              break;
            }
          }
        }
      }
      this._updateToolUi();
      this.render();
      return;
    }
    if (this.drag) {
      // If never moved, drop the redundant history entry
      if (!this._dragMoved && this._undo.length) this._undo.pop();
      this.drag = null;
      this._dragMoved = false;
      this._updateToolUi();
      this.syncToNetlist();
    }
  }

  _onDblClick(e) {
    const { x, y } = this._svgPoint(e);
    const wire = this._hitWire(x, y);
    if (wire?.route?.length) {
      this._resetWireRoute(wire);
      return;
    }
    const comp = this._hitComp(x, y);
    if (!comp || comp.type === "GND") return;
    this.editComponent(comp);
  }

  editComponent(comp) {
    if (!comp || comp.type === "GND") return;
    const promptLabel = isNet(comp.type)
      ? `Net name for label`
      : `Value / params for ${comp.name}`;
    const next = window.prompt(promptLabel, comp.value || "");
    if (next == null) return;
    this._pushHistory();
    comp.value = isNet(comp.type) ? sanitizeNetName(next) || comp.value : next.trim();
    this.render();
    this.syncToNetlist();
  }

  _onContextMenu(e) {
    e.preventDefault();
    if (!this.isVisible()) return;
    const { x, y } = this._svgPoint(e);
    const pin = this._hitPin(x, y);
    const comp = this._hitComp(x, y);
    const wire = !comp ? this._hitWire(x, y) : null;

    if (comp) {
      if (!this.selComps.has(comp.id)) {
        this._clearSelection();
        this.selComps.add(comp.id);
        this.render();
      }
    } else if (wire) {
      if (!this.selWires.has(wire.id)) {
        this._clearSelection();
        this.selWires.add(wire.id);
        this.render();
      }
    }

    const items = [];
    if (wire) {
      items.push({
        label: "Reset wire route",
        disabled: !wire.route?.length,
        action: () => this._resetWireRoute(wire),
      });
    }
    if (comp && comp.type !== "GND") {
      items.push({
        label: isNet(comp.type) ? "Rename net…" : `Edit ${comp.name}…`,
        action: () => this.editComponent(comp),
      });
      items.push({
        label: "Rotate 90° (R)",
        action: () => {
          if (!this.selComps.has(comp.id)) {
            this._clearSelection();
            this.selComps.add(comp.id);
          }
          this.rotateSelected();
        },
      });
      items.push({
        label: "Duplicate (Ctrl+D)",
        action: () => {
          if (!this.selComps.has(comp.id)) {
            this._clearSelection();
            this.selComps.add(comp.id);
          }
          this.duplicateSelected();
        },
      });
    }
    if (pin) {
      const node = this.nodeOfPin(pin.cid, pin.pinId);
      items.push({
        label: node ? `Plot node ${node}` : "Plot node",
        disabled: !node || node === "0",
        action: () =>
          this.onPinProbe?.({ cid: pin.cid, pinId: pin.pinId, node }),
      });
    }
    if (items.length) items.push({ sep: true });
    items.push({
      label: "Delete (Del)",
      danger: true,
      disabled: !this._hasSelection(),
      action: () => this.deleteSelected(),
    });
    items.push({
      label: "Fit view",
      action: () => this.fitView(),
    });
    items.push({
      label: "Zoom in",
      action: () => this._zoomCenter(1.111),
    });
    items.push({
      label: "Zoom out",
      action: () => this._zoomCenter(0.9),
    });

    showContextMenu(e.clientX, e.clientY, items);
  }

  deleteSelected() {
    if (!this._hasSelection()) return;
    this._pushHistory();
    const killComps = new Set(this.selComps);
    const killWires = new Set(this.selWires);
    this.components = this.components.filter((c) => !killComps.has(c.id));
    this.wires = this.wires.filter(
      (w) =>
        !killWires.has(w.id) && !killComps.has(w.a.cid) && !killComps.has(w.b.cid)
    );
    this._clearSelection();
    this.render();
    this.syncToNetlist();
    this._updateTips();
  }

  /** Map each pin to netlist node name (same connectivity as generateNetlist). */
  _pinNodeMap() {
    const uf = new UF();
    for (const c of this.components) {
      for (const pin of DEVICE_PINS[c.type] || []) {
        uf.add(pinKey(c.id, pin.id));
      }
    }
    for (const w of this.wires) {
      uf.union(pinKey(w.a.cid, w.a.pinId), pinKey(w.b.cid, w.b.pinId));
    }
    const groundRoots = new Set();
    for (const c of this.components) {
      if (c.type !== "GND") continue;
      for (const pin of DEVICE_PINS.GND) {
        groundRoots.add(uf.find(pinKey(c.id, pin.id)));
      }
    }
    const rootToNode = new Map();
    let next = 1;
    const roots = new Set();
    for (const c of this.components) {
      for (const pin of DEVICE_PINS[c.type] || []) {
        roots.add(uf.find(pinKey(c.id, pin.id)));
      }
    }
    for (const r of roots) {
      if (groundRoots.has(r)) rootToNode.set(r, "0");
    }
    // Net labels force node names
    for (const c of this.components) {
      if (!isNet(c.type)) continue;
      const label = sanitizeNetName(c.value || "net");
      if (!label || label === "0") continue;
      const pins = DEVICE_PINS.NET;
      if (!pins.length) continue;
      const r = uf.find(pinKey(c.id, pins[0].id));
      if (groundRoots.has(r)) continue;
      rootToNode.set(r, label);
    }
    for (const r of roots) {
      if (!rootToNode.has(r)) rootToNode.set(r, String(next++));
    }
    const map = new Map();
    for (const c of this.components) {
      for (const pin of DEVICE_PINS[c.type] || []) {
        const k = pinKey(c.id, pin.id);
        map.set(k, rootToNode.get(uf.find(k)));
      }
    }
    return map;
  }

  nodeOfPin(cid, pinId) {
    const c = this.components.find((x) => x.id === cid);
    if (c?.nodes?.[pinId] != null) return String(c.nodes[pinId]);
    return this._pinNodeMap().get(pinKey(cid, pinId));
  }

  generateNetlist() {
    const pinNodes = this._pinNodeMap();
    const nodeOf = (cid, pinId) => pinNodes.get(pinKey(cid, pinId));

    const lines = ["* Generated from schematic"];
    for (const c of this.components) {
      if (c.type === "GND" || isNet(c.type)) continue;
      const pins = DEVICE_PINS[c.type];
      const val = c.value || DEFAULTS[c.type] || "1";
      if (isFet(c.type)) {
        const nd = nodeOf(c.id, "d");
        const ng = nodeOf(c.id, "g");
        const ns = nodeOf(c.id, "s");
        lines.push(`${c.name} ${nd} ${ng} ${ns} ${ns} ${val}`);
      } else if (isBjt(c.type)) {
        const nc = nodeOf(c.id, "c");
        const nb = nodeOf(c.id, "b");
        const ne = nodeOf(c.id, "e");
        lines.push(`${c.name} ${nc} ${nb} ${ne} ${val}`);
      } else if (isOpamp(c.type)) {
        const np = nodeOf(c.id, "plus");
        const nm = nodeOf(c.id, "minus");
        const no = nodeOf(c.id, "out");
        const sub = firstToken(val) || "OPAMP";
        lines.push(`${c.name} ${np} ${nm} ${no} ${sub}`);
      } else if (isSw(c.type)) {
        const na = nodeOf(c.id, "a");
        const nb = nodeOf(c.id, "b");
        const nc1 = nodeOf(c.id, "c1");
        const nc2 = nodeOf(c.id, "c2");
        const model = firstToken(val) || "SW";
        lines.push(`${c.name} ${na} ${nb} ${nc1} ${nc2} ${model}`);
      } else if (isEg(c.type)) {
        const na = nodeOf(c.id, "a");
        const nb = nodeOf(c.id, "b");
        const nc1 = nodeOf(c.id, "c1");
        const nc2 = nodeOf(c.id, "c2");
        lines.push(`${c.name} ${na} ${nb} ${nc1} ${nc2} ${val}`);
      } else if (isCsw(c.type)) {
        const na = nodeOf(c.id, "a");
        const nb = nodeOf(c.id, "b");
        const toks = String(val).trim().split(/\s+/);
        const vname = toks[0] || "Vsense";
        const model = toks[1] || "CSW";
        lines.push(`${c.name} ${na} ${nb} ${vname} ${model}`);
      } else if (isFh(c.type)) {
        const na = nodeOf(c.id, "a");
        const nb = nodeOf(c.id, "b");
        const toks = String(val).trim().split(/\s+/);
        const vname = toks[0] || "Vsense";
        const gain = toks[1] || "1";
        lines.push(`${c.name} ${na} ${nb} ${vname} ${gain}`);
      } else if (isBsrc(c.type)) {
        const na = nodeOf(c.id, "a");
        const nb = nodeOf(c.id, "b");
        lines.push(`${c.name} ${na} ${nb} ${val}`);
      } else if (isK(c.type)) {
        lines.push(`${c.name} ${val}`);
      } else if (pins && pins.length >= 2) {
        const n1 = nodeOf(c.id, pins[0].id);
        const n2 = nodeOf(c.id, pins[1].id);
        lines.push(`${c.name} ${n1} ${n2} ${val}`);
      }
    }

    const dirs = extractDirectives(this.netlistEl?.value || "");
    const models = missingModelLines(this.components, dirs);
    const endIdx = dirs.findIndex((l) => l.toLowerCase().startsWith(".end"));
    if (models.length) {
      if (endIdx >= 0) dirs.splice(endIdx, 0, ...models);
      else dirs.push(...models);
    }
    for (const d of dirs) lines.push(d);
    const body = lines.join("\n") + "\n";
    return embedSchLayout(body, this.exportLayout());
  }

  /** Serializable placement + wire routes (stable refs by device name / net). */
  exportLayout() {
    const byId = new Map(this.components.map((c) => [c.id, c]));
    const pinRef = (cid, pinId) => {
      const c = byId.get(cid);
      if (!c) return null;
      if (c.type === "GND") return `GND:${pinId}`;
      if (c.type === "NET") return `NET@${c.value || ""}:${pinId}`;
      return `${c.name}:${pinId}`;
    };
    return {
      v: 1,
      comps: this.components.map((c) => {
        const o = { n: c.name, t: c.type, x: c.x, y: c.y, r: c.rot || 0 };
        if (c.type === "NET") o.val = c.value || "";
        return o;
      }),
      wires: this.wires
        .map((w) => {
          const a = pinRef(w.a.cid, w.a.pinId);
          const b = pinRef(w.b.cid, w.b.pinId);
          if (!a || !b) return null;
          const o = { a, b };
          if (w.route?.length) {
            o.route = w.route.map((p) => ({ x: p.x, y: p.y }));
          }
          return o;
        })
        .filter(Boolean),
      view: { x: this.view.x, y: this.view.y, scale: this.view.scale },
    };
  }

  /**
   * Overlay saved positions / routes onto the current schematic.
   * @returns {boolean} true if any layout was applied
   */
  applyLayout(layout) {
    if (!layout || layout.v !== 1) return false;
    const byName = new Map();
    const gnds = [];
    const netsByVal = new Map();
    for (const c of this.components) {
      if (c.type === "GND") gnds.push(c);
      else if (c.type === "NET") netsByVal.set(String(c.value || ""), c);
      else byName.set(c.name, c);
    }

    let applied = false;
    for (const lc of layout.comps || []) {
      let c = null;
      if (lc.t === "GND") c = gnds.length ? gnds.shift() : null;
      else if (lc.t === "NET") c = netsByVal.get(String(lc.val ?? lc.v ?? ""));
      else c = byName.get(lc.n);
      if (!c) continue;
      if (typeof lc.x === "number") c.x = snap(lc.x);
      if (typeof lc.y === "number") c.y = snap(lc.y);
      if (typeof lc.r === "number") c.rot = ((lc.r % 360) + 360) % 360;
      applied = true;
    }

    const resolve = (ref) => {
      if (!ref || typeof ref !== "string") return null;
      const i = ref.lastIndexOf(":");
      if (i <= 0) return null;
      const head = ref.slice(0, i);
      const pinId = ref.slice(i + 1);
      if (head === "GND") {
        const g = this.components.find((c) => c.type === "GND");
        return g ? { cid: g.id, pinId } : null;
      }
      if (head.startsWith("NET@")) {
        const val = head.slice(4);
        const n = netsByVal.get(val) || this.components.find((c) => c.type === "NET" && c.value === val);
        return n ? { cid: n.id, pinId } : null;
      }
      const c = byName.get(head);
      return c ? { cid: c.id, pinId } : null;
    };

    const rebuilt = [];
    for (const lw of layout.wires || []) {
      const a = resolve(lw.a);
      const b = resolve(lw.b);
      if (!a || !b) continue;
      if (a.cid === b.cid && a.pinId === b.pinId) continue;
      const w = { id: uid("w"), a, b };
      if (lw.route?.length) {
        w.route = lw.route.map((p) => ({ x: snap(p.x), y: snap(p.y) }));
      }
      rebuilt.push(w);
    }
    if (rebuilt.length) {
      this.wires = rebuilt;
      applied = true;
    }

    if (layout.view && typeof layout.view.scale === "number") {
      this.view = {
        x: layout.view.x || 0,
        y: layout.view.y || 0,
        scale: Math.min(4, Math.max(0.25, layout.view.scale)),
      };
      applied = true;
    }
    return applied;
  }

  syncToNetlist() {
    if (this._syncing || !this.netlistEl) return;
    this._syncing = true;
    try {
      this.netlistEl.value = this.generateNetlist();
      this.netlistEl.dispatchEvent(new Event("input", { bubbles: true }));
    } finally {
      this._syncing = false;
    }
  }

  /**
   * Netlist → schematic with layered layout (sources left, ground bottom).
   * Stores node names on components for probe labels.
   */
  fromNetlist(text) {
    this._pushHistory();
    const savedLayout = extractSchLayout(text);
    const devices = [];
    for (const raw of text.split(/\r?\n/)) {
      let line = raw.trim();
      if (!line || line.startsWith("*") || line.startsWith(";") || line.startsWith(".")) continue;
      const semi = line.indexOf(";");
      if (semi >= 0) line = line.slice(0, semi).trim();
      const parts = tokenizeLine(line);
      if (!parts[0]) continue;
      const kind = parts[0][0].toUpperCase();
      if (!"RCLVIDMQXSWKEGHFB".includes(kind)) continue;
      if (kind === "K") {
        if (parts.length < 4) continue;
      devices.push({ name: parts[0], kind, parts, raw: line });
      continue;
      }
      if (parts.length < 3) continue;
      if (kind === "S" && parts.length < 5) continue;
      if ((kind === "E" || kind === "G") && parts.length < 6) continue;
      if ((kind === "W" || kind === "F" || kind === "H") && parts.length < 5) continue;
      if (kind === "B" && parts.length < 4) continue;
      if (kind === "X") {
        const sub = String(parts[parts.length - 1] || "").toUpperCase();
        if (sub !== "OPAMP") continue;
      }
      devices.push({ name: parts[0], kind, parts, raw: line });
    }

    this.components = [];
    this.wires = [];
    this.counters = {
      R: 0,
      C: 0,
      L: 0,
      V: 0,
      I: 0,
      D: 0,
      M: 0,
      Q: 0,
      X: 0,
      S: 0,
      W: 0,
      K: 0,
      E: 0,
      G: 0,
      F: 0,
      H: 0,
      B: 0,
      NET: 0,
      GND: 0,
    };
    this._clearSelection();
    this.probes = {};

    const nodePins = new Map();
    const addNodePin = (node, cid, pinId) => {
      const n = normNode(node);
      if (!nodePins.has(n)) nodePins.set(n, []);
      nodePins.get(n).push({ cid, pinId });
    };

    // Classify for layout columns
    const sources = devices.filter((d) => d.kind === "V" || d.kind === "I");
    const rest = devices.filter((d) => d.kind !== "V" && d.kind !== "I");

    // Build adjacency for layering: node -> set of neighboring nodes via devices
    const adj = new Map();
    const touch = (a, b) => {
      const na = normNode(a);
      const nb = normNode(b);
      if (!adj.has(na)) adj.set(na, new Set());
      if (!adj.has(nb)) adj.set(nb, new Set());
      if (na !== nb) {
        adj.get(na).add(nb);
        adj.get(nb).add(na);
      }
    };
    for (const d of devices) {
      if (d.kind === "M") {
        touch(d.parts[1], d.parts[3]);
        touch(d.parts[2], d.parts[3]);
      } else if (d.kind === "Q") {
        touch(d.parts[1], d.parts[2]);
        touch(d.parts[2], d.parts[3]);
      } else if (d.kind === "X" && schematicTypeFromDevice(d) === "OPAMP") {
        touch(d.parts[1], d.parts[2]);
        touch(d.parts[2], d.parts[3]);
      } else if (d.kind === "S" || d.kind === "E" || d.kind === "G") {
        touch(d.parts[1], d.parts[2]);
        touch(d.parts[3], d.parts[4]);
      } else if (d.kind === "W" || d.kind === "F" || d.kind === "H" || d.kind === "B") {
        touch(d.parts[1], d.parts[2]);
      } else if (d.kind !== "X" && d.kind !== "K") {
        touch(d.parts[1], d.parts[2]);
      }
    }

    // BFS layers from ground (0) and source positive nodes
    const layerOf = new Map();
    layerOf.set("0", 0);
    const q = ["0"];
    for (const s of sources) {
      const n = normNode(s.parts[1]);
      if (!layerOf.has(n)) {
        layerOf.set(n, 1);
        q.push(n);
      }
    }
    while (q.length) {
      const n = q.shift();
      const L = layerOf.get(n) ?? 0;
      for (const m of adj.get(n) || []) {
        if (!layerOf.has(m)) {
          layerOf.set(m, L + 1);
          q.push(m);
        }
      }
    }
    let maxLayer = 1;
    for (const [, L] of layerOf) maxLayer = Math.max(maxLayer, L);
    for (const n of adj.keys()) {
      if (!layerOf.has(n)) layerOf.set(n, maxLayer + 1);
    }

    // Place devices at midpoint layer of their terminals
    const placeDevice = (d, forcedX, forcedY) => {
      const type = schematicTypeFromDevice(d);
      if (DEVICE_PINS[type] === undefined) return null;
      const letter = spiceLetter(type);
      this.counters[letter] = Math.max(
        this.counters[letter] || 0,
        parseInt(d.name.replace(/^[A-Za-z]+/, ""), 10) || 0
      );
      let value = "";
      if (isFet(type)) value = d.parts.slice(5).join(" ") || DEFAULTS[type];
      else if (isBjt(type)) {
        const hasSub = d.parts.length >= 6 && !/=/.test(d.parts[4]);
        value = d.parts.slice(hasSub ? 5 : 4).join(" ") || DEFAULTS[type];
      } else if (isOpamp(type)) value = d.parts[d.parts.length - 1] || DEFAULTS.OPAMP;
      else if (isSw(type)) value = d.parts[5] || DEFAULTS.SW;
      else if (isEg(type)) value = d.parts[5] || DEFAULTS[type];
      else if (isCsw(type))
        value = [d.parts[3], d.parts[4]].filter(Boolean).join(" ") || DEFAULTS.CSW;
      else if (isFh(type))
        value = [d.parts[3], d.parts[4]].filter(Boolean).join(" ") || DEFAULTS[type];
      else if (isBsrc(type)) {
        const bm = /\b([vi]\s*=\s*.+)$/i.exec(d.raw || "");
        value = bm ? bm[1].replace(/\s*=\s*/, "=") : d.parts.slice(3).join(" ") || DEFAULTS.B;
      } else if (isK(type)) value = d.parts.slice(1).join(" ") || DEFAULTS.K;
      else value = d.parts.slice(3).join(" ") || DEFAULTS[type];

      let nodes = {};
      if (isFet(type)) {
        nodes = {
          d: normNode(d.parts[1]),
          g: normNode(d.parts[2]),
          s: normNode(d.parts[3]),
        };
      } else if (isBjt(type)) {
        nodes = {
          c: normNode(d.parts[1]),
          b: normNode(d.parts[2]),
          e: normNode(d.parts[3]),
        };
      } else if (isOpamp(type)) {
        nodes = {
          plus: normNode(d.parts[1]),
          minus: normNode(d.parts[2]),
          out: normNode(d.parts[3]),
        };
      } else if (isSw(type) || isEg(type)) {
        nodes = {
          a: normNode(d.parts[1]),
          b: normNode(d.parts[2]),
          c1: normNode(d.parts[3]),
          c2: normNode(d.parts[4]),
        };
      } else if (isCsw(type) || isFh(type) || isBsrc(type)) {
        nodes = {
          a: normNode(d.parts[1]),
          b: normNode(d.parts[2]),
        };
      } else if (!isK(type)) {
        nodes = {
          [DEVICE_PINS[type][0].id]: normNode(d.parts[1]),
          [DEVICE_PINS[type][1].id]: normNode(d.parts[2]),
        };
      }

      const nodeVals = Object.values(nodes);
      const layers = nodeVals.length
        ? nodeVals.map((n) => layerOf.get(n) ?? 1)
        : [1];
      const avgL = layers.reduce((a, b) => a + b, 0) / layers.length;
      const x = forcedX ?? snap(60 + avgL * 130);
      const y =
        forcedY ??
        snap(
          type === "V" || type === "I"
            ? 100
            : isFet(type) ||
                isBjt(type) ||
                isOpamp(type) ||
                isSw(type) ||
                isEg(type) ||
                isFh(type) ||
                isBsrc(type)
              ? 160
              : isK(type)
                ? 200
                : 120 + (hashStr(d.name) % 5) * 36
        );

      const comp = { id: uid("c"), type, name: d.name, x, y, rot: 0, value, nodes };
      this.components.push(comp);
      if (isFet(type)) {
        addNodePin(nodes.d, comp.id, "d");
        addNodePin(nodes.g, comp.id, "g");
        addNodePin(nodes.s, comp.id, "s");
      } else if (isBjt(type)) {
        addNodePin(nodes.c, comp.id, "c");
        addNodePin(nodes.b, comp.id, "b");
        addNodePin(nodes.e, comp.id, "e");
      } else if (isOpamp(type)) {
        addNodePin(nodes.plus, comp.id, "plus");
        addNodePin(nodes.minus, comp.id, "minus");
        addNodePin(nodes.out, comp.id, "out");
      } else if (isSw(type) || isEg(type)) {
        addNodePin(nodes.a, comp.id, "a");
        addNodePin(nodes.b, comp.id, "b");
        addNodePin(nodes.c1, comp.id, "c1");
        addNodePin(nodes.c2, comp.id, "c2");
      } else if (isCsw(type) || isFh(type) || isBsrc(type)) {
        addNodePin(nodes.a, comp.id, "a");
        addNodePin(nodes.b, comp.id, "b");
      } else if (!isK(type)) {
        const pins = DEVICE_PINS[type];
        addNodePin(nodes[pins[0].id], comp.id, pins[0].id);
        addNodePin(nodes[pins[1].id], comp.id, pins[1].id);
      }
      return comp;
    };

    // Sources in a left column
    sources.forEach((d, i) => placeDevice(d, 70, 90 + i * 100));
    // Passives / semis by layer with vertical packing per column
    const byCol = new Map();
    const kDevices = [];
    for (const d of rest) {
      if (d.kind === "K") {
        kDevices.push(d);
        continue;
      }
      const n1 = normNode(d.parts[1]);
      const n2 = normNode(
        d.kind === "M" ||
          d.kind === "Q" ||
          d.kind === "X" ||
          d.kind === "S" ||
          d.kind === "E" ||
          d.kind === "G"
          ? d.parts[3]
          : d.parts[2]
      );
      const col = Math.round(
        ((layerOf.get(n1) ?? 1) + (layerOf.get(n2) ?? 1)) / 2
      );
      if (!byCol.has(col)) byCol.set(col, []);
      byCol.get(col).push(d);
    }
    for (const [col, list] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
      list.forEach((d, i) => {
        placeDevice(d, 70 + col * 130, 80 + i * 90);
      });
    }
    kDevices.forEach((d, i) => placeDevice(d, 200 + i * 40, 240));

    // Ground
    const gndList = nodePins.get("0") || [];
    if (gndList.length) {
      const xs = gndList.map((p) => {
        const c = this.components.find((x) => x.id === p.cid);
        return c ? c.x : 80;
      });
      const avgX = xs.reduce((a, b) => a + b, 0) / xs.length;
      const g = {
        id: uid("c"),
        type: "GND",
        name: this._nextName("GND"),
        x: snap(avgX),
        y: 280,
        value: "",
        nodes: { g: "0" },
      };
      this.components.push(g);
      gndList.push({ cid: g.id, pinId: "g" });
      nodePins.set("0", gndList);
    }

    // Chain wires along node (reduce star clutter): sort pins by x and connect neighbors
    for (const [, pins] of nodePins) {
      if (pins.length < 2) continue;
      const ordered = [...pins].sort((a, b) => {
        const ca = this.components.find((c) => c.id === a.cid);
        const cb = this.components.find((c) => c.id === b.cid);
        return (ca?.x ?? 0) - (cb?.x ?? 0) || (ca?.y ?? 0) - (cb?.y ?? 0);
      });
      for (let i = 0; i < ordered.length - 1; i++) {
        this.wires.push({
          id: uid("w"),
          a: { cid: ordered[i].cid, pinId: ordered[i].pinId },
          b: { cid: ordered[i + 1].cid, pinId: ordered[i + 1].pinId },
        });
      }
    }

    // Net labels so → Netlist keeps SPICE node names
    for (const [node, pins] of nodePins) {
      if (node === "0" || !pins.length) continue;
      const name = sanitizeNetName(node);
      if (!name || name === "0") continue;
      const xs = [];
      const ys = [];
      for (const p of pins) {
        const c = this.components.find((x) => x.id === p.cid);
        if (!c) continue;
        const abs = this._pinAbs(c.id, p.pinId);
        if (abs) {
          xs.push(abs.x);
          ys.push(abs.y);
        } else {
          xs.push(c.x);
          ys.push(c.y);
        }
      }
      if (!xs.length) continue;
      const lx = snap(xs.reduce((a, b) => a + b, 0) / xs.length + 30);
      const ly = snap(ys.reduce((a, b) => a + b, 0) / ys.length - 20);
      const lab = {
        id: uid("c"),
        type: "NET",
        name: this._nextName("NET"),
        x: lx,
        y: ly,
        rot: 0,
        value: name,
      };
      this.components.push(lab);
      this.wires.push({
        id: uid("w"),
        a: { cid: pins[0].cid, pinId: pins[0].pinId },
        b: { cid: lab.id, pinId: "n" },
      });
    }

    this.render();
    const restored = savedLayout ? this.applyLayout(savedLayout) : false;
    if (restored) this.render();
    else this.fitView();
    return restored;
  }

  /** Show live values at nodes: { out: "3.16V", in: "5V" } */
  setProbes(map) {
    this.probes = map || {};
    if (this.isVisible()) this.render();
  }

  clearProbes() {
    this.probes = {};
    if (this.isVisible()) this.render();
  }

  render(pointerEvent) {
    const svg = this.svg;
    const P = schematicPalette();
    const { w, h, vw, vh } = this._viewSize();
    svg.setAttribute("viewBox", `${this.view.x} ${this.view.y} ${vw} ${vh}`);
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.background = P.bg;

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    // grid
    const defs = document.createElementNS(svg.namespaceURI, "defs");
    const pat = document.createElementNS(svg.namespaceURI, "pattern");
    pat.setAttribute("id", "sch-grid");
    pat.setAttribute("width", String(GRID * 2));
    pat.setAttribute("height", String(GRID * 2));
    pat.setAttribute("patternUnits", "userSpaceOnUse");
    const pdot = document.createElementNS(svg.namespaceURI, "circle");
    pdot.setAttribute("cx", "0");
    pdot.setAttribute("cy", "0");
    pdot.setAttribute("r", "1");
    pdot.setAttribute("fill", P.grid);
    pat.appendChild(pdot);
    defs.appendChild(pat);
    svg.appendChild(defs);

    const bg = document.createElementNS(svg.namespaceURI, "rect");
    bg.setAttribute("width", "100%");
    bg.setAttribute("height", "100%");
    bg.setAttribute("fill", "url(#sch-grid)");
    bg.setAttribute("pointer-events", "all");
    svg.appendChild(bg);

    const pinNodes = this._pinNodeMap();
    const nodeOf = (cid, pinId) => pinNodes.get(pinKey(cid, pinId));

    const gWires = document.createElementNS(svg.namespaceURI, "g");
    gWires.setAttribute("class", "sch-wires");
    for (const wire of this.wires) {
      const pts = this._wirePoints(wire);
      if (pts.length < 2) continue;
      const path = document.createElementNS(svg.namespaceURI, "path");
      const d = pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ");
      path.setAttribute("d", d);
      path.setAttribute("fill", "none");
      const sel = this.selWires.has(wire.id);
      const onNet =
        this.hoverNet != null && nodeOf(wire.a.cid, wire.a.pinId) === this.hoverNet;
      path.setAttribute("stroke", sel ? P.select : onNet ? P.accent : P.wire);
      path.setAttribute("stroke-width", sel || onNet ? "3" : "2");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      path.dataset.wireId = wire.id;
      gWires.appendChild(path);
      // Corner handles when selected — show route is editable
      if (sel && pts.length > 2) {
        for (let i = 1; i < pts.length - 1; i++) {
          const h = document.createElementNS(svg.namespaceURI, "rect");
          h.setAttribute("x", String(pts[i].x - 3.5));
          h.setAttribute("y", String(pts[i].y - 3.5));
          h.setAttribute("width", "7");
          h.setAttribute("height", "7");
          h.setAttribute("fill", P.select);
          h.setAttribute("stroke", P.bg);
          h.setAttribute("stroke-width", "1");
          gWires.appendChild(h);
        }
      }
    }

    // rubber-band wire (drag or click-click)
    if (this.wireStart && pointerEvent) {
      const a = this._pinAbs(this.wireStart.cid, this.wireStart.pinId);
      if (a) {
        const { x, y } = this._svgPoint(pointerEvent);
        const pts = manhattan(a.x, a.y, snap(x), snap(y));
        const path = document.createElementNS(svg.namespaceURI, "path");
        path.setAttribute(
          "d",
          pts.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" ")
        );
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", P.accent);
        path.setAttribute("stroke-width", "1.75");
        path.setAttribute("stroke-dasharray", "4 3");
        gWires.appendChild(path);
      }
    }
    svg.appendChild(gWires);

    // junction dots
    const gJ = document.createElementNS(svg.namespaceURI, "g");
    for (const j of this._junctionPoints()) {
      const cir = document.createElementNS(svg.namespaceURI, "circle");
      cir.setAttribute("cx", String(j.x));
      cir.setAttribute("cy", String(j.y));
      cir.setAttribute("r", "3.5");
      cir.setAttribute("fill", P.wire);
      cir.setAttribute("stroke", "none");
      gJ.appendChild(cir);
    }
    svg.appendChild(gJ);

    const gComps = document.createElementNS(svg.namespaceURI, "g");
    for (const c of this.components) {
      const g = document.createElementNS(svg.namespaceURI, "g");
      const rot = c.rot || 0;
      g.setAttribute("transform", `translate(${c.x},${c.y}) rotate(${rot})`);
      g.dataset.cid = c.id;
      const sel = this.selComps.has(c.id);
      const stroke = sel ? P.select : P.symbol;
      const sym = symbolPaths(c.type, P);

      if (sym.circle) {
        const cir = document.createElementNS(svg.namespaceURI, "circle");
        cir.setAttribute("cx", String(sym.circle.cx));
        cir.setAttribute("cy", String(sym.circle.cy));
        cir.setAttribute("r", String(sym.circle.r));
        cir.setAttribute("fill", "none");
        cir.setAttribute("stroke", stroke);
        cir.setAttribute("stroke-width", "2.25");
        g.appendChild(cir);
      }
      if (sym.circles) {
        for (const cdef of sym.circles) {
          const cir = document.createElementNS(svg.namespaceURI, "circle");
          cir.setAttribute("cx", String(cdef.cx));
          cir.setAttribute("cy", String(cdef.cy));
          cir.setAttribute("r", String(cdef.r));
          cir.setAttribute("fill", P.pinFill);
          cir.setAttribute("stroke", stroke);
          cir.setAttribute("stroke-width", "2");
          g.appendChild(cir);
        }
      }
      if (sym.poly) {
        const poly = document.createElementNS(svg.namespaceURI, "polygon");
        poly.setAttribute("points", sym.poly);
        poly.setAttribute("fill", P.symbol);
        poly.setAttribute("stroke", stroke);
        poly.setAttribute("stroke-width", "1.75");
        g.appendChild(poly);
      }
      if (sym.polys) {
        for (const pdef of sym.polys) {
          const poly = document.createElementNS(svg.namespaceURI, "polygon");
          poly.setAttribute("points", pdef.points);
          poly.setAttribute("fill", pdef.fill === false ? "none" : P.symbol);
          poly.setAttribute("stroke", stroke);
          poly.setAttribute("stroke-width", "1.5");
          g.appendChild(poly);
        }
      }
      if (sym.body) {
        const path = document.createElementNS(svg.namespaceURI, "path");
        path.setAttribute("d", sym.body.replace(/\s+/g, " ").trim());
        path.setAttribute("fill", "none");
        path.setAttribute("stroke", stroke);
        path.setAttribute("stroke-width", "2.25");
        path.setAttribute("stroke-linecap", "round");
        path.setAttribute("stroke-linejoin", "round");
        g.appendChild(path);
      }
      if (sym.marks) {
        for (const m of sym.marks) {
          const path = document.createElementNS(svg.namespaceURI, "path");
          path.setAttribute("d", m.d);
          path.setAttribute("fill", "none");
          path.setAttribute("stroke", m.stroke || stroke);
          path.setAttribute("stroke-width", "2");
          path.setAttribute("stroke-linecap", "round");
          g.appendChild(path);
        }
      }

      // label
      if (c.type !== "GND") {
        const tall =
          isFet(c.type) ||
          isBjt(c.type) ||
          isOpamp(c.type) ||
          isSw(c.type) ||
          isEg(c.type) ||
          isFh(c.type) ||
          isBsrc(c.type) ||
          c.type === "V" ||
          c.type === "I";
        const label = document.createElementNS(svg.namespaceURI, "text");
        label.setAttribute("x", isNet(c.type) ? "36" : "0");
        label.setAttribute("y", String(isNet(c.type) ? 4 : tall ? -52 : -18));
        label.setAttribute("text-anchor", isNet(c.type) ? "start" : "middle");
        label.setAttribute("fill", isNet(c.type) ? P.accent : P.label);
        label.setAttribute("font-size", isNet(c.type) ? "12" : "11");
        label.setAttribute("font-family", "IBM Plex Mono, monospace");
        label.setAttribute("font-weight", "600");
        if (isNet(c.type)) label.textContent = c.value || "net";
        else label.textContent = c.value ? `${c.name} ${c.value}` : c.name;
        g.appendChild(label);
      }

      // pins
      for (const pin of DEVICE_PINS[c.type] || []) {
        const cir = document.createElementNS(svg.namespaceURI, "circle");
        cir.setAttribute("cx", String(pin.x));
        cir.setAttribute("cy", String(pin.y));
        const pinNode = nodeOf(c.id, pin.id);
        const onNet = this.hoverNet != null && pinNode === this.hoverNet;
        cir.setAttribute("r", String(onNet ? PIN_R + 1.5 : PIN_R));
        const hot =
          this.wireStart &&
          this.wireStart.cid === c.id &&
          this.wireStart.pinId === pin.id;
        cir.setAttribute("fill", hot || onNet ? P.accent : P.pinFill);
        cir.setAttribute("stroke", hot || onNet ? P.select : P.symbol);
        cir.setAttribute("stroke-width", onNet ? "2.25" : "2");
        cir.dataset.pin = pin.id;
        g.appendChild(cir);

        if (pin.label) {
          const pl = document.createElementNS(svg.namespaceURI, "text");
          const lx = pin.x < 0 ? pin.x - 8 : pin.x > 0 ? pin.x + 8 : pin.x + 10;
          const ly = pin.y < 0 ? pin.y - 6 : pin.y > 0 ? pin.y + 12 : pin.y - 8;
          pl.setAttribute("x", String(lx));
          pl.setAttribute("y", String(ly));
          pl.setAttribute("text-anchor", pin.x < 0 ? "end" : "start");
          pl.setAttribute("fill", onNet ? P.accentHi : P.labelMuted);
          pl.setAttribute("font-size", "9");
          pl.setAttribute("font-family", "IBM Plex Mono, monospace");
          pl.setAttribute("font-weight", "600");
          pl.textContent = pin.label;
          g.appendChild(pl);
        }

        const nodeName = c.nodes?.[pin.id] ?? pinNode;
        const probeVal = nodeName && this.probes?.[nodeName];
        if (probeVal) {
          const t = document.createElementNS(svg.namespaceURI, "text");
          t.setAttribute("x", String(pin.x + 8));
          t.setAttribute("y", String(pin.y - 6));
          t.setAttribute("fill", P.accent);
          t.setAttribute("font-size", "10");
          t.setAttribute("font-family", "IBM Plex Mono, monospace");
          t.setAttribute("font-weight", "600");
          t.textContent = `${nodeName}: ${probeVal}`;
          g.appendChild(t);
        } else if (nodeName && nodeName !== "0") {
          const t = document.createElementNS(svg.namespaceURI, "text");
          t.setAttribute("x", String(pin.x + 6));
          t.setAttribute("y", String(pin.y + 12));
          t.setAttribute("fill", onNet ? P.accent : P.labelMuted);
          t.setAttribute("font-size", "9");
          t.setAttribute("font-family", "IBM Plex Mono, monospace");
          t.textContent = nodeName;
          g.appendChild(t);
        }
      }

      gComps.appendChild(g);
    }
    svg.appendChild(gComps);

    // rubber-band selection box
    if (this.box) {
      const nb = this._normBox(this.box);
      const rect = document.createElementNS(svg.namespaceURI, "rect");
      rect.setAttribute("x", String(nb.x0));
      rect.setAttribute("y", String(nb.y0));
      rect.setAttribute("width", String(Math.max(0, nb.x1 - nb.x0)));
      rect.setAttribute("height", String(Math.max(0, nb.y1 - nb.y0)));
      rect.setAttribute("fill", P.selectSoft);
      rect.setAttribute("stroke", P.select);
      rect.setAttribute("stroke-width", "1.25");
      rect.setAttribute("stroke-dasharray", "4 3");
      rect.setAttribute("pointer-events", "none");
      svg.appendChild(rect);
    }

    // Floating probe legend (unique nodes)
    if (this.probes && Object.keys(this.probes).length) {
      const gProbe = document.createElementNS(svg.namespaceURI, "g");
      let py = this.view.y + 16;
      const title = document.createElementNS(svg.namespaceURI, "text");
      title.setAttribute("x", String(this.view.x + vw - 8));
      title.setAttribute("y", String(py));
      title.setAttribute("text-anchor", "end");
      title.setAttribute("fill", P.labelMuted);
      title.setAttribute("font-size", "10");
      title.setAttribute("font-family", "IBM Plex Sans, sans-serif");
      title.textContent = "Probes";
      gProbe.appendChild(title);
      py += 14;
      for (const [n, v] of Object.entries(this.probes)) {
        const t = document.createElementNS(svg.namespaceURI, "text");
        t.setAttribute("x", String(this.view.x + vw - 8));
        t.setAttribute("y", String(py));
        t.setAttribute("text-anchor", "end");
        t.setAttribute("fill", P.accent);
        t.setAttribute("font-size", "11");
        t.setAttribute("font-family", "IBM Plex Mono, monospace");
        t.textContent = `v(${n})=${v}`;
        gProbe.appendChild(t);
        py += 14;
      }
      svg.appendChild(gProbe);
    }

    // hint
    const hint = document.createElementNS(svg.namespaceURI, "text");
    hint.setAttribute("x", String(this.view.x + 8));
    hint.setAttribute("y", String(this.view.y + vh - 8));
    hint.setAttribute("fill", P.labelMuted);
    hint.setAttribute("font-size", "10");
    hint.setAttribute("font-family", "IBM Plex Sans, sans-serif");
    hint.textContent = this.hoverNet
      ? `net ${this.hoverNet} · Ctrl+click / long-press pin to plot`
      : "drag wire segment to reshape · pin→pin to wire · Space/Pan · pinch";
    svg.appendChild(hint);
  }
}

function distToSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
