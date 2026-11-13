import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';


import { Workflow } from '../src/workflow.mjs';
import { activate, readSession, writeSession } from '../src/session.mjs';
import { defaults } from '../src/config.mjs';
import { NativeRuntime } from '../src/native.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-workflow-'));
  const previous = process.env.EDICT_HOME;
  process.env.EDICT_HOME = path.join(dir, 'state');
  t.after(() => { if (previous === undefined) delete process.env.EDICT_HOME; else process.env.EDICT_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const project = path.join(dir, 'project'); fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  const proof = path.join(dir, 'proof.txt'); fs.writeFileSync(proof, 'reviewed evidence');
  activate('codex:workflow', defaults(), project);
  const runtime = {
    actor: { owner: true }, calls: [], rows: [], counter: 0,
    identity() { return this.actor; },
    open() { return 'run-test'; },
    start(runId, settings, spec, options, requestId) {
      this.calls.push({ settings, spec, options, requestId });
      if (this.onStart) this.onStart();
      const dispatchId = `dispatch-${++this.counter}`, taskId = `task-${this.counter}`;
      this.rows.push({ dispatchId, state: 'ready' });
      return { dispatchId, taskId, runId };
    },
    workers() { return this.rows; },
    rename(runId, dispatchId, title) { return { state: 'applied', handle: `term_${dispatchId}`, title }; },
    stop(dispatchId) { this.rows.find(x => x.dispatchId === dispatchId).state = 'stopped'; return { dispatchId, state: 'stopped' }; },
    send(runId, dispatchId, body, requestId) { this.calls.push({ dispatchId, body, requestId }); return { messageId: 'message-test' }; },
  };
  const w = new Workflow('codex:workflow', runtime); w.open('Test independent work');
  const root = () => { runtime.actor = { owner: true }; };
  const as = member => { runtime.actor = { owner: false, dispatchId: member.dispatchId }; };
  const add = (id = 'W-001') => w.add('run-test', { id, title: id, requirement: 'Implement in assigned scope', reads: ['src'], writes: ['src'], resources: [], acceptance: ['Check actual output'] });
  add();
  const head = (role, work = 'W-001') => w.launch('run-test', role, 'head', role === 'zhongshu' ? undefined : work, { spec: 'Perform only assigned role', generation: 1 }).member;
  const zhongshu = head('zhongshu'); as(zhongshu);
  root(); w.launch('run-test', 'menxia', 'head', undefined, { spec: 'Wait for an authorized plan handoff' });
  w.launch('run-test', 'shangshu', 'head', undefined, { spec: 'Wait for an approved execution handoff' });
  as(zhongshu);
  const plan = (work = 'W-001') => w.plan('run-test', work, { generation: 1, description: 'Write src/result.txt', reads: ['src'], writes: ['src'], acceptance: ['Check actual output'] });
  let proposal = plan();
  const menxia = head('menxia');
  const approve = (digest = proposal.digest, work = 'W-001', verdict = 'approved') => w.review('run-test', work, { generation: 1, kind: 'plan-approval', digest, verdict, evidence: [proof] });
  as(menxia); approve();
  as(zhongshu); const shangshu = head('shangshu');
  as(shangshu); const bingbu = head('bingbu'), xingbu = head('xingbu');
  const launch = (work = 'W-001', data = {}) => w.launch('run-test', 'bingbu', 'executor', work, { spec: 'Write assigned file and submit evidence', generation: 1, ...data });
  as(bingbu);
  return { w, runtime, dir, project, proof, root, as, add, head, plan, approve, launch, zhongshu, menxia, shangshu, bingbu, xingbu, proposal };
}

const settle = (f, dispatchId, state = 'succeeded') => { f.runtime.rows.find(x => x.dispatchId === dispatchId).state = state; f.root(); f.w.sync('run-test'); };

for (const [name, state, stage, verdict, observation, expected, options = {}] of [
  ['abandoned missing terminal', 'abandoned', 'terminal_missing', 'unverifiable', 'missing', true],
  ['failed retained but gone terminal', 'failed', 'settled', 'unverifiable', 'missing', true],
  ['failed unconfirmed terminal', 'failed', 'settled', 'unverifiable', 'unknown', false],
  ['failed live terminal', 'failed', 'settled', 'live', 'missing', false],
  ['abandoned live terminal', 'abandoned', 'terminal_missing', 'live', 'missing', false],
  ['running live terminal', 'running', 'terminal_missing', 'live', 'missing', false],
  ['running unverifiable terminal', 'running', 'terminal_missing', 'unverifiable', 'missing', false],
  ['accepted unverifiable terminal', 'accepted', 'settled', 'unverifiable', 'missing', false],
  ...['completed', 'succeeded', 'stopped'].map(state =>
    [`${state} with live retained terminal`, state, 'settled', 'live', 'live', true, { probes: 0 }]),
  ...['settled', 'terminal_missing'].flatMap(stage => [
    [`${stage} remote terminal`, 'failed', stage, 'unverifiable', 'missing', false, { hostScope: { kind: 'ssh' } }],
    [`${stage} unknown host`, 'failed', stage, 'unverifiable', 'missing', false, { hostScope: null }],
    [`${stage} worker-show throws`, 'failed', stage, 'unverifiable', 'missing', false, { throws: true }],
    [`${stage} terminal still present`, 'failed', stage, 'unverifiable', 'missing', false, { terminal: { handle: 'term-worker' } }],
  ]),
  ...['id', 'runId', 'taskId', 'assigneeHandle'].map(field =>
    [`mismatched dispatch ${field}`, 'failed', 'settled', 'unverifiable', 'missing', false,
      { alter: detail => { detail.dispatch[field] = 'other'; } }]),
  ...['dispatchId', 'agentTerminalHandle', 'state', 'stage'].map(field =>
    [`mismatched worker ${field}`, 'failed', 'settled', 'unverifiable', 'missing', false,
      { alter: detail => { detail.worker[field] = 'other'; } }]),
  ['worker-show reports live', 'failed', 'settled', 'unverifiable', 'missing', false,
    { alter: detail => { detail.projection.liveness.verdict = 'live'; } }],
  ['missing task IDs on both records', 'failed', 'settled', 'unverifiable', 'missing', false,
    { row: { taskId: undefined }, probes: 0 }],
  ['missing worker-show task ID', 'failed', 'settled', 'unverifiable', 'missing', false,
    { alter: detail => { delete detail.dispatch.taskId; } }],
  ['released terminal skips worker-show', 'failed', 'settled', 'unverifiable', 'missing', true,
    { row: { terminalState: 'released' }, probes: 0 }],
  ['released resource skips worker-show', 'failed', 'settled', 'unverifiable', 'missing', true,
    { row: { resource: { releaseState: 'released' } }, probes: 0 }],
  ['released ownership skips worker-show', 'failed', 'settled', 'unverifiable', 'missing', true,
    { row: { resource: { ownershipState: 'released' } }, probes: 0 }],
  ['exited terminal skips worker-show', 'failed', 'settled', 'exited', 'missing', true, { probes: 0 }],
]) {
  test(`sync and replacement respect native execution evidence: ${name}`, t => {
    const f = fixture(t), started = f.launch();
    const row = f.runtime.rows.find(x => x.dispatchId === started.operation.dispatchId);
    Object.assign(row, { taskId: started.operation.taskId, runId: 'run-test', workerState: state,
      state, dispatchStatus: 'failed', agentTerminalHandle: 'term-worker', terminalState: 'retained',
      resource: { ownershipState: 'external', releaseState: 'not_requested' },
      projection: { host: { kind: 'local' }, stage: { worker: state, detail: stage }, liveness: { verdict } }, ...options.row });
    // Exercise the real adapter: worker-list has no observation field, worker-show does.
    const native = new NativeRuntime(), calls = [];
    native.call = args => {
      calls.push(args);
      if (args[1] === 'worker-list') return { workers: f.runtime.rows.map(x => ({ ...x, runId: 'run-test' })),
        page: { hasMore: false, nextCursor: null } };
      assert.equal(args[1], 'worker-show');
      assert.equal(args[3], row.dispatchId);
      if (options.throws) throw new Error('worker-show unavailable');
      const detail = { dispatch: { id: row.dispatchId, runId: row.runId, taskId: row.taskId,
        assigneeHandle: row.agentTerminalHandle, hostScope: Object.hasOwn(options, 'hostScope') ? options.hostScope : { kind: 'local' } },
        worker: { dispatchId: row.dispatchId, state, stage, agentTerminalHandle: row.agentTerminalHandle },
        projection: structuredClone(row.projection), terminal: options.terminal ?? null,
        observation: { status: observation, exactWorker: false } };
      options.alter?.(detail);
      return detail;
    };
    f.runtime.workers = native.workers.bind(native);
    f.root(); f.w.sync('run-test');
    const op = f.w.run('run-test').operations[started.operation.id];
    assert.equal(op.state, expected ? 'settled' : 'accepted');
    assert.equal(op.native.terminalState, row.terminalState);
    const probes = calls.filter(args => args[1] === 'worker-show').length;
    if (options.probes !== undefined) assert.equal(probes, options.probes);
    else if (['failed', 'abandoned'].includes(state) && verdict !== 'live') {
      assert.equal(probes, 1);
    }
    f.as(f.bingbu);
    if (expected) {
      const replaced = f.w.replace('run-test', started.member.id, { spec: 'Continue assigned work', generation: 1 });
      assert.equal(replaced.confirmed, true);
      assert.equal(f.w.run('run-test').members[started.member.id].retired, true);
    } else {
      assert.throws(() => f.w.replace('run-test', started.member.id, { spec: 'Continue', generation: 1 }), /仍在執行/);
      assert.equal(f.w.run('run-test').members[started.member.id].retired, undefined);
    }
  });
}

test('a supervisor replaces a settled executor with the current settings and the old member is retired', t => {
  const f = fixture(t);
  const started = f.launch('W-001', { title: '冰霜特效', reads: ['src/frost'], writes: ['src/frost'] });
  assert.throws(() => { f.as(f.bingbu); f.w.replace('run-test', started.member.id, { spec: 'Continue', generation: 1 }); }, /仍在執行/);
  settle(f, started.operation.dispatchId);
  f.as(f.shangshu);
  assert.throws(() => f.w.replace('run-test', started.member.id, { spec: 'Continue', generation: 1 }), /直接上級/);
  f.as(f.bingbu);
  assert.throws(() => f.w.replace('run-test', started.member.id, { spec: 'Continue', generation: 2 }), /世代不符/);
  // config set switched the executor agent; the replacement picks it up while the old start keeps its snapshot.
  const session = readSession('codex:workflow');
  session.config.positionOverrides = { bingbu: { executor: { agent: 'claude', model: 'model-b', effort: null } } };
  writeSession(session);
  const replaced = f.w.replace('run-test', started.member.id, { spec: 'Continue the frost work', generation: 1 });
  assert.equal(replaced.confirmed, true);
  const run = f.w.run('run-test');
  const old = run.members[started.member.id], fresh = run.members[replaced.member.id];
  assert.equal(old.retired, true);
  assert.equal(old.replacedBy, fresh.id);
  assert.equal(fresh.supervisor, f.bingbu.id);
  assert.deepEqual(fresh.scopes, ['W-001']);
  const op = run.operations[replaced.operation.id];
  assert.deepEqual(op.writes, ['src/frost']);
  assert.equal(op.phase, 'implementation');
  assert.equal(run.operations[started.operation.id].supersededBy, op.id);
  assert.match(f.runtime.calls.at(-1).spec, /接手說明：你接替成員/);
  assert.deepEqual(f.runtime.calls.at(-1).settings, { agent: 'claude', model: 'model-b', effort: null });
  assert.equal(run.operations[started.operation.id].settings.agent, 'codex');
  assert.match(f.runtime.calls.at(-1).options.title, /兵部郎中.*冰霜特效/);
  // The retired member can no longer act, and messages must go to the new member.
  f.as(started.member);
  assert.throws(() => f.w.show('run-test'), /沒有有效團隊成員綁定/);
  f.as(f.bingbu);
  assert.throws(() => f.w.message('run-test', started.member.id, 'W-001', 'Fix', undefined, 1), /已換手給/);
  assert.ok(run.history.some(x => x.action === 'replace' && x.member === old.id));
});

test('replacing a settled head re-parents its subordinates and keeps later ensures on the new head', t => {
  const f = fixture(t);
  const started = f.launch('W-001', { title: '傷害數值', reads: ['src/damage'], writes: ['src/damage'] });
  f.as(f.shangshu);
  assert.throws(() => f.w.replace('run-test', f.bingbu.id, { spec: 'Take over Bingbu' }), /仍在執行/);
  settle(f, f.bingbu.dispatchId);
  f.as(f.shangshu);
  const replaced = f.w.replace('run-test', f.bingbu.id, { spec: 'Take over Bingbu' });
  const run = f.w.run('run-test');
  assert.equal(run.members[f.bingbu.id].retired, true);
  assert.equal(run.members[started.member.id].supervisor, replaced.member.id);
  assert.deepEqual(run.members[replaced.member.id].scopes, run.members[f.bingbu.id].scopes);
  const ensured = f.w.launch('run-test', 'bingbu', 'head', 'W-001', { spec: 'Ensure', generation: 1 });
  assert.equal(ensured.member.id, replaced.member.id);
});

test('root replaces a settled Sanshu head; refused starts leave the original member active', t => {
  const f = fixture(t);
  settle(f, f.shangshu.dispatchId);
  f.runtime.start = () => { throw Object.assign(new Error('refused'), { receipt: { ok: false, error: { data: { effectsApplied: false } } } }); };
  f.root();
  assert.throws(() => f.w.replace('run-test', f.shangshu.id, { spec: 'Take over Shangshu' }), /refused/);
  let run = f.w.run('run-test');
  assert.equal(run.members[f.shangshu.id].retired, undefined);
  const refused = Object.values(run.operations).find(x => x.operationKind === 'replacement');
  assert.equal(refused.state, 'refused');
  assert.equal(run.members[refused.memberId].retired, true);
  f.runtime.start = (runId) => ({ dispatchId: 'dispatch-new-head', taskId: 'task-new-head', runId });
  const replaced = f.w.replace('run-test', f.shangshu.id, { spec: 'Take over Shangshu' });
  run = f.w.run('run-test');
  assert.equal(run.members[f.shangshu.id].replacedBy, replaced.member.id);
  assert.equal(run.members[f.bingbu.id].supervisor, replaced.member.id);
});

test('replacement is refused while the work is paused', t => {
  const f = fixture(t);
  const started = f.launch('W-001', { reads: ['src/a'], writes: ['src/a'] });
  settle(f, started.operation.dispatchId);
  f.root(); f.w.control('run-test', 'pause', 'W-001');
  f.as(f.bingbu);
  assert.throws(() => f.w.replace('run-test', started.member.id, { spec: 'Continue', generation: 1 }), /暫停/);
  f.root(); f.w.control('run-test', 'resume', 'W-001');
  const run = f.w.run('run-test');
  assert.equal(run.members[started.member.id].retired, undefined);
});
