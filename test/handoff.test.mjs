import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Workflow, assertWorkflowOwner, workflowStatus } from '../src/workflow.mjs';
import { activate, context, readSession } from '../src/session.mjs';
import { defaults } from '../src/config.mjs';

const SESSION = 'codex:handoff';

// Native model: each Run is bound to one coordinator conversation; run-use moves the binding and keeps only the
// named Run for the caller, as observed with Orca 1.4.251.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-handoff-'));
  const previous = process.env.EDICT_HOME;
  process.env.EDICT_HOME = path.join(dir, 'state');
  t.after(() => { if (previous === undefined) delete process.env.EDICT_HOME; else process.env.EDICT_HOME = previous; fs.rmSync(dir, { recursive: true, force: true }); });
  const project = path.join(dir, 'project'); fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  activate(SESSION, defaults(), project);
  let runs = 0;
  const runtime = {
    caller: 'old', worker: null, bindings: {}, takeovers: [], counter: 0, rows: [],
    identity(runId) {
      if (this.worker) return { owner: false, dispatchId: this.worker };
      if (this.bindings[runId] === this.caller) return { owner: true };
      throw new Error('Orca 未確認目前呼叫者屬於此 Run');
    },
    currentRun() { return Object.entries(this.bindings).findLast(([, owner]) => owner === this.caller)?.[0] || null; },
    open() { const id = `run-${++runs}`; this.bindings[id] = this.caller; return id; },
    takeover(runId, requestId) {
      this.takeovers.push({ runId, requestId, caller: this.caller });
      if (this.failTakeover) throw Object.assign(new Error('Orca run-use 失敗或未確認'), { receipt: { ok: false } });
      for (const [id, owner] of Object.entries(this.bindings)) if (owner === this.caller) delete this.bindings[id];
      this.bindings[runId] = this.caller;
      return { run: { id: runId } };
    },
    coordinator(runId) { return { handle: `term_${this.bindings[runId]}`, consumerGeneration: 2 }; },
    start(runId) { const dispatchId = `dispatch-${++this.counter}`; this.rows.push({ dispatchId, state: 'ready' }); return { dispatchId, taskId: `task-${this.counter}`, runId }; },
    workers() { return this.rows; },
    rename(runId, dispatchId, title) { return { state: 'applied', title }; },
    send() { return { messageId: 'message-test' }; },
    stop() { return { state: 'stopped' }; },
  };
  const w = new Workflow(SESSION, runtime);
  const run = w.open('Handoff objective').id;
  w.add(run, { id: 'W-001', title: 'Feature', requirement: 'Implement feature', reads: ['src'], writes: ['src'], acceptance: ['Works'] });
  return { w, runtime, run, dir };
}

test('a handoff moves root duties to another conversation and Orca fences the previous one', t => {
  const f = fixture(t);
  const packet = f.w.handoffExport(f.run, 'context is nearly full');
  assert.equal(packet.kind, 'edict-handoff');
  assert.equal(packet.session, SESSION);
  assert.equal(packet.runId, f.run);
  assert.equal(packet.items[0].id, 'W-001');
  assert.equal(f.w.run(f.run).handoff.state, 'pending');
  assert.notEqual(f.w.run(f.run).handoff.tokenDigest, packet.token);

  f.runtime.caller = 'new';
  const accepted = f.w.handoffAccept(packet);
  assert.equal(accepted.handoff.state, 'accepted');
  assert.equal(accepted.handoff.coordinator.handle, 'term_new');
  assert.equal(f.runtime.takeovers.length, 1);
  assert.equal(readSession(SESSION).handoffs[0].id, packet.id);
  assert.equal(readSession(SESSION).runId, f.run);

  // The receiver now acts as root; the previous conversation cannot change the Run or session-wide settings.
  f.w.add(f.run, { id: 'W-002', title: 'Next', requirement: 'Next item', reads: ['src'], writes: [], acceptance: ['Reviewed'] });
  assert.doesNotThrow(() => assertWorkflowOwner(SESSION, f.runtime));
  f.runtime.caller = 'old';
  assert.throws(() => f.w.control(f.run, 'pause'), /未確認目前呼叫者/);
  assert.throws(() => assertWorkflowOwner(SESSION, f.runtime), /未確認目前呼叫者/);
  assert.throws(() => f.w.handoffAccept(packet), /已完成/);
});

