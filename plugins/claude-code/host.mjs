import { randomUUID } from 'node:crypto';
import { canonicalDirectory, createLedger, copy, digest, errorText, iso, normalizeResumeOptions, promptFor, spawnJsonLines, stopProcess, validId } from './runtime.mjs';

const defaults = { executablePath: 'claude', model: '', maxDurationSeconds: 1800, maxBudgetUsd: null };
const configKeys = new Set(Object.keys(defaults));

export async function createPlugin(context) {
  const ledger = await createLedger({ id: 'claude-code', defaults, ...context });
  const { saved, active, persist, run, taskContext, command, finish, markRunning, now } = ledger;
  const authorizeExecution = typeof context.authorizeExecution === 'function' ? context.authorizeExecution : async () => true;
  const revalidateExecution = typeof context.revalidateExecution === 'function' ? context.revalidateExecution : async () => true;
  let closePromise;

  async function resume({ taskId, expectedRevision, commandId, ...inputOptions }) {
    return run(async () => {
      if (!saved.enabled) throw new Error('Claude Code adapter is disabled');
      const options = normalizeResumeOptions(inputOptions);
      const repeated = saved.commands[commandId];
      if (repeated) {
        if (repeated.taskId !== taskId || repeated.revision !== expectedRevision || repeated.optionsDigest !== digest(options)) throw new Error('commandId already belongs to a different request');
        return copy(repeated);
      }
      const { task, cwd, session } = await taskContext(taskId, expectedRevision);
      if (options.workspace && await canonicalDirectory(options.workspace) !== cwd) throw new Error('Workflow workspace does not match owned session');
      const { existing, fingerprint } = command(task, session, commandId, options);
      if (existing) return copy(existing);
      const entry = { taskId, commandId, sessionId: session.sessionId, cwd, revision: task.revision,
        contentVersion: task.contentVersion, digest: fingerprint, optionsDigest: digest(options), status: 'sending', createdAt: iso(now), updatedAt: iso(now) };
      saved.commands[commandId] = entry;
      await persist();
      try {
        const authorization = await authorizeExecution({ taskId, commandId });
        if (authorization === false || (authorization && typeof authorization === 'object' && authorization.maySend !== true) || ledger.isClosed() || entry.pauseRequested) throw new Error('Execution was cancelled before provider start');
      } catch (error) {
        entry.status = 'not_started'; entry.lastError = errorText(error); entry.updatedAt = iso(now); await persist();
        return copy(entry);
      }
      const args = ['-p', promptFor(task, options), '--output-format', 'stream-json', '--verbose', '--permission-mode', 'dontAsk'];
      if (session.materialized) args.push('--resume', session.sessionId);
      else args.push('--session-id', session.sessionId);
      if (options.evidenceOnly) args.push('--tools', 'Read,Grep,Glob', '--disallowedTools', 'mcp__*');
      if (options.model || saved.config.model) args.push('--model', options.model || saved.config.model);
      if (saved.config.maxBudgetUsd != null) args.push('--max-budget-usd', String(saved.config.maxBudgetUsd));
      let started = false, result = null, denied = false, startWork = Promise.resolve(), resolveStart;
      const startedOrExit = new Promise(resolve => { resolveStart = resolve; });
      let processHandle;
      try {
        const validation = await revalidateExecution({ taskId, commandId, expectedRevision: task.revision, expectedConversationId: task.conversationId || null, expectedDirectory: cwd });
        if (validation === false || validation?.allowed === false || validation?.maySend === false || ledger.isClosed() || entry.pauseRequested) throw new Error('Execution was cancelled before provider start');
      } catch (error) {
        entry.status = 'not_started'; entry.lastError = errorText(error); entry.updatedAt = iso(now); await persist(); return copy(entry);
      }
      try {
        processHandle = spawnJsonLines(saved.config.executablePath, args, cwd, {
          maxDurationSeconds: saved.config.maxDurationSeconds,
          onMessage(message) {
            if (message?.type === 'system' && message.subtype === 'init') {
              if (message.session_id !== session.sessionId) { processHandle?.child.kill('SIGTERM'); return; }
              if (!started) {
                started = true;
                session.materialized = true;
                startWork = markRunning(taskId, entry).then(() => resolveStart(true), () => { processHandle?.child.kill('SIGTERM'); resolveStart(false); });
              }
            }
            if (message?.type === 'system' && message.subtype === 'permission_denied') denied = true;
            if (message?.type === 'result') {
              result = message;
              if (Array.isArray(message.permission_denials) && message.permission_denials.length) denied = true;
            }
          },
        });
      } catch (error) {
        entry.status = 'failed'; entry.lastError = errorText(error); await persist();
        return copy(entry);
      }
      const live = { handle: processHandle, entry, session, completion: null, pauseRequested: false };
      active.set(taskId, live);
      live.completion = (async () => {
        const ended = await processHandle.exit;
        resolveStart(false);
        await startWork.catch(() => {});
        entry.exitConfirmed = !ended.error;
        active.delete(taskId);
        if (live.pauseRequested) {
          if (ended.signal === 'SIGINT' || ended.code === 130 || result?.subtype === 'interrupted') await finish(taskId, entry, 'paused');
          else await finish(taskId, entry, 'unknown', 'Cancellation outcome is not confirmed');
        } else if (!started) {
          const detail = `${result?.result || ''} ${ended.stderr || ''}`;
          const blocked = /auth|login|permission|credential|sign.?in/i.test(detail) || denied;
          entry.status = blocked ? 'awaiting_approval' : 'failed'; entry.lastError = blocked ? 'Claude Code authentication or permission is required' : 'Claude Code did not confirm session start';
          const current = await ledger.getTask(taskId);
          if (blocked && current.revision === entry.revision && current.contentVersion === entry.contentVersion) await ledger.updateTask(taskId, { status: 'blocked', blockedReason: entry.lastError }, current.revision);
          await persist();
        } else if (denied) await finish(taskId, entry, 'awaiting_approval', 'Claude Code denied a permission request');
        else if (ended.code === 0 && result && result.is_error !== true) await finish(taskId, entry, 'completed');
        else await finish(taskId, entry, result?.is_error ? 'failed' : 'unknown', 'Claude Code result was not confirmed');
      })().catch(async error => { entry.status = 'unknown'; entry.lastError = errorText(error); await persist(); });
      const confirmed = await startedOrExit;
      if (confirmed) return copy(entry);
      await live.completion;
      return copy(entry);
    });
  }

  async function createSession({ taskId, expectedRevision, commandId }) {
    return run(async () => {
      if (!saved.enabled) throw new Error('Claude Code adapter is disabled');
      if (!validId(commandId)) throw new Error('commandId is required');
      const existing = saved.sessions[taskId];
      if (existing) {
        if (existing.createCommandId !== commandId || existing.createRevision !== expectedRevision) throw new Error('Task already has another owned session');
        return copy(existing);
      }
      const { task, cwd } = await taskContext(taskId, expectedRevision, { bound: false });
      if (task.conversationId || task.status === 'running') throw new Error('Task already has a conversation binding');
      const sessionId = randomUUID();
      const session = { taskId, projectId: task.projectId, sessionId, cwd, createCommandId: commandId,
        createRevision: expectedRevision, status: 'creating', materialized: false, createdAt: iso(now) };
      saved.sessions[taskId] = session;
      await persist();
      try {
        await ledger.updateTask(taskId, { conversationId: sessionId, sourceConversation: { provider: 'claude-code', conversationId: sessionId, label: task.title } }, expectedRevision);
        session.status = 'created'; await persist(); return copy(session);
      } catch (error) { session.status = 'unknown'; session.lastError = errorText(error); await persist(); return copy(session); }
    });
  }

  async function pause({ taskId, expectedRevision }) {
    const { session } = await taskContext(taskId, expectedRevision);
    const live = active.get(taskId);
    if (!live) {
      const sending = Object.values(saved.commands).find(item => item.taskId === taskId && item.status === 'sending' && item.sessionId === session.sessionId);
      if (sending) { sending.pauseRequested = true; await persist(); return { taskId, status: 'not_started' }; }
      return { status: 'unknown', taskId, lastError: 'No owned live Claude Code process to cancel' };
    }
    if (live.session.sessionId !== session.sessionId || live.entry.cwd !== session.cwd) return { status: 'unknown', taskId, lastError: 'No owned live Claude Code process to cancel' };
    live.pauseRequested = true;
    live.entry.status = 'pausing'; await persist();
    const ended = await stopProcess(live.handle, 'SIGINT');
    await live.completion;
    return { taskId, status: live.entry.status, signal: ended.signal || null };
  }

  async function reconcile({ taskId, expectedRevision, confirmStopped = false }) {
    return run(async () => {
      await taskContext(taskId, expectedRevision);
      const unknown = Object.values(saved.commands).filter(item => item.taskId === taskId && item.status === 'unknown');
      if (!unknown.length) return { taskId, status: 'idle' };
      if (active.has(taskId) || confirmStopped !== true) return { taskId, status: 'unknown', lastError: 'Confirm the Claude Code process stopped before reconciliation' };
      for (const entry of unknown) { entry.status = 'reconciled'; entry.updatedAt = iso(now); }
      await persist(); return { taskId, status: 'reconciled' };
    });
  }

  async function shutdown() {
    const outcomes = await Promise.allSettled([...active.values()].map(async live => { live.pauseRequested = true; await stopProcess(live.handle, 'SIGINT'); await live.completion; }));
    const failures = outcomes.filter(item => item.status === 'rejected').map(item => item.reason);
    if (failures.length) throw new AggregateError(failures, 'Claude Code process shutdown unconfirmed');
  }

  return {
    state: ledger.state,
    configure(config) { return run(async () => {
      if (active.size) throw new Error('Cannot change Claude Code settings during an active turn');
      if (!config || Object.keys(config).some(key => !configKeys.has(key))) throw new Error('Unsupported Claude Code setting');
      if (config.executablePath !== undefined && (typeof config.executablePath !== 'string' || !config.executablePath.trim())) throw new Error('Invalid executablePath');
      if (config.model !== undefined && typeof config.model !== 'string') throw new Error('Invalid model');
      if (config.maxDurationSeconds !== undefined && (!Number.isInteger(config.maxDurationSeconds) || config.maxDurationSeconds < 10 || config.maxDurationSeconds > 14400)) throw new Error('Invalid maxDurationSeconds');
      if (config.maxBudgetUsd !== undefined && config.maxBudgetUsd !== null && (typeof config.maxBudgetUsd !== 'number' || !Number.isFinite(config.maxBudgetUsd) || config.maxBudgetUsd <= 0 || config.maxBudgetUsd > 1000)) throw new Error('Invalid maxBudgetUsd');
      Object.assign(saved.config, config); await persist(); return ledger.state();
    }); },
    enable() { return run(async () => { saved.enabled = true; await persist(); return ledger.state(); }); },
    disable() { return (async () => { await shutdown(); return run(async () => { saved.enabled = false; await persist(); return ledger.state(); }); })(); },
    check: async () => ledger.state(),
    createSession, resume, pause, reconcile,
    getExecution({ taskId, commandId }) {
      const entry = saved.commands[commandId];
      if (!entry || entry.taskId !== taskId) return { taskId, commandId, status: 'not_started' };
      const status = entry.status === 'completed' ? 'completed' : entry.status === 'paused' ? 'paused'
        : entry.status === 'running' && active.get(taskId)?.entry === entry ? 'running'
          : entry.status === 'not_started' ? 'not_started'
            : entry.status === 'awaiting_approval' ? entry.exitConfirmed === true ? entry.runningContentVersion !== undefined ? 'paused' : 'not_started' : 'unknown'
              : entry.status === 'failed' ? 'failed' : 'unknown';
      return { taskId, commandId, status, reason: entry.status === 'awaiting_approval' ? 'awaiting_approval' : undefined, updatedAt: entry.updatedAt };
    },
    close() {
      if (closePromise) return closePromise;
      ledger.closeFlag();
      closePromise = (async () => { await shutdown(); await ledger.drain(); await persist(); })();
      return closePromise;
    },
  };
}
