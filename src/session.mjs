import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateConfig } from './config.mjs';

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
  if (state.version !== 1 || state.session !== id || typeof state.active !== 'boolean') throw new Error(`對話狀態格式不正確：${file}`);
  validateConfig(state.config);
  return state;
}
export function writeSession(state) {
  validateConfig(state.config);
  const file = sessionFile(state.session);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + '.lock';
  const fd = fs.openSync(lock, 'wx', 0o600);
  try {
    const current = readSession(state.session);
    if ((state.revision ?? 0) !== (current?.revision ?? 0)) throw new Error('對話狀態已被另一操作修改；請重新讀取，不得重複派工');
    const next = { ...state, revision: (current?.revision ?? 0) + 1 };
    atomicJSON(file, next);
    Object.assign(state, next);
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export function activate(id, config, project, options = {}) {
  const previous = readSession(id);
  const coordinator = options.coordinator || previous?.coordinator || (id.startsWith('cursor:') ? 'cursor' : null);
  const modeConfirmed = coordinator === 'cursor' && (options.modeConfirmed === true || (previous?.active === true && previous.modeConfirmed === true));
  const active = coordinator !== 'cursor' || modeConfirmed;
  const state = { version: 1, session: id, active, coordinator, modeConfirmed,
    pending: active ? null : 'cursor-custom-mode', project: path.resolve(project), config,
    revision: previous?.revision ?? 0, runId: previous?.runId ?? null, dispatches: previous?.dispatches ?? [], initializedAt: previous?.initializedAt ?? new Date().toISOString() };
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
    `使用者執行 /edict off 後停止套用此模式；off 不取消已派工作，需報告仍執行中的工作。\n`;
}
export function recordDispatch(id, receipt, role, run) {
  const result = receipt.result ?? receipt;
  if (!receipt.ok || !result.dispatchId || !result.taskId) return;
  const state = requireActive(id);
  const runId = result.runId ?? run;
  if (runId) state.runId = runId;
  state.dispatches.push({ role, taskId: result.taskId, dispatchId: result.dispatchId, runId: runId ?? null });
  writeSession(state);
}
