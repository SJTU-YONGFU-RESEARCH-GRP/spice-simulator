import { parseNetlist } from "../src/netlist/parser.js";
import { dcOp } from "../src/engine/circuit.js";
import { transient } from "../src/engine/transient.js";
import { acAnalysis } from "../src/engine/ac.js";
import { runNgspice, parseAsciiRaw } from "../src/engine/ngspice.js";

function approx(a, b, tol) {
  return Math.abs(a - b) <= tol;
}

// --- RC TRAN (trapezoidal) ---
{
  const circuit = parseNetlist(`* RC
V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out 1k
C1 out 0 1u
.tran 10u 5m
.end`);
  const tran = transient(circuit, { tstep: 10e-6, tstop: 5e-3 });
  const vout = tran.series["v(out)"];
  const t = tran.times;
  const mid = vout[t.findIndex((x) => x >= 1e-3)];
  const last = vout[vout.length - 1];
  const ok =
    approx(mid, 5 * (1 - Math.exp(-1)), 0.12) &&
    approx(last, 5 * (1 - Math.exp(-5)), 0.08);
  console.log("RC TRAN trap @1ms", mid, "@5ms", last, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- RC TRAN adaptive ---
{
  const circuit = parseNetlist(`* RC adaptive
V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out 1k
C1 out 0 1u
.tran 100u 5m ADAPTIVE
.end`);
  const tran = transient(circuit, {
    tstep: 100e-6,
    tstop: 5e-3,
    adaptive: true,
  });
  const vout = tran.series["v(out)"];
  const t = tran.times;
  const mid = vout[t.findIndex((x) => x >= 1e-3)];
  const last = vout[vout.length - 1];
  const ok =
    tran.adaptive === true &&
    approx(mid, 5 * (1 - Math.exp(-1)), 0.12) &&
    approx(last, 5 * (1 - Math.exp(-5)), 0.08);
  console.log(
    "RC TRAN adaptive @1ms",
    mid,
    "@5ms",
    last,
    "steps",
    tran.steps,
    ok ? "PASS" : "FAIL"
  );
  if (!ok) process.exitCode = 1;
}

// --- AC RC ---
{
  const circuit = parseNetlist(`V1 in 0 DC 0 AC 1
R1 in out 1k
C1 out 0 1u
.ac dec 40 1 1Meg
.end`);
  const ac = acAnalysis(circuit);
  const f = ac.times;
  const db = ac.series["db(v(out))"];
  const f3 = 1 / (2 * Math.PI * 1e3 * 1e-6);
  const idx = f.reduce((bi, fi, i) => (Math.abs(fi - f3) < Math.abs(f[bi] - f3) ? i : bi), 0);
  const ok = approx(db[idx], -3, 1.0);
  console.log("AC RC @fc", f[idx], "dB", db[idx], ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- MOSFET DC ---
{
  const circuit = parseNetlist(`Vdd dd 0 5
Vin g 0 1.2
Mn out g 0 0 NMOS W=10u L=1u
Rd dd out 10k
.model NMOS NMOS (Vto=0.7 Kp=50u Lambda=0.02)
.dc
.end`);
  const dc = dcOp(circuit);
  // Mid-rail-ish bias with Kp=50u W/L=10
  const ok = dc.nodes.out > 1 && dc.nodes.out < 4.5;
  console.log("MOS DC v(out)", dc.nodes.out, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- Diode ---
{
  const diode = parseNetlist(`V1 in 0 5
R1 in out 1k
D1 out 0 DDEFAULT
.dc
.end`);
  const ddc = dcOp(diode);
  const ok = approx(ddc.nodes.out, 0.7, 0.15);
  console.log("Diode DC", ddc.nodes.out, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- .param ---
{
  const circuit = parseNetlist(`* param RC
.param Rload=1k Cload=1u
V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out {Rload}
C1 out 0 {Cload}
.tran 10u 5m
.end`);
  const r = circuit.devices.find((d) => d.name === "R1");
  const c = circuit.devices.find((d) => d.name === "C1");
  const ok = approx(r.value, 1e3, 1e-6) && approx(c.value, 1e-6, 1e-12);
  console.log("param R", r.value, "C", c.value, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- BJT CE amp DC ---
{
  const circuit = parseNetlist(`Vcc vcc 0 5
Vin in 0 0.8
Rb in b 10k
Q1 c b 0 NPN
Rc vcc c 1k
.model NPN NPN (Is=1e-15 Bf=100 Vaf=50)
.dc
.end`);
  const dc = dcOp(circuit);
  const ok =
    dc.nodes.c > 0.5 &&
    dc.nodes.c < 4.8 &&
    dc.nodes.b > 0.55 &&
    dc.nodes.b < 0.85;
  console.log("BJT DC v(c)", dc.nodes.c, "v(b)", dc.nodes.b, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- OPAMP inverting (X + built-in) ---
{
  const circuit = parseNetlist(`Vin in 0 DC 1
Rin in mid 10k
Rf mid out 100k
X1 0 mid out OPAMP
.dc
.end`);
  const dc = dcOp(circuit);
  // gain ≈ -Rf/Rin = -10 → out ≈ -10
  const ok = approx(dc.nodes.out, -10, 0.5);
  console.log("OPAMP DC v(out)", dc.nodes.out, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- E VCVS ---
{
  const circuit = parseNetlist(`Vin in 0 DC 2
E1 out 0 in 0 5
R1 out 0 1k
.dc
.end`);
  const dc = dcOp(circuit);
  const ok = approx(dc.nodes.out, 10, 0.01);
  console.log("E VCVS v(out)", dc.nodes.out, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- F CCCS / H CCVS ---
{
  const circuit = parseNetlist(`Vin in 0 DC 1
Rs in sense 1k
Vsense sense 0 DC 0
F1 0 out Vsense 2
Rl out 0 1k
H1 hout 0 Vsense 2k
Rh hout 0 10k
.dc
.end`);
  const dc = dcOp(circuit);
  // i(Vsense)=1mA → F (0→out): +2V on Rl; H: 2kΩ*1mA=2V
  const ok = approx(dc.nodes.out, 2, 1e-6) && approx(dc.nodes.hout, 2, 1e-6);
  console.log("F/H v(out)", dc.nodes.out, "v(hout)", dc.nodes.hout, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- S switch ---
{
  const { switchIsOn, switchParams } = await import("../src/engine/switch.js");
  const p = switchParams({ params: { vt: 2.5, vh: 0.5, ron: 1, roff: 1e9 } });
  const hystOk =
    switchIsOn(p, 0, undefined) === false &&
    switchIsOn(p, 3.1, false) === true &&
    switchIsOn(p, 2.6, true) === true &&
    switchIsOn(p, 1.9, true) === false;

  const offCir = parseNetlist(`Vin in 0 DC 5
Vctrl c 0 DC 0
S1 in out c 0 SW1
R1 out 0 1k
.model SW1 SW (Vt=2.5 Vh=0.1 Ron=1 Roff=1G)
.dc
.end`);
  const onCir = parseNetlist(`Vin in 0 DC 5
Vctrl c 0 DC 5
S1 in out c 0 SW1
R1 out 0 1k
.model SW1 SW (Vt=2.5 Vh=0.1 Ron=1 Roff=1G)
.dc
.end`);
  const offDc = dcOp(offCir);
  const onDc = dcOp(onCir);
  // OFF ≈ 0; ON ≈ 5 * 1k/(1+1k) ≈ 4.995
  const ok =
    hystOk &&
    approx(offDc.nodes.out, 0, 1e-3) &&
    approx(onDc.nodes.out, 5 * 1000 / 1001, 1e-3);
  console.log("S switch off", offDc.nodes.out, "on", onDc.nodes.out, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- W current-controlled switch ---
{
  const onCir = parseNetlist(`Iin 0 in DC 2m
Vsense in 0 DC 0
Vload mid 0 DC 5
W1 mid out Vsense CSW1
Rl out 0 1k
.model CSW1 CSW (It=1m Ih=0.1m Ron=1 Roff=1G)
.dc
.end`);
  const offCir = parseNetlist(`Iin 0 in DC 0.1m
Vsense in 0 DC 0
Vload mid 0 DC 5
W1 mid out Vsense CSW1
Rl out 0 1k
.model CSW1 CSW (It=1m Ih=0.1m Ron=1 Roff=1G)
.dc
.end`);
  const onDc = dcOp(onCir);
  const offDc = dcOp(offCir);
  const ok =
    approx(onDc.nodes.out, 5 * 1000 / 1001, 0.05) &&
    approx(offDc.nodes.out, 0, 1e-2);
  console.log("W switch on", onDc.nodes.out, "off", offDc.nodes.out, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- K mutual inductance ---
{
  const { transient } = await import("../src/engine/transient.js");
  const src = `* k
Vin in 0 SIN(0 1 1k)
R1 in p 50
L1 p 0 1m
L2 sec 0 1m
K1 L1 L2 0.95
Rload sec 0 1k
.tran 20u 3m
.end`;
  const c = parseNetlist(src);
  const okParse =
    c.devices.some((d) => d.type === "K" && approx(d.k, 0.95, 1e-12));
  const tr = transient(c, { tstep: 20e-6, tstop: 3e-3 });
  const ys = tr.series["v(sec)"];
  const yp = tr.series["v(p)"];
  const n = ys.length;
  let peakSec = 0;
  let peakP = 0;
  for (let i = Math.floor(n * 0.5); i < n; i++) {
    peakSec = Math.max(peakSec, Math.abs(ys[i]));
    peakP = Math.max(peakP, Math.abs(yp[i]));
  }
  // Loaded 1:1 — secondary tracks primary (both attenuated by R1/Rload)
  const ok =
    okParse &&
    peakP > 0.05 &&
    peakSec > 0.05 &&
    Math.abs(peakSec - peakP) / peakP < 0.5;
  console.log("K mutual |v(sec)|pk", peakSec, "|v(p)|pk", peakP, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- NOISE RC ---
{
  const { noiseAnalysis } = await import("../src/engine/noise.js");
  const circuit = parseNetlist(`V1 in 0 DC 0 AC 1
R1 in out 1k
C1 out 0 1u
.noise V(out) V1 dec 10 1 1k
.end`);
  const result = noiseAnalysis(circuit);
  const o0 = result.series.onoise[0];
  const expected = Math.sqrt(4 * 1.380649e-23 * 300 * 1e3);
  const ok = approx(o0, expected, expected * 0.15) && result.totalOnoise > 0;
  console.log(
    "NOISE onoise(LF)",
    o0,
    "total",
    result.totalOnoise,
    ok ? "PASS" : "FAIL"
  );
  if (!ok) process.exitCode = 1;
}

// --- NOISE flicker rises at LF ---
{
  const { noiseAnalysis } = await import("../src/engine/noise.js");
  const circuit = parseNetlist(`.temp 27
V1 in 0 DC 0.7 AC 1
R1 in mid 1k
D1 mid out DFLICK
R2 out 0 1k
.model DFLICK D (Is=1e-14 Kf=1e-10 Af=1)
.noise V(out) V1 dec 8 1 1k
.end`);
  const result = noiseAnalysis(circuit);
  const lo = result.series.onoise[0];
  const hi = result.series.onoise[result.series.onoise.length - 1];
  const ok = lo > hi * 1.2;
  console.log("NOISE flicker LF", lo, "> HF", hi, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- ngspice WASM ---
{
  try {
    const result = await runNgspice(`* RC ngspice
V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out 1k
C1 out 0 1u
.tran 100u 5m
.end
`);
    const vout = result.series["v(out)"];
    const t = result.times;
    const mid = vout[t.findIndex((x) => x >= 1e-3)];
    const last = vout[vout.length - 1];
    const ok =
      result.engine === "ngspice" &&
      approx(mid, 5 * (1 - Math.exp(-1)), 0.25) &&
      approx(last, 5 * (1 - Math.exp(-5)), 0.15);
    console.log("ngspice RC @1ms", mid, "@5ms", last, ok ? "PASS" : "FAIL");
    if (!ok) process.exitCode = 1;
  } catch (e) {
    console.log("ngspice FAIL", e.message);
    process.exitCode = 1;
  }
}

// raw parser unit (real)
{
  const sample = `Title: t
Plotname: Transient Analysis
Flags: real
No. Variables: 2
No. Points: 2
Variables:
	0	time	time
	1	v(out)	voltage
Values:
0		0
	0
1		1e-3
	3.16
`;
  const p = parseAsciiRaw(sample);
  const ok = p.times.length === 2 && approx(p.series["v(out)"][1], 3.16, 1e-9);
  console.log("raw parse", ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// raw parser unit (complex AC — re,im pairs)
{
  // v(out) = 0.5 - j0.5 → mag=√0.5, phase=-45°, db≈-6.02
  const mag = Math.SQRT1_2;
  const db = 20 * Math.log10(mag);
  const sample = `Title: t
Plotname: AC Analysis
Flags: complex
No. Variables: 2
No. Points: 2
Variables:
	0	frequency	frequency
	1	v(out)	voltage
Values:
0		1.000000000000000e+03,0.000000000000000e+00
	5.000000000000000e-01,-5.000000000000000e-01
1		1.000000000000000e+04,0.000000000000000e+00
	5.000000000000000e-01,-5.000000000000000e-01
`;
  const p = parseAsciiRaw(sample);
  const ok =
    p.flags.includes("complex") &&
    p.times.length === 2 &&
    approx(p.times[0], 1e3, 1e-9) &&
    approx(p.series["v(out)"][0], mag, 1e-9) &&
    approx(p.series["ph(v(out))"][0], -45, 1e-6) &&
    approx(p.series["db(v(out))"][0], db, 1e-6) &&
    p.xUnit === "Hz";
  console.log("raw parse complex", ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// raw parser unit (complex AC — re/im on separate lines)
{
  const sample = `Title: t
Plotname: AC Analysis
Flags: complex
No. Variables: 2
No. Points: 1
Variables:
	0	frequency	frequency
	1	v(out)	voltage
Values:
0		100
	0
	0
	1
`;
  const p = parseAsciiRaw(sample);
  const ok =
    approx(p.times[0], 100, 1e-12) &&
    approx(p.series["v(out)"][0], 1, 1e-12) &&
    approx(p.series["ph(v(out))"][0], 90, 1e-6) &&
    approx(p.series["db(v(out))"][0], 0, 1e-6);
  console.log("raw parse complex lines", ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- .include ---
{
  const { expandIncludes } = await import("../src/netlist/include.js");
  const { readFileSync } = await import("fs");
  const { fileURLToPath } = await import("url");
  const { dirname, join } = await import("path");
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const models = readFileSync(join(root, "lib/models.cir"), "utf8");
  const src = await expandIncludes(
    `* t
.include lib/models.cir
V1 in 0 DC 5
R1 in out 1k
D1 out 0 D1N4148
.dc
.end`,
    { files: { "lib/models.cir": models } }
  );
  const circuit = parseNetlist(src);
  const dc = dcOp(circuit);
  const model = circuit.models.get("D1N4148");
  const ok =
    src.includes(".model D1N4148") &&
    approx(model?.params?.is, 2.52e-9, 1e-12) &&
    dc.nodes.out > 0.4 &&
    dc.nodes.out < 0.9 &&
    !approx(dc.nodes.out, 0.696484574559164, 1e-9); // distinct from DDEFAULT Is=1e-14
  console.log("include diode DC", dc.nodes.out, "Is", model?.params?.is, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- .measure ---
{
  const { parseMeasures, evalMeasures } = await import("../src/engine/measure.js");
  const circuit = parseNetlist(`V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out 1k
C1 out 0 1u
.tran 10u 5m
.meas tran vmax MAX v(out)
.meas tran vat AT v(out) AT=1m
.meas tran t50 WHEN v(out)=2.5 RISE=1
.meas tran vmid AVG v(out) FROM=0.5m TO=1.5m
.meas tran td TRIG v(in)=2.5 RISE=1 TARG v(out)=2.5 RISE=1
.end`);
  const tran = transient(circuit, { tstep: 10e-6, tstop: 5e-3 });
  const specs = parseMeasures(`*
.meas tran vmax MAX v(out)
.meas tran vat AT v(out) AT=1m
.meas tran t50 WHEN v(out)=2.5 RISE=1
.meas tran vmid AVG v(out) FROM=0.5m TO=1.5m
.meas tran td TRIG v(in)=2.5 RISE=1 TARG v(out)=2.5 RISE=1
`);
  const ms = evalMeasures(specs, { ...tran, analysis: "tran" }, "tran");
  const vmax = ms.find((m) => m.name === "vmax");
  const vat = ms.find((m) => m.name === "vat");
  const t50 = ms.find((m) => m.name === "t50");
  const vmid = ms.find((m) => m.name === "vmid");
  const td = ms.find((m) => m.name === "td");
  // RC: v=2.5 at t = -tau*ln(1-2.5/5) = 1e-3*ln(2) ≈ 0.693ms
  const tExpect = 1e-3 * Math.log(2);
  const ok =
    vmax?.ok &&
    approx(vmax.value, 5 * (1 - Math.exp(-5)), 0.1) &&
    vat?.ok &&
    approx(vat.value, 5 * (1 - Math.exp(-1)), 0.15) &&
    t50?.ok &&
    approx(t50.value, tExpect, 80e-6) &&
    vmid?.ok &&
    Number.isFinite(vmid.value) &&
    td?.ok &&
    approx(td.value, tExpect, 80e-6);
  console.log(
    "measure vmax",
    vmax?.value,
    "vat",
    vat?.value,
    "t50",
    t50?.value,
    "td",
    td?.value,
    ok ? "PASS" : "FAIL"
  );
  if (!ok) process.exitCode = 1;
}

// --- golden diff ---
{
  const { diffAgainstGolden, cloneResult } = await import("../src/ui/golden.js");
  const circuit = parseNetlist(`V1 in 0 PULSE(0 5 0 1n 1n 10 10)
R1 in out 1k
C1 out 0 1u
.tran 50u 2m
.end`);
  const a = transient(circuit, { tstep: 50e-6, tstop: 2e-3 });
  const golden = cloneResult(a);
  const b = {
    times: a.times,
    series: {
      "v(out)": a.series["v(out)"].map((v) => v + 0.01),
      "v(in)": a.series["v(in)"],
    },
  };
  const d = diffAgainstGolden(b, golden);
  const row = d.rows.find((r) => r.name === "v(out)");
  const ok = d.ok && approx(row.maxAbs, 0.01, 1e-9);
  console.log("golden max|e|", row?.maxAbs, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- FFT of sine ---
{
  const { spectrumFromTransient } = await import("../src/engine/fft.js");
  const n = 512;
  const f0 = 1e3;
  const fs = 20e3;
  const times = Array.from({ length: n }, (_, i) => i / fs);
  const ys = times.map((t) => Math.sin(2 * Math.PI * f0 * t));
  const spec = spectrumFromTransient(times, { "v(out)": ys }, ["v(out)"], { nfft: 512 });
  const mag = spec.series["|v(out)|"];
  let peakI = 0;
  for (let i = 1; i < mag.length; i++) if (mag[i] > mag[peakI]) peakI = i;
  const ok = approx(spec.times[peakI], f0, 50) && mag[peakI] > 0.4;
  console.log("FFT peak", spec.times[peakI], "Hz mag", mag[peakI], ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- .tf divider ---
{
  const { tfAnalysis } = await import("../src/engine/tf.js");
  const circuit = parseNetlist(`V1 in 0 DC 1
R1 in out 1k
R2 out 0 1k
.tf V(out) V1
.end`);
  const tf = tfAnalysis(circuit);
  const ok =
    approx(tf.transfer, 0.5, 1e-3) &&
    approx(tf.zin, 2e3, 1) &&
    approx(tf.zout, 500, 1);
  console.log(
    "TF transfer",
    tf.transfer,
    "Zin",
    tf.zin,
    "Zout",
    tf.zout,
    ok ? "PASS" : "FAIL"
  );
  if (!ok) process.exitCode = 1;
}

// --- .step ---
{
  const { parseSteps, applyStepParam, formatStepLabel } = await import(
    "../src/netlist/step.js"
  );
  const src = `* s
.param Rload=1k
V1 in 0 DC 1
R1 in out {Rload}
R2 out 0 1k
.dc
.step param Rload list 1k 2k
.end`;
  const step = parseSteps(src);
  const a = applyStepParam(src, step.param, step.values[0]);
  const b = applyStepParam(src, step.param, step.values[1]);
  const ca = parseNetlist(a);
  const cb = parseNetlist(b);
  const da = dcOp(ca);
  const db = dcOp(cb);
  const ok =
    step.values.length === 2 &&
    approx(da.nodes.out, 0.5, 1e-3) &&
    approx(db.nodes.out, 1 / 3, 1e-3) &&
    formatStepLabel(1000) === "1k";
  console.log("step Rload", da.nodes.out, db.nodes.out, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- .four sine ---
{
  const { parseFours, evalFourier } = await import("../src/engine/fourier.js");
  const f0 = 1e3;
  const n = 2000;
  const tstop = 5e-3;
  const times = Array.from({ length: n }, (_, i) => (i * tstop) / (n - 1));
  const ys = times.map((t) => Math.sin(2 * Math.PI * f0 * t));
  const specs = parseFours(".four 1k v(out)");
  const fou = evalFourier({ times, series: { "v(out)": ys } }, specs);
  const h1 = fou[0].harmonics[1];
  const h2 = fou[0].harmonics[2];
  const ok =
    approx(h1.mag, 1, 0.05) &&
    h2.mag < 0.05 &&
    fou[0].thd < 0.08;
  console.log(
    "four |c1|",
    h1.mag,
    "|c2|",
    h2.mag,
    "THD",
    fou[0].thd,
    ok ? "PASS" : "FAIL"
  );
  if (!ok) process.exitCode = 1;
}

// --- .dc source sweep (diode I–V) ---
{
  const { dcAnalysis } = await import("../src/engine/dc.js");
  const src = `* diode iv
V1 a 0 DC 0
D1 a 0 D1
.model D1 D (Is=1e-14 N=1)
.dc V1 0 0.8 0.1
.end`;
  const c = parseNetlist(src);
  const r = dcAnalysis(c);
  const iName = "i(V1)";
  const ys = r.series[iName];
  const idx07 = r.times.findIndex((v) => approx(v, 0.7, 1e-9));
  const iAt07 = ys?.[idx07];
  // Is*(exp(0.7/Vt)-1) ≈ 4.85e-3 A into diode; i(V1) is out of source ≈ −Id
  const IdExpect = 1e-14 * (Math.exp(0.7 / 0.026) - 1);
  const ok =
    c.analysis.sweep?.src === "V1" &&
    r.points >= 8 &&
    idx07 >= 0 &&
    approx(Math.abs(iAt07), IdExpect, 0.15 * IdExpect);
  console.log("dc sweep |i(V1)|@0.7", Math.abs(iAt07), "expect~", IdExpect, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- nested .dc ---
{
  const { dcAnalysis } = await import("../src/engine/dc.js");
  const src = `* nest
V1 in 0 DC 0
V2 bias 0 DC 0
R1 in out 1k
R2 out bias 1k
.dc V1 0 2 1 V2 0 1 1
.end`;
  const c = parseNetlist(src);
  const r = dcAnalysis(c);
  const key0 = "v(out)@V2=0";
  const key1 = "v(out)@V2=1";
  const ys0 = r.series[key0];
  const ys1 = r.series[key1];
  const i1 = r.times.findIndex((v) => approx(v, 2, 1e-12));
  // V1=2,V2=0 → mid=1; V1=2,V2=1 → mid=1.5
  const ok =
    c.analysis.sweep?.nested?.src === "V2" &&
    r.nested &&
    r.outerPoints === 2 &&
    i1 >= 0 &&
    approx(ys0[i1], 1, 1e-6) &&
    approx(ys1[i1], 1.5, 1e-6);
  console.log("dc nested", ys0?.[i1], ys1?.[i1], ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- .print ---
{
  const { parsePrint, matchSeriesNames } = await import("../src/netlist/print.js");
  const src = `.print tran v(out) i(R1)\n.print dc i(V1)\n.print ac v(out)`;
  const tran = parsePrint(src, "tran");
  const dc = parsePrint(src, "dc");
  const series = { "v(out)": [1], "i(R1)": [2], "i(V1)": [3] };
  const matched = matchSeriesNames(series, ["V(OUT)", "i(r1)"]);
  const ok =
    tran.length === 2 &&
    tran[0].toLowerCase() === "v(out)" &&
    dc.length === 1 &&
    matched.length === 2 &&
    matched[0] === "v(out)";
  console.log("print", tran, dc, matched, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- SIN source + TRAN ---
{
  const { transient } = await import("../src/engine/transient.js");
  const { parseFours, evalFourier } = await import("../src/engine/fourier.js");
  const src = `* sin
V1 out 0 SIN(0 1 1k)
.tran 10u 5m
.four 1k v(out)
.end`;
  const c = parseNetlist(src);
  const okParse =
    c.devices[0].waveform?.type === "sin" &&
    approx(c.devices[0].waveform.va, 1, 1e-12) &&
    approx(c.devices[0].waveform.freq, 1e3, 1e-9);
  const tr = transient(c, { tstep: 10e-6, tstop: 5e-3 });
  const fou = evalFourier(tr, parseFours(src));
  const h1 = fou[0].harmonics[1];
  const ok =
    okParse &&
    approx(h1.mag, 1, 0.05) &&
    fou[0].thd < 0.05;
  console.log("sin |c1|", h1.mag, "THD", fou[0].thd, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- PWL + EXP sources ---
{
  const { sourceValue } = await import("../src/netlist/parser.js");
  const pwlSrc = `* pwl
V1 out 0 PWL(0 0 1m 5 2m 5 3m 0)
.tran 50u 3m
.end`;
  const cp = parseNetlist(pwlSrc);
  const wp = cp.devices[0];
  const vMid = sourceValue(wp, 1.5e-3, "tran");
  const vHalf = sourceValue(wp, 0.5e-3, "tran");
  const okPwl =
    wp.waveform?.type === "pwl" &&
    approx(vMid, 5, 1e-9) &&
    approx(vHalf, 2.5, 1e-9);

  const expSrc = `* exp
V1 out 0 EXP(0 5 1m 0.5m 3m 0.5m)
.tran 50u 5m
.end`;
  const ce = parseNetlist(expSrc);
  const we = ce.devices[0];
  // at t=1m+0.5m=1.5m: v1+(v2-v1)*(1-exp(-1)) ≈ 5*(1-1/e) ≈ 3.160
  const vRise = sourceValue(we, 1.5e-3, "tran");
  const expectRise = 5 * (1 - Math.exp(-1));
  const okExp =
    we.waveform?.type === "exp" &&
    approx(sourceValue(we, 0.5e-3, "tran"), 0, 1e-12) &&
    approx(vRise, expectRise, 1e-9);

  const ok = okPwl && okExp;
  console.log("pwl/exp", vMid, vHalf, vRise, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- .nodeset soft initial guess ---
{
  const src = `* nodeset
V1 in 0 5
R1 in mid 1k
R2 mid out 1k
R3 out 0 1k
.nodeset V(mid)=2 V(out)=1
.op
.end`;
  const circuit = parseNetlist(src);
  const okParse =
    circuit.nodeset?.get("mid") === 2 && circuit.nodeset?.get("out") === 1;
  const dc = dcOp(circuit);
  // resistive divider: mid=10/3≈3.333, out=5/3≈1.667
  const okDc =
    approx(dc.nodes.mid, 10 / 3, 1e-6) && approx(dc.nodes.out, 5 / 3, 1e-6);
  const ok = okParse && okDc;
  console.log("nodeset", circuit.nodeset?.get("mid"), dc.nodes.mid, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- .option ---
{
  const src = `* options
V1 in 0 5
R1 in out 1k
R2 out 0 1k
.option temp=75 reltol=1e-4 abstol=1e-9 vntol=1e-7 gmin=1e-11 itl1=40 method=gear
.tran 10u 1m
.end`;
  const c = parseNetlist(src);
  const o = c.options;
  const ok =
    approx(o.tempC, 75, 1e-12) &&
    approx(o.reltol, 1e-4, 1e-15) &&
    approx(o.abstol, 1e-9, 1e-20) &&
    approx(o.vntol, 1e-7, 1e-18) &&
    approx(o.gmin, 1e-11, 1e-20) &&
    o.maxIter === 40 &&
    o.method === "be" &&
    c.analysis.method === "be";
  const dc = dcOp(c);
  const okDc = approx(dc.nodes.out, 2.5, 1e-6);
  console.log("option", o.tempC, o.method, dc.nodes.out, ok && okDc ? "PASS" : "FAIL");
  if (!(ok && okDc)) process.exitCode = 1;
}

// --- Behavioral B ---
{
  const { compileExpr } = await import("../src/engine/expr.js");
  const { eval: ev } = compileExpr("2*v(in)+0.5");
  const eOk = approx(ev({ v: (n) => (n === "in" ? 1.5 : 0) }), 3.5, 1e-12);

  const amp = parseNetlist(`* B gain
Vin in 0 DC 1.2
B1 out 0 V=2.5*v(in)
R1 out 0 1k
.op
.end`);
  const da = dcOp(amp);
  const okAmp = approx(da.nodes.out, 3.0, 1e-4);

  const bi = parseNetlist(`* BI
Vin in 0 DC 2
B1 0 out I=v(in)*1m
R1 out 0 1k
.op
.end`);
  const db = dcOp(bi);
  // I=2m into 1k → 2V
  const okBi = approx(db.nodes.out, 2, 1e-3);

  const clamp = parseNetlist(`* clamp
Vin in 0 DC 3
B1 out 0 V=v(in)>1 ? 1 : v(in)
R1 out 0 1k
.op
.end`);
  const dc = dcOp(clamp);
  const okClamp = approx(dc.nodes.out, 1, 1e-4);

  const ok = eOk && okAmp && okBi && okClamp;
  console.log("behavioral B", da.nodes.out, db.nodes.out, dc.nodes.out, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- .func macro ---
{
  const src = `* func
.func clamp(x,lo,hi) {max(lo,min(hi,x))}
Vin in 0 DC 3
B1 out 0 V=clamp(v(in),-1,1)
R1 out 0 1k
.op
.end`;
  const c = parseNetlist(src);
  const b = c.devices.find((d) => d.type === "B");
  const okParse = b?.expr?.includes("max") && b?.expr?.includes("min");
  const dc = dcOp(c);
  const ok = okParse && approx(dc.nodes.out, 1, 1e-4);
  console.log("func clamp", b?.expr, dc.nodes.out, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- diode Rs / BV + R tc1 ---
{
  const { passiveValue } = await import("../src/engine/circuit.js");
  const rsCir = parseNetlist(`* rs
V1 a 0 DC 0.8
D1 a 0 DRS
.model DRS D (Is=1e-14 N=1 Rs=10)
.op
.end`);
  const rsDc = dcOp(rsCir);
  // With Rs, forward drop at same V is lower current than ideal → |i| smaller than no-Rs
  const noRs = parseNetlist(`V1 a 0 DC 0.8
D1 a 0 D0
.model D0 D (Is=1e-14 N=1)
.op
.end`);
  const iRs = Math.abs(rsDc.currents.V1);
  const i0 = Math.abs(dcOp(noRs).currents.V1);
  const okRs = iRs < i0 * 0.95 && iRs > 1e-6;

  const bvCir = parseNetlist(`* bv
V1 a 0 DC -6
D1 a 0 DBV
.model DBV D (Is=1e-14 N=1 BV=5 Ibv=1e-3)
.op
.end`);
  const bvDc = dcOp(bvCir);
  // reverse beyond BV → significant current
  const okBv = Math.abs(bvDc.currents.V1) > 1e-4;

  const tcCir = parseNetlist(`* tc
.option temp=127 tnom=27
V1 in 0 DC 1
R1 in 0 1k tc1=0.001
.op
.end`);
  const Rhot = passiveValue(tcCir.devices.find((d) => d.type === "R"), tcCir);
  const okTc = approx(Rhot, 1100, 1e-9); // 1k*(1+0.001*100)
  const tcDc = dcOp(tcCir);
  const okTcI = approx(Math.abs(tcDc.currents.V1), 1 / 1100, 1e-9);

  const ok = okRs && okBv && okTc && okTcI;
  console.log("diode Rs/BV + R tc", iRs, i0, bvDc.currents.V1, Rhot, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- C IC= + phase unwrap ---
{
  const { unwrapPhaseDeg } = await import("../src/engine/ac.js");
  const u = unwrapPhaseDeg([170, -170, -175]);
  const okUnwrapFn = approx(u[1], 190, 1e-9) && approx(u[2], 185, 1e-9);

  const icCir = parseNetlist(`* cap IC
V1 in 0 DC 0
R1 in out 1k
C1 out 0 1u IC=5
.tran 1u 50u UIC
.end`);
  const c1 = icCir.devices.find((d) => d.name === "C1");
  const tr = transient(icCir, { tstep: 1e-6, tstop: 50e-6 });
  const v0 = tr.series["v(out)"][0];
  const okIc = c1.ic === 5 && approx(v0, 5, 0.05);

  const acCir = parseNetlist(`* 3-pole RC — phase past -180
Vin in 0 DC 0 AC 1
R1 in n1 1k
C1 n1 0 1u
R2 n1 n2 1k
C2 n2 0 1u
R3 n2 out 1k
C3 out 0 1u
.ac dec 40 10 1Meg
.end`);
  const ac = acAnalysis(acCir);
  const ph = ac.series["ph(v(out))"];
  const phLast = ph[ph.length - 1];
  const okPh = phLast < -180; // unwrapped past ±180

  const ok = okUnwrapFn && okIc && okPh;
  console.log("IC= + phase unwrap", v0, phLast, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- XY plot helper + Lissajous samples ---
{
  const { xyPlotSpec } = await import("../src/ui/waveform.js");
  const series = { "v(x)": [1, 0, -1], "v(y)": [0, 1, 0] };
  const spec = xyPlotSpec(["v(x)", "v(y)"], series, true);
  const okSpec =
    spec?.xName === "v(x)" &&
    spec.yNames.length === 1 &&
    spec.yNames[0] === "v(y)" &&
    xyPlotSpec(["v(x)"], series, true) === null;

  const cir = parseNetlist(`* Lissajous
Vx x 0 SIN(0 1 1k 0 0 0)
Vy y 0 SIN(0 1 1k 0 0 90)
.tran 10u 1m
.end`);
  const tr = transient(cir, { tstep: 10e-6, tstop: 1e-3 });
  const vx = tr.series["v(x)"];
  const vy = tr.series["v(y)"];
  // quadrature → points near unit circle
  let sumR = 0;
  let n = 0;
  for (let i = 0; i < vx.length; i += 5) {
    sumR += vx[i] * vx[i] + vy[i] * vy[i];
    n++;
  }
  const meanR2 = sumR / n;
  const okCirc = approx(meanR2, 1, 0.08);
  const ok = okSpec && okCirc;
  console.log("XY / Lissajous", meanR2, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- Diode Cjo + L Rser ---
{
  const { diodeCapacitance, diodeParams } = await import("../src/engine/diode.js");
  const p = diodeParams({ params: { cjo: 1e-9, vj: 0.7, m: 0.5 } });
  const c0 = diodeCapacitance(p, 0, 0);
  const okC0 = approx(c0, 1e-9, 1e-12);

  const acCir = parseNetlist(`* reverse diode Cjo
Vin in 0 DC -2 AC 1
R1 in out 1k
D1 out 0 DCAP
.model DCAP D (Is=1e-14 Cjo=10n Vj=0.7 M=0.5)
.ac dec 10 1k 100Meg
.end`);
  const ac = acAnalysis(acCir);
  const db = ac.series["db(v(out))"];
  const dbLo = db[0];
  const dbHi = db[db.length - 1];
  // capacitive roll-off: HF much lower than LF
  const okAc = dbHi < dbLo - 10;

  const lCir = parseNetlist(`* L Rser
V1 in 0 DC 1
L1 in 0 1m Rser=100
.op
.end`);
  const ldc = dcOp(lCir);
  // DC: L short except Rser → I = 1/100
  const okRser = approx(Math.abs(ldc.currents.V1), 0.01, 1e-6);

  const ok = okC0 && okAc && okRser;
  console.log("diode Cjo + L Rser", c0, dbLo, dbHi, ldc.currents.V1, ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- C Rser + MOS Cgso ---
{
  const cCir = parseNetlist(`* cap ESR
Vin in 0 DC 0 AC 1
C1 in out 100n Rser=100
R1 out 0 100
.ac lin 2 1 100Meg
.end`);
  const c1 = cCir.devices.find((d) => d.name === "C1");
  const cac = acAnalysis(cCir);
  const dbC = cac.series["db(v(out))"];
  // HF: resistive divider 100/(100+100) → −6 dB
  const okEsr =
    (c1.rser ?? 0) === 100 &&
    approx(dbC[dbC.length - 1], -6.0206, 0.5);

  const { mosCaps, mosParams } = await import("../src/engine/mosfet.js");
  const mp = mosParams(
    { type: "NMOS", params: { cgso: 1e-3, cgdo: 5e-4, cox: 0 } },
    { w: 20e-6, l: 1e-6 }
  );
  const caps = mosCaps(mp, "sat");
  const okMosC = approx(caps.cgs, 1e-3 * 20e-6, 1e-15) && approx(caps.cgd, 5e-4 * 20e-6, 1e-15);

  const mosCir = parseNetlist(`* MOS Cgs roll-off
Vdd dd 0 DC 5
Vin in 0 DC 1.5 AC 1
Rg in g 10k
Mn out g 0 0 NMOS W=20u L=1u
Rd dd out 10k
.model NMOS NMOS (Vto=0.7 Kp=50u Lambda=0.02 Cgso=1e-3 Cgdo=1e-3)
.ac dec 10 1k 100Meg
.end`);
  const mac = acAnalysis(mosCir);
  const mdb = mac.series["db(v(out))"];
  const okRoll = mdb[mdb.length - 1] < mdb[0] - 5;

  const ok = okEsr && okMosC && okRoll;
  console.log("C Rser + MOS Cgs", dbC[dbC.length - 1], mdb[0], mdb[mdb.length - 1], ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- BJT Cje/Cjc ---
{
  const { bjtCaps, bjtParams } = await import("../src/engine/bjt.js");
  const p = bjtParams({ type: "NPN", params: { cje: 10e-12, cjc: 5e-12, tf: 0 } });
  const caps0 = bjtCaps(p, 0, 0, 0);
  const okC = approx(caps0.cbe, 10e-12, 1e-15) && approx(caps0.cbc, 5e-12, 1e-15);

  const cir = parseNetlist(`* BJT with Cje — AC roll-off
Vcc vcc 0 5
Vin in 0 DC 0.8 AC 1
Rb in b 10k
Q1 c b 0 NPN
Rc vcc c 1k
.model NPN NPN (Is=1e-15 Bf=100 Vaf=50 Cje=50p Cjc=20p)
.ac dec 10 1k 100Meg
.end`);
  const ac = acAnalysis(cir);
  const db = ac.series["db(v(c))"];
  const okRoll = db[db.length - 1] < db[0] - 3;

  const ok = okC && okRoll;
  console.log("BJT Cje/Cjc", caps0.cbe, db[0], db[db.length - 1], ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// --- richer .model + .disto ---
{
  const { diodeEval, diodeParams } = await import("../src/engine/diode.js");
  const pIkf = diodeParams({ params: { is: 1e-14, ikf: 1e-3 } });
  const hi = diodeEval(pIkf, 0.8);
  const no = diodeEval(diodeParams({ params: { is: 1e-14 } }), 0.8);
  const okIkf = hi.Id < no.Id * 0.95;

  const bjtR = parseNetlist(`* BJT RE
Vcc vcc 0 5
Vin in 0 DC 0.8
Rb in b 10k
Q1 c b 0 NPN
Rc vcc c 1k
.model NPN NPN (Is=1e-15 Bf=100 Re=100)
.op
.end`);
  const bdc = dcOp(bjtR);
  const okRe = bdc.nodes.c > 0.5 && bdc.nodes.c < 4.8;

  const mosR = parseNetlist(`* MOS RS
Vdd dd 0 5
Vin g 0 1.5
Mn out g 0 0 NMOS W=20u L=1u
Rd dd out 10k
.model NMOS NMOS (Vto=0.7 Kp=50u Rs=1k)
.op
.end`);
  const mdc = dcOp(mosR);
  const okRs = mdc.nodes.out > 0.5 && mdc.nodes.out < 5;

  const { distoAnalysis } = await import("../src/engine/disto.js");
  const dCir = parseNetlist(`* disto clipper
Vin in 0 DC 0 AC 1.5
R1 in out 1k
D1 out 0 D1
D2 0 out D1
.model D1 D (Is=1e-14 N=1)
.disto V(out) lin 3 1k 10k
.end`);
  const dist = distoAnalysis(dCir);
  const okDisto =
    dist.series.thd.length === 3 &&
    dist.series.thd.every((t) => Number.isFinite(t) && t >= 0) &&
    dist.series.thd.some((t) => t > 0.05);

  const ok = okIkf && okRe && okRs && okDisto;
  console.log(
    "model+disto",
    hi.Id,
    no.Id,
    bdc.nodes.c,
    dist.series.thd[0],
    ok ? "PASS" : "FAIL"
  );
  if (!ok) process.exitCode = 1;
}

// --- convergence helpers + .pz + .mc ---
{
  const easy = parseNetlist(`* options parse
V1 a 0 1
R1 a 0 1k
.option gminsteps=5 srcsteps=7
.op
.end`);
  const edc = dcOp(easy);
  const okOpt =
    easy.options.gminSteps === 5 &&
    easy.options.srcSteps === 7 &&
    edc.method === "direct" &&
    approx(edc.nodes.a, 1, 1e-9);

  const { pzAnalysis } = await import("../src/engine/pz.js");
  const pzCir = parseNetlist(`* RC pole
Vin in 0 DC 0
R1 in out 1k
C1 out 0 1u
.pz V(out)
.end`);
  const pz = pzAnalysis(pzCir);
  const pole = pz.poles.find((p) => Math.abs(p.im) < 1 && Math.abs(p.re + 1000) < 200);
  const okPz = !!pole && pz.poles.every((p) => Math.hypot(p.re, p.im) < 1e12);

  const { mcAnalysis } = await import("../src/engine/mc.js");
  const mcCir = parseNetlist(`* MC divider
V1 in 0 5
R1 in out 1k lot=10%
R2 out 0 1k lot=10%
.mc 30 seed=2
.end`);
  const mc = mcAnalysis(mcCir);
  const st = mc.stats["v(out)"];
  const okMc =
    mc.points >= 20 &&
    st &&
    approx(st.mean, 2.5, 0.35) &&
    st.std > 0.01;

  const ok = okOpt && okPz && okMc;
  console.log(
    "conv+pz+mc",
    edc.method,
    pole?.re,
    st?.mean,
    st?.std,
    ok ? "PASS" : "FAIL"
  );
  if (!ok) process.exitCode = 1;
}

console.log(process.exitCode ? "SOME FAILED" : "ALL PASS");
