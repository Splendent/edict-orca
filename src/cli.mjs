import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ROLES, workerSpec } from './roles.mjs';
import { defaults, validateConfig } from './config.mjs';
import { configure } from './configure.mjs';
import { dispatchArgs, taskArgs, continueArgs, orcaCommand, runOrca, printResult } from './orca.mjs';
import { ROOT, activate, context, deactivate, readSession, requireActive, sessionId, writeSession, recordDispatch, recordTask, recordContinuation, taskBinding, saveDispatchReceipt } from './session.mjs';
import { dispatchReady } from './schedule.mjs';
export { ROOT, defaults, validateConfig, dispatchArgs, orcaCommand };

const HELP = `Edict：在目前對話手動啟用 Orca 協作

對話命令（Claude／Cursor）：
  /edict init     設定角色與模型並啟用目前對話；之後正常交代工作
  /edict status   顯示此對話啟用狀態、角色模型與 Orca 派工紀錄
  /edict config   查看／修改此對話設定，不影響其他對話
  /edict off      停用此對話；不取消已派工作
  /edict help     顯示說明，不啟用
Codex 原生技能入口為 $edict init（其他子命令同理）。

代理操作 CLI：
  edict init --session <provider:對話識別碼> [--yes] [--agent codex] [--model ID]
  Cursor 協調者：init --coordinator cursor，待使用者選定原生 Custom Mode 後再加 --mode-confirmed
  edict init --session <ID> --yes --import-config <舊版config.json>
  edict status|context|off --session <ID>
  edict config [set <角色> --agent <claude|codex|cursor> --model <ID> --effort <值>] --session <ID>
  edict config set <角色> --clear-model|--clear-effort --session <ID>
  edict dispatch <角色> --spec-file <檔案|-> --session <ID> [--run <ID>] [--dry-run]
  edict task-create <角色> --spec-file <檔案|-> --run <ID> [--deps <JSON陣列>] --session <ID>
  edict dispatch <角色> --task <TaskID> --run <ID> --session <ID>
  edict continue <DispatchID> --spec-file <檔案|-> --session <ID>
  edict dispatch-ready --plan-file <派工JSON> --session <ID> [--concurrency 3] [--dry-run]
  edict doctor --session <ID>
  edict roles
派工選項：--worktree current|<selector>|new-top-level、--repo、--name、--base-branch、--title
init 可用 --project 指定工作專案；不寫入專案技能或設定。
安裝：node scripts/install-local.mjs（每台電腦一次；不啟用對話）
對話狀態保存在使用者目錄；首次 init 可產生獨立對話識別碼，後續須明確沿用。模型只影響新 worker。`;

function print(value) { console.log(JSON.stringify(value, null, 2)); }
function settings(config, role, options) {
  if (!ROLES[role]) throw new Error(`未知角色：${role}`);
  if (options.model !== undefined && options['clear-model']) throw new Error('--model 不能與 --clear-model 同用');
  if (options.effort !== undefined && options['clear-effort']) throw new Error('--effort 不能與 --clear-effort 同用');
  if (!['agent', 'model', 'effort', 'clear-model', 'clear-effort'].some(k => options[k] !== undefined)) throw new Error('請指定要修改的代理、模型或推理強度');
  const item = config.roles[role];
  if (options.agent !== undefined && options.agent !== item.agent) Object.assign(item, { agent: options.agent, model: null, effort: null });
  if (options.model !== undefined) { if (options.model !== item.model) item.effort = null; item.model = options.model; }
  if (options['clear-model']) Object.assign(item, { model: null, effort: null });
  if (options.effort !== undefined) item.effort = options.effort;
  if (options['clear-effort']) item.effort = null;
  return validateConfig(config);
}
async function doctor(id) {
  const state = readSession(id);
  console.log(`對話：${id}；Edict：${state?.active ? '已啟用' : '未啟用'}`);
  const command = orcaCommand();
  const help = runOrca(command, ['orchestration', 'worker-start', '--help']);
  if (help.status !== 0) return printResult(help);
  for (const flag of ['--spec-file', '--agent', '--model', '--effort', '--run', '--worktree']) {
    if (!help.stdout.includes(flag)) throw new Error(`目前 Orca 不支援 ${flag}`);
  }
  const status = runOrca(command, ['status', '--json']);
  if (status.status !== 0) return printResult(status);
  const data = JSON.parse(status.stdout);
  if (data.ok !== true || data.result?.runtime?.reachable !== true || data.result.runtime.state !== 'ready') throw new Error('Orca 執行環境尚未就緒');
  console.log('成功：Orca 可連線且支援派工參數。模型與帳號仍須實際派工驗證。');
  return 0;
}

