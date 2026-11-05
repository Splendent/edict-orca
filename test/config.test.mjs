import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { defaults, resolveSettings, validateConfig } from '../src/config.mjs';
import { configure } from '../src/configure.mjs';
import { ROLES } from '../src/roles.mjs';

test('v2 defaults contain independent complete settings for every role', () => {
  const config = defaults('claude', 'claude-model', 'high');
  assert.equal(config.version, 2);
  assert.deepEqual(Object.keys(config.roles), Object.keys(ROLES));
  assert.deepEqual(config.positionOverrides, {});
  for (const item of Object.values(config.roles)) {
    assert.deepEqual(item, { agent: 'claude', model: 'claude-model', effort: 'high' });
  }
  config.roles.bingbu.model = 'different';
  assert.equal(config.roles.menxia.model, 'claude-model');
});

test('each position inherits a complete role group across all agents', () => {
  for (const agent of ['claude', 'codex', 'cursor']) {
    const config = defaults(agent, `${agent}-model`, 'high');
    delete config.positionOverrides;
    for (const position of ['head', 'executor']) {
      assert.deepEqual(resolveSettings(config, 'bingbu', position), config.roles.bingbu);
    }
    config.positionOverrides = { bingbu: {} };
    assert.deepEqual(resolveSettings(config, 'bingbu', 'executor'), config.roles.bingbu);
  }
});

test('position overrides replace the entire group without mixing providers', () => {
  const config = defaults('codex', 'codex-model', 'high');
  config.positionOverrides = {
    bingbu: {
      head: { agent: 'cursor', model: 'cursor-model', effort: 'low' },
      executor: { agent: 'claude', model: null, effort: null },
    },
  };
  assert.deepEqual(resolveSettings(config, 'bingbu', 'head'), { agent: 'cursor', model: 'cursor-model', effort: 'low' });
  assert.deepEqual(resolveSettings(config, 'bingbu', 'executor'), { agent: 'claude', model: null, effort: null });
  assert.deepEqual(resolveSettings(config, 'menxia', 'head'), config.roles.menxia);
  delete config.positionOverrides.bingbu.executor;
  assert.deepEqual(resolveSettings(config, 'bingbu', 'executor'), config.roles.bingbu);
});

test('validation and resolution neither normalize nor mutate frozen settings', () => {
  const config = defaults('codex', 'model', 'high');
  config.positionOverrides.bingbu = { executor: { agent: 'claude', model: null, effort: null } };
  const before = structuredClone(config);
  function freeze(value) {
    for (const child of Object.values(value)) if (child && typeof child === 'object') freeze(child);
    return Object.freeze(value);
  }
  freeze(config);
  assert.equal(validateConfig(config), config);
  const resolved = resolveSettings(config, 'bingbu', 'executor');
  resolved.agent = 'cursor';
  assert.deepEqual(config, before);
});

const invalidCases = [
  ['v1', config => { config.version = 1; }],
  ['unknown root field', config => { config.extra = true; }],
  ['missing roles', config => { delete config.roles; }],
  ['roles array', config => { config.roles = []; }],
  ['missing role', config => { delete config.roles.bingbu; }],
  ['unknown role', config => { config.roles.unknown = { agent: 'codex', model: null, effort: null }; }],
  ['unknown agent', config => { config.roles.bingbu.agent = 'other'; }],
  ['unknown setting', config => { config.roles.bingbu.extra = true; }],
  ['missing role model', config => { delete config.roles.bingbu.model; }],
  ['undefined role effort', config => { config.roles.bingbu.effort = undefined; }],
  ['effort without model', config => { config.roles.bingbu.effort = 'high'; }],
  ['blank model', config => { config.roles.bingbu.model = ' '; }],
  ['multiline effort', config => { config.roles.bingbu.model = 'model'; config.roles.bingbu.effort = 'high\nlow'; }],
  ['null overrides', config => { config.positionOverrides = null; }],
  ['overrides array', config => { config.positionOverrides = []; }],
  ['non-record overrides', config => { config.positionOverrides = new Date(0); }],
  ['unknown override role', config => { config.positionOverrides.unknown = {}; }],
  ['null role overrides', config => { config.positionOverrides.bingbu = null; }],
  ['unknown position', config => { config.positionOverrides.bingbu = { root: { agent: 'codex', model: null, effort: null } }; }],
  ['null position', config => { config.positionOverrides.bingbu = { head: null }; }],
  ['partial position', config => { config.positionOverrides.bingbu = { executor: { agent: 'claude' } }; }],
  ['position effort without model', config => { config.positionOverrides.bingbu = { executor: { agent: 'claude', model: null, effort: 'high' } }; }],
];
for (const [name, mutate] of invalidCases) {
  test(`invalid ${name} is rejected without changing input`, () => {
    const config = defaults();
    mutate(config);
    const before = structuredClone(config);
    assert.throws(() => validateConfig(config));
    assert.deepEqual(config, before);
  });
}

