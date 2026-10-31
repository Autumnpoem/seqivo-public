import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { formatHandoffContext } from '../../server/terminal/handoff-context.mjs';
import { nativeSelectedIdentities } from '../../server/terminal/process-identities.mjs';
import { DEFAULT_BUDGET_MINUTES, validateBudgetMinutes, deadlineFor,
  budgetRemainingSeconds, automaticStop, planIntentForTask, validPlanIntent,
  samePlanIntent } from './auto-policy.mjs';
import { providerFailure, finalThreadCheck, publicCompletionDiagnostic } from './completion-diagnostics.mjs';
import { createBridgeDiagnostics, providerRequestDiagnostic } from './bridge-diagnostics.mjs';
import { captureCompletedConversation, completedConversationForTask,
  boundCompletedConversations, addCompletedConversation } from './completed-conversation-snapshot.mjs';
import { captureExecutorBaseline, captureTaskExecutorTree, verifyTaskExecutorRetired } from '../../server/executor-process-proof.mjs';
import { taskJobRecordRoot, auditTaskJobIndex, prepareTaskJob, recoverTaskJob,
  verifyTaskJobRetired, verifyTaskJobMarker, verifyHistoricalRetiredTaskJobMarker,
  currentTaskJobBoot, abandonPreparedTaskJob } from './job-transport.mjs';
