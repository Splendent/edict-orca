#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
function scripts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return scripts(file);
    return entry.isFile() && /\.(?:mjs|cjs|js)$/.test(entry.name) ? [file] : [];
  });
}

const files = ['bin', 'scripts', 'skills/edict/scripts', 'src', 'test'].flatMap(directory => scripts(path.join(root, directory)));
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`成功：${files.length} 個 JavaScript 檔案語法檢查完成。`);
