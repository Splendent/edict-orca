import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeRuntime } from '../src/native.mjs';

// DTOs follow Orca 1.4.249 --json --full result shapes. No native work runs here.
function runtime(...responses) {
  const native = new NativeRuntime(), calls = [];
  native.call = (args, input) => {
    calls.push({ args, input });
    assert.ok(responses.length, 'Unexpected native call');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { native, calls };
}
const runId = 'run-example';
function worker(id, state = 'succeeded') {
  return { dispatchId: id, taskId: `task-${id}`, runId, workerState: state,
    dispatchStatus: state === 'succeeded' ? 'completed' : 'dispatched',
    terminalState: 'released', resource: { ownershipState: 'released', releaseState: 'released' },
    projection: { liveness: { verdict: 'exited', source: 'resource_release' } } };
}
function page(workers, hasMore = false, nextCursor = null) {
  return { workers, counts: {}, page: { limit: 100, total: workers.length, hasMore, nextCursor } };
}
function dispatch(overrides = {}) {
  return { id: 'ctx-example', runId, taskId: 'task-example', status: 'dispatched', capabilityRevokedAt: null, ...overrides };
}

test('currentRun reads the full native run object and preserves an unbound caller', () => {
  const { native, calls } = runtime({ run: { id: runId, coordinator_handle: 'term-owner' } }, { run: null });
  assert.equal(native.currentRun(), runId);
  assert.equal(native.currentRun(), null);
  assert.deepEqual(calls[0].args, ['orchestration', 'run-current']);
});

test('identity recognizes the current owner and another Run owned by the same native coordinator', () => {
  const current = { id: 'run-current', coordinator_handle: 'term-owner' };
  const { native } = runtime({ run: { ...current, id: runId } }, { run: current }, { run: { id: runId, coordinator_handle: 'term-owner', legacy: 0 } });
  assert.deepEqual(native.identity(runId), { owner: true });
  assert.deepEqual(native.identity(runId), { owner: true });
});

test('identity uses the native peek mailbox and full Dispatch instead of a claimed role', () => {
  const { native, calls } = runtime({ run: null }, { runId, dispatchId: 'ctx-example', messages: [] }, { dispatch: dispatch(), worker: { state: 'ready' } });
  assert.deepEqual(native.identity(runId), { owner: false, dispatchId: 'ctx-example' });
  assert.deepEqual(calls[1].args, ['orchestration', 'check', '--peek']);
  assert.deepEqual(calls[2].args, ['orchestration', 'worker-show', '--dispatch', 'ctx-example']);
});

test('identity refuses an unrelated mailbox or a revoked Dispatch', () => {
  assert.throws(() => runtime({ run: null }, { runId: 'other', dispatchId: 'ctx-example' }).native.identity(runId), /未確認目前呼叫者/);
  assert.throws(() => runtime({ run: null }, { runId, dispatchId: 'ctx-example' }, { dispatch: dispatch({ capabilityRevokedAt: '2026-11-05' }) }).native.identity(runId), /Dispatch 已失效/);
});

test('workers follows the second page so an older unfinished Dispatch is not omitted', () => {
  const newest = worker('ctx-new'), older = worker('ctx-old', 'start_unknown');
  const { native, calls } = runtime(page([newest], true, 'snapshot-page-2'), page([older]));
  const rows = native.workers(runId);
  assert.deepEqual(rows.map(x => x.dispatchId), ['ctx-new', 'ctx-old']);
  assert.equal(rows[1].state, 'start_unknown');
  assert.deepEqual(calls[1].args, ['orchestration', 'worker-list', '--run', runId, '--cursor', 'snapshot-page-2']);
});

test('workers preserves failed or unknown liveness and the original DTO without inferring termination', () => {
  const raw = { ...worker('ctx-failed', 'failed'), state: 'raw-state', terminalState: 'retained',
    resource: { ownershipState: 'owned' }, projection: { liveness: { verdict: 'unverifiable' } } };
  const { native } = runtime(page([raw]));
  const [row] = native.workers(runId);
  assert.equal(row.state, 'failed');
  assert.equal(row.status, 'dispatched');
  assert.equal(row.raw, raw);
  assert.equal(row.raw.state, 'raw-state');
  assert.equal(row.projection.liveness.verdict, 'unverifiable');
  assert.equal(raw.state, 'raw-state');
});

test('workers accepts explicit state but never substitutes dispatchStatus for a missing worker state', () => {
  const explicit = { dispatchId: 'ctx-example', taskId: 'task-example', runId, state: 'stop_unknown', dispatchStatus: 'failed' };
  assert.equal(runtime(page([explicit])).native.workers(runId)[0].state, 'stop_unknown');
  assert.throws(() => runtime(page([{ ...explicit, state: undefined }])).native.workers(runId), /格式不明/);
});

test('workers returns a confirmed empty page', () => {
  assert.deepEqual(runtime(page([])).native.workers(runId), []);
});

for (const [name, response] of [
  ['missing page', { workers: [] }],
  ['missing workers', { page: { hasMore: false, nextCursor: null } }],
  ['nonboolean hasMore', { workers: [], page: { hasMore: 'false' } }],
  ['missing next cursor', page([worker('ctx-a')], true)],
  ['empty continuing page', page([], true, 'cursor')],
  ['cursor on final page', page([], false, 'unexpected')],
  ['cross-Run row', page([{ ...worker('ctx-a'), runId: 'other' }])],
]) {
  test(`workers refuses ${name} rather than returning a partial inventory`, () => {
    assert.throws(() => runtime(response).native.workers(runId), /未確認完整/);
  });
}

test('workers refuses a repeated cursor, duplicate Dispatch, or expired snapshot after the first page', () => {
  assert.throws(() => runtime(page([worker('ctx-a')], true, 'cursor'), page([worker('ctx-b')], true, 'cursor')).native.workers(runId), /cursor 重複/);
  assert.throws(() => runtime(page([worker('ctx-a')], true, 'cursor'), page([worker('ctx-a')])).native.workers(runId), /重複/);
  const expired = Object.assign(new Error('snapshot expired'), { code: 'worker_list_cursor_expired' });
  assert.throws(() => runtime(page([worker('ctx-a')], true, 'cursor'), expired).native.workers(runId), error => error === expired);
});

test('dispatch returns the actual full worker-show Dispatch for recovery verification', () => {
  const raw = dispatch();
  const { native, calls } = runtime({ dispatch: raw, worker: { state: 'starting' } });
  assert.equal(native.dispatch(raw.id), raw);
  assert.deepEqual(calls[0].args, ['orchestration', 'worker-show', '--dispatch', raw.id]);
});

for (const bad of [undefined, dispatch({ id: 'other' }), dispatch({ runId: '' }), dispatch({ taskId: null })]) {
  test(`dispatch refuses incomplete or mismatched identity: ${JSON.stringify(bad)}`, () => {
    assert.throws(() => runtime({ dispatch: bad }).native.dispatch('ctx-example'), /格式不明/);
  });
}

test('send normalizes the nested full message receipt while retaining its native evidence', () => {
  const message = { id: 'msg-example', run_id: runId, to_handle: 'dispatch:ctx-example', type: 'status' };
  const { native, calls } = runtime({ message, mutation: { requestId: 'request-example', replayed: false } });
  const receipt = native.send(runId, 'ctx-example', 'Report only', 'request-example');
  assert.equal(receipt.messageId, message.id);
  assert.equal(receipt.runId, runId);
  assert.equal(receipt.message, message);
  assert.equal(calls[0].args.at(-1), 'request-example');
});

test('send does not conceal explicit malformed IDs behind a nested message', () => {
  const { native } = runtime({ messageId: null, runId: 'other', message: { id: 'msg-example', run_id: runId } });
  assert.deepEqual(native.send(runId, 'ctx-example', 'Report', 'request-example'),
    { messageId: null, runId: 'other', message: { id: 'msg-example', run_id: runId } });
});

test('request preserves pending accepted checkpoints and completed receipts for the recovery policy', () => {
  const pending = { requestId: 'request-example', state: 'pending', receipt: { accepted: { taskId: 'task-example', dispatchId: 'ctx-example' } } };
  const completed = { requestId: 'request-example', state: 'completed', receipt: { runId, taskId: 'task-example', dispatchId: 'ctx-example' } };
  const { native } = runtime(pending, completed);
  assert.equal(native.request('request-example'), pending);
  assert.equal(native.request('request-example'), completed);
});