import { linuxJobRecordRoot, auditLinuxJobIndex, prepareLinuxTaskJob,
  recoverLinuxTaskJob } from './linux-job-transport.mjs';

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url));
const UPSTREAM = {
  url: 'https://github.com/Autumnpoem/codex-autocontinue',
  commit: 'fa37ce7f2df1744119149edff661826c33611303',
};
const DEFAULT_CONFIG = { pythonPath: '', codexPath: '', graceSeconds: 30, pollSeconds: 60 };
const TERMINAL_TASKS = new Set(['submitted', 'cancelled']);
const ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
const MAX_CONVERSATION_MESSAGES = 80;
const MAX_CONVERSATION_TEXT = 6000;
const MAX_LIVE_THREADS = 5;
function publicText(value) {
  if (typeof value !== 'string') return '';
  return value.slice(0, MAX_CONVERSATION_TEXT)
    .replace(/(^|[\s=(])\/(?:[^\s"'`/]+\/)*[^\s"'`/]+/g, '$1[local path]')
    .replace(/\b[A-Za-z]:\\Users\\[^\s"']+/g, '[local path]')
    .replace(/Taskboard task ID:\s*[^\n]+/g, '');
}
function itemText(value) {
  if (typeof value === 'string') return publicText(value);
  if (Array.isArray(value)) return publicText(value.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n'));
  return '';
}
// App-server thread/read may omit text that is still being generated. Keep only
// two documented public delta event families, scoped to a taskboard-owned turn.
export function createPublicDeltaCache() {
  const threads = new Map();
  function add(event, commands, ownerTaskId = null) {
    const role = event?.method === 'item/agentMessage/delta' ? 'assistant'
      : event?.method === 'item/commandExecution/outputDelta' ? 'tool' : null;
    const { threadId, turnId, itemId, delta } = event?.params || {};
    if (!role || ![threadId, turnId, itemId, delta].every(value => typeof value === 'string' && value.length)
      || [threadId, turnId, itemId].some(value => value.length > 300) || delta.length > MAX_CONVERSATION_TEXT) return false;
    const command = Object.values(commands).find(c => (ownerTaskId === null || c.taskId === ownerTaskId) &&
      c.threadId === threadId && c.turnId === turnId && ['sending', 'running', 'awaiting_approval'].includes(c.status));
    if (!command) return false;
    const key = `${threadId}:${turnId}`;
    let entry = threads.get(key);
    if (!entry) {
      entry = { taskId: command.taskId, threadId, turnId, items: new Map() };
      threads.set(key, entry);
      while (threads.size > MAX_LIVE_THREADS) threads.delete(threads.keys().next().value);
    }
    if (entry.taskId !== command.taskId) return false;
    const item = entry.items.get(itemId) || { itemId, role, text: '' };
    if (item.role !== role) return false;
    item.text = (item.text + delta).slice(0, MAX_CONVERSATION_TEXT);
    entry.items.set(itemId, item);
    while (entry.items.size > MAX_CONVERSATION_MESSAGES) entry.items.delete(entry.items.keys().next().value);
    return true;
  }
  function forTask(task) {
    return [...threads.values()].filter(entry => entry.taskId === task.id && entry.threadId === task.conversationId);
  }
  function clear() { threads.clear(); }
  return { add, forTask, clear };
}
export function publicConversation(task, thread, commands, live = []) {
  const owned = new Map(Object.values(commands).filter(c => c.taskId === task.id && c.threadId === task.conversationId && c.turnId).map(c => [c.turnId, c]));
  const liveByTurn = new Map(live.filter(entry => entry.taskId === task.id && entry.threadId === task.conversationId).map(entry => [entry.turnId, entry]));
  const messages = [];
  const seenTurns = new Set();
  for (const turn of thread.turns || []) {
    seenTurns.add(turn.id);
    const command = owned.get(turn.id);
    const active = liveByTurn.get(turn.id);
    const seen = new Set();
    if (command?.displayText && !turn.items?.some(item => item?.type === 'userMessage')) {
      messages.push({ id: createHash('sha256').update(`${turn.id}:user`).digest('hex').slice(0, 20), role: 'user', text: publicText(command.displayText) });
    }
    for (let index = 0; index < (turn.items || []).length; index++) {
      const item = turn.items[index];
      if (!item || typeof item !== 'object') continue;
      if (typeof item.id === 'string') seen.add(item.id);
      let role, value;
      if (item.type === 'userMessage') { role = 'user'; value = command?.displayText || itemText(item.content) || itemText(item.text); }
      else if (item.type === 'agentMessage') { role = 'assistant'; value = itemText(item.text) || itemText(item.content); }
      else if (item.type === 'commandExecution') {
        role = 'tool';
        value = [item.command, item.aggregatedOutput, item.stdout, item.stderr].map(itemText).filter(Boolean).join('\n');
      } else if (item.type === 'fileChange') {
        role = 'tool'; value = 'Files changed: ' + (Array.isArray(item.changes) ? item.changes.length : 0);
      } else continue;
      const partial = typeof item.id === 'string' ? active?.items.get(item.id) : null;
      if (partial?.role === role && turn.status === 'inProgress') {
        const liveText = publicText(partial.text);
        if (role === 'assistant' && liveText.length > value.length && liveText.startsWith(value)) value = liveText;
        if (role === 'tool') {
          const readOutput = [item.aggregatedOutput, item.stdout, item.stderr].map(itemText).filter(Boolean).join('\n');
          if (liveText.length > readOutput.length && liveText.startsWith(readOutput)) value = [itemText(item.command), liveText].filter(Boolean).join('\n');
        }
      }
      value = publicText(value);
      if (value) messages.push({ id: createHash('sha256').update(`${turn.id}:${item.id || index}`).digest('hex').slice(0, 20), role, text: value, status: ['inProgress','completed','failed'].includes(item.status) ? item.status : undefined });
    }
    if (turn.status === 'inProgress' && active) for (const item of active.items.values()) {
      if (seen.has(item.itemId)) continue;
      const value = publicText(item.text);
      if (value) messages.push({ id: createHash('sha256').update(`${turn.id}:${item.itemId}`).digest('hex').slice(0, 20), role: item.role, text: value, status: 'inProgress' });
    }
  }
  if (thread.status?.type === 'active') for (const active of liveByTurn.values()) {
    if (seenTurns.has(active.turnId) || !owned.has(active.turnId)) continue;
    const command = owned.get(active.turnId);
    if (command.displayText) messages.push({ id: createHash('sha256').update(`${active.turnId}:user`).digest('hex').slice(0, 20), role: 'user', text: publicText(command.displayText) });
    for (const item of active.items.values()) {
      const value = publicText(item.text);
      if (value) messages.push({ id: createHash('sha256').update(`${active.turnId}:${item.itemId}`).digest('hex').slice(0, 20), role: item.role, text: value, status: 'inProgress' });
    }
  }
  let remaining=100000;
  const bounded=messages.slice(-MAX_CONVERSATION_MESSAGES).reverse().flatMap(message=>{
    if(remaining<=0)return [];
    const text=message.text.slice(0,remaining);remaining-=text.length;return [{...message,text}];
  }).reverse();
  const truncated = messages.length > bounded.length || remaining<=0;
  return { taskId: task.id, status: task.status, messages: bounded, updatedAt: task.updatedAt || iso(Date.now), truncated };
}

function epoch(now) {
  const value = now();
  return value instanceof Date ? value.getTime() : Number(value);
}

function iso(now) { return new Date(epoch(now)).toISOString(); }
function clone(value) { return structuredClone(value); }
function errorText(error) { return error instanceof Error ? error.message : String(error); }
function hasQuotaReason(task) { return /quota|rate.?limit|usage.?limit|额度|限额/i.test(String(task.blockedReason || '')); }
function validDirectory(value) { return typeof value === 'string' && value.trim() && resolve(value) === value; }
function originalJobWorkspace(marker, directory) {
  if (!validDirectory(directory) || marker?.workspace !== directory ||
      !validDirectory(marker.canonicalWorkspace)) return false;
  try { return realpathSync(directory) === marker.canonicalWorkspace; }
  catch { return false; }
}
function resultMatchesTaskContent(entry, task) {
  if (Number.isInteger(entry.startedContentVersion) && Number.isInteger(task.contentVersion)) {
    return entry.startedContentVersion === task.contentVersion;
  }
  if (Number.isInteger(entry.requestedContentVersion) && Number.isInteger(task.contentVersion) && entry.taskRevision === undefined) {
    return entry.requestedContentVersion === task.contentVersion && task.revision === entry.requestedRevision;
  }
  // Historical records have no content version: require their exact revision.
  const recordedRevision = Number.isInteger(entry.taskRevision) ? entry.taskRevision : entry.requestedRevision;
  return Number.isInteger(recordedRevision) && task.revision === recordedRevision;
}
function explicitExecutable(configured,baseDirectory) {
  return process.platform==='linux'&&typeof configured==='string'&&
    configured.includes('/')&&!isAbsolute(configured)
    ?resolve(baseDirectory,configured):configured;
}
function pythonExecutable(configured,baseDirectory=process.cwd()) {
  if (configured?.trim()) return explicitExecutable(configured.trim(),baseDirectory);
  if (process.env.TASKBOARD_PYTHON) return explicitExecutable(process.env.TASKBOARD_PYTHON,baseDirectory);
  const bundled = resolve(dirname(process.execPath), '../../python/bin/python3');
  if (existsSync(bundled)) return bundled;
  for (const name of process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']) {
    for (const directory of (process.env.PATH || '').split(delimiter)) {
      const candidate = join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Python 3 executable not found; configure pythonPath');
}

class Bridge {
  constructor({ pythonPath, codexPath, pluginDir, executableBaseDirectory=null, onEvent, onExit, job = null, diagnostic = () => {} }) {
    this.pythonPath = pythonPath;
    this.codexPath = codexPath;
    this.pluginDir = pluginDir;
    this.executableBaseDirectory = executableBaseDirectory;
    this.onEvent = onEvent;
    this.onExit = onExit;
    this.child = null;
    this.spawnedChild = null;
    this.pending = new Map();
    this.nextId = 0;
    this.openPromise = null;
    this.closing = false;
    this.stopPromise = null;
    this.dead = false;
    this.appServerPid = null;
    this.job = job;
    this.diagnostic = diagnostic;
    this.stopDiagnosticRecorded = false;
  }

  observeDiagnostic(event, fields = {}) {
    try { this.diagnostic({ ...fields, event }); } catch { /* Observation only. */ }
  }

  noteStop(reason, method = null, timeoutMs = null) {
    if (this.stopDiagnosticRecorded) return;
    this.stopDiagnosticRecorded = true;
    this.observeDiagnostic('first_stop', { reason, method, timeoutMs });
  }

  async open() {
    if (this.openPromise) return this.openPromise;
    this.openPromise = (async () => {
      const python = pythonExecutable(this.pythonPath,this.executableBaseDirectory||process.cwd());
      const child = this.job ? await (async () => {
        const launched = await this.job.spawn();
        this.spawnedChild = { pid: launched.identity.pid };
        return { stdin: launched.stdin, stdout: launched.stdout, stderr: launched.stderr };
      })() : spawn(python, ['-B', join(this.pluginDir, 'bridge.py')], {
        stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        detached: process.platform !== 'win32',
      });
      this.child = child;
      if (!this.job) this.spawnedChild = child;
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.event) {
          if (msg.event === 'closed') {
            this.dead = true;
            this.noteStop('provider_closed');
          }
          this.onEvent(msg);
          return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (pending.method === 'thread' && msg.error?.type === 'ThreadReadTimeout')
          this.observeDiagnostic('read_budget_exhausted', { method: 'thread' });
        msg.error ? pending.reject(new Error(`${msg.error.type || 'BridgeError'}: ${msg.error.message || 'bridge failed'}`)) : pending.resolve(msg.result);
      });
      let stderrTail = '';
      child.stderr.on('data', bytes => { stderrTail = (stderrTail + bytes.toString()).slice(-2048); });
      const fail = (error, reason) => {
        if (this.child !== child) return;
        this.noteStop(reason);
        this.child = null;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(error || new Error(`bridge exited: ${stderrTail || 'no detail'}`));
        }
        this.pending.clear();
        if (!this.closing) this.onExit(error || new Error(`bridge exited: ${stderrTail || 'no detail'}`));
      };
      if (this.job) {
        child.stdout.once('close', () => fail(new Error('task job bridge output closed'), 'stdout_closed'));
        child.stdout.once('error', error => fail(error, 'stream_error'));
        child.stderr.once('error', error => fail(error, 'stream_error'));
      } else {
        child.once('error', error => fail(error, 'process_error'));
        child.once('exit', (code, signal) => fail(new Error(`bridge exited (${code ?? signal}): ${stderrTail || 'no detail'}`), 'process_exit'));
      }
      const opened = await this.request('open', { codexPath: this.codexPath || null, timeoutSeconds: 8,
        ...(this.executableBaseDirectory?{executableBaseDirectory:this.executableBaseDirectory}:{}) }, 12000);
      if (!Number.isSafeInteger(opened?.appServerPid) || opened.appServerPid <= 0)
        throw new Error('Codex app-server PID was not verified by its bridge');
      this.appServerPid = opened.appServerPid;
      return this;
    })();
    try { return await this.openPromise; }
    catch (error) {
      // A task bridge must be captured against its prelaunch baseline before
      // shutdown. The owner handles this failure, even if initialize failed.
      if (this.ownerTaskId === null) await this.stop().catch(() => {});
      this.openPromise = null;
      throw error;
    }
  }

  request(method, fields = {}, timeoutMs = 12000) {
    if (!this.child || !this.child.stdin.writable) return Promise.reject(new Error('bridge unavailable'));
    const id = ++this.nextId;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.noteStop('request_timeout', method, timeoutMs);
        reject(new Error(`bridge timed out: ${method}`));
        this.stop().catch(stopError => this.onExit(stopError));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer, method });
      this.child.stdin.write(`${JSON.stringify({ id, method, ...fields })}\n`, error => {
        if (error && this.pending.has(id)) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.noteStop('explicit_stop');
    this.closing = true;
    const child = this.child || this.spawnedChild;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('bridge stopped'));
    }
    this.pending.clear();
    this.openPromise = null;
    if (this.job) {
      this.stopPromise = this.job.stop().then(result => {
        if (result?.verified !== true || result.retired !== true)
          throw new Error(result?.reason || 'Original task job retirement is unconfirmed');
        return result;
      });
      return this.stopPromise;
    }
    if (!child) return Promise.resolve();
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    const groupAlive = () => {
      if (process.platform === 'win32') return !exited();
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { if (error.code === 'ESRCH') return false; throw error; }
    };
    const waitExit = ms => exited() ? Promise.resolve(true) : new Promise(resolveWait => {
      const timer = setTimeout(() => { child.off('exit', onExit); resolveWait(false); }, ms);
      const onExit = () => { clearTimeout(timer); resolveWait(true); };
      child.once('exit', onExit);
      if (exited()) onExit();
    });
    const waitGroupExit = async ms => {
      const deadline = performance.now() + ms;
      // The bridge leader can exit before its app-server and command children.
      // Wait for the group as well, including the kernel's post-signal cleanup.
      while (true) {
        if (exited() && !groupAlive()) return true;
        const remaining = deadline - performance.now();
        if (remaining <= 0) return false;
        await new Promise(resolveWait => setTimeout(resolveWait, Math.min(25, remaining)));
      }
    };
    this.stopPromise = (async () => {
      // Give bridge.py a chance to close its app-server child itself.
      if (!exited() && child.stdin.writable) {
        try { child.stdin.write(`${JSON.stringify({ id: ++this.nextId, method: 'close' })}\n`); }
        catch { /* fallback below */ }
      }
      await waitExit(1500);
      if (process.platform === 'win32') {
        if (exited()) return;
        const treeResult = await new Promise(resolveKill => {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          const timer = setTimeout(() => {
            killer.kill();
            resolveKill({ error: new Error('taskkill timed out') });
          }, 1500);
          killer.once('error', error => { clearTimeout(timer); resolveKill({ error }); });
          killer.once('exit', code => { clearTimeout(timer); resolveKill({ code }); });
        });
        if (treeResult.error || treeResult.code !== 0) {
          if (exited()) return;
          child.kill();
          throw new Error(`Windows process-tree shutdown failed: ${treeResult.error?.message || `taskkill exited ${treeResult.code}`}`);
        }
        if (!(await waitExit(1500))) throw new Error('Windows process tree did not exit after taskkill');
      } else {
        if (groupAlive()) try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await waitGroupExit(1500);
        if (groupAlive()) try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await waitGroupExit(1500);
        if (groupAlive() || !exited()) throw new Error('Bridge process group did not exit');
      }
    })();
    return this.stopPromise;
  }
}

export function isUnresolvedShutdownTurn(command,intent,{allowUnknown=false}={}) {
  return !!command&&!!intent&&command.taskId===intent.taskId&&
    command.commandId===intent.commandId&&command.threadId===intent.threadId&&
    command.turnId===intent.turnId&&!!command.turnId&&
    command.bridgePid===intent.bridgePid&&command.workspace===intent.workspace&&
    (command.worktreeId||null)===(intent.worktreeId||null)&&
    (command.status==='running'||allowUnknown&&command.status==='unknown'||
      intent.stopCause==='provider_approval'&&command.status==='awaiting_approval')&&
    command.stopProof?.status!=='verified';
}

function isDisposedUnknownCommand(command) {
  const disposition=command?.disposition,receipt=disposition?.shutdownReceipt;
  return command?.status==='unknown'&&disposition?.version===1&&
    disposition.providerOutcome==='unknown'&&disposition.reason==='human_disposition'&&
    disposition.taskId===command.taskId&&disposition.commandId===command.commandId&&
    disposition.threadId===command.threadId&&disposition.turnId===command.turnId&&
    disposition.workspace===command.workspace&&
    (disposition.worktreeId||null)===(command.worktreeId||null)&&
    receipt?.taskId===command.taskId&&receipt.commandId===command.commandId&&
    receipt.threadId===command.threadId&&receipt.turnId===command.turnId&&
    receipt.bridgePid===command.bridgePid;
}

export function createPlugin({ dataDir, pluginDir = PLUGIN_DIR, executableBaseDirectory=null, getTask, getProject, resolveWorkspace, updateTask, authorizeExecution=async()=>{}, revalidateExecution=async()=>true, verifyRetirementWorkspace=null,
  verifyLinuxExecutorAdmission=null,verifyLinuxBridgeRetirementWorkspace=null,
  verifyLinuxJobRetirement=null,
  reserveExecutorStartup=null,bindExecutorStartup=null,confirmExecutorStartup=null,bindExecutorConversation=null,
  verifyExecutorStartup=null,retireExecutorStartup=null,disposeStoppedUnknownExecutor=null,emit = () => {}, now = Date.now,
  processProof = { captureExecutorBaseline, captureTaskExecutorTree, verifyTaskExecutorRetired },
  retireStop = candidate => candidate.stop(), taskJobBackend = undefined, beforeStateWrite = null }) {
  if (!dataDir || typeof getTask !== 'function' || typeof getProject !== 'function' || typeof updateTask !== 'function') {
    throw new TypeError('createPlugin requires dataDir, getTask, getProject and updateTask');
  }
  if (beforeStateWrite !== null && typeof beforeStateWrite !== 'function')
    throw new TypeError('beforeStateWrite must be a trusted local test callback');
  const trustedExecutableBase=process.platform==='linux'&&isAbsolute(executableBaseDirectory||'')
    ?executableBaseDirectory:null;
  const executableBase=trustedExecutableBase||process.cwd();
  const statePath = join(dataDir, 'codex-autocontinue.json');
  const bridgeDiagnostics = createBridgeDiagnostics(dataDir);
  // null is reserved for existing bridge-path tests. Production always uses
  // the original macOS job authority for writable task executors.
  const taskJobs = taskJobBackend === undefined ? {
    taskJobRecordRoot, auditTaskJobIndex, prepareTaskJob,
    recoverTaskJob, verifyTaskJobRetired, verifyTaskJobMarker,
    verifyHistoricalRetiredTaskJobMarker, currentTaskJobBoot, abandonPreparedTaskJob,
  } : taskJobBackend;
  let saved = { enabled: false, config: { ...DEFAULT_CONFIG }, policies: [], commands: {}, sessions: {},
    completedConversations: {}, executor: null, executors: {} };
  let initialized = false;
  let policyRecoveryPending = false;
  let jobIndexAudited = false;
  // The plan's own durable marker is the only proof that its first automatic
  // turn started. Caller-supplied manual command IDs and thread state cannot
  // establish plan ownership, even if an old ID looks like `auto-*`.
  const firstTurnProven = policy => policy?.initialTurnConfirmed === true;
  const startupUnknownIdentity = marker => ({
    startupId: typeof marker?.startupId === 'string' ? marker.startupId : null,
    recordId: typeof marker?.recordId === 'string' ? marker.recordId : null,
  });
  function ensureStartupUnknownPolicy(taskId, marker) {
    if (!marker || !(marker.status === 'startup_unknown' ||
        marker.startupFailure === true && marker.status === 'retirement_unknown')) return false;
    let policy = saved.policies.find(item => item.taskId === taskId);
    if (!policy) {
      policy = { taskId, attempts: 0, maxAttempts: 3 };
      saved.policies.push(policy);
    }
    const identity = startupUnknownIdentity(marker);
    if (policy.executorStartupUnknown?.startupId === identity.startupId &&
        policy.executorStartupUnknown?.recordId === identity.recordId &&
        policy.status === 'unknown' && !policy.enabled) return false;
    policy.executorStartupUnknown = { ...identity,
      priorUnknown: policy.status === 'unknown' && !policy.executorStartupUnknown };
    policy.enabled = false;
    policy.status = 'unknown';
    policy.wakeAt = null;
    policy.lastError = '原任务执行器启动或停止结果尚未确认，请核对原记录';
    return true;
  }
  function originalRetirementCommand(taskId, entry) {
    const marker = saved.executors[`task:${taskId}`];
    return marker?.kind === 'macos-job' && marker.taskId === taskId &&
      typeof marker.startupId === 'string' && typeof marker.recordId === 'string' &&
      marker.lastCommandId === entry?.commandId && entry.taskId === taskId &&
      entry.bridgePid === marker.pid && entry.workspace === marker.workspace &&
      entry.stopProof?.status === 'unverified' ? marker : null;
  }
  function rememberRetirementUnknown(policy, taskId, entry) {
    const marker = originalRetirementCommand(taskId, entry);
    if (!marker) return;
    const identity = { ...startupUnknownIdentity(marker), commandId: entry.commandId };
    if (policy.executorRetirementUnknown?.startupId === identity.startupId &&
        policy.executorRetirementUnknown?.recordId === identity.recordId &&
        policy.executorRetirementUnknown?.commandId === identity.commandId) return;
    policy.executorRetirementUnknown = { ...identity,
      priorUnknown: policy.status === 'unknown' && !policy.executorStartupUnknown };
  }
  function settleExecutorUnknownPolicy(taskId, marker, entry, staleResult, latest) {
    const policy = saved.policies.find(item => item.taskId === taskId);
    if (!policy) return null;
    const identity = startupUnknownIdentity(marker);
    const startup = policy.executorStartupUnknown;
    const retirement = policy.executorRetirementUnknown;
    const sameStartup = startup?.startupId === identity.startupId &&
      startup?.recordId === identity.recordId;
    const sameRetirement = retirement?.startupId === identity.startupId &&
      retirement?.recordId === identity.recordId &&
      retirement?.commandId === entry?.commandId &&
      entry?.stopProof?.status === 'verified';
    if (!sameStartup && !sameRetirement) return null;
    const priorUnknown = (sameStartup && startup.priorUnknown) ||
      (sameRetirement && retirement.priorUnknown);
    if (sameStartup) delete policy.executorStartupUnknown;
    if (sameRetirement) delete policy.executorRetirementUnknown;
    const unresolved = Object.values(saved.commands).some(command => command.taskId === taskId &&
      (['sending','unknown','awaiting_approval'].includes(command.status) || unresolvedStop(command)));
    const remainsUnknown = priorUnknown || unresolved ||
      !!policy.executorStartupUnknown || !!policy.executorRetirementUnknown;
    policy.enabled = false;
    policy.status = remainsUnknown ? 'unknown' : staleResult ? 'stale_result' :
      latest.status === 'paused' ? 'paused' : 'reconciled';
    policy.lastError = remainsUnknown ? '另有执行结果仍未核实' :
      staleResult ? '原执行结果已核实，但任务内容已更新；请核对新要求' : null;
    policy.wakeAt = null;
    return policy;
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    saved = {
      enabled: parsed.enabled === true,
      config: { ...DEFAULT_CONFIG, ...parsed.config },
      policies: Array.isArray(parsed.policies) ? parsed.policies : [],
      commands: parsed.commands && typeof parsed.commands === 'object' ? parsed.commands : {},
      sessions: parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      completedConversations: parsed.completedConversations &&
        typeof parsed.completedConversations === 'object' && !Array.isArray(parsed.completedConversations)
        ? parsed.completedConversations : {},
      executor: parsed.executor && (Number.isInteger(parsed.executor.pid) || parsed.executor.status === 'starting') ? parsed.executor : null,
      executors: parsed.executors && typeof parsed.executors === 'object' && !Array.isArray(parsed.executors) ? parsed.executors : {},
    };
    // A restored cache is optional output, never execution or retirement proof.
    // Malformed/over-budget historical maps fail closed without changing leases.
    saved.completedConversations = boundCompletedConversations(saved.completedConversations, saved.commands) || {};
    for (const [key, command] of Object.entries(saved.commands)) {
      if (command.status === 'sending') saved.commands[key] = { ...command, status: 'unknown', error: 'Previous send outcome is unknown' };
    }
    for(const session of Object.values(saved.sessions))if(session.status==='creating')session.status='unknown';
    for (const [key, marker] of Object.entries(saved.executors)) {
      if (key.startsWith('task:') && ensureStartupUnknownPolicy(key.slice(5), marker))
        policyRecoveryPending = true;
    }
    for (const policy of saved.policies) {
      if (!policy.enabled) continue;
      const stop = !validPlanIntent(policy.planIntent) || typeof policy.planId !== 'string' || !policy.planId ||
        !Number.isInteger(policy.recoveryFailureCount) || policy.recoveryFailureCount < 0 ||
        policy.recoveryFailureCount > 2
        ? { status: 'retry_stopped', stopReason: 'plan_intent_missing' }
        : policy.recoveryFailureCount === 2
        ? { status: 'retry_stopped', stopReason: 'repeated_quota_failure' }
        : !policy.restartBinding && !firstTurnProven(policy)
        ? { status: 'retry_stopped', stopReason: 'restart_binding_changed' }
        : policy.pendingAutoCommandId
        ? { status: 'retry_stopped', stopReason: 'attempt_unconfirmed' }
        : automaticStop(policy, epoch(now));
      if (stop) {
        policy.enabled = false;
        policy.status = stop.status;
        policy.stopReason = stop.stopReason;
        policy.lastError = stop.stopReason;
        policy.wakeAt = null;
        policyRecoveryPending = true;
      }
    }
    initialized = true;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let closed = false;
  // A task's app-server is never shared with another task. The null-key bridge
  // is used only for quota reads and never hosts a writable conversation.
  let bridge = null;
  const taskBridges = new Map();
  const executorBaselines = new WeakMap();
  async function admitLinuxExecutor({taskId,commandId,workspace,worktreeId,client}) {
    if(process.platform!=='linux')return;
    const task=await getTask(taskId),project=task&&await getProject(task.projectId);
    const generation=project?.retirementHandoffGeneration;
    const marker=saved.executors[markerKey(taskId)];
    const linuxJob=marker?.kind==='linux-job';
    if(!linuxJob&&(!Number.isSafeInteger(generation)||generation<1))return;
    if(typeof verifyLinuxExecutorAdmission!=='function'||bridgeFor(taskId)!==client||
      !Number.isSafeInteger(client.spawnedChild?.pid)||!Number.isSafeInteger(client.appServerPid))
      throw new Error('Original Linux executor admission is unavailable');
    if(linuxJob){
      if(marker.recordId!==client.job?.recordId||marker.workspace!==workspace||
        (marker.worktreeId||null)!==(worktreeId||null)||
        (marker.expectedHandoffGeneration??null)!==(Number.isSafeInteger(generation)&&generation>0?generation:null))
        throw new Error('Original Linux job admission binding changed');
      marker.appServerPid=client.appServerPid;
      await persist();
    }
    // Durable Linux jobs use Core's private job record and live identity chain
    // for admission. Keep the whole-tree capture for the legacy bridge path;
    // its global process-list churn must not reject an otherwise valid job.
    if(!linuxJob){
      const baseline=executorBaselines.get(client);
      const observed=baseline&&await processProof.captureTaskExecutorTree({baseline,taskId,
        bridgePid:client.spawnedChild.pid,appServerPid:client.appServerPid,workspace,
        pythonPath:pythonExecutable(client.pythonPath,executableBase)});
      if(!observed?.verified||!observed.capture)
        throw new Error(observed?.reason||'Original Linux executor capture is unavailable');
    }
    const binding={taskId,commandId,workspace,worktreeId:worktreeId||null,
      expectedHandoffGeneration:generation,bridgePid:client.spawnedChild.pid,
      appServerPid:client.appServerPid};
    const {expectedHandoffGeneration,...admission}=binding;
    await verifyLinuxExecutorAdmission(linuxJob?{...admission,recordId:marker.recordId}:admission);
    client.linuxManagedBinding=binding;
  }
  const bridgeRetirements = new WeakMap();
  // A stopped bridge is removed from taskBridges, but its opaque OS capture
  // remains usable in this process. A saved marker alone cannot recreate it.
  const retirementRecords = new Map();
  const completedRetirementRechecks = new Map();
  const eventShutdowns = new Map();
  let pendingBridgeShutdown = Promise.resolve();
  let timer = null;
  let saveQueue = Promise.resolve();
  let currentQuota = null;
  let status = saved.enabled ? 'idle' : 'disabled';
  let lastError = null;
  let available = null;
  let serial = Promise.resolve();
  let closePromise = null;
  let disableRequested = false;
  const pauseRequested = new Set();
  const completionEvents = new Map();
  const commandItemEvents = new Map();
  const startedEvents = new Set();
  const startedWaiters = new Map();
  const approvalThreads = new Set();
  const eventKey = (taskId, threadId, turnId) => JSON.stringify([taskId, threadId, turnId]);
  const threadKey = (taskId, threadId) => JSON.stringify([taskId, threadId]);
  const live = createPublicDeltaCache();
  let liveEmitTimer = null;
  function scheduleLiveEmit() {
    if (liveEmitTimer) return;
    liveEmitTimer = setTimeout(() => { liveEmitTimer = null; if (!closed) emit(); }, 150);
    liveEmitTimer.unref?.();
  }
  let reconcileCursor = 0;

  async function initialize() {
    if (!jobIndexAudited && process.platform === 'linux' && taskJobBackend === undefined) {
      await mkdir(dataDir, { recursive: true });
      const root = await linuxJobRecordRoot(dataDir);
      await auditLinuxJobIndex(root, saved.executors);
      jobIndexAudited = true;
    }
    if (!jobIndexAudited && process.platform === 'darwin' && taskJobs) {
      await mkdir(dataDir, { recursive: true });
      const root = await taskJobs.taskJobRecordRoot(dataDir);
      await taskJobs.auditTaskJobIndex(root, saved.executors);
      for (const [key, marker] of Object.entries(saved.executors)) {
        if (!key.startsWith('task:') || marker.kind !== 'macos-job') continue;
        const task = await getTask(key.slice(5));
        const project = task && await getProject(task.projectId);
        const workspace = task && project && await taskJobWorkspace(task, project, marker);
        if (!task || !project || marker.taskId !== task.id || marker.projectId !== task.projectId ||
            !originalJobWorkspace(marker, workspace?.directory) || marker.recordRoot !== root)
          throw new Error('Task job marker project or workspace binding changed');
        await taskJobs.verifyTaskJobMarker({ recordRoot: root, recordId: marker.recordId,
          taskId: task.id, workspace: marker.canonicalWorkspace });
      }
      jobIndexAudited = true;
    }
    if (policyRecoveryPending) { await persist(); policyRecoveryPending = false; }
    if (initialized) return;
    initialized = true;
    status = saved.enabled ? 'idle' : 'disabled';
    if (saved.enabled) schedule(0);
  }

  async function persist() {
    const image = `${JSON.stringify(saved, null, 2)}\n`;
    const next = saveQueue.then(async () => {
      // Constructor-only fault injection; never sourced from plugin config or
      // a remote request. The default persistence path is unchanged.
      if (beforeStateWrite) await beforeStateWrite(image);
      await mkdir(dataDir, { recursive: true });
      const temp = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temp, image, { mode: 0o600 });
      await rename(temp, statePath);
      emit();
    });
    saveQueue = next.catch(() => {});
    return next;
  }

  function snapshot() {
    return {
      id: 'codex-autocontinue', name: 'Codex Auto Continue', version: '0.1.0',
      enabled: saved.enabled, available: available === true, status, lastError,
      upstream: clone(UPSTREAM), quota: currentQuota && clone(currentQuota),
      config: clone(saved.config),
      policies: saved.policies.map(({ taskId, enabled, status: policyStatus, lastError: policyError, wakeAt, attempts, maxAttempts,
        budgetMinutes, startedAt, deadlineAt, stopReason, planIntent, recoveryFailureCount }) => ({
        taskId, enabled, status: policyStatus || 'idle', lastError: policyError || null,
        wakeAt: wakeAt || null, attempts: attempts || 0, maxAttempts: maxAttempts || 3,
        budgetMinutes: budgetMinutes ?? DEFAULT_BUDGET_MINUTES,
        startedAt: startedAt || null, deadlineAt: deadlineAt || null,
        remainingSeconds: budgetRemainingSeconds({ deadlineAt }, epoch(now)), stopReason: stopReason || null,
        planIntent: validPlanIntent(planIntent) ? clone(planIntent) : null,
        recoveryFailureCount: Number.isInteger(recoveryFailureCount) && recoveryFailureCount >= 0 && recoveryFailureCount <= 2
          ? recoveryFailureCount : 0,
      })),
      capabilities: ['quota.read', 'thread.verify', 'task.resume', 'approval.stop', 'per-task-policy'],
    };
  }

  function run(fn, { allowClosed = false } = {}) {
    const task = serial.then(async () => { await initialize(); if (closed && !allowClosed) throw new Error('plugin closed'); return fn(); });
    serial = task.catch(() => {});
    return task;
  }

  function clearSchedule() { if (timer) clearTimeout(timer); timer = null; }
  function schedule(delayMs) {
    clearSchedule();
    if (!saved.enabled || closed) return;
    timer = setTimeout(() => { check().catch(() => {}); }, Math.max(0, Math.min(delayMs, 2147483647)));
    timer.unref?.();
  }

  function stopAutomatic(policy, stop, detail = null) {
    policy.enabled = false;
    policy.status = stop.status;
    policy.stopReason = stop.stopReason;
    policy.lastError = detail || stop.stopReason;
    policy.wakeAt = null;
  }

  async function assertPlanIntent(policy) {
    if (!policy?.enabled || !validPlanIntent(policy.planIntent) ||
        typeof policy.planId !== 'string' || !policy.planId ||
        !Number.isInteger(policy.recoveryFailureCount) || policy.recoveryFailureCount < 0 ||
        policy.recoveryFailureCount > 2) {
      if (policy?.enabled) {
        stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'plan_intent_missing' });
        await persist();
      }
      throw new Error('plan_intent_missing');
    }
    if (policy.recoveryFailureCount === 2) {
      stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'repeated_quota_failure' });
      await persist();
      throw new Error('repeated_quota_failure');
    }
    const task = await getTask(policy.taskId);
    if (task && samePlanIntent(policy.planIntent, task)) return task;
    stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'plan_intent_changed' });
    await persist();
    throw new Error('plan_intent_changed');
  }

  function preserveHumanStop(policy) {
    if (!policy) return false;
    const attempt = policy.pendingAutoCommandId && saved.commands[`${policy.taskId}:${policy.pendingAutoCommandId}`];
    if (['unknown','awaiting_approval'].includes(policy.status) ||
        ['running','unknown','awaiting_approval'].includes(attempt?.status)) return false;
    if (pauseRequested.has(policy.taskId) || policy.status === 'paused') {
      policy.enabled = false;
      policy.status = 'paused';
    } else if (disableRequested || closed || !saved.enabled || policy.status === 'disabled') {
      policy.enabled = false;
      policy.status = 'disabled';
    } else return false;
    policy.wakeAt = null;
    policy.stopReason = null;
    policy.lastError = null;
    return true;
  }

  function assertAutomaticSend(policy, commandId) {
    if (!saved.enabled || !policy?.enabled || policy.pendingAutoCommandId !== commandId ||
        closed || disableRequested || pauseRequested.has(policy.taskId))
      throw new Error('Automatic resume is no longer authorized');
    const stop = automaticStop({ ...policy, attempts: policy.attempts - 1 }, epoch(now));
    // The current attempt is already durably counted. Its limit is inclusive;
    // the next attempt is not allowed to reserve once the limit is reached.
    if (stop) {
      stopAutomatic(policy, stop);
      throw new Error(stop.stopReason);
    }
  }

  async function reserveAutomatic(policy) {
    await assertPlanIntent(policy);
    await assertRestartBinding(policy);
    const stop = automaticStop(policy, epoch(now));
    if (stop) { stopAutomatic(policy, stop); await persist(); return null; }
    if (policy.pendingAutoCommandId) {
      stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'attempt_unconfirmed' });
      await persist();
      return null;
    }
    const commandId = `auto-${randomUUID()}`;
    policy.pendingAutoCommandId = commandId;
    policy.attempts += 1;
    await persist(); // Failure means no preflight or provider request is permitted.
    return commandId;
  }

  const markerKey = taskId => taskId === null ? '@quota' : `task:${taskId}`;
  const startupFields = taskId => {
    const marker=saved.executors[markerKey(taskId)];
    if(!marker?.startupId)return {};
    if(!/^[a-f0-9]{32}$/.test(marker.recordId||''))
      throw new Error('Original task executor startup record is incomplete');
    return {startupId:marker.startupId,recordId:marker.recordId};
  };
  const settledStartupCommands = (taskId,marker) => {
    // Core only needs the command occupying this startup lease. Historical
    // completed turns, even thousands on the same task, are not authority to
    // retire a different job or command.
    if(!marker?.lastCommandId)return [];
    const command=saved.commands[`${taskId}:${marker.lastCommandId}`];
    if(!command||command.taskId!==taskId||command.commandId!==marker.lastCommandId||
      command.bridgePid!==marker.pid||command.workspace!==marker.workspace)
      throw new Error('Original startup command receipt binding changed');
    const status=command.status==='interrupted'?'paused':
      command.status==='cancelled'&&!command.turnId?'not_started':command.status;
    return ['completed','failed','paused','not_started'].includes(status)
      ?[{commandId:command.commandId,status}]:[];
  };
  const bridgeFor = taskId => taskId === null ? bridge : taskBridges.get(taskId) || null;
  function clearBridge(candidate) {
    if (!candidate) return false;
    if (candidate.ownerTaskId === null) {
      if (bridge !== candidate) return false;
      bridge = null;
    } else {
      if (taskBridges.get(candidate.ownerTaskId) !== candidate) return false;
      taskBridges.delete(candidate.ownerTaskId);
    }
    return true;
  }
  const sourceCurrent = candidate => candidate && bridgeFor(candidate.ownerTaskId) === candidate;
  const threadOwnedBy = (candidate, threadId) => candidate?.ownerTaskId !== null &&
    Object.values(saved.commands).some(command => command.taskId === candidate.ownerTaskId && command.threadId === threadId) ||
    candidate?.ownerTaskId !== null && Object.values(saved.sessions).some(session =>
      session.taskId === candidate.ownerTaskId && session.threadId === threadId);

  function onEvent(message, source = null) {
    if (!sourceCurrent(source)) return;
    if (message.event === 'closed') {
      if (source.closing || bridgeRetirements.has(source)) return;
      live.clear();
      stopEventBridge(source);
      available = Boolean(bridge || taskBridges.size);
      lastError = 'codex app-server closed';
      status = 'unavailable';
      emit();
      return;
    }
    if (message.event === 'limit' && currentQuota) {
      currentQuota.blocked = true;
      const wakeAtMs = (message.resetAt + saved.config.graceSeconds) * 1000;
      for (const policy of saved.policies) {
        if (policy.enabled && ['running', 'sending'].includes(policy.status) &&
          (source.ownerTaskId === null || policy.taskId === source.ownerTaskId) &&
          (!message.threadId || message.threadId === policy.threadId)) {
          policy.status = 'waiting_quota';
          policy.wakeAt = new Date(wakeAtMs).toISOString();
          Promise.resolve(getTask(policy.taskId)).then(task => {
            if (task?.status === 'running' && task.conversationId === policy.threadId) {
              return updateTask(task.id, { status: 'blocked', blockedReason: 'Codex quota exhausted' }, task.revision);
            }
          }).catch(() => {});
        }
      }
      status = 'waiting_quota';
      persist().catch(() => {});
      schedule(Math.max(1000, wakeAtMs - epoch(now)));
    }
    if (message.event !== 'codex' && message.event !== 'codexRequest') return;
    const method = message.method;
    const params = message.params || {};
    const threadId = params.threadId;
    if (threadId && !threadOwnedBy(source, threadId)) return;
    if (!threadId && source.ownerTaskId !== null) return;
    if (live.add({ method, params }, saved.commands, source.ownerTaskId)) { scheduleLiveEmit(); return; }
    if (method === 'item/started' && params.item?.type === 'commandExecution') {
      const turnId = params.turnId;
      const itemId = params.item.id;
      if (![threadId, turnId, itemId].every(value => typeof value === 'string' && value.length > 0 && value.length <= 300)) return;
      const key = eventKey(source.ownerTaskId, threadId, turnId);
      let observed = commandItemEvents.get(key);
      if (!observed) { observed = new Set(); observed.bridgePid = source?.spawnedChild?.pid; commandItemEvents.set(key, observed); }
      if (observed.bridgePid !== source?.spawnedChild?.pid) observed.overflow = true;
      if (observed.size >= 64) observed.overflow = true;
      else observed.add(itemId);
      const entry = Object.values(saved.commands).find(command => command.taskId === source.ownerTaskId &&
        command.threadId === threadId && command.turnId === turnId);
      if (entry) {
        if (entry.bridgePid !== source?.spawnedChild?.pid) entry.commandItemOverflow = true;
        entry.commandItemIds = [...observed];
        if (observed.overflow) entry.commandItemOverflow = true;
        persist().catch(() => {});
      }
      return;
    }
    if (method === 'turn/started' && threadId && params.turn?.id) {
      const key = eventKey(source.ownerTaskId, threadId, params.turn.id);
      const waiter = startedWaiters.get(key);
      if (waiter) {
        startedWaiters.delete(key);
        clearTimeout(waiter.timer);
        waiter.resolve(true);
      } else startedEvents.add(key);
      return;
    }
    if (message.event === 'codexRequest' || method.includes('approval') || method.includes('requestUserInput')) {
      try {
        bridgeDiagnostics.record(providerRequestDiagnostic(method, source.ownerTaskId,
          threadId, params.turnId, Object.values(saved.commands)));
      } catch { /* Private diagnostics never change approval stopping. */ }
      source.noteStop('provider_approval');
      // This event belongs to the current task bridge and its owned thread.
      // Keep the thread identity across clearBridge() so retirement can bind
      // an unconfirmed turn to the exact request before stopping its OS job.
      if (source.ownerTaskId !== null && threadId &&
          typeof params.turnId === 'string' && params.turnId.length > 0 && params.turnId.length <= 300) {
        source.approvalStopThreadId = threadId;
        source.approvalStopTurnId = params.turnId;
      }
      if (threadId) approvalThreads.add(threadKey(source.ownerTaskId, threadId));
      for (const policy of saved.policies) {
        if (!threadId || policy.threadId === threadId) {
          policy.status = 'awaiting_approval';
          policy.lastError = 'Codex is waiting for approval or user input';
          policy.enabled = false;
        }
      }
      status = 'awaiting_approval';
      stopEventBridge(source);
      persist().catch(() => {});
    } else if (method === 'turn/completed') {
      const turnId = params.turn?.id;
      if (!threadId || !turnId) return;
      const startKey = eventKey(source.ownerTaskId, threadId, turnId);
      const waiter = startedWaiters.get(startKey);
      if (waiter) {
        startedWaiters.delete(startKey);
        clearTimeout(waiter.timer);
        waiter.resolve(true);
      }
      const match = Object.values(saved.commands).find(command => command.taskId === source.ownerTaskId &&
        command.threadId === threadId && command.turnId === turnId);
      if (match) {
        match.turnCompleteEvent = true;
        if (match.bridgePid !== source?.spawnedChild?.pid) match.commandItemOverflow = true;
        persist().catch(() => {});
        run(() => handleCompletion(params, { ownerTaskId: source.ownerTaskId })).catch(() => {});
      }
      else completionEvents.set(eventKey(source.ownerTaskId, threadId, turnId), { params, bridgePid: source?.spawnedChild?.pid });
    }
  }

  function waitStarted(taskId, threadId, turnId) {
    const key = eventKey(taskId, threadId, turnId);
    if (startedEvents.delete(key)) return Promise.resolve(true);
    if (completionEvents.has(key)) return Promise.resolve(true);
    return new Promise(resolveWait => {
      const timer = setTimeout(() => { startedWaiters.delete(key); resolveWait(false); }, 5000);
      startedWaiters.set(key, { resolve: resolveWait, timer });
    });
  }

  async function handleCompletion(params, { allowDuringPause = false, allowBlocked = false, ownerTaskId = null } = {}) {
    const threadId = params.threadId;
    const turn = params.turn;
    const entry = Object.values(saved.commands).find(command => (ownerTaskId === null || command.taskId === ownerTaskId) &&
      command.threadId === threadId && command.turnId === turn?.id);
    if (!entry || !['completed', 'failed', 'interrupted'].includes(turn.status)) return;
    if (turn.status === 'interrupted' && ['completed', 'failed'].includes(entry.status)) return;
    entry.status = turn.status;
    if (turn.status === 'failed') entry.providerFailure = providerFailure(turn.error);
    entry.completedAt ||= iso(now);
    if (turn.status === 'interrupted' && entry.stopProof?.status !== 'verified') {
      // A finished turn is not an OS process-exit receipt. In particular,
      // foreground command children can survive turn/interrupt in a new session.
      entry.stopProof = { version: 1, status: 'unverified', threadId, turnId: turn.id,
        reason: 'Interrupted turn has no command process-exit proof', checkedAt: iso(now) };
      let policy = saved.policies.find(item => item.taskId === entry.taskId);
      if (!policy) { policy = { taskId: entry.taskId, attempts: 0, maxAttempts: 3 }; saved.policies.push(policy); }
      rememberRetirementUnknown(policy, entry.taskId, entry);
      policy.enabled = false; policy.status = 'unknown'; policy.wakeAt = null; policy.lastError = entry.stopProof.reason;
      status = 'unknown'; lastError = entry.stopProof.reason;
      await persist();
      return;
    }
    if (turn.status !== 'interrupted' && entry.stopProof?.status !== 'verified') {
      entry.stopProof = { version: 1, status: 'unverified', threadId, turnId: turn.id,
        reason: 'Codex turn outcome has no OS command-exit proof', checkedAt: iso(now) };
      await persist();
      try {
        if (!entry.turnCompleteEvent) throw new Error('Codex completion stream was not observed');
        const prepared = await captureOwnedProcesses(entry);
        entry.stopProof = await finishOwnedProcesses(entry, prepared);
        await persist();
      } catch (error) {
        entry.stopProof.reason = errorText(error);
        let policy = saved.policies.find(item => item.taskId === entry.taskId);
        if (!policy) { policy = { taskId: entry.taskId, attempts: 0, maxAttempts: 3 }; saved.policies.push(policy); }
        rememberRetirementUnknown(policy, entry.taskId, entry);
        policy.enabled = false; policy.status = 'unknown'; policy.wakeAt = null; policy.lastError = entry.stopProof.reason;
        status = 'unknown'; lastError = entry.stopProof.reason;
        await persist();
        return;
      }
    }
    const currentTask = await getTask(entry.taskId);
    if (turn.status === 'interrupted' && currentTask?.status === 'paused') {
      await persist();
      return;
    }
    if (!currentTask || currentTask.conversationId !== threadId || !resultMatchesTaskContent(entry, currentTask)) {
      const explanation = 'Task content changed after this Codex turn began; submit the updated task again';
      entry.stale = true;
      entry.taskUpdateError = explanation;
      let stalePolicy = saved.policies.find(item => item.taskId === entry.taskId);
      if (!stalePolicy) { stalePolicy = { taskId: entry.taskId, attempts: 0, maxAttempts: 3 }; saved.policies.push(stalePolicy); }
      stalePolicy.enabled = false;
      stalePolicy.status = 'stale_result';
      stalePolicy.lastError = explanation;
      status = 'stale_result';
      lastError = explanation;
      await persist();
      return;
    }
    const completionFailure = turn.status === 'failed' ? entry.providerFailure :
      turn.error ? providerFailure(turn.error) : null;
    const detail = completionFailure?.summary || '';
    const quotaFailure = completionFailure?.category === 'quota';
    const policy = saved.policies.find(item => item.taskId === entry.taskId);
    if (policy?.stopReason === 'repeated_quota_failure' &&
        policy.planId === entry.automaticPlanId) return;
    const countedQuotaFailure = Boolean(quotaFailure && policy?.enabled === true && entry.automaticPlanId &&
      policy?.planId === entry.automaticPlanId &&
      entry.quotaFailureCountedPlanId !== policy.planId);
    if (countedQuotaFailure) {
      policy.recoveryFailureCount = Math.min(2, (Number.isInteger(policy.recoveryFailureCount) &&
        policy.recoveryFailureCount >= 0 ? policy.recoveryFailureCount : 0) + 1);
      entry.quotaFailureCountedPlanId = policy.planId;
    }
    if (policy && (!entry.automaticPlanId || policy.planId === entry.automaticPlanId) &&
        !['plan_intent_missing','plan_intent_changed','repeated_quota_failure'].includes(policy.stopReason)) {
      if (countedQuotaFailure && policy.recoveryFailureCount >= 2)
        stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'repeated_quota_failure' },
          detail || 'Repeated quota-recovery failure');
      else {
        policy.status = turn.status === 'completed' ? 'turn_completed' : quotaFailure ? 'waiting_quota' : 'failed';
        policy.lastError = turn.status === 'completed' ? null : detail || `Codex turn ${turn.status}`;
        if (turn.status === 'completed' || !quotaFailure) policy.enabled = false;
      }
    }
    try {
      const task = currentTask;
      const mutableStatus = task?.status === 'running' || (allowBlocked && ['blocked', 'planned'].includes(task?.status));
      if (task && task.conversationId === threadId && mutableStatus && (allowDuringPause || !pauseRequested.has(entry.taskId))) {
        const patch = turn.status === 'completed'
          ? { status: 'submitted', blockedReason: '' }
          : quotaFailure
            ? { status: 'blocked', blockedReason: detail || 'Codex quota exhausted' }
            : { status: 'failed', blockedReason: detail || `Codex turn ${turn.status}` };
        await updateTask(entry.taskId, patch, task.revision);
      }
    } catch (error) {
      entry.taskUpdateError = errorText(error);
      if (policy) policy.lastError = entry.taskUpdateError;
    }
    status = turn.status === 'completed' ? 'turn_completed' : quotaFailure ? 'waiting_quota' : 'failed';
    await persist();
  }

  function onExit(error, source) {
    if (source?.closing || bridgeRetirements.has(source)) return;
    if (!sourceCurrent(source)) return;
    stopEventBridge(source);
    available = Boolean(bridge || taskBridges.size);
    lastError = errorText(error);
    status = 'unavailable';
    emit();
  }

  function stopEventBridge(candidate) {
    if (!candidate) return;
    if (candidate.closing || bridgeRetirements.has(candidate)) return;
    clearBridge(candidate);
    const retirement = stopTrackedBridge(candidate);
    eventShutdowns.set(candidate, retirement);
    refreshPendingBridgeShutdown();
    // A failed event shutdown stays in the set until a proven in-memory
    // recheck clears this exact candidate. Other failed candidates survive.
    void retirement.then(() => {
      if (eventShutdowns.get(candidate) === retirement) {
        eventShutdowns.delete(candidate);
        refreshPendingBridgeShutdown();
      }
    }, () => {});
  }

  function refreshPendingBridgeShutdown() {
    pendingBridgeShutdown = Promise.all([...eventShutdowns.values()]);
    void pendingBridgeShutdown.catch(error => { lastError = errorText(error); status = 'unknown'; emit(); });
  }

  function stopTrackedBridge(candidate, preparedCapture = null, proofMeta = null) {
    if (!candidate) return Promise.resolve();
    const existing = bridgeRetirements.get(candidate);
    if (existing) return existing;
    candidate.noteStop('tracked_retirement');
    // Register before any capture/stop await. The bridge's expected `closed`
    // event must observe this same retirement, not start a second capture.
    const retirement = Promise.resolve().then(() => retireTrackedBridge(candidate, preparedCapture, proofMeta));
    bridgeRetirements.set(candidate, retirement);
    return retirement;
  }

  async function retireTrackedBridge(candidate, preparedCapture, proofMeta) {
    if(candidate.job&&saved.executors[markerKey(candidate.ownerTaskId)]?.kind==='linux-job')
      return retireTrackedLinuxJob(candidate,proofMeta);
    if (candidate.job) return retireTrackedJob(candidate, preparedCapture, proofMeta);
    const pid = candidate.spawnedChild?.pid;
    const key = markerKey(candidate.ownerTaskId);
    const marker = saved.executors[key];
    let capture = preparedCapture, captureError = null;
    if (candidate.ownerTaskId !== null && marker?.pid === pid && !capture) {
      const baseline = executorBaselines.get(candidate);
      try {
        const observed = baseline && await processProof.captureTaskExecutorTree({ baseline, taskId: candidate.ownerTaskId,
          bridgePid: pid, appServerPid: candidate.appServerPid, workspace: marker.workspace,
          pythonPath: pythonExecutable(candidate.pythonPath,executableBase) });
        if (observed?.verified && observed.capture) capture = observed.capture;
        else captureError = observed?.reason || 'Dedicated executor prelaunch baseline is unavailable';
      } catch (error) { captureError = errorText(error); }
    }
    let record = null;
    if (candidate.ownerTaskId !== null) {
      let identity = null;
      try {
        const task = await getTask(candidate.ownerTaskId);
        const project = task && await getProject(task.projectId);
        const workspace = task && project && await taskWorkspace(task, project);
        if (task && project && workspace?.directory === marker?.workspace &&
            task.projectId === marker.projectId) {
          identity = { projectId: task.projectId, projectDirectory: project.directory,
            workspace: workspace.directory, worktreeId: workspace.worktreeId || null,
            threadId: task.conversationId || null, revision: task.revision,
            contentVersion: task.contentVersion };
        }
      } catch { /* Missing identity keeps the durable marker unknown. */ }
      const retirementId = randomUUID();
      if (marker?.pid === pid) marker.retirementId = retirementId;
      record = { candidate, marker, capture, pid, retirementId, appServerPid: candidate.appServerPid,
        identity, proofMeta, stopAttempted: false };
      retirementRecords.set(candidate.ownerTaskId, record);
    }
    try { if (record) record.stopAttempted = true; await retireStop(candidate); }
    catch (error) { captureError ||= errorText(error); }
    clearBridge(candidate);
    available = Boolean(bridge || taskBridges.size);
    if (candidate.ownerTaskId === null) {
      if (captureError) throw new Error(captureError);
      if (pid && marker?.pid === pid) { delete saved.executors[key]; await persist(); }
      return;
    }
    let retired = null;
    if (capture && !captureError) {
      try {
        retired = await processProof.verifyTaskExecutorRetired({ capture,
          taskId: candidate.ownerTaskId, bridgePid: pid, appServerPid: candidate.appServerPid,
          workspace: marker?.workspace, pythonPath: pythonExecutable(candidate.pythonPath,executableBase),
          ...(candidate.linuxManagedBinding?{verifyWorkspace:async()=>{
            if(typeof verifyLinuxBridgeRetirementWorkspace!=='function')
              throw new Error('Original Linux executor retirement authority is unavailable');
            return verifyLinuxBridgeRetirementWorkspace(candidate.linuxManagedBinding);
          }}:{}) });
      } catch (error) { captureError = errorText(error); }
    }
    if (captureError || retired?.verified !== true || retired.retired !== true) {
      const reason = captureError || retired?.reason || 'Dedicated executor retirement is unconfirmed';
      if (marker?.pid === pid) {
        marker.status = 'retirement_unknown'; marker.reason = reason;
        if (Array.isArray(retired?.unassignedIdentities))
          marker.unassignedIdentities = retired.unassignedIdentities.slice(0, 16);
        await persist();
      }
      throw new Error(reason);
    }
    if (marker?.pid === pid) { delete saved.executors[key]; await persist(); }
    if (retirementRecords.get(candidate.ownerTaskId) === record) retirementRecords.delete(candidate.ownerTaskId);
  }

  async function stopOriginalLinuxJob(taskId,marker,job,proofMeta=null) {
    const key=markerKey(taskId);
    if(!marker||saved.executors[key]!==marker||marker.kind!=='linux-job'||marker.taskId!==taskId||
      marker.recordId!==job.recordId||marker.recordRoot!==job.recordRoot)
      throw new Error('Original Linux job binding changed');
    const task=await getTask(taskId),project=task&&await getProject(task.projectId);
    const workspace=task&&project&&await taskJobWorkspace(task,project,marker);
    if(!task||!project||task.projectId!==marker.projectId||
      !originalJobWorkspace(marker,workspace?.directory)||
      (workspace.worktreeId||null)!==(marker.worktreeId||null)||
      marker.recordRoot!==await linuxJobRecordRoot(dataDir))
      throw new Error('Original Linux job workspace changed');
    const commandId=marker.lastCommandId||marker.requestCommandId;
    const entry=saved.commands[`${taskId}:${commandId}`];
    const finalProof=proofMeta||marker.finalTurnProof||null;
    const completed=!!finalProof&&!!entry&&finalProof.commandKey===`${taskId}:${commandId}`&&
      finalProof.bridgePid===marker.pid&&finalProof.workspace===marker.workspace&&
      finalProof.threadId===entry.threadId&&finalProof.turnId===entry.turnId&&
      entry.taskId===taskId&&entry.workspace===marker.workspace&&entry.bridgePid===marker.pid&&
      (entry.status===finalProof.status||entry.status==='running'&&finalProof.status==='interrupted')&&
      entry.turnCompleteEvent===true&&
      ['completed','failed','interrupted'].includes(finalProof.status);
    const session=saved.sessions[marker.requestCommandId];
    const abortedSession=marker.sessionAbortBeforeSend===true&&!marker.lastCommandId&&
      session?.status==='not_started'&&session.taskId===taskId&&session.commandId===commandId&&
      session.workspace===marker.workspace&&(session.worktreeId||null)===(marker.worktreeId||null)&&
      !session.threadId&&!session.turnId&&!marker.threadId&&!task.conversationId&&
      !Object.values(saved.commands).some(command=>command.taskId===taskId);
    const idleSession=!marker.lastCommandId&&session?.status==='created'&&
      session.taskId===taskId&&session.workspace===marker.workspace&&
      session.threadId===task.conversationId&&marker.threadId===session.threadId&&
      !Object.values(saved.commands).some(command=>command.taskId===taskId&&
        (['sending','running','unknown','awaiting_approval'].includes(command.status)||unresolvedStop(command)));
    const unresolved=!!entry&&entry.taskId===taskId&&entry.commandId===commandId&&
      entry.workspace===marker.workspace&&entry.bridgePid===marker.pid&&
      typeof entry.threadId==='string'&&entry.threadId.length>0&&
      typeof entry.turnId==='string'&&entry.turnId.length>0&&
      (['sending','running','unknown','awaiting_approval'].includes(entry.status)||
        entry.stopProof?.status==='unverified');
    const intent={taskId,projectId:marker.projectId,recordId:marker.recordId,commandId,
      workspace:marker.workspace,worktreeId:marker.worktreeId||null,
      expectedHandoffGeneration:marker.expectedHandoffGeneration??null,
      bridgePid:marker.pid,appServerPid:marker.appServerPid,
      threadId:entry?.threadId||session?.threadId||marker.threadId||null,
      turnId:entry?.turnId||null};
    if(marker.linuxStopIntent&&JSON.stringify(marker.linuxStopIntent)!==JSON.stringify(intent))
      throw new Error('Original Linux stop intent changed');
    marker.linuxStopIntent=intent;
    if(completed){
      // During an explicit pause the completion event is queued behind this
      // operation. The final idle-turn check already confirmed interruption.
      entry.status=finalProof.status;
      if(!marker.finalTurnProof)marker.finalTurnProof=finalProof;
    }
    if(marker.status!=='stopped_unknown')marker.status='stopping';
    await persist();
    const stopped=await job.stop();
    if(stopped?.verified!==true||stopped.retired!==true)
      throw new Error(stopped?.reason||'Original Linux job retirement is unconfirmed');
    if(!completed&&!idleSession&&!unresolved&&!abortedSession)
      throw new Error('Original Linux command has no admissible retirement outcome');
    if(typeof verifyLinuxJobRetirement!=='function')
      throw new Error('Original Linux retirement authority is unavailable');
    const proof=await verifyLinuxJobRetirement({taskId,recordId:marker.recordId,commandId,
      workspace:marker.workspace,worktreeId:marker.worktreeId||null,
      expectedHandoffGeneration:marker.expectedHandoffGeneration??null,
      bridgePid:marker.pid,appServerPid:marker.appServerPid});
    const receipt=proof?.receipt;
    if(proof?.verified!==true||proof.retired!==true||proof.unknown!==false||
      (abortedSession?proof.scope!=='linux-original-task-job-before-session-send':
        proof.scope==='linux-original-task-job-before-session-send')||
      receipt?.version!==1||receipt.scope!==proof.scope||
      !Number.isSafeInteger(receipt.recordGeneration)||receipt.recordGeneration<1||
      Object.entries(intent).some(([field,value])=>receipt[field]!==value)||
      (marker.linuxStoppedReceipt&&JSON.stringify(marker.linuxStoppedReceipt)!==JSON.stringify(receipt)))
      throw new Error('Original Linux job retirement receipt is unconfirmed');
    marker.linuxStoppedReceipt=receipt;
    if(completed||idleSession||abortedSession){
      if(completed){
        entry.stopProof={version:1,status:'verified',threadId:entry.threadId,turnId:entry.turnId,
          checkedAt:iso(now),scope:proof.scope,identityCount:finalProof.identityCount};
      }
      delete saved.executors[key];
    }else{
      if(entry&&unresolved){
        entry.status='unknown';entry.error='Original provider turn outcome remains unknown after verified process stop';
      }
      marker.status='stopped_unknown';
      let policy=saved.policies.find(item=>item.taskId===taskId);
      if(!policy){policy={taskId,attempts:0,maxAttempts:3};saved.policies.push(policy);}
      policy.enabled=false;policy.status='unknown';policy.wakeAt=null;
      policy.lastError='原执行进程已停止，但本轮结果尚未确认';
      status='unknown';lastError=policy.lastError;
    }
    try{await persist();}catch(error){
      if(abortedSession)saved.executors[key]=marker;
      throw error;
    }
    return {status:abortedSession?'not_started':completed||idleSession?'reconciled':'unknown',
      linuxStoppedVerified:!completed&&!idleSession&&!abortedSession,
      stopProofScope:proof.scope,
      taskId,taskStatus:(await getTask(taskId))?.status||null,resolvedTurns:completed?1:0};
  }

  async function retireTrackedLinuxJob(candidate,proofMeta) {
    const taskId=candidate.ownerTaskId,key=markerKey(taskId),marker=saved.executors[key];
    candidate.closing=true;
    try{return await stopOriginalLinuxJob(taskId,marker,candidate.job,proofMeta);}
    catch(error){
      if(saved.executors[key]===marker){marker.status='retirement_unknown';marker.reason=errorText(error);await persist();}
      throw error;
    }finally{clearBridge(candidate);available=Boolean(bridge||taskBridges.size);}
  }

  async function retireTrackedJob(candidate, preparedCapture, proofMeta) {
    const taskId = candidate.ownerTaskId, key = markerKey(taskId);
    const marker = saved.executors[key], job = candidate.job;
    if (!marker || marker.kind !== 'macos-job' || marker.recordId !== job.recordId ||
        marker.taskId !== taskId || !validDirectory(marker.workspace) ||
        marker.recordRoot !== job.recordRoot)
      throw new Error('Original task job record binding changed');
    let shutdownIntentError=null;
    // A shutdown can stop an executing provider before it emits a final turn.
    // Persist the exact in-flight turn before any OS stop; a later restart may
    // only recheck this intent, never manufacture it from a retired process.
    const approvalStop = candidate.approvalStopThreadId === marker.threadId &&
      typeof candidate.approvalStopTurnId === 'string' && candidate.approvalStopTurnId.length > 0 &&
      candidate.ownerTaskId === taskId && !candidate.dead;
    if ((closed && bridgeFor(taskId) === candidate && !candidate.dead || approvalStop) &&
        !proofMeta && !marker.shutdownStopIntent && marker.status === 'starting' &&
        marker.startupId && marker.lastCommandId) {
      const command=saved.commands[`${taskId}:${marker.lastCommandId}`];
      let intent=command&&{version:1,taskId,projectId:marker.projectId,
          startupId:marker.startupId,recordId:marker.recordId,commandId:command.commandId,
          threadId:marker.threadId,turnId:command.turnId,bridgePid:marker.pid,
          workspace:marker.workspace,worktreeId:marker.worktreeId||null,
          expectedHandoffGeneration:marker.expectedHandoffGeneration??null};
      if(approvalStop&&intent&&command.turnId===candidate.approvalStopTurnId&&
        Number.isSafeInteger(command.taskRevision)&&command.taskRevision>0&&
        Number.isSafeInteger(command.startedContentVersion)&&command.startedContentVersion>0)
        intent.stopCause='provider_approval';
      else if(approvalStop)intent=null;
      if(command?.commandId===marker.lastCommandId&&isUnresolvedShutdownTurn(command,intent)) {
        marker.shutdownStopIntent=intent;
        try{await persist();}catch(error){
          // No stop may claim an intent that was only present in RAM.
          delete marker.shutdownStopIntent;
          shutdownIntentError=errorText(error);
        }
      }
    }
    const retirementId = marker.retirementId || randomUUID();
    marker.retirementId = retirementId;
    let identity = null, evidenceError = shutdownIntentError;
    try {
      const task = await getTask(taskId), project = task && await getProject(task.projectId);
      const workspace = task && project && await taskWorkspace(task, project);
      if (!task || !project || task.projectId !== marker.projectId ||
          !originalJobWorkspace(marker, workspace?.directory) ||
          (workspace?.worktreeId||null)!==(marker.worktreeId||null))
        throw new Error('Task job workspace binding changed');
      identity = { projectId: task.projectId, projectDirectory: project.directory,
        workspace: workspace.directory, worktreeId: workspace.worktreeId || null,
        threadId: task.conversationId || null, revision: task.revision,
        contentVersion: task.contentVersion, taskStatus: task.status };
    } catch (error) { evidenceError = errorText(error); }
    let known = Array.isArray(marker.knownIdentities) ? [...marker.knownIdentities] : [];
    if (Array.isArray(preparedCapture?.knownIdentities)) known.push(...preparedCapture.knownIdentities);
    const baseline = executorBaselines.get(candidate);
    if (baseline && candidate.appServerPid && candidate.spawnedChild?.pid) {
      try {
        const observed = await processProof.captureTaskExecutorTree({ baseline, taskId,
          bridgePid: candidate.spawnedChild.pid, appServerPid: candidate.appServerPid,
          workspace: marker.workspace, pythonPath: pythonExecutable(candidate.pythonPath,executableBase) });
        if (!observed?.verified || !Array.isArray(observed.identities))
          throw new Error(observed?.reason || 'Task member capture is unavailable');
        known.push(...observed.identities);
      } catch (error) { evidenceError ||= errorText(error); }
    } else evidenceError ||= 'Original task member capture is unavailable';
    known = [...new Map(known.map(row => [`${row.pid}:${row.startSec}:${row.startUsec}`, row])).values()];
    if (known.length > 512) evidenceError ||= 'Task process evidence exceeds limit';
    marker.knownIdentities = known.slice(0, 512);
    marker.captureComplete = !evidenceError && known.length >= 2;
    if (!marker.captureComplete) evidenceError ||= 'Original task member capture is incomplete';
    marker.status = 'stopping';
    try { await persist(); }
    catch (error) { evidenceError ||= errorText(error); }
    const record = { candidate, job, marker, identity, proofMeta,
      pid: candidate.spawnedChild?.pid || null, retirementId,
      knownIdentities: known, stopAttempted: true };
    retirementRecords.set(taskId, record);
    candidate.closing = true;
    const retired = await taskJobs.verifyTaskJobRetired({ job, workspace: marker.workspace,
      pythonPath: pythonExecutable(candidate.pythonPath,executableBase), knownIdentities: known,
      verifyRetirementWorkspace, retirementBinding: {
        taskId,recordId:marker.recordId,workspace:marker.workspace,
        worktreeId:marker.worktreeId??null,expectedHandoffGeneration:marker.expectedHandoffGeneration??null} });
    clearBridge(candidate);
    available = Boolean(bridge || taskBridges.size);
    if (evidenceError || retired?.retired !== true || retired?.verified !== true) {
      const reason = evidenceError || retired?.reason || 'Original task job retirement is unconfirmed';
      marker.status = 'retirement_unknown'; marker.reason = reason;
      await persist();
      throw new Error(reason);
    }
    if(marker.shutdownStopIntent){
      await settleShutdownUnknownJob(taskId,marker,retired);
      if (record?.candidate && eventShutdowns.delete(record.candidate)) refreshPendingBridgeShutdown();
      return;
    }
    if(marker.startupId){
      try{
        if(proofMeta){
          const command=saved.commands[proofMeta.commandKey];
          if(!command||proofMeta.commandKey!==`${taskId}:${marker.lastCommandId}`||
            command.taskId!==taskId||command.commandId!==marker.lastCommandId||
            command.threadId!==proofMeta.threadId||command.turnId!==proofMeta.turnId||
            command.bridgePid!==proofMeta.bridgePid||command.workspace!==proofMeta.workspace||
            command.bridgePid!==marker.pid||command.turnCompleteEvent!==true||
            !['interrupted','completed','failed'].includes(proofMeta.status)||
            !['running',proofMeta.status].includes(command.status))
            throw new Error('Original completed turn receipt binding changed');
          // Save the exact final idle turn together with its command result
          // before Core retires the startup lease. A reopened host can then
          // recheck a lost marker-deletion receipt without inventing the
          // in-memory provider result or replaying the turn.
          marker.finalTurnProof={version:1,commandKey:proofMeta.commandKey,
            threadId:proofMeta.threadId,turnId:proofMeta.turnId,status:proofMeta.status,
            bridgePid:proofMeta.bridgePid,workspace:proofMeta.workspace,
            identityCount:proofMeta.identityCount,
            turnError:proofMeta.turnError==null?null:
              publicText(typeof proofMeta.turnError==='string'?proofMeta.turnError:
                JSON.stringify(proofMeta.turnError))};
          if(command.status==='running')command.status=proofMeta.status;
          await persist();
        }
        if(typeof retireExecutorStartup!=='function')throw new Error('Original startup lease retirement authority is unavailable');
        await retireExecutorStartup({taskId,startupId:marker.startupId,recordId:marker.recordId,
          settledCommands:settledStartupCommands(taskId,marker)});
      }catch(error){
        marker.status='retirement_unknown';marker.reason='Original startup lease retirement is unconfirmed';
        await persist();
        throw error;
      }
    }
    const finalCommand=proofMeta&&saved.commands[proofMeta.commandKey];
    const previousStopProof=finalCommand?.stopProof===undefined?undefined:structuredClone(finalCommand.stopProof);
    const originalPolicy=saved.policies.find(item=>item.taskId===taskId);
    const previousPolicy=originalPolicy?structuredClone(originalPolicy):null;
    if(finalCommand){
      finalCommand.stopProof={version:1,status:'verified',threadId:proofMeta.threadId,
        turnId:proofMeta.turnId,checkedAt:iso(now),scope:retired.scope,
        identityCount:proofMeta.identityCount};
    }
    settleExecutorUnknownPolicy(taskId,marker,finalCommand,false,
      {status:identity?.taskStatus||'blocked'});
    delete saved.executors[key];
    try { await persist(); }
    catch (error) { saved.executors[key] = marker; marker.status = 'retirement_unknown';
      if(finalCommand){
        if(previousStopProof===undefined)delete finalCommand.stopProof;
        else finalCommand.stopProof=previousStopProof;
      }
      if(originalPolicy&&previousPolicy){
        for(const field of Object.keys(originalPolicy))delete originalPolicy[field];
        Object.assign(originalPolicy,previousPolicy);
      }
      marker.reason = `Could not save task job retirement: ${errorText(error)}`; throw error; }
    retirementRecords.delete(taskId);
    if (record?.candidate && eventShutdowns.delete(record.candidate)) refreshPendingBridgeShutdown();
    await job.dispose().catch(() => {});
  }

  async function settleShutdownUnknownJob(taskId,marker,retired) {
    const intent=marker.shutdownStopIntent;
    const command=intent&&saved.commands[`${taskId}:${intent.commandId}`];
    if(!intent||intent.version!==1||intent.taskId!==taskId||
      intent.projectId!==marker.projectId||intent.startupId!==marker.startupId||
      intent.recordId!==marker.recordId||intent.bridgePid!==marker.pid||
      intent.workspace!==marker.workspace||
      (intent.worktreeId||null)!==(marker.worktreeId||null)||
      intent.expectedHandoffGeneration!==(marker.expectedHandoffGeneration??null)||
      intent.commandId!==marker.lastCommandId||
      !isUnresolvedShutdownTurn(command,intent,{allowUnknown:true})||
      marker.captureComplete!==true||!Array.isArray(marker.knownIdentities)||
      marker.knownIdentities.length<2||retired?.verified!==true||retired.retired!==true||
      !['macos-original-task-job-coalition-known-descendants-and-managed-handoff',
        'macos-original-task-job-coalition-known-descendants-and-current-writers'].includes(retired.scope))
      throw new Error('Original shutdown turn or process proof is unconfirmed');
    const record=await taskJobs.verifyTaskJobMarker({recordRoot:marker.recordRoot,
      recordId:marker.recordId,taskId,workspace:marker.canonicalWorkspace});
    if(record.phase!=='retired'||record.attempted!==true||!record.identity||
        record.identity.pid!==intent.bridgePid||record.ioFault!==false)
      throw new Error('Original shutdown job retirement record is unconfirmed');
    const receipt=marker.shutdownStopProof||{...intent,recordGeneration:record.generation,
      proofScope:retired.scope};
    if(receipt.proofScope!==retired.scope||record.generation<receipt.recordGeneration||
      JSON.stringify((({recordGeneration,proofScope,...rest})=>rest)(receipt))!==JSON.stringify(intent))
      throw new Error('Original shutdown process proof changed');
    marker.shutdownStopProof=receipt;
    await persist();
    if(typeof retireExecutorStartup!=='function')throw new Error('Original startup lease retirement authority is unavailable');
    await retireExecutorStartup({taskId,startupId:marker.startupId,recordId:marker.recordId,
      settledCommands:[],shutdownUnknown:receipt});
    await finalizeShutdownUnknown(taskId,marker,command,receipt);
  }

  async function finalizeShutdownUnknown(taskId,marker,command,receipt) {
    if(!isUnresolvedShutdownTurn(command,receipt,{allowUnknown:true})||
      marker.shutdownStopProof&&JSON.stringify(marker.shutdownStopProof)!==JSON.stringify(receipt)||
      marker.shutdownStoppedReceipt&&JSON.stringify(marker.shutdownStoppedReceipt)!==JSON.stringify(receipt))
      throw new Error('Original shutdown outcome receipt changed');
    command.status='unknown';
    const approvalStop=receipt.stopCause==='provider_approval';
    command.error=approvalStop
      ? 'Codex requested approval or user input; the stopped turn outcome is unconfirmed'
      : 'Original provider turn outcome is unknown after verified shutdown';
    command.stopProof={version:1,status:'unverified',reason:'Original provider turn outcome is unknown after verified shutdown'};
    let policy=saved.policies.find(item=>item.taskId===taskId);
    if(!policy){policy={taskId,attempts:0,maxAttempts:3};saved.policies.push(policy);}
    rememberRetirementUnknown(policy,taskId,command);
    policy.enabled=false;policy.status='unknown';policy.wakeAt=null;
    policy.lastError=approvalStop
      ? 'Codex 请求审批或用户输入；原进程已停止，本轮结果尚未确认'
      : '原执行进程已停止，但本轮结果尚未确认';
    marker.status='stopped_unknown';marker.shutdownStoppedReceipt=receipt;
    status='unknown';lastError=policy.lastError;
    await persist();
    if(approvalStop){
      try{
        const task=await getTask(taskId);
        if(task?.projectId===receipt.projectId&&task.conversationId===receipt.threadId&&
          task.status==='running'&&task.revision===command.taskRevision&&
          task.contentVersion===command.startedContentVersion)
          await updateTask(taskId,{status:'blocked',blockedReason:policy.lastError},task.revision);
      }catch(error){
        // Task projection is not execution authority. Keep the durable stopped
        // unknown receipt and its active lease even when this display update fails.
        command.taskUpdateError=errorText(error);
        await persist().catch(()=>{});
      }
    }
  }

  async function stopAllTrackedBridges() {
    const candidates = [bridge, ...taskBridges.values()].filter(Boolean);
    const results = await Promise.allSettled(candidates.map(candidate => stopTrackedBridge(candidate)));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  async function stopRecoveredTaskJobs(projectId = null,verifiedLinuxStops = null,verifiedMacStops = null,
    forDisposition = false) {
    for (const [key, marker] of Object.entries(saved.executors)) {
      if(key.startsWith('task:')&&marker.kind==='linux-job'&&!bridgeFor(key.slice(5))){
        const task=await getTask(key.slice(5));
        if(!task||task.projectId!==marker.projectId)
          throw new Error('Recovered Linux job ownership is unconfirmed');
        if(projectId!==null&&task.projectId!==projectId)continue;
        const stopped=await recheckRetiredLinuxJob(task,marker);
        const unsentRetired=stopped.status==='not_started'&&
          stopped.stopProofScope==='linux-original-task-job-before-session-send'&&!saved.executors[key];
        if(stopped.linuxStoppedVerified!==true&&stopped.status!=='reconciled'&&!unsentRetired)
          throw new Error(stopped.error||'Recovered Linux job retirement is unconfirmed');
        if(stopped.linuxStoppedVerified===true&&saved.executors[key]===marker)
          verifiedLinuxStops?.add(marker);
        if(closed&&saved.executors[key]===marker)shutdownVerifiedMarkers.add(marker);
        continue;
      }
      if (!key.startsWith('task:') || marker.kind !== 'macos-job' || bridgeFor(key.slice(5))) continue;
      const task = await getTask(key.slice(5));
      if (!task || (marker.projectId && marker.projectId !== task.projectId))
        throw new Error('Recovered task job ownership is unconfirmed');
      if (projectId !== null && task.projectId !== projectId) continue;
      const stopped = await recheckRetiredJob(task, marker,forDisposition);
      // A current physical-stop proof permits human takeover without claiming
      // that the provider outcome is known. Never reuse a previous call's proof.
      if(stopped.shutdownStoppedVerified===true&&saved.executors[key]===marker&&
        marker.status==='stopped_unknown'&&marker.shutdownStoppedReceipt&&
        JSON.stringify(marker.shutdownStopProof)===JSON.stringify(marker.shutdownStoppedReceipt))
        verifiedMacStops?.set(marker,structuredClone(marker.shutdownStoppedReceipt));
      if (stopped.status === 'unknown' && !(closed && stopped.shutdownStoppedVerified===true) &&
          !verifiedMacStops?.has(marker))
        throw new Error(stopped.error || 'Recovered task job retirement is unconfirmed');
      if (closed && stopped.shutdownStoppedVerified===true &&
          saved.executors[key] === marker && marker.shutdownStoppedReceipt)
        shutdownVerifiedMarkers.add(marker);
    }
  }
  const shutdownVerifiedMarkers=new Set();

  function assertNoUnconfirmedExecutors() {
    if (saved.executor) throw new Error('Legacy shared Codex executor retirement is unconfirmed');
    for (const key of Object.keys(saved.executors)) {
      if (key.startsWith('task:')) throw new Error(`Codex executor retirement is unconfirmed: ${key}`);
    }
  }

  function recordedGroupGone(marker) {
    if (!Number.isInteger(marker?.pid) || process.platform === 'win32') return false;
    try { process.kill(-marker.pid, 0); return false; }
    catch (error) { if (error.code === 'ESRCH') return true; throw error; }
  }

  async function connection(taskId = null, workspace = null, projectId = null,
    creatingWorktreeId = null, requestCommandId = null, purpose = 'turn') {
    if (closed) throw new Error('plugin closed');
    if (taskId !== null && (typeof taskId !== 'string' || !taskId)) throw new Error('Task executor requires a task ID');
    const current = bridgeFor(taskId);
    if (current?.child && !current.dead) {
      const marker = saved.executors[markerKey(taskId)];
      if (!marker || marker.pid !== current.spawnedChild?.pid ||
        (taskId !== null && ((workspace && marker.workspace !== workspace) ||
          (projectId && marker.projectId !== projectId) ||
          (['macos-job','linux-job'].includes(marker.kind) && !originalJobWorkspace(marker, workspace)))))
        throw new Error('Codex task executor binding changed');
      if(taskId!==null&&process.platform==='darwin'&&typeof reserveExecutorStartup==='function'&&
        marker.kind==='macos-job'&&!marker.startupId)
        throw new Error('Existing task executor has no original startup admission');
      // Reading or stopping the original live bridge must remain possible after
      // a human takeover has moved control to stopping. Only a request that
      // may start a new provider command needs fresh ai_ready admission.
      if(marker.startupId&&requestCommandId){
        if(typeof verifyExecutorStartup!=='function'||!marker.recordId)
          throw new Error('Original task executor startup authority is unavailable');
        await verifyExecutorStartup({taskId,startupId:marker.startupId,recordId:marker.recordId,workspace:marker.workspace});
      }
      return current;
    }
    // A status read, reconciliation, or pause must not launch a fresh task
    // job as a side effect. Only an explicit send/create-session request has
    // a command identity from which Core can reserve startup authority.
    if(taskId!==null&&process.platform==='darwin'&&taskJobs&&
      typeof reserveExecutorStartup==='function'&&!requestCommandId)
      throw new Error('Task executor has no admitted startup request');
    if(taskId!==null&&process.platform==='linux'&&taskJobBackend===undefined&&!requestCommandId)
      throw new Error('Linux task executor has no original command request');
    if (taskId !== null && (!validDirectory(workspace) || typeof projectId !== 'string' || !projectId))
      throw new Error('Dedicated executor requires a verified task workspace and project');
    await pendingBridgeShutdown;
    if (closed) throw new Error('plugin closed');
    // Legacy shared executors have no task-specific prelaunch baseline. A dead
    // process group cannot prove that escaped children stopped after restart.
    if (saved.executor) throw new Error('Previous shared Codex executor retirement is unconfirmed');
    const key = markerKey(taskId);
    if (saved.executors[key]?.status === 'retirement_unknown')
      throw new Error('Previous task executor retirement is unconfirmed');
    // A dead bridge group cannot account for descendants that escaped its
    // process group. The prelaunch baseline is memory-only after a restart.
    if (taskId === null && saved.executors[key] && recordedGroupGone(saved.executors[key])) {
      delete saved.executors[key]; await persist();
    }
    if (saved.executors[key]) throw new Error('Previous task Codex executor exit is unconfirmed');
    let expectedHandoffGeneration=null,worktreeId=null,startupId=null,currentRevision=null,currentHandoffGeneration=null;
    // A new thread is not yet in saved.sessions. Verify its requested tree
    // directly before launch, then re-read that same binding at each gate.
    const resolveBinding=async(task,project)=>creatingWorktreeId
      ?await resolveWorkspace?.({taskId:task.id,worktreeId:creatingWorktreeId})
      :await taskWorkspace(task,project);
    if(taskId!==null){
      const task=await getTask(taskId),project=task&&await getProject(task.projectId);
      const binding=task&&project&&await resolveBinding(task,project);
      if(!task||!project||task.projectId!==projectId||binding?.directory!==workspace||
        (creatingWorktreeId!==null&&binding?.worktreeId!==creatingWorktreeId))
        throw new Error('Task job prelaunch binding changed');
      worktreeId=binding.worktreeId||null;
      currentRevision=task.revision;
      const generation=project.retirementHandoffGeneration;
      if(Number.isSafeInteger(generation)&&generation>0)expectedHandoffGeneration=generation;
      if(process.platform==='darwin'&&taskJobs&&typeof reserveExecutorStartup==='function'){
        currentHandoffGeneration=project.handoff?.generation??null;
        if(expectedHandoffGeneration!==null&&
          (!Number.isSafeInteger(currentHandoffGeneration)||currentHandoffGeneration<1)||
          typeof requestCommandId!=='string'||!requestCommandId||
          ![reserveExecutorStartup,bindExecutorStartup,confirmExecutorStartup,verifyExecutorStartup].every(fn=>typeof fn==='function'))
          throw new Error('Managed task executor startup authority is unavailable');
        startupId=randomUUID();
      }
    }
    const assertPrelaunchBinding=async()=>{
      if(taskId===null)return;
      const task=await getTask(taskId),project=task&&await getProject(task.projectId);
      const binding=task&&project&&await resolveBinding(task,project);
      if(!task||!project||task.projectId!==projectId||binding?.directory!==workspace||
        (creatingWorktreeId!==null&&binding?.worktreeId!==creatingWorktreeId)||
        (binding?.worktreeId||null)!==worktreeId||
        (startupId!==null&&task.revision!==currentRevision)||
        (startupId!==null&&(project.handoff?.generation??null)!==currentHandoffGeneration)||
        (project.retirementHandoffGeneration??null)!==expectedHandoffGeneration)
        throw new Error('Task job prelaunch handoff or workspace changed');
    };
    await assertPrelaunchBinding();
    saved.executors[key] = { status: 'starting', taskId, workspace, projectId, worktreeId,
      expectedHandoffGeneration,startupId, startedAt: iso(now) };
    await persist();
    let baseline = null;
    if (taskId !== null) {
      const observed = await processProof.captureExecutorBaseline({ pythonPath: pythonExecutable(saved.config.pythonPath,executableBase) });
      if (!observed?.verified || !observed.baseline) {
        delete saved.executors[key];
        await persist();
        throw new Error(observed?.reason || 'Dedicated executor prelaunch baseline is unavailable');
      }
      baseline = observed.baseline;
    }
    let candidate, preparedJob = null, openAttempted = false;
    let startupReserved = false, prepareAttempted = false;
    const taskJob = process.platform === 'darwin' && taskJobs && taskId !== null;
    const linuxTaskJob = process.platform === 'linux' && taskJobBackend === undefined && taskId !== null;
    try {
      const bridgeId = randomUUID();
      candidate = new Bridge({
        pythonPath: saved.config.pythonPath, codexPath: saved.config.codexPath,
        executableBaseDirectory:trustedExecutableBase,
        pluginDir, onEvent: message => onEvent(message, candidate), onExit: error => onExit(error, candidate),
        diagnostic: row => bridgeDiagnostics.record({ ...row, bridgeId, recordId: candidate?.job?.recordId }),
      });
      candidate.ownerTaskId = taskId;
      if (baseline) executorBaselines.set(candidate, baseline);
      if (taskJob) {
        const recordRoot = await taskJobs.taskJobRecordRoot(dataDir);
        await taskJobs.auditTaskJobIndex(recordRoot, saved.executors);
        await assertPrelaunchBinding();
        // Every fallible prelaunch read and marker write precedes the active
        // lease. Once reserved, enter prepare immediately; a failure inside
        // prepare might have written an intent and must remain unknown.
        if(startupId){
          await reserveExecutorStartup({taskId,startupId,requestCommandId,projectId,workspace,
            worktreeId,purpose,expectedRevision:currentRevision,
            expectedHandoffGeneration:currentHandoffGeneration});
          startupReserved=true;
        }
        prepareAttempted=true;
        preparedJob = await taskJobs.prepareTaskJob({ dataDir, taskId, projectId, workspace,
          pythonPath: pythonExecutable(saved.config.pythonPath,executableBase),
          bridgePath: join(pluginDir, 'bridge.py'), env: process.env });
        candidate.job = preparedJob.job;
        saved.executors[key] = { ...saved.executors[key], kind: 'macos-job',
          recordId: preparedJob.recordId, recordRoot, projectId, workspace,
          canonicalWorkspace: preparedJob.canonicalWorkspace };
        await persist();
        if(startupId)await bindExecutorStartup({taskId,startupId,recordId:preparedJob.recordId});
        // Close the gap between a restored host index and the irreversible
        // submit. The job's independent intent record remains authoritative.
        await taskJobs.auditTaskJobIndex(recordRoot, saved.executors);
      }
      if(linuxTaskJob){
        const recordRoot=await linuxJobRecordRoot(dataDir);
        await auditLinuxJobIndex(recordRoot,saved.executors);
        await assertPrelaunchBinding();
        const owner=(await nativeSelectedIdentities(
          pythonExecutable(saved.config.pythonPath,executableBase),[process.pid])).get(process.pid);
        prepareAttempted=true;
        preparedJob=await prepareLinuxTaskJob({dataDir,taskId,projectId,workspace,
          worktreeId,expectedHandoffGeneration,requestCommandId,
          pythonPath:pythonExecutable(saved.config.pythonPath,executableBase),
          bridgePath:join(pluginDir,'bridge.py'),env:process.env});
        candidate.job=preparedJob.job;
        saved.executors[key]={...saved.executors[key],kind:'linux-job',
          recordId:preparedJob.recordId,recordRoot,requestCommandId,
          canonicalWorkspace:preparedJob.canonicalWorkspace,projectId,workspace,
          worktreeId,expectedHandoffGeneration,linuxStartupOwner:owner};
        await persist();
        await auditLinuxJobIndex(recordRoot,saved.executors);
      }
      await assertPrelaunchBinding();
      openAttempted = true;
      await candidate.open();
      if(startupId)await confirmExecutorStartup({taskId,startupId,recordId:preparedJob.recordId});
      if (closed) throw new Error('plugin closed during bridge startup');
      if (taskId === null) bridge = candidate;
      else taskBridges.set(taskId, candidate);
      saved.executors[key] = { ...saved.executors[key], pid: candidate.spawnedChild.pid,
        taskId, workspace, projectId, startedAt: iso(now) };
      await persist();
      available = true; lastError = null; return candidate;
    }
    catch (error) {
      available = Boolean(bridge || taskBridges.size); lastError = errorText(error); status = 'unavailable';
      if (taskJob && preparedJob && !openAttempted && !candidate.spawnedChild &&
          saved.executors[key]?.kind === 'macos-job' &&
          saved.executors[key].recordId === preparedJob.recordId) {
        try {
          const marker = saved.executors[key];
          const task = await getTask(taskId), project = task && await getProject(task.projectId);
          const currentWorkspace = task && project && await taskJobWorkspace(task, project, marker);
          const recordRoot = await taskJobs.taskJobRecordRoot(dataDir);
          if (!task || !project || task.projectId !== projectId || marker.taskId !== taskId ||
              marker.projectId !== projectId || marker.recordRoot !== recordRoot ||
              marker.recordId !== preparedJob.recordId || marker.worktreeId !== worktreeId ||
              currentWorkspace?.worktreeId !== worktreeId ||
              (project.retirementHandoffGeneration??null)!==expectedHandoffGeneration ||
              preparedJob.job?.taskId !== taskId || preparedJob.projectId !== projectId ||
              preparedJob.workspace !== workspace ||
              recordRoot !== preparedJob.recordRoot ||
              !originalJobWorkspace(marker, currentWorkspace?.directory))
            throw new Error('Prepared job task or workspace binding changed');
          await taskJobs.abandonPreparedTaskJob({ job: preparedJob.job,
            recordRoot, recordId: preparedJob.recordId, taskId,
            workspace: marker.canonicalWorkspace });
          if(startupId){
            if(typeof retireExecutorStartup!=='function')throw new Error('Startup lease retirement authority unavailable');
            await retireExecutorStartup({taskId,startupId,recordId:preparedJob.recordId,
              settledCommands:settledStartupCommands(taskId,marker)});
          }
          await preparedJob.job.dispose();
          delete saved.executors[key];
          try { await persist(); }
          catch (writeError) { saved.executors[key] = marker; throw writeError; }
          // The caller still receives its original failed-start result; only
          // the proven never-submitted executor fence has been retired.
          throw error;
        } catch (abandonError) {
          if (abandonError === error) throw error;
          // Missing/replaced authority, a changed binding, or a failed
          // receipt must preserve the ordinary startup-unknown fence.
        }
      }
      const spawnedPid = candidate?.spawnedChild?.pid;
      if (taskId !== null && ((taskJob||linuxTaskJob) && (preparedJob?.recordId || startupReserved && prepareAttempted) ||
          Number.isSafeInteger(spawnedPid) && spawnedPid > 1)) {
        // Persist the fence before another await. A failed initialize may have
        // launched a helper in a different session even if bridge.stop works.
        saved.executors[key] = { ...saved.executors[key], pid: spawnedPid,
          status: 'startup_unknown', startupFailure: true, reason: errorText(error) };
        const session = saved.sessions[requestCommandId];
        if (linuxTaskJob && purpose === 'session' && preparedJob?.recordId &&
            candidate.job?.recordId === preparedJob.recordId &&
            saved.executors[key].recordId === preparedJob.recordId &&
            Number.isSafeInteger(spawnedPid) && spawnedPid > 1 &&
            session?.status === 'creating' && session.taskId === taskId &&
            session.commandId === requestCommandId && session.workspace === workspace &&
            !session.threadId && !session.turnId) {
          // This call has not returned a client to createSession, so no
          // createThread was sent. Retire only its original Linux job.
          session.status = 'not_started'; session.error = errorText(error);
          saved.executors[key].appServerPid = candidate.appServerPid;
          saved.executors[key].sessionAbortBeforeSend = true;
        }
        // A failing disk must not skip shutdown of an already spawned bridge.
        // Keep the in-memory fence and still attempt retirement below.
        try { await persist(); } catch { /* Preserve the original startup failure. */ }
        try { if(candidate)await stopTrackedBridge(candidate); }
        catch { /* Retain the durable unknown marker and original startup error. */ }
        if (ensureStartupUnknownPolicy(taskId, saved.executors[key]))
          try { await persist(); } catch { /* The original marker remains the restart fence. */ }
      } else {
        // No process identity was ever assigned to the bridge. A failed spawn
        // has no task executor tree to retire; still require stop to settle.
        if(candidate)await candidate.stop();
        delete saved.executors[key];
        await persist();
      }
      throw error;
    }
  }

  async function readQuota() {
    const client = await connection(null);
    const result = await client.request('quota', { graceSeconds: saved.config.graceSeconds });
    if (client.dead || bridge !== client) throw new Error('Codex app-server closed before quota verification');
    if (!result || !Array.isArray(result.windows)) throw new Error('invalid quota response');
    currentQuota = { windows: result.windows, blocked: result.blocked || !result.ready, checkedAt: new Date(result.checkedAt * 1000).toISOString() };
    return result;
  }

  const sessionBinding = task => {
    const session = Object.values(saved.sessions).find(item => item.taskId === task.id && item.threadId === task.conversationId && item.status === 'created');
    return session?.worktreeId || null;
  };
  async function taskWorkspace(task, project, requestedWorktreeId = undefined) {
    const boundId = sessionBinding(task);
    if (requestedWorktreeId !== undefined && (requestedWorktreeId || null) !== boundId)
      throw new Error('Bound Codex session belongs to a different worktree');
    if (!boundId) return { directory: project.directory, worktreeId: null };
    if (typeof resolveWorkspace !== 'function') throw new Error('Worktree workspace resolver is unavailable');
    const result = await resolveWorkspace({ taskId: task.id, worktreeId: boundId });
    if (!validDirectory(result?.directory) || result.worktreeId !== boundId) throw new Error('Worktree binding changed');
    return result;
  }

  // A job is recorded before a new worktree session exists. During recovery,
  // verify that pre-session binding through Core's worktree resolver instead
  // of mistaking the task's project directory for the original workspace.
  async function taskJobWorkspace(task, project, marker) {
    if (!task || !project || task.projectId !== project.id || marker.projectId !== project.id)
      throw new Error('Task job project binding changed');
    const sessions = Object.values(saved.sessions).filter(item => item.taskId === task.id);
    const created = sessions.find(item => item.status === 'created' && item.threadId === task.conversationId);
    if (created) {
      if ((created.worktreeId || null) !== (marker.worktreeId || null) ||
          created.workspace !== marker.workspace)
        throw new Error('Task job session binding changed');
      return taskWorkspace(task, project, marker.worktreeId || null);
    }
    if (marker.worktreeId) {
      if (task.conversationId || marker.threadId || sessions.length ||
          typeof resolveWorkspace !== 'function')
        throw new Error('Task job pre-session binding is unavailable');
      const result = await resolveWorkspace({ taskId: task.id, worktreeId: marker.worktreeId });
      if (!validDirectory(result?.directory) || result.worktreeId !== marker.worktreeId ||
          result.directory !== marker.workspace)
        throw new Error('Task job pre-session worktree binding changed');
      return result;
    }
    return taskWorkspace(task, project);
  }

  async function bindTaskExecutor(task, workspace, client) {
    const marker = saved.executors[markerKey(task.id)];
    if (bridgeFor(task.id) !== client || marker?.pid !== client.spawnedChild?.pid ||
      (marker.threadId && marker.threadId !== task.conversationId) ||
      (marker.workspace && marker.workspace !== workspace.directory) ||
      (marker.projectId && marker.projectId !== task.projectId))
      throw new Error('Codex task executor binding changed');
    if (!marker.threadId || !marker.workspace || !marker.projectId) {
      marker.threadId = task.conversationId;
      marker.workspace = workspace.directory;
      marker.projectId = task.projectId;
      await persist();
    }
  }

  async function verify(taskId, { automatic = false, allowSubmitted = false, worktreeId, commandId = null } = {}) {
    const task = await getTask(taskId);
    if (!task) throw new Error('Task not found');
    if ((TERMINAL_TASKS.has(task.status) && !(allowSubmitted && task.status === 'submitted')) || task.acceptance === 'passed') throw new Error('Task is complete or submitted for review');
    if (task.status === 'cancelled') throw new Error('Task was cancelled');
    if (automatic && (task.status === 'paused' || !hasQuotaReason(task))) throw new Error('Automatic resume requires a quota-blocked task');
    if (!task.conversationId || typeof task.conversationId !== 'string') throw new Error('Task has no bound conversationId');
    const project = await getProject(task.projectId);
    if (!project || !validDirectory(project.directory)) throw new Error('Project has no absolute directory');
    const workspace = await taskWorkspace(task, project, worktreeId);
    const client = await connection(task.id, workspace.directory, task.projectId,null,commandId,'turn');
    const response = await client.request('thread', { threadId: task.conversationId });
    let thread = response?.thread;
    if (!thread || thread.id !== task.conversationId) throw new Error('Bound Codex thread is missing or has the wrong ID');
    if (!validDirectory(thread.cwd) || resolve(thread.cwd) !== resolve(workspace.directory)) throw new Error('Codex thread directory differs from registered workspace');
    if (thread.status?.type === 'notLoaded') {
      const loaded = await client.request('resumeThread', { threadId: task.conversationId, cwd: workspace.directory });
      thread = loaded?.thread;
      if (!thread || thread.id !== task.conversationId || !validDirectory(thread.cwd) || resolve(thread.cwd) !== resolve(workspace.directory)) {
        throw new Error('Codex thread changed identity or directory while loading');
      }
    }
    const threadStatus = thread.status?.type;
    const flags = thread.status?.activeFlags || [];
    if (flags.some(flag => ACTIVE_FLAGS.has(flag))) throw new Error('Codex thread is waiting for approval or user input');
    if (threadStatus === 'active') throw new Error('Codex thread is already active');
    if (threadStatus !== 'idle') throw new Error(`Codex thread is not resumable: ${threadStatus || 'unknown'}`);
    const lastTurn = thread.turns?.at(-1);
    if (lastTurn?.status === 'inProgress') throw new Error('Codex turn is already in progress');
    await bindTaskExecutor(task, workspace, client);
    return { task, project, workspace, thread };
  }

  async function scopedThread(task) {
    const project = await getProject(task.projectId);
    if (!project || !validDirectory(project.directory)) throw new Error('Project has no absolute directory');
    const workspace = await taskWorkspace(task, project);
    if (!task.conversationId) throw new Error('Task has no bound conversationId');
    const turnIds=Object.values(saved.commands).filter(c=>c.taskId===task.id&&c.threadId===task.conversationId&&['running','unknown','sending','awaiting_approval'].includes(c.status)&&c.turnId).map(c=>c.turnId);
    const client = await connection(task.id, workspace.directory, task.projectId);
    const response = await client.request('thread', { threadId: task.conversationId,turnIds });
    const thread = response?.thread;
    if (!thread || thread.id !== task.conversationId) throw new Error('Bound Codex thread is missing or has the wrong ID');
    if (!validDirectory(thread.cwd) || resolve(thread.cwd) !== resolve(workspace.directory)) throw new Error('Codex thread directory differs from registered workspace');
    await bindTaskExecutor(task, workspace, client);
    return thread;
  }

  async function retireIdleExecutorForPolicyRestart(task, policy) {
    const taskId = task.id, key = markerKey(taskId);
    const client = bridgeFor(taskId), marker = saved.executors[key];
    const reject = () => { throw new Error('Original task command, session, or executor is not confirmed idle; policy cannot restart'); };
    // Never use connection() here: a missing original bridge must not launch a
    // replacement merely to decide whether the old executor may be retired.
    if (!client || !marker || !client.child || client.dead || client.closing ||
        bridgeRetirements.has(client) || marker.status !== 'starting' ||
        marker.taskId !== taskId || marker.pid !== client.spawnedChild?.pid ||
        Boolean(client.job) !== (marker.kind === 'macos-job'||marker.kind==='linux-job') ||
        (client.job && (marker.recordId !== client.job.recordId || marker.recordRoot !== client.job.recordRoot))) reject();
    const original = { revision: task.revision, contentVersion: task.contentVersion,
      projectId: task.projectId, threadId: task.conversationId, status: task.status };
    if (!original.threadId || marker.projectId !== original.projectId || marker.threadId !== original.threadId) reject();
    const project = await getProject(original.projectId);
    if (!project || !validDirectory(project.directory)) reject();
    const workspace = await taskWorkspace(task, project);
    let canonicalWorkspace;
    try { canonicalWorkspace = realpathSync(workspace.directory); } catch { reject(); }
    if (marker.workspace !== workspace.directory || (marker.worktreeId || null) !== (workspace.worktreeId || null) ||
        (client.job && !originalJobWorkspace(marker, workspace.directory)) ||
        (project.retirementHandoffGeneration ?? null) !== (marker.expectedHandoffGeneration ?? null)) reject();
    const checkCurrent = async () => {
      const current = await getTask(taskId);
      if (!current || current.revision !== original.revision || current.contentVersion !== original.contentVersion ||
          current.projectId !== original.projectId || current.conversationId !== original.threadId ||
          current.status !== original.status || current.status === 'running' ||
          saved.policies.find(item => item.taskId === taskId) !== policy || policy.enabled ||
          bridgeFor(taskId) !== client || saved.executors[key] !== marker || client.dead || client.closing ||
          marker.status !== 'starting' || marker.taskId !== taskId || marker.pid !== client.spawnedChild?.pid ||
          marker.projectId !== original.projectId || marker.threadId !== original.threadId ||
          Boolean(client.job) !== (marker.kind === 'macos-job'||marker.kind==='linux-job') ||
          (client.job && (marker.recordId !== client.job.recordId || marker.recordRoot !== client.job.recordRoot)) ||
          bridgeRetirements.has(client) ||
          Object.values(saved.sessions).some(session => session.taskId === taskId && ['creating', 'unknown'].includes(session.status)) ||
          Object.values(saved.commands).some(command => command.taskId === taskId &&
            (['sending', 'running', 'unknown', 'awaiting_approval'].includes(command.status) || unresolvedStop(command)))) reject();
      const currentProject = await getProject(original.projectId);
      if (!currentProject || currentProject.directory !== project.directory ||
          (currentProject.retirementHandoffGeneration ?? null) !== (project.retirementHandoffGeneration ?? null)) reject();
      const currentWorkspace = await taskWorkspace(current, currentProject);
      if (currentWorkspace.directory !== workspace.directory || (currentWorkspace.worktreeId || null) !== (workspace.worktreeId || null) ||
          marker.workspace !== workspace.directory || (marker.worktreeId || null) !== (workspace.worktreeId || null) ||
          (client.job && !originalJobWorkspace(marker, currentWorkspace.directory))) reject();
      try { if (realpathSync(currentWorkspace.directory) !== canonicalWorkspace) reject(); }
      catch { reject(); }
    };
    await checkCurrent();
    const response = await client.request('thread', { threadId: original.threadId, turnIds: [] });
    const thread = response?.thread;
    if (!thread || thread.id !== original.threadId || thread.cwd !== workspace.directory ||
        thread.status?.type !== 'idle' ||
        (thread.status.activeFlags !== undefined &&
          (!Array.isArray(thread.status.activeFlags) || thread.status.activeFlags.length)) ||
        !Array.isArray(thread.turns) || thread.turns.some(turn => turn?.status === 'inProgress')) reject();
    await checkCurrent();
    // The original task-only executor and its durable marker are retired by
    // the same OS/record proof used by pause and close. A failed proof keeps
    // the marker unknown; it never authorizes a new automatic plan.
    await stopTrackedBridge(client);
    if (saved.executors[key] || bridgeFor(taskId)) reject();
    const after = await getTask(taskId), afterProject = after && await getProject(after.projectId);
    if (!after || !afterProject || after.revision !== original.revision ||
        after.contentVersion !== original.contentVersion || after.projectId !== original.projectId ||
        after.conversationId !== original.threadId || after.status !== original.status ||
        afterProject.directory !== project.directory ||
        (afterProject.retirementHandoffGeneration ?? null) !== (project.retirementHandoffGeneration ?? null)) reject();
    const afterWorkspace = await taskWorkspace(after, afterProject);
    if (afterWorkspace.directory !== workspace.directory || (afterWorkspace.worktreeId || null) !== (workspace.worktreeId || null)) reject();
    try { if (realpathSync(afterWorkspace.directory) !== canonicalWorkspace) reject(); }
    catch { reject(); }
    // taskWorkspace may wait on the Core worktree resolver. Do not enable the
    // plan from the task object read before that last asynchronous boundary.
    const finalTask = await getTask(taskId);
    if (!finalTask || finalTask.revision !== original.revision ||
        finalTask.contentVersion !== original.contentVersion || finalTask.projectId !== original.projectId ||
        finalTask.conversationId !== original.threadId || finalTask.status !== original.status) reject();
    const finalProject = await getProject(original.projectId);
    if (!finalProject || finalProject.directory !== project.directory ||
        (finalProject.retirementHandoffGeneration ?? null) !== (project.retirementHandoffGeneration ?? null)) reject();
    const finalTaskAfterProject = await getTask(taskId);
    if (!finalTaskAfterProject || finalTaskAfterProject.revision !== original.revision ||
        finalTaskAfterProject.contentVersion !== original.contentVersion ||
        finalTaskAfterProject.projectId !== original.projectId ||
        finalTaskAfterProject.conversationId !== original.threadId ||
        finalTaskAfterProject.status !== original.status) reject();
    if (saved.policies.find(item => item.taskId === taskId) !== policy || policy.enabled ||
        Object.values(saved.sessions).some(session => session.taskId === taskId && ['creating', 'unknown'].includes(session.status)) ||
        Object.values(saved.commands).some(command => command.taskId === taskId &&
          (['sending', 'running', 'unknown', 'awaiting_approval'].includes(command.status) || unresolvedStop(command)))) reject();
  }

  async function captureRestartBinding(taskId, initialTask) {
    const initial = { id: initialTask.id, revision: initialTask.revision,
      contentVersion: initialTask.contentVersion, projectId: initialTask.projectId,
      conversationId: initialTask.conversationId, status: initialTask.status };
    const task = await getTask(taskId);
    const observed = task && { id: task.id, revision: task.revision,
      contentVersion: task.contentVersion, projectId: task.projectId,
      conversationId: task.conversationId, status: task.status };
    const project = task && await getProject(observed.projectId);
    if (!task || !project || !validDirectory(project.directory) ||
        Object.keys(initial).some(key => observed[key] !== initial[key]) ||
        observed.status === 'running') throw new Error('restart_binding_changed');
    const projectDirectory = project.directory;
    const expectedHandoffGeneration = project.handoff?.generation ?? null;
    const retirementHandoffGeneration = project.retirementHandoffGeneration ?? null;
    const workspace = await taskWorkspace(task, project);
    const canonicalWorkspace = realpathSync(workspace.directory);
    const freshProject = await getProject(observed.projectId);
    if (!freshProject || freshProject.directory !== projectDirectory ||
        (freshProject.handoff?.generation ?? null) !== expectedHandoffGeneration ||
        (freshProject.retirementHandoffGeneration ?? null) !==
          retirementHandoffGeneration) throw new Error('restart_binding_changed');
    const fresh = await getTask(taskId);
    if (!fresh || Object.keys(initial).some(key => fresh[key] !== initial[key]))
      throw new Error('restart_binding_changed');
    return { revision: observed.revision, contentVersion: observed.contentVersion,
      projectId: observed.projectId, threadId: observed.conversationId,
      workspace: workspace.directory, canonicalWorkspace, worktreeId: workspace.worktreeId || null,
      projectDirectory, expectedHandoffGeneration, retirementHandoffGeneration };
  }

  async function assertRestartBinding(policy) {
    const expected = policy?.restartBinding;
    if (!expected) {
      if (firstTurnProven(policy)) return;
      stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'restart_binding_changed' });
      await persist();
      throw new Error('restart_binding_changed');
    }
    let actual = null;
    try {
      const task = await getTask(policy.taskId);
      if (task) actual = await captureRestartBinding(policy.taskId, { ...task });
    } catch { /* Unreadable or changed binding cannot authorize the first turn. */ }
    const keys = ['revision', 'contentVersion', 'projectId', 'threadId', 'workspace',
      'canonicalWorkspace', 'worktreeId', 'projectDirectory', 'expectedHandoffGeneration',
      'retirementHandoffGeneration'];
    if (actual && keys.every(key => actual[key] === expected[key])) return;
    stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'restart_binding_changed' });
    await persist();
    throw new Error('restart_binding_changed');
  }

  async function pauseUnknown(taskId, detail) {
    let policy = saved.policies.find(item => item.taskId === taskId);
    if (!policy) { policy = { taskId, attempts: 0, maxAttempts: 3 }; saved.policies.push(policy); }
    const marker=saved.executors[markerKey(taskId)];
    const original=marker?.lastCommandId&&saved.commands[`${taskId}:${marker.lastCommandId}`];
    if(original?.stopProof?.reason===detail)
      rememberRetirementUnknown(policy,taskId,original);
    policy.enabled = false;
    policy.status = 'unknown';
    policy.lastError = detail;
    policy.wakeAt = null;
    status = 'unknown';
    lastError = detail;
    await persist();
    return { status: 'unknown', taskId, error: detail };
  }

  async function terminalList(client, entry) {
    if (entry.commandItemOverflow || !Array.isArray(entry.commandItemIds) ||
        !entry.turnId || !entry.threadId || entry.bridgePid !== client.spawnedChild?.pid ||
        !Number.isSafeInteger(client.appServerPid))
      throw new Error('Codex turn stream or executor identity is unconfirmed');
    const known = new Set(entry.commandItemIds);
    const terminals = [];
    const cursors = new Set();
    let cursor = null;
    for (let page = 0; page < 32; page++) {
      const reply = await client.request('listBackgroundTerminals',
        { threadId: entry.threadId, ...(cursor ? { cursor } : {}), limit: 100 }, 12000);
      if (!Array.isArray(reply?.data) || reply.data.length > 100 ||
          (reply.nextCursor != null && (typeof reply.nextCursor !== 'string' || !reply.nextCursor)))
        throw new Error('Codex terminal pagination is incomplete');
      for (const terminal of reply.data) {
        if (![terminal?.itemId, terminal?.processId, terminal?.command, terminal?.cwd].every(value =>
          typeof value === 'string' && value.length > 0 && value.length <= 4096))
          throw new Error('Codex terminal identity is malformed');
        if (!known.has(terminal.itemId)) throw new Error('Codex thread contains an unowned terminal');
        if (terminals.some(item => item.itemId === terminal.itemId || item.processId === terminal.processId))
          throw new Error('Codex terminal identity is duplicated');
        terminals.push(terminal);
        if (terminals.length > 256) throw new Error('Codex terminal proof exceeds the process limit');
      }
      cursor = reply.nextCursor || null;
      if (!cursor) return terminals;
      if (cursors.has(cursor)) throw new Error('Codex terminal cursor repeated');
      cursors.add(cursor);
    }
    throw new Error('Codex terminal proof exceeds the page limit');
  }

  async function captureOwnedProcesses(entry) {
    const client = bridgeFor(entry.taskId);
    if (!client || bridgeFor(entry.taskId) !== client || client.dead || entry.bridgePid !== client.spawnedChild?.pid)
      throw new Error('Codex executor changed before process capture');
    const task = await getTask(entry.taskId);
    const project = task && await getProject(task.projectId);
    const workspace = task && project && await taskWorkspace(task, project);
    if (!task || task.conversationId !== entry.threadId || workspace?.directory !== entry.workspace)
      throw new Error('Codex task workspace changed before process capture');
    const baseline = executorBaselines.get(client);
    if (!baseline) throw new Error('Codex task executor prelaunch baseline is unavailable');
    const observed = await processProof.captureTaskExecutorTree({ baseline, taskId: entry.taskId,
      bridgePid: client.spawnedChild.pid, appServerPid: client.appServerPid,
      workspace: entry.workspace, pythonPath: pythonExecutable(client.pythonPath,executableBase) });
    if (!observed?.verified || !observed.capture)
      throw new Error(`Codex executor tree capture is unconfirmed: ${observed?.reason || 'unknown'}`);
    const terminals = await terminalList(client, entry);
    return { client, capture: client.job
      ? { scope: saved.executors[markerKey(entry.taskId)]?.kind==='linux-job'
        ?'linux-original-task-job-and-current-writers'
        :'macos-original-task-job-coalition-known-descendants-and-current-writers',
        knownIdentities: observed.identities }
      : observed.capture, identityCount: observed.identities?.length || 0, terminals };
  }

  async function finishOwnedProcesses(entry, prepared) {
    const { client, capture, terminals } = prepared;
    if (bridgeFor(entry.taskId) !== client || client.dead || entry.bridgePid !== client.spawnedChild?.pid)
      throw new Error('Codex executor changed before process termination');
    const current = await terminalList(client, entry);
    for (const terminal of current) {
      const original = terminals.find(item => item.itemId === terminal.itemId);
      if (!original || original.processId !== terminal.processId)
        throw new Error('Codex terminal handle changed after OS capture');
      const reply = await client.request('terminateBackgroundTerminal',
        { threadId: entry.threadId, processId: terminal.processId }, 12000);
      if (reply?.terminated !== true) throw new Error('Codex terminal termination was not acknowledged');
    }
    let reason = 'Codex terminal shutdown is unconfirmed';
    for (let attempt = 0; attempt < 20; attempt++) {
      const remaining = await terminalList(client, entry);
      if (remaining.length === 0) {
        if (bridgeFor(entry.taskId) !== client || client.dead || entry.bridgePid !== client.spawnedChild?.pid)
          throw new Error('Codex executor changed before retirement');
        if ((await terminalList(client, entry)).length)
          throw new Error('Codex reported a new terminal before retirement');
        const task = await getTask(entry.taskId);
        if (!task || task.conversationId !== entry.threadId)
          throw new Error('Codex task binding changed after OS command-exit proof');
        let thread;
        try { thread = await scopedThread(task); }
        catch (error) {
          if (entry.stopProof?.status === 'unverified')
            entry.stopProof.finalThreadCheck = finalThreadCheck(null, entry.turnId);
          throw error;
        }
        if (bridgeFor(entry.taskId) !== client || client.dead || entry.bridgePid !== client.spawnedChild?.pid)
          throw new Error('Codex executor changed during final thread verification');
        const lastTurn = Array.isArray(thread.turns) ? thread.turns.at(-1) : null;
        const expectedStatus = entry.status === 'running' ? 'interrupted' : entry.status;
        const finalCheck = finalThreadCheck(thread, entry.turnId);
        if (thread.status?.type !== 'idle' || !lastTurn || lastTurn.id !== entry.turnId ||
            lastTurn.status !== expectedStatus ||
            !['completed', 'failed', 'interrupted'].includes(lastTurn.status) ||
            !Array.isArray(thread.status.activeFlags || []) || (thread.status.activeFlags || []).length) {
          if (entry.stopProof?.status === 'unverified') entry.stopProof.finalThreadCheck = finalCheck;
          throw new Error('Codex target turn is not the final idle turn');
        }
        if ((await terminalList(client, entry)).length)
          throw new Error('Codex reported a new terminal after final thread verification');
        // The read-only conversation endpoint cannot launch a new Mac job after
        // this bridge retires. Capture only its already-public final output now;
        // a failed output write must never skip the original process retirement.
        const priorConversations = saved.completedConversations;
        try {
          const output = publicConversation(task, thread, saved.commands);
          const snapshot = captureCompletedConversation({ task, entry, thread, output,
            capturedAt: iso(now) });
          const bounded = snapshot && addCompletedConversation(priorConversations, snapshot, saved.commands);
          if (bounded) {
            saved.completedConversations = bounded;
            await persist();
          }
        } catch {
          saved.completedConversations = priorConversations;
        }
        // No task result is released while its own executor can still fork or
        // retain helper processes. Other tasks' executors remain untouched.
        const retired = await stopTrackedBridge(client, capture, {
          commandKey: `${entry.taskId}:${entry.commandId}`, threadId: entry.threadId,
          turnId: entry.turnId, status: lastTurn.status, bridgePid: entry.bridgePid,
          workspace: entry.workspace, identityCount: prepared.identityCount,
          turnError: lastTurn.status === 'failed' ? providerFailure(lastTurn.error).summary : null,
        });
        if (process.platform === 'linux' && client.job && (retired?.status !== 'reconciled' ||
            retired.linuxStoppedVerified === true || !['linux-original-task-job-and-managed-handoff',
              'linux-original-task-job-and-current-writers'].includes(retired.stopProofScope)))
          throw new Error('Original provider outcome remains unknown after process retirement');
        return { version: 1, status: 'verified', threadId: entry.threadId, turnId: entry.turnId,
          checkedAt: iso(now), scope: retired?.stopProofScope || capture.scope || null,
          identityCount: prepared.identityCount };
      }
      reason = 'Codex still reports a command terminal';
      if (attempt < 19) await new Promise(resolveWait => setTimeout(resolveWait, 250));
    }
    throw new Error(reason);
  }

  const unresolvedStop = entry => entry &&
    (['interrupted', 'verified_idle'].includes(entry.status) || entry.stopProof?.status === 'unverified' ||
      (['completed', 'failed'].includes(entry.status) && entry.stopProof?.status !== 'verified')) &&
    entry.stopProof?.status !== 'verified';

  // Two project IDs are not independent if their actual directories nest or
  // alias. An in-flight/unknown executor in either directory may write into
  // the workspace being handed to a human. Keep that executor untouched.
  async function assertNoOverlappingOtherExecutor(projectId, workspace) {
    const canonical = directory => {
      if (!validDirectory(directory)) throw new Error('Codex executor workspace is unknown');
      try { return realpathSync(directory); }
      catch { throw new Error('Codex executor workspace identity is unconfirmed'); }
    };
    const target = canonical(workspace);
    const inside = (parent, child) => {
      const part = relative(parent, child);
      return part === '' || (part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part));
    };
    const overlaps = directory => {
      const other = canonical(directory);
      return inside(target, other) || inside(other, target);
    };
    const tasks = new Map();
    const owner = async taskId => {
      if (!tasks.has(taskId)) tasks.set(taskId, await getTask(taskId));
      const task = tasks.get(taskId);
      if (!task?.projectId) throw new Error('Codex executor project ownership is unknown');
      return task;
    };
    for (const [key, marker] of Object.entries(saved.executors)) {
      if (!key.startsWith('task:')) continue;
      const task = await owner(key.slice(5));
      if (marker.projectId && marker.projectId !== task.projectId)
        throw new Error('Codex executor project ownership changed');
      if (task.projectId !== projectId && overlaps(marker.workspace))
        throw new Error('Another project has an active or unconfirmed Codex executor in an overlapping workspace');
    }
    for (const command of Object.values(saved.commands)) {
      if (!['sending', 'running', 'unknown', 'awaiting_approval'].includes(command.status) && !unresolvedStop(command)) continue;
      const task = await owner(command.taskId);
      if (task.projectId !== projectId && overlaps(command.workspace))
        throw new Error('Another project has an active or unconfirmed Codex command in an overlapping workspace');
    }
  }

  async function pauseTask(taskId, expectedRevision) {
    const task = await getTask(taskId);
    if (!task) throw new Error('Task not found');
    const entry = Object.values(saved.commands).reverse().find(command => command.taskId === taskId && command.threadId === task.conversationId &&
      ['sending', 'running', 'completed', 'unknown', 'awaiting_approval', 'interrupted', 'verified_idle'].includes(command.status));
    const ownRevisionChange = entry && entry.requestedRevision === expectedRevision && entry.taskRevision === task.revision;
    if (task.revision !== expectedRevision && !ownRevisionChange) throw new Error('Task revision changed');
    if (TERMINAL_TASKS.has(task.status) || task.acceptance === 'passed') throw new Error('Task is complete or submitted for review');
    // An idle task with no owned or unresolved execution only needs its future
    // automatic starts fenced. Opening an app-server merely to inspect that
    // thread can itself fail before any process is launched and leave a
    // harmless pending pause stuck as unknown. Active/unknown work never uses
    // this path and still requires the full stop proof below.
    const outstanding = Object.values(saved.commands).some(command => command.taskId === taskId &&
      (['sending', 'running', 'unknown', 'awaiting_approval'].includes(command.status) || unresolvedStop(command)));
    if (task.conversationId && !outstanding && !saved.executor &&
      !saved.executors[markerKey(taskId)] && !bridgeFor(taskId)) {
      let policy = saved.policies.find(item => item.taskId === taskId);
      if (!policy) { policy = { taskId, attempts: 0, maxAttempts: 3 }; saved.policies.push(policy); }
      policy.enabled = false; policy.status = 'paused'; policy.wakeAt = null;
      await persist();
      await updateTask(taskId, { status: 'paused' }, task.revision);
      status = 'paused'; lastError = null;
      return { status: 'paused', taskId, turnId: null };
    }
    if (!task.conversationId) {
      await updateTask(taskId, { status: 'paused' }, task.revision);
      let policy = saved.policies.find(item => item.taskId === taskId);
      if (!policy) { policy = { taskId, attempts: 0, maxAttempts: 3 }; saved.policies.push(policy); }
      policy.enabled = false; policy.status = 'paused'; policy.wakeAt = null;
      await persist();
      return { status: 'paused', taskId };
    }
    const originalLinuxJob=saved.executors[markerKey(taskId)];
    if(originalLinuxJob?.kind==='linux-job'&&!bridgeFor(taskId))
      return recheckRetiredLinuxJob(task,originalLinuxJob);
    let thread;
    try { thread = await scopedThread(task); }
    catch (error) { return pauseUnknown(taskId, errorText(error)); }
    let turn = thread.turns?.at(-1);
    if (thread.status?.type === 'idle' && turn?.status === 'inProgress') return pauseUnknown(taskId, 'Codex turn state is inconsistent');
    const activeTurn = [...(thread.turns || [])].reverse().find(item => item.status === 'inProgress');
    const turnId = activeTurn?.id || null;
    let interruptAcknowledged = false;
    let interruptError = null;
    let prepared = null;
    let captureError = null;
    if (thread.status?.type === 'active') {
      if (!turnId || !entry?.turnId || turnId !== entry.turnId) {
        return pauseUnknown(taskId, 'Active Codex turn does not match the taskboard-owned turn');
      }
      entry.stopProof = { version: 1, status: 'unverified', threadId: task.conversationId, turnId,
        reason: 'Stop requested; command process exit not confirmed', checkedAt: iso(now) };
      await persist();
      try { prepared = await captureOwnedProcesses(entry); }
      catch (error) { captureError = errorText(error); }
      try {
        await (await connection(taskId, entry.workspace, task.projectId)).request('interrupt', { threadId: task.conversationId, turnId }, 12000);
        interruptAcknowledged = true;
      } catch (error) { interruptError = errorText(error); }
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          thread = await scopedThread(task);
          turn = thread.turns?.find(item => item.id === turnId) || thread.turns?.at(-1);
          if (thread.status?.type === 'idle' && turn?.status !== 'inProgress') break;
        } catch (error) { interruptError = errorText(error); }
        if (attempt < 2) await new Promise(resolveWait => setTimeout(resolveWait, 100));
      }
      if (thread.status?.type !== 'idle' || turn?.status === 'inProgress') {
        return pauseUnknown(taskId, interruptError || 'Codex did not confirm that the turn stopped');
      }
    }
    if (turn?.status === 'completed' && entry?.turnId === turn.id) {
      await handleCompletion({ threadId: task.conversationId, turn }, { allowDuringPause: true, ownerTaskId: taskId });
      return unresolvedStop(entry) ? pauseUnknown(taskId, entry.stopProof?.reason || 'Command exit unconfirmed')
        : { status: 'completed', taskId, turnId: turn.id };
    }
    if (turn?.status === 'failed' && entry?.turnId === turn.id) {
      await handleCompletion({ threadId: task.conversationId, turn }, { allowDuringPause: true, ownerTaskId: taskId });
      return unresolvedStop(entry) ? pauseUnknown(taskId, entry.stopProof?.reason || 'Command exit unconfirmed')
        : { status: 'failed', taskId, turnId: turn.id };
    }
    if (thread.status?.type !== 'idle') return pauseUnknown(taskId, 'Codex thread is not idle after pause');
    if (turnId && turn?.id !== turnId && !interruptAcknowledged) return pauseUnknown(taskId, 'Interrupted turn could not be reconciled');
    if (entry && (turnId || unresolvedStop(entry))) {
      if (prepared && turn?.status === 'interrupted') {
        try {
          if (!entry.turnCompleteEvent) throw new Error('Codex interrupted-turn completion stream was not observed');
          entry.stopProof = await finishOwnedProcesses(entry, prepared);
          await persist();
        } catch (error) { captureError = errorText(error); }
      }
      if (entry.stopProof?.status !== 'verified') {
        entry.status = turn?.status === 'interrupted' ? 'interrupted' : entry.status;
        const finalCheck = entry.stopProof?.finalThreadCheck;
        entry.stopProof = { version: 1, status: 'unverified', threadId: task.conversationId,
          turnId: entry.turnId || turnId || null,
          reason: captureError || 'Codex command process exit is unconfirmed', checkedAt: iso(now),
          ...(finalCheck ? { finalThreadCheck: finalCheck } : {}) };
        await persist();
        return pauseUnknown(taskId, entry.stopProof.reason);
      }
    }
    const latest = await getTask(taskId);
    if (!latest || latest.conversationId !== task.conversationId || TERMINAL_TASKS.has(latest.status)) {
      return pauseUnknown(taskId, 'Task changed while pausing');
    }
    await updateTask(taskId, { status: 'paused' }, latest.revision);
    if (entry && entry.turnId === turnId) { entry.status = 'interrupted'; entry.completedAt = iso(now); }
    let policy = saved.policies.find(item => item.taskId === taskId);
    if (!policy) { policy = { taskId, attempts: 0, maxAttempts: 3 }; saved.policies.push(policy); }
    policy.enabled = false; policy.status = 'paused'; policy.wakeAt = null; policy.lastError = null;
    status = 'paused'; lastError = null;
    await persist();
    return { status: 'paused', taskId, turnId: turnId || null };
  }

  async function recheckRetiredExecutor(task) {
    const taskId = task.id, key = markerKey(taskId);
    const marker = saved.executors[key];
    if(marker?.kind==='linux-job')return recheckRetiredLinuxJob(task,marker);
    if (marker?.kind === 'macos-job') return recheckRetiredJob(task, marker);
    const record = retirementRecords.get(taskId);
    const unknownResult = async reason => {
      if (saved.executors[key] === marker && marker?.status === 'retirement_unknown') {
        marker.reason = reason;
        await persist();
      }
      const policy = saved.policies.find(item => item.taskId === taskId);
      if (policy) { policy.enabled = false; policy.status = 'unknown'; policy.lastError = reason; policy.wakeAt = null; await persist(); }
      status = 'unknown'; lastError = reason;
      return { status: 'unknown', taskId, taskStatus: (await getTask(taskId))?.status || null, error: reason, resolvedTurns: 0 };
    };
    // A durable marker survives restart; its opaque baseline/capture does not.
    // Neither a dead PGID nor an idle provider thread substitutes for it.
    if (!record || !record.capture || !record.stopAttempted || marker !== record.marker ||
        marker?.status !== 'retirement_unknown' || marker.pid !== record.pid || marker.retirementId !== record.retirementId ||
        !record.identity || bridgeFor(taskId))
      return unknownResult('Original task executor retirement capture is unavailable or binding changed');
    const bindingMatches = async currentTask => {
      const expected = record.identity;
      // Content edits cannot change the identity of the already captured
      // executor. Check its task/thread/workspace binding here, then evaluate
      // the old turn's freshness separately before updating the task.
      if (!currentTask || currentTask.id !== taskId || currentTask.projectId !== expected.projectId ||
          currentTask.conversationId !== expected.threadId ||
          marker !== saved.executors[key] || marker.pid !== record.pid || marker.retirementId !== record.retirementId ||
          marker.projectId !== expected.projectId || marker.workspace !== expected.workspace ||
          (marker.threadId || null) !== expected.threadId) return false;
      try {
        const project = await getProject(expected.projectId);
        if (!project || project.directory !== expected.projectDirectory) return false;
        const workspace = await taskWorkspace(currentTask, project, expected.worktreeId);
        return workspace.directory === expected.workspace &&
          realpathSync(workspace.directory) === realpathSync(expected.workspace);
      } catch { return false; }
    };
    if (!(await bindingMatches(task))) return unknownResult('Task, conversation, or workspace changed since executor retirement');
    let retired;
    try {
      retired = await processProof.verifyTaskExecutorRetired({ capture: record.capture,
        taskId, bridgePid: record.pid, appServerPid: record.appServerPid,
        workspace: record.identity.workspace, pythonPath: pythonExecutable(record.candidate.pythonPath,executableBase) });
    } catch (error) { return unknownResult(errorText(error)); }
    if (retired?.verified !== true || retired.retired !== true)
      return unknownResult(retired?.reason || 'Dedicated executor retirement is still unconfirmed');
    const fresh = await getTask(taskId);
    if (!(await bindingMatches(fresh))) return unknownResult('Task, conversation, or workspace changed during executor recheck');
    const meta = record.proofMeta;
    const entry = meta && saved.commands[meta.commandKey];
    const eligible = entry && entry.taskId === taskId && entry.threadId === meta.threadId &&
      entry.turnId === meta.turnId && entry.bridgePid === meta.bridgePid &&
      entry.workspace === meta.workspace && entry.status === meta.status &&
      ['interrupted', 'completed', 'failed'].includes(meta.status) &&
      entry.turnCompleteEvent === true;
    const staleResult = eligible && !resultMatchesTaskContent(entry, fresh);
    // The OS proof establishes only process retirement. A sending/unknown
    // command without the earlier scoped final-turn checks remains unknown.
    let latest = fresh;
    if (eligible && !staleResult && fresh.status === 'running') {
      const detail = meta.turnError ? typeof meta.turnError === 'string'
        ? meta.turnError : JSON.stringify(meta.turnError) : '';
      const quotaFailure = /quota|rate.?limit|usage.?limit|额度|限额/i.test(detail);
      const patch = meta.status === 'interrupted'
        ? { status: 'paused' }
        : meta.status === 'completed'
          ? { status: 'submitted', blockedReason: '' }
          : quotaFailure
            ? { status: 'blocked', blockedReason: detail || 'Codex quota exhausted' }
            : { status: 'failed', blockedReason: detail || 'Codex turn failed' };
      try { latest = await updateTask(taskId, patch, fresh.revision); }
      catch (error) { return unknownResult(errorText(error)); }
      if (latest?.id !== taskId || latest.projectId !== fresh.projectId ||
          latest.conversationId !== fresh.conversationId || latest.status !== patch.status ||
          latest.contentVersion !== fresh.contentVersion)
        return unknownResult('Task update after retirement proof changed its identity or content');
    }
    // A manual pause/cancellation is not an executor identity change. Keep
    // that task state while recording the independently verified retirement.
    const previousStopProof = entry?.stopProof;
    if (eligible) entry.stopProof = { version: 1, status: 'verified',
      threadId: meta.threadId, turnId: meta.turnId, checkedAt: iso(now),
      scope: record.capture.scope || null, identityCount: meta.identityCount };
    if (staleResult) {
      entry.stale = true;
      entry.taskUpdateError = 'Task content changed after this Codex turn began; submit the updated task again';
    }
    for (const command of Object.values(saved.commands)) {
      if (command.taskId === taskId && command.bridgePid === record.pid &&
          ['sending', 'running', 'awaiting_approval'].includes(command.status)) {
        command.status = 'unknown';
        command.error = 'Executor retired, but this turn outcome remains unconfirmed';
      }
    }
    delete saved.executors[key];
    const unresolved = Object.values(saved.commands).some(command => command.taskId === taskId &&
      (['sending', 'unknown', 'awaiting_approval'].includes(command.status) || unresolvedStop(command)));
    let policy = saved.policies.find(item => item.taskId === taskId);
    if (!policy) { policy = { taskId, attempts: 0, maxAttempts: 3 }; saved.policies.push(policy); }
    policy.enabled = false; policy.status = unresolved ? 'unknown' : staleResult ? 'stale_result' : latest.status === 'paused' ? 'paused' : 'reconciled';
    policy.lastError = unresolved ? 'Command outcome or process exit remains unconfirmed' : staleResult ? entry.taskUpdateError : null;
    policy.wakeAt = null;
    status = Object.values(saved.executors).some(item => item.status === 'retirement_unknown' || item.status === 'startup_unknown') || unresolved
      ? 'unknown' : policy.status;
    lastError = status === 'unknown' ? policy.lastError || 'Another executor retirement is unconfirmed' : policy.lastError;
    try { await persist(); }
    catch (error) {
      // Do not route a retry into normal thread loading or expose a releasable
      // execution until the verified retirement has a durable receipt.
      saved.executors[key] = marker;
      if (eligible) {
        if (previousStopProof === undefined) delete entry.stopProof;
        else entry.stopProof = previousStopProof;
      }
      marker.reason = `Could not save executor retirement proof: ${errorText(error)}`;
      policy.enabled = false; policy.status = 'unknown'; policy.wakeAt = null; policy.lastError = marker.reason;
      status = 'unknown'; lastError = marker.reason;
      throw error;
    }
    retirementRecords.delete(taskId);
    if (eventShutdowns.delete(record.candidate)) refreshPendingBridgeShutdown();
    const result = { status: policy.status, taskId, taskStatus: latest.status,
      resolvedTurns: eligible ? 1 : 0 };
    completedRetirementRechecks.set(taskId, { revision: latest.revision, result });
    return result;
  }

  async function recheckRetiredLinuxJob(task,marker) {
    const taskId=task.id,key=markerKey(taskId);
    const fail=async error=>{
      if(saved.executors[key]===marker&&marker.status!=='stopped_unknown'){
        marker.status='retirement_unknown';marker.reason=errorText(error);await persist();
      }
      status='unknown';lastError=errorText(error);
      return {status:'unknown',taskId,taskStatus:(await getTask(taskId))?.status||null,
        error:errorText(error),resolvedTurns:0};
    };
    try{
      if(bridgeFor(taskId)||marker.taskId!==taskId||marker.projectId!==task.projectId)
        throw new Error('Original Linux job task binding changed');
      const recovered=await recoverLinuxTaskJob({recordRoot:marker.recordRoot,
        recordId:marker.recordId,taskId,projectId:marker.projectId,workspace:marker.workspace,
        pythonPath:pythonExecutable(saved.config.pythonPath,executableBase)});
      if(recovered.verified!==true||!recovered.job)
        throw new Error(recovered.reason||'Original Linux job recovery is unconfirmed');
      return await stopOriginalLinuxJob(taskId,marker,recovered.job);
    }catch(error){return fail(error);}
  }

  async function recheckRetiredJob(task, marker,forDisposition=false) {
    const taskId = task.id, key = markerKey(taskId);
    const reject = async reason => {
      if (saved.executors[key] === marker) {
        // A previously proven stopped-unknown receipt remains durable even
        // when a later read cannot revalidate it. Never make that receipt
        // unusable by rewriting its status during a non-close operation.
        if(marker.status!=='stopped_unknown'){
          marker.status = 'retirement_unknown'; marker.reason = reason;
          await persist();
        }
      }
      status = 'unknown'; lastError = reason;
      return { status: 'unknown', taskId, taskStatus: (await getTask(taskId))?.status || null,
        error: reason, resolvedTurns: 0 };
    };
    if (bridgeFor(taskId) || marker.taskId !== taskId || !marker.recordId ||
        marker.projectId !== task.projectId)
      return reject('Original task job or task binding is unavailable');
    const project = await getProject(task.projectId);
    let workspace;
    try { workspace = await taskJobWorkspace(task, project, marker); }
    catch { return reject('Task job workspace binding changed'); }
    if (!project || !originalJobWorkspace(marker, workspace.directory) ||
        marker.recordRoot !== await taskJobs.taskJobRecordRoot(dataDir))
      return reject('Task job workspace or private record root changed');
    if(marker.shutdownStopIntent&&marker.shutdownStopProof&&
        (!marker.shutdownStoppedReceipt||
          JSON.stringify(marker.shutdownStopProof)===JSON.stringify(marker.shutdownStoppedReceipt))){
      try{
        const receipt=marker.shutdownStopProof;
        const record=await taskJobs.verifyHistoricalRetiredTaskJobMarker({recordRoot:marker.recordRoot,
          recordId:marker.recordId,taskId,workspace:marker.canonicalWorkspace});
        if(record.boot!==await taskJobs.currentTaskJobBoot()){
          const command=saved.commands[`${taskId}:${receipt.commandId}`];
          if(record.attempted!==true||!record.identity||record.identity.pid!==receipt.bridgePid||
            record.generation<receipt.recordGeneration||receipt.recordId!==marker.recordId||
            !isUnresolvedShutdownTurn(command,receipt,{allowUnknown:true})||
            marker.captureComplete!==true||!Array.isArray(marker.knownIdentities)||
            marker.knownIdentities.length<2)
            return reject('Original historical shutdown receipt is unconfirmed');
          if(typeof retireExecutorStartup!=='function')
            return reject('Original startup lease retirement authority is unavailable');
          await retireExecutorStartup({taskId,startupId:marker.startupId,recordId:marker.recordId,
            settledCommands:[],shutdownUnknown:receipt});
          await finalizeShutdownUnknown(taskId,marker,command,receipt);
          return {status:'unknown',error:'Original provider turn outcome remains unconfirmed',
            shutdownStoppedVerified:closed,taskId,taskStatus:(await getTask(taskId))?.status||null,
            resolvedTurns:0};
        }
      }catch{return reject('Original historical shutdown receipt is unconfirmed');}
    }
    let record = retirementRecords.get(taskId), job = record?.job;
    if (record && (record.marker !== marker || record.job.recordId !== marker.recordId))
      return reject('Original task job retirement record changed');
    if (!job) {
      const recovered = await taskJobs.recoverTaskJob({ recordRoot: marker.recordRoot,
        recordId: marker.recordId, taskId, workspace: marker.workspace,
        pythonPath: pythonExecutable(saved.config.pythonPath,executableBase) });
      if (!recovered.verified || !recovered.job)
        return reject(recovered.reason || 'Original task job recovery is unconfirmed');
      job = recovered.job;
    }
    if((workspace.worktreeId||null)!==(marker.worktreeId||null))
      return reject('Task job worktree binding changed');
    const retired = await taskJobs.verifyTaskJobRetired({ job, workspace: marker.workspace,
      pythonPath: pythonExecutable(saved.config.pythonPath,executableBase),
      knownIdentities: marker.knownIdentities || [],verifyRetirementWorkspace,
      retirementBinding:{taskId,recordId:marker.recordId,workspace:marker.workspace,
        worktreeId:marker.worktreeId??null,expectedHandoffGeneration:marker.expectedHandoffGeneration??null} });
    if (!retired.verified || !retired.retired)
      return reject(retired.reason || 'Original task job retirement is unconfirmed');
    if (marker.captureComplete !== true || !Array.isArray(marker.knownIdentities))
      return reject('Original task member capture is unavailable after original job stop');
    if(marker.shutdownStopIntent){
      const receipt=marker.shutdownStoppedReceipt;
      const command=receipt&&saved.commands[`${taskId}:${receipt.commandId}`];
      if(forDisposition&&marker.status==='stopped_unknown'&&receipt&&
        retired.scope===receipt.proofScope&&
        JSON.stringify(marker.shutdownStopProof)===JSON.stringify(receipt)&&
        isUnresolvedShutdownTurn(command,receipt,{allowUnknown:true}))
        return {status:'unknown',shutdownStoppedVerified:true,taskId,
          taskStatus:(await getTask(taskId))?.status||null,resolvedTurns:0};
      try { await settleShutdownUnknownJob(taskId,marker,retired); }
      catch { return reject('Original shutdown process or unknown outcome receipt is unconfirmed'); }
      return {status:'unknown',error:'Original provider turn outcome remains unconfirmed',
        shutdownStoppedVerified:true,taskId,taskStatus:(await getTask(taskId))?.status||null,
        resolvedTurns:0};
    }
    const fresh = await getTask(taskId), freshProject = fresh && await getProject(fresh.projectId);
    let freshWorkspace;
    try { freshWorkspace = fresh && freshProject && await taskJobWorkspace(fresh, freshProject, marker); }
    catch { return reject('Task job binding changed during retirement recheck'); }
    if (!fresh || fresh.projectId !== task.projectId ||
        !originalJobWorkspace(marker, freshWorkspace?.directory) ||
        (record?.identity && (fresh.conversationId || null) !== record.identity.threadId))
      return reject('Task job binding changed during retirement recheck');
    const meta = marker.finalTurnProof || record?.proofMeta;
    const entry = meta && saved.commands[meta.commandKey];
    const originalTurnMatches = !!entry && entry.taskId === taskId && entry.threadId === meta.threadId &&
      meta.commandKey === `${taskId}:${marker.lastCommandId}` &&
      entry.turnId === meta.turnId && entry.bridgePid === meta.bridgePid &&
      entry.bridgePid === marker.pid && entry.workspace === meta.workspace &&
      entry.workspace === marker.workspace && entry.status === meta.status &&
      ['interrupted', 'completed', 'failed'].includes(meta.status) &&
      entry.turnCompleteEvent === true;
    const originalCommand=marker.lastCommandId&&saved.commands[`${taskId}:${marker.lastCommandId}`];
    if(originalCommand?.turnId&&originalCommand.stopProof?.status!=='verified'&&!originalTurnMatches)
      return reject('Original final turn proof is unavailable or changed');
    const staleResult=originalTurnMatches&&!resultMatchesTaskContent(entry,fresh);
    let latest = fresh;
    if (originalTurnMatches && !staleResult && fresh.status === 'running') {
      const detail = meta.turnError ? typeof meta.turnError === 'string'
        ? meta.turnError : JSON.stringify(meta.turnError) : '';
      const quotaFailure = /quota|rate.?limit|usage.?limit|额度|限额/i.test(detail);
      const patch = meta.status === 'interrupted' ? { status: 'paused' }
        : meta.status === 'completed' ? { status: 'submitted', blockedReason: '' }
          : quotaFailure ? { status: 'blocked', blockedReason: detail || 'Codex quota exhausted' }
            : { status: 'failed', blockedReason: detail || 'Codex turn failed' };
      try { latest = await updateTask(taskId, patch, fresh.revision); }
      catch (error) { return reject(errorText(error)); }
      if (!latest || latest.id !== taskId || latest.projectId !== fresh.projectId ||
          latest.conversationId !== fresh.conversationId || latest.status !== patch.status ||
          latest.contentVersion !== fresh.contentVersion)
        return reject('Task changed after job retirement proof');
    }
    if (originalTurnMatches) entry.stopProof = { version: 1, status: 'verified',
      threadId: meta.threadId, turnId: meta.turnId, checkedAt: iso(now),
      scope: retired.scope, identityCount: meta.identityCount };
    if(staleResult){entry.stale=true;
      entry.taskUpdateError='Task content changed after this Codex turn began; submit the updated task again';}
    for (const command of Object.values(saved.commands)) {
      if (command.taskId === taskId && command.bridgePid === marker.pid &&
          ['sending', 'running', 'awaiting_approval'].includes(command.status)) {
        command.status = 'unknown';
        command.error = 'Task job retired, but the original turn outcome remains unconfirmed';
      }
    }
    if(marker.startupId){
      try{
        if(typeof retireExecutorStartup!=='function')throw new Error('Original startup lease retirement authority is unavailable');
        await retireExecutorStartup({taskId,startupId:marker.startupId,recordId:marker.recordId,
          settledCommands:settledStartupCommands(taskId,marker)});
      }catch(error){return reject('Original startup lease retirement is unconfirmed');}
    }
    const originalPolicy=saved.policies.find(item=>item.taskId===taskId);
    const previousPolicy=originalPolicy?structuredClone(originalPolicy):null;
    settleExecutorUnknownPolicy(taskId,marker,entry,staleResult,latest);
    delete saved.executors[key];
    try { await persist(); }
    catch (error) { saved.executors[key] = marker;
      if (originalTurnMatches) entry.stopProof = { version: 1, status: 'unverified', reason: 'Retirement receipt was not saved' };
      if (originalPolicy&&previousPolicy){
        for(const field of Object.keys(originalPolicy))delete originalPolicy[field];
        Object.assign(originalPolicy,previousPolicy);
      }
      return reject(errorText(error)); }
    retirementRecords.delete(taskId);
    await job.dispose().catch(() => {});
    const unresolved = Object.values(saved.commands).some(command => command.taskId === taskId &&
      (['sending', 'unknown', 'awaiting_approval'].includes(command.status) || unresolvedStop(command)));
    return { status: unresolved || originalPolicy?.status === 'unknown' ? 'unknown' :
      staleResult ? 'stale_result' : latest.status === 'paused' ? 'paused' : 'reconciled', taskId,
      taskStatus: latest.status, resolvedTurns: originalTurnMatches ? 1 : 0 };
  }

  async function reconcileTask(taskId, expectedRevision, expectedRetirementId) {
    const task = await getTask(taskId);
    if (!task) throw new Error('Task not found');
    if (task.revision !== expectedRevision) throw new Error('Task revision changed');
    // A caller asking about one observed retirement must never fall back to
    // loading a thread/new executor if that record changed while queued.
    // The opaque ID is independent of the PID, which can later be reused.
    const marker = saved.executors[markerKey(taskId)];
    if (expectedRetirementId !== undefined && (marker?.status !== 'retirement_unknown' ||
        marker.retirementId !== expectedRetirementId))
      return { status: 'unknown', taskId, taskStatus: task.status,
        error: 'Original executor retirement record changed or is unavailable', resolvedTurns: 0 };
    if (saved.executors[markerKey(taskId)]?.status === 'retirement_unknown' ||
        ['macos-job','linux-job'].includes(saved.executors[markerKey(taskId)]?.kind))
      return recheckRetiredExecutor(task);
    const completedRecheck = completedRetirementRechecks.get(taskId);
    if (completedRecheck?.revision === task.revision) return { ...completedRecheck.result };
    if (closed) throw new Error('plugin closed');
    let thread = await scopedThread(task);
    if (thread.status?.type === 'notLoaded') {
      const project = await getProject(task.projectId);
      const workspace = await taskWorkspace(task, project);
      const response = await (await connection(taskId, workspace.directory, task.projectId)).request('resumeThread', { threadId: task.conversationId, cwd: workspace.directory });
      thread = response?.thread;
      if (!thread || thread.id !== task.conversationId || !validDirectory(thread.cwd) || resolve(thread.cwd) !== resolve(workspace.directory)) {
        throw new Error('Codex thread changed identity or directory while loading');
      }
    }
    if (thread.status?.type !== 'idle' || (thread.status?.activeFlags || []).some(flag => ACTIVE_FLAGS.has(flag)) || thread.turns?.some(turn => turn.status === 'inProgress')) {
      throw new Error('Codex conversation is still active or awaiting approval; reconciliation cannot clear the lock');
    }
    const entries = Object.values(saved.commands).filter(command => command.taskId === taskId && command.threadId === task.conversationId &&
      (['unknown', 'sending', 'awaiting_approval'].includes(command.status) || unresolvedStop(command)));
    let resolvedTurns = 0;
    for (const entry of entries) {
      const turn = thread.turns?.find(item => item.id === entry.turnId);
      if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
        await handleCompletion({ threadId: task.conversationId, turn }, { allowBlocked: true, ownerTaskId: taskId });
        if (!unresolvedStop(entry)) resolvedTurns++;
      } else {
        entry.status = 'unknown';
        entry.error = 'Conversation is idle, but the previous send and command process exit remain unconfirmed';
      }
    }
    let policy = saved.policies.find(item => item.taskId === taskId);
    if (!policy) { policy = { taskId, attempts: 0, maxAttempts: 3 }; saved.policies.push(policy); }
    policy.enabled = false;
    const staleResult = entries.some(entry => entry.stale);
    policy.status = staleResult ? 'stale_result' : resolvedTurns ? 'reconciled' : 'unknown';
    policy.lastError = staleResult
      ? 'Task content changed after this Codex turn began; submit the updated task again'
      : resolvedTurns ? null : 'Conversation is idle, but previous send and process exit are unconfirmed';
    policy.wakeAt = null;
    approvalThreads.delete(threadKey(taskId, task.conversationId));
    for(const session of Object.values(saved.sessions))if(session.taskId===taskId&&['unknown','creating'].includes(session.status)){session.status='reconciled';session.threadId=task.conversationId;}
    status = policy.status;
    lastError = null;
    await persist();
    const latest = await getTask(taskId);
    return { status: policy.status, taskId, taskStatus: latest?.status || null, resolvedTurns };
  }

  function prompt(task,instructions='',handoff=null) {
    return `Continue the taskboard task "${task.title}".\nGoal: ${task.goal}\n` +
      `Acceptance criteria: ${(task.criteria||[]).map(c=>c.text).join('; ')}\nCurrent approach: ${task.approach||''}\nNext step: ${task.nextStep||''}\n${instructions}\n`+
      `${formatHandoffContext(handoff)}\n`+
      `Use the existing conversation context. Continue only this task. Report progress and evidence in this conversation.\n` +
      `Taskboard task ID: ${task.id}`;
  }

  async function send(taskId, commandId, { automatic = false, expectedRevision, instructions='', model, evidenceOnly=false, allowSubmitted=false, worktreeId=undefined, workspace=undefined } = {}) {
    if (closed || disableRequested || pauseRequested.has(taskId)) throw new Error('Resume cancelled before send by pause or disable');
    if (!commandId || typeof commandId !== 'string') throw new Error('commandId is required');
    if (!automatic && !Number.isInteger(expectedRevision)) throw new Error('expectedRevision is required');
    const key = `${taskId}:${commandId}`;
    if(typeof instructions!=='string'||instructions.length>10000||model!==undefined&&(typeof model!=='string'||!model.trim()||model.length>240)||typeof evidenceOnly!=='boolean')throw new Error('Invalid execution options');
    const requestHash=createHash('sha256').update(JSON.stringify({taskId,expectedRevision:expectedRevision??null,instructions,model:model??null,evidenceOnly,allowSubmitted,worktreeId:worktreeId??null,workspace:workspace??null})).digest('hex');
    if (saved.commands[key]) {
      if (saved.commands[key].requestHash && saved.commands[key].requestHash !== requestHash) throw new Error('commandId payload changed');
      const previous = clone(saved.commands[key]);
      return unresolvedStop(previous) ? { ...previous, status: 'unknown' } : previous;
    }
    if (Object.values(saved.commands).some(command => command.taskId === taskId &&
        !isDisposedUnknownCommand(command)&&
        (['sending', 'unknown'].includes(command.status) || unresolvedStop(command)))) {
      throw new Error('A previous send outcome is unknown; inspect the Codex conversation before another resume');
    }
    const policy = saved.policies.find(item => item.taskId === taskId);
    if (automatic) assertAutomaticSend(policy, commandId);
    if (policy?.status === 'paused' && automatic) throw new Error('Task was manually paused');
    const { task, project, workspace: boundWorkspace } = await verify(taskId, { automatic, allowSubmitted, worktreeId, commandId });
    if (automatic) assertAutomaticSend(policy, commandId);
    if (automatic) await assertRestartBinding(policy);
    if (automatic) await assertPlanIntent(policy);
    if (workspace !== undefined && workspace !== boundWorkspace.directory) throw new Error('Requested workspace differs from bound Codex session');
    if (expectedRevision !== undefined && task.revision !== expectedRevision) throw new Error('Task revision changed');
    const quota = await readQuota();
    if (automatic) assertAutomaticSend(policy, commandId);
    if (!quota.ready) {
      if (policy) { policy.status = 'waiting_quota'; policy.wakeAt = quota.wakeAt ? new Date(quota.wakeAt * 1000).toISOString() : null;
        if (automatic) policy.pendingAutoCommandId = null; await persist(); }
      status = 'waiting_quota';
      return { status: 'waiting_quota', wakeAt: quota.wakeAt ? new Date(quota.wakeAt * 1000).toISOString() : null };
    }
    // Recheck immediately before the irreversible send, after the quota read.
    const refreshed = await verify(taskId, { automatic, allowSubmitted, worktreeId, commandId });
    if (automatic) assertAutomaticSend(policy, commandId);
    if (automatic) await assertRestartBinding(policy);
    if (automatic) await assertPlanIntent(policy);
    if (refreshed.task.revision !== task.revision) throw new Error('Task changed before resume');
    if (refreshed.workspace.directory !== boundWorkspace.directory) throw new Error('Worktree binding changed before resume');
    const lastQuota = await readQuota();
    if (automatic) assertAutomaticSend(policy, commandId);
    if (!lastQuota.ready) {
      if (policy) { policy.status = 'waiting_quota'; policy.wakeAt = lastQuota.wakeAt ? new Date(lastQuota.wakeAt * 1000).toISOString() : null;
        if (automatic) policy.pendingAutoCommandId = null; await persist(); }
      status = 'waiting_quota';
      return { status: 'waiting_quota', wakeAt: lastQuota.wakeAt ? new Date(lastQuota.wakeAt * 1000).toISOString() : null };
    }
    if (closed || disableRequested || pauseRequested.has(taskId)) throw new Error('Resume cancelled before send by pause or disable');
    const finalTask = await getTask(taskId);
    if (!finalTask || finalTask.revision !== task.revision || (TERMINAL_TASKS.has(finalTask.status) && !(allowSubmitted && finalTask.status === 'submitted')) || finalTask.status === 'paused' && automatic) {
      throw new Error('Task changed or stopped before resume');
    }
    if (automatic) await assertRestartBinding(policy);
    if (automatic) await assertPlanIntent(policy);
    const authorizedStartup=startupFields(taskId);
    await admitLinuxExecutor({taskId,commandId,workspace:boundWorkspace.directory,
      worktreeId:boundWorkspace.worktreeId,client:bridgeFor(taskId)});
    const authorization=await authorizeExecution({taskId,commandId,worktreeId:boundWorkspace.worktreeId,workspace:boundWorkspace.directory,
      expectedRevision:automatic&&policy?.restartBinding?policy.restartBinding.revision:task.revision,
      ...authorizedStartup});
    if(authorization===false||authorization?.maySend===false||authorization?.allowed===false)throw new Error('Execution authorization was not granted');
    const boundMarker=saved.executors[markerKey(taskId)];
    const originalStartupMatches=boundMarker?.kind==='linux-job'
      ?boundMarker.recordId===bridgeFor(taskId)?.job?.recordId&&
        boundMarker.workspace===boundWorkspace.directory&&
        boundMarker.pid===bridgeFor(taskId)?.spawnedChild?.pid&&
        boundMarker.appServerPid===bridgeFor(taskId)?.appServerPid
      :!authorizedStartup.startupId||
      (boundMarker?.startupId===authorizedStartup.startupId&&
       boundMarker.recordId===authorizedStartup.recordId&&
       boundMarker.workspace===boundWorkspace.directory&&
       Number.isSafeInteger(boundMarker.pid)&&boundMarker.pid>=2);
    const entry = { taskId, commandId, requestHash,displayText:instructions,requestedModel:model||null,evidenceOnly, threadId: task.conversationId, worktreeId:boundWorkspace.worktreeId, workspace: boundWorkspace.directory, requestedRevision: task.revision, requestedContentVersion: task.contentVersion, status: 'sending', at: iso(now),
      ...(automatic?{automaticPlanId:policy.planId}:{}),
      ...(authorizedStartup.startupId||boundMarker?.kind==='linux-job'?{bridgePid:boundMarker?.pid??null}:{}) };
    saved.commands[key] = entry;
    if((authorizedStartup.startupId||boundMarker?.kind==='linux-job')&&originalStartupMatches)
      boundMarker.lastCommandId=commandId;
    if (policy) { policy.threadId = task.conversationId; policy.status = 'sending'; }
    await persist();
    try {
      if(!originalStartupMatches)throw new Error('Original startup command executor changed after authorization');
      if (automatic) assertAutomaticSend(policy, commandId);
      if (automatic) await assertRestartBinding(policy);
      if (automatic) await assertPlanIntent(policy);
    } catch (error) {
      // Core may already hold this command's lease. Persist an explicit
      // no-provider-send outcome before returning; a failed write retains the
      // durable sending receipt as unknown for lease reconciliation.
      entry.status = 'cancelled'; entry.error = errorText(error);
      if (policy && !preserveHumanStop(policy)) {
        if (!['budget_exhausted','attempts_exhausted','retry_stopped','unknown','awaiting_approval'].includes(policy.status))
          policy.status = 'retry_stopped';
        policy.enabled = false;
        policy.lastError = entry.error;
      }
      await persist();
      throw error;
    }
    const cancelBeforeSend = async () => {
      if (!closed && !disableRequested && !pauseRequested.has(taskId)) return false;
      entry.status = 'cancelled';
      preserveHumanStop(policy);
      await persist();
      return true;
    };
    if (await cancelBeforeSend()) throw new Error('Resume cancelled before send');
    let activeBridge;
    try { activeBridge = await connection(taskId, boundWorkspace.directory, task.projectId,
      null,commandId,'turn'); }
    catch (error) {
      entry.status = 'failed'; entry.error = errorText(error);
      if (policy && !preserveHumanStop(policy)) { policy.status = 'failed'; policy.lastError = entry.error; }
      await persist();
      throw error;
    }
    if (await cancelBeforeSend()) throw new Error('Resume cancelled before send');
    try {
      const validation = await revalidateExecution({taskId,commandId,
        ...startupFields(taskId),workspace:boundWorkspace.directory,
        expectedRevision:automatic&&policy?.restartBinding?policy.restartBinding.revision:task.revision,
        expectedConversationId:automatic&&policy?.restartBinding?policy.restartBinding.threadId:task.conversationId||null,
        expectedDirectory:automatic&&policy?.restartBinding?policy.restartBinding.workspace:boundWorkspace.directory,
        ...(boundWorkspace.worktreeId?{worktreeId:boundWorkspace.worktreeId}:{})});
      if (automatic) assertAutomaticSend(policy, commandId);
      if(validation===false||validation?.allowed===false||validation?.maySend===false||closed||disableRequested||pauseRequested.has(taskId))throw new Error('Execution was cancelled before provider start');
      if (automatic) await assertRestartBinding(policy);
    } catch(error) {
      entry.status='failed';entry.error=errorText(error);
      if(policy && !preserveHumanStop(policy)){if(!['budget_exhausted','attempts_exhausted','retry_stopped','unknown','awaiting_approval'].includes(policy.status)) policy.status='failed';
        policy.lastError=entry.error;policy.enabled=false;}
      await persist();return clone(entry);
    }
    const ownedSession = Object.values(saved.sessions).find(session => session.taskId === taskId && session.threadId === task.conversationId && session.status === 'created');
    entry.workspaceWrite = !evidenceOnly && ownedSession?.workspaceWrite === true;
    entry.bridgePid = activeBridge.spawnedChild?.pid || null;
    if(boundMarker?.startupId){
      if(boundMarker.pid!==entry.bridgePid||boundMarker.workspace!==entry.workspace)
        throw new Error('Original startup command executor changed');
    }
    await persist();
    try {
      const ownedExecutor = saved.executors[markerKey(taskId)];
      if (bridgeFor(taskId) !== activeBridge || ownedExecutor?.pid !== activeBridge.spawnedChild?.pid ||
        (ownedExecutor.threadId && ownedExecutor.threadId !== task.conversationId) ||
        (ownedExecutor.workspace && ownedExecutor.workspace !== boundWorkspace.directory))
        throw new Error('Codex task executor ownership is unknown');
      ownedExecutor.threadId = task.conversationId;
      ownedExecutor.workspace = boundWorkspace.directory;
      ownedExecutor.projectId = task.projectId;
      await persist();
      // getProject is a trusted, current Core read. Revalidate its generation
      // after that await and immediately before the provider's irreversible send.
      let currentProject;
      try {
        currentProject = await getProject(task.projectId);
        if (!currentProject || currentProject.directory !== project.directory) throw new Error('Project directory changed before provider start');
        const currentWorkspace=await taskWorkspace(task,currentProject,worktreeId);
        if(currentWorkspace.directory!==boundWorkspace.directory)throw new Error('Worktree binding changed before provider start');
        const validation = await revalidateExecution({taskId,commandId,
          ...startupFields(taskId),workspace:currentWorkspace.directory,
          expectedRevision:automatic&&policy?.restartBinding?policy.restartBinding.revision:task.revision,
          expectedConversationId:automatic&&policy?.restartBinding?policy.restartBinding.threadId:task.conversationId||null,
          expectedDirectory:automatic&&policy?.restartBinding?policy.restartBinding.workspace:currentWorkspace.directory,
          ...(currentWorkspace.worktreeId?{worktreeId:currentWorkspace.worktreeId}:{}),
          expectedHandoffGeneration:automatic&&policy?.restartBinding
            ?policy.restartBinding.expectedHandoffGeneration:currentProject.handoff?.generation??null});
        if (automatic) assertAutomaticSend(policy, commandId);
        if(validation===false||validation?.allowed===false||validation?.maySend===false||closed||disableRequested||pauseRequested.has(taskId))throw new Error('Execution was cancelled before provider start');
        if (automatic) await assertRestartBinding(policy);
        if (automatic) await assertPlanIntent(policy);
      } catch(error) {
        entry.status='failed';entry.error=errorText(error);
        if(policy && !preserveHumanStop(policy)){if(!['budget_exhausted','attempts_exhausted','retry_stopped','unknown','awaiting_approval'].includes(policy.status)) policy.status='failed';
          policy.lastError=entry.error;policy.enabled=false;}
        await persist();return clone(entry);
      }
      const response = await activeBridge.request('turn', {
        threadId: task.conversationId, cwd: boundWorkspace.directory, commandId, text: prompt(task,instructions,currentProject.handoff),model,evidenceOnly,
        workspaceWrite: !evidenceOnly && ownedSession?.workspaceWrite === true,
      });
      if (!response?.turn?.id) throw new Error('Codex did not confirm a turn ID');
      entry.turnId = response.turn.id;
      const observedCommandItems = commandItemEvents.get(eventKey(taskId, task.conversationId, entry.turnId));
      if (observedCommandItems) {
        entry.commandItemIds = [...observedCommandItems];
        if (observedCommandItems.overflow || observedCommandItems.bridgePid !== entry.bridgePid) entry.commandItemOverflow = true;
      } else entry.commandItemIds = [];
      entry.actualModel=response.model||null;
      await persist();
      const observedStart = await waitStarted(taskId, task.conversationId, entry.turnId);
      if (!observedStart) throw new Error('Codex turn/start returned but turn/started was not observed');
      if (approvalThreads.has(threadKey(taskId, task.conversationId))) {
        entry.status = 'awaiting_approval';
        if (policy) { policy.status = 'awaiting_approval'; policy.enabled = false; }
        try { await updateTask(taskId, { status: 'blocked', blockedReason: 'Codex is waiting for approval or user input' }, task.revision); }
        catch (error) { entry.taskUpdateError = errorText(error); }
        status = 'awaiting_approval';
        await persist();
        return clone(entry);
      }
      entry.status = 'running';
      if (policy) {
        if (policy.status !== 'awaiting_approval' && policy.status !== 'turn_completed') policy.status = 'running';
        policy.lastError = policy.status === 'awaiting_approval' ? policy.lastError : null;
        policy.wakeAt = null;
        policy.threadId = task.conversationId;
      }
      try {
        const updated = await updateTask(taskId, { status: 'running', blockedReason: '' }, task.revision);
        entry.taskRevision = updated.revision;
        entry.startedContentVersion = updated.contentVersion;
      } catch (error) { entry.taskUpdateError = errorText(error); }
      // This is the first observed and durably recorded running turn of the
      // restarted plan. Later turns follow their normal task revision rules.
      const firstTurnBinding = automatic ? policy?.restartBinding : null;
      if (firstTurnBinding) { policy.restartBinding = null; policy.initialTurnConfirmed = true; }
      try { await persist(); }
      catch (error) { if (firstTurnBinding) { policy.restartBinding = firstTurnBinding; policy.initialTurnConfirmed = false; } throw error; }
      status = 'running';
      const earlyCompletion = completionEvents.get(eventKey(taskId, task.conversationId, entry.turnId));
      if (earlyCompletion) {
        completionEvents.delete(eventKey(taskId, task.conversationId, entry.turnId));
        if (earlyCompletion.bridgePid === entry.bridgePid) entry.turnCompleteEvent = true;
        else entry.commandItemOverflow = true;
        run(() => handleCompletion(earlyCompletion.params, { ownerTaskId: taskId })).catch(() => {});
      }
      return clone(entry);
    } catch (error) {
      // A broken pipe, timeout, or process crash after writing is ambiguous.
      entry.status = 'unknown';
      entry.error = errorText(error);
      if (policy) {
        if (policy.status !== 'awaiting_approval') policy.status = 'unknown';
        policy.lastError = entry.error; policy.enabled = false;
      }
      await persist();
      status = 'unknown';
      return clone(entry);
    }
  }

  async function automaticCheck() {
    const running = Object.values(saved.commands).filter(item => item.status === 'running');
    const batch = running.length <= 10
      ? running
      : Array.from({ length: 10 }, (_, index) => running[(reconcileCursor + index) % running.length]);
    reconcileCursor = running.length ? (reconcileCursor + batch.length) % running.length : 0;
    for (const command of batch) {
      try {
        const task = await getTask(command.taskId);
        if (!task || task.conversationId !== command.threadId) continue;
        const thread = await scopedThread(task);
        const turn = thread.turns?.find(item => item.id === command.turnId);
        if (turn && ['completed', 'failed', 'interrupted'].includes(turn.status)) {
          await handleCompletion({ threadId: command.threadId, turn }, { ownerTaskId: command.taskId });
        }
      } catch (error) {
        command.reconcileError = errorText(error);
      }
    }
    if (saved.enabled && !disableRequested) {
      for (const policy of saved.policies) {
        if (!policy.enabled || ['paused', 'running', 'sending', 'awaiting_approval', 'unknown', 'turn_completed'].includes(policy.status)) continue;
        try { await assertPlanIntent(policy); }
        catch (error) {
          if (!policy.enabled && ['plan_intent_missing', 'plan_intent_changed', 'repeated_quota_failure'].includes(policy.stopReason)) continue;
          throw error;
        }
      }
    }
    const quota = await readQuota();
    status = quota.ready ? 'ready' : 'waiting_quota';
    if (saved.enabled && !disableRequested && quota.ready) {
      for (const policy of saved.policies) {
        if (!policy.enabled || ['paused', 'running', 'sending', 'awaiting_approval', 'unknown', 'turn_completed'].includes(policy.status)) continue;
        const stop = automaticStop(policy, epoch(now));
        if (stop) { stopAutomatic(policy, stop); await persist(); continue; }
        if (policy.wakeAt && Date.parse(policy.wakeAt) > epoch(now)) {
          policy.status = 'waiting_quota';
          status = 'waiting_quota';
          continue;
        }
        let commandId;
        try {
          commandId = await reserveAutomatic(policy);
          if (!commandId) continue;
          const result = await send(policy.taskId, commandId, { automatic: true });
          if (preserveHumanStop(policy)) { await persist(); continue; }
          if (result?.status === 'waiting_quota') continue;
          if (result?.status === 'running') {
            policy.pendingAutoCommandId = null;
            await persist();
            continue;
          }
          if (result?.status === 'unknown' || result?.status === 'awaiting_approval') {
            policy.enabled = false;
            policy.status = result.status;
            policy.stopReason = 'attempt_unconfirmed';
          } else if (!['budget_exhausted', 'attempts_exhausted', 'retry_stopped', 'unknown', 'awaiting_approval'].includes(policy.status)) {
            stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'retry_failed' }, result?.error || 'Automatic preflight failed');
          }
          await persist();
        } catch (error) {
          if (preserveHumanStop(policy)) {
            await persist();
            continue;
          }
          if (!commandId && !['restart_binding_changed','plan_intent_missing','plan_intent_changed'].includes(policy.stopReason)) {
            // A failed reservation never authorizes a provider request. Keep
            // the in-memory fence; a restart re-reads whichever image committed.
            stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'attempt_unconfirmed' }, errorText(error));
          } else if (policy.status === 'running') {
            policy.enabled = false;
            policy.stopReason = 'attempt_unconfirmed';
            policy.lastError = errorText(error);
          } else if (!['budget_exhausted', 'attempts_exhausted', 'retry_stopped', 'unknown', 'awaiting_approval'].includes(policy.status)) {
            stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'retry_failed' }, errorText(error));
          }
          await persist();
        }
      }
    } else if (saved.enabled && !quota.ready) {
      for (const policy of saved.policies) {
        if (policy.enabled && !['paused','running','sending','unknown','awaiting_approval'].includes(policy.status)) {
          try { await assertRestartBinding(policy); }
          catch (error) { if (error.message === 'restart_binding_changed') continue; throw error; }
          const stop = automaticStop(policy, epoch(now));
          if (stop) { stopAutomatic(policy, stop); continue; }
          policy.status = 'waiting_quota';
          policy.wakeAt = quota.wakeAt ? new Date(quota.wakeAt * 1000).toISOString() : null;
        }
      }
      await persist();
    }
    const nextWake = quota.wakeAt ? Math.max(1000, quota.wakeAt * 1000 - epoch(now)) : saved.config.pollSeconds * 1000;
    schedule(Math.min(nextWake, saved.config.pollSeconds * 1000));
    emit();
    return snapshot();
  }

  async function check() {
    return run(async () => {
      try { return await automaticCheck(); }
      catch (error) {
        lastError = errorText(error); status = 'unavailable';
        for (const policy of saved.policies) {
          if (saved.enabled && !disableRequested && policy.enabled &&
              !['running','sending','unknown','awaiting_approval','paused','disabled'].includes(policy.status))
            stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'retry_failed' }, lastError);
        }
        try { await persist(); } catch { /* A failed write cannot authorize a send. */ }
        schedule(saved.config.pollSeconds * 1000);
        emit();
        return snapshot();
      }
    });
  }

  if (initialized && saved.enabled) schedule(0);

  return {
    state() { return snapshot(); },
    configure(config) { return run(async () => {
      if (!config || typeof config !== 'object') throw new TypeError('config is required');
      for (const key of Object.keys(config)) {
        if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new TypeError(`Unsupported plugin config: ${key}`);
      }
      const next = { ...saved.config, ...config };
      if (!Number.isInteger(next.graceSeconds) || next.graceSeconds < 0 || next.graceSeconds > 3600) throw new RangeError('graceSeconds must be 0..3600');
      if (!Number.isInteger(next.pollSeconds) || next.pollSeconds < 5 || next.pollSeconds > 86400) throw new RangeError('pollSeconds must be 5..86400');
      for (const key of ['pythonPath', 'codexPath']) if (typeof next[key] !== 'string') throw new TypeError(`${key} must be a string`);
      await pendingBridgeShutdown;
      await stopAllTrackedBridges();
      await stopRecoveredTaskJobs();
      assertNoUnconfirmedExecutors();
      available = null; currentQuota = null;
      saved.config = next;
      await persist(); schedule(0); return snapshot();
    }); },
    enable() { return run(async () => { disableRequested = false; saved.enabled = true; status = 'idle'; await persist(); schedule(0); return snapshot(); }); },
    disable() { disableRequested = true; return run(async () => {
      saved.enabled = false; clearSchedule();
      await persist();
      try { await pendingBridgeShutdown; await stopAllTrackedBridges(); await stopRecoveredTaskJobs(); assertNoUnconfirmedExecutors(); }
      catch (error) {
        status = 'shutdown_error'; lastError = errorText(error);
        await persist(); throw error;
      }
      status = 'disabled'; lastError = null;
      await persist(); return snapshot();
    }).finally(() => { disableRequested = false; }); },
    check,
    createSession({taskId,expectedRevision,commandId,workspaceWrite=false,worktreeId=null}) { return run(async()=>{
      if(typeof commandId!=='string'||!commandId||commandId.length>200)throw new Error('commandId is required');
      if(typeof workspaceWrite!=='boolean')throw new Error('workspaceWrite must be a boolean');
      if(worktreeId!==null&&(typeof worktreeId!=='string'||!worktreeId))throw new Error('Invalid worktree ID');
      const existing=saved.sessions[commandId];
      if(existing){if(existing.taskId!==taskId||existing.expectedRevision!==expectedRevision||(existing.workspaceWrite===true)!==workspaceWrite||(existing.worktreeId||null)!==worktreeId)throw new Error('commandId already belongs to a different session request');return clone(existing);}
      if(Object.values(saved.sessions).some(s=>s.taskId===taskId&&['unknown','creating'].includes(s.status)))throw new Error('先前创建会话的结果未知，请在 Codex 中核对并绑定会话，再核对执行状态');
      const task=await getTask(taskId);
      if(task.revision!==expectedRevision)throw new Error('任务已更新，请刷新后再创建会话');
      if(task.conversationId||task.status==='running')throw new Error('任务已绑定会话；请先核对已有会话');
      const project=await getProject(task.projectId);
      if(!validDirectory(project.directory))throw new Error('请先绑定项目目录');
      const bound=worktreeId?await resolveWorkspace?.({taskId,worktreeId}):{directory:project.directory,worktreeId:null};
      if(!validDirectory(bound?.directory)||bound.worktreeId!==worktreeId)throw new Error('工作树身份无法核实');
      const entry={taskId,expectedRevision,commandId,workspaceWrite,worktreeId,workspace:bound.directory,status:'creating',createdAt:iso(now)};
      const linuxSession=process.platform==='linux'&&taskJobBackend===undefined;
      // An initialize failure happens inside connection, before its caller can
      // send createThread. Keep the original request available for retirement.
      if(linuxSession){saved.sessions[commandId]=entry;await persist();}
      let client;
      try{client=await connection(taskId, bound.directory, task.projectId, worktreeId,commandId,'session');}
      catch(error){
        if(!linuxSession)throw error;
        entry.status='not_started';entry.error=errorText(error);await persist();
        return clone(entry);
      }
      saved.sessions[commandId]=entry;await persist();
      try {
        const latestTask=await getTask(taskId),latestProject=await getProject(task.projectId);
        const latestBound=worktreeId?await resolveWorkspace?.({taskId,worktreeId}):{directory:latestProject.directory,worktreeId:null};
        if(latestTask.revision!==expectedRevision||latestTask.conversationId||latestTask.status==='running'||latestProject.directory!==project.directory||latestBound?.directory!==bound.directory)
          throw new Error('Task or project changed before session creation');
        await admitLinuxExecutor({taskId,commandId,workspace:bound.directory,
          worktreeId,client});
        const validation=await revalidateExecution({taskId,commandId,expectedRevision:latestTask.revision,expectedConversationId:latestTask.conversationId||null,expectedDirectory:bound.directory,
          ...startupFields(taskId),workspace:bound.directory,
          ...(worktreeId?{worktreeId}:{})});
        if(validation===false||validation?.allowed===false||validation?.maySend===false||closed||disableRequested||pauseRequested.has(taskId))throw new Error('Session creation was cancelled before provider start');
      }catch(error){
        entry.status='not_started';entry.error=errorText(error);await persist();
        const marker=saved.executors[markerKey(taskId)];
        // This flag is created only while this call still owns the original
        // job and has not invoked createThread. A saved status alone is not proof.
        if(marker?.kind==='linux-job'&&bridgeFor(taskId)===client&&
          marker.recordId===client.job?.recordId&&marker.pid===client.spawnedChild?.pid&&
          marker.requestCommandId===commandId&&!marker.lastCommandId){
          marker.appServerPid=client.appServerPid;
          marker.sessionAbortBeforeSend=true;
          try{
            await persist();
            await retireTrackedLinuxJob(client);
          }catch(cleanupError){
            entry.cleanupError=errorText(cleanupError);
            await persist();
          }
        }
        return clone(entry);
      }
      try{
        const result=await client.request('createThread',{cwd:bound.directory,workspaceWrite});
        const thread=result?.thread;
        if(!thread?.id||thread.cwd!==bound.directory)throw new Error('新会话的工作树目录验证失败');
        entry.threadId=thread.id;entry.model=result.model||null;
        const ownedExecutor=saved.executors[markerKey(taskId)];
        if (bridgeFor(taskId)!==client || ownedExecutor?.pid!==client.spawnedChild?.pid)
          throw new Error('Session executor changed before task binding');
        ownedExecutor.threadId=thread.id;ownedExecutor.workspace=bound.directory;ownedExecutor.projectId=task.projectId;
        await persist();
        await updateTask(taskId,{conversationId:thread.id,sourceConversation:{provider:'codex',conversationId:thread.id,label:task.title}},expectedRevision);
        if(ownedExecutor.startupId){
          if(typeof bindExecutorConversation!=='function')throw new Error('Original session startup binding authority unavailable');
          await bindExecutorConversation({taskId,startupId:ownedExecutor.startupId,
            recordId:ownedExecutor.recordId,threadId:thread.id});
        }
        entry.status='created';await persist();return clone(entry);
      }catch(error){entry.status='unknown';entry.error=errorText(error);await persist();return clone(entry);}
    }); },
    setPolicy({ taskId, enabled, maxAttempts, budgetMinutes, restart = false }) { return run(async () => {
      if (!taskId || typeof taskId !== 'string') throw new TypeError('taskId is required');
      if (typeof restart !== 'boolean') throw new TypeError('restart must be a boolean');
      const task = await getTask(taskId);
      if (!task) throw new Error('Task not found');
      const policyBefore=saved.policies.find(item => item.taskId === taskId);
      const firstEnable=enabled && !restart && !policyBefore?.startedAt;
      const initialPlanIntent = restart || firstEnable ? planIntentForTask(task) : null;
      const restartTaskSnapshot = restart || firstEnable ? { id: task.id, revision: task.revision,
        contentVersion: task.contentVersion, projectId: task.projectId,
        conversationId: task.conversationId, status: task.status } : null;
      let policy = policyBefore;
      const limit = maxAttempts ?? policy?.maxAttempts ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new RangeError('maxAttempts must be 1..10');
      const minutes = validateBudgetMinutes(budgetMinutes ?? policy?.budgetMinutes ?? DEFAULT_BUDGET_MINUTES);
      if (enabled && (['unknown', 'awaiting_approval'].includes(policy?.status) || Object.values(saved.commands).some(command => command.taskId === taskId &&
          (['sending', 'unknown', 'awaiting_approval'].includes(command.status) || unresolvedStop(command))))) {
        throw new Error('Verify the Codex conversation and resolve the unknown send or approval before re-enabling this policy');
      }
      if (restart) {
        if (!enabled || !policy || policy.enabled || task.status === 'running' ||
            Object.values(saved.sessions).some(session => session.taskId === taskId && ['creating','unknown'].includes(session.status)) ||
            Object.values(saved.commands).some(command => command.taskId === taskId &&
              (['sending','running','unknown','awaiting_approval'].includes(command.status) || unresolvedStop(command))))
          throw new Error('Original task command, session, or executor is not confirmed idle; policy cannot restart');
        if (saved.executors[markerKey(taskId)] || bridgeFor(taskId))
          await retireIdleExecutorForPolicyRestart(task, policy);
      }
      const previousPlan = restart ? clone(policy) : null;
      const restartBinding = restart || firstEnable ? await captureRestartBinding(taskId, restartTaskSnapshot) : null;
      if (initialPlanIntent && !samePlanIntent(initialPlanIntent, await getTask(taskId)))
        throw new Error('plan_intent_changed');
      if (!policy) { policy = { taskId, attempts: 0, status: 'idle' }; saved.policies.push(policy); }
      if (enabled && !restart && !firstEnable) await assertRestartBinding(policy);
      if (enabled && !restart && (policy.stopReason || policy.recoveryFailureCount >= 2))
        throw new Error('Stopped automatic policy requires an explicit restart');
      if (enabled && !restart && policy.startedAt &&
          automaticStop({ ...policy, attempts: 0 }, epoch(now))?.stopReason === 'legacy_plan_missing_deadline')
        throw new Error('Legacy automatic policy requires an explicit restart');
      if (restart || enabled && !policy.startedAt) {
        policy.startedAt = iso(now);
        policy.deadlineAt = deadlineFor(policy.startedAt, minutes);
        policy.attempts = 0;
        policy.pendingAutoCommandId = null;
        policy.stopReason = null;
        if (restart || firstEnable) {
          policy.restartBinding = restartBinding;
          policy.initialTurnConfirmed = false;
          policy.planIntent = initialPlanIntent;
          policy.planId = randomUUID();
          policy.recoveryFailureCount = 0;
        }
      } else if (policy.startedAt && (minutes !== policy.budgetMinutes || limit !== policy.maxAttempts)) {
        throw new Error('Changing automatic budget or attempt limit requires an explicit restart');
      }
      policy.budgetMinutes = minutes;
      policy.enabled = enabled === true; policy.maxAttempts = limit;
      if (policy.enabled) {
        const stop = automaticStop(policy, epoch(now));
        if (stop) { stopAutomatic(policy, stop); throw new Error('Automatic policy budget or attempts are exhausted; explicitly restart'); }
        if (policy.pendingAutoCommandId) throw new Error('Previous automatic attempt is unconfirmed; explicitly restart after verifying it');
      }
      if (!policy.enabled) policy.status = 'disabled';
      else if (restart || policy.status === 'disabled' || policy.status === 'paused') policy.status = 'idle';
      if (policy.enabled) { policy.lastError = null; policy.stopReason = null; }
      try { await persist(); }
      catch (error) {
        if (restart) {
          for (const key of Object.keys(policy)) delete policy[key];
          Object.assign(policy, previousPlan);
        }
        else if (enabled) stopAutomatic(policy, { status: 'retry_stopped', stopReason: 'attempt_unconfirmed' }, errorText(error));
        throw error;
      }
      schedule(0); return snapshot();
    }); },
    resume({ taskId, expectedRevision, commandId,instructions,model,evidenceOnly,allowSubmitted,worktreeId,workspace }) { return run(() => send(taskId, commandId, { expectedRevision,instructions,model,evidenceOnly,allowSubmitted,worktreeId,workspace })); },
    conversation({ taskId }) { return run(async () => {
      const task = await getTask(taskId);
      const current = bridgeFor(taskId);
      if (!current?.child || current.dead) {
        const project = task && await getProject(task.projectId);
        const binding = task && project && await taskWorkspace(task, project);
        const completed = completedConversationForTask(saved.completedConversations[taskId],
          task, binding, saved.commands);
        if (completed) return completed;
      }
      const thread = await scopedThread(task);
      return publicConversation(task, thread, saved.commands, live.forTask(task));
    }); },
    getSessionBinding({ taskId }) { return run(async () => {
      const task = await getTask(taskId);
      if (!task) return { status:'unbound', verified:false, taskId, conversationId:null, worktreeId:null };
      const session = Object.values(saved.sessions).find(item => item.taskId === taskId &&
        item.threadId === task.conversationId && item.status === 'created' && item.worktreeId);
      if (!session) return { status:'unbound', verified:false, taskId,
        conversationId:task.conversationId || null, worktreeId:null };
      try {
        const project = await getProject(task.projectId);
        const workspace = await taskWorkspace(task, project, session.worktreeId);
        const thread = await scopedThread(task);
        if (thread.status?.type === 'notLoaded') throw new Error('Thread is not loaded');
        return { status:'bound', verified:true, taskId, conversationId:task.conversationId,
          worktreeId:session.worktreeId, workspace:workspace.directory,
          resumable:thread.status?.type === 'idle' && !(thread.status?.activeFlags || []).some(flag => ACTIVE_FLAGS.has(flag)) };
      } catch {
        return { status:'unconfirmed', verified:false, taskId,
          conversationId:task.conversationId || null, worktreeId:session.worktreeId };
      }
    }); },
    getExecution({taskId,commandId}) {return run(async()=>{
      const entry=saved.commands[`${taskId}:${commandId}`];if(!entry)return {status:'not_started'};
      if(entry.status==='cancelled'&&!entry.turnId)return {status:'not_started'};
      const withDiagnostic = result => {
        const diagnostic=publicCompletionDiagnostic(entry);
        return diagnostic?{...result,diagnostic}:result;
      };
      if(unresolvedStop(entry))return withDiagnostic({status:'unknown',actualModel:entry.actualModel||null});
      if(['completed','failed','interrupted'].includes(entry.status)){
        const result={status:entry.status==='interrupted'?'paused':entry.status,actualModel:entry.actualModel||null};
        return entry.status==='failed'?withDiagnostic(result):result;
      }
      // Explicit reconciliation confirmed the conversation stopped; keep the old outcome unknown, never call it completed.
      if(entry.status==='verified_idle')return withDiagnostic({status:'unknown',previousOutcome:'unknown',actualModel:entry.actualModel||null});
      if(!entry.turnId)return withDiagnostic({status:'unknown'});
      try{const task=await getTask(taskId);if(task.conversationId!==entry.threadId)return withDiagnostic({status:'unknown'});const thread=await scopedThread(task);const turn=thread.turns?.find(t=>t.id===entry.turnId);
        if(thread.model){entry.actualModel=thread.model;await persist();}
        if(turn&&['completed','failed','interrupted'].includes(turn.status)){
          await handleCompletion({threadId:entry.threadId,turn},{allowBlocked:true,ownerTaskId:taskId});
          if(unresolvedStop(entry))return withDiagnostic({status:'unknown',actualModel:entry.actualModel||null});
          const result={status:turn.status==='interrupted'?'paused':turn.status,actualModel:entry.actualModel||null};
          return turn.status==='failed'?withDiagnostic(result):result;
        }
        const current=turn?.status==='inProgress'&&thread.status?.type==='active'?'running':'unknown';
        const result={status:current,actualModel:entry.actualModel||null};
        return current==='unknown'?withDiagnostic(result):result;
      }catch{return withDiagnostic({status:'unknown'});}
    });},
    quiesce({projectId,workspace,unknownDispositionConsent=null}) { return run(async () => {
      const project = await getProject(projectId);
      if (!project || project.id !== projectId || project.directory !== workspace) throw new Error('Project workspace changed during takeover');
      await assertNoOverlappingOtherExecutor(projectId, workspace);
      const verifiedLinuxStops=new Set();
      const verifiedMacStops=new Map();
      const disposing=unknownDispositionConsent!==null;
      if(unknownDispositionConsent!==null&&(process.platform!=='darwin'||
        unknownDispositionConsent?.projectId!==projectId||
        typeof unknownDispositionConsent.id!=='string'||!unknownDispositionConsent.id||
        typeof disposeStoppedUnknownExecutor!=='function'))
        throw new Error('Explicit stopped-command disposition is unavailable');
      await stopRecoveredTaskJobs(projectId,verifiedLinuxStops,verifiedMacStops,disposing);
      const isVerifiedMacStop=(marker,command)=>{
        const receipt=verifiedMacStops.get(marker);
        return !!receipt&&marker.kind==='macos-job'&&marker.status==='stopped_unknown'&&
          !bridgeFor(marker.taskId)&&marker.projectId===projectId&&
          marker.taskId===receipt.taskId&&marker.recordId===receipt.recordId&&
          marker.startupId===receipt.startupId&&marker.lastCommandId===receipt.commandId&&
          JSON.stringify(marker.shutdownStopProof)===JSON.stringify(receipt)&&
          JSON.stringify(marker.shutdownStoppedReceipt)===JSON.stringify(receipt)&&
          isUnresolvedShutdownTurn(command,receipt,{allowUnknown:true});
      };
      const dispositions=[];
      if(unknownDispositionConsent!==null){
        const unresolved=[],alreadyDisposed=[];
        for(const command of Object.values(saved.commands)){
          const task=await getTask(command.taskId);
          if(!task)throw new Error('Codex execution task ownership is unknown');
          if(task.projectId!==projectId)continue;
          if(isDisposedUnknownCommand(command))alreadyDisposed.push(command);
          else if(['sending','running','unknown','awaiting_approval'].includes(command.status)||unresolvedStop(command))
            unresolved.push(command);
        }
        const selectedPrevious=alreadyDisposed.filter(command=>
          command.disposition.id===unknownDispositionConsent.id&&
          command.disposition.projectId===projectId);
        if(!unresolved.length&&!selectedPrevious.length||
          unresolved.length+selectedPrevious.length>16)
          throw new Error('No bounded original unknown commands were selected');
        for(const command of unresolved){
          if(!isVerifiedMacStop(saved.executors[markerKey(command.taskId)],command))
            throw new Error('An original stopped command has no fresh physical proof');
        }
        for(const command of selectedPrevious){
          dispositions.push({id:command.disposition.id,taskId:command.taskId,commandId:command.commandId});
        }
        for(const command of unresolved){
          const marker=saved.executors[markerKey(command.taskId)];
          const receipt=verifiedMacStops.get(marker);
          const disposition=await disposeStoppedUnknownExecutor({taskId:command.taskId,
            startupId:marker.startupId,recordId:marker.recordId,shutdownReceipt:receipt,
            controlConsent:unknownDispositionConsent});
          if(disposition?.id!==unknownDispositionConsent.id||disposition.projectId!==projectId||
            disposition.taskId!==command.taskId||disposition.commandId!==command.commandId||
            JSON.stringify(disposition.shutdownReceipt)!==JSON.stringify(receipt))
            throw new Error('Original disposition receipt changed');
          command.disposition=disposition;
          delete saved.executors[markerKey(command.taskId)];
          try{await persist();}
          catch(error){delete command.disposition;saved.executors[markerKey(command.taskId)]=marker;throw error;}
          dispositions.push({id:disposition.id,taskId:command.taskId,commandId:command.commandId});
        }
      }
      // Each task has its own bridge. An unrelated project's executor is never
      // stopped as a side effect of taking over this project.
      let activeOwned = false;
      const targetTaskIds = new Set();
      for (const command of Object.values(saved.commands)) {
        const task = await getTask(command.taskId);
        if (!task) throw new Error('Codex execution task ownership is unknown');
        if (task.projectId !== projectId) continue;
        targetTaskIds.add(task.id);
        if(isDisposedUnknownCommand(command))continue;
        const stoppedMarker=saved.executors[markerKey(task.id)];
        if(isVerifiedMacStop(stoppedMarker,command))continue;
        if(stoppedMarker?.kind==='linux-job'&&verifiedLinuxStops.has(stoppedMarker)&&
          stoppedMarker.status==='stopped_unknown'&&stoppedMarker.linuxStoppedReceipt&&
          stoppedMarker.linuxStopIntent?.commandId===command.commandId&&
          stoppedMarker.linuxStoppedReceipt.commandId===command.commandId)
          continue;
        if (unresolvedStop(command)) throw new Error('Codex command process exit is unconfirmed; human takeover remains fenced');
        if (!['sending','running','unknown','awaiting_approval'].includes(command.status)) continue;
        if (command.status !== 'running' || !command.turnId)
          throw new Error('Codex execution outcome is not safely stoppable for human takeover');
        const stopped = await pauseTask(task.id, task.revision);
        if (!['paused','completed','failed'].includes(stopped.status) || unresolvedStop(command))
          throw new Error('Codex command exit is unconfirmed; human takeover remains fenced');
        const currentMarker=saved.executors[markerKey(task.id)];
        if(currentMarker?.kind==='linux-job'&&currentMarker.status==='stopped_unknown'&&
          currentMarker.linuxStoppedReceipt)verifiedLinuxStops.add(currentMarker);
        activeOwned = true;
      }
      for (const policy of saved.policies) {
        const task = await getTask(policy.taskId);
        if (task?.projectId === projectId) {
          const marker=saved.executors[markerKey(task.id)];
          policy.enabled = false;
          policy.status = isVerifiedMacStop(marker,saved.commands[`${task.id}:${marker?.lastCommandId}`])||
            Object.values(saved.commands).some(command=>command.taskId===task.id&&isDisposedUnknownCommand(command))
            ?'unknown':'paused';
          policy.wakeAt = null;
        }
      }
      clearSchedule();
      await persist();
      await pendingBridgeShutdown;
      if (saved.executor) throw new Error('Legacy shared Codex executor retirement is unconfirmed');
      let stoppedOwned = false;
      for (const [key, marker] of Object.entries(saved.executors)) {
        if (!key.startsWith('task:')) continue;
        const taskId = key.slice(5), task = await getTask(taskId);
        if (!task || (marker.projectId && marker.projectId !== task.projectId))
          throw new Error('Codex executor project ownership is unknown');
        if (task.projectId !== projectId) continue;
        const client = bridgeFor(taskId);
        if (client?.spawnedChild?.pid === marker.pid) {
          await stopTrackedBridge(client);
          stoppedOwned = true;
        } else if(marker.kind==='linux-job'&&verifiedLinuxStops.has(marker)&&
          marker.status==='stopped_unknown'&&marker.linuxStoppedReceipt){
          stoppedOwned=true;
        } else if(isVerifiedMacStop(marker,saved.commands[`${taskId}:${marker.lastCommandId}`])){
          stoppedOwned=true;
        } else throw new Error('Prior task Codex executor is untracked; retirement is unconfirmed');
      }
      if (activeOwned && !stoppedOwned && Object.values(saved.commands).some(command =>
        targetTaskIds.has(command.taskId) && command.stopProof?.status !== 'verified' && command.status === 'running'))
        throw new Error('Active Codex turn has no tracked task executor');
      if (saved.enabled && saved.policies.some(policy => policy.enabled)) schedule(0);
      return { verified: true, quiescent: true, unknown: false, livePids: [], scope: 'codex-autocontinue-task-executor-group', checkedAt: iso(now),
        ...(dispositions.length?{dispositions}:{}) };
    }); },
    reconcile({ taskId, expectedRevision, expectedRetirementId }) {
      if (!Number.isInteger(expectedRevision)) return Promise.reject(new Error('expectedRevision is required'));
      if (expectedRetirementId !== undefined && (typeof expectedRetirementId !== 'string' ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(expectedRetirementId)))
        return Promise.reject(new Error('expectedRetirementId must identify an original retirement record'));
      return run(() => reconcileTask(taskId, expectedRevision, expectedRetirementId), { allowClosed: true });
    },
    pause({ taskId, expectedRevision }) {
      if (!Number.isInteger(expectedRevision)) return Promise.reject(new Error('expectedRevision is required'));
      pauseRequested.add(taskId);
      return run(() => pauseTask(taskId, expectedRevision)).finally(() => pauseRequested.delete(taskId));
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      shutdownVerifiedMarkers.clear();
      if (liveEmitTimer) clearTimeout(liveEmitTimer);
      live.clear();
      disableRequested = true;
      clearSchedule();
      const stopping = Promise.all([stopAllTrackedBridges(), pendingBridgeShutdown]);
      const drain = serial;
      closePromise = (async () => {
        const parkedRetirement=Object.values(saved.executors).some(marker=>['macos-job','linux-job'].includes(marker?.kind)&&
          Number.isSafeInteger(marker.expectedHandoffGeneration)&&marker.expectedHandoffGeneration>0);
        const deadline = Date.now() + (parkedRetirement?50_000:7_000);
        const bounded = promise => new Promise((resolveWait, reject) => {
          const timer = setTimeout(() => reject(new Error('Plugin shutdown timed out')), Math.max(1, deadline - Date.now()));
          Promise.resolve(promise).then(
            value => { clearTimeout(timer); resolveWait(value); },
            error => { clearTimeout(timer); reject(error); },
          );
        });
        await bounded(stopping);
        await bounded(drain);
        // Serialized work may have been starting a bridge when close began.
        // Recheck after draining; a null reference is not a process-exit proof.
        await bounded(Promise.all([stopAllTrackedBridges(), pendingBridgeShutdown]));
        await bounded(stopRecoveredTaskJobs());
        if (saved.executor) throw new Error('Legacy shared Codex executor retirement is unconfirmed');
        for (const [key, marker] of Object.entries(saved.executors)) {
          if (key.startsWith('task:')) {
            if(marker.status==='stopped_unknown'&&(marker.shutdownStoppedReceipt||marker.linuxStoppedReceipt)&&
                shutdownVerifiedMarkers.has(marker))continue;
            throw new Error(`Codex executor retirement is unconfirmed: ${key}`);
          }
          if (!recordedGroupGone(marker)) throw new Error(`Codex executor shutdown is unconfirmed: ${key}`);
          delete saved.executors[key];
        }
        await bounded(persist());
      })().catch(error => {
        // Only explicit retirement recheck remains available after a failed
        // close. Never reopen automatic or manual provider starts.
        closePromise = null;
        status = 'shutdown_error'; lastError = errorText(error);
        throw error;
      });
      return closePromise;
    },
  };
}
