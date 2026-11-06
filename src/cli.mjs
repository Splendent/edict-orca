import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { ROLES, workerSpec } from './roles.mjs';
import { defaults, validateConfig, resolveSettings } from './config.mjs';
import { configure } from './configure.mjs';
import { dispatchArgs, taskArgs, continueArgs, orcaCommand, runOrca, printResult } from './orca.mjs';
import { ROOT, activate, context, deactivate, readSession, requireActive, sessionId, writeSession, recordDispatch, recordTask, recordContinuation, taskBinding, saveDispatchReceipt } from './session.mjs';
import { updateInstallation } from './update.mjs';
import { Workflow, assertWorkflowOwner, setWorkflowEnabled, workflowStatus } from './workflow.mjs';
export { ROOT, defaults, validateConfig, dispatchArgs, orcaCommand };
const PACKAGE = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const HELP = `Edict：手動啟用目前對話的三省六部團隊協作（新版 v2 資料）

對話命令：init、status、config、off、update、help。Codex 使用 $edict；Claude／Cursor 使用 /edict。
init 先完成代理與模型選擇；Cursor 協調者須確認原生模式。安裝不啟用對話。

設定與查詢：
  edict init --yes --session <ID> --agent <claude|codex|cursor> [--model <ID>]
  edict status|context|off --session <ID>
  edict config set <角色> --position head|executor --agent <代理> [--model <ID>] --session <ID>
  edict config set <角色> --position head|executor --inherit --session <ID>
  edict doctor --session <ID>
  edict update [--session <ID>]
  edict --version

原協調者建立 Run 及三省空頭領：
  edict run open --objective <目標> --session <ID>
  edict team ensure <zhongshu|menxia|shangshu> --run <RunID> --spec-file <JSON|-> --session <ID>

頭領與執行代理的工作操作：
  edict work add --run <RunID> --spec-file <JSON|-> --session <ID>
  edict work amend --run <RunID> --work <W-ID> --spec-file <JSON|-> --session <ID>
    （僅原協調者；JSON 為 {generation, resources?, reads?, extraReads?, reason}：resources 整份取代，
     reads／extraReads 只能擴大，writes 不能修訂；清除現有方案與核可）
  edict work plan --run <RunID> --work <W-ID> --spec-file <JSON|-> --session <ID>
  edict work show --run <RunID> --session <ID>
  edict team ensure <角色> --run <RunID> --work <W-ID> --spec-file <JSON|-> --session <ID>
  edict delegate <角色> --run <RunID> --work <W-ID> --spec-file <JSON|-> --session <ID>
  edict work result --run <RunID> --operation <ID> --spec-file <JSON|-> --session <ID>
  edict review record --run <RunID> --work <W-ID> --spec-file <JSON|-> --session <ID>
  edict team send <成員ID> --run <RunID> --work <W-ID> --spec-file <JSON|-> --session <ID>
  edict team forward <交接ID> --run <RunID> --session <ID>
  edict control pause|resume|cancel|restart --run <RunID> [--work <W-ID>] --session <ID>
  edict sync --run <RunID> --session <ID>
  edict recover --run <RunID> --operation <ID> --session <ID>

需求、方案與委派可用 extraReads: [{root: <既有目錄絕對路徑>, reads: [<相對該目錄的路徑>]}] 讀取其他工作樹；寫入只限單一工作樹。
commit、merge 等寫入 git 中繼資料的操作宣告資源 git:<git rev-parse --git-common-dir 的絕對路徑>，同一 repo 互斥。
業務 JSON 必須引用 generation。核可、成果驗收與門下結案分別記錄。
角色與 --member 不是憑證：權限由原生 Run／Dispatch 與團隊綁定確認。
控制關閉新准入；在途操作須核對，取消受理不等於所有程序已停止。
原生三層結構需要 Orca Settings → Orchestration → Nested worker depth 至少 3；不自行改全域設定。
此版本不轉換舊資料，請使用新的對話狀態；不會清除既有資料。
`;

