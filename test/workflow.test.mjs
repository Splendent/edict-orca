import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { Workflow, assertWorkflowOwner, setWorkflowEnabled, workflowStatus } from '../src/workflow.mjs';
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

for (const status of ['ended', 'running', 'unknown', 'unavailable']) {
  test(`admission accounts for other Run members with ${status} evidence`, t => {
    const f = fixture(t), file = path.join(process.env.EDICT_HOME, 'workflow.json');
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    const old = structuredClone(db.runs['run-test']); old.id = 'old-run';
    old.operations = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, {
      id: `old-${i}`, memberId: `old-member-${i}`, runId: old.id, state: 'accepted', position: 'head',
    }]));
    db.runs[old.id] = old;
    fs.writeFileSync(file, JSON.stringify(db));
    f.runtime.capacityEvidence = (id) => {
      assert.equal(id, old.id);
      if (status === 'unavailable') throw new Error('native unavailable');
      return { ended: status === 'ended' };
    };
    if (status === 'ended') assert.equal(f.launch().confirmed, true);
    else assert.throws(() => f.launch(), /派工資源已滿/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).runs[old.id], old);
  });
}

function addOtherRun(f, count = 16) {
  const file = path.join(process.env.EDICT_HOME, 'workflow.json');
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  db.runs.other = { ...structuredClone(db.runs['run-test']), id: 'other', operations: Object.fromEntries(Array.from({ length: count }, (_, i) => [i, {
    id: `other-${i}`, memberId: `other-${i}`, dispatchId: `dispatch-other-${i}`, taskId: `task-other-${i}`, runId: 'other', position: 'head', state: 'accepted',
  }])) };
  fs.writeFileSync(file, JSON.stringify(db));
  return file;
}

for (const action of ['launch', 'replace', 'message']) {
  test(`${action} queries capacity only outside workflow.lock and reuses ended cache`, t => {
    const f = fixture(t);
    if (action === 'replace') {
      f.runtime.rows.forEach(row => { row.state = 'succeeded'; });
      f.w.sync('run-test');
      f.root();
    } else if (action === 'message') f.as(f.zhongshu);
    addOtherRun(f);
    let queries = 0, queriedWhileLocked = false;
    f.runtime.capacityEvidence = () => {
      queries++;
      queriedWhileLocked ||= fs.existsSync(path.join(process.env.EDICT_HOME, 'workflow.lock'));
      return { ended: true, reason: 'terminal-missing' };
    };
    if (action === 'launch') {
      f.launch('W-001', { reads: ['src/a'], writes: ['src/a'] });
      f.launch('W-001', { reads: ['src/b'], writes: ['src/b'] });
    } else if (action === 'replace') {
      f.w.replace('run-test', f.zhongshu.id, { spec: 'Continue planning' });
      f.w.launch('run-test', 'zhongshu', 'head', undefined, { spec: 'Reuse existing member' });
    } else {
      f.w.message('run-test', f.menxia.id, 'W-001', 'Review the plan', undefined, 1);
      f.w.message('run-test', f.menxia.id, 'W-001', 'Review the plan again', undefined, 1);
    }
    assert.equal(queriedWhileLocked, false);
    assert.equal(queries, 16);
    assert.equal(fs.readdirSync(path.join(process.env.EDICT_HOME, 'capacity-ended')).length, 16);
  });
}

test('operations appearing after the capacity snapshot remain counted during admission', t => {
  const f = fixture(t), file = addOtherRun(f, 1);
  let queries = 0;
  f.runtime.capacityEvidence = () => {
    queries++;
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (let i = 1; i <= 16; i++) db.runs.other.operations[i] = {
      id: `new-${i}`, memberId: `new-${i}`, dispatchId: `new-dispatch-${i}`, taskId: `new-task-${i}`, runId: 'other', position: 'head', state: 'accepted',
    };
    fs.writeFileSync(file, JSON.stringify(db));
    return { ended: true, reason: 'terminal-missing' };
  };
  assert.throws(() => f.launch(), /派工資源已滿/);
  assert.equal(queries, 1);
});

test('current Run executor limit is unchanged even if native capacity evidence says ended', t => {
  const f = fixture(t);
  f.runtime.capacityEvidence = () => { throw new Error('current Run must not be queried'); };
  for (const name of ['one', 'two', 'three']) f.launch('W-001', { reads: [`src/${name}`], writes: [`src/${name}`] });
  assert.throws(() => f.launch('W-001', { reads: ['src/four'], writes: ['src/four'] }), /派工資源已滿/);
});

