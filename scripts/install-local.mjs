#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const root = fileURLToPath(new URL('..', import.meta.url));
try {
  const { values } = parseArgs({ options: { 'bin-dir': { type: 'string' } } });
  const dir = path.resolve(values['bin-dir'] ?? path.join(os.homedir(), '.local', 'bin'));
  const source = path.join(root, 'bin', 'edict.mjs');
  const destination = path.join(dir, process.platform === 'win32' ? 'edict.cmd' : 'edict');
  const windows = `@echo off\r\nnode "${source}" %*\r\n`;
  let existing;
  try { existing = fs.lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    const owned = process.platform === 'win32'
      ? existing.isFile() && fs.readFileSync(destination, 'utf8') === windows
      : existing.isSymbolicLink() && fs.readlinkSync(destination) === source;
    if (!owned) throw new Error(`已有其他指令，未覆寫：${destination}`);
  } else {
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === 'win32') fs.writeFileSync(destination, windows, { flag: 'wx' });
    else { fs.chmodSync(source, 0o755); fs.symlinkSync(source, destination); }
  }
  console.log(`成功：${destination}\n在目標專案執行 edict init。`);
  if (!(process.env.PATH ?? '').split(path.delimiter).includes(dir)) console.log(`請先把 ${dir} 加入 PATH，或使用指令完整路徑。`);
} catch (error) {
  console.error(`失敗：${error.message}`);
  process.exitCode = 1;
}
