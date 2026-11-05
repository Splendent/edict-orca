import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { Workflow, assertWorkflowOwner, setWorkflowEnabled } from '../src/workflow.mjs';
import { activate, deactivate } from '../src/session.mjs';
import { defaults } from '../src/config.mjs';

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

test('native-bound head hierarchy completes plan, independent acceptance and Menxia closure', t => {
  const f = fixture(t), started = f.launch();
  const file = path.join(f.project, 'src/result.txt'); fs.writeFileSync(file, 'delivered');
  f.as(started.member);
  const result = f.w.result('run-test', started.operation.id, { files: [file] }).result;
  assert.equal(f.w.run('run-test').items['W-001'].done, false);
  assert.throws(() => f.w.review('run-test', 'W-001', { generation: 1, kind: 'artifact-acceptance', digest: result.digest, verdict: 'approved', evidence: [f.proof] }), /職權/);
  f.as(f.xingbu);
  assert.throws(() => f.w.review('run-test', 'W-001', { generation: 1, kind: 'artifact-acceptance', digest: result.digest, verdict: 'approved', evidence: [f.proof] }), /仍有可能/);
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test');
  f.as(f.xingbu); f.w.review('run-test', 'W-001', { generation: 1, kind: 'artifact-acceptance', digest: result.digest, verdict: 'approved', evidence: [f.proof] });
  f.as(f.shangshu);
  assert.throws(() => f.w.review('run-test', 'W-001', { generation: 1, kind: 'closure-confirmation', digest: result.digest, verdict: 'approved', evidence: [f.proof] }), /職權/);
  f.as(f.menxia); f.w.review('run-test', 'W-001', { generation: 1, kind: 'closure-confirmation', digest: result.digest, verdict: 'approved', evidence: [f.proof] });
  assert.equal(f.w.show('run-test').items[0].status, 'Done');
  const notification = f.w.message('run-test', f.shangshu.id, 'W-001', 'Closure confirmed', undefined, 1, 'report');
  assert.equal(notification.state, 'delivered');
  assert.throws(() => f.w.message('run-test', f.shangshu.id, 'W-001', 'Start more work', undefined, 1), /結案/);
  assert.throws(() => f.w.message('run-test', started.member.id, 'W-001', 'Run more code', undefined, 1, 'report'), /只能送既有頭領/);
});

test('unknown native caller, executor delegation and cross-department heads are rejected without mutations', t => {
  const f = fixture(t); const calls = f.runtime.calls.length;
  f.runtime.actor = { owner: false, dispatchId: 'forged' };
  assert.throws(() => f.launch(), /原生呼叫者/);
  f.as(f.xingbu); assert.throws(() => f.launch(), /自己省部/);
  f.as(f.bingbu); const started = f.launch(); f.as(started.member);
  assert.throws(() => f.launch(), /沒有派工權/);
  assert.equal(f.runtime.calls.length, calls + 1);
});

test('scope widening and stale or rejected approval cannot launch work', t => {
  const f = fixture(t), calls = f.runtime.calls.length;
  assert.throws(() => f.launch('W-001', { writes: ['other'] }), /超出/);
  f.as(f.menxia); f.approve(f.proposal.digest, 'W-001', 'rejected');
  f.as(f.bingbu); assert.throws(() => f.launch(), /核可/);
  f.as(f.zhongshu); const next = f.plan();
  f.as(f.menxia); assert.throws(() => f.approve(f.proposal.digest), /版本/);
  f.approve(next.digest); f.as(f.bingbu); f.launch();
  assert.equal(f.runtime.calls.length, calls + 1);
});

test('pause before admission rejects start; resume cannot bypass enclosing Run pause', t => {
  const f = fixture(t), calls = f.runtime.calls.length;
  f.root(); f.w.control('run-test', 'pause', 'W-001');
  f.as(f.bingbu); assert.throws(() => f.launch(), /暫停/);
  f.root(); f.w.control('run-test', 'pause'); f.w.control('run-test', 'resume', 'W-001');
  f.as(f.bingbu); assert.throws(() => f.launch(), /暫停/);
  assert.equal(f.runtime.calls.length, calls);
});

