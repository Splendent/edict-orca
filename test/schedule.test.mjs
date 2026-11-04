import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaults } from '../src/config.mjs';
import { ROOT, activate, readSession, writeSession, recordTask, recordDispatch } from '../src/session.mjs';
import { validatePlan, selectReady } from '../src/schedule.mjs';

const id='codex:scheduling-test', run='run-scheduling';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'edict-schedule-'));
  const previous=process.env.EDICT_HOME;
  process.env.EDICT_HOME=path.join(root,'state');
  t.after(()=>{if(previous===undefined)delete process.env.EDICT_HOME;else process.env.EDICT_HOME=previous;fs.rmSync(root,{recursive:true,force:true});});
  const project=path.join(root,'project');fs.mkdirSync(project);
  activate(id,defaults('codex','selected-model'),project);
  recordDispatch(id,{ok:true,result:{dispatchId:'ctx-review',taskId:'task-review',runId:run}},'menxia',run);
  const native=path.join(root,'native.json'),log=path.join(root,'calls.jsonl'),fake=path.join(root,'orca.mjs');
  fs.writeFileSync(native,JSON.stringify([]));
  fs.writeFileSync(fake,`#!/usr/bin/env node
import fs from 'node:fs';
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1];
const log=(data)=>fs.appendFileSync(process.env.LOG,JSON.stringify({...data,time:Date.now()})+'\\n');
const events=()=>fs.existsSync(process.env.LOG)?fs.readFileSync(process.env.LOG,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse):[];
let rows=JSON.parse(fs.readFileSync(process.env.NATIVE,'utf8'));
if(args[0]==='worktree'){
 log({kind:'worktree',args});console.log(JSON.stringify({ok:true,result:{worktree:{path:get('--worktree').startsWith('path:')?get('--worktree').slice(5):process.cwd()}}}));
}else if(args[1]==='task-list'){
 log({kind:'list',args});
 if(args.includes('--ready'))rows=rows.filter(row=>(row.status==='ready'||row.status==='pending')&&(row.deps||[]).every(dep=>rows.find(x=>x.id===dep)?.status==='completed'));
 console.log(JSON.stringify({ok:true,result:{tasks:rows,runId:get('--run')}}));
}else if(args[1]==='task-create'){
 const spec=fs.readFileSync(0,'utf8'),id='task-created-'+rows.length;
 rows.push({id,status:'ready',deps:args.includes('--deps')?JSON.parse(get('--deps')):[]});fs.writeFileSync(process.env.NATIVE,JSON.stringify(rows));
 log({kind:'create',args,spec});console.log(JSON.stringify({ok:true,result:process.env.BAD_TASK_RECEIPT?{taskId:{invalid:true},runId:get('--run')}:{task:{id},runId:get('--run')}}));
}else if(args[1]==='send'){
 log({kind:'send',args});console.log(JSON.stringify({ok:true,result:process.env.SEND_RECEIPT?JSON.parse(process.env.SEND_RECEIPT):process.env.BAD_SEND_RECEIPT?{}:process.env.LIVE_SEND?{messageId:'msg-live'}:{delivery:'reopened',dispatchId:'ctx-followup',taskId:'task-followup',runId:get('--run')}}));
}else{
 const task=get('--task');log({kind:'start',task,args});
 const started=Date.now();
 const finish=()=>{
  if(events().filter(x=>x.kind==='start').length<Number(process.env.EXPECTED||1)&&Date.now()-started<1200){setTimeout(finish,10);return;}
  setTimeout(()=>{log({kind:'end',task});const fail=task===process.env.FAIL_TASK;console.log(JSON.stringify({ok:!fail,result:{dispatchId:'ctx-'+task,taskId:task,runId:get('--run'),failedStage:fail?'agent_readiness':null}}));process.exitCode=fail?1:0;},50);
 };finish();
}
`);
  fs.chmodSync(fake,0o755);
  const env={ORCA_CLI_COMMAND:fake,NATIVE:native,LOG:log};
  function cli(args,extra={},input) { return spawnSync(process.execPath,[path.join(ROOT,'bin/edict.mjs'),...args,'--session',id],{cwd:project,encoding:'utf8',input,env:{...process.env,...env,...extra}}); }
  function plan(tasks) {
    for(const item of tasks) recordTask(id,{ok:true,result:{taskId:item.task,runId:run}},item.role,run);
    const value={run,tasks:tasks.map(item=>({scope:item.task,readOnly:true,approval:{dispatchId:'ctx-review',verdict:'approved',scopes:[item.task]},...item}))};
    const file=path.join(root,'plan.json');fs.writeFileSync(file,JSON.stringify(value));return {value,file};
  }
  const calls=()=>fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  return {root,project,native,log,env,cli,plan,calls};
}

