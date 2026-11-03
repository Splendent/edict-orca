import fs from 'node:fs';
import { ROLES, AGENTS } from './roles.mjs';
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
