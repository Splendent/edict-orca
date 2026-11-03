import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, defaults, initialize, validateConfig, dispatchArgs, orcaCommand } from '../src/cli.mjs';

const cli = path.join(ROOT, 'bin', 'edict.mjs');
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function run(dir, args, extra = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: dir, encoding: 'utf8', ...extra });
}
function setup(t) {
  const dir = workspace(t);
  const result = run(dir, ['init', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  return dir;
}
function config(dir) { return JSON.parse(fs.readFileSync(path.join(dir, '.edict/config.json'), 'utf8')); }

test('init creates discoverable skills and a config without changing AGENTS.md', t => {
  const dir = workspace(t);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'Existing instructions\n');
  const result = run(dir, ['init', '--yes', '--agent', 'cursor']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(Object.keys(config(dir).roles).length, 12);
  assert.ok(Object.values(config(dir).roles).every(x => x.agent === 'cursor' && x.model === null));
  for (const area of ['.agents', '.claude']) {
    assert.ok(fs.existsSync(path.join(dir, area, 'skills/edict/SKILL.md')));
    assert.ok(fs.existsSync(path.join(dir, area, 'skills/edict/references/workflow.md')));
  }
  assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), 'Existing instructions\n');
});

test('non-TTY init stops before writing files without --yes', t => {
  const dir = workspace(t);
  assert.equal(run(dir, ['init']).status, 1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('init is repeatable and preserves per-role configuration', t => {
  const dir = setup(t);
  assert.equal(run(dir, ['config', 'set', 'menxia', '--agent', 'claude', '--model', 'chosen-claude']).status, 0);
  const before = config(dir);
  assert.equal(run(dir, ['init', '--yes']).status, 0);
  assert.deepEqual(config(dir), before);
  assert.equal(run(dir, ['init', '--yes', '--agent', 'cursor']).status, 1);
  assert.deepEqual(config(dir), before);
});

test('a conflicting second skill causes zero initial mutations', t => {
  const dir = workspace(t);
  const skill = path.join(dir, '.claude/skills/edict');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'Not managed by Edict');
  assert.equal(run(dir, ['init', '--yes']).status, 1);
  assert.equal(fs.existsSync(path.join(dir, '.agents')), false);
  assert.equal(fs.existsSync(path.join(dir, '.edict')), false);
  assert.equal(fs.readFileSync(path.join(skill, 'SKILL.md'), 'utf8'), 'Not managed by Edict');
});

test('locally edited skill is not overwritten and config stays intact', t => {
  const dir = setup(t);
  const file = path.join(dir, '.agents/skills/edict/references/workflow.md');
  fs.appendFileSync(file, '\nUser edit\n');
  const before = config(dir);
  assert.equal(run(dir, ['init', '--yes']).status, 1);
  assert.match(fs.readFileSync(file, 'utf8'), /User edit/);
  assert.deepEqual(config(dir), before);
});

test('init rejects symlink destination parents', t => {
  const dir = workspace(t);
  const outside = workspace(t);
  fs.symlinkSync(outside, path.join(dir, '.agents'));
  assert.equal(run(dir, ['init', '--yes']).status, 1);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('config validation rejects unknown roles, missing roles and effort without model', () => {
  const good = defaults();
  const unknown = structuredClone(good); unknown.roles.typo = good.roles.menxia;
  assert.throws(() => validateConfig(unknown), /未知設定/);
  const missing = structuredClone(good); delete missing.roles.menxia;
  assert.throws(() => validateConfig(missing), /menxia/);
  assert.throws(() => defaults('codex', null, 'high'), /必須指定 model/);
  assert.throws(() => defaults('unsupported'), /agent 必須/);
  assert.throws(() => defaults('codex', ''), /非空字串/);
});

test('provider change clears old model and effort; explicit new values take effect', t => {
  const dir = setup(t);
  assert.equal(run(dir, ['config', 'set', 'bingbu', '--model', 'codex-model', '--effort', 'high']).status, 0);
  assert.equal(run(dir, ['config', 'set', 'bingbu', '--agent', 'cursor']).status, 0);
  assert.deepEqual(config(dir).roles.bingbu, { agent: 'cursor', model: null, effort: null });
  assert.equal(run(dir, ['config', 'set', 'bingbu', '--agent', 'claude', '--model', 'claude-model', '--effort', 'low']).status, 0);
  assert.deepEqual(config(dir).roles.bingbu, { agent: 'claude', model: 'claude-model', effort: 'low' });
});

test('model change and clearing remove stale effort; invalid edits preserve config', t => {
  const dir = setup(t);
  run(dir, ['config', 'set', 'menxia', '--model', 'one', '--effort', 'high']);
  assert.equal(run(dir, ['config', 'set', 'menxia', '--model', 'two']).status, 0);
  assert.equal(config(dir).roles.menxia.effort, null);
  assert.equal(run(dir, ['config', 'set', 'menxia', '--clear-model']).status, 0);
  assert.equal(config(dir).roles.menxia.model, null);
  const before = config(dir);
  for (const args of [
    ['--effort', 'high'], ['--agent', 'typo'], ['--model', 'a', '--clear-model'], ['--model', ''],
  ]) assert.equal(run(dir, ['config', 'set', 'menxia', ...args]).status, 1);
  assert.deepEqual(config(dir), before);
});

test('config discovers initialized project from a nested directory', t => {
  const dir = setup(t);
  const sub = path.join(dir, 'src', 'nested'); fs.mkdirSync(sub, { recursive: true });
  const result = run(sub, ['config']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), config(dir));
});

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
  return { env: { ...process.env, ORCA_CLI_COMMAND: file, CALL_LOG: log, ORCA_TEST_IDENTITY: 'original-pane' }, log };
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
  assert.match(result.stderr, /不得重新執行/);
  assert.equal(fs.readFileSync(runtime.log, 'utf8').trim().split('\n').length, 1);
});

test('dry-run never calls Orca and --project does not change execution cwd', t => {
  const project = setup(t);
  const cwd = workspace(t);
  const runtime = fakeOrca(t, cwd);
  const result = run(cwd, ['dispatch', 'menxia', '--project', project, '--spec-file', '-', '--dry-run'], { env: runtime.env, input: 'Review plan' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(runtime.log), false);
  const output = JSON.parse(result.stdout);
  assert.equal(fs.realpathSync(output.cwd), fs.realpathSync(cwd));
  assert.ok(output.spec.includes('門下省'));
});

test('doctor checks interface and runtime without dispatch or consuming inbox', t => {
  const dir = setup(t);
  const runtime = fakeOrca(t, dir);
  const result = run(dir, ['doctor'], { env: runtime.env });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(runtime.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(calls.map(call => call.args), [['orchestration', 'worker-start', '--help'], ['status', '--json']]);
  assert.match(result.stdout, /模型可用性與帳號登入須由實際派工驗證/);
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

test('local command installer preserves other commands and supports idempotence', t => {
  const dir = workspace(t);
  const installer = path.join(ROOT, 'scripts/install-local.mjs');
  const target = path.join(dir, 'edict');
  fs.writeFileSync(target, 'Other command');
  const refused = spawnSync(process.execPath, [installer, '--bin-dir', dir], { encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.equal(fs.readFileSync(target, 'utf8'), 'Other command');
  fs.unlinkSync(target);
  for (let i = 0; i < 2; i++) {
    const installed = spawnSync(process.execPath, [installer, '--bin-dir', dir], { encoding: 'utf8' });
    assert.equal(installed.status, 0, installed.stderr);
  }
  assert.equal(fs.readlinkSync(target), cli);
  assert.equal(spawnSync(target, ['--help'], { encoding: 'utf8' }).status, 0);
});
