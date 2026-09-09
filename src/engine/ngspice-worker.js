/**
 * Web Worker: run ngspice WASM off the main thread.
 * Fresh Module per run (_main exits the runtime).
 */

import {
  parseAsciiRaw,
  prepFs,
  makeArgv,
  ensureTitle,
  buildNgspiceResult,
} from "./ngspice.js";

const CDN_URL = "https://cdn.jsdelivr.net/npm/@o.z/ngspice-wasm@0.0.0/ngspice.js";
const LOCAL_URL = new URL("../../vendor/ngspice.js", import.meta.url).href;

let factoryPromise = null;

async function loadFactory() {
  if (factoryPromise) return factoryPromise;
  factoryPromise = (async () => {
    try {
      // Prefer vendored build; CDN if missing (e.g. sparse checkout).
      const mod = await import(LOCAL_URL);
      return mod.default;
    } catch {
      const mod = await import(/* @vite-ignore */ CDN_URL);
      return mod.default;
    }
  })();
  return factoryPromise;
}

function postLog(message, cls) {
  self.postMessage({ type: "log", message, cls });
}

async function runOnce(netlistText) {
  const factory = await loadFactory();
  postLog("Loading ngspice WASM…");
  const ng = await factory({
    print: () => {},
    printErr: () => {},
  });
  prepFs(ng);
  postLog("ngspice WASM ready");

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
  postLog(
    `ngspice: ${parsed.plotname || "analysis"} · ${parsed.points} points · exit ${exitCode}`,
    "ok"
  );
  return buildNgspiceResult(parsed, exitCode);
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== "run") return;
  try {
    const payload = await runOnce(msg.netlist);
    self.postMessage({ type: "result", payload });
  } catch (e) {
    self.postMessage({ type: "error", message: e?.message || String(e) });
  }
};

self.postMessage({ type: "ready" });
