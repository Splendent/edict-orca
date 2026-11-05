import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { home, readSession, requireActive, atomicJSON, writeSession } from './session.mjs';
import { ROLES, workerSpec } from './roles.mjs';
import { resolveSettings } from './config.mjs';
import { geometry, rangeOverlap } from './ranges.mjs';
import { NativeRuntime } from './native.mjs';

const departments = ['hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr'];
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };
const validId = value => typeof value === 'string' && value.trim().length > 0;
const text = (value, label) => typeof value === 'string' && value.trim() ? value : fail(`缺少 ${label}`);
const list = (value, label) => Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim()) ? [...new Set(value)] : fail(`${label} 必須是非空字串陣列`);
const subset = (a, b) => a.every(x => b.includes('*') || b.some(y => x === y || x.startsWith(y + '/')));
const resourceSubset = (a, b) => a.every(x => b.includes('*') || b.includes(x));
function executionSettled(row) {
  const state = row.workerState || row.state || row.status;
  if (['completed', 'succeeded', 'stopped'].includes(state)) return true;
  return ['failed', 'abandoned'].includes(state) && (row.terminalState === 'released' || row.resource?.releaseState === 'released' || row.resource?.ownershipState === 'released' || row.projection?.liveness?.verdict === 'exited');
}
const safeRanges = (values, label) => list(values, label).map(value => {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (value === '*') return value;
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || /[*?\[\]]/.test(normalized)) fail('工作範圍只接受專案相對路徑或單獨的 *');
  return normalized.replace(/\/$/, '');
});

function readDb() {
  const file = path.join(home(), 'workflow.json');
  const db = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { version: 2, sequence: 0, runs: {}, intents: {} };
  if (db.version !== 2) fail('工作資料格式不支援；未轉換或覆寫');
  return db;
}

function lockSnapshot(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return null;
    return { stat, text: fs.readFileSync(file, 'utf8') };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function sameLock(a, b) { return a && b && a.stat.dev === b.stat.dev && a.stat.ino === b.stat.ino && a.text === b.text; }
function deadLock(snapshot) {
  if (!snapshot) return false;
  let owner;
  try { owner = JSON.parse(snapshot.text); } catch { return false; }
  if (owner.host !== os.hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
}
function recoverLock(file) {
  const original = lockSnapshot(file);
  if (!deadLock(original)) return false;
  const recovery = file + '.recovery';
  let fd;
  try { fd = fs.openSync(recovery, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return false; throw error; }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname() }));
    const current = lockSnapshot(file);
    if (!sameLock(original, current) || !deadLock(current)) return false;
    fs.unlinkSync(file);
    return true;
  } finally { fs.closeSync(fd); fs.unlinkSync(recovery); }
}

