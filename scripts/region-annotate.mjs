#!/usr/bin/env node
/**
 * Is the region line actually on the screen, and is it the one the shipped
 * bytes compute?
 *
 *   node scripts/region-annotate.mjs [--site=<dir>] [--require]
 *
 * The unit-level questions (does the arithmetic pick the right region, does it
 * refuse a BSIM model, does the PMOS branch mirror correctly) belong to
 * scripts/region-annotate.oracle.mjs, which needs no browser. This harness
 * answers the three questions only a browser can:
 *
 *   1. Does the row appear at all, on the shipped example, in the tab a reader
 *      actually opens? The card it belongs to is on the Operating Point tab, and
 *      that tab is not the one the page opens by default once a run contains
 *      dc/ac/tran (xn() picks `plot` for those), so "it is not visible" is the
 *      default state of a working feature.
 *   2. Is the text on screen the text the artifact computes? Rather than
 *      restating the expectation here -- which would pass even if the artifact's
 *      own logic drifted, as long as this file drifted with it -- the harness
 *      lifts the injected runtime OUT OF THE ARTIFACT, runs it in a vm, and feeds
 *      it the very device record the page is drawing. The two must agree exactly.
 *   3. Do the parameters behind it match the one reference that is not this
 *      repository's own code: the engine's answer. The table says which region
 *      the transistor is in and predicts the drain current from
 *      site/models/cmos.lib; the page carries the current ngspice computed. A
 *      wrong model, a wrong corner or a wrong sign convention moves that
 *      comparison by tens of percent, not by rounding.
 *
 * The device record is taken from the page's own run state rather than scraped
 * from the table, because the table prints six significant figures and the
 * current comparison above needs every digit the engine produced.
 *
 * Exit codes: 0 reported, 1 a --require assertion failed, 2 the harness could
 * not run (no browser, no surface chunk, page never settled).
 */