test('delegation names and status expose all subordinate assignments and cross-worktree locations', t => {
  const f = fixture(t);
  const first = f.launch('W-001', { title: '冰霜特效', reads: ['src/frost'], writes: ['src/frost'], worktree: `path:${f.project}` });
  const second = f.launch('W-001', { title: '傷害數值', reads: ['src/damage'], writes: ['src/damage'] });
  assert.match(first.presentation.label, /兵部郎中.*W-001 冰霜特效.*←兵部尚書/);
  assert.notEqual(first.presentation.label, second.presentation.label);
  assert.match(f.runtime.calls.at(-1).options.title, /兵部郎中.*傷害數值/);
  const tree = workflowStatus('codex:workflow')[0].hierarchy[0];
  const shangshu = tree.children.find(x => x.role === 'shangshu');
  const bingbu = shangshu.children.find(x => x.role === 'bingbu');
  assert.equal(bingbu.memberId, f.bingbu.id);
  assert.deepEqual(bingbu.children.map(x => x.assignment), ['冰霜特效', '傷害數值']);
  assert.equal(bingbu.children[0].supervisorId, f.bingbu.id);
  assert.equal(bingbu.children[0].worktree, f.project);
  assert.equal(bingbu.children[0].workerState, null);
  f.root(); f.w.sync('run-test');
  const synced = f.w.show('run-test').hierarchy[0].children.find(x => x.role === 'shangshu').children.find(x => x.role === 'bingbu').children[0];
  assert.equal(synced.workerState, 'ready');
  assert.ok(synced.observedAt);
});

test('presentation failure preserves accepted work and sync retries only presentation', t => {
  const f = fixture(t); f.runtime.rename = () => { throw new Error('UI unavailable'); };
  const started = f.launch('W-001', { title: '冰霜特效' });
  assert.equal(started.confirmed, true);
  assert.equal(started.operation.state, 'accepted');
  assert.equal(started.presentation.state, 'unconfirmed');
  const starts = f.runtime.counter;
  let renamed = 0;
  f.runtime.rename = () => { renamed++; return { state: 'applied' }; };
  f.root(); f.w.sync('run-test');
  assert.equal(f.runtime.counter, starts);
  assert.equal(f.w.run('run-test').members[started.member.id].presentation.state, 'applied');
  const attempts = renamed; f.w.sync('run-test');
  assert.equal(renamed, attempts);
});

test('head handoff keeps the assignment visible on its existing Dispatch', t => {
  const f = fixture(t); f.as(f.zhongshu);
  f.w.message('run-test', f.shangshu.id, 'W-001', 'Dispatch the approved work', undefined, 1);
  const head = workflowStatus('codex:workflow')[0].hierarchy[0].children.find(x => x.role === 'shangshu');
  assert.equal(head.work, 'W-001');
  assert.equal(head.assignment, 'W-001');
});

test('a design-only item closes on its approved plan without an implementation result', t => {
  const f = fixture(t);
  f.root(); f.w.add('run-test', { id: 'W-002', title: 'Design only', requirement: 'Write a design table', reads: ['src'], writes: [], resources: [], acceptance: ['Design reviewed'] });
  f.as(f.zhongshu);
  const proposal = f.w.plan('run-test', 'W-002', { generation: 1, description: 'Design table for three skills', reads: ['src'], writes: [], acceptance: ['Design reviewed'] });
  f.w.launch('run-test', 'menxia', 'head', 'W-002', { spec: 'Review W-002', generation: 1 });
  f.as(f.menxia);
  assert.throws(() => f.w.review('run-test', 'W-002', { generation: 1, kind: 'closure-confirmation', digest: proposal.digest, verdict: 'approved', evidence: [f.proof] }), /設計型工作缺少已核可的方案/);
  f.w.review('run-test', 'W-002', { generation: 1, kind: 'plan-approval', digest: proposal.digest, verdict: 'approved', evidence: [f.proof] });
  assert.throws(() => f.w.review('run-test', 'W-002', { generation: 1, kind: 'closure-confirmation', digest: 'wrong', verdict: 'approved', evidence: [f.proof] }), /摘要不符/);
  f.w.review('run-test', 'W-002', { generation: 1, kind: 'closure-confirmation', digest: proposal.digest, verdict: 'approved', evidence: [f.proof] });
  assert.equal(f.w.run('run-test').items['W-002'].done, true);
  // An item that authorizes writes still needs a delivered result.
  assert.throws(() => f.w.review('run-test', 'W-001', { generation: 1, kind: 'closure-confirmation', digest: f.proposal.digest, verdict: 'approved', evidence: [f.proof] }), /缺少有效方案、完整交付或成果/);
});

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

