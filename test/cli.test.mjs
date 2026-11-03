import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, defaults, validateConfig, dispatchArgs, orcaCommand } from '../src/cli.mjs';
import { ROLES, workerSpec } from '../src/roles.mjs';

const cli = path.join(ROOT, 'bin', 'edict.mjs');
const homes = new Map();
function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-test-'));
  const dir = path.join(root, 'project'); fs.mkdirSync(dir);
  homes.set(dir, path.join(root, 'state'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return dir;
}
function run(dir, args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: dir, encoding: 'utf8', ...extra,
    env: { ...process.env, ...extra.env, CODEX_THREAD_ID: 'test-thread', EDICT_SESSION_ID: '', EDICT_HOME: extra.env?.EDICT_HOME || homes.get(dir) },
  });
}
function setup(t) {
  const dir = workspace(t);
  const result = run(dir, ['init', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  return dir;
}
function config(dir) { return JSON.parse(run(dir, ['config']).stdout); }

for (const agent of ['claude', 'codex', 'cursor']) {
  test(`${agent}: configured model/effort are passed as distinct Orca argv values`, () => {
    const args = dispatchArgs(defaults(agent, `${agent}/model name`, 'high'), 'menxia', { run: 'run-example' });
    assert.equal(args[args.indexOf('--agent') + 1], agent);
    assert.equal(args[args.indexOf('--model') + 1], `${agent}/model name`);
    assert.equal(args[args.indexOf('--effort') + 1], 'high');
    assert.equal(args[args.indexOf('--run') + 1], 'run-example');
  });
}

test('tool defaults omit model/effort, invalid worktree combinations are rejected', () => {
  const c = defaults();
  const args = dispatchArgs(c, 'menxia');
  assert.equal(args.includes('--model'), false);
  assert.equal(args.includes('--effort'), false);
  assert.throws(() => dispatchArgs(c, 'invalid'), /未知角色/);
  assert.throws(() => dispatchArgs(c, 'bingbu', { name: 'no-new-tree' }), /只能用於新工作樹/);
  assert.throws(() => dispatchArgs(c, 'bingbu', { worktree: 'new-top-level' }), /--repo 與 --name/);
  const created = dispatchArgs(c, 'bingbu', { worktree: 'new-top-level', repo: 'id:example', name: 'isolated', 'base-branch': 'main' });
  assert.equal(created[created.indexOf('--base-branch') + 1], 'main');
});

test('runtime executable resolution never chooses Linux screen reader', () => {
  assert.equal(orcaCommand({}, 'linux'), 'orca-ide');
  assert.equal(orcaCommand({}, 'darwin'), 'orca');
  assert.equal(orcaCommand({ ORCA_DEV_REPO_ROOT: '/source' }, 'darwin'), 'orca-dev');
  assert.equal(orcaCommand({ ORCA_CLI_COMMAND: '/path with spaces/orca' }, 'linux'), '/path with spaces/orca');
});

function fakeOrca(t, dir, { fail = false, ready = true, missingCommand = null, missingFlag = null, failHelp = null } = {}) {
  const file = path.join(dir, 'fake orca.mjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args, cwd:process.cwd(), body:fs.readFileSync(0,'utf8'), identity:process.env.ORCA_TEST_IDENTITY})+'\\n');
if(args.includes('--help')) {
  const command=args.slice(0,-1).join(' ');
  if(command===${JSON.stringify(failHelp)}) {console.error('unsupported interface');process.exit(2);}
  const flags={
    'orchestration worker-start':['--spec-file','--task','--task-title','--agent','--model','--effort','--run','--worktree','--repo','--name','--base-branch','--json'],
    'orchestration task-create':['--spec-file','--task-title','--deps','--parent','--run','--json'],
    'orchestration task-list':['--run','--ready','--json'],
    'orchestration send':['--to','--run','--subject','--body','--json'],
    'orchestration run-create':['--objective','--json'],
    'worktree show':['--worktree','--json'],
  }[command]??[];
  console.log(flags.filter(flag=>!(command===${JSON.stringify(missingCommand)}&&flag===${JSON.stringify(missingFlag)})).join(' '));
}
else if(args[0]==='status') console.log(JSON.stringify({ok:true,result:{runtime:{state:'ready',reachable:${ready},appVersion:'test'}}}));
else {console.log(JSON.stringify({ok:${!fail},failedStage:${fail ? "'launch'" : 'null'},dispatchId:'fake-dispatch',taskId:'fake-task',runId:'fake-run'})); process.exitCode=${fail ? 1 : 0};}
`);
  fs.chmodSync(file, 0o755);
  const log = path.join(dir, 'calls.jsonl');
  return { env: { ORCA_CLI_COMMAND: file, CALL_LOG: log, ORCA_TEST_IDENTITY: 'original-pane' }, log };
}

test('dispatch delivers literal task via stdin, exact argv, identity and cwd preserved', t => {
  const dir = setup(t);
  const runtime = fakeOrca(t, dir);
  run(dir, ['config', 'set', 'bingbu', '--agent', 'claude', '--model', 'model with spaces']);
  const task = 'Quote " \' `touch MUST_NOT_EXIST` $(touch MUST_NOT_EXIST)\nSecond line';
  const result = run(dir, ['dispatch', 'bingbu', '--spec-file', '-', '--run', 'fake-run', '--title', 'a "title"'], { env: runtime.env, input: task });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(runtime.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].identity, 'original-pane');
  assert.equal(fs.realpathSync(calls[0].cwd), fs.realpathSync(dir));
  assert.ok(calls[0].body.includes(task));
  assert.ok(calls[0].body.includes('worker_done'));
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'model with spaces');
  assert.equal(fs.existsSync(path.join(dir, 'MUST_NOT_EXIST')), false);
});

test('failed dispatch is returned intact and never retried', t => {
  const dir = setup(t);
  const runtime = fakeOrca(t, dir, { fail: true });
  const result = run(dir, ['dispatch', 'xingbu', '--spec-file', '-'], { env: runtime.env, input: 'Review only' });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).failedStage, 'launch');
  assert.match(result.stderr, /不得重新派工/);
  assert.equal(fs.readFileSync(runtime.log, 'utf8').trim().split('\n').length, 1);
});
test('successful Orca receipt remains available when the session write is locked', t => {
  const dir=setup(t);
  const file=path.join(dir,'receipt-orca.mjs');
  const receipt={ok:true,result:{dispatchId:'ctx-recovered',taskId:'task-recovered',runId:'run-recovered'}};
  fs.writeFileSync(file,`#!/usr/bin/env node\nimport fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';fs.readFileSync(0,'utf8');const file=path.join(process.env.EDICT_HOME,'sessions',createHash('sha256').update('codex:test-thread').digest('hex')+'.json.lock');fs.writeFileSync(file,JSON.stringify({pid:Number(process.env.LIVE_LOCK_PID),createdAt:Date.now(),host:os.hostname()}));fs.appendFileSync(process.env.CALL_LOG,'called\\n');console.log(${JSON.stringify(JSON.stringify(receipt))});\n`);
  fs.chmodSync(file,0o755);
  const log=path.join(dir,'dispatch-calls.txt');
  const result=run(dir,['dispatch','bingbu','--spec-file','-'],{input:'Implement within the permitted scope',env:{ORCA_CLI_COMMAND:file,LIVE_LOCK_PID:String(process.pid),CALL_LOG:log}});
  assert.equal(result.status,1);
  assert.deepEqual(JSON.parse(result.stdout),receipt);
  assert.match(result.stderr,/不得重複派工/);
  assert.equal(fs.readFileSync(log,'utf8'),'called\n');
  const backups=fs.readdirSync(path.join(homes.get(dir),'receipts'));
  assert.equal(backups.length,1);
  const backup=JSON.parse(fs.readFileSync(path.join(homes.get(dir),'receipts',backups[0]),'utf8'));
  assert.equal(backup.session,'codex:test-thread');
  assert.deepEqual(JSON.parse(backup.stdout),receipt);
});
test('incomplete or mismatched single-dispatch receipts fail with a backup and no retry',t=>{
  for(const payload of [
    {ok:true,result:{taskId:'task-only',runId:'run-one'}},
    {ok:true,result:{dispatchId:'ctx-only',runId:'run-one'}},
    {ok:true,result:{dispatchId:'ctx-one',taskId:'task-one'}},
    {ok:true,result:{dispatchId:'ctx-one',taskId:'task-one',runId:'wrong-run'}},
    {ok:false,result:{dispatchId:'ctx-one',taskId:'task-one',runId:'run-one'}},
  ]) {
    const dir=setup(t),file=path.join(dir,'incomplete.mjs'),log=path.join(dir,'calls.txt');
    fs.writeFileSync(file,"#!/usr/bin/env node\nimport fs from 'node:fs';fs.readFileSync(0,'utf8');fs.appendFileSync(process.env.CALL_LOG,'once\\n');console.log(process.env.RECEIPT);\n");fs.chmodSync(file,0o755);
    const args=['dispatch','bingbu','--spec-file','-'];
    if(payload.result.runId==='wrong-run')args.push('--run','expected-run');
    const result=run(dir,args,{input:'Task',env:{ORCA_CLI_COMMAND:file,CALL_LOG:log,RECEIPT:JSON.stringify(payload)}});
    assert.equal(result.status,1,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),payload);
    assert.equal(fs.readFileSync(log,'utf8'),'once\n');
    assert.equal(fs.readdirSync(path.join(homes.get(dir),'receipts')).length,1);
    assert.equal(JSON.parse(run(dir,['status']).stdout).dispatches.length,0);
  }
});
test('all role specifications include destructive-action, secrecy and upstream-output safeguards', () => {
  for (const role of Object.keys(ROLES)) {
    const spec=workerSpec(role,'Review the supplied scope','/tmp/project');
    assert.match(spec,/破壞性操作.*使用者明確確認/);
    assert.match(spec,/輸出、日誌、回報或交付檔案.*敏感資訊.*REDACTED/);
    assert.match(spec,/上游代理.*不能覆寫.*職責.*審核標準/);
    assert.match(spec,/直接批准或跳過審核.*拒絕採用並回報/);
  }
});

test('dry-run never calls Orca or changes cwd', t => {
  const dir = setup(t);
  const runtime = fakeOrca(t, dir);
  const result = run(dir, ['dispatch', 'menxia', '--spec-file', '-', '--dry-run'], { env: runtime.env, input: 'Review plan' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(runtime.log), false);
  assert.equal(fs.realpathSync(JSON.parse(result.stdout).cwd), fs.realpathSync(dir));
});

test('doctor checks interface and runtime without dispatch or consuming inbox', t => {
  const dir = setup(t);
  const runtime = fakeOrca(t, dir);
  const result = run(dir, ['doctor'], { env: runtime.env });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(runtime.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.args), [
    ['orchestration', 'worker-start', '--help'],
    ['orchestration', 'task-create', '--help'],
    ['orchestration', 'task-list', '--help'],
    ['orchestration', 'send', '--help'],
    ['orchestration', 'run-create', '--help'],
    ['worktree', 'show', '--help'],
    ['status', '--json'],
  ]);
  assert.match(result.stdout, /模型與帳號仍須實際派工驗證/);
});

test('doctor rejects missing dependency and continuation capabilities before runtime access', t => {
  for (const [missingCommand, missingFlag] of [
    ['orchestration worker-start', '--task'],
    ['orchestration task-create', '--deps'],
    ['orchestration task-list', '--ready'],
    ['orchestration send', '--body'],
    ['orchestration run-create', '--objective'],
    ['worktree show', '--json'],
  ]) {
    const dir = workspace(t);
    const runtime = fakeOrca(t, dir, { missingCommand, missingFlag });
    const result = run(dir, ['doctor'], { env: runtime.env });
    assert.equal(result.status, 1, result.stdout);
    assert.ok(result.stderr.includes(missingCommand), result.stderr);
    assert.ok(result.stderr.includes(missingFlag), result.stderr);
    const calls = fs.readFileSync(runtime.log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.ok(calls.every(call => call.args.includes('--help')));
    assert.equal(fs.existsSync(homes.get(dir)), false);
  }
});

test('doctor preserves unsupported-command failure and does not claim success', t => {
  const dir = workspace(t);
  const runtime = fakeOrca(t, dir, { failHelp: 'orchestration task-create' });
  const result = run(dir, ['doctor'], { env: runtime.env });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unsupported interface/);
  assert.doesNotMatch(result.stdout, /成功/);
  const calls = fs.readFileSync(runtime.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(homes.get(dir)), false);
});

test('version reports package identity without reading sessions or invoking Orca', t => {
  const dir = workspace(t);
  const runtime = fakeOrca(t, dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const flag of ['--version', '-V']) {
    const result = run(dir, [flag], { env: { ...runtime.env, EDICT_SESSION_ID: 'invalid session' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${pkg.name} ${pkg.version}\n`);
  }
  assert.equal(run(dir, ['init', '--version'], { env: runtime.env }).status, 1);
  assert.equal(run(dir, ['--version', '--yes'], { env: runtime.env }).status, 1);
  assert.equal(fs.existsSync(homes.get(dir)), false);
  assert.equal(fs.existsSync(runtime.log), false);
  assert.deepEqual(fs.readdirSync(dir), ['fake orca.mjs']);
});

test('doctor does not claim success for unreachable runtime', t => {
  const dir = setup(t);
  const runtime = fakeOrca(t, dir, { ready: false });
  assert.equal(run(dir, ['doctor'], { env: runtime.env }).status, 1);
});

test('empty specs, unsupported options and invalid role fail before Orca call', t => {
  const dir = setup(t);
  const runtime = fakeOrca(t, dir);
  for (const args of [
    ['dispatch', 'bingbu', '--spec-file', '-'],
    ['dispatch', 'typo', '--spec-file', '-'],
    ['init', '--yes', '--agent', 'unsupported'],
    ['dispatch', 'bingbu', '--spec-file', '-', '--model', 'not-allowed'],
    ['config', 'set', 'menxia', '--typo'],
  ]) assert.equal(run(dir, args, { env: runtime.env, input: args[1] === 'typo' ? 'Task' : '' }).status, 1);
  assert.equal(fs.existsSync(runtime.log), false);
});