test('task creation forwards structured dependencies and embeds the role once',t=>{
  const f=fixture(t);
  const result=f.cli(['task-create','bingbu','--spec-file','-','--run',run,'--deps','["task-contract"]','--parent','task-parent'],{},'Literal `code` $(text)\nScope');
  assert.equal(result.status,0,result.stderr);
  const created=f.calls().find(x=>x.kind==='create');
  assert.deepEqual(JSON.parse(created.args[created.args.indexOf('--deps')+1]),['task-contract']);
  assert.equal(created.args[created.args.indexOf('--parent')+1],'task-parent');
  assert.match(created.spec,/兵部/);assert.ok(created.spec.includes('$(text)'));
  const task=JSON.parse(result.stdout).result.task.id;
  assert.equal(readSession(id).tasks.find(x=>x.taskId===task).role,'bingbu');
  assert.equal(f.cli(['dispatch','bingbu','--task',task,'--run',run]).status,0);
  assert.equal(f.cli(['dispatch','libu','--task',task,'--run',run]).status,1);
});
test('independent same-role tasks launch concurrently and both receipts are saved',t=>{
  const f=fixture(t),tasks=[{task:'task-a',role:'bingbu'},{task:'task-b',role:'bingbu'}],p=f.plan(tasks);
  fs.writeFileSync(f.native,JSON.stringify(tasks.map(x=>({id:x.task,status:'ready'}))));
  const result=f.cli(['dispatch-ready','--plan-file',p.file],{EXPECTED:'2'});
  assert.equal(result.status,0,result.stderr);
  const events=f.calls(),starts=events.filter(x=>x.kind==='start'),ends=events.filter(x=>x.kind==='end');
  assert.equal(starts.length,2);assert.ok(Math.max(...starts.map(x=>x.time))<=Math.min(...ends.map(x=>x.time)));
  assert.equal(readSession(id).dispatches.filter(x=>x.role==='bingbu').length,2);
  for(const item of starts) assert.equal(item.args[item.args.indexOf('--model')+1],'selected-model');
  assert.equal(events.filter(x=>x.kind==='list').length,2);
});