test('overlap rejection names the in-flight work, operation and conflicting dimension', t => {
  const f = fixture(t), first = f.launch('W-001', { reads: ['src'], writes: ['src/a.txt'] });
  const error = (() => { try { f.launch('W-001', { reads: ['src/a.txt'], writes: ['src/a.txt'] }); } catch (e) { return e; } })();
  assert.match(error.message, /^與在途工作的檔案或工具範圍衝突：/);
  assert.match(error.message, new RegExp(`W-001 bingbu/executor 操作 ${first.operation.id}`));
  assert.match(error.message, /寫入\/寫入：本次寫入 src\/a\.txt，在途寫入 src\/a\.txt/);
  assert.match(error.message, /讀取\/寫入：本次讀取 src\/a\.txt，在途寫入 src\/a\.txt/);
  assert.doesNotMatch(error.message, /routes|tail|\d+:\d+/);
  assert.doesNotMatch(error.message, /保守視為重疊/);
});

test('sibling outputs under a wholly read directory conflict with a hint', t => {
  const f = fixture(t); f.launch('W-001', { reads: ['src'], writes: ['src/a.txt'] });
  assert.throws(() => f.launch('W-001', { reads: ['src'], writes: ['src/b.txt'] }), /讀取目錄 src 涵蓋另一方在該目錄內的寫入；若不需讀取那些輸出，雙方改列出實際要讀的檔案/);
});

test('sibling outputs with file-level reads run in parallel', t => {
  const f = fixture(t); f.launch('W-001', { reads: ['src/input.txt'], writes: ['src/a.txt'] });
  assert.equal(f.launch('W-001', { reads: ['src/input.txt'], writes: ['src/b.txt'] }).confirmed, true);
});

test('shared tool resources are named; distinct resources and disjoint paths run in parallel', t => {
  const f = fixture(t);
  f.root(); f.w.add('run-test', { id: 'W-002', title: 'VFX', requirement: 'Implement VFX', reads: ['src/vfx'], writes: ['src/vfx'], resources: ['vite-5216'], acceptance: ['Check'] });
  f.w.add('run-test', { id: 'W-003', title: 'Growth', requirement: 'Implement growth', reads: ['src/growth'], writes: ['src/growth'], resources: ['vite-5216', 'vite-5217'], acceptance: ['Check'] });
  f.as(f.zhongshu);
  for (const [id, resources] of [['W-002', ['vite-5216']], ['W-003', ['vite-5216', 'vite-5217']]]) {
    const proposal = f.w.plan('run-test', id, { generation: 1, description: id, reads: [`src/${id === 'W-002' ? 'vfx' : 'growth'}`], writes: [`src/${id === 'W-002' ? 'vfx' : 'growth'}`], resources });
    f.w.launch('run-test', 'menxia', 'head', id, { spec: 'Review', generation: 1 });
    f.as(f.menxia); f.approve(proposal.digest, id); f.as(f.zhongshu);
    f.w.launch('run-test', 'shangshu', 'head', id, { spec: 'Coordinate', generation: 1 });
    f.as(f.shangshu); f.w.launch('run-test', 'bingbu', 'head', id, { spec: 'Implement', generation: 1 }); f.as(f.zhongshu);
  }
  f.as(f.bingbu); const vfx = f.launch('W-002');
  assert.throws(() => f.launch('W-003'), new RegExp(`W-002 bingbu/executor 操作 ${vfx.operation.id}（共用工具資源 vite-5216）`));
  assert.equal(f.launch('W-003', { resources: ['vite-5217'] }).confirmed, true);
});

