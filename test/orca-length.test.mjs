import test from 'node:test';
import assert from 'node:assert/strict';
import { windowsCommandLength, preflightOrca, spawnFailure, runOrca, continueArgs, WINDOWS_COMMAND_LIMIT } from '../src/orca.mjs';

test('Windows length counts UTF-16, spaces, quotes, trailing slashes and the NUL', () => {
  assert.equal(windowsCommandLength('orca', ['abc']), 9);
  assert.equal(windowsCommandLength('orca', ['']), 8);
  assert.equal(windowsCommandLength('orca', ['a b']), 11);
  assert.equal(windowsCommandLength('orca', ['a"b']), 12);
  assert.equal(windowsCommandLength('orca', ['a b\\']), 13);
  assert.equal(windowsCommandLength('orca', ['a\\"b']), 14);
  assert.equal(windowsCommandLength('orca', ['😀']), 8);
  assert.equal(preflightOrca('orca', ['x'.repeat(WINDOWS_COMMAND_LIMIT - 6)], 'win32'), WINDOWS_COMMAND_LIMIT);
  assert.throws(() => preflightOrca('orca', ['x'.repeat(WINDOWS_COMMAND_LIMIT)], 'win32'), /檔案路徑/);
  assert.doesNotThrow(() => preflightOrca('orca', ['x'.repeat(40000)], 'linux'));
});

for (const code of ['ENAMETOOLONG', 'E2BIG', 'ENOENT']) {
  test(`spawn ${code} without process identity proves no effects`, () => {
    const error = spawnFailure('orca', ['orchestration', 'send'], { error: { code, message: code }, pid: 0, status: null, signal: null });
    assert.equal(error.code, code);
    assert.equal(error.receipt.error.data.effectsApplied, false);
    assert.equal(error.receipt.error.data.spawn.processStarted, false);
  });
}

test('spawn errors with pid, status, signal or other codes stay unconfirmed', () => {
  for (const overrides of [{ pid: 42 }, { status: 0 }, { status: 1 }, { signal: 'SIGTERM' }, { error: { code: 'ENOBUFS', message: 'buffer exceeded' } }]) {
    const error = spawnFailure('orca', [], { error: { code: 'ENAMETOOLONG', message: 'too long' }, pid: 0, status: null, ...overrides });
    assert.equal(error.receipt, undefined);
  }
});

test('runOrca preserves a real failed-start receipt', () => {
  assert.throws(() => runOrca('edict-nonexistent-executable-489247', []), error =>
    error.code === 'ENOENT' && error.receipt.error.data.effectsApplied === false);
});

test('continuation argv uses the same Windows preflight', () => {
  const args = continueArgs({ dispatchId: 'ctx-test', runId: 'run-test', role: 'bingbu' }, 'x'.repeat(40000));
  assert.throws(() => preflightOrca('orca', args, 'win32'), /過長/);
});