test('pause after durable submission preserves native receipt and reports in-flight work', t => {
  const f = fixture(t);
  f.runtime.onStart = () => { const prior = f.runtime.actor; f.root(); f.w.control('run-test', 'pause', 'W-001'); f.runtime.actor = prior; };
  const started = f.launch();
  assert.equal(started.confirmed, true);
  assert.equal(f.w.run('run-test').items['W-001'].paused, true);
  assert.equal(f.w.run('run-test').operations[started.operation.id].state, 'accepted');
});

test('cancel persists across late results and cannot be cleared by resume', t => {
  const f = fixture(t), started = f.launch(); f.root();
  f.w.control('run-test', 'cancel', 'W-001');
  assert.throws(() => f.w.control('run-test', 'resume', 'W-001'), /取消世代/);
  const file = path.join(f.project, 'src/result.txt'); fs.writeFileSync(file, 'late result');
  f.as(started.member); const archived = f.w.result('run-test', started.operation.id, { files: [file] });
  assert.equal(archived.archivedOnly, true);
  assert.equal(f.w.run('run-test').items['W-001'].result, null);
  f.as(f.bingbu); assert.throws(() => f.launch(), /取消/);
  f.root(); f.w.sync('run-test'); f.w.control('run-test', 'restart', 'W-001');
  assert.equal(f.w.run('run-test').items['W-001'].generation, 2);
  assert.equal(f.w.run('run-test').items['W-001'].plan, null);
});

test('off between submission and receipt preserves receipt but prohibits subsequent work', t => {
  const f = fixture(t);
  f.runtime.onStart = () => { const prior=f.runtime.actor; f.root(); setWorkflowEnabled('codex:workflow', false, f.runtime); deactivate('codex:workflow'); f.runtime.actor=prior; };
  const started = f.launch();
  assert.equal(started.confirmed, true);
  assert.ok(f.w.run('run-test').operations[started.operation.id].receipt.dispatchId);
  assert.throws(() => f.launch(), /尚未啟用/);
});

test('same-file claims conflict; distinct readonly verification waits for writers', t => {
  const f = fixture(t); f.launch(); const calls = f.runtime.calls.length;
  assert.throws(() => f.launch(), /範圍衝突/);
  f.as(f.xingbu);
  assert.throws(() => f.w.launch('run-test', 'xingbu', 'executor', 'W-001', { spec: 'Read assigned source', generation: 1, phase: 'verification' }), /範圍衝突/);
  assert.equal(f.runtime.calls.length, calls);
});

test('unknown native start is durable, keeps its slot and is never automatically retried', t => {
  const f = fixture(t); const calls = f.runtime.calls.length;
  f.runtime.start = () => { f.runtime.calls.push('unknown'); throw new Error('response lost'); };
  assert.throws(() => f.launch(), /response lost/);
  assert.equal(f.runtime.calls.length, calls + 1);
  const op = Object.values(f.w.run('run-test').operations).findLast(x => x.position === 'executor');
  assert.equal(op.state, 'unknown'); assert.ok(op.requestId);
  assert.throws(() => f.launch(), /範圍衝突/);
});

test('changed review evidence revokes approval, changed result revokes acceptance', t => {
  const f = fixture(t); fs.writeFileSync(f.proof, 'modified evidence');
  assert.throws(() => f.launch(), /核可/);
});

test('a reviewer cannot replace engineering output with its own submission', t => {
  const f = fixture(t), op = Object.values(f.w.run('run-test').operations).find(x => x.memberId === f.xingbu.id);
  const file = path.join(f.dir, 'fake-output'); fs.writeFileSync(file, 'not an implementation');
  f.as(f.xingbu);
  assert.throws(() => f.w.result('run-test', op.id, { files: [file] }), /只有實作執行代理/);
  assert.equal(f.w.run('run-test').items['W-001'].result, null);
});

