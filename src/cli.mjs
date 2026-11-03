import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { ROLES, AGENTS, workerSpec } from './roles.mjs';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SKILL_SOURCE = path.join(ROOT, 'skills', 'edict');
const CONFIG = '.edict/config.json';
const MARKER = '.edict-managed.json';
const SKILL_DIRS = ['.agents/skills/edict', '.claude/skills/edict'];

const HELP = `edict — 在目前 Orca 對話使用三省六部流程

edict init                         互動設定專案角色、代理與模型
edict init --yes [--agent codex]   使用工具預設模型，不派工
edict config                      顯示專案設定
edict config set <角色> --agent <claude|codex|cursor> [--model <ID>] [--effort <值>]
edict config set <角色> --clear-model
edict roles                       列出角色
edict doctor                      檢查設定、技能與 Orca 介面／執行狀態
edict dispatch <角色> --spec-file <檔案|-> --run <ID> [--dry-run]

共用選項：--project <目錄>（預設從目前目錄向上尋找 .edict/config.json）
派工選項：--worktree <selector>（預設 current）、--repo <selector>、--name <名稱>
          --base-branch <ref>（新工作樹使用）、--title <標題>
首次任務未建立 Run 可省略 --run，Orca 會使用已綁定的 Run 或建立一個。
模型 ID 直接傳給 Orca；不查詢帳號憑證、不代替使用者選模型。
設定只影響新代理；不修改目前對話模型。`;

