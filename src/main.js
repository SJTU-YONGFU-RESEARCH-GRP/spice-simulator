import { parseNetlist } from "./netlist/parser.js";
import { expandIncludes } from "./netlist/include.js";
import {
  parseSteps,
  applyStepParam,
  formatStepLabel,
  resampleSeries,
} from "./netlist/step.js";
import { dcAnalysis } from "./engine/dc.js";
import { transient } from "./engine/transient.js";
import { acAnalysis } from "./engine/ac.js";
import { noiseAnalysis } from "./engine/noise.js";
import { tfAnalysis } from "./engine/tf.js";
import { distoAnalysis } from "./engine/disto.js";
import { pzAnalysis } from "./engine/pz.js";
import { mcAnalysis } from "./engine/mc.js";
import { parseMeasures, evalMeasures } from "./engine/measure.js";
import { runNgspice } from "./engine/ngspice.js";
import { WaveformView } from "./ui/waveform.js";
import { SchematicEditor } from "./ui/schematic.js";
import { initWorkspaceSplitters } from "./ui/splitters.js";
import { showContextMenu } from "./ui/ctxmenu.js";
import { resultToCsv, downloadCsv } from "./ui/csv.js";
import { resultToVcd, downloadText } from "./ui/vcd.js";
import { diffAgainstGolden, cloneResult } from "./ui/golden.js";
import { spectrumFromTransient } from "./engine/fft.js";
import { parseFours, evalFourier } from "./engine/fourier.js";
import { parsePrint, matchSeriesNames } from "./netlist/print.js";
import { CommandPalette } from "./ui/palette.js";
import { formatEng, parseNumber } from "./units.js";

const EXAMPLE_RC = `* RC low-pass — step response (PULSE)
V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out 1k
C1 out 0 1u
.tran 10u 5m
.end
`;

const EXAMPLE_RLC = `* Series RLC underdamped
V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in mid 10
L1 mid out 1m
C1 out 0 1u
.tran 5u 2m
.end
`;

const EXAMPLE_AC = `* RC low-pass — AC Bode
V1 in 0 DC 0 AC 1
R1 in out 1k
C1 out 0 1u
.ac dec 20 1 1Meg
.end
`;

const EXAMPLE_MOS = `* NMOS common-source amp (DC bias + AC)
Vdd dd 0 DC 5
Vin in 0 DC 1.2 AC 1
Rg in g 1k
Mn out g 0 0 NMOS W=10u L=1u
Rd dd out 10k
.model NMOS NMOS (Vto=0.7 Kp=50u Lambda=0.02)
.ac dec 20 1k 100Meg
.end
`;

const EXAMPLE_DIODE = `* Diode + UIC
V1 in 0 DC 5
R1 in out 1k
D1 out 0 DDEFAULT
.model DDEFAULT D (Is=1e-14 N=1)
.ic V(out)=0
.tran 10u 2m UIC
.end
`;

const EXAMPLE_ADAPTIVE = `* RC with adaptive timestep
V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out 1k
C1 out 0 1u
.tran 100u 5m ADAPTIVE
.end
`;

const EXAMPLE_PARAM = `* RC with .param
.param Rload=1k Cload=1u
V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out {Rload}
C1 out 0 {Cload}
.tran 10u 5m
.end
`;

const EXAMPLE_BJT = `* NPN common-emitter amp
.param Rc=1k Rb=10k
Vcc vcc 0 DC 5
Vin in 0 PULSE(0 0.8 0 1n 1n 10 10)
Rb in b {Rb}
Q1 c b 0 NPN
Rc vcc c {Rc}
.model NPN NPN (Is=1e-15 Bf=100 Br=1 Vaf=50)
.tran 10u 2m
.end
`;

const EXAMPLE_OPAMP = `* Inverting amp using built-in OPAMP subckt
Vin in 0 PULSE(0 1 0 1n 1n 10 10)
Rin in mid 10k
Rf mid out 100k
X1 0 mid out OPAMP
.tran 10u 2m
.end
`;

const EXAMPLE_NOISE = `* RC noise + diode flicker
.temp 27
V1 in 0 DC 0.7 AC 1
R1 in mid 1k
D1 mid out DFLICK
R2 out 0 1k
C1 out 0 1u
.model DFLICK D (Is=1e-14 N=1 Kf=1e-12 Af=1)
.noise V(out) V1 dec 20 1 100k
.end
`;

const EXAMPLE_INCLUDE = `* Diode via .include lib/models.cir
.include lib/models.cir
V1 in 0 DC 5
R1 in out 1k
D1 out 0 D1N4148
.dc
.end
`;

const EXAMPLE_MEAS = `* RC with .measure
V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out 1k
C1 out 0 1u
.tran 10u 5m
.meas tran vmax MAX v(out)
.meas tran vmin MIN v(out)
.meas tran vpp PP v(out)
.meas tran vrms RMS v(out) FROM=1m TO=5m
.meas tran vat AT v(out) AT=1m
.meas tran t50 WHEN v(out)=2.5 RISE=1
.meas tran td TRIG v(in)=2.5 RISE=1 TARG v(out)=2.5 RISE=1
.end
`;

const EXAMPLE_B = `* Behavioral B + .func
.func clamp(x,lo,hi) {max(lo,min(hi,x))}
Vin in 0 SIN(0 1.5 1k)
B1 mid 0 V=2*v(in)
B2 out 0 V=clamp(v(mid),-1,1)
R1 out 0 1k
.tran 20u 3m
.print tran v(in) v(mid) v(out)
.end
`;

const EXAMPLE_TF = `* Resistive divider — .tf
V1 in 0 DC 1
R1 in out 1k
R2 out 0 1k
.tf V(out) V1
.end
`;

const EXAMPLE_STEP = `* RC step response vs Rload
.param Rload=1k
V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out {Rload}
C1 out 0 1u
.tran 20u 5m
.step param Rload list 500 1k 2k
.end
`;

const EXAMPLE_FOUR = `* Pulse Fourier spectrum
V1 in 0 PULSE(0 1 0 1n 1n 0.5m 1m)
R1 in out 1k
C1 out 0 10n
.tran 5u 5m
.four 1k v(out)
.end
`;

const EXAMPLE_SIN = `* Sine drive + Fourier
V1 in 0 SIN(0 1 1k)
R1 in out 1k
C1 out 0 10n
.tran 10u 5m
.four 1k v(out)
.print tran v(out) v(in)
.end
`;

const EXAMPLE_PWL = `* Piecewise-linear ramp
V1 in 0 PWL(0 0 1m 5 3m 5 4m 0)
R1 in out 1k
C1 out 0 1u
.tran 20u 5m
.print tran v(in) v(out)
.end
`;

const EXAMPLE_EXP = `* Exponential pulse into RC
V1 in 0 EXP(0 5 0.5m 0.2m 2.5m 0.3m)
R1 in out 1k
C1 out 0 0.5u
.tran 20u 5m
.print tran v(in) v(out)
.end
`;

const EXAMPLE_FH = `* Current-controlled sources F / H
Vin in 0 DC 1
Rs in sense 1k
Vsense sense 0 DC 0
F1 0 out Vsense 2
Rl out 0 1k
H1 hout 0 Vsense 2k
Rh hout 0 10k
.dc
.print dc v(out) v(hout) i(Vsense)
.end
`;

const EXAMPLE_SW = `* Voltage-controlled switch
Vin in 0 PULSE(0 5 0 1n 1n 1m 2m)
Vctrl c 0 PULSE(0 5 0.5m 1n 1n 0.5m 2m)
S1 in out c 0 SW1
R1 out 0 1k
.model SW1 SW (Vt=2.5 Vh=0.1 Ron=1 Roff=1G)
.tran 10u 4m
.print tran v(in) v(out) v(c)
.end
`;

const EXAMPLE_CSW = `* Current-controlled switch
Iin 0 in DC 2m
Vsense in 0 DC 0
Vload mid 0 DC 5
W1 mid out Vsense CSW1
Rl out 0 1k
.model CSW1 CSW (It=1m Ih=0.1m Ron=1 Roff=1G)
.dc
.print dc v(out) i(Vsense)
.end
`;