test('one delivered implementation cannot hide a failed necessary implementation', t => {
  const f = fixture(t);
  const a = f.launch('W-001', { writes: ['src/a.txt'], reads: [] });
  const b = f.launch('W-001', { writes: ['src/b.txt'], reads: [] });
  const file = path.join(f.project, 'src/a.txt'); fs.writeFileSync(file, 'A delivered');
  f.as(a.member); const bundle = f.w.result('run-test', a.operation.id, { files: [file] }).result;
  f.runtime.rows.find(x => x.dispatchId === a.member.dispatchId).state = 'succeeded';
  Object.assign(f.runtime.rows.find(x => x.dispatchId === b.member.dispatchId), { state: 'failed', terminalState: 'released' });
  f.root(); f.w.sync('run-test'); f.as(f.xingbu);
  assert.throws(() => f.w.review('run-test', 'W-001', { generation: 1, kind: 'artifact-acceptance', digest: bundle.digest, verdict: 'approved', evidence: [f.proof] }), /必要實作委派/);
});

test('continuation replaces its contribution and claims resources before native send', t => {
  const f = fixture(t), started = f.launch('W-001', { writes: ['src/a.txt'], reads: [] });
  const file = path.join(f.project, 'src/a.txt'); fs.writeFileSync(file, 'v1');
  f.as(started.member); f.w.result('run-test', started.operation.id, { files: [file] });
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test');
  f.runtime.send = (runId, oldId, body, requestId) => {
    const snapshot = f.w.run(runId), sending = Object.values(snapshot.operations).findLast(x => x.operationKind === 'continuation');
    assert.equal(sending.state, 'submitted'); assert.equal(sending.dispatchId, undefined); assert.equal(sending.native, undefined);
    const prior=f.runtime.actor; f.root(); f.w.sync(runId); f.runtime.actor=prior;
    assert.equal(f.w.run(runId).operations[sending.id].state, 'submitted');
    f.runtime.rows.push({ dispatchId: 'dispatch-followup', state: 'ready' });
    return { dispatchId: 'dispatch-followup', taskId: 'task-followup', runId };
  };
  f.as(f.bingbu); const sent = f.w.message('run-test', started.member.id, 'W-001', 'Fix same scope', undefined, 1);
  assert.equal(sent.state, 'delivered');
  fs.writeFileSync(file, 'v2'); f.as(f.w.run('run-test').members[started.member.id]);
  const bundle = f.w.result('run-test', sent.id, { files: [file] }).result;
  assert.equal(bundle.contributions.length, 1);
  assert.equal(bundle.contributions[0].operationId, sent.id);
  f.runtime.rows.find(x => x.dispatchId === 'dispatch-followup').state = 'succeeded';
  f.root(); f.w.sync('run-test'); f.as(f.xingbu);
  f.w.review('run-test', 'W-001', { generation: 1, kind: 'artifact-acceptance', digest: bundle.digest, verdict: 'approved', evidence: [f.proof] });
});

test('cancel before late start receipt persists and runs the authorized stop once accepted', t => {
  const f = fixture(t); let stopped=0;
  f.runtime.onStart = () => { const prior=f.runtime.actor; f.root(); f.w.control('run-test', 'cancel', 'W-001'); f.runtime.actor=prior; };
  const stop = f.runtime.stop.bind(f.runtime);
  f.runtime.stop = (...args) => { stopped++; return stop(...args); };
  const started = f.launch();
  assert.equal(stopped, 1);
  assert.equal(f.w.run('run-test').operations[started.operation.id].state, 'settled');
  assert.equal(f.w.run('run-test').items['W-001'].cancelled, true);
});

test('failed with live or unverifiable resources retains claims and cancellation remains pending', t => {
  const f = fixture(t), started = f.launch();
  Object.assign(f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId), { state: 'failed', terminalState: 'retained', projection: { liveness: { verdict: 'unverifiable' } } });
  f.root(); f.w.sync('run-test');
  assert.equal(f.w.run('run-test').operations[started.operation.id].state, 'accepted');
  f.runtime.stop = () => ({ state: 'failed', terminalState: 'retained' });
  f.w.control('run-test', 'cancel', 'W-001');
  assert.match(f.w.show('run-test').items[0].controlResult, /仍有在途/);
  assert.throws(() => f.w.control('run-test', 'restart', 'W-001'), /在途/);
});