test('a wildcard tool resource and unknown ranges are named as such', t => {
  const f = fixture(t);
  f.root(); f.w.add('run-test', { id: 'W-002', title: 'Ports', requirement: 'Use every port', reads: ['src/a'], writes: ['src/a'], resources: ['*'], acceptance: ['Check'] });
  f.as(f.zhongshu);
  const proposal = f.w.plan('run-test', 'W-002', { generation: 1, description: 'all ports', reads: ['src/a'], writes: ['src/a'], resources: ['*'] });
  f.w.launch('run-test', 'menxia', 'head', 'W-002', { spec: 'Review', generation: 1 });
  f.as(f.menxia); f.approve(proposal.digest, 'W-002'); f.as(f.zhongshu);
  f.w.launch('run-test', 'shangshu', 'head', 'W-002', { spec: 'Coordinate', generation: 1 });
  f.as(f.shangshu); f.w.launch('run-test', 'bingbu', 'head', 'W-002', { spec: 'Implement', generation: 1 });
  f.as(f.bingbu); f.launch('W-002', { resources: ['*'] });
  f.root(); f.w.amend('run-test', 'W-001', { generation: 1, resources: ['vite-5217'], reason: 'port' });
  f.as(f.zhongshu);
  const next = f.w.plan('run-test', 'W-001', { generation: 1, description: 'b', reads: ['src/b'], writes: ['src/b'], resources: ['vite-5217'] });
  f.as(f.menxia); f.approve(next.digest);
  f.as(f.bingbu);
  assert.throws(() => f.launch('W-001', { reads: ['src/b'], writes: ['src/b'], resources: ['vite-5217'] }), /在途操作宣告資源 \*，與所有工具資源互斥（本次資源 vite-5217）/);
  assert.throws(() => f.launch('W-001', { reads: ['src/b'], writes: ['src/b'], resources: [], worktree: 'new-child' }), /寫入\/寫入：本次寫入 src\/b，在途寫入 src\/a.*實體範圍未確認/);
});

test('root amends requirement resources, clearing plan approval and recording history', t => {
  const f = fixture(t);
  f.as(f.zhongshu);
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, resources: ['vite-5217'], reason: 'port' }), /只有原對話/);
  f.root();
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 2, resources: ['vite-5217'], reason: 'port' }), /工作世代不符/);
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, resources: ['vite-5217'], acceptance: ['x'], reason: 'port' }), /只接受 generation、resources、reads、extraReads、reason/);
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, reason: 'nothing' }), /至少須提供 resources、reads 或 extraReads/);
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, resources: ['vite-5217'] }), /缺少 reason/);
  const result = f.w.amend('run-test', 'W-001', { generation: 1, resources: ['vite-5217'], reason: 'vite-5216 is used by W-002' });
  const run = f.w.run('run-test'), item = run.items['W-001'];
  assert.deepEqual(item.resources, ['vite-5217']);
  assert.equal(item.plan, null);
  assert.equal(item.generation, 1);
  assert.deepEqual(run.history.at(-1), { ...result.amendment });
  assert.equal(run.history.at(-1).action, 'amend');
  assert.deepEqual(run.history.at(-1).changes, { resources: { from: [], to: ['vite-5217'] } });
  assert.equal(run.history.at(-1).clearedPlan.digest, f.proposal.digest);
  f.as(f.bingbu);
  assert.throws(() => f.launch(), /必須有中書送審方案/);
  f.as(f.zhongshu);
  const proposal = f.w.plan('run-test', 'W-001', { generation: 1, description: 'New port', reads: ['src'], writes: ['src'], resources: ['vite-5217'] });
  f.as(f.bingbu); assert.throws(() => f.launch(), /缺少門下對目前方案的正式核可/);
  f.as(f.menxia); f.approve(proposal.digest);
  f.as(f.bingbu); assert.equal(f.launch().operation.resources[0], 'vite-5217');
});

test('amend refuses a generation that already has a delivered result', t => {
  const f = fixture(t), started = f.launch('W-001', { reads: [], writes: ['src/a.txt'] });
  const file = path.join(f.project, 'src/a.txt'); fs.writeFileSync(file, 'A delivered');
  f.as(started.member); f.w.result('run-test', started.operation.id, { files: [file] });
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test');
  assert.equal(f.w.run('run-test').operations[started.operation.id].state, 'settled');
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, resources: ['vite-5217'], reason: 'port' }), /已有交付成果.*control cancel／restart.*新工作項目/);
  assert.ok(f.w.run('run-test').items['W-001'].result);
  assert.ok(f.w.run('run-test').items['W-001'].plan);
});