function transaction(fn) {
  fs.mkdirSync(home(), { recursive: true, mode: 0o700 });
  const lock = path.join(home(), 'workflow.lock'), deadline = Date.now() + 1000;
  let fd;
  while (fd === undefined) {
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (recoverLock(lock)) continue;
      if (Date.now() >= deadline) fail(`工作資料鎖仍被使用或無法確認；沒有派工。請核對 ${lock} 及 ${lock}.recovery；不依鎖齡移除回收鎖`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: randomUUID() }));
    const db = readDb(), result = fn(db);
    db.sequence++;
    atomicJSON(path.join(home(), 'workflow.json'), db);
    return result;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function getRun(db, session, runId) {
  const run = db.runs[runId];
  if (!run || run.session !== session) fail('Run 不屬於本對話');
  return run;
}
function memberFor(run, identity) {
  if (identity.owner) return run.members.root;
  const member = Object.values(run.members).find(x => x.dispatches.includes(identity.dispatchId));
  if (!member || member.dispatchId !== identity.dispatchId || member.retired) fail('原生呼叫者沒有有效團隊成員綁定');
  return member;
}
function itemFor(run, id) { return run.items[id] || fail('工作項目不存在'); }
function generationFor(item, value) { if (value !== item.generation) fail('工作世代不符或未指定；舊指令不能作用於重新授權的工作'); }
function controlAllowed(run, item, active = true) {
  if (!active || run.enabled === false || run.paused || run.cancelled || item?.paused || item?.cancelled || item?.done) fail('工作已停用、暫停、取消或結案，禁止推進');
}
function roleIs(actor, ...roles) { if (!roles.includes(actor.role)) fail(`此操作不屬於 ${actor.role} 的職權`); }
function isHead(actor) { if (actor.position !== 'head' && actor.position !== 'coordinator') fail('執行代理沒有派工權'); }
function approval(run, item) {
  const decision = run.decisions.findLast(x => x.kind === 'plan-approval' && x.work === item.id && x.generation === item.generation && x.digest === item.plan?.digest);
  return decision?.verdict === 'approved' && validEvidence(decision.evidence) ? decision : null;
}
function evidence(paths) {
  const names = list(paths, 'evidence');
  if (!names.length) fail('必須提供可讀取的證據檔案');
  return names.map(file => {
    if (!fs.statSync(file).isFile()) fail(`證據不是檔案：${file}`);
    return { file: path.resolve(file), digest: hash(fs.readFileSync(file)) };
  });
}
function validEvidence(rows) {
  return rows.every(x => fs.existsSync(x.file) && hash(fs.readFileSync(x.file)) === x.digest);
}
function outstanding(run, item) {
  return Object.values(run.operations).filter(x => (!item || x.work === item.id && x.generation === item.generation) && ['submitted', 'unknown', 'accepted'].includes(x.state));
}
function claim(db, candidate, ignoreMember) {
  const active = Object.values(db.runs).flatMap(r => outstanding(r)).filter(x => x.memberId !== ignoreMember);
  const executors = new Set(active.filter(x => x.position === 'executor').map(x => x.memberId));
  if (candidate.position === 'executor' && executors.size >= 3 || new Set(active.map(x => x.memberId)).size >= 16) fail('目前派工資源已滿；沒有建立新代理');
  if (active.some(x => candidate.resources.length && x.resources.length && (candidate.resources.includes('*') || x.resources.includes('*') || candidate.resources.some(y => x.resources.includes(y))) || rangeOverlap(candidate.physicalWrites, x.physicalWrites) || rangeOverlap(candidate.physicalWrites, x.physicalReads) || rangeOverlap(candidate.physicalReads, x.physicalWrites))) fail('與在途工作的檔案或工具範圍衝突');
}
function requiredOperations(run, item) {
  return Object.values(run.operations).filter(x => x.work === item.id && x.generation === item.generation && x.revision === item.revision && x.position === 'executor' && x.phase === 'implementation' && !x.supersededBy && !['owner-required', 'forwarded'].includes(x.state));
}
function deliveryComplete(run, item) {
  const required = requiredOperations(run, item);
  return required.length > 0 && required.every(x => x.result && validEvidence(x.result.files) && x.state === 'settled' && ['succeeded', 'completed'].includes(x.native?.state || x.native?.status));
}

function finalizeReceipt(run, operationId, receipt) {
  const op = run.operations[operationId];
  if (!op) fail('未知操作');
  op.receiptHistory ??= [];
  const digest = hash(receipt);
  if (!op.receiptHistory.some(x => x.digest === digest)) op.receiptHistory.push({ digest, receipt });
  if (op.state === 'forwarded') return { operation: op, confirmed: true, forwarded: true };
  const message = run.messages.find(x => x.id === operationId);
  const normalized = { ...receipt };
  if (!Object.hasOwn(normalized, 'messageId') && receipt.message?.id) normalized.messageId = receipt.message.id;
  if (!Object.hasOwn(normalized, 'runId') && receipt.message?.run_id) normalized.runId = receipt.message.run_id;
  const continuation = op.operationKind === 'continuation';
  const hasPair = normalized.dispatchId !== undefined || normalized.taskId !== undefined;
  const validMessage = continuation && op.position === 'head' && !hasPair && validId(normalized.messageId) && (normalized.runId === undefined || normalized.runId === run.id);
  const validPair = validId(normalized.dispatchId) && validId(normalized.taskId) && normalized.runId === run.id && (normalized.messageId === undefined || validId(normalized.messageId));
  const previous = op.supersedes ? run.operations[op.supersedes] : null;
  if ((!validMessage && !validPair) || continuation && op.position === 'executor' && normalized.dispatchId === previous?.dispatchId || op.dispatchId && validPair && op.dispatchId !== normalized.dispatchId) {
    op.state = 'unknown'; op.receipt = receipt;
    if (message) { message.state = 'unknown'; message.receipt = receipt; }
    return { operation: op, message, confirmed: false };
  }
  op.receipt = receipt;
  const member = run.members[op.memberId];
  if (validPair) {
    op.dispatchId = normalized.dispatchId; op.taskId = normalized.taskId;
    if (op.state !== 'settled') op.state = 'accepted';
    const currentSequence = member.dispatchSequence ?? Math.max(0, ...Object.values(run.operations).filter(x => x.dispatchId === member.dispatchId).map(x => x.sequence));
    if (op.sequence >= currentSequence) { member.dispatchId = normalized.dispatchId; member.dispatchSequence = op.sequence; }
    if (!member.dispatches.includes(normalized.dispatchId)) member.dispatches.push(normalized.dispatchId);
  } else if (op.state !== 'settled') op.state = 'message-delivered';
  if (continuation && op.position === 'executor' && previous) previous.supersededBy = op.id;
  if (message) {
    message.state = 'delivered'; message.receipt = receipt;
    if (message.forwardOf) {
      const original = run.messages.find(x => x.id === message.forwardOf);
      if (original) { original.state = 'delivered'; original.forwardedBy = message.id; }
      if (run.operations[message.forwardOf]) { run.operations[message.forwardOf].state = 'forwarded'; run.operations[message.forwardOf].supersededBy = op.id; }
    }
  }
  if (op.replaces && run.operations[op.replaces]) run.operations[op.replaces].supersededBy = op.id;
  const cancelPending = op.position === 'executor' && !!(run.cancelled || run.items[op.work]?.cancelled);
  if (cancelPending && op.state !== 'settled') op.stopRequested = true;
  return { operation: op, member, confirmed: true, cancelPending, message };
}