const EXAMPLE_K = `* Coupled inductors (transformer)
Vin in 0 SIN(0 1 1k)
R1 in p 10
L1 p 0 10m
L2 sec 0 10m
K1 L1 L2 0.95
Rload sec 0 1k
.tran 10u 5m
.print tran v(p) v(sec)
.end
`;

const EXAMPLE_DCSWEEP = `* Diode I–V (.dc sweep)
V1 a 0 DC 0
D1 a 0 D1
.model D1 D (Is=1e-14 N=1)
.dc V1 0 0.8 0.02
.print dc i(V1) v(a)
.end
`;

const EXAMPLE_DCNEST = `* NMOS Id–Vds family (nested .dc)
Vds d 0 DC 0
Vgs g 0 DC 0
Mn d g 0 0 NMOS W=10u L=1u
.model NMOS NMOS (Vto=0.7 Kp=50u Lambda=0.02)
.dc Vds 0 5 0.1 Vgs 1 2.5 0.5
.print dc i(Vds)
.end
`;

const EXAMPLE_PZ = `* RC low-pass poles
Vin in 0 DC 0
R1 in out 1k
C1 out 0 1u
.pz V(out)
.end
`;

const EXAMPLE_MC = `* Resistive divider Monte Carlo
V1 in 0 5
R1 in out 1k lot=10%
R2 out 0 1k lot=10%
.mc 40 seed=1
.end
`;

const EXAMPLE_DISTO = `* Diode clipper — harmonic distortion vs freq
Vin in 0 DC 0 AC 1.5
R1 in mid 1k
D1 mid 0 D1
D2 0 mid D1
R2 mid out 1k
C1 out 0 10n
.model D1 D (Is=1e-14 N=1 Rs=10 IKF=0.1)
.disto V(out) dec 5 1k 100k
.end
`;

const EXAMPLE_XY = `* Lissajous — enable XY, select v(x) then v(y)
Vx x 0 SIN(0 1 1k 0 0 0)
Vy y 0 SIN(0 1 1k 0 0 90)
.tran 10u 2m
.print tran v(x) v(y)
.end
`;

const EXAMPLES = [
  EXAMPLE_RC,
  EXAMPLE_RLC,
  EXAMPLE_AC,
  EXAMPLE_MOS,
  EXAMPLE_DIODE,
  EXAMPLE_ADAPTIVE,
  EXAMPLE_PARAM,
  EXAMPLE_BJT,
  EXAMPLE_OPAMP,
  EXAMPLE_NOISE,
  EXAMPLE_INCLUDE,
  EXAMPLE_MEAS,
  EXAMPLE_TF,
  EXAMPLE_STEP,
  EXAMPLE_FOUR,
  EXAMPLE_DCSWEEP,
  EXAMPLE_DCNEST,
  EXAMPLE_SIN,
  EXAMPLE_PWL,
  EXAMPLE_EXP,
  EXAMPLE_FH,
  EXAMPLE_SW,
  EXAMPLE_CSW,
  EXAMPLE_K,
  EXAMPLE_B,
  EXAMPLE_XY,
  EXAMPLE_DISTO,
  EXAMPLE_PZ,
  EXAMPLE_MC,
];

const netlistEl = document.getElementById("netlist");
const netlistWrap = document.getElementById("netlist-wrap");
const netlistGutter = document.getElementById("netlist-gutter");
const consoleEl = document.getElementById("console");
const resultsEl = document.getElementById("results");
const statusEl = document.getElementById("status");
const plotSelect = document.getElementById("plot-signals");
const signalListEl = document.getElementById("signal-list");
const cursorStatus = document.getElementById("cursor-status");
const cursorTbody = document.getElementById("cursor-tbody");
const analysisType = document.getElementById("analysis-type");
const engineType = document.getElementById("engine-type");
const adaptiveEl = document.getElementById("adaptive");
const logYEl = document.getElementById("log-y");
const xyModeEl = document.getElementById("xy-mode");
const tstopEl = document.getElementById("tstop");
const tstepEl = document.getElementById("tstep");
const btnRun = document.getElementById("btn-run");
const btnStop = document.getElementById("btn-stop");
const btnCsv = document.getElementById("btn-csv");
const btnVcd = document.getElementById("btn-vcd");
const btnPng = document.getElementById("btn-png");
const btnGolden = document.getElementById("btn-golden");
const btnDiff = document.getElementById("btn-diff");
const btnReset = document.getElementById("btn-reset");
const btnFft = document.getElementById("btn-fft");
const btnSave = document.getElementById("btn-save");
const openNetlistEl = document.getElementById("open-netlist");
const libFilesEl = document.getElementById("lib-files");

const SIG_COLORS = [
  "#4fb8a7",
  "#6ea8fe",
  "#e6a05c",
  "#c9a0dc",
  "#e07070",
  "#d4c35c",
];

const wave = new WaveformView(document.getElementById("wave"));
initWorkspaceSplitters(document.getElementById("workspace"));

/** Set after SchematicEditor is constructed (theme refresh). */
const uiRefs = { schematic: null };

function applyTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try {
    localStorage.setItem("spice-theme", next);
  } catch {
    /* ignore */
  }
  const toggle = document.getElementById("theme-toggle");
  const label = document.getElementById("theme-label");
  const isNight = next === "dark";
  if (toggle) {
    toggle.checked = isNight;
    toggle.setAttribute("aria-checked", String(isNight));
  }
  if (label) label.textContent = isNight ? "Night" : "Day";
  wave.draw();
  uiRefs.schematic?.render?.();
  document.documentElement.style.colorScheme = next;
}

{
  const cur =
    document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
  applyTheme(cur);
  document.getElementById("theme-toggle")?.addEventListener("change", (e) => {
    applyTheme(e.target.checked ? "dark" : "light");
  });
}

function selectedPlotSignals() {
  return [...plotSelect.selectedOptions].map((o) => o.value);
}

function syncSignalListFromSelect() {
  if (!signalListEl || !plotSelect) return;
  const selected = new Set(selectedPlotSignals());
  const opts = [...plotSelect.options];
  signalListEl.innerHTML = opts
    .map((o, i) => {
      const on = selected.has(o.value);
      const color = SIG_COLORS[i % SIG_COLORS.length];
      return `<label class="signal-item${on ? " on" : ""}" style="--sig-color:${color}" data-name="${esc(o.value)}" title="${esc(o.value)}">
        <input type="checkbox" ${on ? "checked" : ""} />
        <span class="swatch"></span>
        <span class="sig-name">${esc(o.value)}</span>
      </label>`;
    })
    .join("");
}

function setPlotSelection(names, { refreshWave = true } = {}) {
  const want = new Set(names);
  for (const opt of plotSelect.options) {
    opt.selected = want.has(opt.value);
  }
  syncSignalListFromSelect();
  if (refreshWave && lastResult?.times) {
    wave.setData(
      lastResult.times,
      lastResult.series,
      selectedPlotSignals(),
      wavePlotOpts(lastResult)
    );
  }
}

function togglePlotSignal(name) {
  const opt = [...plotSelect.options].find((o) => o.value === name);
  if (!opt) return;
  opt.selected = !opt.selected;
  // keep at least one selected if possible
  if (![...plotSelect.selectedOptions].length && plotSelect.options.length) {
    opt.selected = true;
  }
  syncSignalListFromSelect();
  if (lastResult?.times) {
    wave.setData(
      lastResult.times,
      lastResult.series,
      selectedPlotSignals(),
      wavePlotOpts(lastResult)
    );
  }
}

signalListEl?.addEventListener("click", (e) => {
  const row = e.target.closest(".signal-item");
  if (!row) return;
  e.preventDefault();
  togglePlotSignal(row.dataset.name);
});

function setDock(which) {
  const cons = document.getElementById("console");
  const res = document.getElementById("results");
  const tabC = document.getElementById("dock-tab-console");
  const tabR = document.getElementById("dock-tab-results");
  const isConsole = which !== "results";
  if (cons) cons.hidden = !isConsole;
  if (res) res.hidden = isConsole;
  tabC?.classList.toggle("active", isConsole);
  tabR?.classList.toggle("active", !isConsole);
  tabC?.setAttribute("aria-selected", String(isConsole));
  tabR?.setAttribute("aria-selected", String(!isConsole));
  const clearBtn = document.getElementById("btn-clear-log");
  if (clearBtn) clearBtn.hidden = !isConsole;
}