test('recovering a lost continuation applies replacement and message finalization exactly once', t => {
  const f = fixture(t), started = f.launch('W-001', { writes: ['src/a.txt'], reads: [] });
  const file = path.join(f.project, 'src/a.txt'); fs.writeFileSync(file, 'v1');
  f.as(started.member); f.w.result('run-test', started.operation.id, { files: [file] });
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test'); f.as(f.bingbu);
  let sent=0;
  f.runtime.send = () => { sent++; f.runtime.rows.push({ dispatchId: 'recovered-new', state: 'ready' }); throw new Error('response lost'); };
  assert.throws(() => f.w.message('run-test', started.member.id, 'W-001', 'Repair file', undefined, 1), /response lost/);
  const op = Object.values(f.w.run('run-test').operations).findLast(x => x.operationKind === 'continuation');
  f.runtime.request = () => ({ state: 'pending', receipt: { accepted: { dispatchId: 'recovered-new', taskId: 'new-task' } } });
  f.runtime.dispatch = () => ({ id: 'recovered-new', taskId: 'new-task', runId: 'run-test' });
  f.w.recover('run-test', op.id);
  let run = f.w.run('run-test');
  assert.equal(run.operations[started.operation.id].supersededBy, op.id);
  assert.equal(run.messages.find(x => x.id === op.id).state, 'delivered');
  assert.equal(run.members[started.member.id].dispatchId, 'recovered-new');
  fs.writeFileSync(file, 'v2'); f.as(run.members[started.member.id]);
  const bundle = f.w.result('run-test', op.id, { files: [file] }).result;
  assert.equal(bundle.contributions.length, 1); assert.equal(bundle.contributions[0].operationId, op.id);
  f.as(f.bingbu); f.w.recover('run-test', op.id);
  f.runtime.request = () => ({ state: 'completed', receipt: { dispatchId: started.member.dispatchId, taskId: started.operation.taskId, runId: 'run-test' } });
  f.w.recover('run-test', started.operation.id);
  run = f.w.run('run-test');
  assert.equal(run.operations[started.operation.id].state, 'settled');
  assert.equal(run.members[started.member.id].dispatchId, 'recovered-new');
  assert.equal(sent, 1);
});

test('recovery never overwrites a receipt Run or trusts a cross-Run checkpoint', t => {
  const f = fixture(t);
  f.runtime.start = () => { throw new Error('lost'); };
  assert.throws(() => f.launch(), /lost/);
  const op = Object.values(f.w.run('run-test').operations).findLast(x => x.position === 'executor');
  f.runtime.request = () => ({ state: 'completed', receipt: { dispatchId: 'd', taskId: 't', runId: 'other-run' } });
  assert.equal(f.w.recover('run-test', op.id).confirmed, false);
  assert.equal(f.w.run('run-test').operations[op.id].dispatchId, undefined);
  f.runtime.request = () => ({ state: 'pending', receipt: { accepted: { dispatchId: 'd', taskId: 't' } } });
  f.runtime.dispatch = () => ({ id: 'd', taskId: 't', runId: 'other-run' });
  assert.throws(() => f.w.recover('run-test', op.id), /checkpoint/);
});

test('owner forwarding settles the original request and preserves the replacement chain', t => {
  const f = fixture(t), started = f.launch();
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test'); f.as(f.bingbu);
  f.runtime.send = () => { const error=new Error('owner required'); error.code='consumer_fenced'; throw error; };
  const first = f.w.message('run-test', started.member.id, 'W-001', 'Repair', undefined, 1);
  assert.equal(first.state, 'owner-required');
  f.runtime.send = () => ({ dispatchId: 'owner-new', taskId: 'owner-task', runId: 'run-test' });
  f.root(); const forwarded = f.w.forward('run-test', first.messageId);
  assert.equal(forwarded.state, 'delivered');
  const run = f.w.run('run-test');
  assert.equal(run.messages.find(x => x.id === first.messageId).state, 'delivered');
  assert.equal(run.operations[first.messageId].state, 'forwarded');
  assert.equal(run.operations[started.operation.id].supersededBy, forwarded.id);
});

