import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { ROOT, home, sessionId, sessionFile, readSession, activate, context, deactivate, recordDispatch, writeSession } from '../src/session.mjs';
import { defaults } from '../src/config.mjs';
import { install, planInstall, quote } from '../src/install.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-session-'));
  const old = process.env.EDICT_HOME;
  process.env.EDICT_HOME = path.join(dir, 'state');
  const project = path.join(dir, 'project'); fs.mkdirSync(project);
  t.after(() => { if (old === undefined) delete process.env.EDICT_HOME; else process.env.EDICT_HOME = old; fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, project };
}
function cli(project, args, extraEnv = {}, input) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bin/edict.mjs'), ...args], {
    cwd: project, encoding: 'utf8', input,
    env: { ...process.env, CODEX_THREAD_ID: '', EDICT_SESSION_ID: '', ...extraEnv },
  });
}
test('two conversations in the same project remain isolated and project stays unchanged', t => {
  const { project } = fixture(t);
  fs.writeFileSync(path.join(project, 'AGENTS.md'), 'Existing rules');
  const initialized = cli(project, ['init', '--yes', '--session', 'codex:A', '--agent', 'cursor', '--model', 'selected-model']);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(readSession('codex:A').active, true);
  assert.equal(readSession('codex:B'), null);
  assert.deepEqual(fs.readdirSync(project), ['AGENTS.md']);
  assert.equal(context('codex:B'), '');
  assert.match(context('codex:A'), /selected-model/);
  assert.equal(cli(project, ['dispatch', 'bingbu', '--session', 'codex:B', '--spec-file', '-', '--dry-run'], {}, 'Task').status, 1);
});
test('native session IDs, not project or terminal, define scope', () => {
  assert.equal(sessionId(undefined, { CODEX_THREAD_ID: 'native' }), 'codex:native');
  assert.throws(() => sessionId(undefined, { ORCA_TERMINAL_HANDLE: 'term_x', ORCA_WORKSPACE_ID: 'worktree' }), /無法辨識/);
  assert.throws(() => sessionId('project:/tmp/a', {}), /無法辨識/);
  assert.throws(() => sessionId('codex:a\nb', {}), /無法辨識/);
});
test('init without native ID returns a conversation token without modifying the project', t => {
  const { project } = fixture(t);
  const result=cli(project, ['init', '--yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).session, /^conversation:/);
  assert.equal(cli(project, ['status']).status, 1);
  assert.deepEqual(fs.readdirSync(project), []);
});
test('status help off and context never enable an uninitialized conversation', t => {
  const { project } = fixture(t);
  for (const command of ['status', 'context', 'off']) assert.equal(cli(project, [command, '--session', 'claude:never']).status, 0);
  assert.equal(cli(project, ['help']).status, 0);
  assert.equal(readSession('claude:never'), null);
  assert.equal(fs.existsSync(home()), false);
});
test('repeat init and off preserve run and settings; config affects only its conversation', t => {
  const { project } = fixture(t);
  activate('codex:A', defaults('claude', 'original', 'high'), project);
  activate('codex:B', defaults('cursor'), project);
  recordDispatch('codex:A', { ok: true, result: { dispatchId: 'ctx_1', taskId: 'task_1', runId: 'run_1' } }, 'bingbu');
  assert.equal(cli(project, ['init', '--yes', '--session', 'codex:A']).status, 0);
  assert.equal(readSession('codex:A').runId, 'run_1');
  assert.equal(readSession('codex:A').dispatches.length, 1);
  assert.equal(cli(project, ['config', 'set', 'menxia', '--session', 'codex:A', '--agent', 'codex', '--model', 'review']).status, 0);
  assert.equal(readSession('codex:A').config.roles.menxia.model, 'review');
  assert.equal(readSession('codex:B').config.roles.menxia.model, null);
  deactivate('codex:A');
  assert.equal(context('codex:A'), '');
  assert.equal(readSession('codex:A').dispatches.length, 1);
  assert.equal(cli(project, ['config', 'set', 'menxia', '--session', 'codex:A', '--clear-model']).status, 0);
  assert.equal(readSession('codex:A').active, false);
  assert.equal(cli(project, ['dispatch', 'bingbu', '--session', 'codex:A', '--spec-file', '-', '--dry-run'], {}, 'Task').status, 1);
});
test('invalid config edits leave persisted state intact', t => {
  const { project } = fixture(t);
  activate('codex:A', defaults('claude', 'one', 'high'), project);
  const before = readSession('codex:A');
  for (const args of [['--agent','invalid'], ['--model',''], ['--model','two','--clear-model']]) {
    assert.equal(cli(project, ['config','set','menxia','--session','codex:A',...args]).status, 1);
  }
  assert.deepEqual(readSession('codex:A'), before);
  assert.equal(cli(project, ['config','set','menxia','--session','codex:A','--agent','cursor']).status, 0);
  assert.deepEqual(readSession('codex:A').config.roles.menxia, { agent:'cursor', model:null, effort:null });
});
test('Cursor coordinator remains pending until mode confirmation and off clears confirmation', t => {
  const { project } = fixture(t);
  let result = cli(project, ['init','--yes','--session','cursor:A','--coordinator','cursor']);
  assert.equal(result.status,0,result.stderr);
  assert.equal(readSession('cursor:A').active,false);
  assert.equal(readSession('cursor:A').pending,'cursor-custom-mode');
  assert.equal(context('cursor:A'),'');
  assert.equal(cli(project,['dispatch','bingbu','--session','cursor:A','--spec-file','-','--dry-run'],{},'Task').status,1);
  result=cli(project,['init','--yes','--session','cursor:A','--coordinator','cursor','--mode-confirmed']);
  assert.equal(result.status,0,result.stderr);
  assert.equal(readSession('cursor:A').active,true);
  assert.equal(readSession('cursor:A').pending,null);
  assert.match(context('cursor:A'),/已啟用/);
  assert.equal(readSession('cursor:B'),null);
  assert.equal(cli(project,['off','--session','cursor:A']).status,0);
  assert.equal(readSession('cursor:A').modeConfirmed,false);
  assert.equal(cli(project,['init','--yes','--session','cursor:A','--coordinator','cursor']).status,0);
  assert.equal(readSession('cursor:A').active,false);
});
test('stale writes cannot overwrite newer conversation state', t => {
  const { project } = fixture(t);
  activate('codex:A', defaults(), project);
  const stale = readSession('codex:A');
  deactivate('codex:A');
  assert.throws(() => writeSession(stale), /另一操作修改/);
  assert.equal(readSession('codex:A').active, false);
});
test('dead-owner lock permits off, config and repeated init to recover', t => {
  const { project } = fixture(t);
  activate('codex:A', defaults(), project);
  const exited = spawnSync(process.execPath, ['-e', ''], { encoding:'utf8' });
  assert.equal(exited.status,0);
  assert.throws(() => process.kill(exited.pid,0), error => error.code === 'ESRCH');
  const lock=sessionFile('codex:A')+'.lock';
  for (const args of [
    ['off','--session','codex:A'],
    ['config','set','menxia','--session','codex:A','--model','review-model'],
    ['init','--yes','--session','codex:A'],
  ]) {
    fs.writeFileSync(lock,JSON.stringify({pid:exited.pid,createdAt:Date.now(),host:os.hostname()}));
    const result=cli(project,args);
    assert.equal(result.status,0,result.stderr);
    assert.equal(fs.existsSync(lock),false);
  }
  assert.equal(readSession('codex:A').active,true);
  assert.equal(readSession('codex:A').config.roles.menxia.model,'review-model');
});
test('legacy empty and malformed old locks recover without resetting state', t => {
  const { project } = fixture(t);
  activate('codex:A', defaults('claude'),project);
  const lock=sessionFile('codex:A')+'.lock';
  for (const text of ['', 'incomplete metadata']) {
    fs.writeFileSync(lock,text);
    fs.utimesSync(lock,new Date(Date.now()-60_000),new Date(Date.now()-60_000));
    const result=cli(project,['init','--yes','--session','codex:A']);
    assert.equal(result.status,0,result.stderr);
    assert.equal(readSession('codex:A').config.roles.menxia.agent,'claude');
  }
});
test('an old lock with a live owner is retained and error names its path', t => {
  const { project } = fixture(t);
  activate('codex:A',defaults(),project);
  const lock=sessionFile('codex:A')+'.lock';
  const text=JSON.stringify({pid:process.pid,createdAt:Date.now()-86_400_000,host:os.hostname()});
  fs.writeFileSync(lock,text);
  fs.utimesSync(lock,new Date(0),new Date(0));
  const result=cli(project,['off','--session','codex:A']);
  assert.equal(result.status,1);
  assert.ok(result.stderr.includes(lock));
  assert.match(result.stderr,/已等待 500 毫秒/);
  assert.equal(fs.readFileSync(lock,'utf8'),text);
  assert.equal(readSession('codex:A').active,true);
});
test('a fresh incomplete lock is not treated as abandoned', t => {
  const { project } = fixture(t);
  activate('codex:A',defaults(),project);
  const lock=sessionFile('codex:A')+'.lock'; fs.writeFileSync(lock,'');
  assert.equal(cli(project,['off','--session','codex:A']).status,1);
  assert.equal(fs.existsSync(lock),true);
});
test('a contended lock that is released during the bounded wait allows writing', async t => {
  const { project } = fixture(t);
  activate('codex:A',defaults(),project);
  const lock=sessionFile('codex:A')+'.lock';
  const script=`const fs=require('node:fs'),os=require('node:os');const lock=process.argv[1];fs.writeFileSync(lock,JSON.stringify({pid:process.pid,createdAt:Date.now(),host:os.hostname()}));process.stdout.write('ready');setTimeout(()=>fs.unlinkSync(lock),200);`;
  const child=spawn(process.execPath,['-e',script,lock],{stdio:['ignore','pipe','pipe']});
  const closed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(new Error(`lock fixture failed: ${code}`)));});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
  const result=cli(project,['off','--session','codex:A']);
  assert.equal(result.status,0,result.stderr);
  await closed;
  assert.equal(readSession('codex:A').active,false);
});
test('legacy configuration is imported explicitly and the source is unchanged', t => {
  const { dir, project } = fixture(t);
  const file = path.join(dir, 'legacy.json'); const original = JSON.stringify(defaults('cursor', 'chosen'));
  fs.writeFileSync(file, original);
  const result = cli(project, ['init','--yes','--session','cursor:imported','--import-config',file]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readSession('cursor:imported').config.roles.bingbu.model, 'chosen');
  assert.equal(fs.readFileSync(file,'utf8'), original);
  assert.deepEqual(fs.readdirSync(project), []);
  const before=readSession('cursor:imported');
  const repeated=cli(project,['init','--yes','--session','cursor:imported','--import-config',file]);
  assert.equal(repeated.status,1);
  assert.match(repeated.stderr,/僅限對話首次 init 前/);
  assert.match(repeated.stderr,/edict config set/);
  assert.deepEqual(readSession('cursor:imported'),before);
});
test('noninteractive init without --yes stops before activation', t => {
  const { project } = fixture(t);
  assert.equal(cli(project, ['init','--session','codex:A']).status, 1);
  assert.equal(readSession('codex:A'), null);
});
test('install never modifies agent settings or hooks and enables no sessions', t => {
  const { dir, project } = fixture(t);
  const user = path.join(dir, 'user'); const configFile = path.join(user,'.claude/settings.json');
  fs.mkdirSync(path.dirname(configFile),{recursive:true});
  const original = { model:'keep', hooks:{ UserPromptSubmit:[{ hooks:[{ type:'command',command:'existing-hook' }] }] } };
  fs.writeFileSync(configFile, JSON.stringify(original));
  const plan = install(user, undefined, {});
  assert.ok(plan.links.length > 0);
  const after = JSON.parse(fs.readFileSync(configFile,'utf8'));
  assert.equal(after.model,'keep'); assert.deepEqual(after.hooks.UserPromptSubmit[0], original.hooks.UserPromptSubmit[0]);
  assert.deepEqual(after, original);
  assert.equal(fs.existsSync(path.join(user,'.codex/hooks.json')),false);
  assert.equal(fs.existsSync(path.join(user,'.cursor/hooks.json')),false);
  const second = planInstall(user,undefined,{});
  assert.deepEqual(second.links,[]); assert.deepEqual(second.writes,[]);
  assert.equal(fs.existsSync(home()),false);
  assert.equal(fs.realpathSync(path.join(user,'.claude/skills/edict')),fs.realpathSync(path.join(ROOT,'skills/edict')));
  assert.equal(spawnSync(path.join(user,'.local/bin/edict'),['help'],{encoding:'utf8'}).status,0);
  assert.deepEqual(fs.readdirSync(project),[]);
});
test('installer refuses collisions before touching unrelated configuration', t => {
  const { dir } = fixture(t); const user=path.join(dir,'user');
  const conflict=path.join(user,'.cursor/skills/edict'); fs.mkdirSync(conflict,{recursive:true});
  fs.writeFileSync(path.join(conflict,'SKILL.md'),'User skill');
  assert.throws(()=>install(user,undefined,{}),/已有其他技能/);
  assert.equal(fs.existsSync(path.join(user,'.agents')),false);
  assert.equal(fs.existsSync(path.join(user,'.claude/settings.json')),false);
});
test('POSIX hook paths use shell quoting rather than JSON quoting', () => {
  const literal="/tmp/path ' with $() `quotes`";
  const result=spawnSync('/bin/sh',['-c',`printf %s ${quote(literal, 'darwin')}`],{encoding:'utf8'});
  assert.equal(result.stdout,literal);
});
