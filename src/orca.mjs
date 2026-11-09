import { spawn, spawnSync } from 'node:child_process';
import { ROLES } from './roles.mjs';
import { validateConfig } from './config.mjs';
// CreateProcessW allows 32,767 UTF-16 code units including the terminating NUL.
// Reserve space for executable resolution (for example, orca -> an absolute .exe path).
export const WINDOWS_COMMAND_LIMIT = 30000;
export function windowsCommandLength(command, args) {
  const quote = value => {
    const text = String(value);
    if (text && !/[ \t"]/u.test(text)) return text.length;
    return 2 + text.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/u, '$&$&').length;
  };
  return [command, ...args].reduce((length, value) => length + quote(value) + 1, 0);
}
export function preflightOrca(command, args, platform = process.platform) {
  const length = windowsCommandLength(command, args);
  if (platform === 'win32' && length > WINDOWS_COMMAND_LIMIT) {
    const error = new Error(`body 或其他命令列參數過長（${length} UTF-16 單位，安全上限 ${WINDOWS_COMMAND_LIMIT}）；改附檔案路徑，縮短 body；未啟動 Orca`);
    error.code = 'EDICT_ARGV_TOO_LONG';
    throw error;
  }
  return length;
}
export function spawnFailure(command, args, result) {
  const error = new Error(`${command} ${args.slice(0, 2).join(' ')}：${result.error.message}；沒有改用其他 Orca 入口，也沒有重試`);
  error.code = result.error.code;
  const notStarted = ['ENAMETOOLONG', 'E2BIG', 'ENOENT'].includes(error.code) &&
    !result.pid && result.status == null && result.signal == null;
  if (notStarted) error.receipt = { ok: false, error: { code: error.code, message: error.message,
    data: { effectsApplied: false, spawn: { code: error.code, pid: result.pid ?? null, status: result.status ?? null, processStarted: false } } } };
  return error;
}
export function orcaCommand(env = process.env, platform = process.platform) {
  return env.ORCA_CLI_COMMAND || (env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : platform === 'linux' ? 'orca-ide' : 'orca');
}
export function dispatchArgs(config, role, options = {}) {
  validateConfig(config);
  if (!ROLES[role]) throw new Error(`未知角色：${role}`);
  const worktree = options.worktree ?? 'current';
  if (worktree.startsWith('new-') && !['new-child', 'new-top-level'].includes(worktree)) throw new Error(`無效的新工作樹類型：${worktree}`);
  if (worktree === 'new-top-level' && (!options.repo || !options.name)) throw new Error('獨立工作樹必須提供 --repo 與 --name');
  if (!worktree.startsWith('new-') && (options.repo || options.name || options['base-branch'])) throw new Error('--repo、--name、--base-branch 只能用於新工作樹');
  const item = config.roles[role];
  if (options.task && (options.deps || options.parent)) throw new Error('既有 Task 的相依與 parent 已在建立時指定，不能於啟動時覆寫');
  const source = options.task ? ['--task', options.task] : ['--spec-file', '-'];
  const args = ['orchestration', 'worker-start', ...source, '--worktree', worktree, '--agent', item.agent, '--json'];
  if (!options.task) args.push('--task-title', options.title || `Edict ${ROLES[role].name}`);
  for (const key of ['model', 'effort']) if (item[key]) args.push(`--${key}`, item[key]);
  for (const key of ['run', 'repo', 'name', 'base-branch']) if (options[key]) args.push(`--${key}`, options[key]);
  return args;
}
export function dependencies(value) {
  const ids = typeof value === 'string' ? JSON.parse(value) : value ?? [];
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) throw new Error('deps 必須是無重複 Task ID 的 JSON 陣列');
  return ids;
}
export function taskArgs(role, options) {
  if (!ROLES[role]) throw new Error(`未知角色：${role}`);
  if (!options.run) throw new Error('建立 Task 須明確指定 --run');
  const args = ['orchestration','task-create','--spec-file','-','--task-title',options.title || `Edict ${ROLES[role].name}`,'--run',options.run,'--json'];
  if (options.deps !== undefined) args.push('--deps',JSON.stringify(dependencies(options.deps)));
  if (options.parent) args.push('--parent',options.parent);
  return args;
}
export function continueArgs(dispatch, spec, title) {
  return ['orchestration','send','--to',`dispatch:${dispatch.dispatchId}`,'--run',dispatch.runId,'--subject',title || `Edict ${ROLES[dispatch.role].name}續辦`,'--body',spec,'--json'];
}
export function runOrcaAsync(command, args) {
  preflightOrca(command, args);
  return new Promise((resolve,reject) => {
    const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data',text=>{stdout+=text;});
    child.stderr.on('data',text=>{stderr+=text;});
    child.once('error',reject);
    child.once('close',(status,signal)=>resolve({stdout,stderr,status,signal}));
  });
}
export function runOrca(command, args, options = {}) {
  preflightOrca(command, args);
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw spawnFailure(command, args, result);
  return result;
}
export function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.signal) console.error(`Orca 因訊號 ${result.signal} 結束，結果未確認；不得直接重試派工。`);
  return result.status ?? 1;
}
