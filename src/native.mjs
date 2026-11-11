import { orcaCommand, runOrca, preflightOrca } from './orca.mjs';
import path from 'node:path';

const validId = value => typeof value === 'string' && value.trim().length > 0;
// Selection, approval and confirmation prompts where a bare Enter would choose an option. Matches only block a CR.
const MENU_PATTERNS = [
  /Update available/i, /Press enter to (continue|confirm|select)/i, /^\s*[›❯▶]\s*\d+[.)]\s+\S/u,
  /\((y\/n|Y\/n|y\/N)\)|\[(y\/n|Y\/n|y\/N)\]/, /Do you trust/i, /Would you like to (run|make|apply|allow|proceed)/i,
];
const CONNECTION_CODES = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOENT'];
const hasHandle = (value, handle) => value && typeof value === 'object' &&
  (value.handle === handle || Object.values(value).some(child => hasHandle(child, handle)));

export function sendArgs(runId, dispatchId, body, requestId) {
  return ['orchestration', 'send', '--run', runId, '--to', `dispatch:${dispatchId}`, '--subject', 'Edict 工作交接', '--body', body, '--retry-request', requestId];
}
export function startArgs(runId, settings, options, requestId) {
  const args = ['orchestration', 'worker-start', '--run', runId, '--spec-file', '-', '--worktree', options.worktree || 'current', '--agent', settings.agent, '--task-title', options.title, '--retry-request', requestId];
  if (settings.model) args.push('--model', settings.model);
  if (settings.effort) args.push('--effort', settings.effort);
  if (options.parent) args.push('--parent', options.parent);
  if (options.deps?.length) args.push('--deps', JSON.stringify(options.deps));
  if (options.name) args.push('--name', options.name);
  return args;
}
export const nativeArgs = args => [...args, ...(args[0] === 'orchestration' ? ['--json', '--full'] : ['--json'])];
export const preflightNative = args => preflightOrca(orcaCommand(), nativeArgs(args));

