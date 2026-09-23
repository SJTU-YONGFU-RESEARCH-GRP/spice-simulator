// Region-annotation runtime. Injected into
// site/assets/spice-simulation-surface-<hash>.js by scripts/patch-outbound.mjs
// from scripts/region-annotate.json, which is itself generated from this file
// by scripts/region-annotate.manifest.cjs. Edit HERE, not in the artifact.
//
// WHAT THIS IS. The Operating Point tab already draws a per-device table of
// VGS / VDS / VBS / ID (component `Ut`, labelled "MOS operating-point details").
// Those four numbers are the whole input a reader needs to tell which region the
// transistor is in, and the screen said nothing about it: the shipped example
// sits at VDS = 41.6 mV against Vov = 400 mV, i.e. firmly in the linear region
// while looking like an amplifier. This adds one line of interpretation under
// that table, with the quantities it used, so the reader can check the call
// rather than take a word for it.
//
// WHY IT IS COMPUTED HERE AND NOT MEASURED. A region is not a measurement: it is
// a reading of measurements that are already on screen. Adding it to the
// automatic summary would have meant a new name in the artifact schema's CLOSED
// `metric` enum (files-DP-BVVb4.js, declared twice), and a name missing there
// makes the client reject the WHOLE result artifact -- the user loses the tables
// they already had. So nothing here touches the payload, the schema, or the
// metric enum, and the row appears with the device it describes rather than in a
// file nobody opened.
//
// WHERE THE NUMBERS COME FROM. Not from the run. The deck carries only
// `.include ".../cmos.lib"` plus a `.param __cn_sel=<v>` selector -- no `.model`
// line, no VTO, no LEVEL -- and log.txt and out.raw carry no device parameters
// either (measured, see analysis/_evidence/_d3_recon_2026-09-23.log). The
// parameters live in site/models/cmos.lib, they are `{...}` EXPRESSIONS whose
// value moves with the corner, and `rgTable` is that file pre-resolved to a
// (base, coefficient) pair per parameter so that nothing has to evaluate an
// expression at runtime. Check 19 re-derives the table from cmos.lib and fails
// any tree where the two disagree.
//
// WHAT IT REFUSES TO DO. A model that is not in the table (anything above
// LEVEL=1, which is every BSIM model, plus any model added to the library later
// without coming through this manifest), a corner selector outside tt/ss/ff, an
// unavailable VGS/VDS/VBS, or a body bias that makes PHI+VSB non-positive all
// produce NO line at all. It does not guess and it does not print "unsupported":
// a card that says it cannot tell you something is worse than a card that says
// nothing, because the first one invites the question and the second one is just
// the card the user had before.
//
// SIGN CONVENTION. The payload's VGS/VDS/VBS are signed V(G)-V(S) and friends,
// and a PMOS carries a negative VTO. One sign flip applied to the bias, to VTO
// and to the region comparison keeps a single set of inequalities, which is the
// only way the PMOS branch does not come out one region off.
var rgTable = __RG_TABLE__;
function rgFmt(v) {
  let m = Math.abs(v);
  return m === 0 ? `0 V` : m < 1e-3 ? `${(v * 1e6).toPrecision(4)} µV` : m < 1 ? `${(v * 1e3).toPrecision(4)} mV` : `${v.toPrecision(4)} V`;
}
// Model name for one operating-point device: device.documentId + device.instanceId
// back to the instance that carries it. `surface` already walks documents this
// way when it lists sources, so this adds no new mechanism.
function rgModel(docs, dev) {
  for (let doc of docs ?? []) {
    if (doc.id !== dev.documentId) continue;
    for (let inst of doc.instances ?? []) if (inst.id === dev.instanceId) return inst.netlist?.binding?.name ?? null;
  }
  return null;
}
// One device plus the run's corner selector -> one line of text, or null to refuse.
function rgDevice(dev, sel, docs) {
  let model = rgModel(docs, dev);
  if (model === null) return null;
  let p = rgTable[model];
  if (!p) return null;
  let vgs = null, vds = null, vbs = null;
  for (let v of dev.values ?? []) {
    if (v.status !== `available`) continue;
    if (v.parameter === `vgs`) vgs = v.value;
    else if (v.parameter === `vds`) vds = v.value;
    else if (v.parameter === `vbs`) vbs = v.value;
  }
  if (typeof vgs !== `number` || typeof vds !== `number` || typeof vbs !== `number`) return null;
  let s = p.type === `pmos` ? -1 : 1;
  let VGS = s * vgs, VDS = s * vds, VBS = s * vbs;
  let VTO = s * (p.vto[0] + p.vto[1] * sel);
  let PSI = p.phi - VBS;
  if (!(PSI > 0)) return null;
  let VTH = VTO + p.gamma * (Math.sqrt(PSI) - Math.sqrt(p.phi));
  let VOV = VGS - VTH;
  if (!(VOV > 0)) return `Region  Cutoff · Vov = ${rgFmt(VOV)}`;
  if (Math.abs(VDS - VOV) <= 0.02 * Math.abs(VOV)) return `Region  At the edge of saturation · Vov ≈ VDS = ${rgFmt(VDS)}`;
  return VDS < VOV ? `Region  Linear · Vov = ${rgFmt(VOV)} > VDS = ${rgFmt(VDS)}` : `Region  Saturation · VDS = ${rgFmt(VDS)} ≥ Vov = ${rgFmt(VOV)}`;
}
// Which corner the run actually used. `section` is the value the deck assembler
// reads to decide whether to emit `.param __cn_sel`; null/absent/'tt' means it
// emitted nothing and the library's own `= 0` stands. An unrecognised selector
// annotates nothing rather than assuming tt.
function rgAnnotate(project, run) {
  let section = run?.result?.metadata?.configuration?.modelLibrary?.section;
  let sel = section === null || section === undefined || section === `` || section === `tt` ? 0 : section === `ss` ? 1 : section === `ff` ? -1 : null;
  let devices = run?.outputData?.deviceOperatingPoints ?? [];
  if (sel === null) return devices;
  let docs = project?.documents ?? [];
  return devices.map((dev) => {
    let line = rgDevice(dev, sel, docs);
    return line === null ? dev : { ...dev, region: line };
  });
}