document.getElementById("dock-tab-console")?.addEventListener("click", () => setDock("console"));
document.getElementById("dock-tab-results")?.addEventListener("click", () => setDock("results"));
setDock("console");

let abortCtrl = null;
let lastResult = null;
let lastTranResult = null;
let lastAnalysis = null;
let lastSourceText = "";
let goldenResult = null;
const libraryFiles = new Map();

function log(msg, cls = "") {
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = msg;
  consoleEl.appendChild(line);
  consoleEl.scrollTop = consoleEl.scrollHeight;
}

function setStatus(s, kind = "") {
  statusEl.textContent = s;
  statusEl.classList.remove("ok", "busy", "err");
  if (kind) statusEl.classList.add(kind);
}

const schematicRoot = document.getElementById("schematic-root");
const tabNetlist = document.getElementById("tab-netlist");
const tabSchematic = document.getElementById("tab-schematic");
const editorHint = document.getElementById("editor-hint");

const schematic = new SchematicEditor(schematicRoot, netlistEl, {
  onLog: (msg) => log(msg),
  onPinProbe: ({ node }) => togglePlotNode(node),
});
uiRefs.schematic = schematic;

function signalCandidatesForNode(node) {
  if (!node || node === "0" || !lastResult?.series) return [];
  const keys = Object.keys(lastResult.series);
  const exact = [
    `v(${node})`,
    `db(v(${node}))`,
    `ph(v(${node}))`,
  ];
  const hit = exact.filter((k) => keys.includes(k));
  if (hit.length) return hit;
  // stepped overlays e.g. v(out)@1k
  return keys.filter(
    (k) =>
      k === `v(${node})` ||
      k.startsWith(`v(${node})@`) ||
      k.startsWith(`db(v(${node}))`)
  );
}

function togglePlotNode(node) {
  if (!lastResult?.series) {
    log("Run a simulation first, then Ctrl+click a pin to plot", "warn");
    return;
  }
  const cands = signalCandidatesForNode(node);
  if (!cands.length) {
    log(`No plotted signal for node ${node}`, "warn");
    return;
  }
  const opts = [...plotSelect.options];
  let changed = false;
  for (const name of cands) {
    const opt = opts.find((o) => o.value === name);
    if (!opt) continue;
    opt.selected = !opt.selected;
    changed = true;
  }
  if (!changed) {
    log(`Signal for node ${node} not in plot list`, "warn");
    return;
  }
  const selected = selectedPlotSignals();
  wave.setData(lastResult.times, lastResult.series, selected, wavePlotOpts(lastResult));
  syncSignalListFromSelect();
  log(`Plot toggle node ${node}: ${selected.filter((s) => cands.includes(s)).join(", ") || "off"}`);
}

function wavePlotOpts(result, extra = {}) {
  return {
    xScale: result?.xScale,
    xUnit: result?.xUnit,
    yScale: logYEl?.checked ? "log" : "lin",
    xyMode: !!xyModeEl?.checked,
    golden: result?.analysis === "fft" ? null : goldenResult,
    ...extra,
  };
}

wave.onHover = (info) => {
  updateCursorUi(info);
  if (!info || (info.t == null && info.x == null && !info.cursorA && !info.cursorB)) {
    schematic.clearProbes();
    return;
  }
  const tProbe =
    info.t != null ? info.t : info.cursorA?.t != null ? info.cursorA.t : info.cursorB?.t;
  schematic.setProbes(probesFromResult(lastResult, tProbe));
};

function updateCursorUi(info) {
  const hint =
    "wheel zoom · drag pan · click A · Shift+click B · drag cursors · Ctrl+drag box";
  if (!cursorStatus) return;
  if (!info || (info.t == null && info.x == null && !info.cursorA && !info.cursorB)) {
    cursorStatus.textContent = hint;
    if (cursorTbody) {
      cursorTbody.innerHTML = `<tr><td colspan="5" class="muted">Place cursors A/B on the plot for values.</td></tr>`;
    }
    return;
  }
  const xy = !!info.xy;
  const unit = info.unit || (xy ? "" : "s");
  const axis = xy ? info.xName || "x" : unit === "Hz" ? "f" : "t";
  const bits = [];
  const fmtX = (c) => (c == null ? "—" : formatEng(xy ? c.x : c.t, 4) + unit);
  bits.push(`A: ${fmtX(info.cursorA)}`);
  bits.push(`B: ${fmtX(info.cursorB)}`);
  if (info.cursorA && info.cursorB) {
    const a = xy ? info.cursorA.x : info.cursorA.t;
    const b = xy ? info.cursorB.x : info.cursorB.t;
    bits.push(`Δ: ${formatEng(b - a, 4)}${unit}`);
  }
  const hoverX = xy ? info.x : info.t;
  if (hoverX != null) bits.push(`${axis}=${formatEng(hoverX, 4)}${unit}`);
  cursorStatus.textContent = bits.join("  ·  ");

  if (!cursorTbody) return;
  const names = [
    ...new Set([
      ...Object.keys(info.values || {}),
      ...Object.keys(info.cursorA?.values || {}),
      ...Object.keys(info.cursorB?.values || {}),
    ]),
  ];
  if (!names.length) {
    cursorTbody.innerHTML = `<tr><td colspan="5" class="muted">No plotted signals.</td></tr>`;
    return;
  }
  const cell = (v) => (v == null || !Number.isFinite(v) ? "—" : formatEng(v, 5));
  cursorTbody.innerHTML = names
    .map((n) => {
      const va = info.cursorA?.values?.[n];
      const vb = info.cursorB?.values?.[n];
      const vh = info.values?.[n];
      const d =
        va != null && vb != null && Number.isFinite(va) && Number.isFinite(vb)
          ? formatEng(vb - va, 5)
          : "—";
      return `<tr><td>${esc(n)}</td><td>${cell(va)}</td><td>${cell(vb)}</td><td>${d}</td><td>${cell(vh)}</td></tr>`;
    })
    .join("");
}

/** Sample all v(node) [and overlays] at time/freq t for schematic pins. */
function probesFromResult(result, t) {
  if (!result?.times?.length || t == null || !Number.isFinite(t)) return {};
  const times = result.times;
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  let idx = lo;
  if (idx > 0 && Math.abs(times[idx - 1] - t) < Math.abs(times[idx] - t)) idx = idx - 1;

  const probes = {};
  const entries = Object.entries(result.series || {});
  for (const [k, ys] of entries) {
    const m = /^v\(([^)]+)\)$/i.exec(k);
    if (!m) continue;
    const node = m[1];
    if (node === "0") continue;
    const v = ys?.[idx];
    if (Number.isFinite(v)) probes[node] = formatEng(v, 4);
  }
  for (const [k, ys] of entries) {
    const m = /^v\(([^)]+)\)@.+$/i.exec(k);
    if (!m) continue;
    const node = m[1];
    if (node === "0" || probes[node] != null) continue;
    const v = ys?.[idx];
    if (Number.isFinite(v)) probes[node] = formatEng(v, 4);
  }
  return probes;
}

document.getElementById("btn-fit").addEventListener("click", () => wave.fit());
document.getElementById("btn-goto-a")?.addEventListener("click", () => wave.gotoCursor("A"));
document.getElementById("btn-goto-b")?.addEventListener("click", () => wave.gotoCursor("B"));
document.getElementById("btn-clear-cursors")?.addEventListener("click", () => wave.clearCursors());

wave.onLegendClick = (name, mods) => {
  if (!name) return;
  // Ctrl/Shift/Alt+click legend → toggle visibility in signal list
  if (mods.ctrl || mods.shift || mods.alt) {
    togglePlotSignal(name);
    return;
  }
  // click → highlight (again clears)
  if (wave.highlight === name) wave.setHighlight(null);
  else wave.setHighlight(name);
};

