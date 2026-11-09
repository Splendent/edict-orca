import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJSON } from '../src/session.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-atomic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, '{"original":true}\n');
  return { dir, file };
}

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
