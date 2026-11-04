import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const RELEASES = 'https://api.github.com/repos/Splendent/edict-orca/releases?per_page=100';
const ORIGIN = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)Splendent\/edict-orca(?:\.git)?\/?$/i;
const DOCUMENTS = ['SKILL.md', 'references/active.md', 'references/scheduling.md', 'references/workflow.md'];

function version(text) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(text);
  if (!match) return null;
  const pre = match[4]?.split('.') ?? [];
  if (pre.some(x => /^\d+$/.test(x) && x.length > 1 && x[0] === '0')) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}
function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1;
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    if (a.pre[i] === undefined || b.pre[i] === undefined) return a.pre[i] === b.pre[i] ? 0 : a.pre[i] === undefined ? -1 : 1;
    if (a.pre[i] === b.pre[i]) continue;
    const an = /^\d+$/.test(a.pre[i]), bn = /^\d+$/.test(b.pre[i]);
    if (an !== bn) return an ? -1 : 1;
    return an ? BigInt(a.pre[i]) > BigInt(b.pre[i]) ? 1 : -1 : a.pre[i] > b.pre[i] ? 1 : -1;
  }
  return 0;
}
function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  });
  if (result.error || result.status !== 0) throw new Error(`Edict 更新的 git ${args[0]} 失敗：${result.error?.message || result.stderr.trim() || result.stdout.trim()}；未自動重試`);
  return result.stdout.trim();
}
function clean(root) {
  if (git(root, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Edict 安裝目錄有本機修改或未追蹤檔案；尚未切換版本。請先保留並處理修改，不會自動 stash、reset 或覆寫。');
}
export async function releaseCatalog(fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(RELEASES, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'edict-orca-updater' },
    signal: AbortSignal.timeout(30_000), redirect: 'error',
  });
  if (!response.ok) throw new Error(`GitHub 發佈清單讀取失敗（HTTP ${response.status}）；未更新安裝`);
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('GitHub 發佈清單格式不正確；未更新安裝');
  return rows;
}
export function reloadManifest(root) {
  const base = path.join(root, 'skills', 'edict');
  const files = DOCUMENTS.map(name => path.join(base, name));
  for (const file of files) if (!fs.statSync(file).isFile()) throw new Error(`更新後指引不是檔案：${file}`);
  return {
    files,
    instruction: '由目前對話的代理重新讀取以上四份檔案，再讀取本對話 context。保留既有識別碼、開關、模型、Run 與未完成工作；不重新 init、不重派或搬動代理。未啟用的對話維持停用。檔案更新成功不等於對話已完成重讀。',
  };
}
export async function updateInstallation(root, { fetchImpl } = {}) {
  root = fs.realpathSync(root);
  const own = fs.statSync(root, { bigint: true });
  const top = fs.statSync(git(root, ['rev-parse', '--show-toplevel']), { bigint: true });
  if (own.dev !== top.dev || own.ino !== top.ino) throw new Error('Edict 須安裝在獨立的 Git clone 根目錄，不能更新工作專案或來源壓縮檔');
  if (!ORIGIN.test(git(root, ['config', '--get', 'remote.origin.url']))) throw new Error('Edict origin 不是 Splendent/edict-orca；未更新，也不修改遠端設定');
  const before = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const current = version(before.version);
  if (before.name !== 'edict-orca' || !current) throw new Error('Edict 套件名稱或版本不正確；未更新');
  clean(root);
  const lockName = git(root, ['rev-parse', '--git-path', 'edict-update.lock']);
  const lock = path.resolve(root, lockName);
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`另一個更新仍持有鎖或上次更新未清理：${lock}；請先確認沒有更新程序，不會自動刪鎖或重試`);
    throw error;
  }
  let ref;
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    const oldHead = git(root, ['rev-parse', 'HEAD']);
    const rows = await releaseCatalog(fetchImpl);
    const candidates = rows.filter(row => !row.draft && row.published_at && typeof row.tag_name === 'string' && row.tag_name.startsWith('v'))
      .map(row => ({ row, parsed: version(row.tag_name.slice(1)) }))
      .filter(x => x.parsed && (current.pre.length || !x.parsed.pre.length && !x.row.prerelease))
      .sort((a, b) => compare(b.parsed, a.parsed));
    if (!candidates.length) throw new Error('找不到適用的已發佈版本；未更新。預覽版可更新到較新的預覽版或正式版，正式版不自動切到預覽版。');
    const target = candidates[0];
    if (compare(target.parsed, current) <= 0) return { updated: false, beforeVersion: before.version, version: before.version, commit: oldHead, reload: reloadManifest(root) };
    ref = `refs/edict-update/${randomUUID()}`;
    git(root, ['fetch', '--no-tags', '--no-recurse-submodules', 'origin', `refs/tags/${target.row.tag_name}:${ref}`]);
    const commit = git(root, ['rev-parse', `${ref}^{commit}`]);
    const next = JSON.parse(git(root, ['show', `${commit}:package.json`]));
    if (next.name !== 'edict-orca' || next.version !== target.row.tag_name.slice(1)) throw new Error('發佈 tag 與套件版本不符；未切換安裝版本');
    for (const name of DOCUMENTS) {
      const file = git(root, ['ls-tree', commit, '--', `skills/edict/${name}`]);
      if (!/^100644 blob /.test(file)) throw new Error(`發佈版本缺少一般指引檔案：${name}；未切換版本`);
    }
    clean(root);
    if (git(root, ['rev-parse', 'HEAD']) !== oldHead) throw new Error('下載期間 Edict 安裝版本被其他操作改動；未切換版本');
    git(root, ['switch', '--detach', commit]);
    return { updated: true, beforeVersion: before.version, version: next.version, tag: target.row.tag_name, commit, reload: reloadManifest(root) };
  } finally {
    if (ref) {
      try { git(root, ['update-ref', '-d', ref]); }
      catch { /* A private fetched ref is harmless; never retry the checkout. */ }
    }
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