wave.onContextMenu = (e, info) => {
  const items = [
    {
      label: "Fit view",
      action: () => wave.fit(),
    },
    {
      label: "Set cursor A here",
      disabled: info.t == null,
      action: () => wave.setCursorT(info.t, "A"),
    },
    {
      label: "Set cursor B here",
      disabled: info.t == null,
      action: () => wave.setCursorT(info.t, "B"),
    },
    {
      label: "Clear cursors",
      disabled: wave.cursorA == null && wave.cursorB == null,
      action: () => wave.clearCursors(),
    },
    { sep: true },
    {
      label: "Center on A (→A)",
      disabled: wave.cursorA == null,
      action: () => wave.gotoCursor("A"),
    },
    {
      label: "Center on B (→B)",
      disabled: wave.cursorB == null,
      action: () => wave.gotoCursor("B"),
    },
  ];
  if (info.legendName) {
    items.push({ sep: true });
    items.push({
      label:
        wave.highlight === info.legendName
          ? `Clear highlight (${info.legendName})`
          : `Highlight ${info.legendName}`,
      action: () => {
        if (wave.highlight === info.legendName) wave.setHighlight(null);
        else wave.setHighlight(info.legendName);
      },
    });
    items.push({
      label: `Hide ${info.legendName}`,
      action: () => togglePlotSignal(info.legendName),
    });
  }
  showContextMenu(e.clientX, e.clientY, items);
};

btnPng?.addEventListener("click", () => {
  if (!lastResult?.times?.length) return;
  wave.exportPng();
  log("Downloaded waveform PNG", "ok");
});

btnReset?.addEventListener("click", () => {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem("spice-golden");
  } catch {
    /* */
  }
  goldenResult = null;
  lastResult = null;
  lastTranResult = null;
  netlistEl.value = EXAMPLE_RC;
  engineType.value = "js";
  analysisType.value = "auto";
  adaptiveEl.checked = false;
  if (logYEl) {
    logYEl.checked = false;
    delete logYEl.dataset.userSet;
  }
  if (xyModeEl) xyModeEl.checked = false;
  tstopEl.value = "5m";
  tstepEl.value = "10u";
  btnCsv.disabled = true;
  btnVcd.disabled = true;
  if (btnPng) btnPng.disabled = true;
  btnGolden.disabled = true;
  btnDiff.disabled = true;
  if (btnFft) btnFft.disabled = true;
  wave.setData([], {}, [], { xyMode: false, yScale: "lin" });
  if (plotSelect) plotSelect.innerHTML = "";
  syncSignalListFromSelect();
  resultsEl.innerHTML = `<p class="muted">Run a simulation for DC / .meas / golden diff.</p>`;
  setDock("console");
  scheduleSave();
  log("Reset to default example (cleared local save + golden)", "ok");
  setStatus("Ready");
});

const helpModal = document.getElementById("help-modal");
function openHelp() {
  if (!helpModal) return;
  helpModal.hidden = false;
}
function closeHelp() {
  if (!helpModal) return;
  helpModal.hidden = true;
}
document.getElementById("btn-help")?.addEventListener("click", openHelp);
document.getElementById("btn-help-close")?.addEventListener("click", closeHelp);
helpModal?.querySelector("[data-close-help]")?.addEventListener("click", closeHelp);

function loadExample() {
  const i = EXAMPLES.findIndex((c) => c.trim() === netlistEl.value.trim());
  netlistEl.value = EXAMPLES[(i + 1) % EXAMPLES.length];
  log("Loaded example netlist");
  scheduleSave();
  if (schematic.isVisible()) {
    try {
      schematic.fromNetlist(netlistEl.value);
    } catch {
      /* */
    }
  }
}

function saveNetlist() {
  const name = (netlistFileName || "circuit.cir").replace(/[^\w.\-]+/g, "_");
  downloadText(name.endsWith(".cir") || name.includes(".") ? name : `${name}.cir`, netlistEl.value);
  log(`Saved ${name}`, "ok");
}

async function openNetlistFile(file) {
  if (!file) return;
  const text = await file.text();
  netlistEl.value = text;
  netlistFileName = file.name || "circuit.cir";
  log(`Opened ${netlistFileName}`);
  scheduleSave();
  if (schematic.isVisible()) {
    try {
      schematic.fromNetlist(netlistEl.value);
    } catch {
      /* */
    }
  }
}

let netlistFileName = "circuit.cir";

btnSave?.addEventListener("click", () => saveNetlist());
openNetlistEl?.addEventListener("change", async () => {
  const f = openNetlistEl.files?.[0];
  await openNetlistFile(f);
  openNetlistEl.value = "";
});

document.getElementById("btn-example").addEventListener("click", () => loadExample());

const palette = new CommandPalette({
  commands: () => [
    { id: "run", label: "Run simulation", hint: "F5", run: () => run() },
    { id: "stop", label: "Stop", run: () => abortCtrl?.abort() },
    { id: "example", label: "Next example", run: () => loadExample() },
    { id: "open", label: "Open netlist…", hint: "Ctrl+O", run: () => openNetlistEl?.click() },
    { id: "save", label: "Save netlist", hint: "Ctrl+S", run: () => saveNetlist() },
    { id: "fit", label: "Fit waveform", run: () => wave.fit() },
    {
      id: "logy",
      label: "Toggle log Y axis",
      run: () => {
        if (!logYEl) return;
        logYEl.checked = !logYEl.checked;
        logYEl.dataset.userSet = "1";
        wave.setYScale(logYEl.checked ? "log" : "lin");
        scheduleSave();
      },
    },
    {
      id: "xy",
      label: "Toggle XY plot mode",
      run: () => {
        if (!xyModeEl) return;
        xyModeEl.checked = !xyModeEl.checked;
        wave.setXyMode(xyModeEl.checked);
        scheduleSave();
      },
    },
    { id: "fft", label: "FFT of last TRAN", run: () => btnFft?.click() },
    { id: "csv", label: "Export CSV", run: () => btnCsv.click() },
    { id: "vcd", label: "Export VCD", run: () => btnVcd.click() },
    { id: "png", label: "Export PNG", run: () => btnPng?.click() },
    { id: "golden", label: "Set golden", run: () => btnGolden.click() },
    { id: "diff", label: "Diff vs golden", run: () => btnDiff.click() },
    { id: "netlist", label: "Show netlist editor", run: () => showEditorTab("netlist") },
    { id: "schematic", label: "Show schematic", run: () => showEditorTab("schematic") },
    { id: "help", label: "Help", hint: "F1", run: () => openHelp() },
    { id: "clear", label: "Clear console", run: () => { consoleEl.textContent = ""; } },
    { id: "reset", label: "Reset UI state", run: () => btnReset?.click() },
  ],
});

window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    palette.toggle();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    saveNetlist();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
    e.preventDefault();
    openNetlistEl?.click();
    return;
  }
  if (e.key === "F1" || (e.key === "?" && !e.ctrlKey && !e.metaKey && !e.altKey)) {
    const tag = (e.target && e.target.tagName) || "";
    if (tag === "TEXTAREA" || tag === "INPUT") return;
    e.preventDefault();
    if (helpModal && !helpModal.hidden) closeHelp();
    else openHelp();
  } else if (e.key === "Escape") {
    if (palette.open) {
      e.preventDefault();
      palette.close();
    } else if (helpModal && !helpModal.hidden) {
      e.preventDefault();
      closeHelp();
    }
  }
});


function showEditorTab(which) {
  const net = which === "netlist";
  tabNetlist.classList.toggle("active", net);
  tabSchematic.classList.toggle("active", !net);
  tabNetlist.setAttribute("aria-selected", String(net));
  tabSchematic.setAttribute("aria-selected", String(!net));
  if (netlistWrap) netlistWrap.hidden = !net;
  netlistEl.hidden = !net;
  schematic.setVisible(!net);
  if (!net && schematic.components.length === 0 && netlistEl.value.trim()) {
    try {
      schematic.fromNetlist(netlistEl.value);
    } catch {
      /* ignore parse errors */
    }
  }
  if (net) syncNetlistGutter();
  if (editorHint) {
    editorHint.textContent = net
      ? "*.cir · .tran / .dc / .ac · click .meas → cursor"
      : "Ctrl+click pin → plot · hotkeys 1–9 · zoom/pan";
  }
}

