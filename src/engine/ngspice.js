/**
 * ngspice WASM backend — loads @o.z/ngspice-wasm (vendored or CDN),
 * runs batch sims with -r rawfile, parses ASCII raw into our plot shape.
 * Prefers a module Worker; falls back to main-thread if Worker fails.
 */

const CDN_URL = "https://cdn.jsdelivr.net/npm/@o.z/ngspice-wasm@0.0.0/ngspice.js";
const LOCAL_URL = new URL("../../vendor/ngspice.js", import.meta.url).href;

/** Cache the factory import; instantiate a fresh Module each run (_main exits the runtime). */
let factoryPromise = null;

async function loadFactory() {
  if (factoryPromise) return factoryPromise;
  factoryPromise = (async () => {
    try {
      const mod = await import(LOCAL_URL);
      return mod.default;
    } catch {
      const mod = await import(/* @vite-ignore */ CDN_URL);
      return mod.default;
    }
  })();
  return factoryPromise;
}

export function ensureDir(ng, p) {
  let cur = "";
  for (const part of p.split("/").filter(Boolean)) {
    cur += "/" + part;
    try {
      ng.FS.mkdir(cur);
    } catch {
      /* exists */
    }
  }
}

export function prepFs(ng) {
  ensureDir(ng, "/proc/self");
  ensureDir(ng, "/usr/local/share/ngspice/scripts");
  ng.FS.writeFile(
    "/proc/meminfo",
    "MemTotal:       16777216 kB\nMemFree:        8388608 kB\nMemAvailable:   8388608 kB\n"
  );
  ng.FS.writeFile("/proc/self/statm", "0 0 0 0 0 0 0\n");
  ng.FS.writeFile(
    "/usr/local/share/ngspice/scripts/spinit",
    `set filetype=ascii
set ngbehavior=lt
`
  );
}

export function makeArgv(ng, args) {
  const ptrs = args.map((a) => ng.stringToUTF8OnStack(a));
  const argv = ng.stackAlloc((args.length + 1) * 4);
  for (let i = 0; i < ptrs.length; i++) ng.HEAP32[(argv >> 2) + i] = ptrs[i];
  ng.HEAP32[(argv >> 2) + ptrs.length] = 0;
  return { argc: args.length, argv };
}

export function ensureTitle(netlist) {
  const trimmed = netlist.trim();
  if (!trimmed) throw new Error("Empty netlist");
  const firstTok = trimmed.split(/\r?\n/)[0].trim().split(/\s+/)[0];
  if (/^[RCLVIDEFGM]\w*$/i.test(firstTok)) {
    return `spice-simulator\n${trimmed}`;
  }
  return trimmed;
}

/**
 * Read one real or complex cell starting at lines[i] with optional pre-trimmed first line body.
 * Complex: "re,im" on one line, or re then im on consecutive lines.
 */
function readCell(lines, i, firstBody, complex) {
  const body = firstBody != null ? firstBody : lines[i].trim();
  if (!complex) {
    return { value: parseFloat(body), next: i };
  }
  if (body.includes(",")) {
    const [reS, imS] = body.split(",");
    return { value: { re: parseFloat(reS), im: parseFloat(imS) }, next: i };
  }
  const parts = body.split(/\s+/).filter(Boolean);
  if (parts.length >= 2 && Number.isFinite(parseFloat(parts[0])) && Number.isFinite(parseFloat(parts[1]))) {
    return {
      value: { re: parseFloat(parts[0]), im: parseFloat(parts[1]) },
      next: i,
    };
  }
  const re = parseFloat(parts[0]);
  let j = i + 1;
  while (j < lines.length && !lines[j].trim()) j++;
  if (j >= lines.length) return { value: { re, im: 0 }, next: i };
  // New point lines typically start with an index at column 0 (no leading whitespace).
  if (/^\d/.test(lines[j]) && !/^\s/.test(lines[j])) {
    return { value: { re, im: 0 }, next: i };
  }
  const im = parseFloat(lines[j].trim());
  return { value: { re, im: Number.isFinite(im) ? im : 0 }, next: j };
}

function cellRe(c) {
  return c && typeof c === "object" ? c.re : c;
}

function cellMag(c) {
  if (c && typeof c === "object") return Math.hypot(c.re, c.im);
  return Math.abs(c ?? NaN);
}

function cellPhaseDeg(c) {
  if (c && typeof c === "object") return (Math.atan2(c.im, c.re) * 180) / Math.PI;
  return 0;
}

