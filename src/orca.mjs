import { spawn, spawnSync } from 'node:child_process';
import { ROLES } from './roles.mjs';
import { validateConfig } from './config.mjs';
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
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command} ${args.slice(0, 2).join(' ')}：${result.error.message}；沒有改用其他 Orca 入口，也沒有重試`);
  return result;
}
export function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.signal) console.error(`Orca 因訊號 ${result.signal} 結束，結果未確認；不得直接重試派工。`);
  return result.status ?? 1;
}