function syncNetlistGutter(errLine = null) {
  if (!netlistGutter || !netlistEl) return;
  const n = Math.max(1, netlistEl.value.split(/\r?\n/).length);
  const parts = [];
  for (let i = 1; i <= n; i++) {
    if (errLine != null && i === errLine) {
      parts.push(`<span class="err-line">${i}</span>`);
    } else {
      parts.push(String(i));
    }
  }
  netlistGutter.innerHTML = parts.join("\n");
  netlistGutter.scrollTop = netlistEl.scrollTop;
}

function jumpToErrorLine(msg) {
  const m = /\(line\s+(\d+)\)/i.exec(String(msg || ""));
  if (!m) return;
  const lineNo = Number(m[1]);
  if (!(lineNo >= 1)) return;
  showEditorTab("netlist");
  const text = netlistEl.value;
  const lines = text.split(/\r?\n/);
  let start = 0;
  for (let i = 0; i < lineNo - 1 && i < lines.length; i++) {
    start += lines[i].length + 1;
  }
  const end = start + (lines[lineNo - 1]?.length || 0);
  netlistEl.focus();
  netlistEl.setSelectionRange(start, end);
  // Scroll roughly into view
  const lineHeight = 1.45 * 0.85 * 16; // matches CSS rem-ish
  netlistEl.scrollTop = Math.max(0, (lineNo - 3) * lineHeight);
  syncNetlistGutter(lineNo);
}

tabNetlist.addEventListener("click", () => showEditorTab("netlist"));
tabSchematic.addEventListener("click", () => showEditorTab("schematic"));

document.getElementById("btn-clear-log").addEventListener("click", () => {
  consoleEl.textContent = "";
});

btnFft?.addEventListener("click", () => {
  if (!lastTranResult?.times?.length) {
    log("FFT needs a TRAN result first", "warn");
    return;
  }
  try {
    const selected = selectedPlotSignals();
    const prefer = selected.filter((n) => lastTranResult.series[n]);
    const spec = spectrumFromTransient(
      lastTranResult.times,
      lastTranResult.series,
      prefer.length ? prefer : undefined
    );
    applyPlot(spec, Object.keys(spec.series));
    log(`FFT ${spec.nfft}-pt · fs=${formatEng(spec.fs, 3)}Hz`, "ok");
    setStatus("FFT");
  } catch (e) {
    log(String(e.message || e), "err");
  }
});

plotSelect.addEventListener("change", () => {
  if (!lastResult) return;
  syncSignalListFromSelect();
  wave.setData(
    lastResult.times,
    lastResult.series,
    selectedPlotSignals(),
    wavePlotOpts(lastResult)
  );
});

logYEl?.addEventListener("change", () => {
  logYEl.dataset.userSet = "1";
  wave.setYScale(logYEl.checked ? "log" : "lin");
  scheduleSave();
});

xyModeEl?.addEventListener("change", () => {
  wave.setXyMode(xyModeEl.checked);
  scheduleSave();
});

btnStop.addEventListener("click", () => abortCtrl?.abort());
btnRun.addEventListener("click", () => run());
btnCsv.addEventListener("click", () => {
  if (!lastResult) return;
  const csv = resultToCsv(lastResult);
  downloadCsv(`spice-${Date.now()}.csv`, csv);
  log("Downloaded CSV", "ok");
});

btnVcd.addEventListener("click", () => {
  if (!lastResult?.times?.length) return;
  if (lastResult.xUnit === "Hz") {
    log("VCD is for TRAN time-domain results", "warn");
    return;
  }
  const vcd = resultToVcd(lastResult);
  downloadText(`spice-${Date.now()}.vcd`, vcd);
  log("Downloaded VCD (voltages as µV integers)", "ok");
});

btnGolden.addEventListener("click", () => {
  if (!lastResult?.times?.length) return;
  goldenResult = cloneResult(lastResult);
  try {
    localStorage.setItem("spice-golden", JSON.stringify(goldenResult));
  } catch {
    /* quota */
  }
  btnDiff.disabled = false;
  wave.setGolden(goldenResult);
  log(`Golden stored (${Object.keys(goldenResult.series).length} signals)`, "ok");
});

btnDiff.addEventListener("click", () => {
  if (!lastResult || !goldenResult) return;
  const diff = diffAgainstGolden(lastResult, goldenResult);
  if (!diff.ok) {
    log(diff.error, "warn");
    return;
  }
  showMeasuresAndDiff([], diff);
  for (const r of diff.rows) {
    log(`diff ${r.name}: max|e|=${formatEng(r.maxAbs, 4)} rms=${formatEng(r.rms, 4)}`, "ok");
  }
  log(`worst ${diff.worstName} max|e|=${formatEng(diff.worst, 4)}`, "ok");
});

libFilesEl?.addEventListener("change", async () => {
  const files = [...(libFilesEl.files || [])];
  for (const f of files) {
    const text = await f.text();
    libraryFiles.set(f.name, text);
    libraryFiles.set(`lib/${f.name}`, text);
    log(`Library + ${f.name} (${text.length} chars)`);
  }
  libFilesEl.value = "";
});

try {
  const raw = localStorage.getItem("spice-golden");
  if (raw) {
    goldenResult = JSON.parse(raw);
    btnDiff.disabled = false;
  }
} catch {
  /* */
}

fetch("./lib/models.cir")
  .then((r) => (r.ok ? r.text() : null))
  .then((t) => {
    if (!t) return;
    libraryFiles.set("lib/models.cir", t);
    libraryFiles.set("models.cir", t);
  })
  .catch(() => {});

window.addEventListener("keydown", (e) => {
  if (e.key === "F5") {
    e.preventDefault();
    run();
  }
});

function showDcResults(nodes, currents, iterations, extraHtml = "") {
  const rows = [
    ...Object.entries(nodes || {}).map(
      ([n, v]) => `<tr><td>v(${n})</td><td>${formatEng(v, 5)} V</td></tr>`
    ),
    ...Object.entries(currents || {}).map(
      ([n, v]) => `<tr><td>i(${n})</td><td>${formatEng(v, 5)} A</td></tr>`
    ),
  ];
  resultsEl.innerHTML = `
    <p class="muted">Converged in ${iterations} NR iteration(s)</p>
    ${extraHtml}
    <table>
      <thead><tr><th>Signal</th><th>Value</th></tr></thead>
      <tbody>${rows.join("") || "<tr><td colspan=2 class=muted>No node table</td></tr>"}</tbody>
    </table>
  `;
}

function showMeasuresAndDiff(measures, diff, prependHtml = "", fourier = []) {
  const blocks = [prependHtml];
  if (measures?.length) {
    const rows = measures
      .map((m) => {
        if (!m.ok) {
          return `<tr><td>${esc(m.name)}</td><td class="err">${esc(m.error)}</td></tr>`;
        }
        const clickable = Number.isFinite(m.markT);
        const td = clickable
          ? `<td><button type="button" class="meas-jump" data-t="${m.markT}" title="Place cursor A at this time">${formatEng(m.value, 5)}</button></td>`
          : `<td>${formatEng(m.value, 5)}</td>`;
        return `<tr><td>${esc(m.name)}</td>${td}</tr>`;
      })
      .join("");
    blocks.push(`
      <h3 class="subhead">.measure</h3>
      <table>
        <thead><tr><th>Name</th><th>Value</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `);
  }
  if (fourier?.length) {
    for (const f of fourier) {
      if (f.error) {
        blocks.push(`
          <h3 class="subhead">.four ${esc(f.signal)}</h3>
          <p class="err">${esc(f.error)}</p>
        `);
        continue;
      }
      const rows = (f.harmonics || [])
        .map(
          (h) =>
            `<tr><td>${h.n}</td><td>${formatEng(h.freq, 4)}</td><td>${formatEng(h.mag, 5)}</td><td>${formatEng(h.phaseDeg, 3)}°</td></tr>`
        )
        .join("");
      blocks.push(`
        <h3 class="subhead">.four ${esc(f.signal)} @ ${formatEng(f.freq, 4)}Hz</h3>
        <p class="muted">THD=${formatEng(f.thd * 100, 3)}% · window ${formatEng(f.tStart, 3)}–${formatEng(f.tEnd, 3)}s</p>
        <table>
          <thead><tr><th>n</th><th>f</th><th>|c|</th><th>phase</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      `);
    }
  }
  if (diff?.ok) {
    const rows = diff.rows
      .map(
        (r) =>
          `<tr><td>${esc(r.name)}</td><td>${formatEng(r.maxAbs, 4)}</td><td>${formatEng(r.rms, 4)}</td></tr>`
      )
      .join("");
    blocks.push(`
      <h3 class="subhead">Golden diff</h3>
      <p class="muted">worst ${esc(diff.worstName)} max|e|=${formatEng(diff.worst, 4)}</p>
      <table>
        <thead><tr><th>Signal</th><th>max|e|</th><th>rms</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `);
  }
  const html = blocks.filter(Boolean).join("");
  if (html) resultsEl.innerHTML = html;
}

