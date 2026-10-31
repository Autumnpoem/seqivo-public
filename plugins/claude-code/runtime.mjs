import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rename, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const copy = value => structuredClone(value);
export const errorText = error => error instanceof Error ? error.message : String(error);
export const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
export const iso = now => new Date(now()).toISOString();

export async function canonicalDirectory(value) {
  if (typeof value !== 'string' || !value) throw new Error('Project directory is required');
  const directory = await realpath(value);
  if (!(await stat(directory)).isDirectory() || directory !== resolve(directory)) throw new Error('Project directory is invalid');
  return directory;
}

export function normalizeResumeOptions(input) {
  if (Object.keys(input || {}).some(key => !['instructions', 'model', 'evidenceOnly', 'role', 'workspace', 'reviewOf'].includes(key))) throw new Error('Unsupported per-turn option');
  const instructions = input?.instructions ?? '';
  const model = input?.model ?? '';
  const evidenceOnly = input?.evidenceOnly === true;
  const role = input?.role ?? '';
  const workspace = input?.workspace ?? '';
  const reviewOf = input?.reviewOf ?? '';
  if (typeof instructions !== 'string' || instructions.length > 10000 || typeof model !== 'string' || model.length > 200 ||
      typeof role !== 'string' || role.length > 100 || typeof workspace !== 'string' || workspace.length > 1000 ||
      typeof reviewOf !== 'string' || reviewOf.length > 200 || (reviewOf && !evidenceOnly)) throw new Error('Invalid per-turn execution options');
  return { instructions, model, evidenceOnly, role, workspace, reviewOf };
}

export function promptFor(task, options = {}) {
  const criteria = Array.isArray(task.criteria) ? task.criteria.map(item => `- ${item.text}`).join('\n') : '';
  return `Work on the task titled ${task.title}.\n${options.role ? `Role: ${options.role}.\n` : ''}Goal: ${task.goal}\nAcceptance criteria:\n${criteria || '- Meet the stated goal.'}\nCurrent summary: ${task.summary || ''}\n${options.evidenceOnly ? 'Read-only evidence review: do not modify files or execute commands. Report findings with evidence.' : 'Update the project files as needed and report what you changed and verified.'}\n${options.instructions || ''}\nDo not claim acceptance; a human reviews it separately.`;
}

