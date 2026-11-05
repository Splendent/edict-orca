import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { updateInstallation, releaseCatalog } from '../src/update.mjs';
import { ROOT, activate, deactivate, recordDispatch, sessionFile } from '../src/session.mjs';
import { defaults } from '../src/config.mjs';

const official = 'https://github.com/Splendent/edict-orca.git';
const documents = ['SKILL.md', 'references/active.md', 'references/scheduling.md', 'references/workflow.md'];
const published = tag => ({ tag_name: tag, draft: false, prerelease: tag.includes('-'), published_at: '2026-11-04T00:00:00Z' });
const catalog = rows => async () => new Response(JSON.stringify(rows), { status: 200 });

function fixture(t, { current = '0.3.0-beta.1', next = '0.3.0-beta.2', rewrite = false, mismatch = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'edict update '));
  const seed = path.join(root, 'seed'), bare = path.join(root, 'remote.git'), install = path.join(root, 'installed code');
  const oldConfig = process.env.GIT_CONFIG_GLOBAL, oldSystem = process.env.GIT_CONFIG_NOSYSTEM, oldHome = process.env.EDICT_HOME;
  const globalConfig = path.join(root, 'empty-gitconfig'); fs.writeFileSync(globalConfig, '');
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1', EDICT_HOME: path.join(root, 'conversation-state') });
  t.after(() => {
    for (const [key, value] of Object.entries({ GIT_CONFIG_GLOBAL: oldConfig, GIT_CONFIG_NOSYSTEM: oldSystem, EDICT_HOME: oldHome })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  function git(dir, args) {
    const p = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env: process.env });
    assert.equal(p.status, 0, p.stderr);
    return p.stdout.trim();
  }
  fs.mkdirSync(seed);
  git(seed, ['init', '-b', 'main']);
  git(seed, ['config', 'user.name', 'Edict test']);
  git(seed, ['config', 'user.email', 'test@example.invalid']);
  git(seed, ['config', 'commit.gpgsign', 'false']);
  git(seed, ['config', 'core.autocrlf', 'false']);
  for (const name of ['src', 'bin', 'skills']) fs.cpSync(path.join(ROOT, name), path.join(seed, name), { recursive: true });
  function content(v) {
    fs.writeFileSync(path.join(seed, 'package.json'), JSON.stringify({ name: 'edict-orca', version: v, type: 'module' }));
    fs.writeFileSync(path.join(seed, 'marker.txt'), v);
    for (const doc of documents) fs.appendFileSync(path.join(seed, 'skills/edict', doc), `\nTest release ${v}\n`);
  }
  content(current); git(seed, ['add', '.']); git(seed, ['commit', '-m', 'Initial fixture']);
  git(seed, ['tag', `v${current}`]);
  git(root, ['init', '--bare', bare]);
  git(seed, ['remote', 'add', 'fixture', bare]);
  git(seed, ['push', 'fixture', 'main', '--tags']);
  git(root, ['clone', '--branch', `v${current}`, bare, install]);
  git(install, ['config', 'remote.origin.url', official]);
  git(install, ['config', `url.${pathToFileURL(bare).href}.insteadOf`, official]);
  const before = git(install, ['rev-parse', 'HEAD']);
  if (rewrite) git(seed, ['checkout', '--orphan', 'rewritten-history']);
  content(mismatch ? '0.0.0' : next); git(seed, ['add', '.']); git(seed, ['commit', '-m', 'Published fixture']);
  git(seed, ['tag', `v${next}`]); git(seed, ['push', 'fixture', `refs/tags/v${next}`]);
  const expected = git(seed, ['rev-parse', 'HEAD']);
  function cli(args, rows, env = {}) {
    const script = `globalThis.fetch=async()=>new Response(${JSON.stringify(JSON.stringify(rows))});process.argv=['node',${JSON.stringify(path.join(install, 'bin/edict.mjs'))},...${JSON.stringify(args)}];await import(${JSON.stringify(pathToFileURL(path.join(install, 'bin/edict.mjs')).href)});`;
    return spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: '', EDICT_SESSION_ID: '', ORCA_CLI_COMMAND: '/nonexistent/orca-must-not-run', ...env },
    });
  }
  return { root, install, seed, before, expected, git, cli, rows: [published(`v${next}`), published(`v${current}`)] };
}