resultsEl.addEventListener("click", (e) => {
  const btn = e.target.closest?.(".meas-jump");
  if (!btn) return;
  const t = Number(btn.dataset.t);
  if (!Number.isFinite(t)) return;
  wave.setCursorT(t, "A");
  log(`cursor A → ${formatEng(t, 5)}${wave.xUnit || "s"}`, "ok");
});

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fillPlotSelect(series, prefer = []) {
  const names = Object.keys(series);
  const preferred = matchSeriesNames(series, prefer);
  const rest = names.filter((n) => !preferred.includes(n));
  const ordered = [...preferred, ...rest];
  const nSel = Math.max(1, Math.min(3, preferred.length || 3));
  plotSelect.innerHTML = ordered
    .map(
      (n, i) =>
        `<option value="${n}" ${i < nSel ? "selected" : ""}>${n}</option>`
    )
    .join("");
  syncSignalListFromSelect();
}

function dedupeNames(arr) {
  const out = [];
  const seen = new Set();
  for (const n of arr) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

function resolveType(circuit, uiType) {
  if (uiType === "auto") return circuit.analysis.type || "tran";
  return uiType;
}

function applyPlot(result, prefer = []) {
  lastResult = result;
  const isTimeWave =
    result?.times?.length > 2 &&
    result.xUnit !== "Hz" &&
    result.analysis !== "fft" &&
    result.analysis !== "dc" &&
    result.analysis !== "ac" &&
    result.analysis !== "noise" &&
    result.analysis !== "disto" &&
    result.analysis !== "pz" &&
    result.analysis !== "mc";
  if (result?.analysis === "tran" || isTimeWave) lastTranResult = result;

  btnCsv.disabled = !result?.times?.length;
  btnVcd.disabled =
    !result?.times?.length ||
    result.xUnit === "Hz" ||
    result.analysis === "dc" ||
    result.analysis === "ac" ||
    result.analysis === "noise" ||
    result.analysis === "disto" ||
    result.analysis === "pz" ||
    result.analysis === "mc" ||
    result.analysis === "tf";
  if (btnPng) btnPng.disabled = !result?.times?.length;
  btnGolden.disabled = !result?.times?.length || result.analysis === "fft";
  btnDiff.disabled = !goldenResult;
  if (btnFft) btnFft.disabled = !lastTranResult?.times?.length;
  const printed = parsePrint(lastSourceText || netlistEl.value, result.analysis);
  const preferMerged = dedupeNames([
    ...matchSeriesNames(result.series, printed),
    ...matchSeriesNames(result.series, prefer),
  ]);
  fillPlotSelect(result.series, preferMerged);
  // Noise density is almost always better on a log Y axis
  if (result.analysis === "noise" && logYEl && !logYEl.dataset.userSet) {
    logYEl.checked = true;
  }
  // Lissajous / parametric: auto XY when netlist says so
  if (xyModeEl && /\bXY\b|Lissajous/i.test(lastSourceText || netlistEl.value)) {
    xyModeEl.checked = true;
  }
  wave.setData(
    result.times,
    result.series,
    selectedPlotSignals(),
    wavePlotOpts(result)
  );

  let prepend = "";
  if (result.step) {
    prepend += `<p class="muted">.step ${result.step.param}: ${result.step.values.length} points</p>`;
  }
  if (result.dc) {
    prepend = `
      <p class="muted">Converged in ${result.dc.iterations} NR iteration(s)</p>
    `;
    if (result.analysis === "noise") {
      prepend += `<p class="muted">T=${result.tempC}°C · ∫onoise=${formatEng(result.totalOnoise, 4)} Vrms`;
      if (result.totalInoise != null) {
        prepend += ` · ∫inoise=${formatEng(result.totalInoise, 4)} Vrms`;
      }
      prepend += ` (${formatEng(result.times[0])}–${formatEng(result.times[result.times.length - 1])} Hz)</p>`;
    }
    if (result.analysis === "tf") {
      prepend += `
        <h3 class="subhead">.tf</h3>
        <table>
          <thead><tr><th>Quantity</th><th>Value</th></tr></thead>
          <tbody>
            <tr><td>Transfer V(${result.outNode}${result.refNode !== "0" ? "," + result.refNode : ""})/${result.srcName}</td><td>${formatEng(result.transfer, 5)}</td></tr>
            <tr><td>Input impedance</td><td>${formatEng(result.zin, 5)} Ω</td></tr>
            <tr><td>Output impedance</td><td>${formatEng(result.zout, 5)} Ω</td></tr>
          </tbody>
        </table>
      `;
    }
    const rows = [
      ...Object.entries(result.dc.nodes || {}).map(
        ([n, v]) => `<tr><td>v(${n})</td><td>${formatEng(v, 5)} V</td></tr>`
      ),
      ...Object.entries(result.dc.currents || {}).map(
        ([n, v]) => `<tr><td>i(${n})</td><td>${formatEng(v, 5)} A</td></tr>`
      ),
    ];
    prepend += `
      <table>
        <thead><tr><th>Signal</th><th>Value</th></tr></thead>
        <tbody>${rows.join("") || "<tr><td colspan=2 class=muted>No node table</td></tr>"}</tbody>
      </table>
    `;
  }

  if (result.analysis === "pz" && result.poles?.length) {
    const rows = result.poles
      .slice(0, 24)
      .map((p) => {
        const im =
          Math.abs(p.im) < 1e-18
            ? "0"
            : `${p.im >= 0 ? "+" : ""}${formatEng(p.im, 4)}`;
        return `<tr><td>${formatEng(p.re, 4)} ${im}j</td><td>${formatEng(p.fHz, 4)} Hz</td><td>${p.Q != null ? formatEng(p.Q, 3) : "—"}</td></tr>`;
      })
      .join("");
    prepend += `
      <h3 class="subhead">.pz poles</h3>
      <table>
        <thead><tr><th>s (rad/s)</th><th>|Im|/(2π)</th><th>Q</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  if (result.analysis === "mc" && result.stats) {
    const rows = Object.entries(result.stats)
      .map(
        ([k, st]) =>
          `<tr><td>${esc(k)}</td><td>${formatEng(st.mean, 4)}</td><td>${formatEng(st.std, 4)}</td><td>${formatEng(st.min, 3)}…${formatEng(st.max, 3)}</td></tr>`
      )
      .join("");
    prepend += `
      <h3 class="subhead">.mc stats (${result.points} runs)</h3>
      <table>
        <thead><tr><th>Signal</th><th>μ</th><th>σ</th><th>min…max</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  let measures = [];
  try {
    const specs = parseMeasures(lastSourceText || netlistEl.value);
    measures = evalMeasures(specs, result, lastAnalysis || result.analysis);
    for (const m of measures) {
      if (m.ok) log(`.meas ${m.name} = ${formatEng(m.value, 5)}`, "ok");
      else log(`.meas ${m.name}: ${m.error}`, "warn");
    }
    const marks = [];
    for (const m of measures) {
      if (!m.ok) continue;
      if (Number.isFinite(m.markT2)) {
        marks.push({
          t: m.markT2,
          label: `${m.name}:trig`,
          color: "#e6a05c",
        });
      }
      if (Number.isFinite(m.markT)) {
        marks.push({
          t: m.markT,
          label: m.type === "TRIG" ? `${m.name}:targ` : m.name,
          color: m.type === "TRIG" ? "#6ea8fe" : "#c9a0dc",
        });
      }
    }
    if (marks.length && (result.analysis === "tran" || result.xUnit === "s")) {
      wave.setMarkers(marks);
    }
  } catch (e) {
    log(String(e.message || e), "warn");
  }

  let fourier = [];
  const isTranLike =
    result?.analysis === "tran" ||
    (result?.xUnit === "s" && result?.times?.length > 2 && !result.step);
  if (isTranLike) {
    try {
      const specs = parseFours(lastSourceText || netlistEl.value);
      if (specs.length) {
        fourier = evalFourier(result, specs);
        for (const f of fourier) {
          if (f.error) log(`.four ${f.signal}: ${f.error}`, "warn");
          else {
            log(
              `.four ${f.signal} f0=${formatEng(f.freq, 4)}Hz THD=${formatEng(f.thd * 100, 3)}%  |c1|=${formatEng(f.harmonics[1]?.mag, 4)}`,
              "ok"
            );
          }
        }
      }
    } catch (e) {
      log(String(e.message || e), "warn");
    }
  }

  let diff = null;
  if (goldenResult && result?.times?.length) {
    diff = diffAgainstGolden(result, goldenResult);
  }
  showMeasuresAndDiff(measures, diff, prepend, fourier);
  setDock("results");
}

async function run() {
  if (abortCtrl) abortCtrl.abort();
  abortCtrl = new AbortController();

  btnRun.disabled = true;
  btnStop.disabled = false;
  setStatus("Running…", "busy");

  try {
    const engine = engineType.value;
    await new Promise((r) => setTimeout(r, 0));
    const t0 = performance.now();

    const source = await expandIncludes(netlistEl.value, { files: libraryFiles });
    lastSourceText = source;
    if (source !== netlistEl.value) {
      log("Expanded .include");
    }

    if (engine === "ngspice") {
      const result = await runNgspice(source, {
        onLog: (m, cls) => log(m, cls),
        signal: abortCtrl.signal,
      });
      lastAnalysis = result.analysis || (result.xUnit === "Hz" ? "ac" : "tran");
      const ms = (performance.now() - t0).toFixed(1);
      const prefer = Object.keys(result.series).filter(
        (n) => n.includes("out") || n.startsWith("db(")
      );
      applyPlot(result, prefer);
      log(`ngspice done in ${ms} ms · ${result.points} pts`, "ok");
      setStatus(`ngspice · ${ms} ms`);
      return;
    }

    const step = parseSteps(source);
    if (step && step.values.length > 1) {
      log(`.step ${step.param}: ${step.values.length} values`);
      const runs = [];
      for (let i = 0; i < step.values.length; i++) {
        if (abortCtrl.signal.aborted) break;
        const val = step.values[i];
        const label = formatStepLabel(val);
        setStatus(`.step ${step.param}=${label} (${i + 1}/${step.values.length})`);
        const stepped = applyStepParam(source, step.param, val);
        const one = await runJsOnce(stepped, { quiet: true });
        runs.push({ label, val, result: one });
        log(`.step ${step.param}=${label} ok`, "ok");
      }
      const merged = mergeStepRuns(runs, step.param);
      lastAnalysis = merged.analysis;
      lastSourceText = source;
      applyPlot(merged, merged.prefer || []);
      const ms = (performance.now() - t0).toFixed(1);
      log(`.step done: ${runs.length} runs, ${ms} ms`, "ok");
      setStatus(`.step · ${ms} ms`);
      return;
    }

    const one = await runJsOnce(source, { quiet: false, t0 });
    applyPlot(one.result, one.prefer || []);
  } catch (err) {
    console.error(err);
    const msg = String(err.message || err);
    log(msg, "err");
    setStatus("Error", "err");
    jumpToErrorLine(msg);
  } finally {
    btnRun.disabled = false;
    btnStop.disabled = true;
    abortCtrl = null;
  }
}

/**
 * Run one JS-engine analysis. Returns { result, prefer, analysis }.
 */
async function runJsOnce(source, { quiet = false, t0 = performance.now() } = {}) {
  const circuit = parseNetlist(source);
  if (!quiet) {
    log(`Parsed ${circuit.devices.length} device(s), nodes: ${circuit.nodes.join(", ")}`);
  }

  const type = resolveType(circuit, analysisType.value);
  lastAnalysis = type;
  let tstep = circuit.analysis.tstep;
  let tstop = circuit.analysis.tstop;
  try {
    if (tstepEl.value.trim()) tstep = parseNumber(tstepEl.value);
    if (tstopEl.value.trim()) tstop = parseNumber(tstopEl.value);
  } catch {
    /* keep netlist */
  }
  const adaptive = adaptiveEl.checked || circuit.analysis.adaptive;

  if (type === "dc") {
    const result = dcAnalysis(circuit, {
      signal: abortCtrl?.signal,
      onProgress: quiet
        ? undefined
        : (p) => setStatus(`DC ${(p * 100).toFixed(0)}%`),
    });
    const ms = (performance.now() - t0).toFixed(1);
    if (!quiet) {
      if (result.sweep) {
        const nest = result.nested
          ? ` × ${result.sweep.nested.src} (${result.outerPoints})`
          : "";
        log(
          `DC sweep ${result.sweep.src}${nest}: ${result.points} pts, ${ms} ms`,
          result.aborted ? "warn" : "ok"
        );
      } else {
        log(`DC operating point done in ${ms} ms`, "ok");
      }
      setStatus(`DC · ${ms} ms`);
    }
    let prefer = [];
    if (result.sweep) {
      const keys = Object.keys(result.series);
      prefer = keys.filter((n) => n.startsWith("i(")).slice(0, result.nested ? 6 : 2);
      if (!prefer.length) prefer = keys.slice(0, result.nested ? 4 : 2);
    }
    return { result, prefer, analysis: "dc" };
  }

  if (type === "ac") {
    if (circuit.analysis.type !== "ac") {
      throw new Error("Select a netlist with .ac, or add e.g. .ac dec 20 1 1Meg");
    }
    const result = acAnalysis(circuit, {
      signal: abortCtrl.signal,
      onProgress: quiet ? undefined : (p) => setStatus(`AC ${(p * 100).toFixed(0)}%`),
    });
    const ms = (performance.now() - t0).toFixed(1);
    if (!quiet) {
      log(`AC done: ${result.points} freqs, ${ms} ms`, "ok");
      setStatus(`AC · ${ms} ms`);
    }
    return {
      result: { ...result, analysis: "ac" },
      prefer: ["db(v(out))", "ph(v(out))"],
      analysis: "ac",
    };
  }

  if (type === "disto") {
    if (circuit.analysis.type !== "disto") {
      throw new Error("Select a netlist with .disto, e.g. .disto V(out) dec 5 1k 100k");
    }
    const result = distoAnalysis(circuit, {
      signal: abortCtrl.signal,
      onProgress: quiet ? undefined : (p) => setStatus(`DISTO ${(p * 100).toFixed(0)}%`),
    });
    const ms = (performance.now() - t0).toFixed(1);
    if (!quiet) {
      log(`DISTO done: ${result.points} freqs, ${ms} ms`, "ok");
      setStatus(`DISTO · ${ms} ms`);
    }
    return {
      result: { ...result, analysis: "disto" },
      prefer: ["thd", "hd2", "hd3"],
      analysis: "disto",
    };
  }

  if (type === "pz") {
    if (circuit.analysis.type !== "pz") {
      throw new Error("Select a netlist with .pz, e.g. .pz V(out)");
    }
    const result = pzAnalysis(circuit);
    const ms = (performance.now() - t0).toFixed(1);
    if (!quiet) {
      log(`PZ: ${result.poles.length} pole(s), ${ms} ms`, "ok");
      for (const p of result.poles.slice(0, 8)) {
        const im = p.im === 0 ? "" : ` ${p.im >= 0 ? "+" : ""}j${formatEng(p.im, 4)}`;
        log(`  pole ${formatEng(p.re, 4)}${im}  (f≈${formatEng(p.fHz, 4)}Hz)`, "ok");
      }
      setStatus(`PZ · ${ms} ms`);
    }
    return { result, prefer: [], analysis: "pz" };
  }

  if (type === "mc") {
    if (circuit.analysis.type !== "mc") {
      throw new Error("Select a netlist with .mc, e.g. .mc 40 seed=1 (and lot= on R/C/L)");
    }
    const result = mcAnalysis(circuit, {
      signal: abortCtrl.signal,
      onProgress: quiet ? undefined : (p) => setStatus(`MC ${(p * 100).toFixed(0)}%`),
    });
    const ms = (performance.now() - t0).toFixed(1);
    if (!quiet) {
      log(`MC: ${result.points}/${result.runs} runs (failed ${result.failed}), ${ms} ms`, "ok");
      for (const [k, st] of Object.entries(result.stats || {})) {
        log(
          `  ${k}: μ=${formatEng(st.mean, 4)} σ=${formatEng(st.std, 4)} [${formatEng(st.min, 3)}, ${formatEng(st.max, 3)}]`,
          "ok"
        );
      }
      setStatus(`MC · ${ms} ms`);
    }
    return {
      result: { ...result, analysis: "mc" },
      prefer: Object.keys(result.series).slice(0, 4),
      analysis: "mc",
    };
  }

  if (type === "noise") {
    if (circuit.analysis.type !== "noise") {
      throw new Error("Select a netlist with .noise, e.g. .noise V(out) V1 dec 20 1 1Meg");
    }
    const result = noiseAnalysis(circuit, {
      signal: abortCtrl.signal,
      onProgress: quiet ? undefined : (p) => setStatus(`NOISE ${(p * 100).toFixed(0)}%`),
    });
    const ms = (performance.now() - t0).toFixed(1);
    if (!quiet) {
      const o0 = result.series.onoise?.[0];
      log(
        `NOISE done: ${result.points} freqs, onoise(f0)=${formatEng(o0, 4)} V/√Hz, ${ms} ms`,
        "ok"
      );
      setStatus(`NOISE · ${ms} ms`);
    }
    return { result: { ...result, analysis: "noise" }, prefer: ["onoise", "inoise"], analysis: "noise" };
  }

  if (type === "tf") {
    if (circuit.analysis.type !== "tf") {
      throw new Error("Select a netlist with .tf, e.g. .tf V(out) V1");
    }
    const result = tfAnalysis(circuit);
    const ms = (performance.now() - t0).toFixed(1);
    if (!quiet) {
      log(
        `TF: transfer=${formatEng(result.transfer, 5)}  Zin=${formatEng(result.zin, 4)}Ω  Zout=${formatEng(result.zout, 4)}Ω  (${ms} ms)`,
        "ok"
      );
      setStatus(`TF · ${ms} ms`);
    }
    return { result, prefer: ["tf", "zin", "zout"], analysis: "tf" };
  }

  // TRAN
  const result = transient(circuit, {
    tstep,
    tstop,
    tmax: circuit.analysis.tmax,
    adaptive,
    signal: abortCtrl.signal,
    onProgress: quiet ? undefined : (p) => setStatus(`TRAN ${(p * 100).toFixed(0)}%`),
  });
  const ms = (performance.now() - t0).toFixed(1);
  if (!quiet) {
    if (result.aborted) {
      log("Stopped by user", "warn");
      setStatus("Stopped");
    } else {
      const mode = result.adaptive ? "adaptive" : result.method;
      log(
        `TRAN (${mode}): ${result.steps} steps, tstop=${formatEng(tstop)}s, ${ms} ms`,
        "ok"
      );
      setStatus(`TRAN · ${ms} ms`);
    }
  }
  return {
    result: { ...result, xScale: "lin", xUnit: "s", analysis: "tran" },
    prefer: [],
    analysis: "tran",
  };
}

function mergeStepRuns(runs, paramName) {
  if (!runs.length) throw new Error(".step produced no runs");
  const analysis = runs[0].result.analysis;
  const prefer = [];

  // DC / TF: x-axis = stepped parameter
  if (analysis === "dc" || analysis === "tf") {
    const times = runs.map((r) => r.val);
    const series = {};
    if (analysis === "tf") {
      series.tf = runs.map((r) => r.result.transfer);
      series.zin = runs.map((r) => r.result.zin);
      series.zout = runs.map((r) => r.result.zout);
      prefer.push("tf");
    } else {
      const names = new Set();
      for (const r of runs) {
        for (const k of Object.keys(r.result.series || {})) names.add(k);
      }
      for (const name of names) {
        series[name] = runs.map((r) => r.result.series[name]?.[0] ?? NaN);
      }
      prefer.push(...[...names].filter((n) => n.includes("out")).slice(0, 3));
    }
    return {
      times,
      series,
      xScale: "lin",
      xUnit: paramName,
      analysis,
      prefer,
      step: { param: paramName, values: times },
      dc: runs[0].result.dc,
    };
  }

  // TRAN / AC / NOISE: overlay curves on first axis
  const base = runs[0].result;
  const times = base.times;
  const series = {};
  const keySet = new Set();
  for (const r of runs) {
    for (const k of Object.keys(r.result.series || {})) {
      if (k.startsWith("ph(")) continue; // keep plots readable
      keySet.add(k);
    }
  }
  // Prefer a few signals
  const keys = [...keySet].filter((k) => /out|onoise|inoise|^db\(/.test(k));
  const use = keys.length ? keys.slice(0, 2) : [...keySet].slice(0, 2);

  for (const r of runs) {
    for (const name of use) {
      const ys = r.result.series[name];
      if (!ys) continue;
      const key = `${name}@${r.label}`;
      series[key] =
        r.result.times === times || r.result.times?.length === times.length
          ? resampleSeries(r.result.times, ys, times)
          : resampleSeries(r.result.times, ys, times);
      prefer.push(key);
    }
  }

  return {
    times,
    series,
    xScale: base.xScale || "lin",
    xUnit: base.xUnit || "s",
    analysis,
    prefer,
    step: { param: paramName, values: runs.map((r) => r.val) },
    dc: base.dc,
    tempC: base.tempC,
    totalOnoise: base.totalOnoise,
    totalInoise: base.totalInoise,
  };
}

const STORAGE_KEY = "spice-simulator-ui";

function saveUiState() {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        netlist: netlistEl.value,
        engine: engineType.value,
        analysis: analysisType.value,
        adaptive: adaptiveEl.checked,
        logY: !!logYEl?.checked,
        xyMode: !!xyModeEl?.checked,
        tstop: tstopEl.value,
        tstep: tstepEl.value,
      })
    );
  } catch {
    /* quota */
  }
}