test('a result from an earlier revision of the generation does not block amend', t => {
  const f = fixture(t), started = f.launch('W-001', { reads: [], writes: ['src/a.txt'] });
  const file = path.join(f.project, 'src/a.txt'); fs.writeFileSync(file, 'A delivered');
  f.as(started.member); f.w.result('run-test', started.operation.id, { files: [file] });
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test');
  f.as(f.zhongshu); f.plan();
  const replanned = f.w.run('run-test').items['W-001'];
  assert.equal(replanned.result, null); assert.equal(replanned.revision, 2);
  f.root();
  const amended = f.w.amend('run-test', 'W-001', { generation: 1, resources: ['vite-5217'], reason: 'port' });
  assert.deepEqual(amended.item.resources, ['vite-5217']);
  assert.equal(amended.item.revision, 3);
});

test('amend bumps the revision so a settled stale executor result is archived only', t => {
  const f = fixture(t), started = f.launch('W-001', { reads: [], writes: ['src/a.txt'] });
  f.runtime.rows.find(x => x.dispatchId === started.member.dispatchId).state = 'succeeded';
  f.root(); f.w.sync('run-test');
  const before = f.w.run('run-test').items['W-001'].revision;
  for (const input of [null, ['vite-5217'], 'vite-5217']) assert.throws(() => f.w.amend('run-test', 'W-001', input), /需求修訂輸入必須是 JSON 物件/);
  f.w.amend('run-test', 'W-001', { generation: 1, resources: ['vite-5217'], reason: 'port' });
  const item = f.w.run('run-test').items['W-001'];
  assert.equal(item.revision, before + 1); assert.equal(item.plan, null);
  const file = path.join(f.project, 'src/a.txt'); fs.writeFileSync(file, 'late');
  f.as(started.member);
  const late = f.w.result('run-test', started.operation.id, { files: [file] });
  assert.equal(late.archivedOnly, true);
  assert.equal(f.w.run('run-test').items['W-001'].result, null);
});

// Adds an approved item with a bingbu head so executors can be delegated for it.
function approvedItem(f, id, requirement, plan = requirement) {
  f.root(); f.w.add('run-test', { id, title: id, requirement: id, acceptance: ['Check'], ...requirement });
  f.as(f.zhongshu);
  const proposal = f.w.plan('run-test', id, { generation: 1, description: id, ...plan });
  f.w.launch('run-test', 'menxia', 'head', id, { spec: 'Review', generation: 1 });
  f.as(f.menxia); f.approve(proposal.digest, id); f.as(f.zhongshu);
  f.w.launch('run-test', 'shangshu', 'head', id, { spec: 'Coordinate', generation: 1 });
  f.as(f.shangshu); f.w.launch('run-test', 'bingbu', 'head', id, { spec: 'Implement', generation: 1 });
  f.as(f.bingbu);
  return proposal;
}
function otherRoot(f) {
  const other = path.join(f.dir, 'other-worktree');
  fs.mkdirSync(path.join(other, 'src'), { recursive: true }); fs.mkdirSync(path.join(other, 'public'), { recursive: true });
  return other;
}

