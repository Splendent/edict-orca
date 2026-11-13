import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { home, readSession, requireActive, atomicJSON, writeSession, readJSON } from './session.mjs';
import { ROLES, workerSpec } from './roles.mjs';
import { resolveSettings } from './config.mjs';
import { geometry, mergeGeometry, overlapDetails } from './ranges.mjs';
import { NativeRuntime, sendArgs, startArgs, preflightNative, nativeArgs } from './native.mjs';
import { windowsCommandLength } from './orca.mjs';

const departments = ['hubu', 'libu', 'bingbu', 'xingbu', 'gongbu', 'libu_hr'];
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const fail = message => { throw new Error(message); };
const validId = value => typeof value === 'string' && value.trim().length > 0;
const displayText = value => String(value).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').replace(/\s+/gu, ' ').trim().slice(0, 72);
function memberSummary(run, member) {
  const operations = Object.values(run.operations).filter(x => x.memberId === member.id);
  const nativeOperation = operations.findLast(x => x.dispatchId && x.dispatchId === member.dispatchId);
  const op = operations.findLast(x => x.dispatchId && x.dispatchId === member.dispatchId || x.state === 'message-delivered') || operations.at(-1);
  const item = run.items[op?.work], supervisor = run.members[member.supervisor];
  const assignment = displayText(op?.title || item?.title || (member.id === 'root' ? '需求與工作控制' : '協調與交接'));
  const title = member.title || ROLES[member.role]?.name || member.role;
  const label = `${title}｜${op?.work ? `${displayText(op.work)} ` : ''}${assignment}${supervisor ? `｜←${supervisor.title || ROLES[supervisor.role]?.name}` : ''}｜${member.id.slice(0, 8)}`;
  return { memberId: member.id, role: member.role, position: member.position, title, label, assignment,
    supervisorId: member.supervisor || null, work: op?.work || null, scopes: member.scopes,
    dispatchId: member.dispatchId || null, worktree: nativeOperation?.native?.projection?.workspace?.id || op?.root || op?.worktree || run.project,
    operationState: op?.state || null, workerState: nativeOperation?.native?.state || nativeOperation?.native?.workerState || null,
    observedAt: nativeOperation?.observedAt || null, retired: member.retired || false, presentation: member.presentation || null };
}
function hierarchy(run, scopes) {
  const members = Object.values(run.members);
  let visible = members;
  if (scopes) {
    const ids = new Set(members.filter(member => member.scopes.some(id => scopes.includes(id))).map(member => member.id));
    for (const id of ids) {
      let parent = run.members[id]?.supervisor;
      while (parent && !ids.has(parent)) { ids.add(parent); parent = run.members[parent]?.supervisor; }
    }
    visible = members.filter(member => ids.has(member.id));
    run = { ...run, operations: Object.fromEntries(Object.entries(run.operations).filter(([, op]) => !op.work || scopes.includes(op.work))) };
  }
  const nodes = visible.map(member => ({ ...memberSummary(run, member), scopes: scopes ? member.scopes.filter(id => scopes.includes(id)) : member.scopes, children: [] }));
  const byId = new Map(nodes.map(node => [node.memberId, node]));
  const roots = [];
  for (const node of nodes) {
    const parent = byId.get(node.supervisorId);
    if (parent) parent.children.push(node); else roots.push(node);
  }
  return roots;
}
const text = (value, label) => typeof value === 'string' && value.trim() ? value : fail(`缺少 ${label}`);
const list = (value, label) => Array.isArray(value) && value.every(x => typeof x === 'string' && x.trim()) ? [...new Set(value)] : fail(`${label} 必須是非空字串陣列`);
const subset = (a, b) => a.every(x => b.includes('*') || b.some(y => x === y || x.startsWith(y + '/')));
const resourceSubset = (a, b) => a.every(x => b.includes('*') || b.includes(x));
function executionSettled(row) {
  const state = row.workerState || row.state || row.status;
  if (row.projection?.liveness?.verdict === 'live') return false;
  if (['completed', 'succeeded', 'stopped'].includes(state)) return true;
  const stage = row.stage || row.projection?.stage?.detail;
  const missing = stage === 'terminal_missing' || stage === 'settled' && row.observation?.status === 'missing';
  return ['failed', 'abandoned'].includes(state) && (missing || row.terminalState === 'released' || row.resource?.releaseState === 'released' || row.resource?.ownershipState === 'released' || row.projection?.liveness?.verdict === 'exited');
}
function followUpSettlements(rows, runtime, runId) {
  const id = row => row.dispatchId || row.id;
  const state = row => row.workerState || row.state || row.status;
  const released = row => row.terminalState === 'released' || row.resource?.releaseState === 'released' ||
    row.resource?.ownershipState === 'released' || row.projection?.liveness?.verdict === 'exited';
  const failed = rows.filter(row => ['failed', 'abandoned'].includes(state(row)) && !executionSettled(row));
  const children = new Map(), byId = new Map(rows.map(row => [id(row), row]));
  if (!failed.length) return new Map();
  const dispatches = new Map();
  // Native reads must finish before the workflow transaction. followUpOf selects the
  // parent; terminal handles only corroborate that relationship when available.
  const lookup = row => {
    if (!dispatches.has(id(row))) {
      let dispatch;
      try { dispatch = runtime.dispatch(id(row)); } catch { /* Keep unconfirmed claims. */ }
      dispatches.set(id(row), dispatch?.id === id(row) && dispatch.runId === runId &&
        dispatch.taskId === row.taskId ? dispatch : null);
    }
    return dispatches.get(id(row));
  };
  for (const row of rows) {
    const dispatch = lookup(row);
    if (!dispatch || !validId(dispatch.followUpOf)) continue;
    if (validId(row.agentTerminalHandle) && validId(dispatch.assigneeHandle) &&
        dispatch.assigneeHandle !== row.agentTerminalHandle) continue;
    const parent = byId.get(dispatch.followUpOf);
    if (!parent) continue;
    const parentDispatch = validId(parent.agentTerminalHandle) ? null : lookup(parent);
    if (!validId(parent.agentTerminalHandle) && !parentDispatch) continue;
    const parentTerminal = validId(parent.agentTerminalHandle) ? parent.agentTerminalHandle : parentDispatch.assigneeHandle;
    const childTerminal = validId(row.agentTerminalHandle) ? row.agentTerminalHandle : dispatch.assigneeHandle;
    if (validId(parentTerminal) && validId(childTerminal) && parentTerminal !== childTerminal) continue;
    const siblings = children.get(dispatch.followUpOf) || [];
    siblings.push(row); children.set(dispatch.followUpOf, siblings);
  }
  const settled = (row, seen) => {
    if (seen.has(id(row)) || row.projection?.liveness?.verdict === 'live') return false;
    const next = new Set([...seen, id(row)]), followUps = children.get(id(row)) || [];
    if (followUps.length && !followUps.every(child => settled(child, next))) return false;
    return executionSettled(row) || released(row) ||
      ['failed', 'abandoned'].includes(state(row)) && followUps.length > 0;
  };
  return new Map(failed.filter(row => (children.get(id(row)) || []).length && settled(row, new Set()))
    .map(row => [id(row), { reason: 'native-follow-up-settled', followUpDispatchIds: children.get(id(row)).map(id) }]));
}
const safeRanges = (values, label) => list(values, label).map(value => {
  const normalized = path.posix.normalize(value.replaceAll('\\', '/'));
  if (value === '*') return value;
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || /[*?\[\]]/.test(normalized)) fail('工作範圍只接受專案相對路徑或單獨的 *');
  return normalized.replace(/\/$/, '');
});