import { existsSync, readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const argv = process.argv.slice(2);
const siteArg = argv.find((a) => a.startsWith('--site='));
const SITE = siteArg ? resolve(siteArg.slice('--site='.length)) : join(REPO, 'site');
const REQUIRE = argv.includes('--require');
const EX = 'common-source-amplifier';
const TMP = join(REPO, '..', '.rgtest', 'tmp');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = [];
let failed = 0;
let skipped = 0;
function check(name, pass, detail) {
  report.push({ name, pass: !!pass });
  if (!pass) failed += 1;
  console.log((pass ? '  ok   ' : '  FAIL ') + name + (detail === undefined ? '' : '   ' + detail));
}
function skip(name, why) { skipped += 1; console.log('  skip  ' + name + '   ' + why); }

mkdirSync(TMP, { recursive: true });

// --- lift the injected runtime out of the artifact --------------------------
const assetsDir = join(SITE, 'assets');
let names;
try { names = readdirSync(assetsDir).filter((f) => /^spice-simulation-surface-.*\.js$/.test(f)); }
catch (e) { console.error('cannot read ' + assetsDir + ': ' + e.message); process.exit(2); }
if (names.length !== 1) { console.error('expected one surface chunk under ' + assetsDir + ', found ' + names.length); process.exit(2); }
const surface = readFileSync(join(assetsDir, names[0]), 'utf8');
const from = surface.indexOf('var rgTable = {');
const to = surface.indexOf('var Ht=', from);
if (from === -1 || to === -1) {
  console.error('the artifact carries no injected runtime; run scripts/patch-outbound.mjs --manifest=scripts/region-annotate.json first');
  process.exit(2);
}
const injected = surface.slice(from, to);
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(injected + '\n', sandbox);
const { rgTable, rgDevice, rgAnnotate, rgModel } = sandbox;
if (!rgTable || typeof rgDevice !== 'function' || typeof rgAnnotate !== 'function') {
  console.error('the injected runtime did not define rgTable/rgDevice/rgAnnotate');
  process.exit(2);
}
console.log('artifact  = ' + names[0] + '  (' + injected.length + ' chars injected, ' + Object.keys(rgTable).length + ' models)');

// --- browser ---------------------------------------------------------------
const NODE = process.execPath;
const PORT = 9379, DP = 9879;
const srv = spawn(NODE, [join(REPO, 'scripts/serve-local.mjs'), '--port=' + PORT, '--base=/spice-simulator/', '--cache=public', '--site=' + SITE], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
let srvOut = ''; srv.stdout.on('data', (d) => { srvOut += d; }); srv.stderr.on('data', (d) => { srvOut += d; });
for (let i = 0; i < 40; i++) { try { const r = await fetch('http://127.0.0.1:' + PORT + '/spice-simulator/'); if (r.ok) break; } catch {} await sleep(300); }

const CHROME = process.env.CHROME_BIN || process.env.CHROME_PATH
  || ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']
    .find((p) => existsSync(p))
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
if (!existsSync(CHROME)) { console.error('no chrome at ' + CHROME + '; set CHROME_PATH'); try { srv.kill(); } catch {} process.exit(2); }
const profile = mkdtempSync(join(TMP, 'rg-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--mute-audio', '--user-data-dir=' + profile, '--remote-debugging-port=' + DP, '--no-first-run', '--no-default-browser-check', '--window-size=1600,1000', 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });

const finish = (code) => { try { chrome.kill(); } catch {} try { srv.kill(); } catch {} try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch {} process.exit(code); };

let ver = null;
for (let i = 0; i < 60 && !ver; i++) { try { const r = await fetch('http://127.0.0.1:' + DP + '/json/version'); if (r.ok) ver = await r.json(); } catch {} await sleep(250); }
if (!ver) { console.error('no devtools; server said: ' + srvOut.slice(0, 300)); finish(2); }

const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws')); });
let id = 0; const pending = new Map(); const events = [];
const send = (m, p = {}, s) => new Promise((res, rej) => { const msg = { id: ++id, method: m, params: p }; if (s) msg.sessionId = s; pending.set(msg.id, { res, rej }); ws.send(JSON.stringify(msg)); });
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; } if (m.method) events.push(m); };
await send('Target.setDiscoverTargets', { discover: true });
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
for (const d of ['Page', 'Runtime', 'Log']) await send(d + '.enable', {}, sessionId);
const evalv = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId); if (r.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text).slice(0, 600) }; return r.result?.value; };
const poll = async (fn, ms, iv) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() >= end) return null; await sleep(iv); } };
const load = (f, ms) => poll(() => events.slice(f).some((m) => m.method === 'Page.loadEventFired') || null, ms, 200);
const clickText = "(function(NAME){const tt=(e)=>(e.textContent||'').replace(/\\s+/g,' ').trim();const b=[...document.querySelectorAll('button,[role=tab],a')].filter(x=>tt(x)===NAME).filter(x=>{const r=x.getBoundingClientRect();return r.width>0&&r.height>0});if(!b.length)return false;b[0].click();return true;})";

const BASE = 'http://127.0.0.1:' + PORT + '/spice-simulator/';
const f0 = events.length;
await send('Page.navigate', { url: BASE }, sessionId); await load(f0, 20000); await sleep(1200);
const f1 = events.length;
await send('Page.navigate', { url: BASE + '?example=' + EX }, sessionId); await load(f1, 20000);
const ready = await poll(async () => {
  const r = await evalv("({p:location.pathname+location.search,op:/Opened example:/.test(document.body?document.body.innerText:''),btn:!!document.querySelector('button.simulation-run-button')})");
  return (r && !r.__error && r.p.endsWith('?example=' + EX) && r.op && r.btn) ? r : null;
}, 40000, 600);
if (!ready) { console.error('page never became ready'); finish(2); }

const chip = () => evalv("(function(){const c=document.querySelector('.simulation-status-chip');return c?{cls:c.className}:null;})()");
await evalv("(function(){const b=[...document.querySelectorAll('button.simulation-run-button')].filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0});if(b.length)b[0].click();return b.length;})()");
const left = await poll(async () => { const c = await chip(); return (c && !/simulation-status-idle/.test(c.cls || '')) ? c : null; }, 90000, 300);
const settled = (left && /simulation-status-(finished|failed|error)/.test(left.cls || '')) ? left
  : await poll(async () => { const c = await chip(); return (c && /simulation-status-(finished|failed|error)/.test(c.cls || '')) ? c : null; }, 90000, 400);
