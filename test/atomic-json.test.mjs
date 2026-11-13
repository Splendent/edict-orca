import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJSON, readJSON } from '../src/session.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"original":true}\n');
  return { dir, file };
}

test('atomic backup reuses a validated read of the same file version',t=>{
  const {file}=fixture(t),parse=JSON.parse;let parses=0;
  t.mock.method(JSON,'parse',(...args)=>{parses++;return parse(...args);});
  const value=readJSON(file);value.updated=true;
  atomicJSON(file,value,{keepPrevious:true});
  assert.equal(parses,1);
  assert.deepEqual(readJSON(file+'.prev'),{original:true});
  assert.deepEqual(readJSON(file),{original:true,updated:true});
});

test('validated backup never trusts a file changed since the read',t=>{
  const {file}=fixture(t),value=readJSON(file),original=fs.readFileSync(file,'utf8');
  fs.writeFileSync(file,'x'.repeat(original.length));
  assert.throws(()=>atomicJSON(file,value,{keepPrevious:true}),SyntaxError);
  assert.equal(fs.readFileSync(file,'utf8'),'x'.repeat(original.length));
  assert.equal(fs.existsSync(file+'.prev'),false);
});

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
  test(`atomic JSON retries temporary ${code} and writes compact readable JSON`, t => {
    const { dir, file } = fixture(t), rename = fs.renameSync;
    const value = { text: '狀態', nested: { values: [1, 2] } };
    let attempts = 0;
    t.mock.method(fs, 'renameSync', (from, to) => {
      assert.equal(fs.readFileSync(file, 'utf8'), '{"original":true}\n');
      if (++attempts < 3) throw Object.assign(new Error('temporary contention'), { code });
      return rename(from, to);
    });
    t.mock.method(Atomics, 'wait', () => 'timed-out');
    atomicJSON(file, value);
    assert.equal(attempts, 3);
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(value) + '\n');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), value);
    assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  });

  test(`atomic JSON exhausted ${code} preserves original and temporary files`, t => {
    const { dir, file } = fixture(t), value = { replacement: true };
    let elapsed = 0, attempts = 0;
    const waits = [];
    t.mock.method(performance, 'now', () => elapsed);
    t.mock.method(Atomics, 'wait', (_array, _index, _value, timeout) => {
      waits.push(timeout); elapsed += timeout; return 'timed-out';
    });
    t.mock.method(fs, 'renameSync', () => {
      attempts++; throw Object.assign(new Error('busy target'), { code });
    });
    let failure;
    assert.throws(() => atomicJSON(file, value), error => {
      failure = error;
      return error.code === code && error.message.includes(file) && error.message.includes('暫存檔保留');
    });
    assert.equal(elapsed, 2000);
    assert.equal(attempts, waits.length + 1);
    assert.deepEqual(waits.slice(0, 5), [20, 40, 80, 160, 250]);
    assert.ok(waits.every(x => x > 0 && x <= 250));
    assert.equal(fs.readFileSync(file, 'utf8'), '{"original":true}\n');
    const temp = fs.readdirSync(dir).find(x => x.endsWith('.tmp'));
    assert.ok(temp);
    assert.ok(failure.message.includes(path.join(dir, temp)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, temp), 'utf8')), value);
  });
}

test('atomic JSON does not retry unrelated rename errors and preserves recovery data', t => {
  const { dir, file } = fixture(t);
  const error = Object.assign(new Error('invalid rename'), { code: 'EXDEV' });
  const rename = t.mock.method(fs, 'renameSync', () => { throw error; });
  const wait = t.mock.method(Atomics, 'wait', () => assert.fail('unexpected retry'));
  assert.throws(() => atomicJSON(file, { next: true }), actual => actual === error);
  assert.equal(rename.mock.callCount(), 1);
  assert.equal(wait.mock.callCount(), 0);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"original":true}\n');
  assert.equal(fs.readdirSync(dir).filter(x => x.endsWith('.tmp')).length, 1);
});