test('amend widens reads and extraReads but never narrows them or changes writes', t => {
  const f = fixture(t), other = otherRoot(f);
  f.root();
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, reads: ['src/a'], reason: 'narrow' }), /reads 只能擴大/);
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, writes: ['src', 'api'], reason: 'more writes' }), /writes 不能修訂/);
  const widened = f.w.amend('run-test', 'W-001', { generation: 1, reads: ['src', 'api', 'vite.config.ts'], extraReads: [{ root: other, reads: ['src'] }], reason: 'needs api and the other worktree' });
  const item = f.w.run('run-test').items['W-001'];
  assert.deepEqual(item.reads, ['src', 'api', 'vite.config.ts']);
  assert.deepEqual(item.writes, ['src']);
  assert.equal(item.extraReads[0].root, fs.realpathSync.native(other));
  assert.equal(item.plan, null);
  assert.deepEqual(Object.keys(widened.amendment.changes), ['reads', 'extraReads']);
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, extraReads: [], reason: 'narrow' }), /extraReads 只能擴大/);
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, extraReads: [{ root: other, reads: ['src/a'] }], reason: 'narrow' }), /extraReads 只能擴大/);
  f.w.amend('run-test', 'W-001', { generation: 1, extraReads: [{ root: other, reads: ['src', 'public'] }], reason: 'wider' });
  f.as(f.zhongshu);
  assert.throws(() => f.w.plan('run-test', 'W-001', { generation: 1, description: 'too wide', reads: ['src'], writes: ['src'], extraReads: [{ root: f.dir, reads: ['src'] }] }), /方案超出需求授權範圍/);
  const plan = f.w.plan('run-test', 'W-001', { generation: 1, description: 'cross root', reads: ['src'], writes: ['src'], extraReads: [{ root: other, reads: ['src'] }] });
  assert.deepEqual(plan.extraReads[0].reads, ['src']);
  f.as(f.menxia); f.approve(plan.digest);
  f.as(f.bingbu);
  assert.throws(() => f.launch('W-001', { extraReads: [{ root: other, reads: ['public'] }] }), /委派超出已核可範圍/);
  assert.equal(f.launch('W-001', { reads: ['src'], writes: ['src/a.txt'] }).operation.extraReads[0].reads[0], 'src');
});

test('extraReads accept only existing absolute directories with contained relative reads', t => {
  const f = fixture(t), other = otherRoot(f);
  f.root();
  const add = extraReads => f.w.add('run-test', { id: `W-${Math.random()}`, title: 'x', requirement: 'x', reads: ['src'], writes: [], extraReads, acceptance: ['Check'] });
  assert.throws(() => add([{ root: 'other-worktree', reads: ['src'] }]), /必須是既有目錄的絕對路徑/);
  assert.throws(() => add([{ root: path.join(f.dir, 'missing'), reads: ['src'] }]), /不存在/);
  assert.throws(() => add([{ root: path.join(f.proof), reads: ['src'] }]), /不是目錄/);
  for (const escape of ['../project/src', '/etc', 'C:/x', 'src/*'])
    assert.throws(() => add([{ root: other, reads: [escape] }]), /工作範圍只接受專案相對路徑或單獨的 \*/);
  assert.throws(() => add([{ root: other, reads: [] }]), /不可為空/);
  assert.throws(() => add([{ root: other, reads: ['src'], writes: ['src'] }]), /只接受 root 與 reads/);
  assert.throws(() => add({ root: other, reads: ['src'] }), /物件陣列/);
  const item = add([{ root: other + path.sep, reads: ['src'] }, { root: other, reads: ['public'] }]);
  assert.deepEqual(item.extraReads, [{ root: fs.realpathSync.native(other), reads: ['src', 'public'] }]);
});

test('UNC and drive-letter spellings of one extraReads root are the same root', t => {
  const f = fixture(t), other = fs.realpathSync.native(otherRoot(f));
  const drive = /^([A-Za-z]):\\(.*)$/.exec(other);
  const unc = drive && `\\\\localhost\\${drive[1]}$\\${drive[2]}`;
  if (process.platform !== 'win32' || !unc || !fs.existsSync(unc)) return t.skip('administrative share \\\\localhost\\<drive>$ unavailable');
  approvedItem(f, 'W-002', { reads: ['src'], writes: [], extraReads: [{ root: other, reads: ['src', 'public'] }] }, { reads: ['src'], writes: [], extraReads: [{ root: unc, reads: ['src'] }] });
  assert.equal(f.w.launch('run-test', 'bingbu', 'executor', 'W-002', { spec: 'Read via share', generation: 1, extraReads: [{ root: unc, reads: ['src'] }] }).confirmed, true);
  f.root();
  const merged = f.w.add('run-test', { id: 'W-003', title: 'x', requirement: 'x', reads: ['src'], writes: [], extraReads: [{ root: other, reads: ['src'] }, { root: unc, reads: ['public'] }], acceptance: ['Check'] });
  assert.deepEqual(merged.extraReads, [{ root: other, reads: ['src', 'public'] }]);
  f.w.amend('run-test', 'W-003', { generation: 1, extraReads: [{ root: unc, reads: ['src', 'public', 'docs'] }], reason: 'share spelling' });
});

