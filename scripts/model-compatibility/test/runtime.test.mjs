import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseModels } from '../parser.mjs';
import { probeModel, probeDeck, classifyEngine, buildProbe } from '../runtime-probe.mjs';
import { stableJSON } from '../reporter.mjs';
import { analyzeSource } from '../cli.mjs';
import { localizeFailure } from '../failure-localizer.mjs';
const model = card => parseModels(card).models[0];
const result = () => ({ exitStatus:0, exception:null, stdout:[], stderr:[], rawPresent:true,
  parsed:{plotname:'DC transfer characteristic',variables:[{name:'v(d)'},{name:'v(g)'},{name:'i(vds)'}],points:Array.from({length:19},()=>['1','0','0'])} });

test('real shipped WASM: NMOS/PMOS across LEVEL1/2/3/8/49/14/54', () => {
  for (const level of [1,2,3,8,49,14,54]) for (const type of ['NMOS','PMOS']) {
    const version = [8,49].includes(level) ? ' VERSION=3.3.0' : [14,54].includes(level) ? ' VERSION=4.8.1' : '';
    const r = probeModel(model(`.model n ${type} LEVEL=${level}${version}`));
    assert.ok(['PASS','WARNING'].includes(r.status), JSON.stringify(r));
    assert.equal(r.validResult,true);
    assert.equal(r.pointCount,19);
  }
});
test('real negative control: unknown parameter fails engine despite static warning', () => {
  const r = analyzeSource('.model n NMOS LEVEL=8 QMTCENCV=0', 'negative.lib', {runtime:true});
  assert.equal(r[0].static,'WARNING');
  assert.equal(r[0].runtime.status,'RUNTIME_FAILURE');
  assert.match(JSON.stringify(r[0].runtime), /strtod: Invalid argument/);
  assert.equal(r[0].localization.oneMinimal,true);
});
test('real static PASS is not runtime PASS: numerically invalid device physics', () => {
  const [r] = analyzeSource('.model n NMOS LEVEL=8 VERSION=3.3.0 TOX=-3n', 'physics.lib', {runtime:true,localize:false});
  assert.equal(r.static,'PASS');
  assert.equal(r.runtime.status,'RUNTIME_FAILURE');
});
test('real two intake models: failure, reproduction and reduction evidence', () => {
  for (const type of ['nmos','pmos']) {
    const source=readFileSync(new URL(`../../../site/models/${type}_bsim3v3.ngspice`,import.meta.url),'utf8');
    const m=model(source), original=probeModel(m);
    assert.equal(original.status,'RUNTIME_FAILURE');
    assert.equal(original.rawPresent,false);
    const included = probeDeck(buildProbe(m, [], '.include "/models/intake.lib"'), { files: { '/models/intake.lib': source } });
    assert.equal(included.status, 'RUNTIME_FAILURE');
    assert.match(JSON.stringify(included.diagnostics), /strtod: Invalid argument/);
    const r=localizeFailure(m,original,card=>probeModel(m,[],{},card));
    assert.equal(r.status,'LOCALIZED');
    assert.equal(r.oneMinimal,true);
    assert.ok(r.suspectedParameters.length<m.parameters.length);
  }
});
test('real runtime evidence is deterministic across independent processes', () => {
  const m = model('.model n NMOS LEVEL=8 VERSION=3.3.0');
  assert.equal(stableJSON(probeModel(m)), stableJSON(probeModel(m)));
});
test('batch failure is isolated; subsequent real probe still passes', () => {
  const rows=analyzeSource('.model bad NMOS LEVEL=8 QMTCENCV=0\n.model good PMOS LEVEL=1 VTO=-0.4','batch.lib',{runtime:true,localize:false});
  assert.deepEqual(rows.map(r=>r.runtime.status),['RUNTIME_FAILURE','PASS']);
});
test('engine setup error and actual deck without simulation result', () => {
  assert.equal(probeDeck('test\n.end',{vendor:'missing-engine.mjs'}).status,'TOOL_ERROR');
  assert.equal(probeDeck('no analysis\nR1 1 0 1k\n.end').status,'RUNTIME_FAILURE');
});
test('classifier rejects absent, empty, truncated, nonfinite, wrong plot and failing exit', () => {
  assert.equal(classifyEngine(result()).status,'PASS');
  for (const mutate of [r=>r.rawPresent=false,r=>r.parsed.points=[],r=>r.parsed.points[0]=['NaN','0','0'],r=>r.parsed.points.pop(),r=>r.parsed.variables=[],r=>r.parsed.plotname='Operating Point',r=>r.exitStatus=1,r=>r.exception='abort',r=>r.stderr=['Error: model broken']]) {
    const r=result();mutate(r);assert.equal(classifyEngine(r).status,'RUNTIME_FAILURE');
  }
  const warning=result();warning.stderr=['Warning: parameter ignored'];
  assert.equal(classifyEngine(warning).status,'WARNING');
});
test('worker timeout, crash, corrupt protocol and setup are distinct', () => {
  const run=reply=>probeDeck('unused',{spawn:()=>reply});
  assert.equal(run({error:{code:'ETIMEDOUT'}}).failureKind,'timeout');
  assert.equal(run({status:1}).status,'TOOL_ERROR');
  assert.equal(run({status:0,stdout:'not-json'}).failureKind,'worker-protocol');
  assert.equal(run({status:0,stdout:'MODEL_PROBE_RESULT={oops}\n'}).status,'TOOL_ERROR');
});