function print(value) { console.log(JSON.stringify(value, null, 2)); }
function settings(config, role, options) {
  if (!ROLES[role]) throw new Error(`未知角色：${role}`);
  if (options.model !== undefined && options['clear-model']) throw new Error('--model 不能與 --clear-model 同用');
  if (options.effort !== undefined && options['clear-effort']) throw new Error('--effort 不能與 --clear-effort 同用');
  if (!['agent', 'model', 'effort', 'clear-model', 'clear-effort', 'inherit'].some(k => options[k] !== undefined)) throw new Error('請指定要修改的代理、模型或推理強度');
  if (options.position && !['head', 'executor'].includes(options.position)) throw new Error('position 必須為 head 或 executor');
  if (options.inherit) {
    if (!options.position || ['agent', 'model', 'effort', 'clear-model', 'clear-effort'].some(k => options[k] !== undefined)) throw new Error('--inherit 必須單獨搭配 --position');
    if (config.positionOverrides?.[role]) delete config.positionOverrides[role][options.position];
    return validateConfig(config);
  }
  const item = options.position ? resolveSettings(config, role, options.position) : config.roles[role];
  if (options.agent !== undefined && options.agent !== item.agent) Object.assign(item, { agent: options.agent, model: null, effort: null });
  if (options.model !== undefined) { if (options.model !== item.model) item.effort = null; item.model = options.model; }
  if (options['clear-model']) Object.assign(item, { model: null, effort: null });
  if (options.effort !== undefined) item.effort = options.effort;
  if (options['clear-effort']) item.effort = null;
  if (options.position) {
    config.positionOverrides ??= {};
    config.positionOverrides[role] ??= {};
    config.positionOverrides[role][options.position] = item;
  }
  return validateConfig(config);
}
async function doctor(id) {
  const state = readSession(id);
  console.log(`${PACKAGE.name} ${PACKAGE.version}；對話：${id}；Edict：${state?.active ? '已啟用' : '未啟用'}`);
  const command = orcaCommand();
  const interfaces = [
    { args: ['orchestration', 'worker-start'], flags: ['--spec-file', '--task', '--task-title', '--agent', '--model', '--effort', '--run', '--worktree', '--repo', '--name', '--base-branch', '--json'] },
    { args: ['orchestration', 'task-create'], flags: ['--spec-file', '--task-title', '--deps', '--parent', '--run', '--json'] },
    { args: ['orchestration', 'task-list'], flags: ['--run', '--ready', '--json'] },
    { args: ['orchestration', 'send'], flags: ['--to', '--run', '--subject', '--body', '--json'] },
    { args: ['orchestration', 'run-create'], flags: ['--objective', '--json'] },
    { args: ['worktree', 'show'], flags: ['--worktree', '--json'] },
  ];
  for (const item of interfaces) {
    const help = runOrca(command, [...item.args, '--help']);
    if (help.status !== 0) return printResult(help);
    const supported = new Set(help.stdout.match(/--[a-z][a-z0-9-]*/g) ?? []);
    for (const flag of item.flags) {
      if (!supported.has(flag)) throw new Error(`目前 Orca 的 ${item.args.join(' ')} 不支援 ${flag}`);
    }
  }
  const status = runOrca(command, ['status', '--json']);
  if (status.status !== 0) return printResult(status);
  const data = JSON.parse(status.stdout);
  if (data.ok !== true || data.result?.runtime?.reachable !== true || data.result.runtime.state !== 'ready') throw new Error('Orca 執行環境尚未就緒');
  console.log('成功：Orca 可連線，基本派工、Task 相依、批次就緒查詢與續辦所需介面齊備。模型與帳號仍須實際派工驗證。');
  return 0;
}