test('handoff accept refuses the exporting conversation, workers and conversations already coordinating a Run', t => {
  const f = fixture(t);
  const packet = f.w.handoffExport(f.run);
  assert.throws(() => f.w.handoffAccept(packet), /另一個對話接手/);
  f.runtime.caller = 'new'; f.runtime.worker = 'dispatch-x';
  assert.throws(() => f.w.handoffAccept(packet), /執行代理不能接手/);
  f.runtime.worker = null; f.runtime.bindings['run-other'] = 'new';
  assert.throws(() => f.w.handoffAccept(packet), /正在協調 Run run-other/);
  assert.equal(f.runtime.takeovers.length, 0);
  assert.equal(f.w.run(f.run).handoff.state, 'pending');
});

test('a forged, replaced or revoked packet cannot take over the Run', t => {
  const f = fixture(t);
  const first = f.w.handoffExport(f.run);
  const second = f.w.handoffExport(f.run);
  f.runtime.caller = 'new';
  assert.throws(() => f.w.handoffAccept(first), /已被新的交棒取代/);
  assert.throws(() => f.w.handoffAccept({ ...second, token: 'guess' }), /已被新的交棒取代/);
  assert.throws(() => f.w.handoffAccept({ ...second, session: 'codex:other' }), /不屬於此 Edict 對話身分/);
  f.runtime.caller = 'old';
  f.w.handoffCancel(f.run);
  f.runtime.caller = 'new';
  assert.throws(() => f.w.handoffAccept(second), /撤回/);
  assert.equal(f.runtime.takeovers.length, 0);
  assert.ok(f.w.run(f.run).history.some(x => x.action === 'handoff-replaced'));
});

test('an unconfirmed takeover keeps one request ID so a retried accept is deduplicated by Orca', t => {
  const f = fixture(t);
  const packet = f.w.handoffExport(f.run);
  f.runtime.caller = 'new'; f.runtime.failTakeover = true;
  assert.throws(() => f.w.handoffAccept(packet), /run-use 失敗/);
  assert.equal(f.w.run(f.run).handoff.state, 'unknown');
  f.runtime.caller = 'old';
  assert.throws(() => f.w.handoffCancel(f.run), /不能撤回/);
  assert.throws(() => f.w.handoffExport(f.run), /未確認/);
  f.runtime.caller = 'new'; f.runtime.failTakeover = false;
  f.w.handoffAccept(packet);
  assert.equal(f.runtime.takeovers.length, 2);
  assert.equal(f.runtime.takeovers[0].requestId, f.runtime.takeovers[1].requestId);
  assert.equal(f.w.run(f.run).handoff.state, 'accepted');
});

test('other open Runs block a handoff; finished Runs are archived and refuse later changes', t => {
  const f = fixture(t);
  const older = f.run;
  const newer = f.w.open('Second objective').id;
  assert.throws(() => f.w.handoffExport(newer), new RegExp(`另有未結束的 Run：${older}`));
  f.w.control(older, 'cancel', 'W-001');
  const packet = f.w.handoffExport(newer);
  f.runtime.caller = 'new';
  const accepted = f.w.handoffAccept(packet);
  assert.deepEqual(accepted.archivedRuns, [older]);
  assert.doesNotThrow(() => assertWorkflowOwner(SESSION, f.runtime));
  f.runtime.caller = 'old';
  assert.throws(() => f.w.add(older, { id: 'W-009', title: 'Late', requirement: 'Late', acceptance: ['x'] }), /交棒時封存/);
  const status = workflowStatus(SESSION);
  assert.ok(status.find(x => x.runId === older).archived);
  assert.equal(status.find(x => x.runId === newer).handoff.state, 'accepted');
});

test('the handoff packet lists owner relays and unconfirmed operations for the receiver', t => {
  const f = fixture(t);
  const run = f.w.run(f.run);
  assert.deepEqual(f.w.handoffExport(f.run).pending, { ownerRequired: [], unknown: [], inFlight: [] });
  f.w.launch(f.run, 'zhongshu', 'head', undefined, { spec: 'Plan' });
  const packet = f.w.handoffExport(f.run);
  assert.equal(packet.pending.inFlight.length, 1);
  assert.equal(packet.heads[0].role, 'zhongshu');
  assert.ok(run);
});

