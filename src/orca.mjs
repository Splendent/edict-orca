import { spawnSync } from 'node:child_process';
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
  if (worktree.startsWith('new-') && (!options.repo || !options.name)) throw new Error('新工作樹必須提供 --repo 與 --name');
  if (!worktree.startsWith('new-') && (options.repo || options.name || options['base-branch'])) throw new Error('--repo、--name、--base-branch 只能用於新工作樹');
  const item = config.roles[role];
  const args = ['orchestration', 'worker-start', '--spec-file', '-', '--worktree', worktree, '--agent', item.agent, '--task-title', options.title || `Edict ${ROLES[role].name}`, '--json'];
  for (const key of ['model', 'effort']) if (item[key]) args.push(`--${key}`, item[key]);
  for (const key of ['run', 'repo', 'name', 'base-branch']) if (options[key]) args.push(`--${key}`, options[key]);
  return args;
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
