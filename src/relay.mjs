import fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';

export async function runRelay(workflow, runId, { once = false, interval = 30, log, output = row => console.log(JSON.stringify(row)), signal } = {}) {
  interval = Number(interval);
  if (!Number.isFinite(interval) || interval <= 0 || interval * 1000 > 2147483647) throw new Error('--interval 必須是正數秒，且不超過 2147483.647');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  let fd, manualRequired = false;
  try {
    // Authenticate before opening a user-selected log file.
    workflow.run(runId);
    if (!workflow.runtime.identity(runId).owner) throw new Error('只有原對話 owner 可以執行 relay');
    if (log) fd = fs.openSync(log, 'a', 0o600);
    do {
      if (controller.signal.aborted) break;
      const rows = workflow.relay(runId, { stopped: () => controller.signal.aborted, onResult: row => {
        const entry = { at: new Date().toISOString(), runId, ...row };
        if (fd !== undefined) fs.writeSync(fd, JSON.stringify(entry) + '\n');
        output(entry);
      } });
      manualRequired ||= rows.some(row => row.manualRequired);
      if (once || controller.signal.aborted) break;
      try { await setTimeout(interval * 1000, undefined, { signal: controller.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    } while (!controller.signal.aborted);
    return manualRequired ? 1 : 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    signal?.removeEventListener('abort', stop);
  }
}
