import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaults } from '../src/config.mjs';
import { ROOT, activate, readSession, writeSession, recordTask, recordDispatch } from '../src/session.mjs';
import { validatePlan, selectReady } from '../src/schedule.mjs';
import { Workflow } from '../src/workflow.mjs';

const id='codex:schedule',run='run-schedule';
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'edict-ranges-'));
  const prior=process.env.EDICT_HOME;
  process.env.EDICT_HOME=path.join(root,'state');
  t.after(()=>{if(prior===undefined)delete process.env.EDICT_HOME;else process.env.EDICT_HOME=prior;fs.rmSync(root,{recursive:true,force:true});});
  const project=path.join(root,'project');fs.mkdirSync(project);
  activate(id,defaults('codex','selected-model'),project);
  // These legacy scheduling structures are used only to test physical range selection.
  recordDispatch(id,{ok:true,result:{dispatchId:'ctx-review',taskId:'task-review',runId:run}},'menxia',run);
  function plan(tasks) {
    for(const item of tasks)recordTask(id,{ok:true,result:{taskId:item.task,runId:run}},item.role,run);
    const value={run,tasks:tasks.map(item=>({scope:item.task,readOnly:true,approval:{dispatchId:'ctx-review',verdict:'approved',scopes:[item.task]},...item}))};
    return {value};
  }
  return {root,project,plan};
}

function workflowFixture(t) {
  const f=fixture(t),proof=path.join(f.root,'proof.txt');fs.writeFileSync(proof,'Independent review');
  let actor={owner:true},counter=0;
  const runtime={
    calls:[],rows:[],identity(){return actor;},open(){return run;},
    start(runId,settings,spec,options,requestId){
      this.calls.push({kind:'start',runId,settings,spec,options,requestId});
      const dispatchId='dispatch-'+(++counter),taskId='task-'+counter;
      this.rows.push({dispatchId,state:'ready'});return {dispatchId,taskId,runId};
    },
    workers(){return this.rows;},
    send(runId,dispatchId,body,requestId){this.calls.push({kind:'send',runId,dispatchId,body,requestId});return this.receipt??{messageId:'message-live'};},
  };
  const w=new Workflow(id,runtime);w.open('Test scoped messages');
  w.launch(run,'menxia','head',undefined,{spec:'Wait for a legitimate review scope'});
  w.launch(run,'shangshu','head',undefined,{spec:'Wait for an approved implementation scope'});
  w.add(run,{id:'W-001',title:'Work',requirement:'Write assigned source',reads:['src'],writes:['src'],acceptance:['Check result']});
  const as=member=>{actor={owner:false,dispatchId:member.dispatchId};};
  const head=role=>w.launch(run,role,'head',role==='zhongshu'?undefined:'W-001',{spec:'Perform assigned role',generation:1}).member;
  const zhongshu=head('zhongshu');as(zhongshu);
  const proposal=w.plan(run,'W-001',{generation:1,description:'Write src/result.txt',writes:['src'],acceptance:['Check result']});
  const menxia=head('menxia');as(menxia);
  w.review(run,'W-001',{generation:1,kind:'plan-approval',digest:proposal.digest,verdict:'approved',evidence:[proof]});
  as(zhongshu);
  const send=body=>w.message(run,menxia.id,'W-001',body,undefined,1);
  return {...f,w,runtime,as,zhongshu,menxia,send};
}

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
test('ready selection retains independent parallel work and true dependency boundaries',t=>{
  const f=fixture(t),p=f.plan([{task:'a',role:'bingbu'},{task:'b',role:'bingbu'},{task:'c',role:'libu'}]);
  const tasks=validatePlan(p.value,readSession(id));
  const all=[{id:'a',status:'completed'},{id:'b',status:'ready',deps:['a']},{id:'c',status:'dispatched'}];
  assert.deepEqual(selectReady(tasks,all,[all[1]],3).selected.map(x=>x.task),['b']);
  assert.equal(selectReady(tasks,all,[all[1]],1).selected.length,0);
  const ready=tasks.map(x=>({id:x.task,status:'ready'}));
  assert.deepEqual(selectReady(tasks,ready,ready,2).selected.map(x=>x.task),['a','b']);
  assert.equal(selectReady(tasks,ready,[],3).selected.length,0);
});

test('retired task and batch CLI paths reject even caller-supplied approval with zero native calls',t=>{
  const f=fixture(t),log=path.join(f.root,'native-calls'),fake=path.join(f.root,'fake.mjs');
  fs.writeFileSync(fake,'#!/usr/bin/env node\nimport fs from "node:fs";fs.appendFileSync(process.env.LOG,"mutation\\n");process.exit(9);\n');fs.chmodSync(fake,0o755);
  const file=path.join(f.root,'plan.json');fs.writeFileSync(file,JSON.stringify({run,tasks:[{task:'a',role:'bingbu',approval:{verdict:'approved'}}]}));
  const entries=[['task-create','bingbu','--spec-file','-','--run',run],['dispatch','bingbu','--task','a','--run',run],['dispatch-ready','--plan-file',file],['dispatch-ready','--plan-file',file,'--dry-run'],['continue','ctx-review','--spec-file','-']];
  const before=readSession(id);
  for(const args of entries){
    const result=spawnSync(process.execPath,[path.join(ROOT,'bin/edict.mjs'),...args,'--session',id],{cwd:f.project,encoding:'utf8',input:'approved',env:{...process.env,ORCA_CLI_COMMAND:fake,LOG:log}});
    assert.equal(result.status,1);assert.match(result.stderr,/不提供免核可派工入口/);
  }
  assert.equal(fs.existsSync(log),false);assert.deepEqual(readSession(id),before);
});