export async function createLedger({ id, dataDir, getTask, getProject, updateTask, emit = () => {}, now = Date.now, defaults }) {
  if (!dataDir || typeof getTask !== 'function' || typeof getProject !== 'function' || typeof updateTask !== 'function') throw new TypeError('Invalid plugin context');
  const path = join(dataDir, 'sessions.json');
  let saved = { enabled: false, config: { ...defaults }, sessions: {}, commands: {} };
  try { saved = { ...saved, ...JSON.parse(await readFile(path, 'utf8')) }; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  saved.config = { ...defaults, ...saved.config };
  for (const command of Object.values(saved.commands)) {
    if (['sending', 'starting', 'running', 'pausing'].includes(command.status)) {
      command.status = 'unknown'; command.lastError = 'Adapter restarted before outcome was confirmed';
    }
  }
  for (const session of Object.values(saved.sessions)) if (session.status === 'creating') session.status = 'unknown';
  let closed = false;
  let serial = Promise.resolve();
  const active = new Map();
  async function persist() {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(saved)}\n`, { mode: 0o600 });
    await rename(temp, path);
    emit();
  }
  await persist();
  function run(fn) {
    const result = serial.then(() => { if (closed) throw new Error('Plugin closed'); return fn(); });
    serial = result.catch(() => {});
    return result;
  }
  function state() {
    return { id, enabled: saved.enabled, available: true, status: !saved.enabled ? 'disabled' : active.size ? 'running' : 'idle',
      lastError: null, config: copy(saved.config), sessions: Object.values(saved.sessions).map(copy), commands: Object.values(saved.commands).map(copy),
      policies: [], quota: null };
  }
  async function taskContext(taskId, expectedRevision, { bound = true } = {}) {
    if (!validId(taskId) || !Number.isInteger(expectedRevision)) throw new Error('Task ID and expectedRevision are required');
    const task = await getTask(taskId);
    if (!task || task.revision !== expectedRevision) throw new Error('Task revision changed');
    const project = await getProject(task.projectId);
    const cwd = await canonicalDirectory(project?.directory);
    const session = saved.sessions[taskId];
    if (bound && (!session || session.status === 'unknown' || session.cwd !== cwd || session.projectId !== task.projectId || task.conversationId !== session.sessionId)) {
      throw new Error('Task is not bound to an owned session in this project directory');
    }
    return { task, project, cwd, session };
  }
  function command(task, session, commandId, options = {}) {
    if (!validId(commandId)) throw new Error('commandId is required');
    const payload = { taskId: task.id, commandId, revision: task.revision, contentVersion: task.contentVersion, sessionId: session.sessionId, cwd: session.cwd, options };
    const fingerprint = digest(payload);
    const existing = saved.commands[commandId];
    if (existing) {
      if (existing.digest !== fingerprint) throw new Error('commandId already belongs to a different request');
      return { existing, fingerprint };
    }
    if (Object.values(saved.commands).some(item => item.taskId === task.id && ['sending', 'starting', 'running', 'pausing', 'unknown', 'awaiting_approval'].includes(item.status))) {
      throw new Error('Prior command must be reconciled or stopped before another resume');
    }
    return { fingerprint };
  }
  async function finish(taskId, entry, status, reason = '') {
    entry.status = status; entry.lastError = reason || null; entry.updatedAt = iso(now);
    const task = await getTask(taskId);
    const session = saved.sessions[taskId];
    if (task && session && task.conversationId === session.sessionId && session.cwd === entry.cwd && task.contentVersion === entry.runningContentVersion && task.status === 'running') {
      const patch = status === 'completed' ? { status: 'submitted', blockedReason: '' }
        : status === 'awaiting_approval' ? { status: 'blocked', blockedReason: 'Provider requires an approval in its own tool' }
          : status === 'failed' ? { status: 'failed', blockedReason: reason.slice(0, 300) }
            : status === 'paused' ? { status: 'paused' } : null;
      if (patch) await updateTask(taskId, patch, task.revision);
    }
    await persist();
  }
  async function markRunning(taskId, entry) {
    const task = await getTask(taskId);
    if (task.revision !== entry.revision || task.contentVersion !== entry.contentVersion || task.conversationId !== entry.sessionId) throw new Error('Task changed before provider start');
    const updated = await updateTask(taskId, { status: 'running', blockedReason: '' }, task.revision);
    entry.runningContentVersion = updated.contentVersion;
    entry.status = 'running'; entry.updatedAt = iso(now);
    await persist();
  }
  return { id, saved, active, persist, run, state, taskContext, command, finish, markRunning,
    getTask, getProject, updateTask, now,
    closeFlag() { closed = true; },
    isClosed() { return closed; },
    async drain() { await serial; },
  };
}

export function spawnJsonLines(executablePath, args, cwd, { onMessage, maxDurationSeconds = 1800 } = {}) {
  if (typeof executablePath !== 'string' || !executablePath.trim()) throw new Error('Configure executablePath first');
  const executable = executablePath.trim();
  const script = /\.[cm]?js$/i.test(executable);
  const child = spawn(script ? process.execPath : executable, script ? [executable, ...args] : args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stdout = '', stderr = '', total = 0, settled = false;
  const exit = new Promise(resolveExit => {
    const finish = (code, signal, error) => { if (settled) return; settled = true; clearTimeout(timer); resolveExit({ code, signal, error, stderr }); };
    child.once('error', error => finish(null, null, error));
    child.once('exit', (code, signal) => finish(code, signal, null));
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), Math.max(1, maxDurationSeconds) * 1000);
  timer.unref?.();
  child.stdout.on('data', chunk => {
    total += chunk.length;
    if (total > 4_000_000) { child.kill('SIGTERM'); return; }
    stdout += chunk.toString('utf8');
    if (Buffer.byteLength(stdout) > 100_000) { child.kill('SIGTERM'); return; }
    let at;
    while ((at = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, at); stdout = stdout.slice(at + 1);
      if (!line.trim()) continue;
      try { onMessage?.(JSON.parse(line)); } catch { child.kill('SIGTERM'); }
    }
  });
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-20000); });
  return { child, exit, send(value) {
    const raw = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(raw) > 100_000) throw new Error('ACP message too large');
    if (!child.stdin.writable) throw new Error('Provider stdin is closed');
    child.stdin.write(raw);
  } };
}

export async function stopProcess(processHandle, signal = 'SIGTERM', timeoutMs = 2500) {
  if (!processHandle) return;
  const { child, exit } = processHandle;
  if (child.exitCode !== null || child.signalCode) return exit;
  const bounded = async ms => {
    let timer;
    try { return await Promise.race([exit, new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), ms); })]); }
    finally { clearTimeout(timer); }
  };
  child.kill(signal);
  const result = await bounded(timeoutMs);
  if (result) return result;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    const killed = await new Promise(resolveKilled => {
      let settledKill = false;
      const done = value => { if (settledKill) return; settledKill = true; clearTimeout(timerKill); resolveKilled(value); };
      const timerKill = setTimeout(() => { killer.kill(); done(false); }, 2000);
      killer.once('error', () => done(false));
      killer.once('exit', code => done(code === 0));
    });
    if (!killed) {
      child.kill('SIGKILL');
      const error = new Error('Provider process tree shutdown unconfirmed'); error.code = 'SHUTDOWN_UNCONFIRMED'; throw error;
    }
  } else child.kill('SIGKILL');
  const forced = await bounded(1500);
  if (!forced) { const error = new Error('Provider process shutdown unconfirmed'); error.code = 'SHUTDOWN_UNCONFIRMED'; throw error; }
  return forced;
}
