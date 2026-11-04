import path from 'node:path';
import { ROLES } from './roles.mjs';
import { dispatchArgs, orcaCommand, runOrca, runOrcaAsync } from './orca.mjs';
import { requireActive, taskBinding, recordDispatch, saveDispatchReceipt } from './session.mjs';
import { geometry, rangeOverlap } from './ranges.mjs';

function paths(value, fallback) {
  const list=value ?? fallback;
  if (!Array.isArray(list) || list.some(x=>typeof x!=='string'||!x.trim())) throw new Error('reads／writes 必須是工作樹相對路徑陣列');
  return list.map(value=>{
    if (value==='*') return value;
    const name=path.posix.normalize(value.replaceAll('\\','/')).replace(/\/$/,'');
    if (name==='.' || name==='..' || name.startsWith('../') || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name) || /[*?\[\]]/.test(name)) throw new Error('工作範圍只接受工作樹相對路徑或單獨的 *');
    return name;
  });
}
export function conflict(a,b) {
  return rangeOverlap(a.physicalWrites,b.physicalWrites)||rangeOverlap(a.physicalWrites,b.physicalReads)||rangeOverlap(b.physicalWrites,a.physicalReads);
}
export function validatePlan(plan,state,roots) {
  if (!plan || typeof plan.run!=='string' || !plan.run.trim() || !Array.isArray(plan.tasks)) throw new Error('派工檔須包含 run 與 tasks 陣列');
  const seen=new Set(), creations=new Set();
  return plan.tasks.map(item=>{
    if (!item || typeof item.task!=='string' || seen.has(item.task) || !ROLES[item.role]) throw new Error('Task ID 不可重複，且須指定有效角色');
    seen.add(item.task);
    taskBinding(state,item.task,item.role,plan.run);
    if (typeof item.scope!=='string'||!item.scope.trim()||typeof item.readOnly!=='boolean') throw new Error('每項工作須有 scope 與明確的 readOnly');
    const approval=item.approval;
    const reviewer=state.dispatches.find(row=>row.dispatchId===approval?.dispatchId);
    if (approval?.verdict!=='approved'||!Array.isArray(approval.scopes)||!approval.scopes.includes(item.scope)||reviewer?.role!=='menxia'||reviewer.runId!==plan.run) throw new Error(`工作 ${item.task} 缺少本 Run 門下對此 scope 的明確放行聲明`);
    const writes=paths(item.writes,[]), reads=paths(item.reads,['*']);
    if (item.readOnly&&writes.length || !item.readOnly&&!writes.length) throw new Error('唯讀工作不可宣告 writes，寫入工作必須列出 writes');
    const result={...item,worktree:item.worktree||'current',writes,reads};
    dispatchArgs(state.config,item.role,{...result,run:plan.run});
    const root=roots?roots.get(result.worktree):result.worktree==='current'?state.project:result.worktree.startsWith('path:')?result.worktree.slice(5):null;
    result.physicalReads=geometry(root,reads);result.physicalWrites=geometry(root,writes);
    if (result.worktree.startsWith('new-') && result.name) {
      const key=`${result.repo}:${result.name}`;
      if (creations.has(key)) throw new Error('同批不可重複建立相同名稱的工作樹');
      creations.add(key);
    }
    return result;
  });
}
function taskRows(result) {
  if (result.status!==0) throw new Error(`Orca Task 查詢失敗；未派工。${result.stderr||result.stdout}`);
  const data=JSON.parse(result.stdout);
  if (!data.ok||!Array.isArray(data.result?.tasks)) throw new Error('Orca Task 查詢格式不正確；未派工');
  return data.result.tasks;
}
export function selectReady(tasks,all,ready,limit) {
  const native=new Map(all.map(row=>[row.id,row]));
  const eligible=new Set(ready.map(row=>row.id));
  const running=all.filter(row=>row.status==='dispatched');
  const knownRunning=running.map(row=>tasks.find(item=>item.task===row.id));
  const selected=[], held=[];
  for (const item of tasks) {
    const row=native.get(item.task);
    let reason;
    if (!row) reason='Task 不在指定 Run';
    else if (!['ready','pending'].includes(row.status)) reason=`Task 已不在可啟動狀態（${row.status}）`;
    else if (!eligible.has(item.task)) reason=`Orca 尚未就緒（${row.status}）`;
    else if (running.length+selected.length>=limit) reason='目前 Run 已達本次併發上限';
    else if (knownRunning.some(other=>other?conflict(item,other):true)) reason='與執行中工作的讀寫範圍可能衝突';
    else if (selected.some(other=>conflict(item,other))) reason='與本批工作有讀寫相依，暫緩';
    if (reason) held.push({taskId:item.task,reason}); else selected.push(item);
  }
  return {selected,held};
}
export async function dispatchReady(id,plan,limit=3,dryRun=false) {
  if (!Number.isInteger(limit)||limit<1||limit>8) throw new Error('concurrency 必須為 1–8 的整數');
  const state=requireActive(id);
  validatePlan(plan,state,new Map());
  const command=orcaCommand();
  const roots=new Map();
  for(const selector of new Set(plan.tasks.map(item=>item.worktree||'current'))) {
    if(selector.startsWith('new-')) continue;
    const result=runOrca(command,['worktree','show','--worktree',selector,'--json']);
    try {
      const data=JSON.parse(result.stdout);
      if(result.status===0&&data.ok&&typeof data.result?.worktree?.path==='string') roots.set(selector,data.result.worktree.path);
    } catch { /* Unknown physical roots are serialized conservatively. */ }
  }
  const tasks=validatePlan(plan,state,roots);
  const all=taskRows(runOrca(command,['orchestration','task-list','--run',plan.run,'--json']));
  const ready=taskRows(runOrca(command,['orchestration','task-list','--run',plan.run,'--ready','--json']));
  const {selected,held}=selectReady(tasks,all,ready,limit);
  const launches=selected.map(item=>({item,args:dispatchArgs(state.config,item.role,{...item,run:plan.run})}));
  if (dryRun) return {runId:plan.run,launches:launches.map(x=>({taskId:x.item.task,args:x.args})),held};
  // Start independent ready work together; receipt updates stay synchronous and ordered.
  const results=await Promise.all(launches.map(async({item,args})=>{
    let result;
    try { requireActive(id); result=await runOrcaAsync(command,args); }
    catch(error) { return {taskId:item.task,exitCode:1,error:error.message}; }
    const row={taskId:item.task,role:item.role,exitCode:result.status ?? 1,stdout:result.stdout,stderr:result.stderr};
    try {
      if (result.status!==0) throw new Error('Orca 啟動未確認成功；不得重試');
      const receipt=JSON.parse(result.stdout);
      if (!receipt.ok || !(receipt.result?.dispatchId) || !(receipt.result?.taskId)) throw new Error('派工收據缺少必要識別碼；不得重試');
      if (receipt.result.taskId!==item.task || receipt.result.runId && receipt.result.runId!==plan.run) throw new Error('派工收據的 Task／Run 不符，保留收據，不得重試');
      recordDispatch(id,receipt,item.role,plan.run);
    } catch(error) {
      row.exitCode=1; row.error=error.message;
      try { row.receiptBackup=saveDispatchReceipt(id,item.role,plan.run,result.stdout); }
      catch(backupError) { row.backupError=backupError.message; }
    }
    return row;
  }));
  return {runId:plan.run,results,held,next:'已啟動的工作仍由 Orca 監督；依各收據處理後結束本輪。收到事件再單次檢查就緒工作，不輪詢、不重送失敗或結果未知的派工。'};
}
