import { orcaCommand, runOrca } from './orca.mjs';
import path from 'node:path';

const validId = value => typeof value === 'string' && value.trim().length > 0;

export class NativeRuntime {
  worktreeRoot(receipt) {
    const id = receipt.effects?.find(x => x.kind === 'worktree')?.id;
    if (typeof id !== 'string' || !id) throw new Error('派工收據缺少工作樹身分；未確認成果位置');
    const data = this.call(['worktree', 'show', '--worktree', `id:${id}`]);
    if (typeof data.worktree?.path !== 'string' || !path.isAbsolute(data.worktree.path)) throw new Error('原生工作樹路徑未確認');
    return data.worktree.path;
  }
  call(args, input) {
    const result = runOrca(orcaCommand(), [...args, '--json', '--full'], input === undefined ? {} : { input });
    let value;
    try { value = JSON.parse(result.stdout); }
    catch { throw new Error(`Orca 回應無法解析；結果未確認，不得重送：${result.stderr || result.stdout}`); }
    if (result.status !== 0 || !value.ok) {
      const error = new Error(`Orca ${args.slice(0, 2).join(' ')} 失敗或未確認：${value.error?.message || result.stderr || JSON.stringify(value)}`);
      error.receipt = value;
      error.code = value.error?.code;
      throw error;
    }
    return value.result;
  }
  currentRun() {
    const data = this.call(['orchestration', 'run-current']);
    return data.run?.id || data.runId || null;
  }
  identity(runId) {
    const current = this.call(['orchestration', 'run-current']).run;
    if (current?.id === runId) return { owner: true };
    if (current?.coordinator_handle) {
      const target = this.call(['orchestration', 'run-show', '--id', runId]).run;
      if (target?.coordinator_handle === current.coordinator_handle && !target.legacy) return { owner: true };
    }
    const data = this.call(['orchestration', 'check', '--peek']);
    if (data.runId !== runId || !data.dispatchId) throw new Error('Orca 未確認目前呼叫者屬於此 Run；不接受自行指定角色或成員身分');
    const detail = this.call(['orchestration', 'worker-show', '--dispatch', data.dispatchId]);
    const dispatch = detail.dispatch;
    if (!dispatch || dispatch.id !== data.dispatchId || dispatch.runId !== runId || dispatch.capabilityRevokedAt || !['pending', 'dispatched'].includes(dispatch.status)) {
      throw new Error('原生 Dispatch 已失效或無法核對身分');
    }
    return { owner: false, dispatchId: dispatch.id };
  }
  open(objective, requestId) {
    const data = this.call(['orchestration', 'run-create', '--objective', objective, '--retry-request', requestId]);
    const id = data.run?.id || data.runId;
    if (!id || this.currentRun() !== id) throw new Error('原生 Run 建立結果未確認；保留收據，不得重新建立');
    return id;
  }
  workers(runId) {
    const workers = [], cursors = new Set(), dispatches = new Set();
    let cursor;
    for (;;) {
      const args = ['orchestration', 'worker-list', '--run', runId];
      if (cursor) args.push('--cursor', cursor);
      const data = this.call(args), page = data?.page;
      if (!Array.isArray(data?.workers) || !page || typeof page.hasMore !== 'boolean' ||
          (page.hasMore ? !validId(page.nextCursor) || !data.workers.length : page.nextCursor != null)) {
        throw new Error('原生 worker-list 分頁格式不明；清單未確認完整，未釋放占用');
      }
      for (const row of data.workers) {
        const state = row?.workerState ?? row?.state;
        if (!row || !validId(row.dispatchId) || row.runId !== runId || !validId(state) || dispatches.has(row.dispatchId)) {
          throw new Error('原生 worker-list 成員格式不明、跨 Run 或重複；清單未確認完整，未釋放占用');
        }
        dispatches.add(row.dispatchId);
        workers.push({ ...row, raw: row, state, status: row.dispatchStatus ?? row.status });
      }
      if (!page.hasMore) return workers;
      if (cursors.has(page.nextCursor)) throw new Error('原生 worker-list cursor 重複；清單未確認完整，未釋放占用');
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }
  dispatch(dispatchId) {
    if (!validId(dispatchId)) throw new Error('缺少有效原生 Dispatch ID');
    const dispatch = this.call(['orchestration', 'worker-show', '--dispatch', dispatchId])?.dispatch;
    if (!dispatch || dispatch.id !== dispatchId || !validId(dispatch.runId) || !validId(dispatch.taskId)) {
      throw new Error('原生 Dispatch 身分或 Run／Task 格式不明；結果仍未確認');
    }
    return dispatch;
  }
  start(runId, settings, spec, options, requestId) {
    const args = ['orchestration', 'worker-start', '--run', runId, '--spec-file', '-', '--worktree', options.worktree || 'current', '--agent', settings.agent, '--task-title', options.title, '--retry-request', requestId];
    if (settings.model) args.push('--model', settings.model);
    if (settings.effort) args.push('--effort', settings.effort);
    if (options.parent) args.push('--parent', options.parent);
    if (options.deps?.length) args.push('--deps', JSON.stringify(options.deps));
    if (options.name) args.push('--name', options.name);
    return this.call(args, spec);
  }
  send(runId, dispatchId, body, requestId) {
    const data = this.call(['orchestration', 'send', '--run', runId, '--to', `dispatch:${dispatchId}`, '--subject', 'Edict 工作交接', '--body', body, '--retry-request', requestId]);
    const normalized = { ...data };
    if (!Object.hasOwn(data, 'messageId') && data.message?.id) normalized.messageId = data.message.id;
    if (!Object.hasOwn(data, 'runId') && data.message?.run_id) normalized.runId = data.message.run_id;
    return normalized;
  }
  stop(dispatchId, requestId) {
    return this.call(['orchestration', 'worker-stop', '--dispatch', dispatchId, '--retry-request', requestId]);
  }
  request(requestId) {
    return this.call(['orchestration', 'request-show', '--request', requestId]);
  }
}