test('resolver rejects unknown roles and positions instead of silently inheriting', () => {
  const config = defaults();
  for (const role of ['unknown', 'toString', '__proto__']) {
    assert.throws(() => resolveSettings(config, role, 'head'), /未知角色/);
  }
  for (const position of ['root', '', undefined]) {
    assert.throws(() => resolveSettings(config, 'bingbu', position), /未知職位/);
  }
});

test('noninteractive configure creates v2 and preserves explicit position groups', async () => {
  const initial = await configure(undefined, { yes: true, agent: 'cursor', model: 'cursor-model', effort: 'high' });
  assert.equal(initial.version, 2);
  assert.deepEqual(resolveSettings(initial, 'bingbu', 'head'), { agent: 'cursor', model: 'cursor-model', effort: 'high' });
  initial.positionOverrides.bingbu = { executor: { agent: 'claude', model: null, effort: null } };
  const before = structuredClone(initial);
  const result = await configure(initial, { yes: true });
  assert.deepEqual(result, before);
  result.roles.bingbu.model = 'changed';
  assert.deepEqual(initial, before);
  await assert.rejects(configure(initial, { yes: true, agent: 'codex' }), /已有設定/);
  const old = { ...initial, version: 1 };
  await assert.rejects(configure(old, { yes: true }), /必須為 2/);
});

function interactive(previous, answers) {
  const script = `
import readline from 'node:readline/promises';
import { syncBuiltinESMExports } from 'node:module';
const answers = ${JSON.stringify(answers)}, prompts = [];
let closed = false;
readline.createInterface = () => ({
  question: async prompt => {
    prompts.push(prompt);
    if (!answers.length) throw new Error('Unexpected additional initialization question');
    return answers.shift();
  },
  close: () => { closed = true; },
});
syncBuiltinESMExports();
Object.defineProperty(process.stdin, 'isTTY', { value: true });
Object.defineProperty(process.stdout, 'isTTY', { value: true });
console.log = () => {};
const { configure } = await import(${JSON.stringify(new URL('../src/configure.mjs', import.meta.url).href)});
const config = await configure(${JSON.stringify(previous) ?? 'undefined'}, {});
process.stdout.write(JSON.stringify({ config, prompts, remaining: answers.length, closed }));
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('TTY initialization can choose shared v2 settings without position questions', () => {
  const result = interactive(undefined, ['claude', 'chosen-model', 'high', 'n']);
  assert.deepEqual(result.config, defaults('claude', 'chosen-model', 'high'));
  assert.equal(result.prompts.length, 4);
  assert.equal(result.remaining, 0);
  assert.equal(result.closed, true);
});

test('TTY role edits clear provider-specific settings and preserve position overrides', () => {
  const config = defaults('claude', 'claude-model', 'high');
  config.positionOverrides.bingbu = { executor: { agent: 'codex', model: 'executor-model', effort: 'low' } };
  const answers = ['y'];
  for (const role of Object.keys(ROLES)) answers.push(...(role === 'bingbu' ? ['cursor', ''] : ['', '', '']));
  const result = interactive(config, answers);
  assert.equal(result.remaining, 0);
  assert.equal(result.closed, true);
  assert.deepEqual(result.config.roles.bingbu, { agent: 'cursor', model: null, effort: null });
  assert.deepEqual(result.config.roles.menxia, config.roles.menxia);
  assert.deepEqual(result.config.positionOverrides, config.positionOverrides);
});