export async function main(argv) {
  const { values: options, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, yes: { type: 'boolean' }, session: { type: 'string' }, project: { type: 'string' },
    version: { type: 'boolean', short: 'V' },
    coordinator: { type: 'string' }, 'mode-confirmed': { type: 'boolean' },
    agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    'clear-model': { type: 'boolean' }, 'clear-effort': { type: 'boolean' }, 'import-config': { type: 'string' },
    'spec-file': { type: 'string' }, 'dry-run': { type: 'boolean' }, run: { type: 'string' },
    task: { type: 'string' }, deps: { type: 'string' }, parent: { type: 'string' },
    'plan-file': { type: 'string' }, concurrency: { type: 'string' },
    worktree: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' },
    'base-branch': { type: 'string' }, title: { type: 'string' },
    work: { type: 'string' }, operation: { type: 'string' }, position: { type: 'string' }, inherit: { type: 'boolean' }, objective: { type: 'string' },
  } });
  const [command, sub, role] = positionals;
  if (options.version) {
    if (positionals.length || Object.keys(options).some(key => key !== 'version')) throw new Error('--version 必須單獨使用');
    console.log(`${PACKAGE.name} ${PACKAGE.version}`);
    return 0;
  }
  if (options.help || !command || command === 'help') { console.log(HELP); return 0; }
  const allowed = {
    init: ['yes', 'session', 'project', 'agent', 'model', 'effort', 'import-config', 'coordinator', 'mode-confirmed'],
    config: ['session', 'agent', 'model', 'effort', 'clear-model', 'clear-effort', 'position', 'inherit'],
    roles: [], status: ['session'], context: ['session'], off: ['session'], doctor: ['session'],
    dispatch: ['session', 'spec-file', 'task', 'dry-run', 'run', 'worktree', 'repo', 'name', 'base-branch', 'title'],
    'task-create': ['session','spec-file','run','deps','parent','title','dry-run'],
    continue: ['session','spec-file','title','dry-run'],
    'dispatch-ready': ['session','plan-file','concurrency','dry-run'],
    update: ['session'],
    run: ['session', 'objective'],
    work: ['session', 'run', 'work', 'spec-file', 'operation'],
    team: ['session', 'run', 'work', 'spec-file'],
    delegate: ['session', 'run', 'work', 'spec-file'],
    review: ['session', 'run', 'work', 'spec-file'],
    control: ['session', 'run', 'work'],
    sync: ['session', 'run'],
    recover: ['session', 'run', 'operation'],
  };
  if (!allowed[command]) throw new Error(`未知命令：${command}；執行 edict help`);
  for (const key of Object.keys(options)) if (!allowed[command].includes(key)) throw new Error(`${command} 不接受 --${key}`);
  if (positionals.length > (['config', 'team'].includes(command) ? 3 : ['dispatch','task-create','continue','run','work','review','control','delegate'].includes(command) ? 2 : 1)) throw new Error('多餘的命令參數');
  if (command === 'roles') { for (const [key, info] of Object.entries(ROLES)) console.log(`${key}\t${info.name}\t${info.duty}`); return 0; }
  if (command === 'update') {
    const supplied = options.session || process.env.EDICT_SESSION_ID || (process.env.CODEX_THREAD_ID ? `codex:${process.env.CODEX_THREAD_ID}` : null);
    const id = supplied ? sessionId(supplied) : null;
    // Validate an explicit conversation before changing installed files; never activate it.
    if (id) readSession(id);
    const result = await updateInstallation(ROOT);
    const state = id ? readSession(id) : null;
    print({ ...result, session: id, active: state?.active ?? false, runId: state?.runId ?? null,
      note: '本機安裝已核對；目前對話尚須完成 reload.files 的重讀。其他對話不會自動啟用；既有代理與工作樹不移動。' });
    return 0;
  }
  const id = sessionId(options.session || (command === 'init' && !process.env.EDICT_SESSION_ID && !process.env.CODEX_THREAD_ID ? `conversation:${randomUUID()}` : undefined));
  if (command === 'context') { const text = context(id); if (text) console.log(text); return 0; }
  if (command === 'status') { const state=readSession(id); print(state ? {...state, workflows:workflowStatus(id)} : { session: id, active: false }); return 0; }
  if (command === 'off') {
    setWorkflowEnabled(id, false);
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
    setWorkflowEnabled(id, true);
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
    assertWorkflowOwner(id);
    state.config = settings(state.config, role, options);
    writeSession(state);
    print({ session: id, active: state.active, role, position: options.position || null, ...(options.position ? resolveSettings(state.config, role, options.position) : state.config.roles[role]), note: '僅影響此對話下一次啟動的 worker，不更換執行中的模型。' });
    return 0;
  }
  if (command === 'doctor') return doctor(id);
  if (['dispatch', 'task-create', 'dispatch-ready', 'continue'].includes(command)) {
    throw new Error('新版不提供免核可派工入口；請使用 run、work、team、delegate、review 與 control，並明確指定 --run');
  }
  const workflow = new Workflow(id);
  if (command === 'run') {
    if (sub !== 'open' || !options.objective) throw new Error('用法：run open --objective <工作目標>');
    print(workflow.open(options.objective)); return 0;
  }
  if (!options.run) throw new Error('必須指定原生 --run；不猜選最近工作');
  function input() {
    if (!options['spec-file']) throw new Error('須指定 --spec-file <JSON檔案|->');
    const raw = fs.readFileSync(options['spec-file'] === '-' ? 0 : options['spec-file'], 'utf8');
    const data = JSON.parse(raw);
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('工作輸入必須是 JSON 物件');
    return data;
  }
  if (command === 'work') {
    if (sub === 'show') { print(workflow.show(options.run)); return 0; }
    if (sub === 'add') { print(workflow.add(options.run, input())); return 0; }
    if (sub === 'plan') {
      if (!options.work) throw new Error('必須指定 --work');
      print(workflow.plan(options.run, options.work, input())); return 0;
    }
    if (sub === 'amend') {
      if (!options.work) throw new Error('必須指定 --work');
      print(workflow.amend(options.run, options.work, input())); return 0;
    }
    if (sub === 'result') {
      if (!options.operation) throw new Error('必須指定 --operation');
      print(workflow.result(options.run, options.operation, input())); return 0;
    }
    throw new Error('work 支援 add、amend、plan、result、show');
  }
  if (command === 'team') {
    if (sub === 'send') { const data=input(); print(workflow.message(options.run, role, options.work, data.body, undefined, data.generation, data.kind || 'handoff')); return 0; }
    if (sub === 'forward') { print(workflow.forward(options.run, role)); return 0; }
    if (sub !== 'ensure' || !role) throw new Error('用法：team ensure <角色> --spec-file <JSON>');
    const result = workflow.launch(options.run, role, 'head', options.work, input());
    print(result); return result.confirmed === false ? 1 : 0;
  }
  if (command === 'delegate') {
    const result = workflow.launch(options.run, sub, 'executor', options.work, input());
    print(result); return result.confirmed === false ? 1 : 0;
  }
  if (command === 'review') {
    if (sub !== 'record' || !options.work) throw new Error('用法：review record --work <ID> --spec-file <JSON>');
    print(workflow.review(options.run, options.work, input())); return 0;
  }
  if (command === 'control') {
    print(workflow.control(options.run, sub, options.work)); return 0;
  }
  if (command === 'sync') { print(workflow.sync(options.run)); return 0; }
  if (command === 'recover') {
    if (!options.operation) throw new Error('必須指定 --operation');
    print(workflow.recover(options.run, options.operation)); return 0;
  }
  throw new Error('未支援的工作操作');
}
