import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { home, atomicJSON, readJSON } from './session.mjs';

const directory = () => path.join(home(), 'workflow-receipts');
export function saveNativeReceipt(context, outcome, file = path.join(directory(), randomUUID() + '.json')) {
  atomicJSON(file, { version: 1, at: new Date().toISOString(), owner: { pid: process.pid, host: os.hostname() }, ...context, ...outcome });
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
function quarantine(file, reason) {
  try {
    const target = path.join(directory(), 'quarantine');
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    fs.renameSync(file, path.join(target, `${path.basename(file)}.${randomUUID()}.${reason}`));
  } catch { /* Keep the evidence in place if an observer has it open; never replay it. */ }
}
function pendingOwnerDead(owner) {
  if (owner?.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}
export function nativeReceipts(applied = {}) {
  let names;
  try { names = fs.readdirSync(directory()); }
  catch (error) { if (error.code === 'ENOENT') names = []; else throw error; }
  const present = new Set(names);
  // UUIDs are never reused. A marker is only needed while its sidecar still exists.
  for (const id of Object.keys(applied)) if (!present.has(id)) delete applied[id];
  return names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
    const file = path.join(directory(), name);
    if (Object.hasOwn(applied, name)) return [{ file, id: name }];
    let event;
    try { event = readJSON(file); }
    catch (error) {
      if (error.code === 'ENOENT') return [];
      if (error.cause instanceof SyntaxError) { quarantine(file, 'malformed'); return []; }
      throw error;
    }
    if (event?.version !== 1 || !['pending', 'returned', 'error'].includes(event.status) ||
        !['open', 'takeover', 'presentation', 'draft', 'stop', 'start', 'message', 'receipt'].includes(event.kind) ||
        typeof event.session !== 'string' || !event.session || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at)) ||
        ![undefined, 0, 1].includes(event.phase) ||
        event.status === 'error' && typeof event.error?.message !== 'string') {
      quarantine(file, 'malformed'); return [];
    }
    if (event.status === 'pending') {
      // Only a proven dead local process is safe to archive; no-effect is never inferred.
      if (pendingOwnerDead(event.owner)) quarantine(file, 'pending-unconfirmed');
      return [];
    }
    return [{ file, id: name, event }];
  }).sort((a, b) => (a.event?.phase ?? 0) - (b.event?.phase ?? 0) || (a.event?.at ?? '').localeCompare(b.event?.at ?? '') || a.file.localeCompare(b.file));
}
export function acknowledgeNativeReceipts(files) {
  for (const file of files) {
    try { fs.unlinkSync(file); }
    catch { /* The durable main-file marker prevents replay while cleanup is retried. */ }
  }
}