check('the run settled', settled && /finished/.test(settled.cls), settled ? settled.cls.replace('simulation-status-chip ', '') : 'never left idle');
await sleep(1500);
await evalv(clickText + "('Operating Point')"); await sleep(1500);

// What the page drew, and what the run it drew it from actually says. The tab is
// opened explicitly: the page auto-selects `plot` whenever a run carries
// dc/ac/tran, so the Operating Point tab is not where a reader lands.
const drawn = await evalv(`(function(){
  const tt=(e)=>(e.textContent||'').replace(/\\s+/g,' ').trim();
  const c=document.querySelector('.simulation-device-operating-points');
  if(!c) return {found:false};
  return {found:true, card:tt(c.querySelector('h3')), devices:[...c.querySelectorAll('section[aria-label$=" details"]')].map(s=>{
    const cells={};
    for(const tr of s.querySelectorAll('tbody tr')){ const th=tr.querySelector('th'), td=tr.querySelector('td'); if(th&&td) cells[tt(th)]=tt(td); }
    const r=s.querySelector('.simulation-device-region');
    // textContent, not the whitespace-collapsed form used for the numeric cells:
    // the line's own spacing is part of what the artifact produced, and comparing
    // against the collapsed form would let a spacing change through unnoticed.
    return {aria:s.getAttribute('aria-label'), head:tt(s.querySelector('header')), cells, region:r?r.textContent:null, regionClass:r?r.getAttribute('class'):null};
  })};
})()`);

check('the Operating Point tab draws the devices card', drawn && drawn.found === true, drawn && drawn.__error ? drawn.__error : (drawn && drawn.card));
const shown = (drawn && drawn.devices) || [];
check('the card lists at least one device', shown.length > 0, shown.length + ' device(s)');
const shownDev = shown[0] || null;
check('the row repair put a region line on the card', !!(shownDev && shownDev.region), shownDev && shownDev.region ? JSON.stringify(shownDev.region) : 'no .simulation-device-region under the device');
check('the region line carries its own class', !!(shownDev && /simulation-device-region/.test(shownDev.regionClass || '')));

// The run state behind that card: full-precision device values, the project it
// belongs to, and the corner selector the deck assembler saw.
const state = await evalv(`(function(){
  const el=document.querySelector('.simulation-device-operating-points');
  if(!el) return {found:false};
  const key=Object.keys(el).find(k=>k.indexOf('__reactFiber')===0);
  if(!key) return {found:false,why:'no fiber key'};
  let f=el[key];
  while(f){
    if(typeof f.type==='function'&&f.memoizedState){
      let h=f.memoizedState,i=0;
      while(h&&i<70){
        const v=h.memoizedState;
        if(v&&typeof v==='object'&&!Array.isArray(v)&&v.outputData){
          const md=v.result&&v.result.metadata;
          const ml=md&&md.configuration&&md.configuration.modelLibrary;
          let g=f,proj=null;
          while(g){ const p=g.memoizedProps; if(p&&p.project&&p.project.documents){ proj=p.project; break } g=g.return; }
          return {
            found: true,
            section: ml? (ml.section===undefined?'<absent>':ml.section===null?'<null>':String(ml.section)) : '<no path>',
            devices: v.outputData.deviceOperatingPoints.map(d=>({id:d.id,documentId:d.documentId,instanceId:d.instanceId,reference:d.reference,polarity:d.polarity,
              values:d.values.map(x=>({parameter:x.parameter,label:x.label,unit:x.unit,status:x.status,value:x.value}))})),
            mos: proj? proj.documents.reduce((a,d)=>a.concat((d.instances||[]).filter(x=>x.netlist&&x.netlist.binding&&x.netlist.binding.deviceClass==='mos').map(x=>({documentId:d.id,instanceId:x.id,name:x.netlist.binding.name}))),[]) : null,
            documents: proj? proj.documents.map(d=>({id:d.id, instances:(d.instances||[]).map(x=>({id:x.id, netlist:x.netlist?{binding:x.netlist.binding}:undefined}))})) : null
          };
        }
        h=h.next;i++;
      }
    }
    f=f.return;
  }
  return {found:false,why:'no run state on the fiber chain'};
})()`);