function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\0]/.test(value); }
function checkKeys(object, allowed, where) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) throw new Error(`${where} 必須是物件`);
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`${where} 未知設定：${key}`);
}
export function validateConfig(config) {
  checkKeys(config, ['version', 'roles'], 'config');
  if (config.version !== 1) throw new Error('不支援的設定版本，必須為 1');
  checkKeys(config.roles, Object.keys(ROLES), 'roles');
  for (const role of Object.keys(ROLES)) {
    const item = config.roles[role];
    checkKeys(item, ['agent', 'model', 'effort'], role);
    if (!AGENTS.includes(item.agent)) throw new Error(`${role} 的 agent 必須為 claude、codex 或 cursor`);
    for (const key of ['model', 'effort']) {
      if (item[key] !== null && item[key] !== undefined && !nonempty(item[key])) throw new Error(`${role}.${key} 必須是非空字串或 null`);
    }
    if (item.effort && !item.model) throw new Error(`${role} 設定 effort 前必須指定 model`);
  }
  return config;
}
export function defaults(agent = 'codex', model = null, effort = null) {
  return validateConfig({ version: 1, roles: Object.fromEntries(Object.keys(ROLES).map(role => [role, { agent, model, effort }])) });
}
export function projectRoot(start, exact = false) {
  let dir = path.resolve(start);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`不是目錄：${dir}`);
  if (exact) return dir;
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('此專案尚未初始化；請在專案根目錄執行 edict init');
    dir = parent;
  }
}
function loadConfig(project) {
  const file = path.join(project, CONFIG);
  if (!fs.existsSync(file)) throw new Error(`找不到 ${file}；請執行 edict init`);
  return validateConfig(json(file));
}
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function exists(file) {
  try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function inside(project, target) {
  // Reject existing symlink parents so init cannot write outside the project.
  let cursor = target;
  while (cursor !== project) {
    if (exists(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`路徑是符號連結，未寫入：${cursor}`);
    cursor = path.dirname(cursor);
    if (!cursor.startsWith(project + path.sep) && cursor !== project) throw new Error('目標超出專案範圍');
  }
}
function skillFiles() {
  const out = [];
  function walk(dir, prefix = '') {
    for (const name of fs.readdirSync(dir)) {
      const relative = path.join(prefix, name);
      const stat = fs.lstatSync(path.join(dir, name));
      if (stat.isDirectory()) walk(path.join(dir, name), relative);
      else if (stat.isFile()) out.push(relative);
      else throw new Error(`技能來源含不支援的檔案：${relative}`);
    }
  }
  walk(SKILL_SOURCE);
  return out;
}
function preflightInit(project) {
  const files = skillFiles();
  inside(project, path.join(project, CONFIG));
  if (exists(path.join(project, CONFIG))) loadConfig(project);
  for (const relative of SKILL_DIRS) {
    const target = path.join(project, relative);
    inside(project, target);
    if (!exists(target)) continue;
    if (!fs.statSync(target).isDirectory()) throw new Error(`技能位置不是目錄：${target}`);
    const marker = path.join(target, MARKER);
    inside(project, marker);
    if (!exists(marker) || json(marker).package !== 'edict-orca') throw new Error(`已有非 Edict 管理的技能，未覆寫：${target}`);
    const managed = json(marker).files;
    if (!managed || typeof managed !== 'object') throw new Error(`無效的技能安裝記錄：${marker}`);
    for (const name of files) {
      const dest = path.join(target, name);
      inside(project, dest);
      if (exists(dest) && (!fs.lstatSync(dest).isFile() || fs.readFileSync(dest, 'utf8') !== managed[name])) {
        throw new Error(`技能已有本機修改，未覆寫：${dest}`);
      }
    }
  }
  return files;
}
export function initialize(project, config) {
  validateConfig(config);
  const files = preflightInit(project);
  // All collision checks happen before changing any file.
  for (const relative of SKILL_DIRS) {
    const target = path.join(project, relative);
    const contents = {};
    for (const name of files) {
      const content = fs.readFileSync(path.join(SKILL_SOURCE, name), 'utf8');
      fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true });
      fs.writeFileSync(path.join(target, name), content);
      contents[name] = content;
    }
    writeJSON(path.join(target, MARKER), { package: 'edict-orca', version: 1, files: contents });
  }
  writeJSON(path.join(project, CONFIG), config);
}
async function configure(previous, options) {
  if (options.yes) {
    if (previous && (options.agent || options.model || options.effort)) throw new Error('已有設定；請用 edict config set 調整角色，避免覆寫全部角色');
    return previous ?? defaults(options.agent, options.model ?? null, options.effort ?? null);
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('互動初始化需要終端機；自動化請用 edict init --yes');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('模型 ID 請填供應商實際值；留白沿用工具預設。不啟動代理、不改目前對話模型。');
    let config = previous;
    if (!config) {
      const agent = (await rl.question(`共用代理 claude / codex / cursor [${options.agent ?? 'codex'}]：`)).trim() || options.agent || 'codex';
      const model = (await rl.question('共用模型 ID [工具預設]：')).trim() || options.model || null;
      const effort = model ? (await rl.question('推理強度 [工具預設]：')).trim() || options.effort || null : null;
      config = defaults(agent, model, effort);
    } else console.log('已讀取既有設定；未調整的角色會保留。');
    const customize = (await rl.question('逐一設定角色？[y/N]：')).trim().toLowerCase();
    if (['y', 'yes', '是'].includes(customize)) {
      for (const [role, info] of Object.entries(ROLES)) {
        const item = config.roles[role];
        console.log(`\n${info.name} (${role})：${info.duty}`);
        const agent = (await rl.question(`代理 [${item.agent}]：`)).trim() || item.agent;
        const oldModel = agent === item.agent ? item.model : null;
        const modelAnswer = (await rl.question(`模型 [${oldModel ?? '工具預設'}]（- 清除）：`)).trim();
        const model = modelAnswer === '-' ? null : modelAnswer || oldModel;
        const oldEffort = model === item.model && agent === item.agent ? item.effort : null;
        const effortAnswer = model ? (await rl.question(`推理強度 [${oldEffort ?? '工具預設'}]（- 清除）：`)).trim() : '-';
        config.roles[role] = { agent, model, effort: effortAnswer === '-' ? null : effortAnswer || oldEffort };
        validateConfig(config);
      }
    }
    return config;
  } finally { rl.close(); }
}
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
function runOrca(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error) throw new Error(`${command} ${args.slice(0, 2).join(' ')}：${result.error.message}；沒有改用其他 Orca 入口，也沒有重試`);
  return result;
}
function printResult(result) {
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.signal) console.error(`Orca 因訊號 ${result.signal} 結束，結果未確認；不得直接重試派工。`);
  return result.status ?? 1;
}
async function doctor(project) {
  const config = loadConfig(project);
  for (const relative of SKILL_DIRS) {
    const installed = path.join(project, relative, 'SKILL.md');
    if (!fs.existsSync(installed)) throw new Error(`缺少技能：${installed}；請重新執行 edict init`);
  }
  console.log(`成功：設定及專案技能可讀取（${Object.keys(config.roles).length} 個角色）。`);
  const command = orcaCommand();
  const help = runOrca(command, ['orchestration', 'worker-start', '--help']);
  if (help.status !== 0) return printResult(help);
  for (const flag of ['--spec-file', '--agent', '--model', '--effort', '--run', '--worktree']) {
    if (!help.stdout.includes(flag)) throw new Error(`目前 Orca 不支援 ${flag}；請更新 Orca`);
  }
  console.log(`成功：${command} 支援所需派工參數。`);
  const status = runOrca(command, ['status', '--json']);
  if (status.status !== 0) return printResult(status);
  const data = JSON.parse(status.stdout);
  const runtime = data.result?.runtime;
  if (data.ok !== true || runtime?.reachable !== true || runtime.state !== 'ready') throw new Error('Orca 執行環境尚未就緒；請查看 orca status --json');
  console.log(`成功：Orca ${runtime.appVersion ?? ''} 執行環境可連線。模型可用性與帳號登入須由實際派工驗證。`);
  return 0;
}