export async function main(argv) {
  const { values: options, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, yes: { type: 'boolean' }, session: { type: 'string' }, project: { type: 'string' },
    coordinator: { type: 'string' }, 'mode-confirmed': { type: 'boolean' },
    agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    'clear-model': { type: 'boolean' }, 'clear-effort': { type: 'boolean' }, 'import-config': { type: 'string' },
    'spec-file': { type: 'string' }, 'dry-run': { type: 'boolean' }, run: { type: 'string' },
    task: { type: 'string' }, deps: { type: 'string' }, parent: { type: 'string' },
    'plan-file': { type: 'string' }, concurrency: { type: 'string' },
    worktree: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' },
    'base-branch': { type: 'string' }, title: { type: 'string' },
  } });
  const [command, sub, role] = positionals;
  if (options.help || !command || command === 'help') { console.log(HELP); return 0; }
  const allowed = {
    init: ['yes', 'session', 'project', 'agent', 'model', 'effort', 'import-config', 'coordinator', 'mode-confirmed'],
    config: ['session', 'agent', 'model', 'effort', 'clear-model', 'clear-effort'],
    roles: [], status: ['session'], context: ['session'], off: ['session'], doctor: ['session'],
    dispatch: ['session', 'spec-file', 'task', 'dry-run', 'run', 'worktree', 'repo', 'name', 'base-branch', 'title'],
    'task-create': ['session','spec-file','run','deps','parent','title','dry-run'],
    continue: ['session','spec-file','title','dry-run'],
    'dispatch-ready': ['session','plan-file','concurrency','dry-run'],
  };
  if (!allowed[command]) throw new Error(`未知命令：${command}；執行 edict help`);
  for (const key of Object.keys(options)) if (!allowed[command].includes(key)) throw new Error(`${command} 不接受 --${key}`);
  if (positionals.length > (command === 'config' ? 3 : ['dispatch','task-create','continue'].includes(command) ? 2 : 1)) throw new Error('多餘的命令參數');
  if (command === 'roles') { for (const [key, info] of Object.entries(ROLES)) console.log(`${key}\t${info.name}\t${info.duty}`); return 0; }
  const id = sessionId(options.session || (command === 'init' && !process.env.EDICT_SESSION_ID && !process.env.CODEX_THREAD_ID ? `conversation:${randomUUID()}` : undefined));
  if (command === 'context') { const text = context(id); if (text) console.log(text); return 0; }
  if (command === 'status') { print(readSession(id) ?? { session: id, active: false }); return 0; }
  if (command === 'off') {
    const state = deactivate(id);
    print({ session: id, active: false, dispatches: state?.dispatches ?? [], note: '已停用此對話；未取消已派工作。派工紀錄不是即時狀態，需由 Orca 確認是否仍在執行。' });
    return 0;
  }
  if (command === 'init') {
    if (options.coordinator && !['claude','codex','cursor'].includes(options.coordinator)) throw new Error('coordinator 必須為 claude、codex 或 cursor');
    if (options['mode-confirmed'] && options.coordinator !== 'cursor' && !id.startsWith('cursor:')) throw new Error('--mode-confirmed 僅用於 Cursor 的原生模式確認');
    const previous = readSession(id);
    let imported;
    if (options['import-config']) {
      if (previous) throw new Error('匯入舊設定僅限對話首次 init 前；此對話已有設定。請用 edict config set <角色> --session <本對話ID> --agent <代理> --model <模型ID> 逐角色調整，避免覆寫');
      imported = validateConfig(JSON.parse(fs.readFileSync(options['import-config'], 'utf8')));
    }
    const project = path.resolve(options.project ?? previous?.project ?? process.cwd());
    if (!fs.statSync(project).isDirectory()) throw new Error(`不是工作目錄：${project}`);
    const config = await configure(previous?.config ?? imported, options);
    const state = activate(id, config, project, { coordinator: options.coordinator, modeConfirmed: options['mode-confirmed'] });
    print({ ...state, note: state.active ? '目前對話已啟用 Edict。接下來直接交代工作，不需每次加命令；其他對話未改動。' : '設定已保存，但尚未啟用。請在 Cursor 原生介面把 Edict 選為此對話的 Custom Mode，確認輸入框顯示模式標記後再完成 init。Orca 的 Cursor CLI 是否支援此介面尚未確認，不可宣稱已啟用。' });
    return 0;
  }
  if (command === 'config') {
    const state = readSession(id);
    if (!state) throw new Error('此對話沒有角色設定，請執行 /edict init');
    if (!sub) {
      if (Object.keys(options).some(k => k !== 'session')) throw new Error('修改設定請用 config set <角色>');
      print(state.config); return 0;
    }
    if (sub !== 'set') throw new Error('用法：edict config set <角色> --agent ... --model ...');
    state.config = settings(state.config, role, options);
    writeSession(state);
    print({ session: id, active: state.active, role, ...state.config.roles[role], note: '僅影響此對話下一次啟動的 worker，不更換執行中的模型。' });
    return 0;
  }
  if (command === 'doctor') return doctor(id);
  const state = requireActive(id);
  if (command === 'dispatch-ready') {
    if (!options['plan-file']) throw new Error('須指定 --plan-file <派工JSON>');
    const output=await dispatchReady(id,JSON.parse(fs.readFileSync(options['plan-file'],'utf8')),options.concurrency===undefined?3:Number(options.concurrency),options['dry-run']);
    print(output);
    return output.results?.some(row=>row.exitCode!==0)?1:0;
  }
  if (!!options.task === !!options['spec-file']) throw new Error('須擇一指定 --spec-file <檔案|-> 或 --task <TaskID>');
  const task = options['spec-file'] ? fs.readFileSync(options['spec-file'] === '-' ? 0 : options['spec-file'], 'utf8') : null;
  if (task!==null && !task.trim()) throw new Error('任務內容不可空白');
  const executable = orcaCommand();
  if (command === 'task-create') {
    const args=taskArgs(sub,options), spec=workerSpec(sub,task,state.project);
    if (options['dry-run']) { print({executable,args,spec}); return 0; }
    const result=runOrca(executable,args,{input:spec}), code=printResult(result);
    if (code!==0) { console.error('建立 Task 未確認成功，保留原始回應，不得重複建立。'); return code; }
    try { recordTask(id,JSON.parse(result.stdout),sub,options.run); }
    catch(error) { return receiptFailure(id,sub,options.run,result.stdout,error); }
    return 0;
  }
  if (command === 'continue') {
    const original=state.dispatches.find(row=>row.dispatchId===sub);
    if (!original?.runId) throw new Error('只能續辦本對話已保存且具有 Run ID 的 Dispatch');
    const spec=workerSpec(original.role,task,state.project),args=continueArgs(original,spec,options.title);
    if (options['dry-run']) { print({executable,args}); return 0; }
    const result=runOrca(executable,args),code=printResult(result);
    if (code!==0) { console.error('續辦未確認成功，保留原始回應，不得重送。'); return code; }
    try { recordContinuation(id,JSON.parse(result.stdout),original); }
    catch(error) { return receiptFailure(id,original.role,original.runId,result.stdout,error); }
    return 0;
  }
  const dispatchOptions = { ...options, run: options.run || state.runId || undefined };
  if (options.task) taskBinding(state,options.task,sub,dispatchOptions.run);
  const args = dispatchArgs(state.config, sub, dispatchOptions);
  const spec = options.task ? undefined : workerSpec(sub, task, state.project);
  if (options['dry-run']) { print({ executable, args, cwd: process.cwd(), spec }); return 0; }
  const result = runOrca(executable, args, { input: spec });
  const code = printResult(result);
  if (code !== 0) console.error('派工結果未確認或失敗；保留原始回應並讀 Orca recovery-and-cleanup 指南，不得重新派工。');
  else {
    try {
      const receipt=JSON.parse(result.stdout);
      if (options.task && receipt.result?.taskId!==options.task) throw new Error('派工收據的 Task 與請求不符，結果未確認，不得重複派工');
      recordDispatch(id, receipt, sub, dispatchOptions.run);
    }
    catch (error) { return receiptFailure(id,sub,dispatchOptions.run,result.stdout,error); }
  }
  return code;
}
function receiptFailure(id,role,run,stdout,error) {
  console.error(`Orca 已回覆，但紀錄未保存：${error.message}。保留上方原始收據，不得重複派工。`);
  try { console.error(`收據已另存：${saveDispatchReceipt(id,role,run,stdout)}。請協調者依收據核對 Orca 並補記紀錄。`); }
  catch(backupError) { console.error(`收據備份也失敗：${backupError.message}。請保存 stdout 的原始 Orca 收據。`); }
  return 1;
}
