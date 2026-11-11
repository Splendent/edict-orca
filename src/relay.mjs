import fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const message = error => String(error?.message ?? error);

// Each round: settle natively ended operations, forward owner-required messages, then check in-flight Dispatches for
// stalls. A round that fails before any forward is attempted (for example Orca not running: spawnSync orca ENOENT)
// is logged and polling continues; a failure after a forward attempt still ends the relay so nothing is resent.
export async function runRelay(workflow, runId, { once = false, interval = 30, log, unstick = false, output = row => console.log(JSON.stringify(row)), signal } = {}) {
  interval = Number(interval);
  if (!Number.isFinite(interval) || interval <= 0 || interval * 1000 > 2147483647) throw new Error('--interval 必須是正數秒，且不超過 2147483.647');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  let fd, manualRequired = false, roundFailed = false;
  const reportedStallErrors = new Set();
  const emit = row => {
    const entry = { at: new Date().toISOString(), runId, ...row };
    if (fd !== undefined) fs.writeSync(fd, JSON.stringify(entry) + '\n');
    output(entry);
  };
  const roundError = (phase, error) => { roundFailed = true; emit({ type: 'round-error', phase, error: message(error), code: error?.code ?? null, note: '本輪未完成；下一輪依間隔重試，不重送已嘗試的轉送' }); };
  try {
    // Authenticate before opening a user-selected log file.
    workflow.run(runId);
    if (!workflow.runtime.identity(runId).owner) throw new Error('只有原對話 owner 可以執行 relay');
    if (log) fd = fs.openSync(log, 'a', 0o600);
    do {
      if (controller.signal.aborted) break;
      try {
        const settled = workflow.settle(runId);
        if (settled.length) emit({ type: 'settle', settled, note: '原生已結束的操作已標記 settled，釋放派工占用' });
      } catch (error) { roundError('settle', error); }
      if (controller.signal.aborted) break;
      try {
        const rows = workflow.relay(runId, { stopped: () => controller.signal.aborted, onResult: emit });
        manualRequired ||= rows.some(row => row.manualRequired);
      } catch (error) {
        if (error?.relayForwardAttempted) throw error;
        roundError('relay', error);
      }
      if (controller.signal.aborted) break;
      try {
        for (const row of workflow.stalls(runId, { unstick })) {
          if (row.error) {
            const key = `${row.dispatchId}\n${row.error}`;
            if (reportedStallErrors.has(key)) continue;
            reportedStallErrors.add(key);
          } else if (!row.findings.length && !row.unstick) continue;
          emit({ type: 'stall', ...row });
        }
      } catch (error) { roundError('stalls', error); }
      if (once || controller.signal.aborted) break;
      try { await setTimeout(interval * 1000, undefined, { signal: controller.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    } while (!controller.signal.aborted);
    return manualRequired || roundFailed ? 1 : 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    signal?.removeEventListener('abort', stop);
  }
}