test('a peer send refused as not-a-helper of a settled dispatch becomes owner-required and rebinds on forward', t => {
  const f = fixture(t), started = f.launch();
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test'); f.as(f.bingbu);
  const refusal = { ok: false, error: { code: 'task_not_found', message: `Dispatch ${started.member.dispatchId} is not a helper of Dispatch peer, so only the coordinator or the worker that started it can give it more work. No effects were applied.`, data: { effectsApplied: false } } };
  f.runtime.send = () => { const error = new Error('refused'); error.code = 'task_not_found'; error.receipt = refusal; throw error; };
  const first = f.w.message('run-test', started.member.id, 'W-001', 'Repair', undefined, 1);
  assert.equal(first.state, 'owner-required');
  assert.equal(f.w.run('run-test').operations[first.messageId].rawReceipt.error.code, 'task_not_found');
  f.runtime.send = () => ({ dispatchId: 'owner-new', taskId: 'owner-task', runId: 'run-test' });
  f.root(); const forwarded = f.w.forward('run-test', first.messageId);
  assert.equal(forwarded.state, 'delivered');
  const run = f.w.run('run-test'), member = run.members[started.member.id];
  assert.equal(member.dispatchId, 'owner-new');
  assert.ok(member.dispatches.includes('owner-new'));
  assert.equal(run.operations[first.messageId].state, 'forwarded');
});

test('a continuation delivered to an executor\'s open follow-up rebinds the member from the delivery target', t => {
  const f = fixture(t), started = f.launch();
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test'); f.as(f.bingbu);
  f.runtime.dispatch = id => ({ id, taskId: 'follow-task', runId: 'run-test' });
  f.runtime.send = () => ({ message: { id: 'msg-follow', run_id: 'run-test', to_handle: 'dispatch:follow-up' } });
  const sent = f.w.message('run-test', started.member.id, 'W-001', 'Repair the report', undefined, 1);
  const run = f.w.run('run-test'), member = run.members[started.member.id];
  assert.equal(member.dispatchId, 'follow-up');
  assert.ok(member.dispatches.includes('follow-up'));
  assert.equal(run.operations[sent.id].state, 'accepted');
  assert.equal(run.operations[sent.id].taskId, 'follow-task');
});

test('a message-only delivery to another Run or an unresolvable dispatch stays unknown', t => {
  const f = fixture(t), started = f.launch();
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test'); f.as(f.bingbu);
  f.runtime.dispatch = () => { throw new Error('unverified'); };
  f.runtime.send = (runId, dispatchId, body) => { f.runtime.calls.push({ dispatchId, body }); return { message: { id: 'msg-follow', run_id: 'run-test', to_handle: 'dispatch:follow-up' } }; };
  const sent = f.w.message('run-test', started.member.id, 'W-001', 'Repair the report', undefined, 1);
  let run = f.w.run('run-test');
  assert.equal(run.operations[sent.id].state, 'unknown');
  assert.equal(run.members[started.member.id].dispatchId, started.member.dispatchId);
  // Once the Dispatch can be verified, recover re-finalizes the stored receipt without resending.
  f.runtime.dispatch = id => ({ id, taskId: 'follow-task', runId: 'run-test' });
  f.runtime.request = () => ({ state: 'absent' });
  const recovered = f.w.recover('run-test', sent.id);
  run = f.w.run('run-test');
  assert.equal(recovered.confirmed, true);
  assert.equal(run.members[started.member.id].dispatchId, 'follow-up');
  assert.equal(run.operations[sent.id].state, 'accepted');
  assert.equal(f.runtime.calls.filter(x => x.body === 'Repair the report').length, 1);
});

test('a plain task_not_found without the helper refusal stays unknown', t => {
  const f = fixture(t), started = f.launch();
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test'); f.as(f.bingbu);
  f.runtime.send = () => { const error = new Error('missing'); error.code = 'task_not_found'; error.receipt = { ok: false, error: { code: 'task_not_found', message: 'Task missing', data: { effectsApplied: false } } }; throw error; };
  assert.throws(() => f.w.message('run-test', started.member.id, 'W-001', 'Repair', undefined, 1), /missing/);
  const op = Object.values(f.w.run('run-test').operations).findLast(x => x.operationKind === 'continuation');
  assert.equal(op.state, 'unknown');
});

