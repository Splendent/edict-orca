import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, defaults, validateConfig, dispatchArgs, orcaCommand } from '../src/cli.mjs';

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

function fakeOrca(t, dir, { fail = false, ready = true } = {}) {
  const file = path.join(dir, 'fake orca.mjs');
  fs.writeFileSync(file, `#!/usr/bin/env node
import fs from 'node:fs';
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({args, cwd:process.cwd(), body:fs.readFileSync(0,'utf8'), identity:process.env.ORCA_TEST_IDENTITY})+'\\n');
if(args.includes('--help')) console.log('--spec-file --agent --model --effort --run --worktree');
else if(args[0]==='status') console.log(JSON.stringify({ok:true,result:{runtime:{state:'ready',reachable:${ready},appVersion:'test'}}}));
else {console.log(JSON.stringify({ok:${!fail},failedStage:${fail ? "'launch'" : 'null'},dispatchId:'fake-dispatch'})); process.exitCode=${fail ? 1 : 0};}
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
  const result = run(dir, ['dispatch', 'bingbu', '--spec-file', '-', '--run', 'run-one', '--title', 'a "title"'], { env: runtime.env, input: task });
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
  assert.deepEqual(calls.map(call => call.args), [['orchestration', 'worker-start', '--help'], ['status', '--json']]);
  assert.match(result.stdout, /模型與帳號仍須實際派工驗證/);
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