// Extra read roots: [{ root: <existing absolute directory>, reads: [<root-relative ranges>] }]. Roots are stored by
// their real path so subset checks compare one spelling; claims use physical identities from geometry().
function realDirectory(value, label) {
  // On Windows a leading single slash is drive-relative, not absolute; require a drive or UNC root there.
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) || process.platform === 'win32' && /^[\\/](?![\\/])/.test(value)) fail(`${label} 必須是既有目錄的絕對路徑`);
  let real;
  try { real = fs.realpathSync.native(path.resolve(value)); } catch { fail(`${label} 不存在：${value}`); }
  if (!fs.statSync(real).isDirectory()) fail(`${label} 不是目錄：${value}`);
  return real;
}
function extraReadList(values, label = 'extraReads') {
  if (values === undefined) return [];
  if (!Array.isArray(values)) fail(`${label} 必須是 {root, reads} 物件陣列`);
  const merged = [];
  for (const entry of values) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !['root', 'reads'].includes(key))) fail(`${label} 每項只接受 root 與 reads`);
    const root = realDirectory(entry.root, `${label}.root`), reads = safeRanges(entry.reads, `${label}.reads`);
    if (!reads.length) fail(`${label}.reads 不可為空`);
    const existing = merged.find(x => sameDirectory(x.root, root));
    if (existing) existing.reads = [...new Set([...existing.reads, ...reads])]; else merged.push({ root, reads });
  }
  return merged;
}
// A UNC share and a drive path can name one directory (e.g. \\localhost\C$\x and C:\x); realpath keeps both
// spellings and a share cannot be mapped back to a drive safely, so roots compare by physical directory identity.
function directoryIdentity(dir) {
  try { const stat = fs.statSync(dir, { bigint: true }); return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null; } catch { return null; }
}
function sameDirectory(a, b) {
  if (a === b) return true;
  const left = directoryIdentity(a);
  return left !== null && left === directoryIdentity(b);
}
const extraSubset = (a, b) => a.every(x => b.some(y => sameDirectory(x.root, y.root) && subset(x.reads, y.reads)));
const extraGeometry = extras => mergeGeometry(...extras.map(x => geometry(x.root, x.reads)));
// Built-in convention: git:<common dir> names the shared git metadata a commit or merge writes. It is canonicalised to
// the real common dir so every spelling of one repository yields the same exclusive resource name.
function resourceList(values, label) {
  return [...new Set(list(values, label).map(name => {
    if (!name.startsWith('git:')) return name;
    const dir = realDirectory(name.slice(4), 'git: 資源');
    if (!fs.existsSync(path.join(dir, 'HEAD'))) fail(`git: 資源必須指向 git common dir（git rev-parse --git-common-dir 的結果）：${name}`);
    if (fs.existsSync(path.join(dir, 'commondir'))) fail(`git: 資源指向單一工作樹的 git dir；請改用 git rev-parse --git-common-dir 的結果：${name}`);
    return `git:${dir.replaceAll('\\', '/')}`;
  }))];
}

function readDb() {
  const file = path.join(home(), 'workflow.json');
  const db = fs.existsSync(file) ? readJSON(file) : { version: 2, sequence: 0, runs: {}, intents: {} };
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
      if (Date.now() >= deadline) throw Object.assign(new Error(`工作資料鎖仍被使用或無法確認；沒有派工。請核對 ${lock} 及 ${lock}.recovery；不依鎖齡移除回收鎖`), { code: 'EDICT_LOCK_BUSY' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, host: os.hostname(), nonce: randomUUID() }));
    const db = readDb(), result = fn(db);
    db.sequence++;
    atomicJSON(path.join(home(), 'workflow.json'), db, { keepPrevious: true });
    return result;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