test('a cross-root read conflicts with a writer in that root and passes disjoint ranges', t => {
  const f = fixture(t), other = otherRoot(f);
  approvedItem(f, 'W-002', { reads: ['src'], writes: ['src'] });
  const writer = f.launch('W-002', { reads: [], writes: ['src'], worktree: `path:${other}` });
  approvedItem(f, 'W-003', { reads: ['src/docs'], writes: [], extraReads: [{ root: other, reads: ['src', 'public'] }] });
  const error = (() => { try { f.w.launch('run-test', 'bingbu', 'executor', 'W-003', { spec: 'Read the other worktree', generation: 1, extraReads: [{ root: other, reads: ['src'] }] }); } catch (e) { return e; } })();
  assert.match(error.message, new RegExp(`W-002 bingbu/executor 操作 ${writer.operation.id}`));
  assert.match(error.message, /讀取\/寫入：本次讀取 src\/docs, .*other-worktree\/src，在途寫入 src/);
  const reader = f.w.launch('run-test', 'bingbu', 'executor', 'W-003', { spec: 'Read public only', generation: 1, extraReads: [{ root: other, reads: ['public'] }] });
  assert.equal(reader.confirmed, true);
});

test('git metadata resources are canonicalised so one common dir is exclusive', t => {
  const f = fixture(t), common = path.join(f.dir, 'repo.git');
  fs.mkdirSync(path.join(common, 'worktrees', 'urchin'), { recursive: true });
  fs.writeFileSync(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(common, 'worktrees', 'urchin', 'HEAD'), 'ref: refs/heads/x\n');
  fs.writeFileSync(path.join(common, 'worktrees', 'urchin', 'commondir'), '../..\n');
  f.root();
  const add = resources => f.w.add('run-test', { id: `W-${Math.random()}`, title: 'x', requirement: 'x', reads: ['src'], writes: [], resources, acceptance: ['Check'] });
  assert.throws(() => add(['git:relative/.git']), /必須是既有目錄的絕對路徑/);
  assert.throws(() => add([`git:${path.join(f.dir, 'missing.git')}`]), /不存在/);
  assert.throws(() => add([`git:${f.project}`]), /git common dir/);
  assert.throws(() => add([`git:${path.join(common, 'worktrees', 'urchin')}`]), /單一工作樹的 git dir/);
  const canonical = `git:${fs.realpathSync.native(common).replaceAll('\\', '/')}`;
  assert.deepEqual(add([`git:${common}${path.sep}`, 'vite-5216']).resources, [canonical, 'vite-5216']);
  approvedItem(f, 'W-002', { reads: ['src/a'], writes: ['src/a'], resources: [`git:${common}`] });
  const commit = f.launch('W-002');
  approvedItem(f, 'W-003', { reads: ['src/b'], writes: ['src/b'], resources: [`git:${common.replaceAll('\\', '/')}/`] });
  assert.throws(() => f.launch('W-003'), new RegExp(`操作 ${commit.operation.id}（共用工具資源 git:`));
});

test('amend is refused while an executor of the generation is outstanding and after closure', t => {
  const f = fixture(t); f.launch();
  f.root();
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, resources: ['vite-5217'], reason: 'port' }), /在途或未確認的執行代理/);
  f.w.add('run-test', { id: 'W-002', title: 'Design only', requirement: 'Design', reads: ['src'], writes: [], resources: [], acceptance: ['Design reviewed'] });
  f.as(f.zhongshu);
  const proposal = f.w.plan('run-test', 'W-002', { generation: 1, description: 'Design', reads: ['src'], writes: [] });
  f.w.launch('run-test', 'menxia', 'head', 'W-002', { spec: 'Review W-002', generation: 1 });
  f.as(f.menxia);
  f.w.review('run-test', 'W-002', { generation: 1, kind: 'plan-approval', digest: proposal.digest, verdict: 'approved', evidence: [f.proof] });
  f.w.review('run-test', 'W-002', { generation: 1, kind: 'closure-confirmation', digest: proposal.digest, verdict: 'approved', evidence: [f.proof] });
  f.root();
  assert.throws(() => f.w.amend('run-test', 'W-002', { generation: 1, resources: ['x'], reason: 'late' }), /已結案/);
  f.w.control('run-test', 'cancel', 'W-001');
  assert.throws(() => f.w.amend('run-test', 'W-001', { generation: 1, resources: ['x'], reason: 'late' }), /已結案、取消/);
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
