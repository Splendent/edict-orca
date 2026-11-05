import { createInterface } from 'node:readline/promises';
import { ROLES } from './roles.mjs';
import { defaults, validateConfig } from './config.mjs';
export async function configure(previous, options = {}) {
  if (previous !== undefined && previous !== null) {
    validateConfig(previous);
    previous = structuredClone(previous);
  }
  if (options.yes) {
    if (previous && (options.agent || options.model || options.effort)) throw new Error('已有設定；請用 edict config set 調整角色，避免覆寫全部角色');
    return validateConfig(previous ?? defaults(options.agent, options.model ?? null, options.effort ?? null));
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
    return validateConfig(config);
  } finally { rl.close(); }
}