test('context gives the root its duty card and handoff history', t => {
  fixture(t);
  const text = context(SESSION);
  assert.match(text, /太子（原對話 root）職責/);
  assert.match(text, /不自己調查或規劃/);
  assert.match(text, /edict handoff export/);
  assert.match(text, /交棒紀錄：\[\]/);
});

// CLI end to end with a stateful fake Orca: Run bindings live in a file keyed by the caller's terminal identity.
test('cli: export writes a private packet without printing the token; accept in another conversation takes over', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-handoff-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const state = path.join(root, 'state'), bindings = path.join(root, 'bindings.json'), fake = path.join(root, 'fake-orca.mjs');
  fs.writeFileSync(fake, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2), me = process.env.ORCA_TEST_IDENTITY, file = ${JSON.stringify(bindings)};
const b = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
const save = () => fs.writeFileSync(file, JSON.stringify(b));
const out = (result, ok = true) => { console.log(JSON.stringify(ok ? { ok, result } : { ok, error: result })); if (!ok) process.exitCode = 1; };
const arg = name => args[args.indexOf(name) + 1];
const mine = Object.keys(b).filter(id => b[id] === me);
if (args[1] === 'run-create') { b['run-1'] = me; save(); out({ run: { id: 'run-1', coordinator_handle: me } }); }
else if (args[1] === 'run-current') out({ run: mine.length ? { id: mine.at(-1), coordinator_handle: me } : null });
else if (args[1] === 'run-use') { for (const id of mine) delete b[id]; b[arg('--id')] = me; save(); out({ run: { id: arg('--id') } }); }
else if (args[1] === 'run-show') out({ run: { id: arg('--id'), coordinator_handle: b[arg('--id')] ?? null, consumer_generation: 2 } });
else if (args[1] === 'check') out({ messages: [] });
else out({ code: 'unsupported', message: args.join(' ') }, false);
`);
  fs.chmodSync(fake, 0o755);
  const edict = path.join(import.meta.dirname, '..', 'bin', 'edict.mjs');
  const cli = (identity, args) => {
    const result = spawnSync(process.execPath, [edict, ...args], { cwd: project, encoding: 'utf8',
      env: { ...process.env, EDICT_HOME: state, EDICT_SESSION_ID: '', CODEX_THREAD_ID: 'cli-handoff', ORCA_CLI_COMMAND: fake, ORCA_TEST_IDENTITY: identity } });
    return { ...result, json: () => JSON.parse(result.stdout) };
  };
  assert.equal(cli('term-old', ['init', '--yes']).status, 0);
  assert.equal(cli('term-old', ['run', 'open', '--objective', 'CLI handoff']).status, 0);
  const exported = cli('term-old', ['handoff', 'export', '--run', 'run-1', '--note', 'switch coordinator']);
  assert.equal(exported.status, 0, exported.stderr);
  const summary = exported.json();
  assert.equal(summary.token, undefined);
  assert.equal(fs.statSync(summary.file).mode & 0o777, 0o600);
  assert.ok(JSON.parse(fs.readFileSync(summary.file, 'utf8')).token);

  const wrongHome = spawnSync(process.execPath, [edict, 'handoff', 'accept', '--file', summary.file], { cwd: project, encoding: 'utf8',
    env: { ...process.env, EDICT_HOME: path.join(root, 'other'), ORCA_CLI_COMMAND: fake, ORCA_TEST_IDENTITY: 'term-new' } });
  assert.notEqual(wrongHome.status, 0);
  assert.match(wrongHome.stderr, /EDICT_HOME/);

  const accepted = cli('term-new', ['handoff', 'accept', '--file', summary.file]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.json().handoff.state, 'accepted');
  assert.match(accepted.json().roleCard, /太子/);
  assert.equal(JSON.parse(fs.readFileSync(bindings, 'utf8'))['run-1'], 'term-new');
  assert.notEqual(cli('term-old', ['control', 'pause', '--run', 'run-1']).status, 0);
  assert.equal(cli('term-new', ['control', 'pause', '--run', 'run-1']).status, 0);
});
