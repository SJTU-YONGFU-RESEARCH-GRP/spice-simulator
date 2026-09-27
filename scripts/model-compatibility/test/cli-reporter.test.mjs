import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { analyzeSource, scanFiles, parseArgs } from '../cli.mjs';
import { stableJSON, buildReport, terminalReport } from '../reporter.mjs';
const CLI=fileURLToPath(new URL('../../model-compatibility.mjs',import.meta.url));

for (const alias of ['exact', 'case', 'normalized', 'hard-link', 'independent']) {
  test(`CLI output identity: ${alias}; input bytes are preserved`, t => {
    const dir = mkdtempSync(join(tmpdir(), 'model-path-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const input = join(dir, 'input.lib');
    const source = Buffer.from('.model safe NMOS LEVEL=1\r\n');
    writeFileSync(input, source);
    let output = input;
    if (alias === 'case') {
      output = join(dir, 'INPUT.LIB');
      if (!existsSync(output)) return t.skip('Filesystem is case-sensitive');
    } else if (alias === 'normalized') {
      mkdirSync(join(dir, 'child'));
      output = `${dir}/./child/../input.lib`;
    } else if (alias === 'hard-link') {
      output = join(dir, 'alias.json');
      linkSync(input, output);
    } else if (alias === 'independent') output = join(dir, 'report.json');
    const result = spawnSync(process.execPath, [CLI, './input.lib', '--json', '--output', output],
      { cwd: dir, encoding: 'utf8', windowsHide: true });
    assert.deepEqual(readFileSync(input), source);
    assert.equal(result.status, alias === 'independent' ? 0 : 3, result.stderr);
    if (alias === 'independent') {
      assert.equal(JSON.parse(result.stdout).exitCode, 0);
      assert.equal(result.stdout, readFileSync(output, 'utf8'));
    } else {
      assert.equal(JSON.parse(result.stderr).diagnostics[0].code, 'TOOL_001');
      assert.match(result.stderr, /must not overwrite an input file/);
    }
  });
}

test('default scan is static; dependencies and non-MOS remain explicitly untested', () => {
  assert.equal(analyzeSource('.model n NMOS LEVEL=1','n.lib')[0].runtime.status,'NOT_RUN');
  assert.equal(analyzeSource('.include "x"\n.model n NMOS LEVEL=1','n.lib',{runtime:true})[0].runtime.status,'NOT_RUN');
  assert.equal(analyzeSource('.model b NPN IS=1e-16','n.lib',{runtime:true})[0].static,'UNSUPPORTED');
  assert.equal(analyzeSource('.subckt x a b\nR1 a b 1k\n.ends','x.lib')[0].static,'WARNING');
  assert.equal(analyzeSource('.model','bad.lib')[0].static,'INVALID');
});
test('deterministic JSON keys and row sorting', () => {
  const a=analyzeSource('.model a NMOS LEVEL=1','a.lib');
  const b=analyzeSource('.model b PMOS LEVEL=1','b.lib');
  assert.equal(stableJSON(buildReport([...a,...b])),stableJSON(buildReport([...b,...a])));
  assert.equal(stableJSON({b:1,a:2}),stableJSON({a:2,b:1}));
  assert.match(terminalReport(buildReport([...a,...b])),/Static.*Runtime.*Diagnostic/);
  assert.ok(buildReport(a).capabilityMatrix.every(c=>c.shippedWasm==='UNVERIFIED'));
});
test('exit-code priority and structured summary', () => {
  assert.equal(buildReport(analyzeSource('.model n NMOS LEVEL=1','n')).exitCode,0);
  assert.equal(buildReport(analyzeSource('.model n NMOS','n')).exitCode,1);
  assert.equal(buildReport(analyzeSource('.model n NMOS LEVEL=999','n')).exitCode,2);
  const rows=analyzeSource('.model n NMOS LEVEL=1','n',{runtime:true,probe:()=>({status:'TOOL_ERROR',diagnostics:[]})});
  assert.equal(buildReport(rows).exitCode,3);
});
test('CLI argument validation', () => {
  assert.equal(parseArgs([]).input,'site/models');
  for(const args of [['--oops'],['a','b'],['--output'],['--output','--json']]) assert.throws(()=>parseArgs(args));
});
test('CLI writes stable reports, scans deterministically and returns all documented codes', () => {
  const dir=mkdtempSync(join(tmpdir(),'model-cli-'));
  try {
    const output=join(dir,'report.json'), path=join(dir,'input.lib');
    const run=(args)=>spawnSync(process.execPath,[CLI,...args,'--output',output],{encoding:'utf8',windowsHide:true});
    for(const [source,status] of [['.model n NMOS LEVEL=1',0],['.model n NMOS',1],['.model n NMOS LEVEL=999',2]]) {
      writeFileSync(path,source);const r=run([path,'--json']);assert.equal(r.status,status,r.stderr);
      assert.equal(JSON.parse(r.stdout).exitCode,status);
    }
    writeFileSync(path,'.model n NMOS LEVEL=1');
    run([path]);const first=readFileSync(output,'utf8');run([path]);assert.equal(readFileSync(output,'utf8'),first);
    assert.equal(run([join(dir,'missing')]).status,3);
    writeFileSync(join(dir,'a.mod'),'.model a PMOS LEVEL=1');
    writeFileSync(join(dir,'ignored.txt'),'ignore');
    assert.deepEqual(scanFiles(dir).map(p=>p.split(/[\\/]/).pop()),['a.mod','input.lib']);
    const overwrite=spawnSync(process.execPath,[CLI,path,'--output',path],{encoding:'utf8',windowsHide:true});
    assert.equal(overwrite.status,3);assert.equal(readFileSync(path,'utf8'),'.model n NMOS LEVEL=1');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