/** Parse ngspice ASCII rawfile into { times, series, meta }. */
export function parseAsciiRaw(text) {
  const lines = text.split(/\r?\n/);
  let nVars = 0;
  let nPoints = 0;
  let plotname = "";
  let flags = "";
  const varNames = [];
  let mode = "header";
  const columns = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (mode === "header") {
      if (/^Plotname:/i.test(line)) plotname = line.split(":").slice(1).join(":").trim();
      if (/^Flags:/i.test(line)) flags = line.split(":").slice(1).join(":").trim().toLowerCase();
      if (/^No\. Variables:/i.test(line)) nVars = parseInt(line.split(":").pop(), 10);
      if (/^No\. Points:/i.test(line)) nPoints = parseInt(line.split(":").pop(), 10);
      if (/^Variables:/i.test(line)) {
        mode = "vars";
        continue;
      }
      if (/^Values:/i.test(line)) {
        mode = "values";
        continue;
      }
      if (/^Binary:/i.test(line)) {
        throw new Error("Binary rawfile — set filetype=ascii in spinit");
      }
    } else if (mode === "vars") {
      if (/^Values:/i.test(line)) {
        mode = "values";
        continue;
      }
      if (/^Binary:/i.test(line)) throw new Error("Binary rawfile");
      const m = line.match(/^\s*\d+\s+(\S+)/);
      if (m) varNames.push(m[1].toLowerCase());
    } else if (mode === "values") {
      if (!line.trim()) continue;
      const complex = flags.includes("complex");
      // "0\t\t1.23" / "0\t\t1.23,0.0" / "0 1.23"
      const start = line.match(/^(\d+)(?:\s+(.*))?$/);
      if (!start) continue;
      const row = [];
      let j = i;
      const firstRest = (start[2] || "").trim();
      if (firstRest) {
        const cell = readCell(lines, j, firstRest, complex);
        row.push(cell.value);
        j = cell.next;
      }
      while (row.length < nVars) {
        j++;
        if (j >= lines.length) break;
        if (!lines[j].trim()) continue;
        // Un-indented index ⇒ next point
        if (row.length > 0 && /^\d/.test(lines[j]) && !/^\s/.test(lines[j])) {
          j--;
          break;
        }
        const cell = readCell(lines, j, lines[j].trim(), complex);
        row.push(cell.value);
        j = cell.next;
      }
      columns.push(row);
      i = j;
    }
  }

  if (!columns.length) throw new Error("Empty ngspice rawfile");

  const isComplex = flags.includes("complex");
  const series = {};
  let times = [];

  if (isComplex) {
    // var0 frequency: typically re=freq, im=0
    times = columns.map((r) => cellRe(r[0]));
    for (let v = 1; v < varNames.length; v++) {
      const name = normalizeVar(varNames[v]);
      const mags = columns.map((r) => cellMag(r[v]));
      series[name] = mags;
      series[`ph(${name})`] = columns.map((r) => cellPhaseDeg(r[v]));
      if (name.startsWith("v(")) {
        series[`db(${name})`] = mags.map((m) => 20 * Math.log10(Math.max(m, 1e-30)));
      }
    }
  } else {
    times = columns.map((r) => cellRe(r[0]));
    for (let v = 1; v < varNames.length; v++) {
      const name = normalizeVar(varNames[v]);
      series[name] = columns.map((r) => cellRe(r[v]));
    }
  }

  const lowerPlot = plotname.toLowerCase();
  let xScale = "lin";
  let xUnit = "s";
  if (isComplex || lowerPlot.includes("ac") || varNames[0] === "frequency") {
    xScale = "log";
    xUnit = "Hz";
    if (!isComplex) {
      for (const [name, ys] of Object.entries(series)) {
        if (name.startsWith("v(") && !name.startsWith("db(") && !series[`db(${name})`]) {
          series[`db(${name})`] = ys.map((y) => 20 * Math.log10(Math.max(Math.abs(y), 1e-30)));
        }
      }
    }
  }

  return {
    times,
    series,
    plotname,
    flags,
    points: columns.length,
    xScale,
    xUnit,
    variables: varNames,
    nPoints,
  };
}

function normalizeVar(name) {
  return name;
}

export function buildNgspiceResult(parsed, exitCode) {
  const nodes = {};
  const currents = {};
  if (parsed.points === 1 || /operating|dc/i.test(parsed.plotname)) {
    const idx = parsed.points - 1;
    for (const [name, ys] of Object.entries(parsed.series)) {
      if (name.startsWith("v(")) {
        nodes[name.slice(2, -1)] = ys[idx];
      } else if (name.startsWith("i(")) {
        currents[name.slice(2, -1)] = ys[idx];
      }
    }
    nodes["0"] = 0;
  } else {
    const idx = parsed.times.length - 1;
    for (const [name, ys] of Object.entries(parsed.series)) {
      if (name.startsWith("v(")) nodes[name.slice(2, -1)] = ys[idx];
      if (name.startsWith("i(")) currents[name.slice(2, -1)] = ys[idx];
    }
    nodes["0"] = 0;
  }

  return {
    ...parsed,
    engine: "ngspice",
    exitCode,
    dc: { nodes, currents, iterations: "—" },
    aborted: false,
    steps: parsed.points,
    method: "ngspice",
  };
}