test('a proven no-effect refusal can be explicitly replaced but unknown work cannot', t => {
  const f = fixture(t), start=f.runtime.start.bind(f.runtime);
  f.runtime.start = () => { const error = new Error('native refused without effects'); error.receipt={ok:false,error:{data:{effectsApplied:false}}}; throw error; };
  assert.throws(() => f.launch(), /native refused/);
  const old = Object.values(f.w.run('run-test').operations).findLast(x => x.position === 'executor');
  assert.equal(old.state, 'refused');
  f.runtime.start = start;
  const next = f.launch('W-001', { replaces: old.id });
  assert.equal(f.w.run('run-test').operations[old.id].supersededBy, next.operation.id);
  const file=path.join(f.project,'src/result.txt'); fs.writeFileSync(file,'replacement'); f.as(next.member);
  const result=f.w.result('run-test',next.operation.id,{files:[file]}).result;
  f.runtime.rows.find(x=>x.dispatchId===next.member.dispatchId).state='succeeded'; f.root(); f.w.sync('run-test'); f.as(f.xingbu);
  f.w.review('run-test','W-001',{generation:1,kind:'artifact-acceptance',digest:result.digest,verdict:'approved',evidence:[f.proof]});
});

test('verification cannot replace a refused implementation obligation', t => {
  const f = fixture(t);
  f.runtime.start = () => { const error=new Error('no effects'); error.receipt={ok:false,error:{data:{effectsApplied:false}}}; throw error; };
  assert.throws(() => f.launch('W-001', { writes: [], reads: [] }), /no effects/);
  const op=Object.values(f.w.run('run-test').operations).findLast(x=>x.position==='executor');
  assert.equal(op.phase,'implementation');
  assert.throws(()=>f.launch('W-001',{writes:[],reads:[],phase:'verification',replaces:op.id}),/同階段/);
  assert.equal(f.w.run('run-test').operations[op.id].supersededBy,undefined);
});

test('an explicitly authorized Xingbu implementation retains its writes and cannot self-accept', t => {
  const f=fixture(t); f.as(f.xingbu);
  const fixed=f.w.launch('run-test','xingbu','executor','W-001',{generation:1,phase:'implementation',writes:['src/fix.txt'],reads:[],spec:'Fix the assigned scope'});
  assert.deepEqual(fixed.operation.writes,['src/fix.txt']);
  const file=path.join(f.project,'src/fix.txt'); fs.writeFileSync(file,'fixed'); f.as(fixed.member);
  const result=f.w.result('run-test',fixed.operation.id,{files:[file]}).result;
  f.runtime.rows.find(x=>x.dispatchId===fixed.member.dispatchId).state='succeeded'; f.root(); f.w.sync('run-test'); f.as(fixed.member);
  assert.throws(()=>f.w.review('run-test','W-001',{generation:1,kind:'artifact-acceptance',digest:result.digest,verdict:'approved',evidence:[f.proof]}),/獨立性/);
});

test('dependency cycles are rejected without replacing the current plan', t => {
  const f=fixture(t); f.root(); f.add('W-002'); f.as(f.zhongshu);
  f.w.plan('run-test','W-001',{generation:1,description:'A after B',reads:['src'],writes:['src'],dependencies:['W-002']});
  assert.throws(()=>f.w.plan('run-test','W-002',{generation:1,description:'B after A',reads:['src'],writes:['src'],dependencies:['W-001']}),/相依成環/);
  assert.equal(f.w.run('run-test').items['W-002'].plan,null);
});

test('named tool resources do not inherit filesystem prefix authorization', t => {
  const f=fixture(t); f.root();
  f.w.add('run-test',{id:'W-002',title:'Browser scope',requirement:'Use only named browser',reads:[],writes:[],resources:['browser'],acceptance:['one browser']});
  f.as(f.zhongshu);
  assert.throws(()=>f.w.plan('run-test','W-002',{generation:1,description:'Widen named resource',reads:[],writes:[],resources:['browser/other']}),/超出需求授權/);
});

test('a worker knowing the coordinator session cannot change session-wide authority or open a Run', t => {
  const f=fixture(t); f.as(f.bingbu);
  assert.throws(()=>assertWorkflowOwner('codex:workflow',f.runtime),/只有此 Run 原協調者/);
  assert.throws(()=>setWorkflowEnabled('codex:workflow',false,f.runtime),/只有此 Run 原協調者/);
  assert.throws(()=>f.w.open('Unauthorised new goal'),/只有此 Run 原協調者/);
  assert.equal(f.w.run('run-test').enabled,true);
});

