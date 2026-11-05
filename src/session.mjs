import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './config.mjs';
const validId=value=>typeof value==='string'&&value.trim().length>0;

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export function home(env = process.env) { return env.EDICT_HOME || path.join(os.homedir(), '.config', 'edict'); }
export function sessionId(explicit, env = process.env) {
  const id = explicit || env.EDICT_SESSION_ID || (env.CODEX_THREAD_ID ? `codex:${env.CODEX_THREAD_ID}` : null);
  if (!id || !/^(codex|claude|cursor|conversation):[^\s\x00-\x1f]{1,200}$/u.test(id)) {
    throw new Error('無法辨識目前對話。請使用 init 回傳且保留在本對話的 --session 識別碼，不得以專案或終端機代替。');
  }
  return id;
}
export function atomicJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
export function sessionFile(id) {
  sessionId(id, {});
  return path.join(home(), 'sessions', createHash('sha256').update(id).digest('hex') + '.json');
}
export function readSession(id) {
  const file = sessionFile(id);
  if (!fs.existsSync(file)) return null;
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (state.version !== 2 || state.session !== id || typeof state.active !== 'boolean') throw new Error(`對話狀態格式不正確或不是新版 v2：${file}`);
  validateConfig(state.config);
  return state;
}
function lockSnapshot(lock) {
  try {
    const stat = fs.lstatSync(lock);
    return { stat, text: stat.isFile() ? fs.readFileSync(lock, 'utf8') : '' };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function sameLock(a, b) {
  return a && b && a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino &&
    a.stat.mtimeMs === b.stat.mtimeMs && a.text === b.text;
}
function abandonedLock(snapshot) {
  if (!snapshot.stat.isFile()) return false;
  let owner;
  try { owner = JSON.parse(snapshot.text); } catch { /* Legacy locks may be empty. */ }
  if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0 && owner.host === os.hostname()) {
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  }
  if (owner?.host && owner.host !== os.hostname()) return false;
  // Allow a newly opened file time to receive its owner metadata.
  return Date.now() - snapshot.stat.mtimeMs > 30_000;
}
function acquireLock(lock) {
  const deadline = Date.now() + 500;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let fd;
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) { if (error.code !== 'EEXIST') throw new Error(`無法建立對話鎖檔：${lock}（${error.code}）`); }
    if (fd !== undefined) {
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now(), host: os.hostname(), token: randomUUID() }));
        return { fd, snapshot: lockSnapshot(lock) };
      } catch (error) {
        fs.closeSync(fd);
        throw new Error(`無法寫入對話鎖檔資訊：${lock}（${error.code}）`);
      }
    }
    const snapshot = lockSnapshot(lock);
    if (!snapshot) continue;
    if (abandonedLock(snapshot) && sameLock(snapshot, lockSnapshot(lock))) {
      try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`對話鎖檔仍由其他程序持有或無法確認擁有者：${lock}。已等待 500 毫秒，尚未寫入；請確認持有程序後再操作，勿直接刪除活躍鎖檔。`);
    Atomics.wait(pause, 0, 0, 25);
  }
}
export function writeSession(state) {
  validateConfig(state.config);
  const file = sessionFile(state.session);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + '.lock';
  const held = acquireLock(lock);
  try {
    const current = readSession(state.session);
    if ((state.revision ?? 0) !== (current?.revision ?? 0)) throw new Error('對話狀態已被另一操作修改；請重新讀取，不得重複派工');
    const next = { ...state, revision: (current?.revision ?? 0) + 1 };
    atomicJSON(file, next);
    Object.assign(state, next);
  } finally {
    fs.closeSync(held.fd);
    if (sameLock(held.snapshot, lockSnapshot(lock))) fs.unlinkSync(lock);
  }
}
export function activate(id, config, project, options = {}) {
  const previous = readSession(id);
  const coordinator = options.coordinator || previous?.coordinator || (id.startsWith('cursor:') ? 'cursor' : null);
  const modeConfirmed = coordinator === 'cursor' && (options.modeConfirmed === true || (previous?.active === true && previous.modeConfirmed === true));
  const active = coordinator !== 'cursor' || modeConfirmed;
  const state = { version: 2, session: id, active, coordinator, modeConfirmed,
    pending: active ? null : 'cursor-custom-mode', project: path.resolve(project), config,
    revision: previous?.revision ?? 0, runId: previous?.runId ?? null, dispatches: previous?.dispatches ?? [],
    tasks: previous?.tasks ?? [], continuations: previous?.continuations ?? [], initializedAt: previous?.initializedAt ?? new Date().toISOString() };
  writeSession(state);
  return state;
}
export function deactivate(id) {
  const state = readSession(id);
  if (state) { state.active = false; state.modeConfirmed = false; state.pending = null; writeSession(state); }
  return state;
}
export function requireActive(id) {
  const state = readSession(id);
  if (state?.pending === 'cursor-custom-mode') throw new Error('Cursor 設定已保存，但仍需在本對話選定 Edict Custom Mode 並確認，不能派工');
  if (!state?.active) throw new Error('此對話尚未啟用 Edict；請先在目前對話執行 /edict init');
  return state;
}
export function context(id) {
  const state = readSession(id);
  if (!state?.active) return '';
  const skill = path.join(ROOT, 'skills', 'edict', 'references', 'active.md');
  return `[Edict 對話模式已啟用]\n本次身分：${id}\n` +
    `使用者已在此對話執行 init；後續正常交代工作即使用 Edict，不要求重複命令。一般問答直接回答。此模式由對話中的指令延續，沒有 hook 或背景載入程序。\n` +
    `執行工作前讀取 ${JSON.stringify(skill)}，按規劃→獨立審查→派工→驗收流程，實際通訊使用 Orca。\n` +
    `CLI 每次指定 --session ${JSON.stringify(id)}；不得改用別的對話、專案或終端機ID。設定：${JSON.stringify(state.config.roles)}\n` +
    `目前 Run：${state.runId ?? '尚未建立'}；派工紀錄：${JSON.stringify(state.dispatches)}\n` +
    `Task 索引：${JSON.stringify(state.tasks ?? [])}；續辦收據：${JSON.stringify(state.continuations ?? [])}。任務狀態以 Orca 為準。\n` +
    `使用者執行 /edict off 後停止套用此模式；off 不取消已派工作，需報告仍執行中的工作。\n`;
}
export function recordDispatch(id, receipt, role, run, details = {}) {
  const result = receipt.result ?? receipt;
  if (!receipt.ok || !validId(result.dispatchId) || !validId(result.taskId)) throw new Error('派工收據缺少有效的 Task／Dispatch ID，結果未確認，不得重複派工');
  if (run && result.runId && result.runId!==run) throw new Error('派工收據的 Run 與請求不符，結果未確認，不得重複派工');
  const state = readSession(id);
  if (!state) throw new Error('對話資料不存在，保留原生收據');
  const runId = result.runId ?? run;
  if (!validId(runId)) throw new Error('派工收據缺少 Run 綁定，結果未確認，不得重複派工');
  if (runId) state.runId = runId;
  if (!state.dispatches.some(row=>row.dispatchId===result.dispatchId)) state.dispatches.push({ role, taskId: result.taskId, dispatchId: result.dispatchId, runId: runId ?? null, ...details });
  state.tasks ??= [];
  if (!state.tasks.some(row=>row.taskId===result.taskId)) state.tasks.push({taskId:result.taskId,role,runId:runId ?? null});
  writeSession(state);
}
export function recordTask(id, receipt, role, run) {
  const result=receipt.result ?? receipt;
  const taskId=result.taskId || result.task?.id || result.id;
  if (!receipt.ok || !validId(taskId)||!validId(result.runId||run)) throw new Error('Task 收據缺少有效 ID／Run，請保存原始收據，不得重複建立');
  if (result.runId&&result.runId!==run) throw new Error('Task 收據的 Run 不符，請保存原始收據，不得重複建立');
  const state=readSession(id);
  if (!state) throw new Error('對話資料不存在，保留原生收據');
  state.tasks ??= [];
  if (!state.tasks.some(row=>row.taskId===taskId)) state.tasks.push({taskId,role,runId:result.runId || run});
  writeSession(state);
}
export function recordContinuation(id, receipt, original) {
  if (!receipt.ok) throw new Error('Orca 續辦未確認成功，保留收據，不得重送');
  const result=receipt.result ?? receipt;
  const present=key=>result[key]!==undefined&&result[key]!==null;
  const hasDispatch=present('dispatchId')||present('taskId');
  if (present('messageId')&&!validId(result.messageId)) throw new Error('續辦收據的 message ID 無效，不得重送');
  if (hasDispatch&&(!validId(result.dispatchId)||!validId(result.taskId))) throw new Error('續辦收據的 Task／Dispatch ID 必須同時為有效字串，不得重送');
  if (!validId(result.messageId)&&!hasDispatch) throw new Error('續辦收據缺少有效 message 或 Task／Dispatch ID，不得重送');
  if (present('runId')&&(!validId(result.runId)||result.runId!==original.runId)) throw new Error('續辦收據的 Run 與原 Dispatch 不符，不得重送');
  const state=readSession(id);
  if (!state) throw new Error('對話資料不存在，保留原生收據');
  state.continuations ??= [];
  state.continuations.push({ targetDispatchId:original.dispatchId, role:original.role, runId:original.runId,
    messageId:result.messageId ?? null, dispatchId:result.dispatchId ?? null, taskId:result.taskId ?? null, delivery:result.delivery ?? null });
  if (hasDispatch && !state.dispatches.some(row=>row.dispatchId===result.dispatchId)) {
    state.dispatches.push({role:original.role,runId:result.runId || original.runId,taskId:result.taskId,dispatchId:result.dispatchId,resumedFrom:original.dispatchId});
    state.tasks ??= [];
    if (!state.tasks.some(row=>row.taskId===result.taskId)) state.tasks.push({role:original.role,runId:result.runId || original.runId,taskId:result.taskId});
  }
  writeSession(state);
}
export function taskBinding(state, task, role, run) {
  const binding=(state.tasks ?? []).find(row=>row.taskId===task);
  if (!binding || binding.role!==role || binding.runId!==run) throw new Error('Task 不在本對話同角色／Run 的索引，請使用 Edict task-create 取得正確 Task');
  return binding;
}
export function saveDispatchReceipt(id, role, run, stdout) {
  const file = path.join(home(), 'receipts', `${createHash('sha256').update(id).digest('hex')}-${randomUUID()}.json`);
  atomicJSON(file, { session: id, role, runId: run ?? null, recordedAt: new Date().toISOString(), stdout });
  return file;
}