check('the run state behind the card is readable', !!(state && state.found), state && state.__error ? state.__error : JSON.stringify(state).slice(0, 500));
const selOf = (s) => s === '<null>' || s === '<absent>' || s === 'tt' ? 0 : s === 'ss' ? 1 : s === 'ff' ? -1 : null;
const sel = state && state.found ? selOf(state.section) : null;
check('the corner the deck assembler saw is readable from the run', sel !== null, state && state.found ? 'section=' + state.section + ' -> __cn_sel=' + sel : undefined);

if (shownDev && state && state.found && state.devices && state.devices.length) {
  const record = state.devices[0];
  const expected = sel === null ? null : rgDevice(record, sel, state.documents);
  check('the artifact computes the same line the page drew', expected === shownDev.region,
    'artifact=' + JSON.stringify(expected) + '  page=' + JSON.stringify(shownDev.region));
  check('the line names a region', /^Region\s+(Linear|Saturation|Cutoff|At the edge of saturation)/.test(shownDev.region || ''), JSON.stringify(shownDev.region || ''));
  check('the line shows the quantities that decided it', /Vov =|VDS =/.test(shownDev.region || ''));

  // The reference that is not this repository's own code.
  const model = (state.mos || []).find((m) => m.instanceId === record.instanceId);
  check('the model the device is bound to is readable from the schematic', !!(model && rgTable[model.name]), model ? model.name : 'no binding name');
  if (model && rgTable[model.name]) {
    const p = rgTable[model.name];
    const get = (k) => { const v = record.values.find((x) => x.parameter === k); return v && v.status === 'available' ? v.value : null; };
    const vgs = get('vgs'), vds = get('vds'), vbs = get('vbs'), iEngine = get('id');
    if ([vgs, vds, vbs, iEngine].every((x) => typeof x === 'number') && iEngine !== 0) {
      const W = 10e-6, L = 0.18e-6; // the example's instance parameters
      const VTO = p.vto[0] + p.vto[1] * (sel ?? 0);
      const PSI = p.phi - vbs;
      const VTH = VTO + p.gamma * (Math.sqrt(PSI) - Math.sqrt(p.phi));
      const VOV = vgs - VTH;
      const KP = p.kp[0] + p.kp[1] * (sel ?? 0);
      const wl = W / L;
      const iLinear = KP * wl * ((VOV * vds) - vds * vds / 2) * (1 + p.lambda * vds);
      const iSat = (KP / 2) * wl * VOV * VOV * (1 + p.lambda * vds);
      const relL = Math.abs(iLinear - iEngine) / Math.abs(iEngine);
      const relS = Math.abs(iSat - iEngine) / Math.abs(iEngine);
      check('the parameters reproduce the engine drain current', relL < 1e-6,
        'VGS=' + vgs + ' VDS=' + vds + ' -> LEVEL-1 linear formula ' + iLinear.toExponential(8) + ' vs engine ' + iEngine.toExponential(8) + ' (rel ' + relL.toExponential(3) + ')');
      if (/Linear/.test(shownDev.region || '')) check('and only the region the row claims reproduces it', relL < relS, 'linear rel ' + relL.toExponential(3) + ' vs saturation rel ' + relS.toExponential(3));
      else if (/Saturation/.test(shownDev.region || '')) check('and only the region the row claims reproduces it', relS < relL, 'saturation rel ' + relS.toExponential(3) + ' vs linear rel ' + relL.toExponential(3));
      else skip('and only the region the row claims reproduces it', 'the row is ' + shownDev.region);
    } else {
      check('the run state carries VGS/VDS/VBS/ID to compare against the engine', false, JSON.stringify(record.values.map((v) => v.parameter + '=' + v.value)));
    }
  }
}