/** Fresh Module + batch run. Exported for Worker and main-thread fallback. */
export async function runNgspiceOnFactory(factory, netlistText, { onLog } = {}) {
  onLog?.("Loading ngspice WASM…");
  const ng = await factory({
    print: () => {},
    printErr: () => {},
  });
  prepFs(ng);
  onLog?.("ngspice WASM ready");

  const text = ensureTitle(netlistText);
  ng.FS.writeFile("/circuit.cir", text);
  try {
    ng.FS.unlink("/out.raw");
  } catch {
    /* */
  }

  const args = ["ngspice", "-b", "-r", "/out.raw", "/circuit.cir"];
  let exitCode = 0;
  try {
    const { argc, argv } = makeArgv(ng, args);
    exitCode = ng._main(argc, argv);
  } catch (e) {
    const msg = String(e?.message || e);
    if (!/exit\((\d+)\)/.test(msg) && !/ExitStatus/.test(msg)) throw e;
    const m = msg.match(/exit\((\d+)\)/);
    exitCode = m ? Number(m[1]) : 0;
  }

  let raw;
  try {
    raw = ng.FS.readFile("/out.raw", { encoding: "utf8" });
  } catch {
    throw new Error(
      `ngspice produced no rawfile (exit ${exitCode}). Check netlist / analysis directives.`
    );
  }

  const parsed = parseAsciiRaw(raw);
  onLog?.(
    `ngspice: ${parsed.plotname || "analysis"} · ${parsed.points} points · exit ${exitCode}`,
    "ok"
  );
  return buildNgspiceResult(parsed, exitCode);
}

export async function getNgspice(onLog) {
  onLog?.("Loading ngspice WASM…");
  const factory = await loadFactory();
  const ng = await factory({
    print: () => {},
    printErr: () => {},
  });
  prepFs(ng);
  onLog?.("ngspice WASM ready");
  return ng;
}

async function runNgspiceMain(netlistText, { onLog, signal } = {}) {
  if (signal?.aborted) throw new Error("Aborted");
  const factory = await loadFactory();
  if (signal?.aborted) throw new Error("Aborted");
  return runNgspiceOnFactory(factory, netlistText, { onLog });
}

function runViaWorker(netlistText, { onLog, signal } = {}) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(new URL("./ngspice-worker.js", import.meta.url), {
        type: "module",
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      err.workerOnly = true;
      reject(err);
      return;
    }

    let settled = false;
    let ready = false;

    const cleanup = () => {
      signal?.removeEventListener("abort", onAbort);
      try {
        worker.terminate();
      } catch {
        /* */
      }
    };

    const fail = (err, { workerOnly = false } = {}) => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = err instanceof Error ? err : new Error(String(err));
      error.workerOnly = workerOnly;
      reject(error);
    };

    const onAbort = () => fail(new Error("Aborted"));

    signal?.addEventListener("abort", onAbort);
    if (signal?.aborted) {
      fail(new Error("Aborted"));
      return;
    }

    worker.onmessage = (ev) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "ready") {
        ready = true;
        worker.postMessage({ type: "run", netlist: netlistText });
        return;
      }
      if (msg.type === "log") {
        onLog?.(msg.message, msg.cls);
        return;
      }
      if (msg.type === "result") {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(msg.payload);
        return;
      }
      if (msg.type === "error") {
        // Simulation / parse errors should not trigger main-thread fallback.
        fail(new Error(msg.message), { workerOnly: false });
      }
    };

    worker.onerror = (ev) => {
      fail(new Error(ev.message || "ngspice worker error"), {
        workerOnly: !ready,
      });
    };

    worker.onmessageerror = () => {
      fail(new Error("ngspice worker message error"), { workerOnly: !ready });
    };
  });
}

/**
 * Run netlist text through ngspice batch mode.
 * Prefers Worker; falls back to main thread if Worker fails to start.
 */
export async function runNgspice(netlistText, { onLog, signal } = {}) {
  if (signal?.aborted) throw new Error("Aborted");
  try {
    return await runViaWorker(netlistText, { onLog, signal });
  } catch (e) {
    if (signal?.aborted) throw e;
    // Only fall back when the Worker itself failed (construct / import / ready).
    if (!e?.workerOnly) throw e;
    onLog?.(`Worker unavailable (${e?.message || e}); running on main thread…`);
    return runNgspiceMain(netlistText, { onLog, signal });
  }
}

export function ngspiceAvailableHint() {
  return "Engine: JS (built-in) or ngspice WASM (real SPICE-46)";
}