// A held composer draft belongs to this Dispatch only when it is Orca's own dispatch preamble or wake-up notice, the
// Edict worker spec header (roles.mjs workerSpec), or carries the start of one of the member's Edict specs.
// Anything else may be a human's half-typed text.
const squash = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
function dispatchDraft(draft, specs) {
  const text = squash(draft);
  if (/^You are working inside Orca\b/i.test(text) || /^# Edict /u.test(text) || /^You have \d+ (new )?orchestration messages?\b/i.test(text)) return true;
  return specs.some(spec => {
    const body = squash(spec);
    if (body.length < 20) return false;
    return text.includes(body.slice(0, 80)) || text.length >= 20 && body.startsWith(text);
  });
}
function getRun(db, session, runId) {
  const run = db.runs[runId];
  if (!run || run.session !== session) fail('Run 不屬於本對話');
  return run;
}
// Orca lets only a Run's coordinator or a Dispatch's creator reopen a settled Dispatch. A peer head's send is then
// refused either as consumer_fenced or as task_not_found ("... is not a helper of Dispatch ..., No effects were
// applied."). Both are owner-relay cases for the original conversation, not unknown side effects: forward resends
// the same body as root, and the reopened Dispatch pair in the receipt rebinds the member.
function ownerRelayRequired(error) {
  if (error.code === 'consumer_fenced') return true;
  const native = error.receipt?.error;
  return error.code === 'task_not_found' && native?.data?.effectsApplied === false && /is not a helper of/.test(native.message || '');
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
// Planning-only work: the requirement authorizes no writes and nothing was delivered, so the approved plan is the result.
function designOnly(item) { return !item.writes.length && !item.result; }
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
// Orca's run-use keeps only the Run it names, so a handoff can move one open Run; every other Run of the session
// must already be finished and quiet, and is archived when the handoff completes.
function runSettled(run) {
  return !outstanding(run).length && !run.messages.some(x => ['submitted', 'unknown', 'forwarding', 'owner-required'].includes(x.state)) &&
    Object.values(run.items).every(item => item.done || item.cancelled);
}
function otherOpenRuns(db, session, runId) {
  return Object.values(db.runs).filter(x => x.session === session && x.id !== runId && !x.archived && !runSettled(x)).map(x => x.id);
}
function handoffPending(run) {
  return {
    ownerRequired: run.messages.filter(x => x.state === 'owner-required').map(x => ({ messageId: x.id, from: x.from, to: x.to, work: x.work, kind: x.kind || 'handoff' })),
    unknown: Object.values(run.operations).filter(x => x.state === 'unknown').map(x => ({ operationId: x.id, role: x.role, position: x.position, work: x.work, actorId: x.actorId })),
    inFlight: Object.values(run.operations).filter(x => ['submitted', 'accepted'].includes(x.state)).map(x => ({ operationId: x.id, role: x.role, position: x.position, work: x.work, state: x.state, dispatchId: x.dispatchId || null })),
  };
}
function handoffFor(run, packet, token) {
  const handoff = run.handoff;
  if (!handoff || handoff.id !== packet.id || handoff.tokenDigest !== hash(token)) fail('交棒檔已失效、已被新的交棒取代，或不屬於此 Run');
  if (handoff.state === 'accepted') fail('此交棒已完成；不重複接手');
  if (handoff.state === 'revoked') fail('原協調者已撤回此交棒');
  return handoff;
}
function resourceConflict(mine, theirs) {
  if (!mine.length || !theirs.length) return null;
  if (theirs.includes('*')) return `在途操作宣告資源 *，與所有工具資源互斥（本次資源 ${mine.join(', ')}）`;
  if (mine.includes('*')) return `本次宣告資源 *，與所有工具資源互斥（在途資源 ${theirs.join(', ')}）`;
  const shared = mine.filter(x => theirs.includes(x));
  return shared.length ? `共用工具資源 ${shared.join(', ')}` : null;
}
const capacityKey = (runId, op) => JSON.stringify([runId, op.id, op.dispatchId ?? null, op.taskId ?? null, op.memberId]);

// Prepare read-only native evidence before taking workflow.lock. Each immutable cache entry
// has its own file so concurrent commands cannot overwrite another command's discoveries.
export function prepareCapacityEvidence(db, currentRunId, runtime, cacheDir = path.join(home(), 'capacity-ended')) {
  const results = new Map();
  for (const run of Object.values(db.runs)) {
    if (run.id === currentRunId) continue;
    for (const op of outstanding(run)) {
      const key = capacityKey(run.id, op), file = path.join(cacheDir, hash(key) + '.json');
      let evidence;
      try {
        const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (cached.key === key && cached.evidence?.ended === true) evidence = cached.evidence;
      } catch { /* Missing or unreadable cache entries require fresh evidence. */ }
      if (!evidence) {
        try { evidence = runtime.capacityEvidence(run.id, op); }
        catch { evidence = { ended: false, reason: 'query-unavailable' }; }
        if (evidence?.ended === true) {
          try { atomicJSON(file, { key, evidence }); }
          catch { /* A cache failure must not turn confirmed evidence into an admission failure. */ }
        }
      }
      results.set(key, evidence);
    }
  }
  return results;
}

// Pure accounting: operations absent from the pre-lock snapshot remain counted.
export function capacityOperations(db, currentRunId, evidence = new Map()) {
  const active = [], excluded = [];
  for (const run of Object.values(db.runs)) {
    for (const op of outstanding(run)) {
      const proof = run.id === currentRunId ? null : evidence.get(capacityKey(run.id, op));
      if (proof?.ended === true) excluded.push({ runId: run.id, operationId: op.id, evidence: proof });
      else active.push(op);
    }
  }
  return { active, excluded };
}
function claim(db, candidate, ignoreMember, evidence) {
  const active = capacityOperations(db, candidate.runId, evidence).active.filter(x => x.memberId !== ignoreMember);
  const executors = new Set(active.filter(x => x.position === 'executor').map(x => x.memberId));
  if (candidate.position === 'executor' && executors.size >= 3 || new Set(active.map(x => x.memberId)).size >= 16) fail('目前派工資源已滿；沒有建立新代理');
  const conflicts = active.map(op => {
    const resource = resourceConflict(candidate.resources, op.resources || []);
    const reasons = [...(resource ? [resource] : []), ...overlapDetails(candidate, op)];
    return reasons.length ? `${op.runId && op.runId !== candidate.runId ? `Run ${op.runId} ` : ''}${op.work || '無工作項目'} ${op.role}/${op.position} 操作 ${op.id}（${reasons.join('；')}）` : null;
  }).filter(Boolean);
  if (conflicts.length) fail(`與在途工作的檔案或工具範圍衝突：${conflicts.slice(0, 3).join('；')}${conflicts.length > 3 ? `；另有 ${conflicts.length - 3} 項` : ''}。若無實際重疊，改宣告較窄的 reads／writes 或不同的資源名稱／工作樹`);
}
function requiredOperations(run, item) {
  return Object.values(run.operations).filter(x => x.work === item.id && x.generation === item.generation && x.revision === item.revision && x.position === 'executor' && x.phase === 'implementation' && !x.supersededBy && !['owner-required', 'forwarded'].includes(x.state) && !(x.operationKind === 'continuation' && x.state === 'refused' && x.rawReceipt?.error?.data?.effectsApplied === false));
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
  if (op.operationKind === 'replacement' && validPair) {
    const replaced = run.members[op.replacesMember];
    if (replaced && !replaced.retired) {
      replaced.retired = true; replaced.replacedBy = member.id;
      for (const child of Object.values(run.members)) if (child.supervisor === replaced.id) child.supervisor = member.id;
    }
    if (op.position === 'executor' && previous) {
      previous.supersededBy = op.id;
      const item = run.items[op.work];
      if (item && item.generation === op.generation && item.revision === op.revision) item.result = null;
    }
  }
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
  mutate(runId, fn, { active = true, capacity = false, preflight } = {}) {
    const identity = this.runtime.identity(runId);
    const evidence = capacity ? prepareCapacityEvidence(readDb(), runId, this.runtime) : new Map();
    // Validate the proposed native argv against a disposable snapshot before taking the lock.
    // The transaction still repeats all admission checks against the current database.
    if (preflight) {
      const db = readDb(), run = getRun(db, this.session, runId);
      if (active) requireActive(this.session);
      preflight(fn(run, memberFor(run, identity), db, evidence), run);
    }
    return transaction(db => {
      const run = getRun(db, this.session, runId), actor = memberFor(run, identity);
      if (run.archived) fail('此 Run 已在交棒時封存，不再接受變更；請在接手對話使用目前的 Run');
      if (active) requireActive(this.session);
      return fn(run, actor, db, evidence);
    });
  }
  // The current coordinator hands its root duties to another conversation. The packet carries a one-time token; the
  // receiving conversation proves the native takeover with run-use before Edict records the new root.
  handoffExport(runId, note) {
    const token = randomUUID();
    const exported = this.mutate(runId, (run, actor, db) => {
      if (actor.id !== 'root') fail('只有目前協調此 Run 的對話可以交棒');
      const others = otherOpenRuns(db, this.session, runId);
      if (others.length) fail(`本對話另有未結束的 Run：${others.join(', ')}。Orca 的 run-use 只讓接手對話保留一個 Run；先完成或取消其他 Run 的工作再交棒`);
      if (['accepting', 'unknown'].includes(run.handoff?.state)) fail('上一筆交棒的原生接手結果未確認；由接手對話以同一交棒檔再次 accept 核對，不另建交棒');
      const at = new Date().toISOString();
      if (run.handoff?.state === 'pending') run.history.push({ action: 'handoff-replaced', id: run.handoff.id, sequence: ++db.sequence, actor: actor.id, at });
      run.handoff = { id: randomUUID(), tokenDigest: hash(token), state: 'pending', note: note === undefined ? null : text(note, 'note'), createdAt: at };
      run.history.push({ action: 'handoff-export', id: run.handoff.id, sequence: ++db.sequence, actor: actor.id, at });
      const view = this.view(run);
      return { handoff: run.handoff, objective: db.intents && Object.values(db.intents).find(x => x.runId === runId)?.objective || null,
        items: view.items.map(x => ({ id: x.id, title: x.title, status: x.status, generation: x.generation })),
        heads: Object.values(run.members).filter(x => x.position === 'head' && !x.retired).map(x => ({ role: x.role, memberId: x.id, dispatchId: x.dispatchId, scopes: x.scopes })),
        pending: handoffPending(run), project: run.project };
    });
    return { kind: 'edict-handoff', version: 1, id: exported.handoff.id, token, session: this.session, edictHome: path.resolve(home()), runId,
      createdAt: exported.handoff.createdAt, note: exported.handoff.note, objective: exported.objective, project: exported.project,
      items: exported.items, heads: exported.heads, pending: exported.pending };
  }
  handoffCancel(runId) {
    return this.mutate(runId, (run, actor, db) => {
      if (actor.id !== 'root') fail('只有目前協調此 Run 的對話可以撤回交棒');
      if (run.handoff?.state !== 'pending') fail(run.handoff && ['accepting', 'unknown'].includes(run.handoff.state) ? '接手對話已送出原生接手，結果未確認；不能撤回' : '沒有待接手的交棒');
      run.handoff.state = 'revoked'; run.handoff.revokedAt = new Date().toISOString();
      run.history.push({ action: 'handoff-revoked', id: run.handoff.id, sequence: ++db.sequence, actor: actor.id, at: run.handoff.revokedAt });
      return { handoff: run.handoff };
    }, { active: false });
  }
  handoffAccept(packet) {
    if (!packet || packet.kind !== 'edict-handoff' || packet.version !== 1 || packet.session !== this.session) fail('交棒檔格式不正確或不屬於此 Edict 對話身分');
    const runId = text(packet.runId, 'runId'), token = text(packet.token, 'token');
    requireActive(this.session);
    handoffFor(this.run(runId), packet, token);
    let before = null;
    try { before = this.runtime.identity(runId); } catch { /* An unbound conversation is the expected receiver. */ }
    if (before?.owner) fail('目前對話已是此 Run 的協調者；交棒須由另一個對話接手');
    if (before) fail('執行代理不能接手協調者職責');
    const current = this.runtime.currentRun();
    if (current && current !== runId) fail(`此對話正在協調 Run ${current}；Orca run-use 會解除該綁定。請在尚未協調任何 Run 的對話接手`);
    const requestId = transaction(db => {
      const run = getRun(db, this.session, runId), handoff = handoffFor(run, packet, token);
      const others = otherOpenRuns(db, this.session, runId);
      if (others.length) fail(`本對話另有未結束的 Run：${others.join(', ')}；交棒沒有套用`);
      // A retried accept reuses the request ID so Orca deduplicates the takeover instead of applying it twice.
      handoff.requestId ??= randomUUID(); handoff.state = 'accepting'; handoff.acceptingAt = new Date().toISOString();
      return handoff.requestId;
    });
    let receipt, owner = false;
    try { receipt = this.runtime.takeover(runId, requestId); owner = this.runtime.identity(runId).owner === true; }
    catch (error) {
      transaction(db => { const handoff = getRun(db, this.session, runId).handoff; handoff.state = 'unknown'; handoff.error = error.message; handoff.rawReceipt = error.receipt || null; });
      throw error;
    }
    if (!owner) {
      transaction(db => { const handoff = getRun(db, this.session, runId).handoff; handoff.state = 'unknown'; handoff.error = 'run-use 後仍未確認目前對話是此 Run 的協調者'; });
      fail('Orca 未確認接手；保留交棒紀錄，以同一交棒檔再次 accept 核對，不另建交棒');
    }
    let coordinator = null;
    try { coordinator = this.runtime.coordinator(runId); } catch { /* The binding is already proven by identity. */ }
    const accepted = transaction(db => {
      const run = getRun(db, this.session, runId), handoff = run.handoff, at = new Date().toISOString();
      Object.assign(handoff, { state: 'accepted', acceptedAt: at, coordinator, receipt, error: null });
      const archived = Object.values(db.runs).filter(x => x.session === this.session && x.id !== runId && !x.archived && runSettled(x));
      for (const other of archived) other.archived = { handoff: handoff.id, at };
      run.history.push({ action: 'handoff-accept', id: handoff.id, coordinator, archivedRuns: archived.map(x => x.id), sequence: ++db.sequence, actor: 'root', at });
      return { handoff, archivedRuns: archived.map(x => x.id), pending: handoffPending(run) };
    });
    const session = readSession(this.session);
    session.runId = runId;
    session.handoffs = [...(session.handoffs || []), { id: accepted.handoff.id, runId, acceptedAt: accepted.handoff.acceptedAt, coordinator }];
    let sessionIndexError = null;
    try { writeSession(session); } catch (error) { sessionIndexError = error.message; }
    return { ...accepted, runId, session: this.session, sessionIndexError };
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
        reads: safeRanges(data.reads || ['*'], 'reads'), extraReads: extraReadList(data.extraReads), writes: safeRanges(data.writes || [], 'writes'), resources: resourceList(data.resources || [], 'resources'),
        acceptance: list(data.acceptance, 'acceptance'), paused: false, cancelled: false, done: false, plan: null, result: null, authors: [] };
      if (!item.acceptance.length) fail('工作必須有驗收條件');
      run.items[id] = item; return item;
    });
  }
  // Root-only requirement amendment: replace resources and/or widen reads and extraReads; writes never change. Any
  // current plan is cleared (and the revision bumped) so Zhongshu resubmits and Menxia re-reviews before delegation.
  amend(runId, work, data) {
    return this.mutate(runId, (run, actor, db) => {
      if (actor.id !== 'root') fail('只有原對話（原協調者）可以修訂需求');
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail('需求修訂輸入必須是 JSON 物件，含 generation、reason 及 resources、reads 或 extraReads');
      if (Object.hasOwn(data, 'writes')) fail('需求的 writes 不能修訂；需要新的寫入範圍時請建立新工作項目');
      const fields = ['resources', 'reads', 'extraReads'];
      const extra = Object.keys(data).filter(key => !['generation', 'reason', ...fields].includes(key));
      if (extra.length) fail(`需求修訂只接受 generation、resources、reads、extraReads、reason；不接受 ${extra.join(', ')}`);
      if (!fields.some(key => data[key] !== undefined)) fail('需求修訂至少須提供 resources、reads 或 extraReads');
      const item = itemFor(run, work);
      if (item.done || item.cancelled || run.cancelled || run.enabled === false) fail('工作已結案、取消或停用；需求修訂沒有套用');
      generationFor(item, data.generation);
      const reason = text(data.reason, 'reason'), next = {};
      if (data.resources !== undefined) next.resources = resourceList(data.resources, 'resources');
      if (data.reads !== undefined) {
        next.reads = safeRanges(data.reads, 'reads');
        if (!subset(item.reads, next.reads)) fail('reads 只能擴大：新的 reads 必須涵蓋目前所有 reads，不能縮小');
      }
      if (data.extraReads !== undefined) {
        next.extraReads = extraReadList(data.extraReads);
        if (!extraSubset(item.extraReads || [], next.extraReads)) fail('extraReads 只能擴大：新的清單必須涵蓋目前每個根目錄及其 reads，不能縮小');
      }
      if (outstanding(run, item).some(x => x.position === 'executor')) fail('本世代仍有在途或未確認的執行代理操作；先 sync 或等其收斂再修訂需求');
      // Clearing the plan would orphan a delivered result (closure only counts the new revision), so refuse instead.
      if (item.result || Object.values(run.operations).some(x => x.work === item.id && x.generation === item.generation && x.revision === item.revision && x.position === 'executor' && x.phase === 'implementation' && x.result)) fail('本世代已有交付成果；修訂需求會使已完成成果失效。請以 control cancel／restart 重新授權，或建立新工作項目');
      const changes = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, { from: item[key] || [], to: value }]));
      const clearedPlan = item.plan ? { revision: item.plan.revision, digest: item.plan.digest } : null;
      Object.assign(item, next);
      // Bump the revision with the cleared plan so stale same-revision executors take the archived-only result path.
      if (item.plan) { item.plan = null; item.result = null; item.revision++; }
      const record = { action: 'amend', work, generation: item.generation, changes, reason, clearedPlan, sequence: ++db.sequence, actor: actor.id, at: new Date().toISOString() };
      run.history.push(record);
      return { item, amendment: record, next: clearedPlan ? '方案與核可已清除；中書須依修訂後的需求重新提交方案並由門下重新審查' : '中書提交方案時可宣告修訂後的範圍' };
    });
  }
  plan(runId, work, data) {
    return this.mutate(runId, (run, actor) => {
      roleIs(actor, 'zhongshu'); isHead(actor); const item = itemFor(run, work); controlAllowed(run, item);
      generationFor(item, data.generation);
      const plan = { description: text(data.description, 'description'), reads: safeRanges(data.reads || item.reads, 'reads'),
        extraReads: data.extraReads === undefined ? item.extraReads || [] : extraReadList(data.extraReads), writes: safeRanges(data.writes || [], 'writes'),
        resources: resourceList(data.resources || [], 'resources'), acceptance: list(data.acceptance || item.acceptance, 'acceptance'), dependencies: list(data.dependencies || [], 'dependencies'), author: actor.id };
      if (!subset(plan.reads, item.reads) || !extraSubset(plan.extraReads, item.extraReads || []) || !subset(plan.writes, item.writes) || !resourceSubset(plan.resources, item.resources)) fail('方案超出需求授權範圍');
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
        if (designOnly(item)) {
          // A design-only item (no writes, nothing delivered) closes on its approved plan: the plan is the deliverable.
          if (!item.plan || data.digest !== item.plan.digest || !approval(run, item) || item.plan.author === actor.id) fail('設計型工作缺少已核可的方案或摘要不符');
          if (outstanding(run, item).some(x => x.writes.length || x.position === 'executor')) fail('在途工作尚未收斂');
        } else {
          if (!item.result || data.digest !== item.result.digest || !validEvidence(item.result.files) || !approval(run, item) || !deliveryComplete(run, item)) fail('缺少有效方案、完整交付或成果');
          const accepted = run.decisions.findLast(x => x.kind === 'artifact-acceptance' && x.work === work && x.generation === item.generation && x.digest === item.result.digest);
          if (!accepted || accepted.verdict !== 'approved' || !validEvidence(accepted.evidence) || outstanding(run, item).some(x => x.writes.length || x.position === 'executor')) fail('獨立驗收或在途工作尚未收斂');
        }
        if (data.verdict === 'approved') item.done = true;
      } else fail('未知審查種類');
      const record = { id: randomUUID(), kind, work, generation: item.generation, digest: data.digest, verdict: data.verdict, actor: actor.id, evidence: proof, reason: data.reason || '', at: new Date().toISOString() };
      run.decisions.push(record); return record;
    });
  }
  prepare(runId, role, position, work, data) {
    return this.mutate(runId, (run, actor, db, evidence) => {
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
      const extraReads = position === 'head' ? [] : data.extraReads === undefined ? item?.plan?.extraReads || item?.extraReads || [] : extraReadList(data.extraReads);
      const resources = position === 'head' ? [] : resourceList(data.resources || item?.plan?.resources || [], 'resources');
      if (!item && extraReads.length) fail('extraReads 只能用於已授權的工作項目');
      if (item && (!subset(writes, item.plan?.writes || item.writes) || !subset(reads, item.plan?.reads || item.reads) || !extraSubset(extraReads, item.plan?.extraReads || item.extraReads || []) || !resourceSubset(resources, item.plan?.resources || item.resources))) fail('委派超出已核可範圍');
      const replaces = data.replaces ? run.operations[data.replaces] : null;
      if (data.replaces && (!replaces || replaces.state !== 'refused' || replaces.rawReceipt?.error?.data?.effectsApplied !== false || replaces.actorId !== actor.id || replaces.work !== work || replaces.generation !== item?.generation || replaces.revision !== item?.revision || replaces.role !== role || replaces.position !== position || replaces.phase !== phase || !subset(replaces.writes, writes) || !subset(writes, replaces.writes) || !subset(replaces.reads, reads) || !subset(reads, replaces.reads) || !subset(replaces.resources, resources) || !subset(resources, replaces.resources) || JSON.stringify(replaces.extraReads || []) !== JSON.stringify(extraReads))) fail('只能明確取代自己同階段、同範圍、同世代且原生已證明無副作用的拒絕操作');
      const deps = item?.plan?.dependencies || [];
      if (deps.some(id => !run.items[id].done)) fail('前置工作尚未結案；未送出原生派工');
      const worktree = data.worktree || 'current';
      if (!['current', 'new-child'].includes(worktree) && !worktree.startsWith('path:')) fail('工作樹必須為 current、new-child 或既有 path');
      const root = worktree === 'current' ? run.project : worktree.startsWith('path:') ? worktree.slice(5) : null;
      const shape = { physicalReads: mergeGeometry(geometry(root, reads), extraGeometry(extraReads)), physicalWrites: geometry(root, writes) };
      claim(db, { runId, position, reads, extraReads, writes, resources, ...shape }, undefined, evidence);
      const member = { id: randomUUID(), role, position, title: position === 'head' ? ROLES[role].head : ROLES[role].executor,
        supervisor: actor.id, scopes: role === 'zhongshu' && position === 'head' ? ['*'] : work ? [work] : [], dispatches: [], dispatchId: null, generation: 1 };
      const session = requireActive(this.session), settings = resolveSettings(session.config, role, position);
      const op = { id: randomUUID(), requestId: randomUUID(), memberId: member.id, actorId: actor.id, role, position, runId, work: work || null, generation: item?.generation || 0,
        revision: item?.revision || 0, writes, reads, extraReads, resources, worktree, root, ...shape, settings, state: 'submitted', sequence: ++db.sequence,
        spec: text(data.spec, 'spec'), title: data.title === undefined ? null : displayText(text(data.title, 'title')),
        phase, operationKind: 'start', replaces: replaces?.id || null, planDigest: item?.plan?.digest || null, controlRevision: run.controlRevision };
      run.members[member.id] = member; run.operations[op.id] = op;
      if (op.phase === 'implementation') item.authors.push(member.id);
      return { operation: op, member };
    }, { capacity: true, preflight: (prepared, run) => this.preflightStart(prepared, run) });
  }
  launch(runId, role, position, work, data) {
    const prepared = this.prepare(runId, role, position, work, data);
    if (prepared.existing) return { ...prepared, member: prepared.existing };
    return this.startPrepared(runId, prepared);
  }
  // A supervisor hands a settled member's assignment to a new native worker that uses the current role settings,
  // for example after config set switched the agent or model, or when the member's context is exhausted.
  replace(runId, memberId, data) {
    const prepared = this.mutate(runId, (run, actor, db, evidence) => {
      isHead(actor);
      const target = run.members[memberId];
      if (!target || target.id === 'root' || !['head', 'executor'].includes(target.position)) fail('找不到可換手的團隊成員');
      if (target.retired) fail('此成員已停用或已被換手');
      if (target.supervisor !== actor.id) fail('只有此成員的直接上級可以換手');
      if (!target.dispatchId) fail('此成員尚未取得原生 Dispatch；先 recover 原操作');
      if (Object.values(run.operations).some(x => x.memberId === target.id && ['submitted', 'unknown', 'accepted'].includes(x.state))) fail('原成員仍在執行或結果未確認；等它回報結束並 sync 後再換手，不同時保留兩位執行者');
      if (Object.values(run.operations).some(x => x.actorId === target.id && ['submitted', 'unknown'].includes(x.state))) fail('原成員發起的操作結果未確認；須由原成員 recover 後再換手');
      if (run.messages.some(x => x.from === target.id && ['submitted', 'unknown', 'forwarding', 'owner-required'].includes(x.state))) fail('原成員的交接訊息尚未送達或待 owner 轉交；先處理後再換手');
      const previous = Object.values(run.operations).findLast(x => x.memberId === target.id && x.state === 'settled');
      const work = target.position === 'executor' ? previous?.work : null;
      const item = work ? itemFor(run, work) : null;
      controlAllowed(run, item);
      if (target.position === 'executor') {
        if (!previous || !item) fail('找不到原執行代理已結束的委派');
        generationFor(item, data.generation);
        if (previous.generation !== item.generation || previous.revision !== item.revision) fail('換手不能跨工作世代或已變更方案；須建立新的明確委派');
        if (!['zhongshu', 'menxia'].includes(target.role) && !approval(run, item)) fail('缺少門下對目前方案的正式核可');
        if ((item.plan?.dependencies || []).some(id => !run.items[id].done)) fail('前置工作尚未結案；未送出原生派工');
      }
      const scope = target.position === 'executor' ? previous : { reads: [], extraReads: [], writes: [], resources: [], worktree: 'current', root: run.project, physicalReads: geometry(run.project, []), physicalWrites: geometry(run.project, []) };
      claim(db, { runId, position: target.position, reads: scope.reads, extraReads: scope.extraReads || [], writes: scope.writes, resources: scope.resources, physicalReads: scope.physicalReads, physicalWrites: scope.physicalWrites }, target.id, evidence);
      const session = requireActive(this.session), settings = resolveSettings(session.config, target.role, target.position);
      const member = { id: randomUUID(), role: target.role, position: target.position, title: target.title, supervisor: target.supervisor,
        scopes: [...target.scopes], dispatches: [], dispatchId: null, generation: 1, replaces: target.id };
      const handover = `接手說明：你接替成員 ${target.id}（${target.title}）的${work ? ` ${work} ` : ''}職務；原成員已結束並將停用。先讀 work show 中原成員的 operations、messages 與 decisions 了解進度，再依本角色指引繼續。`;
      const op = { id: randomUUID(), requestId: randomUUID(), memberId: member.id, actorId: actor.id, role: target.role, position: target.position, runId, work,
        generation: item?.generation || 0, revision: item?.revision || 0, writes: scope.writes, reads: scope.reads, extraReads: scope.extraReads || [], resources: scope.resources,
        worktree: scope.worktree, root: scope.root, physicalReads: scope.physicalReads, physicalWrites: scope.physicalWrites, settings, state: 'submitted', sequence: ++db.sequence,
        spec: `${text(data.spec, 'spec')}\n\n${handover}`, title: previous?.title || null, phase: target.position === 'head' ? 'coordination' : previous.phase,
        operationKind: 'replacement', replacesMember: target.id, supersedes: previous?.id || null, replaces: null, planDigest: item?.plan?.digest || null, controlRevision: run.controlRevision };
      run.members[member.id] = member; run.operations[op.id] = op;
      if (op.phase === 'implementation') item.authors.push(member.id);
      run.history.push({ action: 'replace', member: target.id, by: member.id, operation: op.id, settings, sequence: db.sequence, actor: actor.id, at: new Date().toISOString() });
      return { operation: op, member };
    }, { capacity: true, preflight: (prepared, run) => this.preflightStart(prepared, run) });
    return this.startPrepared(runId, prepared);
  }
  preflightStart(prepared, run) {
    if (prepared.existing) return;
    const op = prepared.operation;
    preflightNative(startArgs(run.id, op.settings, { worktree: op.worktree, title: memberSummary(run, prepared.member).label }, op.requestId));
  }
  startPrepared(runId, prepared) {
    const op = prepared.operation;
    const spec = workerSpec(op.role, op.spec, this.run(runId).project, { position: op.position, session: this.session, runId, memberId: op.memberId, work: op.work || undefined, phase: op.phase, stateHome: home() });
    let receipt;
    try { receipt = this.runtime.start(runId, op.settings, spec, { worktree: op.worktree, title: memberSummary(this.run(runId), prepared.member).label }, op.requestId); }
    catch (error) {
      transaction(db => {
        const run = getRun(db, this.session, runId), stored = run.operations[op.id];
        const refused = error.receipt?.ok === false && error.receipt.error?.data?.effectsApplied === false;
        stored.state = refused ? 'refused' : 'unknown'; stored.error = error.message; stored.rawReceipt = error.receipt || null;
        if (refused) stored.effectsApplied = false;
        if (refused) run.members[stored.memberId].retired = true;
      });
      throw error;
    }
    return this.recordReceipt(runId, op.id, receipt);
  }
  // Orca delivers a continuation to an executor whose follow-up Dispatch is still open as a plain message: the
  // receipt names the target only as message.to_handle = "dispatch:<id>" and carries no Task pair. Resolve that
  // Dispatch natively so the member rebinds to it; anything unverifiable stays message-only (→ unknown).
  resolveDeliveryTarget(op, receipt) {
    if (!op || op.operationKind !== 'continuation' || op.position !== 'executor') return receipt;
    if (receipt?.dispatchId !== undefined || receipt?.taskId !== undefined) return receipt;
    const target = /^dispatch:(.+)$/.exec(receipt?.message?.to_handle || '');
    if (!target) return receipt;
    try {
      const dispatch = this.runtime.dispatch(target[1]);
      if (dispatch.runId !== op.runId) return receipt;
      return { ...receipt, dispatchId: dispatch.id, taskId: dispatch.taskId, runId: dispatch.runId };
    } catch { return receipt; }
  }
  recordReceipt(runId, operationId, receipt) {
    const current = this.run(runId).operations[operationId];
    receipt = this.resolveDeliveryTarget(current, receipt);
    let root = current?.root, rootError;
    if (current?.worktree === 'new-child' && !root) {
      try { root = this.runtime.worktreeRoot(receipt); } catch (error) { rootError = error.message; }
    }
    const result = transaction(db => {
      const run = getRun(db, this.session, runId), op = run.operations[operationId];
      if (op && root) { op.root = root; op.physicalReads = mergeGeometry(geometry(root, op.reads), extraGeometry(op.extraReads || [])); op.physicalWrites = geometry(root, op.writes); }
      if (op && rootError) op.rootError = rootError;
      return finalizeReceipt(run, operationId, receipt);
    });
    if (result.cancelPending) result.stops = this.drainStops(runId);
    if (result.confirmed && result.member) result.presentation = this.present(runId, result.member.id);
    return result;
  }
  present(runId, memberId) {
    const run = this.run(runId), member = run.members[memberId];
    if (!member?.dispatchId) return null;
    const { label } = memberSummary(run, member);
    if (member.presentation?.state === 'applied' && member.presentation.dispatchId === member.dispatchId && member.presentation.label === label) return member.presentation;
    let result;
    try { result = this.runtime.rename(runId, member.dispatchId, label); }
    catch (error) { result = { state: 'unconfirmed', error: error.message }; }
    const presentation = { ...result, label, dispatchId: member.dispatchId };
    transaction(db => {
      const current = getRun(db, this.session, runId).members[memberId];
      if (current.dispatchId === member.dispatchId) current.presentation = presentation;
    });
    return presentation;
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
  message(runId, targetId, work, body, forwardId, expectedGeneration, kind = 'handoff', relay = false) {
    if (!['handoff', 'report'].includes(kind)) fail('訊息種類必須為 handoff 或 report');
    const prepared = this.mutate(runId, (run, actor, db, evidence) => {
      isHead(actor); const target = run.members[targetId];
      if (!target?.dispatchId) fail('目標成員尚未取得原生 Dispatch');
      if (target.retired) fail(target.replacedBy ? `目標成員已換手給 ${target.replacedBy}；改送新成員` : '目標成員已停用');
      const item = work ? itemFor(run, work) : null;
      if (kind === 'handoff') controlAllowed(run, item);
      if (kind === 'report' && target.position !== 'head') fail('只讀回報只能送既有頭領，不能啟動執行工作');
      if (item) generationFor(item, expectedGeneration);
      let source = actor;
      if (forwardId) {
        roleIs(actor, 'taizi');
        const original = run.messages.find(x => x.id === forwardId && x.state === 'owner-required');
        if (!original || original.to !== targetId || original.work !== work || original.body !== body || original.generation !== (item?.generation || 0)) fail('沒有可由 owner 原樣轉交的有效世代交接');
        if (relay && original.relayAttempt) fail('relay 已嘗試此訊息；交由人工處理，不重送');
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
      const claims = target.position === 'executor' ? previous : { reads: [], extraReads: [], writes: [], resources: [], physicalReads: geometry(run.project, []), physicalWrites: geometry(run.project, []) };
      claim(db, { ...claims, runId, position: target.position }, target.id, evidence);
      const record = { id: randomUUID(), requestId: randomUUID(), kind, from: source.id, to: targetId, work: work || null, generation: item?.generation || 0, revision: item?.revision || 0, body: text(body, 'body'), forwardOf: forwardId || null, state: 'submitted', sequence: ++db.sequence };
      // Commit the attempt with the existing forward admission, before native I/O.
      if (relay) run.messages.find(x => x.id === forwardId).relayAttempt = { forwardedMessageId: record.id, at: new Date().toISOString() };
      run.messages.push(record);
      run.operations[record.id] = { id: record.id, operationKind: 'continuation', supersedes: previous.id, memberId: target.id,
        role: target.role, position: target.position, actorId: actor.id, runId, requestId: record.requestId,
        settings: previous.settings, phase: previous.phase, spec: record.body, title: previous.title, worktree: previous.worktree, root: previous.root,
        reads: claims.reads, extraReads: claims.extraReads || [], writes: claims.writes, resources: claims.resources, physicalReads: claims.physicalReads, physicalWrites: claims.physicalWrites,
        planDigest: item?.plan?.digest || null, work: work || null, generation: item?.generation || 0, revision: item?.revision || 0,
        state: 'submitted', sequence: record.sequence, result: null, receipt: null };
      const previousResult = item?.result;
      if (item && target.position === 'executor') item.result = null;
      return { record, target, previousResult };
    }, { active: kind !== 'report', capacity: true, preflight: prepared =>
      preflightNative(sendArgs(runId, prepared.target.dispatchId, prepared.record.body, prepared.record.requestId)) });
    let receipt;
    try { receipt = this.runtime.send(runId, prepared.target.dispatchId, prepared.record.body, prepared.record.requestId); }
    catch (error) {
      const ownerRequired = !forwardId && ownerRelayRequired(error);
      const refused = !ownerRequired && error.receipt?.ok === false && error.receipt.error?.data?.effectsApplied === false && error.receipt.error.data.spawn?.processStarted === false;
      transaction(db => {
        const run = getRun(db, this.session, runId), record = run.messages.find(x => x.id === prepared.record.id), op = run.operations[record.id];
        record.state = ownerRequired ? 'owner-required' : refused ? 'refused' : 'unknown'; record.error = error.message; record.rawReceipt = error.receipt || null;
        op.state = record.state; op.error = error.message; op.rawReceipt = error.receipt || null;
        if (refused) {
          op.effectsApplied = record.effectsApplied = false;
          if (op.work && prepared.previousResult) run.items[op.work].result = prepared.previousResult;
          if (forwardId) run.messages.find(x => x.id === forwardId).state = 'owner-required';
        }
      });
      if (ownerRequired) return { messageId: prepared.record.id, state: 'owner-required', next: '由原對話 team forward 原樣轉交；不重新判斷業務決定' };
      throw error;
    }
    const finalized = this.recordReceipt(runId, prepared.record.id, receipt);
    return { ...finalized.message, confirmed: finalized.confirmed, state: finalized.confirmed ? 'delivered' : 'unknown' };
  }
  forward(runId, messageId, relay = false) {
    const original = this.run(runId).messages.find(x => x.id === messageId);
    if (!original) fail('找不到交接');
    return this.message(runId, original.to, original.work, original.body, messageId, original.generation, original.kind || 'handoff', relay);
  }
  relay(runId, { stopped = () => false, onResult = () => {} } = {}) {
    const snapshot = this.run(runId);
    if (!this.runtime.identity(runId).owner) fail('只有原對話 owner 可以執行 relay');
    if (snapshot.archived) fail('此 Run 已封存，不能執行 relay');
    const results = [];
    const pending = handoffPending(snapshot).ownerRequired;
    // An interrupted/unknown forward is no longer owner-required. Surface its
    // durable attempt for human recovery as well, without making another call.
    pending.push(...snapshot.messages.filter(x => x.relayAttempt && x.state === 'forwarding').map(x => ({ messageId: x.id })));
    // runRelay keeps polling after a failed round only when no forward was attempted in that round.
    let attempted = false;
    try {
    for (const { messageId } of pending) {
      if (stopped()) break;
      const original = this.run(runId).messages.find(x => x.id === messageId);
      if (original.state !== 'owner-required' && !(original.relayAttempt && original.state === 'forwarding')) continue;
      let error;
      if (!original.relayAttempt && original.state === 'owner-required') {
        attempted = true;
        try { this.forward(runId, messageId, true); }
        catch (failure) {
          error = failure.message;
          // Preflight/admission failures have no forward record. Persist a marker
          // only for that case so later rounds and processes never retry them.
          if (!this.run(runId).messages.find(x => x.id === messageId).relayAttempt) this.mutate(runId, run => {
            const saved = run.messages.find(x => x.id === messageId);
            if (!saved.relayAttempt && saved.state === 'owner-required') saved.relayAttempt = { forwardedMessageId: null, error, at: new Date().toISOString() };
          }, { active: false });
        }
      }
      const run = this.run(runId), saved = run.messages.find(x => x.id === messageId);
      const forwarded = run.messages.find(x => x.id === saved.relayAttempt?.forwardedMessageId);
      const state = forwarded?.state === 'submitted' ? 'unknown' : forwarded?.state || 'refused';
      const row = { messageId, forwardedMessageId: forwarded?.id || null,
        nativeMessageId: forwarded?.receipt?.messageId || forwarded?.receipt?.message?.id || null,
        state, originalState: saved.state, manualRequired: state !== 'delivered',
        skipped: !!original.relayAttempt, error: forwarded?.error || saved.relayAttempt?.error || error || null,
        note: state === 'delivered' ? `已由 relay 轉送 ${forwarded.id}` : 'relay 不重送；交由人工核對或 recover' };
      results.push(row); onResult(row);
    }
    } catch (error) {
      if (attempted && error && typeof error === 'object') error.relayForwardAttempted = true;
      throw error;
    }
    return results;
  }
  recover(runId, operationId) {
    const run = this.run(runId), actor = memberFor(run, this.runtime.identity(runId)), op = run.operations[operationId];
    if (!op || op.actorId !== actor.id) fail('只能以原呼叫身分查核此操作；不猜測或改 ID 重送');
    const request = this.runtime.request(op.requestId);
    const message = run.messages.find(x => x.id === operationId);
    const legacyCommand = /^(.+) orchestration send：spawnSync \1 ENAMETOOLONG；沒有改用其他 Orca 入口，也沒有重試$/u.exec(op.error || '')?.[1];
    const legacyTarget = run.operations[op.supersedes]?.dispatchId;
    // Legacy runOrca errors discarded the structured spawn result. Require the exact wrapper,
    // an absent native request, and an argv exceeding the OS hard limit, not our safety margin.
    const legacyTooLong = process.platform === 'win32' && op.state === 'unknown' && op.operationKind === 'continuation' &&
      !op.receipt && !op.rawReceipt && request.state === 'absent' && message?.requestId === op.requestId &&
      message.body === op.spec && typeof message.body === 'string' &&
      legacyCommand && validId(legacyTarget) &&
      windowsCommandLength(legacyCommand, nativeArgs(sendArgs(runId, legacyTarget, message.body, op.requestId))) > 32767;
    const refusal = transaction(db => {
      const saved = getRun(db, this.session, runId), operation = saved.operations[operationId]; operation.recovery = request;
      if (operation.rawReceipt?.ok === false && operation.rawReceipt.error?.data?.effectsApplied === false || legacyTooLong) {
        operation.state = 'refused'; operation.effectsApplied = false;
        if (legacyTooLong) operation.rawReceipt = { ok: false, error: { code: 'ENAMETOOLONG', data: { effectsApplied: false, proof: 'legacy-spawn-error-and-argv-over-hard-limit' } } };
        if (operation.operationKind === 'continuation') {
          const record = saved.messages.find(x => x.id === operationId);
          if (record) {
            record.state = 'refused'; record.effectsApplied = false; record.rawReceipt = operation.rawReceipt;
            if (record.forwardOf) saved.messages.find(x => x.id === record.forwardOf).state = 'owner-required';
          }
        } else saved.members[operation.memberId].retired = true;
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
    // A message-only receipt was already saved as unknown; re-finalize it so a delivery target that resolves now
    // (the follow-up Dispatch Orca delivered to) can bind the member without resending anything.
    if (!receipt && op.state === 'unknown' && op.receipt) receipt = op.receipt;
    if (receipt) return this.recordReceipt(runId, operationId, receipt);
    return { request, operationId, state: op.state, next: '原生結果尚未核對；保留占用，不重新派工' };
  }
  // Records native worker rows and settles operations whose execution natively ended. Returns the operations that
  // changed to settled in this call. Used by sync and by every relay round so finished executors free capacity.
  // onlyChanges (relay) skips the write transaction when no operation would change to settled.
  settle(runId, { onlyChanges = false } = {}) {
    const rows = this.runtime.workers(runId);
    const followUps = followUpSettlements(rows, this.runtime, runId);
    const ends = row => executionSettled(row) || followUps.has(row.dispatchId || row.id);
    if (onlyChanges) {
      const operations = Object.values(this.run(runId).operations);
      if (!rows.some(row => ends(row) && operations.some(op => op.dispatchId === (row.dispatchId || row.id) && op.state !== 'settled'))) return [];
    }
    return this.mutate(runId, run => {
      const settled = [];
      for (const row of rows) {
        const id = row.dispatchId || row.id;
        for (const op of Object.values(run.operations).filter(x => x.dispatchId === id)) {
          op.native = row;
          op.observedAt = new Date().toISOString();
          if (ends(row)) {
            if (op.state !== 'settled') settled.push({ operationId: op.id, dispatchId: id, memberId: op.memberId, role: op.role, position: op.position, previousState: op.state, nativeState: row.workerState || row.state || row.status || null });
            op.state = 'settled'; op.stopRequested = false;
            if (followUps.has(id)) op.settlementEvidence = followUps.get(id);
          }
        }
      }
      return settled;
    }, { active: false });
  }
  // Read-only unless unstick: finds in-flight Dispatches whose prompt is held unsent in the composer (draft), whose
  // terminal shows the agent's "Update available" prompt, or whose screen shows a selection or approval prompt.
  // With unstick, one bare CR is sent only for a live draft that matches this Dispatch's own prompt (Orca preamble,
  // Orca wake-up notice, or the operation spec), with no prompt on screen, at most once per Dispatch per caller Set.
  stalls(runId, { unstick = false, submitted = new Set() } = {}) {
    const snapshot = this.run(runId);
    if (!this.runtime.identity(runId).owner) fail('只有原對話 owner 可以檢查或解除卡住的派工');
    const targets = new Map();
    for (const op of Object.values(snapshot.operations)) {
      if (!['submitted', 'accepted'].includes(op.state) || !validId(op.dispatchId)) continue;
      const target = targets.get(op.dispatchId) || { dispatchId: op.dispatchId, operationIds: [], memberId: op.memberId, role: op.role, position: op.position, work: op.work || null };
      target.operationIds.push(op.id); targets.set(op.dispatchId, target);
    }
    return [...targets.values()].map(target => {
      let evidence;
      try { evidence = this.runtime.stallEvidence(runId, target.dispatchId); }
      catch (error) { return { ...target, findings: [], error: error.message }; }
      const findings = [...(evidence.draft ? ['draft'] : []), ...(evidence.updatePrompt ? ['update-prompt'] : []),
        ...(evidence.menu && !evidence.updatePrompt || evidence.agentWait ? ['menu-prompt'] : [])];
      const specs = Object.values(snapshot.operations).filter(op => op.memberId === target.memberId).map(op => op.spec);
      const draftMatches = !!evidence.draft && dispatchDraft(evidence.draft, specs);
      const row = { ...target, ...evidence, draft: evidence.draft ? evidence.draft.slice(0, 200) : null, draftMatches, findings, unstick: null };
      if (unstick && evidence.draft) {
        const refuse = reason => { row.unstick = { sent: false, reason }; };
        if (evidence.liveness !== 'live') refuse(`liveness=${evidence.liveness}；未送出`);
        else if (!draftMatches) refuse('輸入框內容不符合本 Dispatch 的派工提示，可能是人工輸入；只回報，未送出');
        else if (evidence.updatePrompt || evidence.menu || evidence.agentWait) refuse('畫面有更新、選單或待人工回應的提示；先由人工處理，未送出');
        else if (submitted.has(target.dispatchId)) refuse('本程序已對此 Dispatch 送過一次 CR；不再送出');
        else {
          submitted.add(target.dispatchId);
          try { row.unstick = this.runtime.submitDraft(runId, target.dispatchId, evidence.draft); }
          catch (error) { row.unstick = { sent: false, error: error.message }; }
        }
      }
      return row;
    });
  }
  sync(runId) {
    this.settle(runId);
    const stops = this.drainStops(runId);
    const presentations = Object.values(this.run(runId).members).filter(member => member.dispatchId).map(member => this.present(runId, member.id));
    return { ...this.show(runId), stops, presentations };
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
    return { ...run, items, hierarchy: hierarchy(run) };
  }
  show(runId) {
    const run = this.run(runId), actor = memberFor(run, this.runtime.identity(runId)), view = this.view(run);
    if (actor.scopes.includes('*')) return view;
    return { ...view, hierarchy: hierarchy(run, actor.scopes), items: view.items.filter(x => actor.scopes.includes(x.id)), operations: Object.fromEntries(Object.entries(view.operations).filter(([, x]) => actor.scopes.includes(x.work))) };
  }
}

export function assertWorkflowOwner(session, runtime = new NativeRuntime()) {
  // Runs archived by a handoff stay bound to the previous conversation in Orca and accept no changes.
  const runs = Object.values(readDb().runs).filter(x => x.session === session && !x.archived);
  for (const run of runs) if (!runtime.identity(run.id).owner) fail('只有此 Run 原協調者可以啟用或停用');
  return runs;
}

export function setWorkflowEnabled(session, enabled, runtime = new NativeRuntime()) {
  const runs = assertWorkflowOwner(session, runtime);
  if (!runs.length) return;
  transaction(db => { for (const run of Object.values(db.runs)) if (run.session === session && !run.archived) { run.enabled = enabled; run.controlRevision++; } });
}

export function workflowStatus(session) {
  return Object.values(readDb().runs).filter(x => x.session === session).map(x => ({ runId: x.id, paused: x.paused, cancelled: x.cancelled,
    archived: x.archived || null, handoff: x.handoff ? { id: x.handoff.id, state: x.handoff.state, createdAt: x.handoff.createdAt, acceptedAt: x.handoff.acceptedAt || null } : null,
    teams: Object.values(x.members).filter(m => m.position === 'head').map(m => ({ role: m.role, memberId: m.id, dispatchId: m.dispatchId })),
    hierarchy: hierarchy(x),
    items: Object.values(x.items).map(i => ({ id: i.id, title: i.title, done: i.done, paused: i.paused, cancelled: i.cancelled, generation: i.generation })) }));
}
