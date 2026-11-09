import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { capacityOperations, prepareCapacityEvidence } from '../src/workflow.mjs';
import { NativeRuntime } from '../src/native.mjs';

const op = (id, state = 'accepted') => ({ id, memberId: id, runId: 'other', dispatchId: `d-${id}`, taskId: `t-${id}`, position: 'executor', state });
function detail(operation) {
  return {
    dispatch: { id: operation.dispatchId, runId: 'other', taskId: operation.taskId, assigneeHandle: 'term-x', hostScope: { kind: 'local' } },
    worker: { dispatchId: operation.dispatchId, agentTerminalHandle: 'term-x', state: 'running', stage: 'active' },
    projection: { dispatchId: operation.dispatchId, runId: 'other', taskId: operation.taskId, liveness: { verdict: 'unverifiable' } },
    observation: { status: 'unknown' },
  };
}

test('capacity excludes only proven ended operations of other Runs without mutating records', t => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-capacity-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const states = ['submitted', 'accepted', 'unknown'];
  const operations = Object.fromEntries(states.map(state => [state, op(state, state)]));
  const db = { runs: { other: { id: 'other', operations }, current: { id: 'current', operations: { self: op('self') } } } };
  const before = JSON.stringify(db), queried = [];
  const evidence = prepareCapacityEvidence(db, 'current', { capacityEvidence(run, operation) {
    queried.push(operation.id);
    return { ended: true, reason: 'terminal-missing' };
  } }, cache);
  const result = capacityOperations(db, 'current', evidence);
  assert.deepEqual(result.active.map(x => x.id), ['self']);
  assert.equal(result.excluded.length, 3);
  assert.deepEqual(queried, states);
  assert.equal(JSON.stringify(db), before);
});

for (const mode of ['running', 'unknown', 'unverifiable', 'query-error', 'missing-identity']) {
  test(`capacity retains other Run operations when ${mode}`, () => {
    const db = { runs: { other: { id: 'other', operations: { x: op('x') } } } };
    const result = capacityOperations(db, 'current', prepareCapacityEvidence(db, 'current', { capacityEvidence() {
      if (mode === 'query-error') throw new Error('native unavailable');
      return { ended: false, reason: mode };
    } }));
    assert.equal(result.active.length, 1);
    assert.equal(result.excluded.length, 0);
  });
}

test('native capacity evidence requires exact Run, Task, Dispatch and assignee identity', () => {
  const operation = op('x'), native = new NativeRuntime();
  for (const field of ['runId', 'taskId', 'id', 'assigneeHandle']) {
    const data = detail(operation); data.observation.status = 'missing'; data.dispatch[field] = 'wrong';
    native.call = () => data;
    assert.equal(native.capacityEvidence('other', operation).ended, false, field);
  }
  native.call = () => { throw new Error('must not query without identity'); };
  assert.equal(native.capacityEvidence('other', { state: 'unknown' }).ended, false);
});

for (const evidence of ['missing', 'exited', 'released', 'settled', 'running', 'unverifiable']) {
  test(`native capacity handles ${evidence} evidence conservatively`, () => {
    const operation = op('x'), data = detail(operation), native = new NativeRuntime();
    if (evidence === 'missing') data.observation.status = 'missing';
    if (evidence === 'exited') data.projection.liveness.verdict = 'exited';
    if (evidence === 'released') data.terminalResource = { releaseState: 'released' };
    if (evidence === 'settled') Object.assign(data.worker, { state: 'succeeded', stage: 'settled' });
    native.call = args => {
      assert.deepEqual(args, ['orchestration', 'worker-show', '--dispatch', operation.dispatchId]);
      return data;
    };
    assert.equal(native.capacityEvidence('other', operation).ended, !['running', 'unverifiable'].includes(evidence));
  });
}

for (const mode of ['unknown', 'error']) {
  test(`capacity never caches ${mode} evidence`, t => {
    const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-capacity-'));
    t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
    const db = { runs: { other: { id: 'other', operations: { x: op('x') } } } };
    let queries = 0;
    const runtime = { capacityEvidence() { queries++; if (mode === 'error') throw new Error('unavailable'); return { ended: false }; } };
    for (let i = 0; i < 2; i++) assert.equal(capacityOperations(db, 'current', prepareCapacityEvidence(db, 'current', runtime, cache)).active.length, 1);
    assert.equal(queries, 2);
    assert.deepEqual(fs.readdirSync(cache), []);
  });
}

test('cached evidence cannot exclude an operation with a changed native or member identity', t => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-capacity-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const operation = op('x'), db = { runs: { other: { id: 'other', operations: { x: operation } } } };
  const evidence = prepareCapacityEvidence(db, 'current', { capacityEvidence: () => ({ ended: true }) }, cache);
  for (const field of ['dispatchId', 'taskId', 'memberId', 'id']) {
    const changed = structuredClone(db); changed.runs.other.operations.x[field] = 'new';
    assert.equal(capacityOperations(changed, 'current', evidence).active.length, 1, field);
    let queries = 0;
    const fresh = prepareCapacityEvidence(changed, 'current', { capacityEvidence() { queries++; return { ended: false }; } }, cache);
    assert.equal(queries, 1, field);
    assert.equal(capacityOperations(changed, 'current', fresh).active.length, 1, field);
  }
});