test('atomic JSON handles partial writes and syncs and closes before rename', t => {
  const { file } = fixture(t), events = [], descriptors = new Map();
  const open = fs.openSync, write = fs.writeSync, sync = fs.fsyncSync, close = fs.closeSync, rename = fs.renameSync;
  t.mock.method(fs, 'openSync', (...args) => { const fd = open(...args); descriptors.set(fd, args[0]); return fd; });
  t.mock.method(fs, 'writeSync', (fd, data, offset, length) => {
    events.push('write'); return write(fd, data, offset, Math.min(3, length));
  });
  t.mock.method(fs, 'fsyncSync', fd => { events.push(descriptors.get(fd).endsWith('.tmp') ? 'file-sync' : 'directory-sync'); return sync(fd); });
  t.mock.method(fs, 'closeSync', fd => { events.push(descriptors.get(fd).endsWith('.tmp') ? 'file-close' : 'directory-close'); return close(fd); });
  t.mock.method(fs, 'renameSync', (...args) => { events.push('rename'); return rename(...args); });
  atomicJSON(file, { text: '完整狀態' });
  assert.deepEqual(readJSON(file), { text: '完整狀態' });
  const tail = ['file-sync', 'file-close', 'rename'];
  if (process.platform !== 'win32') tail.push('directory-sync', 'directory-close');
  assert.deepEqual(events.slice(-tail.length), tail);
  assert.ok(events.filter(x => x === 'write').length > 1);
});

test('failed file fsync closes and removes temp without renaming or changing original', t => {
  const { dir, file } = fixture(t), error = new Error('sync failed');
  t.mock.method(fs, 'fsyncSync', () => { throw error; });
  const rename = t.mock.method(fs, 'renameSync', () => assert.fail('must not rename unsynced data'));
  assert.throws(() => atomicJSON(file, { next: true }, { keepPrevious: true }), actual => actual === error);
  assert.equal(rename.mock.callCount(), 0);
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  assert.deepEqual(readJSON(file), { original: true });
});

test('supported platforms sync the parent directory after rename', t => {
  const { dir, file } = fixture(t), events = [];
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const open = fs.openSync, sync = fs.fsyncSync, close = fs.closeSync, rename = fs.renameSync;
  const directoryFd = 987654;
  t.mock.method(fs, 'openSync', (...args) => args[0] === dir ? directoryFd : open(...args));
  t.mock.method(fs, 'fsyncSync', fd => { if (fd === directoryFd) events.push('directory-sync'); else sync(fd); });
  t.mock.method(fs, 'closeSync', fd => { if (fd === directoryFd) events.push('directory-close'); else close(fd); });
  t.mock.method(fs, 'renameSync', (...args) => { events.push('rename'); return rename(...args); });
  atomicJSON(file, { next: true });
  assert.deepEqual(events, ['rename', 'directory-sync', 'directory-close']);
});

test('failed main rename leaves existing prev unchanged', t => {
  const { file } = fixture(t);
  atomicJSON(file, { sequence: 1 }, { keepPrevious: true });
  const error = Object.assign(new Error('invalid rename'), { code: 'EXDEV' });
  t.mock.method(fs, 'renameSync', () => { throw error; });
  assert.throws(() => atomicJSON(file, { sequence: 2 }, { keepPrevious: true }), actual => actual === error);
  assert.deepEqual(readJSON(file), { sequence: 1 });
  assert.deepEqual(readJSON(file + '.prev'), { original: true });
});

test('prev rotates only after successful main rename and retains previous valid state', t => {
  const { file } = fixture(t);
  atomicJSON(file, { sequence: 1 }, { keepPrevious: true });
  assert.deepEqual(readJSON(file + '.prev'), { original: true });
  const rename = fs.renameSync;
  let attempts = 0;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) {
      assert.deepEqual(readJSON(file + '.prev'), { original: true });
      if (++attempts === 1) throw Object.assign(new Error('busy'), { code: 'EPERM' });
    } else if (to === file + '.prev') assert.deepEqual(readJSON(file), { sequence: 2 });
    return rename(from, to);
  });
  t.mock.method(Atomics, 'wait', () => 'timed-out');
  atomicJSON(file, { sequence: 2 }, { keepPrevious: true });
  assert.equal(attempts, 2);
  assert.deepEqual(readJSON(file + '.prev'), { sequence: 1 });
});

test('initial write has no prev and corrupt main never replaces usable prev', t => {
  const { file } = fixture(t);
  fs.unlinkSync(file);
  atomicJSON(file, { sequence: 1 }, { keepPrevious: true });
  assert.equal(fs.existsSync(file + '.prev'), false);
  atomicJSON(file, { sequence: 2 }, { keepPrevious: true });
  fs.writeFileSync(file, '\0\0\0');
  assert.throws(() => atomicJSON(file, { sequence: 3 }, { keepPrevious: true }), SyntaxError);
  assert.deepEqual(readJSON(file + '.prev'), { sequence: 1 });
  assert.throws(() => readJSON(file), error => error.message.includes(file + '.prev') && /手動還原.*未覆寫主檔.*未改用 prev/.test(error.message));
  assert.equal(fs.readFileSync(file, 'utf8'), '\0\0\0');
  fs.writeFileSync(file + '.prev', 'broken');
  assert.throws(() => readJSON(file), /沒有可解析的 prev/);
});
