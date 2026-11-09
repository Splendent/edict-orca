import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const runId = 'run_196d0722f532';
const session = 'claude:57e189de-7318-4955-92b4-905a5562fa9c';
const liveHome = 'C:/Users/USER/.config/edict-v2';
const cwd = 'C:/Users/USER/orca/workspaces/vampire-web/urchin';
const repo = 'C:/workspace/edict-orca/edict-slot-fix';
const sha = data => createHash('sha256').update(data).digest('hex');

if (process.argv[2] === '--child') {
  const [source, output] = process.argv.slice(3);
  const { NativeRuntime } = await import(pathToFileURL(path.join(source, 'src/native.mjs')));
  const { Workflow } = await import(pathToFileURL(path.join(source, 'src/workflow.mjs')));
  const { main } = await import(pathToFileURL(path.join(source, 'src/cli.mjs')));
  const originalOpen = fs.openSync, originalUnlink = fs.unlinkSync;
  const lockFile = path.resolve(process.env.EDICT_HOME, 'workflow.lock');
  const lockMs = [], queries = [], blockedEffects = [];
  let heldAt;
  fs.openSync = function(file, ...args) {
    const fd = originalOpen.call(this, file, ...args);
    if (path.resolve(String(file)) === lockFile) heldAt = performance.now();
    return fd;
  };
  fs.unlinkSync = function(file, ...args) {
    const result = originalUnlink.call(this, file, ...args);
    if (path.resolve(String(file)) === lockFile && heldAt !== undefined) {
      lockMs.push(performance.now() - heldAt); heldAt = undefined;
    }
    return result;
  };
  const nativeCall = NativeRuntime.prototype.call;
  // The dispatched measuring worker is not the live Run owner. Use an owner
  // fixture only against the private copy; this performs no native takeover.
  NativeRuntime.prototype.identity = () => ({ owner: true });
  NativeRuntime.prototype.call = function(args, input) {
    if (heldAt !== undefined) throw new Error('Native query attempted under workflow.lock');
    if (args[0] !== 'orchestration' || !['run-current', 'run-show', 'worker-show', 'worker-list', 'check'].includes(args[1]) ||
        args[1] === 'check' && !args.includes('--peek')) throw new Error(`Forbidden native effect: ${args.join(' ')}`);
    queries.push(args.slice(0, 2).join(' '));
    return nativeCall.call(this, args, input);
  };
  for (const method of ['start', 'stop', 'rename', 'send', 'open', 'takeover']) {
    NativeRuntime.prototype[method] = () => { blockedEffects.push(method); throw new Error(`Blocked ${method}`); };
  }
  Workflow.prototype.present = () => { blockedEffects.push('present'); return null; };
  const log = console.log;
  console.log = () => {};
  const started = performance.now();
  let exitCode, error;
  try { exitCode = await main(['sync', '--run', runId, '--session', session]); }
  catch (failure) { error = failure.message; exitCode = 1; }
  console.log = log;
  fs.writeFileSync(output, JSON.stringify({ exitCode, error, commandMs: performance.now() - started,
    lockMs, lockTotalMs: lockMs.reduce((a, b) => a + b, 0), lockMaxMs: Math.max(0, ...lockMs), queries, blockedEffects }, null, 2));
  process.exitCode = exitCode;
} else {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'edict-capacity-v2-'));
  const result = { runId, session, cwd, measurements: {}, snapshotSha256: null,
    identity: 'fixed owner fixture on private copy; no native takeover',
    effects: 'present suppressed; native mutation methods blocked; only read-only Orca calls permitted' };
  try {
    const snapshot = path.join(temp, 'snapshot'), baseline = path.join(temp, 'baseline'), trial = path.join(temp, 'trial');
    fs.mkdirSync(snapshot);
    const snapshotBytes = fs.readFileSync(path.join(liveHome, 'workflow.json'));
    result.snapshotSha256 = sha(snapshotBytes);
    fs.writeFileSync(path.join(snapshot, 'workflow.json'), snapshotBytes);
    fs.cpSync(path.join(liveHome, 'sessions'), path.join(snapshot, 'sessions'), { recursive: true });
    fs.mkdirSync(baseline);
    const archive = path.join(temp, 'baseline.tar');
    const archived = spawnSync('git', ['-C', repo, 'archive', '--format=tar', '--output', archive, '441f582'], { encoding: 'utf8' });
    if (archived.status !== 0) throw new Error(archived.stderr || 'Could not export baseline');
    const extracted = spawnSync('tar', ['-xf', archive, '-C', baseline], { encoding: 'utf8' });
    if (extracted.status !== 0) throw new Error(extracted.stderr || 'Could not unpack baseline');
    for (const [label, source] of [['baseline441f582', baseline], ['modified', repo]]) {
      result.measurements[label] = [];
      for (let i = 0; i < 5; i++) {
        // Every invocation starts with exactly the same workflow/session snapshot.
        fs.cpSync(snapshot, trial, { recursive: true, force: true });
        const output = path.join(temp, 'child.json'), started = performance.now();
        const child = spawnSync(process.execPath, [path.join(repo, 'reports/measure-capacity-v2.mjs'), '--child', source, output], {
          cwd, env: { ...process.env, EDICT_HOME: trial }, encoding: 'utf8', timeout: 120000,
        });
        const totalMs = performance.now() - started;
        const row = JSON.parse(fs.readFileSync(output, 'utf8'));
        result.measurements[label].push({ iteration: i + 1, totalMs, ...row });
        console.log(JSON.stringify({ label, iteration: i + 1, totalMs, lockMs: row.lockMs, error: row.error }));
        if (child.status !== 0 || row.exitCode !== 0) throw new Error(row.error || child.stderr || 'sync failed');
      }
    }
    const workflow = await import(pathToFileURL(path.join(repo, 'src/workflow.mjs')));
    const { NativeRuntime } = await import(pathToFileURL(path.join(repo, 'src/native.mjs')));
    const db = JSON.parse(snapshotBytes), runtime = new NativeRuntime();
    let queryCount = 0;
    const call = runtime.capacityEvidence.bind(runtime);
    runtime.capacityEvidence = (...args) => { queryCount++; return call(...args); };
    const cache = path.join(temp, 'capacity-ended');
    const evidence = workflow.prepareCapacityEvidence(db, runId, runtime, cache);
    const accounting = workflow.capacityOperations(db, runId, evidence);
    const summarize = rows => ({ operations: rows.length, members: new Set(rows.map(x => x.memberId)).size,
      executors: new Set(rows.filter(x => x.position === 'executor').map(x => x.memberId)).size });
    result.capacity = Object.values(db.runs).map(run => {
      const before = Object.values(run.operations).filter(x => ['submitted', 'unknown', 'accepted'].includes(x.state));
      return { runId: run.id, before: summarize(before), after: summarize(before.filter(op => accounting.active.includes(op))) };
    });
    result.excluded = accounting.excluded;
    result.firstEvidenceCalls = queryCount;
    queryCount = 0;
    workflow.prepareCapacityEvidence(db, runId, runtime, cache);
    result.secondEvidenceCalls = queryCount;
    result.cacheFiles = fs.readdirSync(cache).length;
    result.success = true;
  } finally {
    // This target is the absolute mkdtemp directory created by this process.
    if (!path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(temp).startsWith('edict-capacity-v2-')) throw new Error('Unexpected cleanup target');
    fs.rmSync(temp, { recursive: true, force: true });
    result.temporaryCopyRemoved = !fs.existsSync(temp);
    fs.writeFileSync(path.join(repo, 'reports/slot-capacity-v2-measurements.json'), JSON.stringify(result, null, 2) + '\n');
  }
}
