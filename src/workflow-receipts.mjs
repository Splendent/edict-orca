import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { home, atomicJSON, readJSON } from './session.mjs';

const directory = () => path.join(home(), 'workflow-receipts');
export function saveNativeReceipt(context, outcome, file = path.join(directory(), randomUUID() + '.json')) {
  atomicJSON(file, { version: 1, at: new Date().toISOString(), ...context, ...outcome });
  return file;
}
// The main intent is already committed. Keep a small independent witness before native I/O, then
// durably replace it with the outcome before attempting any further workflow.lock acquisition.
export function nativeWithReceipt(context, invoke) {
  const file = saveNativeReceipt(context, { status: 'pending' });
  let receipt;
  try { receipt = invoke(); }
  catch (error) {
    saveNativeReceipt(context, { status: 'error', error: { message: error.message, code: error.code, receipt: error.receipt ?? null } }, file);
    throw error;
  }
  try { saveNativeReceipt(context, { status: 'returned', receipt }, file); }
  catch (error) { error.receipt = { ok: true, result: receipt }; throw error; }
  return receipt;
}
export function nativeReceipts() {
  let names;
  try { names = fs.readdirSync(directory()); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
    const file = path.join(directory(), name);
    let event;
    try { event = readJSON(file); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    if (event?.version !== 1 || !['pending', 'returned', 'error'].includes(event.status) ||
        typeof event.kind !== 'string' || typeof event.session !== 'string' || !Number.isFinite(Date.parse(event.at)) ||
        ![undefined, 0, 1].includes(event.phase)) throw new Error(`原生收據格式無法確認；保留 ${file}`);
    return event.status === 'pending' ? [] : [{ file, event }];
  }).sort((a, b) => (a.event.phase ?? 0) - (b.event.phase ?? 0) || a.event.at.localeCompare(b.event.at) || a.file.localeCompare(b.file));
}
export function acknowledgeNativeReceipts(files) {
  for (const file of files) {
    try { fs.unlinkSync(file); }
    catch { /* The main commit is durable; retain the receipt for idempotent replay if cleanup fails. */ }
  }
}