test('two dead-lock recoverers cannot remove a newly acquired live lock', async t => {
  const f=fixture(t), exited=spawnSync(process.execPath,['-e','']);
  assert.equal(exited.status,0);
  const lock=path.join(process.env.EDICT_HOME,'workflow.lock');
  fs.writeFileSync(lock,JSON.stringify({pid:exited.pid,host:os.hostname()}));
  const shared=new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT*4);
  const code=String.raw`
    const {workerData,parentPort}=require('node:worker_threads');
    const fs=require('node:fs'),path=require('node:path');
    const flags=new Int32Array(workerData.shared),read=fs.readFileSync,unlink=fs.unlinkSync;
    process.env.EDICT_HOME=workerData.home;
    function wait(index){if(Atomics.load(flags,index)===0&&Atomics.wait(flags,index,0,5000)==='timed-out')throw Error('barrier '+index);}
    let captured=false;
    fs.readFileSync=function(file,...rest){
      const text=read.call(this,file,...rest);
      if(workerData.name==='B'&&String(file)===workerData.lock){
        if(!captured&&String(text).includes(String(workerData.deadPid))){captured=true;Atomics.store(flags,0,1);Atomics.notify(flags,0);wait(1);}
        else if(captured){Atomics.store(flags,2,1);Atomics.notify(flags,2);}
      }
      if(workerData.name==='A'&&String(file)===path.join(workerData.home,'workflow.json')){Atomics.store(flags,1,1);Atomics.notify(flags,1);wait(2);}
      return text;
    };
    fs.unlinkSync=function(file,...rest){
      if(workerData.name==='A'&&String(file)===workerData.lock){Atomics.store(flags,1,2);Atomics.notify(flags,1);}
      if(workerData.name==='B'&&String(file)===workerData.lock&&Atomics.load(flags,1)===1){
        try{const owner=JSON.parse(read.call(fs,file,'utf8'));if(owner.pid===process.pid)Atomics.store(flags,3,1);}catch{}
        Atomics.store(flags,2,1);Atomics.notify(flags,2);
      }
      return unlink.call(this,file,...rest);
    };
    (async()=>{
      if(workerData.name==='A')wait(0);
      const {Workflow}=await import(workerData.module);
      const w=new Workflow('codex:workflow',{identity:()=>({owner:true})});
      w.add('run-test',{id:'lock-'+workerData.name,title:'lock test',requirement:'preserve both writes',reads:[],writes:[],acceptance:['atomic']});
      parentPort.postMessage('done');
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const run=name=>new Promise((resolve,reject)=>{
    const worker=new Worker(code,{eval:true,workerData:{name,shared,home:process.env.EDICT_HOME,lock,deadPid:exited.pid,module:new URL('../src/workflow.mjs',import.meta.url).href}});
    worker.once('error',reject);worker.once('exit',code=>code===0?resolve():reject(Error('lock worker exit '+code)));
  });
  await Promise.all([run('A'),run('B')]);
  assert.equal(Atomics.load(new Int32Array(shared),3),0);
  const items=f.w.run('run-test').items;
  assert.ok(items['lock-A']);assert.ok(items['lock-B']);
});

test('a child worktree result is checked against its native confirmed root', t => {
  const f=fixture(t),child=path.join(f.dir,'child'); fs.mkdirSync(path.join(child,'src'),{recursive:true});
  f.runtime.worktreeRoot=()=>child;
  const started=f.launch('W-001',{worktree:'new-child',reads:[],writes:['src']});
  assert.equal(started.operation.root,child);
  const file=path.join(child,'src/result.txt');fs.writeFileSync(file,'child output');f.as(started.member);
  assert.equal(f.w.result('run-test',started.operation.id,{files:[file]}).archivedOnly,false);
  const wrong=path.join(f.project,'src/wrong.txt');fs.writeFileSync(wrong,'other worktree');
  assert.throws(()=>f.w.result('run-test',started.operation.id,{files:[wrong]}),/不在委派寫入範圍/);
});
