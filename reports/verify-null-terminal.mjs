import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repo = path.resolve(import.meta.dirname, '..');
const runId = 'run_196d0722f532', operationId = '82f6f52f-c6ee-405e-9f11-8ed0c24feb72';
const liveHome = 'C:/Users/USER/.config/edict-v2';
const sha = data => createHash('sha256').update(data).digest('hex');
if (process.argv[2] === '--child') {
  const [source, output] = process.argv.slice(3);
  const { NativeRuntime } = await import(pathToFileURL(path.join(source, 'src/native.mjs')));
  const { Workflow } = await import(pathToFileURL(path.join(source, 'src/workflow.mjs')));
  const { main } = await import(pathToFileURL(path.join(source, 'src/cli.mjs')));
  const nativeCall = NativeRuntime.prototype.call, queries = [], lockMs = [];
  const open = fs.openSync, unlink = fs.unlinkSync;
  const lock = path.resolve(process.env.EDICT_HOME, 'workflow.lock');
  let heldAt;
  fs.openSync = function(file, ...args) {
    const fd = open.call(this, file, ...args);
    if (path.resolve(String(file)) === lock) heldAt = performance.now();
    return fd;
  };
  fs.unlinkSync = function(file, ...args) {
    const result = unlink.call(this, file, ...args);
    if (path.resolve(String(file)) === lock && heldAt !== undefined) {
      lockMs.push(performance.now() - heldAt); heldAt = undefined;
    }
    return result;
  };
  // Owner identity is a fixture on the private copy, never a native takeover.
  NativeRuntime.prototype.identity = () => ({ owner: true });
  NativeRuntime.prototype.call = function(args, input) {
    if (heldAt !== undefined) throw new Error('Native query under workflow.lock');
    if (args[0] !== 'orchestration' || !['worker-show', 'worker-list'].includes(args[1])) {
      throw new Error(`Forbidden native command: ${args.join(' ')}`);
    }
    queries.push(args);
    return nativeCall.call(this, args, input);
  };
  for (const method of ['start', 'stop', 'rename', 'send', 'open', 'takeover']) {
    NativeRuntime.prototype[method] = () => { throw new Error(`Forbidden native mutation: ${method}`); };
  }
  Workflow.prototype.present = () => null;
  const file = path.join(process.env.EDICT_HOME, 'workflow.json');
  const before = JSON.parse(fs.readFileSync(file)).runs[runId];
  if (Object.values(before.operations).some(op => op.stopRequested)) throw new Error('Pending stops in snapshot');
  const log = console.log;
  console.log = () => {};
  const exitCode = await main(['sync', '--run', runId, '--session', before.session]);
  console.log = log;
  const after = JSON.parse(fs.readFileSync(file)).runs[runId];
  fs.writeFileSync(output, JSON.stringify({ exitCode, before: before.operations[operationId].state,
    after: after.operations[operationId].state, evidence: after.operations[operationId].settlementEvidence,
    queries, lockMs, maxLockMs: Math.max(...lockMs), totalLockMs: lockMs.reduce((a, b) => a + b, 0) }, null, 2));
  process.exitCode = exitCode;
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-null-terminal-'));
  const snapshot = path.join(temp, 'snapshot'), baseline = path.join(temp, 'baseline');
  fs.mkdirSync(snapshot); fs.mkdirSync(baseline);
  const liveFile = path.join(liveHome, 'workflow.json'), bytes = fs.readFileSync(liveFile);
  fs.writeFileSync(path.join(snapshot, 'workflow.json'), bytes);
  fs.cpSync(path.join(liveHome, 'sessions'), path.join(snapshot, 'sessions'), { recursive: true });
  const archive = path.join(temp, 'main.tar');
  for (const [command, args] of [['git', ['-C', repo, 'archive', '--output', archive, 'main']],
    ['tar', ['-xf', archive, '-C', baseline]]]) {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  const report = { runId, operationId, temp, executable: process.env.ORCA_CLI_COMMAND,
    snapshotSha256: sha(bytes), safety: 'Private EDICT_HOME, fixture owner, presentation suppressed, native mutations forbidden; real orca.exe reads only', trials: [] };
  for (const [label, source] of [['main', baseline], ['fixed', repo]]) {
    for (let iteration = 1; iteration <= 3; iteration++) {
      const home = path.join(temp, `${label}-${iteration}`), output = home + '.json';
      fs.cpSync(snapshot, home, { recursive: true });
      const result = spawnSync(process.execPath, [import.meta.filename, '--child', source, output], {
        cwd: 'C:/Users/USER/orca/workspaces/vampire-web/urchin',
        env: { ...process.env, EDICT_HOME: home }, encoding: 'utf8', timeout: 120000,
      });
      if (result.status !== 0) throw new Error(result.stderr || result.stdout);
      const trial = { label, iteration, ...JSON.parse(fs.readFileSync(output)) };
      report.trials.push(trial);
      if (trial.before !== 'accepted' || trial.after !== (label === 'main' ? 'accepted' : 'settled')) throw new Error('Unexpected settlement');
      console.log(JSON.stringify({ label, iteration, before: trial.before, after: trial.after, maxLockMs: trial.maxLockMs }));
    }
  }
  report.liveSha256After = sha(fs.readFileSync(liveFile));
  report.liveUnchanged = report.snapshotSha256 === report.liveSha256After;
  fs.writeFileSync(path.join(repo, 'reports/null-terminal-sync.json'), JSON.stringify(report, null, 2) + '\n');
}