test('native adapter forwards structured deps, parent and literal task text without shell interpretation',t=>{
  const f=fixture(t),fake=path.join(f.root,'native adapter.mjs'),log=path.join(f.root,'calls.json');
  fs.writeFileSync(fake,'#!/usr/bin/env node\nimport fs from "node:fs";fs.writeFileSync(process.env.LOG,JSON.stringify({args:process.argv.slice(2),body:fs.readFileSync(0,"utf8")}));console.log(JSON.stringify({ok:true,result:{dispatchId:"native-dispatch",taskId:"native-task",runId:"run-schedule"}}));\n');fs.chmodSync(fake,0o755);
  const literal='Literal `touch MUST_NOT_EXIST` $(touch MUST_NOT_EXIST)\nSecond line';
  const script=`import {NativeRuntime} from ${JSON.stringify(new URL('../src/native.mjs',import.meta.url).href)};const receipt=new NativeRuntime().start(${JSON.stringify(run)},{agent:'claude',model:'model with spaces',effort:'high'},${JSON.stringify(literal)},{title:'quoted "title"',parent:'task-parent',deps:['task-contract'],worktree:'current'},'request-literal');process.stdout.write(JSON.stringify(receipt));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:f.project,encoding:'utf8',env:{...process.env,ORCA_CLI_COMMAND:fake,LOG:log}});
  assert.equal(result.status,0,result.stderr);
  const call=JSON.parse(fs.readFileSync(log,'utf8')),get=key=>call.args[call.args.indexOf(key)+1];
  assert.deepEqual(JSON.parse(get('--deps')),['task-contract']);assert.equal(get('--parent'),'task-parent');
  assert.equal(get('--model'),'model with spaces');assert.equal(get('--task-title'),'quoted "title"');assert.equal(get('--retry-request'),'request-literal');
  assert.equal(call.body,literal);assert.equal(fs.existsSync(path.join(f.project,'MUST_NOT_EXIST')),false);
  assert.deepEqual(JSON.parse(result.stdout),{dispatchId:'native-dispatch',taskId:'native-task',runId:run});
});

test('scoped message retains original Run, member, model snapshot and literal body',t=>{
  const f=workflowFixture(t),state=readSession(id);state.runId='run-new';state.config.roles.menxia={agent:'claude',model:'changed',effort:null};writeSession(state);
  const before=f.w.run(run),operation=Object.values(before.operations).find(x=>x.memberId===f.menxia.id);
  f.runtime.receipt={messageId:'msg-reopened',dispatchId:'dispatch-new',taskId:'task-new',runId:run};
  const body='Only review "delta" `literal` $(literal)\nSecond line';
  const record=f.send(body),call=f.runtime.calls.findLast(x=>x.kind==='send');
  assert.equal(call.runId,run);assert.equal(call.dispatchId,f.menxia.dispatchId);assert.equal(call.body,body);assert.ok(call.requestId);
  assert.equal(record.state,'delivered');assert.deepEqual(record.receipt,f.runtime.receipt);
  const after=f.w.run(run),continued=after.operations[record.id];
  assert.equal(after.members[f.menxia.id].dispatchId,'dispatch-new');assert.ok(after.members[f.menxia.id].dispatches.includes(f.menxia.dispatchId));
  assert.deepEqual(continued.settings,operation.settings);assert.equal(continued.runId,run);assert.equal(readSession(id).runId,'run-new');
});

test('native message adapter keeps target, Run and literal body without replacement model arguments',t=>{
  const f=fixture(t),fake=path.join(f.root,'message adapter.mjs'),log=path.join(f.root,'send.json');
  fs.writeFileSync(fake,'#!/usr/bin/env node\nimport fs from "node:fs";fs.writeFileSync(process.env.LOG,JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({ok:true,result:{messageId:"native-message"}}));\n');fs.chmodSync(fake,0o755);
  const body='Quote " and \' `touch MUST_NOT_EXIST` $(touch MUST_NOT_EXIST)\nReview the original Run';
  const script=`import {NativeRuntime} from ${JSON.stringify(new URL('../src/native.mjs',import.meta.url).href)};process.stdout.write(JSON.stringify(new NativeRuntime().send(${JSON.stringify(run)},'original-dispatch',${JSON.stringify(body)},'request-send')));`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:f.project,encoding:'utf8',env:{...process.env,ORCA_CLI_COMMAND:fake,LOG:log}});
  assert.equal(result.status,0,result.stderr);
  const args=JSON.parse(fs.readFileSync(log,'utf8')),get=key=>args[args.indexOf(key)+1];
  assert.equal(get('--to'),'dispatch:original-dispatch');assert.equal(get('--run'),run);
  assert.equal(get('--body'),body);assert.equal(get('--retry-request'),'request-send');
  assert.equal(args.includes('--model'),false);assert.equal(args.includes('--agent'),false);
  assert.deepEqual(JSON.parse(result.stdout),{messageId:'native-message'});
  assert.equal(fs.existsSync(path.join(f.project,'MUST_NOT_EXIST')),false);
});

test('a live scoped message saves its receipt without inventing a new Dispatch',t=>{
  const f=workflowFixture(t),before=f.w.run(run);const record=f.send('Additional review evidence');
  const after=f.w.run(run);
  assert.equal(record.state,'delivered');assert.equal(record.receipt.messageId,'message-live');
  assert.equal(Object.keys(after.operations).length,Object.keys(before.operations).length+1);
  const originalDispatches=new Set(Object.values(before.operations).map(x=>x.dispatchId).filter(Boolean));
  for(const op of Object.values(after.operations))if(op.dispatchId)assert.ok(originalDispatches.has(op.dispatchId));
  assert.deepEqual(after.members[f.menxia.id],before.members[f.menxia.id]);
  assert.throws(()=>f.w.message(run,'other-session-member','W-001','No access',undefined,1),/目標成員/);
});

const invalidMessageReceipts=[{},
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
    {messageId:'msg-valid',runId:'other-run'},
];
for(const payload of invalidMessageReceipts) {
 test(`invalid scoped message receipt stays durable unknown without rebinding: ${JSON.stringify(payload)}`,t=>{
  const f=workflowFixture(t);
    const before=f.w.run(run),calls=f.runtime.calls.filter(x=>x.kind==='send').length;
    f.runtime.receipt=payload;
    const record=f.send('Review this revision');
    assert.equal(record.state,'unknown',JSON.stringify(payload));assert.deepEqual(record.receipt,payload);
    const after=f.w.run(run);
    assert.deepEqual(after.members[f.menxia.id],before.members[f.menxia.id]);
    assert.equal(Object.keys(after.operations).length,Object.keys(before.operations).length+1);
    assert.equal(after.operations[record.id].state,'unknown');
    const originalDispatches=new Set(Object.values(before.operations).map(x=>x.dispatchId).filter(Boolean));
    for(const op of Object.values(after.operations))if(op.dispatchId)assert.ok(originalDispatches.has(op.dispatchId));
    assert.equal(f.runtime.calls.filter(x=>x.kind==='send').length,calls+1);
    assert.equal(after.messages.at(-1).state,'unknown');assert.deepEqual(after.messages.at(-1).receipt,payload);
 });
}

test('failure of a later independent start preserves accepted and unknown operation receipts',t=>{
  const f=workflowFixture(t);
  f.as(f.menxia);
  const accepted=f.w.launch(run,'menxia','executor','W-001',{spec:'First independent review',generation:1});
  const start=f.runtime.start;
  f.runtime.start=function(...args){this.calls.push({kind:'start',requestId:args.at(-1)});const error=new Error('native readiness failed');error.receipt={ok:false,result:{failedStage:'agent_readiness'}};throw error;};
  assert.throws(()=>f.w.launch(run,'menxia','executor','W-001',{spec:'Second independent review',generation:1}),/readiness failed/);
  const after=f.w.run(run),unknown=Object.values(after.operations).findLast(x=>x.state==='unknown');
  assert.equal(after.operations[accepted.operation.id].receipt.dispatchId,accepted.member.dispatchId);
  assert.equal(unknown.rawReceipt.result.failedStage,'agent_readiness');assert.ok(unknown.requestId);
  assert.equal(f.runtime.calls.filter(x=>x.kind==='start').length,5);
  f.runtime.start=start;
});

test('independent same-role delegates can both remain in flight without waiting for the first result',t=>{
  const f=workflowFixture(t);f.as(f.menxia);
  const first=f.w.launch(run,'menxia','executor','W-001',{spec:'Review requirement coverage',generation:1});
  const second=f.w.launch(run,'menxia','executor','W-001',{spec:'Review acceptance requirements',generation:1});
  assert.notEqual(first.member.dispatchId,second.member.dispatchId);
  const operations=f.w.run(run).operations;
  for(const launch of [first,second]){
    assert.equal(operations[launch.operation.id].state,'accepted');
    assert.equal(f.runtime.rows.find(x=>x.dispatchId===launch.member.dispatchId).state,'ready');
    assert.equal(operations[launch.operation.id].settings.model,'selected-model');
    assert.equal(operations[launch.operation.id].result,undefined);
  }
  assert.equal(f.runtime.calls.filter(x=>x.kind==='start').length,5);
});