function loadUiState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (typeof s.netlist === "string" && s.netlist.trim()) netlistEl.value = s.netlist;
    if (s.engine) engineType.value = s.engine;
    if (s.analysis) analysisType.value = s.analysis;
    if (typeof s.adaptive === "boolean") adaptiveEl.checked = s.adaptive;
    if (typeof s.logY === "boolean" && logYEl) {
      logYEl.checked = s.logY;
      logYEl.dataset.userSet = "1";
    }
    if (typeof s.xyMode === "boolean" && xyModeEl) {
      xyModeEl.checked = s.xyMode;
    }
    if (s.tstop) tstopEl.value = s.tstop;
    if (s.tstep) tstepEl.value = s.tstep;
    return true;
  } catch {
    return false;
  }
}

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveUiState, 400);
}

netlistEl.addEventListener("input", () => {
  scheduleSave();
  syncNetlistGutter();
});
netlistEl.addEventListener("scroll", () => {
  if (netlistGutter) netlistGutter.scrollTop = netlistEl.scrollTop;
});
engineType.addEventListener("change", scheduleSave);
analysisType.addEventListener("change", scheduleSave);
adaptiveEl.addEventListener("change", scheduleSave);
tstopEl.addEventListener("change", scheduleSave);
tstepEl.addEventListener("change", scheduleSave);

if (!loadUiState()) {
  netlistEl.value = EXAMPLE_RC;
}
if (xyModeEl) wave.setXyMode(xyModeEl.checked);
if (logYEl) wave.setYScale(logYEl.checked ? "log" : "lin");
syncNetlistGutter();

log("SPICE — press ? or F1 for help · hover nets on schematic");