export class Workflow {
  constructor(session, runtime = new NativeRuntime()) { this.session = session; this.runtime = runtime; }
  run(runId) { return getRun(readDb(), this.session, runId); }
  mutate(runId, fn, { active = true } = {}) {
    const identity = this.runtime.identity(runId);
    return transaction(db => {
      const run = getRun(db, this.session, runId), actor = memberFor(run, identity);
      if (active) requireActive(this.session);
      return fn(run, actor, db);
    });
  }
  open(objective) {
    assertWorkflowOwner(this.session, this.runtime);
    const session = requireActive(this.session), id = randomUUID();
    transaction(db => { db.intents[id] = { session: this.session, objective: text(objective, 'objective'), state: 'submitted' }; });
    let runId;
    try { runId = this.runtime.open(objective, id); }
    catch (error) { transaction(db => { db.intents[id].state = 'unknown'; db.intents[id].error = error.message; }); throw error; }
    transaction(db => {
      db.intents[id].state = 'accepted'; db.intents[id].runId = runId;
      db.runs[runId] = { version: 2, id: runId, session: this.session, project: session.project, enabled: true, paused: false, cancelled: false, controlRevision: 0,
        members: { root: { id: 'root', role: 'taizi', position: 'coordinator', dispatches: [], scopes: ['*'] } }, items: {}, operations: {}, decisions: [], messages: [], history: [] };
    });
    const current = readSession(this.session);
    current.runId = runId;
    try { writeSession(current); }
    catch (error) { return { ...this.run(runId), sessionIndexError: error.message }; }
    return this.run(runId);
  }
  add(runId, data) {
    return this.mutate(runId, (run, actor) => {
      roleIs(actor, 'taizi', 'zhongshu'); isHead(actor); controlAllowed(run);
      const id = data.id || `W-${String(Object.keys(run.items).length + 1).padStart(3, '0')}`;
      if (run.items[id]) fail('工作項目已存在，不重建');
      const item = { id, title: text(data.title, 'title'), requirement: text(data.requirement, 'requirement'), generation: 1, revision: 0,
        reads: safeRanges(data.reads || ['*'], 'reads'), writes: safeRanges(data.writes || [], 'writes'), resources: list(data.resources || [], 'resources'),
        acceptance: list(data.acceptance, 'acceptance'), paused: false, cancelled: false, done: false, plan: null, result: null, authors: [] };
      if (!item.acceptance.length) fail('工作必須有驗收條件');
      run.items[id] = item; return item;
    });
  }
  plan(runId, work, data) {
    return this.mutate(runId, (run, actor) => {
      roleIs(actor, 'zhongshu'); isHead(actor); const item = itemFor(run, work); controlAllowed(run, item);
      generationFor(item, data.generation);
      const plan = { description: text(data.description, 'description'), reads: safeRanges(data.reads || item.reads, 'reads'), writes: safeRanges(data.writes || [], 'writes'),
        resources: list(data.resources || [], 'resources'), acceptance: list(data.acceptance || item.acceptance, 'acceptance'), dependencies: list(data.dependencies || [], 'dependencies'), author: actor.id };
      if (!subset(plan.reads, item.reads) || !subset(plan.writes, item.writes) || !resourceSubset(plan.resources, item.resources)) fail('方案超出需求授權範圍');
      for (const dep of plan.dependencies) if (!run.items[dep] || dep === item.id) fail('工作相依無效');
      const visiting = new Set(), visited = new Set();
      function visit(id) {
        if (visiting.has(id)) fail('工作相依成環，不能提交方案');
        if (visited.has(id)) return;
        visiting.add(id);
        for (const dep of id === item.id ? plan.dependencies : run.items[id].plan?.dependencies || []) visit(dep);
        visiting.delete(id); visited.add(id);
      }
      visit(item.id);
      item.revision++; plan.revision = item.revision; plan.generation = item.generation; plan.digest = hash(plan); item.plan = plan; item.result = null;
      return plan;
    });
  }
  review(runId, work, data) {
    const proof = evidence(data.evidence);
    return this.mutate(runId, (run, actor) => {
      const item = itemFor(run, work); controlAllowed(run, item); const kind = data.kind;
      generationFor(item, data.generation);
      if (!actor.scopes.includes('*') && !actor.scopes.includes(work)) fail('沒有此工作項目的審查委派');
      if (!['approved', 'rejected'].includes(data.verdict)) fail('verdict 必須為 approved 或 rejected');
      if (kind === 'plan-approval') {
        roleIs(actor, 'menxia'); isHead(actor);
        if (!item.plan || data.digest !== item.plan.digest || item.plan.author === actor.id) fail('方案版本或審查獨立性不成立');
      } else if (kind === 'artifact-acceptance') {
        roleIs(actor, 'xingbu');
        if (!item.result || data.digest !== item.result.digest || item.authors.includes(actor.id) || item.result.authors?.includes(actor.id) || !validEvidence(item.result.files)) fail('成果版本或審查獨立性不成立');
        if (outstanding(run, item).some(x => x.writes.length)) fail('仍有可能修改成果的委派，不能驗收');
        if (!deliveryComplete(run, item)) fail('必要實作委派失敗、未交付或未確認成功，不能驗收');
      } else if (kind === 'closure-confirmation') {
        roleIs(actor, 'menxia'); isHead(actor);
        if (!item.result || data.digest !== item.result.digest || !validEvidence(item.result.files) || !approval(run, item) || !deliveryComplete(run, item)) fail('缺少有效方案、完整交付或成果');
        const accepted = run.decisions.findLast(x => x.kind === 'artifact-acceptance' && x.work === work && x.generation === item.generation && x.digest === item.result.digest);
        if (!accepted || accepted.verdict !== 'approved' || !validEvidence(accepted.evidence) || outstanding(run, item).some(x => x.writes.length || x.position === 'executor')) fail('獨立驗收或在途工作尚未收斂');
        if (data.verdict === 'approved') item.done = true;
      } else fail('未知審查種類');
      const record = { id: randomUUID(), kind, work, generation: item.generation, digest: data.digest, verdict: data.verdict, actor: actor.id, evidence: proof, reason: data.reason || '', at: new Date().toISOString() };
      run.decisions.push(record); return record;
    });
  }
  prepare(runId, role, position, work, data) {
    return this.mutate(runId, (run, actor, db) => {
      isHead(actor); const item = work ? itemFor(run, work) : null; controlAllowed(run, item);
      if (item) generationFor(item, data.generation);
      if (!ROLES[role] || !['head', 'executor'].includes(position)) fail('角色或職位無效');
      const bootstrap = position === 'head' && actor.role === 'taizi' && ['zhongshu', 'menxia', 'shangshu'].includes(role) && !work;
      if (position === 'head') {
        const allowed = bootstrap || actor.role === 'zhongshu' && ['menxia', 'shangshu'].includes(role) || actor.role === 'menxia' && role === 'shangshu' || actor.role === 'shangshu' && departments.includes(role);
        if (!allowed) fail('禁止越級建立省部頭領');
      } else if (actor.position !== 'head' || actor.role !== role) fail('只能建立自己省部的執行代理');
      if (!bootstrap && role !== 'zhongshu' && (!item || !item.plan)) fail('必須有中書送審方案');
      if (!bootstrap && !['zhongshu', 'menxia'].includes(role) && !approval(run, item)) fail('缺少門下對目前方案的正式核可');
      if (item && actor.scopes[0] !== '*' && !actor.scopes.includes(work)) fail('頭領沒有此工作項目的委派');
      if (position === 'head') {
        const existing = Object.values(run.members).find(x => x.role === role && x.position === 'head' && !x.retired);
        if (existing) { if (work && !existing.scopes.includes(work)) existing.scopes.push(work); return { existing }; }
        if (['menxia', 'shangshu'].includes(role) && !bootstrap) fail('原協調者須先建立無工作授權的三省頭領；以原生 ask 請原協調者處理，不自行增加巢狀深度');
      }
      const phase = position === 'head' ? 'coordination' : data.phase || (role === 'zhongshu' ? 'planning' : role === 'menxia' ? 'plan-review' : role === 'shangshu' ? 'coordination' : role === 'xingbu' ? 'verification' : 'implementation');
      const verification = ['verification', 'plan-review'].includes(phase);
      const phases = role === 'zhongshu' ? ['planning'] : role === 'menxia' ? ['plan-review', 'verification'] : role === 'shangshu' ? ['coordination'] : ['implementation', 'verification'];
      if (position === 'executor' && !phases.includes(phase)) fail('執行階段不屬於此角色');
      const writes = position === 'head' || verification || role === 'zhongshu' || role === 'shangshu' ? [] : safeRanges(data.writes || item.plan.writes, 'writes');
      const reads = position === 'head' ? [] : safeRanges(data.reads || item?.plan?.reads || item?.reads || ['*'], 'reads');
      const resources = position === 'head' ? [] : list(data.resources || item?.plan?.resources || [], 'resources');
      if (item && (!subset(writes, item.plan?.writes || item.writes) || !subset(reads, item.plan?.reads || item.reads) || !resourceSubset(resources, item.plan?.resources || item.resources))) fail('委派超出已核可範圍');
      const replaces = data.replaces ? run.operations[data.replaces] : null;
      if (data.replaces && (!replaces || replaces.state !== 'refused' || replaces.rawReceipt?.error?.data?.effectsApplied !== false || replaces.actorId !== actor.id || replaces.work !== work || replaces.generation !== item?.generation || replaces.revision !== item?.revision || replaces.role !== role || replaces.position !== position || replaces.phase !== phase || !subset(replaces.writes, writes) || !subset(writes, replaces.writes) || !subset(replaces.reads, reads) || !subset(reads, replaces.reads) || !subset(replaces.resources, resources) || !subset(resources, replaces.resources))) fail('只能明確取代自己同階段、同範圍、同世代且原生已證明無副作用的拒絕操作');
      const deps = item?.plan?.dependencies || [];
      if (deps.some(id => !run.items[id].done)) fail('前置工作尚未結案；未送出原生派工');
      const worktree = data.worktree || 'current';
      if (!['current', 'new-child'].includes(worktree) && !worktree.startsWith('path:')) fail('工作樹必須為 current、new-child 或既有 path');
      const root = worktree === 'current' ? run.project : worktree.startsWith('path:') ? worktree.slice(5) : null;
      const shape = { physicalReads: geometry(root, reads), physicalWrites: geometry(root, writes) };
      claim(db, { position, resources, ...shape });
      const member = { id: randomUUID(), role, position, title: position === 'head' ? ROLES[role].head : ROLES[role].executor,
        supervisor: actor.id, scopes: role === 'zhongshu' && position === 'head' ? ['*'] : work ? [work] : [], dispatches: [], dispatchId: null, generation: 1 };
      const session = requireActive(this.session), settings = resolveSettings(session.config, role, position);
      const op = { id: randomUUID(), requestId: randomUUID(), memberId: member.id, actorId: actor.id, role, position, runId, work: work || null, generation: item?.generation || 0,
        revision: item?.revision || 0, writes, reads, resources, worktree, root, ...shape, settings, state: 'submitted', sequence: ++db.sequence,
        spec: text(data.spec, 'spec'), phase, operationKind: 'start', replaces: replaces?.id || null, planDigest: item?.plan?.digest || null, controlRevision: run.controlRevision };
      run.members[member.id] = member; run.operations[op.id] = op;
      if (op.phase === 'implementation') item.authors.push(member.id);
      return { operation: op, member };
    });
  }
  launch(runId, role, position, work, data) {
    const prepared = this.prepare(runId, role, position, work, data);
    if (prepared.existing) return { ...prepared, member: prepared.existing };
    const op = prepared.operation;
    const spec = workerSpec(role, op.spec, this.run(runId).project, { position, session: this.session, runId, memberId: op.memberId, work, phase: op.phase, stateHome: home() });
    let receipt;
    try { receipt = this.runtime.start(runId, op.settings, spec, { worktree: op.worktree, title: prepared.member.title }, op.requestId); }
    catch (error) {
      transaction(db => {
        const run = getRun(db, this.session, runId), stored = run.operations[op.id];
        const refused = error.receipt?.ok === false && error.receipt.error?.data?.effectsApplied === false;
        stored.state = refused ? 'refused' : 'unknown'; stored.error = error.message; stored.rawReceipt = error.receipt || null;
        if (refused) run.members[stored.memberId].retired = true;
      });
      throw error;
    }
    return this.recordReceipt(runId, op.id, receipt);
  }
  recordReceipt(runId, operationId, receipt) {
    const current = this.run(runId).operations[operationId];
    let root = current?.root, rootError;
    if (current?.worktree === 'new-child' && !root) {
      try { root = this.runtime.worktreeRoot(receipt); } catch (error) { rootError = error.message; }
    }
    const result = transaction(db => {
      const run = getRun(db, this.session, runId), op = run.operations[operationId];
      if (op && root) { op.root = root; op.physicalReads = geometry(root, op.reads); op.physicalWrites = geometry(root, op.writes); }
      if (op && rootError) op.rootError = rootError;
      return finalizeReceipt(run, operationId, receipt);
    });
    if (result.cancelPending) result.stops = this.drainStops(runId);
    return result;
  }
  result(runId, operationId, data) {
    const files = evidence(data.files);
    return this.mutate(runId, (run, actor) => {
      const op = run.operations[operationId];
      if (!op || op.memberId !== actor.id || !op.work) fail('只能提交自己的委派成果');
      if (op.position !== 'executor' || op.phase !== 'implementation' || !departments.includes(actor.role)) fail('只有實作執行代理可以提交交付成果；審查與管理操作不能取代工程交付');
      const item = itemFor(run, op.work);
      if (op.worktree === 'new-child' && !op.root) fail('子工作樹位置尚未由原生收據核對，不能提交成果');
      for (const row of files) {
        const relative = path.relative(op.root || run.project, row.file).replaceAll('\\', '/');
        const reportRoot = path.join(home(), 'artifacts', operationId);
        const reportRelative = path.relative(reportRoot, row.file);
        const inProject = !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('../');
        if (!(inProject && subset([relative], op.writes)) && (path.isAbsolute(reportRelative) || reportRelative.startsWith('..'))) fail('成果檔案不在委派寫入範圍或本操作的成果目錄');
      }
      const result = { files, author: actor.id, generation: op.generation, planDigest: op.planDigest, operationId, at: new Date().toISOString() };
      result.digest = hash(result); op.result = result;
      const archivedOnly = !!item.cancelled || item.generation !== op.generation || op.revision !== item.revision;
      if (!archivedOnly) {
        const contributions = requiredOperations(run, item).filter(x => x.result).map(x => x.result);
        const bundle = { files: contributions.flatMap(x => x.files), authors: [...new Set(contributions.map(x => x.author))], contributions: contributions.map(x => ({ operationId: x.operationId, digest: x.digest })), generation: item.generation, planDigest: item.plan.digest };
        bundle.digest = hash(bundle); item.result = bundle;
      }
      return { result: archivedOnly ? result : item.result, contribution: result, archivedOnly };
    }, { active: false });
  }
  control(runId, action, work) {
    const result = this.mutate(runId, (run, actor, db) => {
      roleIs(actor, 'taizi'); const item = work ? itemFor(run, work) : null, target = item || run;
      if (target.done && action === 'cancel') fail('工作已結案；取消沒有套用');
      if (action === 'pause') target.paused = true;
      else if (action === 'resume') { if (target.cancelled) fail('取消世代不能恢復；需明確重新授權'); target.paused = false; }
      else if (action === 'cancel') target.cancelled = true;
      else if (action === 'restart') {
        if (!item || !item.cancelled) fail('重新授權必須指定已取消項目');
        if (outstanding(run, item).some(x => x.position === 'executor') || run.messages.some(x => x.work === item.id && ['submitted', 'unknown', 'forwarding'].includes(x.state))) fail('原世代仍有在途工作或未知副作用');
        item.generation++; item.cancelled = false; item.paused = false; item.plan = null; item.result = null; item.done = false; item.authors = [];
      } else fail('未知控制操作');
      run.controlRevision++; run.history.push({ action, work, sequence: ++db.sequence, actor: actor.id, at: new Date().toISOString() });
      if (action === 'cancel') for (const op of outstanding(run, item)) if (op.position === 'executor') op.stopRequested = true;
      return { action, work, pending: outstanding(run, item).filter(x => x.position === 'executor') };
    }, { active: false });
    if (action === 'cancel') result.stops = this.drainStops(runId);
    return result;
  }
  message(runId, targetId, work, body, forwardId, expectedGeneration, kind = 'handoff') {
    if (!['handoff', 'report'].includes(kind)) fail('訊息種類必須為 handoff 或 report');
    const prepared = this.mutate(runId, (run, actor, db) => {
      isHead(actor); const target = run.members[targetId];
      if (!target?.dispatchId) fail('目標成員尚未取得原生 Dispatch');
      const item = work ? itemFor(run, work) : null;
      if (kind === 'handoff') controlAllowed(run, item);
      if (kind === 'report' && target.position !== 'head') fail('只讀回報只能送既有頭領，不能啟動執行工作');
      if (item) generationFor(item, expectedGeneration);
      let source = actor;
      if (forwardId) {
        roleIs(actor, 'taizi');
        const original = run.messages.find(x => x.id === forwardId && x.state === 'owner-required');
        if (!original || original.to !== targetId || original.work !== work || original.body !== body || original.generation !== item?.generation) fail('沒有可由 owner 原樣轉交的有效世代交接');
        source = run.members[original.from];
        if (!source || source.retired) fail('交接來源已失效');
        original.state = 'forwarding';
      }
      const route = source.position === 'head' && target.position === 'executor' && target.supervisor === source.id ||
        target.position === 'head' && ({ taizi: ['zhongshu'], zhongshu: ['menxia', 'shangshu', 'taizi'], menxia: ['zhongshu', 'shangshu'], shangshu: ['zhongshu', 'menxia', ...departments] }[source.role] || (departments.includes(source.role) ? ['shangshu'] : [])).includes(target.role);
      if (!route) fail('不允許此跨省部或越級交接');
      if (item && (!source.scopes.includes('*') && !source.scopes.includes(work) || !target.scopes.includes('*') && !target.scopes.includes(work))) fail('交接不屬於來源及目標的共同工作範圍');
      if (target.position === 'executor' && (!item || !approval(run, item))) fail('實作續辦缺少有效核可');
      const previous = Object.values(run.operations).findLast(x => x.memberId === target.id && ['accepted', 'settled'].includes(x.state));
      if (!previous) fail('沒有目標原委派');
      if (target.position === 'executor' && (previous.work !== work || previous.generation !== item.generation || previous.revision !== item.revision)) fail('續辦不能跨工作、世代或已變更方案；須建立新的明確委派');
      if (target.position === 'executor' && previous.state !== 'settled') fail('實作代理仍在執行；先處理其原生回報並 sync，再續辦有界修正');
      if (Object.values(run.operations).some(x => x.memberId === target.id && ['unknown', 'submitted'].includes(x.state))) fail('目標仍有未確認操作，不能再次傳送');
      const claims = target.position === 'executor' ? previous : { reads: [], writes: [], resources: [], physicalReads: geometry(run.project, []), physicalWrites: geometry(run.project, []) };
      claim(db, { ...claims, position: target.position }, target.id);
      const record = { id: randomUUID(), requestId: randomUUID(), kind, from: source.id, to: targetId, work: work || null, generation: item?.generation || 0, revision: item?.revision || 0, body: text(body, 'body'), forwardOf: forwardId || null, state: 'submitted', sequence: ++db.sequence };
      run.messages.push(record);
      run.operations[record.id] = { id: record.id, operationKind: 'continuation', supersedes: previous.id, memberId: target.id,
        role: target.role, position: target.position, actorId: actor.id, runId, requestId: record.requestId,
        settings: previous.settings, phase: previous.phase, spec: record.body, worktree: previous.worktree, root: previous.root,
        reads: claims.reads, writes: claims.writes, resources: claims.resources, physicalReads: claims.physicalReads, physicalWrites: claims.physicalWrites,
        planDigest: item?.plan?.digest || null, work: work || null, generation: item?.generation || 0, revision: item?.revision || 0,
        state: 'submitted', sequence: record.sequence, result: null, receipt: null };
      if (item && target.position === 'executor') item.result = null;
      return { record, target };
    }, { active: kind !== 'report' });
    let receipt;
    try { receipt = this.runtime.send(runId, prepared.target.dispatchId, prepared.record.body, prepared.record.requestId); }
    catch (error) {
      transaction(db => {
        const run = getRun(db, this.session, runId), record = run.messages.find(x => x.id === prepared.record.id);
        record.state = error.code === 'consumer_fenced' && !forwardId ? 'owner-required' : 'unknown'; record.error = error.message;
        run.operations[record.id].state = record.state;
      });
      if (error.code === 'consumer_fenced' && !forwardId) return { messageId: prepared.record.id, state: 'owner-required', next: '由原對話 team forward 原樣轉交；不重新判斷業務決定' };
      throw error;
    }
    const finalized = this.recordReceipt(runId, prepared.record.id, receipt);
    return { ...finalized.message, confirmed: finalized.confirmed, state: finalized.confirmed ? 'delivered' : 'unknown' };
  }
  forward(runId, messageId) {
    const original = this.run(runId).messages.find(x => x.id === messageId);
    if (!original) fail('找不到交接');
    return this.message(runId, original.to, original.work, original.body, messageId, original.generation, original.kind || 'handoff');
  }
  recover(runId, operationId) {
    const run = this.run(runId), actor = memberFor(run, this.runtime.identity(runId)), op = run.operations[operationId];
    if (!op || op.actorId !== actor.id) fail('只能以原呼叫身分查核此操作；不猜測或改 ID 重送');
    const request = this.runtime.request(op.requestId);
    const refusal = transaction(db => {
      const saved = getRun(db, this.session, runId), operation = saved.operations[operationId]; operation.recovery = request;
      if (operation.rawReceipt?.ok === false && operation.rawReceipt.error?.data?.effectsApplied === false) {
        operation.state = 'refused'; saved.members[operation.memberId].retired = true;
        return { operationId, state: 'refused', effectsApplied: false, request };
      }
      return null;
    });
    if (refusal) return refusal;
    let receipt = request.receipt || request.response?.result || request.result || request.accepted || request.request?.accepted;
    if (receipt?.ok === true && receipt.result) receipt = receipt.result;
    if (receipt?.accepted) receipt = receipt.accepted;
    if (receipt?.dispatchId && receipt?.taskId && receipt.runId === undefined) {
      const dispatch = this.runtime.dispatch(receipt.dispatchId);
      if (dispatch.id !== receipt.dispatchId || dispatch.taskId !== receipt.taskId || dispatch.runId !== runId) fail('原生接受 checkpoint 與 Dispatch 的 Run 或 Task 不符');
      receipt = { ...receipt, runId: dispatch.runId };
    }
    if (receipt) return this.recordReceipt(runId, operationId, receipt);
    return { request, operationId, state: op.state, next: '原生結果尚未核對；保留占用，不重新派工' };
  }
  sync(runId) {
    const rows = this.runtime.workers(runId);
    this.mutate(runId, run => {
      for (const row of rows) {
        const id = row.dispatchId || row.id;
        for (const op of Object.values(run.operations).filter(x => x.dispatchId === id)) {
          op.native = row;
          if (executionSettled(row)) { op.state = 'settled'; op.stopRequested = false; }
        }
      }
    }, { active: false });
    const stops = this.drainStops(runId);
    return { ...this.show(runId), stops };
  }
  drainStops(runId) {
    const pending = transaction(db => {
      const run = getRun(db, this.session, runId), ready = [];
      for (const op of Object.values(run.operations)) {
        if (!op.stopRequested || op.state === 'settled' || !op.dispatchId) continue;
        const nativeState = op.native?.state || op.native?.status || 'unobserved';
        if (op.stopAttempt && !(op.stopAttempt.code === 'dispatch_inactive' && op.stopAttempt.nativeState !== nativeState && ['ready', 'start_unknown'].includes(nativeState))) continue;
        op.stopAttempt = { id: randomUUID(), nativeState, state: 'submitted' };
        ready.push({ operationId: op.id, dispatchId: op.dispatchId, requestId: op.stopAttempt.id });
      }
      return ready;
    });
    return pending.map(entry => {
      let receipt, error;
      try { receipt = this.runtime.stop(entry.dispatchId, entry.requestId); } catch (failure) { error = failure; }
      return transaction(db => {
        const op = getRun(db, this.session, runId).operations[entry.operationId];
        op.stopAttempt.state = error ? 'unconfirmed' : 'accepted';
        if (error) { op.stopAttempt.error = error.message; op.stopAttempt.code = error.code; }
        else {
          op.stopAttempt.receipt = receipt;
          const state = receipt.worker?.state || receipt.state;
          if (executionSettled({ ...receipt, ...receipt.worker, state })) { op.state = 'settled'; op.native = { ...op.native, state }; op.stopRequested = false; }
        }
        return { operationId: op.id, stop: op.stopAttempt, executionSettled: op.state === 'settled' };
      });
    });
  }
  view(run) {
    const items = Object.values(run.items).map(item => ({ ...item,
      status: item.done ? 'Done' : item.cancelled || item.paused || run.paused || run.cancelled ? 'Blocked' : item.result || item.plan && !approval(run, item) ? 'Review' : outstanding(run, item).length ? 'WIP' : 'Todo',
      controlResult: item.cancelled || run.cancelled ? outstanding(run, item).some(x => x.position === 'executor') || run.messages.some(x => x.work === item.id && ['submitted', 'unknown', 'forwarding'].includes(x.state)) ? '取消已受理，仍有在途或未確認工作' : '取消已完成' : null }));
    return { ...run, items };
  }
  show(runId) {
    const run = this.run(runId), actor = memberFor(run, this.runtime.identity(runId)), view = this.view(run);
    if (actor.scopes.includes('*')) return view;
    return { ...view, items: view.items.filter(x => actor.scopes.includes(x.id)), operations: Object.fromEntries(Object.entries(view.operations).filter(([, x]) => actor.scopes.includes(x.work))) };
  }
}

export function assertWorkflowOwner(session, runtime = new NativeRuntime()) {
  const runs = Object.values(readDb().runs).filter(x => x.session === session);
  for (const run of runs) if (!runtime.identity(run.id).owner) fail('只有此 Run 原協調者可以啟用或停用');
  return runs;
}

export function setWorkflowEnabled(session, enabled, runtime = new NativeRuntime()) {
  const runs = assertWorkflowOwner(session, runtime);
  if (!runs.length) return;
  transaction(db => { for (const run of Object.values(db.runs)) if (run.session === session) { run.enabled = enabled; run.controlRevision++; } });
}

export function workflowStatus(session) {
  return Object.values(readDb().runs).filter(x => x.session === session).map(x => ({ runId: x.id, paused: x.paused, cancelled: x.cancelled,
    teams: Object.values(x.members).filter(m => m.position === 'head').map(m => ({ role: m.role, memberId: m.id, dispatchId: m.dispatchId })),
    items: Object.values(x.items).map(i => ({ id: i.id, title: i.title, done: i.done, paused: i.paused, cancelled: i.cancelled, generation: i.generation })) }));
}