export async function main(argv) {
  const { values: options, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, yes: { type: 'boolean' }, project: { type: 'string' },
    agent: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string' },
    'clear-model': { type: 'boolean' }, 'clear-effort': { type: 'boolean' },
    'spec-file': { type: 'string' }, 'dry-run': { type: 'boolean' }, run: { type: 'string' },
    worktree: { type: 'string' }, repo: { type: 'string' }, name: { type: 'string' },
    'base-branch': { type: 'string' }, title: { type: 'string' },
  } });
  const [command, sub, role] = positionals;
  if (options.help || !command) { console.log(HELP); return 0; }
  const allowed = {
    init: ['yes', 'project', 'agent', 'model', 'effort'],
    config: ['project', 'agent', 'model', 'effort', 'clear-model', 'clear-effort'],
    roles: [], doctor: ['project'],
    dispatch: ['project', 'spec-file', 'dry-run', 'run', 'worktree', 'repo', 'name', 'base-branch', 'title'],
  };
  if (!allowed[command]) throw new Error(`未知指令：${command}；執行 edict --help`);
  for (const key of Object.keys(options)) if (!allowed[command].includes(key)) throw new Error(`${command} 不接受 --${key}`);
  const maxArgs = { init: 1, config: 3, roles: 1, doctor: 1, dispatch: 2 };
  if (positionals.length > maxArgs[command]) throw new Error('多餘的指令參數；執行 edict --help');
  if (command === 'roles') {
    for (const [key, info] of Object.entries(ROLES)) console.log(`${key}\t${info.name}\t${info.duty}`);
    return 0;
  }
  const project = projectRoot(options.project ?? process.cwd(), command === 'init' || !!options.project);
  if (command === 'init') {
    preflightInit(project);
    const file = path.join(project, CONFIG);
    const previous = fs.existsSync(file) ? loadConfig(project) : null;
    const config = await configure(previous, options);
    initialize(project, config);
    console.log(`成功：${path.join(project, CONFIG)}\n已安裝 .agents/skills/edict 與 .claude/skills/edict（Cursor 也讀取這些目錄）。\n在目前對話說「用 Edict 處理這個需求」。若技能清單尚未更新，請代理直接讀取 .agents/skills/edict/SKILL.md。`);
    return 0;
  }
  if (command === 'config') {
    const config = loadConfig(project);
    if (!sub) {
      if (Object.keys(options).some(key => key !== 'project')) throw new Error('修改角色請用 edict config set <角色>');
      console.log(JSON.stringify(config, null, 2)); return 0;
    }
    if (sub !== 'set' || !ROLES[role]) throw new Error('用法：edict config set <角色> --agent ... --model ...');
    if (options.model && options['clear-model']) throw new Error('--model 不能與 --clear-model 同用');
    if (options.effort && options['clear-effort']) throw new Error('--effort 不能與 --clear-effort 同用');
    if (!Object.keys(options).some(key => key !== 'project')) throw new Error('請指定要修改的 --agent、--model 或 --effort');
    const item = config.roles[role];
    if (options.agent && options.agent !== item.agent) Object.assign(item, { agent: options.agent, model: null, effort: null });
    if (options.model !== undefined) { if (options.model !== item.model) item.effort = null; item.model = options.model; }
    if (options['clear-model']) Object.assign(item, { model: null, effort: null });
    if (options.effort !== undefined) item.effort = options.effort;
    if (options['clear-effort']) item.effort = null;
    validateConfig(config);
    inside(project, path.join(project, CONFIG));
    writeJSON(path.join(project, CONFIG), config);
    console.log(`成功：${ROLES[role].name} 設定為 ${JSON.stringify(item)}。只影響下一次啟動。`);
    return 0;
  }
  if (command === 'doctor') return doctor(project);
  const config = loadConfig(project);
  if (!options['spec-file']) throw new Error('派工必須指定 --spec-file <檔案|->');
  const task = fs.readFileSync(options['spec-file'] === '-' ? 0 : options['spec-file'], 'utf8');
  if (!task.trim()) throw new Error('任務內容不可空白');
  const args = dispatchArgs(config, sub, options);
  const spec = workerSpec(sub, task, project);
  const executable = orcaCommand();
  if (options['dry-run']) {
    console.log(JSON.stringify({ executable, args, cwd: process.cwd(), spec }, null, 2));
    return 0;
  }
  const result = runOrca(executable, args, { input: spec });
  const code = printResult(result);
  if (code !== 0) console.error('派工結果未確認或失敗；保留上方原始回應，讀 Orca recovery-and-cleanup 指南。不得重新執行相同派工。');
  return code;
}