test('CLI updates across rewritten history and preserves all conversation state and work', t => {
  const f = fixture(t, { rewrite: true });
  const project = path.join(f.root, 'actual-project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'unfinished.txt'), 'Keep my current work');
  const config=defaults('codex','chosen-model');
  config.positionOverrides.bingbu={executor:{agent:'claude',model:null,effort:null}};
  activate('claude:active', config, project);
  recordDispatch('claude:active', { ok: true, result: { taskId: 'task-running', dispatchId: 'ctx-running', runId: 'run-original' } }, 'bingbu');
  activate('claude:off', defaults(), project); deactivate('claude:off');
  activate('cursor:pending', defaults(), project, { coordinator: 'cursor' });
  const snapshots = ['claude:active', 'claude:off', 'cursor:pending'].map(id => [sessionFile(id), fs.readFileSync(sessionFile(id))]);
  for(const [,raw] of snapshots){const state=JSON.parse(raw);assert.equal(state.version,2);assert.equal(state.config.version,2);}
  const result = f.cli(['update', '--session', 'claude:active'], f.rows);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.updated, true);
  assert.equal(receipt.version, '0.3.0-beta.2');
  assert.equal(receipt.commit, f.expected);
  assert.equal(receipt.session, 'claude:active');
  assert.equal(receipt.active, true);
  assert.equal(receipt.runId, 'run-original');
  assert.equal(receipt.reload.files.length, 4);
  for (const file of receipt.reload.files) assert.match(fs.readFileSync(file, 'utf8'), /Test release 0\.3\.0-beta\.2/);
  for (const [file, raw] of snapshots) assert.deepEqual(fs.readFileSync(file), raw);
  assert.deepEqual(JSON.parse(fs.readFileSync(sessionFile('claude:active'),'utf8')).config.positionOverrides,config.positionOverrides);
  assert.equal(fs.readFileSync(path.join(project, 'unfinished.txt'), 'utf8'), 'Keep my current work');
  assert.equal(f.git(f.install, ['rev-parse', 'HEAD']), f.expected);
  assert.equal(f.git(f.install, ['status', '--porcelain']), '');
  assert.equal(f.git(f.install, ['for-each-ref', '--format=%(refname)', 'refs/edict-update']), '');
});

test('standalone CLI update creates no conversation and up-to-date updates still return reload files', t => {
  const f = fixture(t);
  const result = f.cli(['update'], [published('v0.3.0-beta.1')]);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.updated, false);
  assert.equal(receipt.session, null);
  assert.equal(receipt.active, false);
  assert.equal(receipt.reload.files.length, 4);
  assert.equal(fs.existsSync(process.env.EDICT_HOME), false);
  assert.equal(f.git(f.install, ['rev-parse', 'HEAD']), f.before);
});

test('update refuses tracked and untracked local work before network access', async t => {
  for (const kind of ['tracked', 'untracked']) await t.test(kind, async child => {
    const f = fixture(child);
    const file = path.join(f.install, kind === 'tracked' ? 'marker.txt' : 'notes.txt'); fs.writeFileSync(file, 'Local work');
    let contacted = false;
    await assert.rejects(updateInstallation(f.install, { fetchImpl: async () => { contacted = true; throw new Error('Must not call'); } }), /本機修改或未追蹤/);
    assert.equal(contacted, false);
    assert.equal(fs.readFileSync(file, 'utf8'), 'Local work');
    assert.equal(f.git(f.install, ['rev-parse', 'HEAD']), f.before);
  });
});

