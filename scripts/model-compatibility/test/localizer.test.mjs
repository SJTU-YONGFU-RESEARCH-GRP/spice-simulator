import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModels } from '../parser.mjs';
import { localizeFailure } from '../failure-localizer.mjs';
const model = parseModels('.model n NMOS LEVEL=8 A=1 B=2 C=3 D=4').models[0];
const success = { status: 'PASS', diagnostics: [] };
const failure = { status: 'RUNTIME_FAILURE', failureKind: 'engine-parse', diagnostics: [{code:'ENGINE_PARSE_002', evidence:'strtod: Invalid argument'}] };

test('positive: preserves interacting pair and verifies removal controls', () => {
  const r = localizeFailure(model, failure, card => card.includes('B=2') && card.includes('D=4') ? failure : success);
  assert.equal(r.confidence, 'high');
  assert.equal(r.oneMinimal, true);
  assert.deepEqual(r.suspectedParameters.map(p=>p.name), ['B','D']);
  assert.ok(r.evidence.removalControls.every(c=>c.result.status === 'PASS'));
});
test('negative: baseline fails, normalized input passes, or error changes', () => {
  assert.equal(localizeFailure(model, failure, ()=>failure).status, 'INCONCLUSIVE');
  assert.equal(localizeFailure(model, failure, ()=>success).status, 'INCONCLUSIVE');
  assert.equal(localizeFailure(model, failure, card=>card.includes('A=1') ? {...failure, diagnostics:[{code:'OTHER',evidence:'different'}]} : success).status, 'INCONCLUSIVE');
  assert.equal(localizeFailure(model, success, ()=>success).status, 'INCONCLUSIVE');
});
test('budget and engine errors cannot manufacture high confidence', () => {
  const r=localizeFailure(model, failure, card=>card.includes('A=1') ? failure : success, {maxProbes:2});
  assert.equal(r.confidence,'medium');
  assert.equal(r.budgetExhausted,true);
  assert.equal(r.oneMinimal,false);
  const e=localizeFailure(model, failure, ()=>({status:'TOOL_ERROR',diagnostics:[]}));
  assert.equal(e.status,'INCONCLUSIVE');
});
