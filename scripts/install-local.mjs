#!/usr/bin/env node
import os from 'node:os';
import { parseArgs } from 'node:util';
import { install, planInstall } from '../src/install.mjs';
try {
  const { values } = parseArgs({ options: { 'bin-dir': { type: 'string' }, 'user-home': { type: 'string' }, 'dry-run': { type: 'boolean' } } });
  const userHome = values['user-home'] || os.homedir();
  // Isolated home installs must not touch the invoking agent's real config homes.
  const env = values['user-home'] ? {} : process.env;
  if (values['dry-run']) {
    const plan = planInstall(userHome, values['bin-dir'], env);
    console.log(JSON.stringify({ links: plan.links, writes: plan.writes.map(x => x.file) }, null, 2));
  } else {
    install(userHome, values['bin-dir'], env);
    console.log('成功：已安裝 Edict 指令與共用手動技能。沒有啟用任何對話，也不修改代理 hook。\n於目前對話執行 /edict init；Codex 使用 $edict init。\n若技能尚未出現在目前對話清單，可直接請代理讀取已安裝的 SKILL.md。');
  }
} catch (error) { console.error(`失敗：${error.message}`); process.exitCode = 1; }
