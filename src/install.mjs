import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { ROOT, atomicJSON } from './session.mjs';

export function quote(value, platform = process.platform) {
  if (platform === 'win32') {
    if (/["%!\r\n]/.test(value)) throw new Error('Windows 安裝路徑含不支援的命令字元');
    return `"${value}"`;
  }
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}
function exists(file) { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
export function planInstall(userHome = os.homedir(), binDir, env = process.env) {
  const node = quote(process.execPath);
  const source = path.join(ROOT, 'skills', 'edict');
  const canonical = path.join(userHome, '.agents/skills/edict');
  const links = [
    [canonical, source],
    [path.join(env.CLAUDE_CONFIG_DIR || env.ORCA_CLAUDE_CONFIG_DIR || path.join(userHome, '.claude'), 'skills/edict'), canonical],
    [path.join(userHome, '.cursor/skills/edict'), canonical],
  ];
  const result = { links: [], writes: [] };
  for (const [file, target] of links) {
    const stat = exists(file);
    if (stat && (!stat.isSymbolicLink() || path.resolve(path.dirname(file), fs.readlinkSync(file)) !== path.resolve(target))) throw new Error(`已有其他技能，未覆寫：${file}`);
    if (!stat) result.links.push({ file, target });
  }
  const dir = path.resolve(binDir || path.join(userHome, '.local/bin'));
  const bin = path.join(dir, process.platform === 'win32' ? 'edict.cmd' : 'edict');
  const target = path.join(ROOT, 'bin/edict.mjs');
  const stat = exists(bin);
  if (process.platform === 'win32') {
    const content = `@echo off\r\nnode "${target}" %*\r\n`;
    if (stat && (!stat.isFile() || fs.readFileSync(bin, 'utf8') !== content)) throw new Error(`已有其他指令，未覆寫：${bin}`);
    if (!stat) result.writes.push({ file: bin, content, before: null });
  } else {
    if (stat && (!stat.isSymbolicLink() || fs.readlinkSync(bin) !== target)) throw new Error(`已有其他指令，未覆寫：${bin}`);
    if (!stat) result.links.push({ file: bin, target });
  }
  return result;
}
export function install(userHome, binDir, env) {
  const plan = planInstall(userHome, binDir, env);
  // Refuse conflicts before any writes; preserve unrelated hook entries and settings.
  for (const item of plan.writes) {
    fs.mkdirSync(path.dirname(item.file), { recursive: true });
    if (item.before !== null) {
      const hash = createHash('sha256').update(item.before).digest('hex').slice(0, 16);
      const backup = `${item.file}.edict-backup-${hash}`;
      if (!exists(backup)) fs.writeFileSync(backup, item.before, { flag: 'wx', mode: 0o600 });
    }
    if (item.file.endsWith('.json')) atomicJSON(item.file, JSON.parse(item.content));
    else fs.writeFileSync(item.file, item.content, { flag: 'wx', mode: 0o755 });
  }
  fs.chmodSync(path.join(ROOT, 'bin/edict.mjs'), 0o755);
  for (const item of plan.links) {
    fs.mkdirSync(path.dirname(item.file), { recursive: true });
    fs.symlinkSync(item.target, item.file, process.platform === 'win32' && item.file.endsWith('/edict') ? 'junction' : undefined);
  }
  return plan;
}