test('unnamed child worktrees are distinct creation requests while duplicate explicit names are refused',t=>{
  const f=fixture(t),tasks=[{task:'task-a',role:'bingbu',worktree:'new-child',reads:[]},{task:'task-b',role:'bingbu',worktree:'new-child',reads:[]}],p=f.plan(tasks);
  fs.writeFileSync(f.native,JSON.stringify(tasks.map(x=>({id:x.task,status:'ready'}))));
  const result=f.cli(['dispatch-ready','--plan-file',p.file,'--dry-run']);
  assert.equal(result.status,0,result.stderr);
  const output=JSON.parse(result.stdout);
  assert.equal(output.launches.length,2);
  assert.deepEqual(output.held,[]);
  for(const row of output.launches) {
    assert.equal(row.args[row.args.indexOf('--worktree')+1],'new-child');
    assert.equal(row.args.includes('--repo'),false);
    assert.equal(row.args.includes('--name'),false);
  }
  assert.equal(f.calls().filter(x=>x.kind==='start').length,0);
  const callsBefore=f.calls().length;
  p.value.tasks.forEach(item=>{item.name='same-child';});
  fs.writeFileSync(p.file,JSON.stringify(p.value));
  const duplicate=f.cli(['dispatch-ready','--plan-file',p.file,'--dry-run']);
  assert.equal(duplicate.status,1);
  assert.match(duplicate.stderr,/不可重複建立相同名稱/);
  assert.equal(f.calls().length,callsBefore);
});
test('dependencies release one work item without waiting for an unrelated active item',t=>{
  const f=fixture(t),p=f.plan([{task:'task-a',role:'bingbu'},{task:'task-b',role:'libu'},{task:'task-c',role:'hubu'}]);
  fs.writeFileSync(f.native,JSON.stringify([{id:'task-a',status:'completed'},{id:'task-b',status:'pending',deps:['task-a']},{id:'task-c',status:'dispatched'}]));
  const result=f.cli(['dispatch-ready','--plan-file',p.file]);
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(f.calls().filter(x=>x.kind==='start').map(x=>x.task),['task-b']);
});
test('pending dependencies, completed tasks and a full Run never get launched',t=>{
  const f=fixture(t),p=f.plan([{task:'task-a',role:'bingbu'},{task:'task-b',role:'libu'}]);
  fs.writeFileSync(f.native,JSON.stringify([{id:'task-a',status:'dispatched'},{id:'task-b',status:'pending',deps:['task-a']}]));
  const result=f.cli(['dispatch-ready','--plan-file',p.file,'--concurrency','1']);
  assert.equal(result.status,0,result.stderr);
  assert.equal(f.calls().filter(x=>x.kind==='start').length,0);
  assert.equal(JSON.parse(result.stdout).held.length,2);
});
test('unapproved scopes are rejected before any runtime call',t=>{
  const f=fixture(t),p=f.plan([{task:'task-a',role:'bingbu'}]);
  p.value.tasks[0].approval.scopes=['different-unit'];fs.writeFileSync(p.file,JSON.stringify(p.value));
  assert.equal(f.cli(['dispatch-ready','--plan-file',p.file]).status,1);
  assert.deepEqual(f.calls(),[]);
});
test('read/write overlaps hold conflicting work; separate declared ranges can run together',t=>{
  const f=fixture(t),p=f.plan([
    {task:'task-a',role:'bingbu',readOnly:false,reads:[],writes:['src/frontend']},
    {task:'task-b',role:'bingbu',readOnly:false,reads:[],writes:['src/frontend/index.js']},
    {task:'task-c',role:'bingbu',readOnly:false,reads:[],writes:['src/backend']},
    {task:'task-d',role:'xingbu',reads:['src/frontend']},
  ]);
  const tasks=validatePlan(p.value,readSession(id));
  const rows=tasks.map(x=>({id:x.task,status:'ready'}));
  const selection=selectReady(tasks,rows,rows,3);
  assert.deepEqual(selection.selected.map(x=>x.task),['task-a','task-c']);
  assert.deepEqual(selection.held.map(x=>x.taskId),['task-b','task-d']);
});
test('uncreated worktrees have unknown physical ranges and serialize writers',t=>{
  const f=fixture(t),p=f.plan(['a','b'].map(s=>({task:'task-'+s,role:'bingbu',readOnly:false,writes:['src'],reads:[],worktree:'new-top-level',repo:'id:repo',name:'isolated-'+s})));
  const tasks=validatePlan(p.value,readSession(id)),rows=tasks.map(x=>({id:x.task,status:'ready'}));
  assert.equal(selectReady(tasks,rows,rows,3).selected.length,1);
});
test('precreated independent worktrees can write the same relative paths concurrently',t=>{
  const f=fixture(t);
  const entries=['a','b'].map(name=>{
    const root=path.join(f.root,name);fs.mkdirSync(path.join(root,'src'),{recursive:true});fs.writeFileSync(path.join(root,'src/file.js'),'');
    return {task:'task-'+name,role:'bingbu',readOnly:false,writes:['src'],reads:[],worktree:'path:'+root};
  });
  const p=f.plan(entries),tasks=validatePlan(p.value,readSession(id)),rows=tasks.map(x=>({id:x.task,status:'ready'}));
  assert.equal(selectReady(tasks,rows,rows,3).selected.length,2);
});
test('an unscoped active task blocks even an uncreated writer with unknown physical ranges',t=>{
  const f=fixture(t),p=f.plan([{task:'task-a',role:'bingbu',readOnly:false,writes:['src'],reads:[],worktree:'new-top-level',repo:'id:repo',name:'new-a'}]);
  const tasks=validatePlan(p.value,readSession(id));
  const rows=[{id:'unknown-active',status:'dispatched'},{id:'task-a',status:'ready'}];
  assert.equal(selectReady(tasks,rows,[rows[1]],3).selected.length,0);
});
test('symbolic links to existing and future files cannot bypass conflicts',t=>{
  const f=fixture(t);
  fs.mkdirSync(path.join(f.project,'actual'));fs.writeFileSync(path.join(f.project,'actual/file.txt'),'');
  fs.symlinkSync('actual',path.join(f.project,'alias'),'dir');
  for(const file of ['file.txt','future.txt']) {
    const p=f.plan([{task:'writer-'+file,role:'bingbu',readOnly:false,reads:[],writes:['actual/'+file]},{task:'reader-'+file,role:'xingbu',reads:['alias/'+file]}]);
    const tasks=validatePlan(p.value,readSession(id)),rows=tasks.map(x=>({id:x.task,status:'ready'}));
    assert.equal(selectReady(tasks,rows,rows,3).selected.length,1);
  }
});
test('case aliases use physical identity when the filesystem supports them',t=>{
  const f=fixture(t);
  fs.mkdirSync(path.join(f.project,'actual'));fs.writeFileSync(path.join(f.project,'actual/file.txt'),'');
  if(!fs.existsSync(path.join(f.project,'ACTUAL/FILE.TXT'))) { t.skip('case-sensitive filesystem');return; }
  const p=f.plan([{task:'writer',role:'bingbu',readOnly:false,reads:[],writes:['actual/file.txt']},{task:'reader',role:'xingbu',reads:['ACTUAL/FILE.TXT']}]);
  const tasks=validatePlan(p.value,readSession(id)),rows=tasks.map(x=>({id:x.task,status:'ready'}));
  assert.equal(selectReady(tasks,rows,rows,3).selected.length,1);
});
test('directory scopes include linked descendants and hard-linked files',t=>{
  const f=fixture(t);
  fs.mkdirSync(path.join(f.project,'sources'));fs.mkdirSync(path.join(f.project,'outside'));
  fs.writeFileSync(path.join(f.project,'outside/file.txt'),'');
  fs.symlinkSync('../outside/file.txt',path.join(f.project,'sources/link.txt'));
  fs.linkSync(path.join(f.project,'outside/file.txt'),path.join(f.project,'sources/hard.txt'));
  const p=f.plan([{task:'writer',role:'bingbu',readOnly:false,reads:[],writes:['sources']},{task:'reader',role:'xingbu',reads:['outside/file.txt']}]);
  const tasks=validatePlan(p.value,readSession(id)),rows=tasks.map(x=>({id:x.task,status:'ready'}));
  assert.equal(selectReady(tasks,rows,rows,3).selected.length,1);
});
test('one failed parallel launch preserves the other receipt and never retries',t=>{
  const f=fixture(t),p=f.plan([{task:'task-a',role:'bingbu'},{task:'task-b',role:'libu'}]);
  fs.writeFileSync(f.native,JSON.stringify([{id:'task-a',status:'ready'},{id:'task-b',status:'ready'}]));
  const result=f.cli(['dispatch-ready','--plan-file',p.file],{FAIL_TASK:'task-b',EXPECTED:'2'});
  assert.equal(result.status,1);
  const output=JSON.parse(result.stdout);
  assert.equal(output.results.find(x=>x.taskId==='task-a').exitCode,0);
  assert.ok(fs.existsSync(output.results.find(x=>x.taskId==='task-b').receiptBackup));
  assert.equal(f.calls().filter(x=>x.kind==='start').length,2);
  assert.ok(readSession(id).dispatches.some(x=>x.taskId==='task-a'));
});
test('continue targets the original role and Run even after another Run becomes current',t=>{
  const f=fixture(t);
  const state=readSession(id);state.runId='run-new';state.config.roles.menxia={agent:'claude',model:'changed',effort:null};writeSession(state);
  const result=f.cli(['continue','ctx-review','--spec-file','-'],{},'Only review the revision delta');
  assert.equal(result.status,0,result.stderr);
  const sent=f.calls().find(x=>x.kind==='send');
  assert.equal(sent.args[sent.args.indexOf('--to')+1],'dispatch:ctx-review');
  assert.equal(sent.args[sent.args.indexOf('--run')+1],run);
  assert.equal(sent.args.includes('--model'),false);
  assert.match(sent.args[sent.args.indexOf('--body')+1],/門下省/);
  const after=readSession(id);
  assert.equal(after.runId,'run-new');
  assert.ok(after.dispatches.some(x=>x.dispatchId==='ctx-followup'&&x.resumedFrom==='ctx-review'));
  assert.equal(after.continuations.length,1);
});
test('a live continuation records its message without inventing a new Dispatch',t=>{
  const f=fixture(t);
  const before=readSession(id).dispatches.length;
  assert.equal(f.cli(['continue','ctx-review','--spec-file','-'],{LIVE_SEND:'1'},'More evidence').status,0);
  assert.equal(readSession(id).dispatches.length,before);
  assert.equal(readSession(id).continuations[0].messageId,'msg-live');
  assert.equal(f.cli(['continue','ctx-other-session','--spec-file','-'],{},'No access').status,1);
});
test('an unidentifiable continuation is backed up without recording or resending',t=>{
  const f=fixture(t),before=readSession(id);
  const result=f.cli(['continue','ctx-review','--spec-file','-'],{BAD_SEND_RECEIPT:'1'},'Revision');
  assert.equal(result.status,1);
  assert.deepEqual(readSession(id),before);
  assert.equal(f.calls().filter(x=>x.kind==='send').length,1);
  assert.equal(fs.readdirSync(path.join(process.env.EDICT_HOME,'receipts')).length,1);
});
test('valid message IDs never conceal invalid or partial additional receipt IDs',t=>{
  const f=fixture(t),before=readSession(id);
  const invalid=[
    {messageId:'msg-valid',dispatchId:123,taskId:456},
    {messageId:'msg-valid',dispatchId:'ctx-new',taskId:456},
    {messageId:'msg-valid',dispatchId:123,taskId:'task-new'},
    {messageId:'msg-valid',dispatchId:'ctx-new'},
    {messageId:'msg-valid',taskId:'task-new'},
    {messageId:'msg-valid',dispatchId:' ',taskId:'task-new'},
    {messageId:'msg-valid',dispatchId:'ctx-new',taskId:'\t'},
    {messageId:'msg-valid',dispatchId:0,taskId:null},
    {messageId:123,dispatchId:'ctx-new',taskId:'task-new'},
    {messageId:'msg-valid',runId:0},
    {messageId:'msg-valid',runId:' '},
  ];
  for(const payload of invalid) {
    const result=f.cli(['continue','ctx-review','--spec-file','-'],{SEND_RECEIPT:JSON.stringify(payload)},'Only the revision');
    assert.equal(result.status,1,JSON.stringify(payload));
    assert.deepEqual(JSON.parse(result.stdout),{ok:true,result:payload});
    assert.deepEqual(readSession(id),before);
  }
  assert.equal(f.calls().filter(x=>x.kind==='send').length,invalid.length);
  assert.equal(fs.readdirSync(path.join(process.env.EDICT_HOME,'receipts')).length,invalid.length);
});
test('a valid mixed receipt records both message and complete Dispatch pair',t=>{
  const f=fixture(t),payload={messageId:'msg-valid',dispatchId:'ctx-new',taskId:'task-new',runId:run};
  assert.equal(f.cli(['continue','ctx-review','--spec-file','-'],{SEND_RECEIPT:JSON.stringify(payload)},'Revision').status,0);
  const after=readSession(id);
  assert.equal(after.continuations[0].messageId,'msg-valid');
  assert.ok(after.dispatches.some(x=>x.dispatchId==='ctx-new'&&x.taskId==='task-new'));
  assert.ok(after.tasks.some(x=>x.taskId==='task-new'));
});
test('a malformed Task receipt is backed up without indexing or recreating',t=>{
  const f=fixture(t),before=readSession(id);
  const result=f.cli(['task-create','bingbu','--spec-file','-','--run',run],{BAD_TASK_RECEIPT:'1'},'Task');
  assert.equal(result.status,1);
  assert.deepEqual(readSession(id),before);
  assert.equal(f.calls().filter(x=>x.kind==='create').length,1);
  assert.equal(fs.readdirSync(path.join(process.env.EDICT_HOME,'receipts')).length,1);
});
test('dry-run queries readiness once without launching or recording work',t=>{
  const f=fixture(t),p=f.plan([{task:'task-a',role:'bingbu'}]);
  fs.writeFileSync(f.native,JSON.stringify([{id:'task-a',status:'ready'}]));
  const before=readSession(id);
  assert.equal(f.cli(['dispatch-ready','--plan-file',p.file,'--dry-run']).status,0);
  assert.deepEqual(readSession(id),before);
  assert.equal(f.calls().filter(x=>x.kind==='start').length,0);
});