test('update rejects a foreign origin and never rewrites remote configuration', async t => {
  const f = fixture(t); f.git(f.install, ['config', 'remote.origin.url', 'https://github.com/example/another-project.git']);
  await assert.rejects(updateInstallation(f.install, { fetchImpl: catalog(f.rows) }), /origin 不是/);
  assert.equal(f.git(f.install, ['config', '--get', 'remote.origin.url']), 'https://github.com/example/another-project.git');
  assert.equal(f.git(f.install, ['rev-parse', 'HEAD']), f.before);
});

test('mismatched release metadata never switches files and cleans its private ref', async t => {
  const f = fixture(t, { mismatch: true });
  await assert.rejects(updateInstallation(f.install, { fetchImpl: catalog(f.rows) }), /tag 與套件版本不符/);
  assert.equal(f.git(f.install, ['rev-parse', 'HEAD']), f.before);
  assert.equal(f.git(f.install, ['for-each-ref', '--format=%(refname)', 'refs/edict-update']), '');
  assert.equal(fs.existsSync(path.join(f.install, '.git', 'edict-update.lock')), false);
});

test('network failures do not switch the installation and allow a later explicit update', async t => {
  const f = fixture(t); let calls = 0;
  await assert.rejects(updateInstallation(f.install, { fetchImpl: async () => { calls++; return new Response('', { status: 503 }); } }), /HTTP 503/);
  assert.equal(calls, 1);
  assert.equal(f.git(f.install, ['rev-parse', 'HEAD']), f.before);
  assert.equal(fs.existsSync(path.join(f.install, '.git', 'edict-update.lock')), false);
  assert.equal((await updateInstallation(f.install, { fetchImpl: catalog(f.rows) })).updated, true);
});

test('preview versions sort numerically and drafts or invalid tags are not installed', async t => {
  const f = fixture(t, { next: '0.3.0-beta.10' });
  const rows = [published('v0.3.0-beta.2'), { ...published('v99.0.0'), draft: true }, published('v1.0.0:bad'), ...f.rows];
  const result = await updateInstallation(f.install, { fetchImpl: catalog(rows) });
  assert.equal(result.version, '0.3.0-beta.10');
  assert.equal(result.commit, f.expected);
});

test('stable installations do not silently enter previews or downgrade', async t => {
  const f = fixture(t, { current: '0.3.0', next: '0.4.0-beta.1' });
  const result = await updateInstallation(f.install, { fetchImpl: catalog([...f.rows, published('v0.2.0')]) });
  assert.equal(result.updated, false);
  assert.equal(result.version, '0.3.0');
  assert.equal(f.git(f.install, ['rev-parse', 'HEAD']), f.before);
});

test('local edits made while querying releases are retained and prevent switching', async t => {
  const f = fixture(t);
  await assert.rejects(updateInstallation(f.install, { fetchImpl: async () => {
    fs.writeFileSync(path.join(f.install, 'marker.txt'), 'Concurrent work');
    return new Response(JSON.stringify(f.rows));
  } }), /本機修改/);
  assert.equal(f.git(f.install, ['rev-parse', 'HEAD']), f.before);
  assert.equal(fs.readFileSync(path.join(f.install, 'marker.txt'), 'utf8'), 'Concurrent work');
});

test('an existing update lock is retained instead of starting another update', async t => {
  const f = fixture(t), lock = path.join(f.install, '.git', 'edict-update.lock'); fs.writeFileSync(lock, 'Another updater');
  await assert.rejects(updateInstallation(f.install, { fetchImpl: catalog(f.rows) }), /更新仍持有鎖/);
  assert.equal(fs.readFileSync(lock, 'utf8'), 'Another updater');
  assert.equal(f.git(f.install, ['rev-parse', 'HEAD']), f.before);
});

test('invalid release responses fail without accepting arbitrary server data', async () => {
  await assert.rejects(releaseCatalog(async () => new Response('{"tag_name":"v9.0.0"}')), /格式不正確/);
});
