import { ROLES, AGENTS } from './roles.mjs';
const POSITIONS = ['head', 'executor'];
const FIELDS = ['agent', 'model', 'effort'];
function nonempty(value) { return typeof value === 'string' && value.trim().length > 0 && !/[\r\n\0]/.test(value); }
function checkKeys(object, allowed, where) {
  if (!object || typeof object !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(object))) throw new Error(`${where} 必須是物件`);
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`${where} 未知設定：${key}`);
}
function settings(item, where) {
  checkKeys(item, FIELDS, where);
  for (const field of FIELDS) {
    if (!Object.hasOwn(item, field)) throw new Error(`${where} 缺少設定：${field}`);
  }
  if (!AGENTS.includes(item.agent)) throw new Error(`${where} 的 agent 必須為 claude、codex 或 cursor`);
  for (const key of ['model', 'effort']) {
    if (item[key] !== null && !nonempty(item[key])) throw new Error(`${where}.${key} 必須是非空字串或 null`);
  }
  if (item.effort !== null && item.model === null) throw new Error(`${where} 設定 effort 前必須指定 model`);
}
export function validateConfig(config) {
  checkKeys(config, ['version', 'roles', 'positionOverrides'], 'config');
  if (config.version !== 2) throw new Error('不支援的設定版本，必須為 2');
  checkKeys(config.roles, Object.keys(ROLES), 'roles');
  for (const role of Object.keys(ROLES)) {
    if (!Object.hasOwn(config.roles, role)) throw new Error(`roles 缺少角色：${role}`);
    settings(config.roles[role], role);
  }
  if (Object.hasOwn(config, 'positionOverrides')) {
    checkKeys(config.positionOverrides, Object.keys(ROLES), 'positionOverrides');
    for (const [role, overrides] of Object.entries(config.positionOverrides)) {
      checkKeys(overrides, POSITIONS, `positionOverrides.${role}`);
      for (const [position, item] of Object.entries(overrides)) settings(item, `positionOverrides.${role}.${position}`);
    }
  }
  return config;
}
export function resolveSettings(config, role, position) {
  validateConfig(config);
  if (!Object.hasOwn(ROLES, role)) throw new Error(`未知角色：${role}`);
  if (!POSITIONS.includes(position)) throw new Error(`未知職位：${position}`);
  return { ...(config.positionOverrides?.[role]?.[position] ?? config.roles[role]) };
}
export function defaults(agent = 'codex', model = null, effort = null) {
  return validateConfig({ version: 2, roles: Object.fromEntries(Object.keys(ROLES).map(role => [role, { agent, model, effort }])), positionOverrides: {} });
}