console.log('');
// PMOS coverage. The arithmetic branch is proven in the oracle (4/4 sign flips),
// and the nmos model LOOKUP is proven above against the live schematic. The one
// link never exercised on a real device is the PMOS branch end-to-end. The
// runnable example loads as a single NMOS plus passives (the diagnostic dump
// below shows the runtime schematic, which is the ground truth -- a static
// payload scan that disagrees with it is the scan that is wrong), and the PMOS
// examples are locked and several use sky130 BSIM models that the table
// deliberately refuses. So we prove the PMOS path with a SYNTHETIC instance that
// carries a real pmos table entry and feeds the EXACT runtime the artifact
// ships (rgModel -> rgDevice), rather than guessing which locked example is
// annotatable. The on-screen render of a pmos line is the same code path as the
// nmos line already proven (one field, one class, polarity absorbed into the
// bias), so a correct lookup + arithmetic is sufficient.
const docs = (state && state.found) ? state.documents : null;
if (docs) {
  const dump = [];
  for (const d of docs) for (const inst of d.instances || []) {
    const b = inst.netlist && inst.netlist.binding;
    dump.push({ documentId: d.id, instanceId: inst.id, name: b ? b.name : '<no binding>', deviceClass: b ? b.deviceClass : '<none>', inTable: !!(b && b.name && rgTable[b.name]) });
  }
  console.log('  [diag] runtime schematic instances (' + dump.length + '):');
  for (const x of dump) console.log('    ' + x.instanceId + '  name=' + JSON.stringify(x.name) + '  class=' + JSON.stringify(x.deviceClass) + '  inTable=' + x.inTable);
  const all = dump.filter((x) => x.inTable);
  check('every schematic MOS instance resolves its model through the card lookup', all.length > 0 && all.every((x) => rgModel(docs, { documentId: x.documentId, instanceId: x.instanceId }) === x.name), all.length + ' resolvable: ' + all.map((x) => x.name).join(', '));
}
// Synthetic PMOS path: a real pmos entry from the table, a real binding name,
// real bias magnitudes. This is the same lookup+arithmetic the card uses.
const pmosModel = Object.keys(rgTable).find((k) => rgTable[k].type === 'pmos');
if (pmosModel) {
  const synthDocs = [{ id: 'doc-pmos', instances: [{ id: 'X1', netlist: { binding: { name: pmosModel, deviceClass: 'mos' } } }] }];
  const synthRec = { documentId: 'doc-pmos', instanceId: 'X1', values: [
    { parameter: 'vgs', status: 'available', value: -0.8 },
    { parameter: 'vds', status: 'available', value: -0.05 },
    { parameter: 'vbs', status: 'available', value: 0 },
  ] };
  check('a PMOS binding name resolves through the same rgModel lookup', rgModel(synthDocs, { documentId: 'doc-pmos', instanceId: 'X1' }) === pmosModel, pmosModel);
  const line = rgDevice(synthRec, 0, synthDocs);
  check('a PMOS device is judged by the PMOS branch (vgs=-0.8, vds=-0.05 -> Linear)', /^Region\s+Linear/.test(line || ''), JSON.stringify(line));
  const p = rgTable[pmosModel];
  const noFlip = (() => { let s = 1, VGS = s * -0.8, VDS = s * -0.05, VBS = 0; let VTO = s * p.vto[0]; let PSI = p.phi - VBS; if (!(PSI > 0)) return 'refused'; let VTH = VTO + p.gamma * (Math.sqrt(PSI) - Math.sqrt(p.phi)); let VOV = VGS - VTH; return VOV > 0 ? (VDS < VOV ? 'Linear' : 'Saturation') : 'Cutoff'; })();
  check('without the PMOS sign flip the same numbers would be misjudged', noFlip !== 'Linear', 'no-flip would say ' + noFlip + '; with flip says Linear');
} else {
  skip('a PMOS device is judged by the PMOS branch', 'no pmos entry in rgTable');
}

console.log(failed === 0 ? 'RESULT: all ' + report.length + ' checks passed' + (skipped ? ' (' + skipped + ' skipped)' : '') : 'RESULT: ' + failed + ' of ' + report.length + ' checks FAILED');
console.log('  site = ' + SITE);
finish(REQUIRE && failed ? 1 : 0);
