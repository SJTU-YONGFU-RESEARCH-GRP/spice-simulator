import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseModels, numericValue } from '../parser.mjs';
import { analyzeModel } from '../rules.mjs';
const fixture = name => readFileSync(new URL('./fixtures/' + name, import.meta.url), 'utf8');
const check = source => { const p = parseModels(source); return p.models.map(m => analyzeModel(m, p)); };

test('LEVEL1 NMOS/PMOS, parentheses, continuation, metadata', () => {
  const parsed = parseModels(fixture('level1.lib'));
  assert.equal(parsed.models.length, 2);
  assert.equal(parsed.models[0].parameterCount, 6);
  assert.equal(parsed.models[0].level, 1);
  assert.equal(parsed.models[1].type, 'PMOS');
  assert.deepEqual(check(fixture('level1.lib')).map(r => r.status), ['PASS', 'PASS']);
});
test('BSIM3/4 dotted VERSION syntax and family aliases', () => {
  assert.deepEqual(check(fixture('bsim.lib')).map(r => [r.family, r.status]), [['BSIM3', 'PASS'], ['BSIM4', 'PASS']]);
  for (const [level, family] of [[2,'MOS2'],[3,'MOS3'],[49,'BSIM3'],[54,'BSIM4']]) assert.equal(check(`.model n NMOS LEVEL=${level}`)[0].family, family);
});
test('malformed declarations, unclosed structures, orphan continuation', () => {
  assert.equal(parseModels(fixture('malformed.lib')).diagnostics[0].code, 'SPICE_PARSE_001');
  for (const card of ['.model n NMOS (LEVEL=1', '.model n NMOS LEVEL=1 KP={1+2', '.model n NMOS LEVEL=1 KP=', '.model n NMOS LEVEL 1']) assert.equal(check(card)[0].status, 'INVALID', card);
  assert.equal(parseModels('+ KP=1').diagnostics[0].code, 'SPICE_PARSE_004');
});
test('negative fixtures do not silently pass', () => {
  assert.deepEqual(check(fixture('negative.lib')).map(r => r.status), ['UNSUPPORTED', 'INVALID', 'WARNING']);
});
test('missing, fractional, expression, malformed LEVEL', () => {
  assert.equal(check('.model n NMOS VTO=0.4')[0].effectiveLevel, 1);
  assert.equal(check('.model n NMOS VTO=0.4')[0].status, 'WARNING');
  for (const level of ['1.5','bad','{x}']) assert.equal(check(`.model n NMOS LEVEL=${level}`)[0].status, 'INVALID');
});
test('duplicates are retained, including case and source order', () => {
  const p = parseModels('.model n NMOS LEVEL=1 kp=1u KP=2u\n.model N NMOS LEVEL=1');
  assert.equal(p.models[0].parameters.length, 3);
  assert.ok(p.models[0].diagnostics.some(d => d.code === 'MODEL_PARAM_002'));
  assert.ok(p.models[1].diagnostics.some(d => d.code === 'SPICE_PARSE_005'));
});
test('comments, expressions, include/lib and scoped declarations', () => {
  const p = parseModels('* ignore\n.param x = 2\n.include "a.lib"\n.lib "b.lib" tt\n.model n NMOS LEVEL=1 VTO={0.5 + x} ; tail');
  assert.equal(p.dependencies.length, 2);
  assert.equal(p.context.length, 1);
  assert.equal(p.models[0].parameters[1].value, '{0.5 + x}');
  assert.equal(p.models[0].scoped, true);
  assert.equal(check('.model n NMOS LEVEL=1 KP=1u $ ignore')[0].status, 'PASS');
});
test('SPICE suffix semantics and malformed numeric values', () => {
  for (const [s, n] of [['1meg',1e6],['1m',.001],['1uA',1e-6],['-2.5e-3',-.0025],['1mil',25.4e-6]]) assert.equal(numericValue(s), n);
  for (const s of ['1e','1e-','NaN','Infinity','oops','1.2.3','1e999']) assert.equal(numericValue(s), null);
});
