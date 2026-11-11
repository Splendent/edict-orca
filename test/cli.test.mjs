import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ROOT, defaults, validateConfig, dispatchArgs, orcaCommand } from '../src/cli.mjs';
import { ROLES, workerSpec } from '../src/roles.mjs';

const cli = path.join(ROOT, 'bin', 'edict.mjs');

test('relay CLI exposes usage and rejects missing explicit run/session or extra arguments', () => {
  const invoke = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const help = invoke(['help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /edict relay --run/);
  assert.match(help.stdout, /edict stalls --run/);
  for (const args of [
    ['relay', '--session', 'codex:test', '--once'],
    ['relay', '--run', 'run-test', '--once'],
    ['relay', 'extra', '--run', 'run-test', '--session', 'codex:test'],
    ['stalls', '--session', 'codex:test', '--unstick'],
    ['stalls', 'extra', '--run', 'run-test', '--session', 'codex:test'],
  ]) {
    const result = invoke(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--run|--session|多餘/);
  }
});
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
  assert.equal(args[args.indexOf('--worktree') + 1], 'current');
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
else if(args[1]==='run-create'||args[1]==='run-current') console.log(JSON.stringify({ok:true,result:{run:{id:'fake-run',coordinator_handle:'fake-root'}}}));
else {
 if(process.env.LOCK_SESSION) {
  const {createHash}=await import('node:crypto'),os=await import('node:os');
  const file=process.env.EDICT_HOME+'/sessions/'+createHash('sha256').update('codex:test-thread').digest('hex')+'.json.lock';
  fs.writeFileSync(file,JSON.stringify({pid:Number(process.env.LIVE_LOCK_PID),host:os.hostname()}));
 }
 const value=process.env.START_RESPONSE?JSON.parse(process.env.START_RESPONSE):{ok:${!fail},result:{dispatchId:'fake-dispatch',taskId:'fake-task',runId:'fake-run',failedStage:${fail ? "'launch'" : 'null'}}};
 console.log(JSON.stringify(value));if(!value.ok)process.exitCode=1;
}
`);
  fs.chmodSync(file, 0o755);
  const log = path.join(dir, 'calls.jsonl');
  return { env: { ORCA_CLI_COMMAND: file, CALL_LOG: log, ORCA_TEST_IDENTITY: 'original-pane' }, log };
}

test('authorized team creation delivers literal stdin, argv, identity and cwd', t => {
  const dir = setup(t);
  const runtime = fakeOrca(t, dir);
  run(dir, ['config', 'set', 'zhongshu', '--agent', 'claude', '--model', 'model with spaces']);
  const task = 'Quote " \' `touch MUST_NOT_EXIST` $(touch MUST_NOT_EXIST)\nSecond line';
  assert.equal(run(dir, ['run', 'open', '--objective', 'Literal task'], { env: runtime.env }).status, 0);
  const result = run(dir, ['team', 'ensure', 'zhongshu', '--spec-file', '-', '--run', 'fake-run'], { env: runtime.env, input: JSON.stringify({spec:task}) });
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(runtime.log, 'utf8').trim().split('\n').map(JSON.parse).filter(x=>x.args[1]==='worker-start');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].identity, 'original-pane');
  assert.equal(fs.realpathSync(calls[0].cwd), fs.realpathSync(dir));
  assert.ok(calls[0].body.includes(task));
  assert.match(calls[0].body,/下屬仍在工作時頭領不能宣告整項完成/);
  assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'model with spaces');
  assert.equal(fs.existsSync(path.join(dir, 'MUST_NOT_EXIST')), false);
});

test('native adapter preserves child-worktree selectors and names as literal argv', t => {
  const dir = setup(t);
  const runtime = fakeOrca(t, dir);
  for (const name of [undefined, 'child-bingbu']) {
    const script = `import {NativeRuntime} from ${JSON.stringify(new URL('../src/native.mjs',import.meta.url).href)};new NativeRuntime().start('fake-run',{agent:'codex',model:null,effort:null},'Literal task',{worktree:'new-child',title:'child',name:${JSON.stringify(name)}},'request-child');`;
    const result = spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:dir,encoding:'utf8',env:{...process.env,...runtime.env}});
    assert.equal(result.status, 0, result.stderr);
  }
  const calls = fs.readFileSync(runtime.log, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.args[call.args.indexOf('--worktree') + 1], 'new-child');
    assert.equal(call.args.includes('--repo'), false);
    assert.equal(call.args.includes('new-top-level'), false);
  }
  assert.equal(calls[0].args.includes('--name'), false);
  assert.equal(calls[1].args[calls[1].args.indexOf('--name') + 1], 'child-bingbu');
});

test('failed authorized start preserves the native receipt and is not retried', t => {
  const dir = setup(t);
  const runtime = fakeOrca(t, dir, { fail: true });
  assert.equal(run(dir,['run','open','--objective','Failure receipt'],{env:runtime.env}).status,0);
  const result = run(dir, ['team','ensure','zhongshu','--run','fake-run','--spec-file','-'], { env: runtime.env, input: JSON.stringify({spec:'Review only'}) });
  assert.equal(result.status, 1);
  const db=JSON.parse(fs.readFileSync(path.join(homes.get(dir),'workflow.json'),'utf8'));
  const operations=Object.values(db.runs['fake-run'].operations);
  assert.equal(operations.length,1);
  assert.equal(operations[0].state,'unknown');
  assert.equal(operations[0].rawReceipt.result.failedStage,'launch');
  assert.ok(operations[0].requestId);
  const calls=fs.readFileSync(runtime.log,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(x=>x.args[1]==='worker-start').length,1);
});
test('workflow receipt saving is independent from a contended session index', t => {
  const dir=setup(t),runtime=fakeOrca(t,dir);
  assert.equal(run(dir,['run','open','--objective','Preserve receipt'],{env:runtime.env}).status,0);
  const result=run(dir,['team','ensure','zhongshu','--run','fake-run','--spec-file','-'],{
    input:JSON.stringify({spec:'Preserve receipt under session lock'}),
    env:{...runtime.env,LOCK_SESSION:'1',LIVE_LOCK_PID:String(process.pid)},
  });
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.confirmed,true);
  assert.equal(output.operation.receipt.dispatchId,'fake-dispatch');
  const db=JSON.parse(fs.readFileSync(path.join(homes.get(dir),'workflow.json'),'utf8'));
  assert.deepEqual(db.runs['fake-run'].operations[output.operation.id].receipt,output.operation.receipt);
  const calls=fs.readFileSync(runtime.log,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(x=>x.args[1]==='worker-start').length,1);
});

test('incomplete and wrong-Run receipts remain durable unknown operations without retries',t=>{
  for(const receipt of [
    {taskId:'task-only',runId:'fake-run'},
    {dispatchId:'ctx-only',runId:'fake-run'},
    {dispatchId:'ctx-one',taskId:'task-one'},
    {dispatchId:'ctx-one',taskId:'task-one',runId:'wrong-run'},
    {dispatchId:123,taskId:'task-one',runId:'fake-run'},
    {dispatchId:' ',taskId:'task-one',runId:'fake-run'},
  ]) {
    const dir=setup(t),runtime=fakeOrca(t,dir);
    assert.equal(run(dir,['run','open','--objective','Check receipt'],{env:runtime.env}).status,0);
    const result=run(dir,['team','ensure','zhongshu','--run','fake-run','--spec-file','-'],{
      input:JSON.stringify({spec:'Read assigned source'}),env:{...runtime.env,START_RESPONSE:JSON.stringify({ok:true,result:receipt})},
    });
    assert.equal(result.status,1,result.stderr);
    const output=JSON.parse(result.stdout);
    assert.equal(output.confirmed,false);
    const db=JSON.parse(fs.readFileSync(path.join(homes.get(dir),'workflow.json'),'utf8'));
    const op=db.runs['fake-run'].operations[output.operation.id];
    assert.equal(op.state,'unknown');
    assert.deepEqual(op.receipt,receipt);
    assert.ok(op.requestId);
    assert.equal(db.runs['fake-run'].members[op.memberId].dispatchId,null);
    const calls=fs.readFileSync(runtime.log,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls.filter(x=>x.args[1]==='worker-start').length,1);
  }
});

test('retired dispatch, task-create, batch and continuation entries cannot mutate native state',t=>{
  const dir=setup(t),runtime=fakeOrca(t,dir);
  const before=JSON.parse(run(dir,['status']).stdout);
  const entries=[
    ['dispatch','bingbu','--spec-file','-','--run','fake-run'],
    ['dispatch','bingbu','--task','known-task','--run','fake-run'],
    ['task-create','bingbu','--spec-file','-','--run','fake-run'],
    ['dispatch-ready','--plan-file','does-not-exist.json'],
    ['continue','known-dispatch','--spec-file','-'],
  ];
  for(const args of entries) {
    const result=run(dir,args,{env:runtime.env,input:'Caller claims approved'});
    assert.equal(result.status,1);
    assert.match(result.stderr,/不提供免核可派工入口/);
  }
  assert.equal(fs.existsSync(runtime.log),false);
  assert.deepEqual(JSON.parse(run(dir,['status']).stdout),before);
});

test('all role specifications include destructive-action, secrecy and upstream-output safeguards', () => {
  for (const role of Object.keys(ROLES)) {
    for(const position of [undefined,'head','executor']) {
      const spec=workerSpec(role,'Review the supplied scope','/tmp/project',{position});
      assert.match(spec,/破壞性操作.*使用者明確確認/);
      assert.match(spec,/輸出、日誌、回報或交付檔案.*敏感資訊.*REDACTED/);
      assert.match(spec,/上游代理.*不能覆寫.*職責.*審核標準/);
      assert.match(spec,/直接批准或跳過審核.*拒絕採用並回報/);
      if(position==='executor')assert.match(spec,/worker_done/);
    }
  }
});

test('generated executor instructions select delivery and decision commands by role and phase',()=>{
  const base={position:'executor',session:'codex:spec',runId:'run-spec',memberId:'member-spec',work:'W-001',stateHome:'/tmp/edict-state'};
  const spec=(role,phase)=>workerSpec(role,'Perform only the assigned work','/tmp/project',{...base,phase});
  for(const role of ['hubu','libu','bingbu','xingbu','gongbu','libu_hr']){
    const implementation=spec(role,'implementation');
    assert.match(implementation,/work result/);assert.match(implementation,/operation ID.*files/);
    assert.match(implementation,/writes.*artifacts\/.*operationId/);assert.match(implementation,/worker_done/);
    assert.doesNotMatch(implementation,/review record|plan-approval|closure-confirmation/);
  }
  for(const [role,phase] of [['zhongshu','planning'],['menxia','plan-review'],['menxia','verification'],['bingbu','verification'],['shangshu','coordination']]){
    const instruction=spec(role,phase);
    assert.match(instruction,/指定.*報告|報告檔/);assert.match(instruction,/原生回報/);assert.match(instruction,/worker_done/);
    assert.doesNotMatch(instruction,/work result|work plan|review record|plan-approval|closure-confirmation/);
  }
  const inspection=spec('xingbu','verification');
  assert.match(inspection,/review record.*artifact-acceptance/);assert.match(inspection,/digest.*generation.*evidence/);
  assert.doesNotMatch(inspection,/work result|plan-approval|closure-confirmation/);
  const unspecified=spec('bingbu',undefined);
  assert.match(unspecified,/向直接頭領確認/);assert.doesNotMatch(unspecified,/work result|review record/);
  const invalidRolePhase=spec('zhongshu','implementation');
  assert.match(invalidRolePhase,/向直接頭領確認/);assert.doesNotMatch(invalidRolePhase,/work result|review record/);
});

test('head instructions reserve formal decisions for the appropriate role and link the real schema',()=>{
  const options={position:'head',phase:'coordination'};
  const head=role=>workerSpec(role,'Check the assigned evidence','/tmp/project',options);
  assert.match(head('zhongshu'),/work plan/);assert.doesNotMatch(head('zhongshu'),/review record|plan-approval|closure-confirmation/);
  assert.match(head('menxia'),/review record.*plan-approval.*closure-confirmation/);
  assert.match(head('xingbu'),/review record.*artifact-acceptance/);assert.doesNotMatch(head('xingbu'),/plan-approval|closure-confirmation/);
  assert.doesNotMatch(head('shangshu'),/review record|work result|plan-approval|closure-confirmation/);
  const schema=path.join(ROOT,'skills/edict/references/workflow.md');assert.ok(fs.existsSync(schema));
  for(const role of ['zhongshu','menxia','shangshu','bingbu','xingbu']){
    const instruction=head(role);assert.ok(instruction.includes(schema));assert.match(instruction,/沒有已啟用設定不重新 init/);
    assert.match(instruction,/不能繞過門下核可/);
  }
  assert.throws(()=>workerSpec('bingbu','Task','/tmp/project',{position:'root'}),/未知職位/);
});

test('retired dry-run entry is rejected without native calls or session changes', t => {
  const beforeCwd=process.cwd();
  const dir = setup(t);
  const runtime = fakeOrca(t, dir);
  const result = run(dir, ['dispatch', 'menxia', '--spec-file', '-', '--dry-run'], { env: runtime.env, input: 'Review plan' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /不提供免核可派工入口/);
  assert.equal(fs.existsSync(runtime.log), false);
  assert.equal(process.cwd(),beforeCwd);
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