export class NativeRuntime {
  worktreeRoot(receipt) {
    const id = receipt.effects?.find(x => x.kind === 'worktree')?.id;
    if (typeof id !== 'string' || !id) throw new Error('派工收據缺少工作樹身分；未確認成果位置');
    const data = this.call(['worktree', 'show', '--worktree', `id:${id}`]);
    if (typeof data.worktree?.path !== 'string' || !path.isAbsolute(data.worktree.path)) throw new Error('原生工作樹路徑未確認');
    return data.worktree.path;
  }
  call(args, input) {
    let result;
    // nativeFailure marks failures to reach Orca (spawn failure, unparsable response, or a refused/unavailable
    // connection code), so a polling caller can retry them. A semantic ok:false refusal (for example an ended Run)
    // and argv preflight are not marked.
    try { result = runOrca(orcaCommand(), nativeArgs(args), input === undefined ? {} : { input }); }
    catch (error) { if (error?.code !== 'EDICT_ARGV_TOO_LONG') error.nativeFailure = true; throw error; }
    let value;
    try { value = JSON.parse(result.stdout); }
    catch { throw Object.assign(new Error(`Orca 回應無法解析；結果未確認，不得重送：${result.stderr || result.stdout}`), { nativeFailure: true }); }
    if (result.status !== 0 || !value.ok) {
      const error = new Error(`Orca ${args.slice(0, 2).join(' ')} 失敗或未確認：${value.error?.message || result.stderr || JSON.stringify(value)}`);
      error.receipt = value;
      error.code = value.error?.code;
      if (CONNECTION_CODES.includes(error.code) || /unavailable|unreachable|refused/i.test(error.code ?? '')) error.nativeFailure = true;
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
  // run-use rebinds the Run to the calling conversation; Orca then fences the previous coordinator (consumer_fenced)
  // and keeps only this Run bound to the caller.
  takeover(runId, requestId) {
    const data = this.call(['orchestration', 'run-use', '--id', runId, '--retry-request', requestId]);
    const id = data.run?.id || data.runId;
    if (id !== runId || this.currentRun() !== runId) throw new Error('原生 Run 接手結果未確認；保留收據，不得改用其他 Run');
    return data;
  }
  coordinator(runId) {
    const run = this.call(['orchestration', 'run-show', '--id', runId]).run;
    return { handle: run?.coordinator_handle ?? null, consumerGeneration: run?.consumer_generation ?? null };
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
  // Read-only accounting across Runs; this never grants the caller a Run identity.
  capacityEvidence(runId, operation) {
    if (!validId(operation.dispatchId) || !validId(operation.taskId)) return { ended: false, reason: 'missing-identity' };
    const data = this.call(['orchestration', 'worker-show', '--dispatch', operation.dispatchId]);
    const d = data?.dispatch, w = data?.worker, p = data?.projection;
    if (d?.id !== operation.dispatchId || d.runId !== runId || d.taskId !== operation.taskId ||
        !validId(d.assigneeHandle) || w?.dispatchId !== d.id || w.agentTerminalHandle !== d.assigneeHandle ||
        p?.dispatchId !== d.id || p.runId !== runId || p.taskId !== d.taskId) {
      return { ended: false, reason: 'identity-unverified' };
    }
    // Missing is an explicit native terminal observation, not an inference from unverifiable liveness.
    if (data.observation?.status === 'missing' && d.hostScope?.kind === 'local') return { ended: true, reason: 'terminal-missing' };
    if (p.liveness?.verdict === 'exited') return { ended: true, reason: 'execution-exited' };
    if (data.terminalResource?.releaseState === 'released' || data.terminalResource?.ownershipState === 'released') return { ended: true, reason: 'terminal-released' };
    if (['completed', 'succeeded', 'stopped'].includes(w.state) && w.stage === 'settled') return { ended: true, reason: 'execution-settled' };
    return { ended: false, reason: 'execution-unconfirmed' };
  }
  // Read-only stall evidence: a dispatch prompt held unsent in the agent composer (Orca reports it as the UI-only
  // `draft` field of terminal read), the Codex "Update available" startup prompt, and any other selection or
  // approval prompt visible on the rendered screen (Enter there would pick a default option).
  stallEvidence(runId, dispatchId) {
    const data = this.call(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const d = data?.dispatch, w = data?.worker;
    if (d?.id !== dispatchId || d.runId !== runId || !validId(d.assigneeHandle) || w?.dispatchId !== d.id || w.agentTerminalHandle !== d.assigneeHandle) {
      throw new Error('原生 Dispatch、Run 或代理終端身分未確認；未讀取終端');
    }
    const handle = d.assigneeHandle;
    const terminal = this.call(['terminal', 'read', '--terminal', handle, '--limit', '40'])?.terminal;
    if (terminal?.handle !== handle) throw new Error('終端讀取結果的 handle 與 Dispatch 不符');
    const screen = this.call(['terminal', 'read', '--terminal', handle, '--screen'])?.terminal;
    if (screen?.handle !== handle) throw new Error('終端畫面讀取結果的 handle 與 Dispatch 不符');
    const lines = value => Array.isArray(value?.tail) ? value.tail.filter(line => typeof line === 'string') : [];
    const visible = [...lines(terminal), ...lines(screen)];
    return {
      handle, state: w.state ?? null, stage: w.stage ?? null, liveness: data.projection?.liveness?.verdict ?? null,
      // Absent means Orca did not look; only a non-null value proves a human-only wait.
      agentWait: data.observation?.agentWait ?? null,
      terminalStatus: terminal.status ?? null, screenSource: screen.source ?? null,
      draft: typeof terminal.draft === 'string' && terminal.draft.trim() ? terminal.draft : null,
      updatePrompt: visible.some(line => /Update available/i.test(line)),
      menu: lines(screen).find(line => MENU_PATTERNS.some(pattern => pattern.test(line))) ?? null,
    };
  }
  // Re-reads the terminal immediately before sending and sends a bare CR only when the same draft is still held, the
  // worker is live, and no update, selection or approval prompt is visible. The prompt text is never sent again.
  submitDraft(runId, dispatchId, expectedDraft) {
    const now = this.stallEvidence(runId, dispatchId);
    if (now.liveness !== 'live') throw new Error(`送出前 liveness=${now.liveness}；未送出`);
    if (now.draft !== expectedDraft) throw new Error('送出前輸入框內容已改變；未送出');
    if (now.updatePrompt || now.menu || now.agentWait) throw new Error('送出前畫面有更新、選單或待人工回應的提示；未送出');
    this.call(['terminal', 'send', '--terminal', now.handle, '--text', '\r']);
    return { sent: true, handle: now.handle };
  }
  start(runId, settings, spec, options, requestId) {
    const args = startArgs(runId, settings, options, requestId);
    try { return this.call(args, spec); }
    catch (error) {
      // Orca exits non-zero for an unverified start (input accepted, turn start unobserved) while still
      // returning ok:true with the Task/Dispatch pair. That pair is a real receipt: keep it so the member
      // binds and the worker's own Edict calls resolve; the unobserved start stays recorded on the receipt.
      const result = error.receipt?.ok === true ? error.receipt.result : null;
      if (result && validId(result.dispatchId) && validId(result.taskId) && result.runId === runId) return { ...result, startUnverified: true };
      throw error;
    }
  }
  rename(runId, dispatchId, title) {
    const detail = this.call(['orchestration', 'worker-show', '--dispatch', dispatchId]);
    const dispatch = detail.dispatch, worker = detail.worker;
    if (dispatch?.id !== dispatchId || dispatch.runId !== runId || worker?.dispatchId !== dispatchId ||
        !validId(dispatch.assigneeHandle) || worker.agentTerminalHandle !== dispatch.assigneeHandle) {
      throw new Error('分頁所屬 Dispatch、Run 或代理身分未確認；未改名');
    }
    const handle = dispatch.assigneeHandle;
    let inventory = this.call(['terminal', 'list', '--include-visual-layouts']);
    let reveal = null, restoreWarning = null;
    if (!Array.isArray(inventory.visualLayouts) || inventory.truncated !== false) throw new Error('分頁版面未確認；未切換或改名');
    if (!inventory.terminals?.some(row => row.handle === handle)) return { state: 'unavailable', reason: '原生終端清單沒有此代理的可用分頁；保留原派工與啟動方式', handle };
    if (!hasHandle(inventory.visualLayouts, handle)) {
      const source = this.call(['terminal', 'show']).terminal;
      if (!validId(source?.handle) || source.handle === handle) throw new Error('無法確認可返回的呼叫者分頁；未切換');
      try {
        reveal = this.call(['terminal', 'switch', '--terminal', handle]).focus;
        if (reveal?.handle !== handle || reveal.navigated !== true) throw new Error('Orca 未確認代理分頁已顯示；未改名');
        inventory = this.call(['terminal', 'list', '--include-visual-layouts']);
        if (!Array.isArray(inventory.visualLayouts) || !hasHandle(inventory.visualLayouts, handle)) throw new Error('顯示代理後仍未查到分頁版面；未改名');
      } finally {
        try {
          const restored = this.call(['terminal', 'switch', '--terminal', source.handle]).focus;
          if (restored?.handle !== source.handle || restored.navigated !== true) throw new Error('Orca 未確認已返回呼叫者分頁');
        } catch (error) { restoreWarning = error.message; }
      }
    }
    const terminal = inventory.terminals?.find(row => row.handle === handle);
    if (!terminal?.tabId || !terminal.leafId || dispatch.assigneePaneKey !== `${terminal.tabId}:${terminal.leafId}` || inventory.truncated !== false) throw new Error('分頁及共用面板未確認；未改名');
    const shared = inventory.terminals.filter(row => row.tabId === terminal.tabId).length > 1;
    const renamed = shared
      ? this.call(['terminal', 'set-pane-title', '--terminal', handle, '--title', title]).paneTitle
      : this.call(['terminal', 'rename', '--terminal', handle, '--title', title]).rename;
    if (renamed?.handle !== handle || renamed.title !== title || renamed.tabId !== terminal.tabId || shared && renamed.leafId !== terminal.leafId) throw new Error('分頁改名結果未確認；未重新派工');
    return { state: 'applied', target: shared ? 'pane' : 'tab', ...renamed, reveal, restoreWarning };
  }
  send(runId, dispatchId, body, requestId) {
    const data = this.call(sendArgs(runId, dispatchId, body, requestId));
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
