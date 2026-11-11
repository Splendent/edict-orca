import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('native calls request full records only for orchestration commands', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-native-flags-'));
  const command = path.join(dir, 'orca-fixture');
  fs.writeFileSync(command, '#!/usr/bin/env node\nconsole.log(JSON.stringify({ok:true,result:{argv:process.argv.slice(2)}}));\n', { mode: 0o755 });
  const previous = process.env.ORCA_CLI_COMMAND; process.env.ORCA_CLI_COMMAND = command;
  t.after(() => { if (previous === undefined) delete process.env.ORCA_CLI_COMMAND; else process.env.ORCA_CLI_COMMAND = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const native = new NativeRuntime();
  assert.deepEqual(native.call(['orchestration', 'worker-show']).argv, ['orchestration', 'worker-show', '--json', '--full']);
  assert.deepEqual(native.call(['terminal', 'show']).argv, ['terminal', 'show', '--json']);
  assert.deepEqual(native.call(['worktree', 'show']).argv, ['worktree', 'show', '--json']);
});
test('an unverified start that still returns the Task/Dispatch pair is kept as a receipt', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-native-unverified-'));
  const command = path.join(dir, 'orca-fixture');
  fs.writeFileSync(command, `#!/usr/bin/env node
console.log(JSON.stringify({ok:true,result:{runId:"run-example",taskId:"task-x",dispatchId:"ctx-x",state:"outcome_unknown",stage:"turn_start_unobserved"}}));process.exit(1);
`, { mode: 0o755 });
  const previous = process.env.ORCA_CLI_COMMAND; process.env.ORCA_CLI_COMMAND = command;
  t.after(() => { if (previous === undefined) delete process.env.ORCA_CLI_COMMAND; else process.env.ORCA_CLI_COMMAND = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const native = new NativeRuntime();
  const receipt = native.start(runId, { agent: 'codex' }, 'spec', { title: 't' }, 'req-1');
  assert.equal(receipt.dispatchId, 'ctx-x'); assert.equal(receipt.taskId, 'task-x'); assert.equal(receipt.startUnverified, true);
  assert.throws(() => native.call(['orchestration', 'worker-show']), /失敗或未確認/);
});

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

function stallDetail(overrides = {}) {
  return { dispatch: dispatch({ assigneeHandle: 'term_worker' }),
    worker: { dispatchId: 'ctx-example', agentTerminalHandle: 'term_worker', state: 'start_unknown', stage: 'turn_start_unobserved' },
    projection: { liveness: { verdict: 'live' } }, observation: { status: 'live', agentWait: null }, ...overrides };
}
const stream = (tail, draft) => ({ terminal: { handle: 'term_worker', status: 'running', tail, ...(draft ? { draft } : {}) } });
const screen = tail => ({ terminal: { handle: 'term_worker', status: 'running', source: 'screen', tail } });

test('stallEvidence reads the verified assignee terminal stream and screen for drafts, update and menu prompts', () => {
  const { native, calls } = runtime(stallDetail(), stream(['Update available! 0.1 -> 0.2'], 'Held prompt'), screen(['› 1. Update now', '  2. Skip']));
  assert.deepEqual(native.stallEvidence(runId, 'ctx-example'), { handle: 'term_worker', state: 'start_unknown', stage: 'turn_start_unobserved',
    liveness: 'live', agentWait: null, terminalStatus: 'running', screenSource: 'screen', draft: 'Held prompt', updatePrompt: true, menu: '› 1. Update now' });
  assert.deepEqual(calls[1].args, ['terminal', 'read', '--terminal', 'term_worker', '--limit', '40']);
  assert.deepEqual(calls[2].args, ['terminal', 'read', '--terminal', 'term_worker', '--screen']);
  const quiet = runtime(stallDetail(), stream(['working']), screen(['› You have 1 orchestration message.'])).native.stallEvidence(runId, 'ctx-example');
  assert.equal(quiet.draft, null); assert.equal(quiet.updatePrompt, false); assert.equal(quiet.menu, null);
  for (const line of ['Would you like to run the following command?', 'Do you trust the files in this folder?', 'Press enter to continue', 'Proceed? (y/n)']) {
    assert.equal(runtime(stallDetail(), stream([]), screen([line])).native.stallEvidence(runId, 'ctx-example').menu, line);
  }
});

test('stallEvidence never reads a terminal whose Dispatch, Run or handle is unverified', () => {
  const detail = stallDetail();
  for (const bad of [{ ...detail, dispatch: { ...detail.dispatch, runId: 'other' } }, { ...detail, worker: { ...detail.worker, agentTerminalHandle: 'term_other' } }]) {
    const { native, calls } = runtime(bad);
    assert.throws(() => native.stallEvidence(runId, 'ctx-example'), /身分未確認/);
    assert.equal(calls.length, 1);
  }
  assert.throws(() => runtime(detail, { terminal: { handle: 'term_other', tail: [] } }).native.stallEvidence(runId, 'ctx-example'), /handle/);
  assert.throws(() => runtime(detail, stream([]), { terminal: { handle: 'term_other', tail: [] } }).native.stallEvidence(runId, 'ctx-example'), /handle/);
});

test('submitDraft re-reads the terminal and sends only a bare carriage return for the same held draft', () => {
  const { native, calls } = runtime(stallDetail(), stream([], 'Held prompt'), screen(['› Held prompt']), { ok: true });
  assert.deepEqual(native.submitDraft(runId, 'ctx-example', 'Held prompt'), { sent: true, handle: 'term_worker' });
  assert.deepEqual(calls.at(-1).args, ['terminal', 'send', '--terminal', 'term_worker', '--text', '\r']);
  const refused = [
    [stallDetail(), stream([], 'Changed by a human'), screen([])],
    [stallDetail({ projection: { liveness: { verdict: 'exited' } } }), stream([], 'Held prompt'), screen([])],
    [stallDetail(), stream([], 'Held prompt'), screen(['Would you like to run the following command?'])],
    [stallDetail({ observation: { status: 'live', agentWait: { evidence: 'prompt-text' } } }), stream([], 'Held prompt'), screen([])],
  ];
  for (const responses of refused) {
    const { native: other, calls: made } = runtime(...responses);
    assert.throws(() => other.submitDraft(runId, 'ctx-example', 'Held prompt'), /未送出/);
    assert.equal(made.some(x => x.args[1] === 'send'), false);
  }
});

test('native call failures are marked so relay can tell an unreachable Orca from workflow refusals', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-native-missing-'));
  const previous = process.env.ORCA_CLI_COMMAND; process.env.ORCA_CLI_COMMAND = path.join(dir, 'missing-orca');
  t.after(() => { if (previous === undefined) delete process.env.ORCA_CLI_COMMAND; else process.env.ORCA_CLI_COMMAND = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  assert.throws(() => new NativeRuntime().call(['orchestration', 'run-current']), error => error.nativeFailure === true && error.code === 'ENOENT');
});

test('a semantic ok:false refusal is not marked retryable but a refused connection code is', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-native-refusal-'));
  const preload = path.join(dir, 'reply.cjs');
  const previous = { command: process.env.ORCA_CLI_COMMAND, options: process.env.NODE_OPTIONS, code: process.env.EDICT_TEST_CODE };
  t.after(() => {
    for (const [key, value] of [['ORCA_CLI_COMMAND', previous.command], ['NODE_OPTIONS', previous.options], ['EDICT_TEST_CODE', previous.code]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // Node itself stands in for orca: the preload prints the native response and exits before the argv is run.
  fs.writeFileSync(preload, 'process.stdout.write(JSON.stringify({ok:false,error:{code:process.env.EDICT_TEST_CODE,message:"refused"}}));process.exit(1);');
  process.env.ORCA_CLI_COMMAND = process.execPath;
  process.env.NODE_OPTIONS = `--require ${JSON.stringify(preload)}`;
  process.env.EDICT_TEST_CODE = 'run_not_found';
  assert.throws(() => new NativeRuntime().call(['orchestration', 'run-current']), error => error.code === 'run_not_found' && error.nativeFailure === undefined);
  process.env.EDICT_TEST_CODE = 'runtime_unavailable';
  assert.throws(() => new NativeRuntime().call(['orchestration', 'run-current']), error => error.nativeFailure === true);
});

function renameFixture() {
  return { detail: { dispatch: dispatch({ assigneeHandle: 'term_worker', assigneePaneKey: 'tab-worker:leaf-worker' }),
    worker: { dispatchId: 'ctx-example', agentTerminalHandle: 'term_worker' } },
    terminal: { handle: 'term_worker', tabId: 'tab-worker', leafId: 'leaf-worker' } };
}
const inventory = terminals => ({ terminals, truncated: false, visualLayouts: [{ root: { tabs: terminals.map(row => ({ tabId: row.tabId, panes: row })) } }] });

test('rename uses a verified worker handle and changes a dedicated tab without dispatching work', () => {
  const { detail, terminal } = renameFixture(), title = '兵部郎中｜W-001 冰霜特效｜←兵部尚書';
  const { native, calls } = runtime(detail, inventory([terminal]), { rename: { ...terminal, title } });
  assert.equal(native.rename(runId, 'ctx-example', title).target, 'tab');
  assert.deepEqual(calls.at(-1).args, ['terminal', 'rename', '--terminal', terminal.handle, '--title', title]);
  assert.equal(calls.some(x => x.args.includes('worker-start') || x.args.includes('send')), false);
});

test('rename changes only its pane when another agent shares the tab', () => {
  const { detail, terminal } = renameFixture(), title = '兵部郎中｜效能查證';
  const other = { handle: 'term_other', tabId: terminal.tabId, leafId: 'leaf-other' };
  const { native, calls } = runtime(detail, inventory([terminal, other]), { paneTitle: { ...terminal, title } });
  assert.equal(native.rename(runId, 'ctx-example', title).target, 'pane');
  assert.equal(calls.at(-1).args[1], 'set-pane-title');
  assert.equal(calls.some(x => x.args[1] === 'rename'), false);
});

test('rename refuses cross-Run, mismatched handles, partial inventory and mismatched pane identity', () => {
  const { detail, terminal } = renameFixture();
  assert.throws(() => runtime({ ...detail, dispatch: { ...detail.dispatch, runId: 'other' } }).native.rename(runId, 'ctx-example', 'title'), /身分未確認/);
  assert.throws(() => runtime({ ...detail, worker: { ...detail.worker, agentTerminalHandle: 'term_other' } }).native.rename(runId, 'ctx-example', 'title'), /身分未確認/);
  assert.throws(() => runtime(detail, { ...inventory([terminal]), truncated: true }).native.rename(runId, 'ctx-example', 'title'), /未確認/);
  assert.throws(() => runtime(detail, inventory([{ ...terminal, leafId: 'different' }])).native.rename(runId, 'ctx-example', 'title'), /未確認/);
});

test('rename reports agents without terminal tabs as unavailable without changing their launch surface', () => {
  const { detail } = renameFixture(); detail.dispatch.assigneeHandle = detail.worker.agentTerminalHandle = 'structured_agent';
  const { native, calls } = runtime(detail, inventory([]));
  assert.equal(native.rename(runId, 'ctx-example', 'title').state, 'unavailable');
  assert.equal(calls.length, 2);
});

test('a hidden worker gets a visible tab and returns to its caller before naming', () => {
  const { detail, terminal } = renameFixture(), title = '兵部郎中｜冰霜特效';
  const { native, calls } = runtime(detail, { ...inventory([]), terminals: [terminal] }, { terminal: { handle: 'term_caller' } },
    { focus: { handle: terminal.handle, navigated: true } }, inventory([terminal]),
    { focus: { handle: 'term_caller', navigated: true } }, { rename: { ...terminal, title } });
  const result = native.rename(runId, 'ctx-example', title);
  assert.equal(result.reveal.navigated, true);
  assert.equal(result.restoreWarning, null);
  assert.deepEqual(calls.filter(x => x.args[1] === 'switch').map(x => x.args.at(-1)), [terminal.handle, 'term_caller']);
  assert.equal(calls.filter(x => x.args[1] === 'rename').length, 1);
});

test('a failed reveal still returns to its caller and never creates another worker', () => {
  const { detail } = renameFixture();
  const { native, calls } = runtime(detail, { ...inventory([]), terminals: [{ handle: 'term_worker' }] }, { terminal: { handle: 'term_caller' } },
    { focus: { handle: 'term_worker', navigated: false } }, { focus: { handle: 'term_caller', navigated: true } });
  assert.throws(() => native.rename(runId, 'ctx-example', 'title'), /未確認代理分頁/);
  assert.equal(calls.at(-1).args.at(-1), 'term_caller');
  assert.equal(calls.some(x => x.args[1] === 'worker-start' || x.args[1] === 'rename'), false);
});
