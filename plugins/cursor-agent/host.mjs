import { canonicalDirectory, createLedger, copy, digest, errorText, iso, normalizeResumeOptions, promptFor, spawnJsonLines, stopProcess, validId } from '../claude-code/runtime.mjs';

const defaults = { executablePath: 'agent', model: '', maxDurationSeconds: 1800 };
const configKeys = new Set(Object.keys(defaults));

function acp(executablePath, cwd, maxDurationSeconds, model, events = {}) {
  let nextId = 1;
  const pending = new Map();
  const handle = spawnJsonLines(executablePath, model ? ['--model', model, 'acp'] : ['acp'], cwd, {
    maxDurationSeconds,
    onMessage(message) {
      if (message?.id != null && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) && !message.method) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || 'ACP request failed'));
        else waiter.resolve(message.result);
        return;
      }
      if (message?.method === 'session/request_permission' && message.id != null) {
        events.permissionDenied?.();
        const options = message.params?.options || [];
        const reject = options.find(item => item.kind === 'reject-once' || item.optionId === 'reject-once');
        handle.send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: reject?.optionId || 'reject-once' } } });
        return;
      }
      if (message?.method === 'cursor/ask_question' && message.id != null) {
        events.permissionDenied?.();
        handle.send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } }); return;
      }
      if (message?.method === 'cursor/create_plan' && message.id != null) {
        events.permissionDenied?.();
        handle.send({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'rejected', reason: 'Review in Cursor before continuing' } } }); return;
      }
      if (message?.method === 'session/update') events.update?.(message.params);
    },
  });
  handle.exit.then(result => {
    for (const waiter of pending.values()) waiter.reject(result.error || new Error('ACP process exited before response'));
    pending.clear();
  });
  function call(method, params, timeoutMs = 10000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`ACP ${method} timed out`)); }, timeoutMs);
      pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { handle.send({ jsonrpc: '2.0', id, method, params }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  async function initialize() {
    const result = await call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'taskboard', version: '0.2.0' } });
    if (result?.protocolVersion !== 1) throw new Error('Unsupported ACP protocol version');
    await call('authenticate', { methodId: 'cursor_login' });
  }
  return { ...handle, call, initialize, notify(method, params) { handle.send({ jsonrpc: '2.0', method, params }); } };
}

export async function createPlugin(context) {
  const ledger = await createLedger({ id: 'cursor-agent', defaults, ...context });
  const { saved, active, persist, run, taskContext, command, finish, markRunning, now } = ledger;
  const authorizeExecution = typeof context.authorizeExecution === 'function' ? context.authorizeExecution : async () => true;
  const revalidateExecution = typeof context.revalidateExecution === 'function' ? context.revalidateExecution : async () => true;
  let closePromise;
  const auxiliaries = new Set();

  async function createSession({ taskId, expectedRevision, commandId }) {
    return run(async () => {
      if (!saved.enabled) throw new Error('Cursor adapter is disabled');
      if (!validId(commandId)) throw new Error('commandId is required');
      const existing = saved.sessions[taskId];
      if (existing) {
        if (existing.createCommandId !== commandId || existing.createRevision !== expectedRevision) throw new Error('Task already has another owned session');
        return copy(existing);
      }
      const { task, cwd } = await taskContext(taskId, expectedRevision, { bound: false });
      if (task.conversationId || task.status === 'running') throw new Error('Task already has a conversation binding');
      const session = { taskId, projectId: task.projectId, cwd, createCommandId: commandId, createRevision: expectedRevision, status: 'creating', createdAt: iso(now) };
      saved.sessions[taskId] = session;
      await persist();
      let client;
      try {
        client = acp(saved.config.executablePath, cwd, saved.config.maxDurationSeconds, saved.config.model);
        auxiliaries.add(client);
        await client.initialize();
        const validation = await revalidateExecution({ taskId, commandId, expectedRevision: task.revision, expectedConversationId: task.conversationId || null, expectedDirectory: cwd });
        if (validation === false || validation?.allowed === false || validation?.maySend === false || ledger.isClosed()) {
          session.status = 'not_started'; throw new Error('Session creation was cancelled before provider start');
        }
        const created = await client.call('session/new', { cwd, mcpServers: [] });
        if (typeof created?.sessionId !== 'string' || !created.sessionId) throw new Error('ACP did not return a session ID');
        session.sessionId = created.sessionId;
        await ledger.updateTask(taskId, { conversationId: session.sessionId, sourceConversation: { provider: 'cursor-agent', conversationId: session.sessionId, label: task.title } }, expectedRevision);
        session.status = 'created'; await persist();
      } catch (error) {
        session.status = session.status === 'not_started' ? 'not_started' : /auth|login|credential/i.test(errorText(error)) ? 'awaiting_approval' : 'unknown'; session.lastError = errorText(error);
        if (['awaiting_approval', 'not_started'].includes(session.status) && !session.sessionId) delete saved.sessions[taskId];
        await persist();
      }
      finally { if (client) { try { await stopProcess(client); } finally { auxiliaries.delete(client); } } }
      return copy(session);
    });
  }

  async function resume({ taskId, expectedRevision, commandId, ...inputOptions }) {
    return run(async () => {
      if (!saved.enabled) throw new Error('Cursor adapter is disabled');
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
      const entry = { taskId, commandId, sessionId: session.sessionId, cwd, revision: task.revision, contentVersion: task.contentVersion,
        digest: fingerprint, optionsDigest: digest(options), status: 'sending', createdAt: iso(now), updatedAt: iso(now) };
      saved.commands[commandId] = entry; await persist();
      if (entry.pauseRequested || ledger.isClosed()) {
        entry.status = 'not_started'; entry.lastError = 'Execution was cancelled before provider start'; await persist(); return copy(entry);
      }
      let started = false, denied = false, stopReason = null, startWork = Promise.resolve(), resolveStart;
      const startedOrExit = new Promise(resolve => { resolveStart = resolve; });
      let client;
      try {
        client = acp(saved.config.executablePath, cwd, saved.config.maxDurationSeconds, options.model || saved.config.model, {
          permissionDenied() { denied = true; },
          update(params) {
            if (params?.sessionId !== session.sessionId) return;
            const kind = params.update?.sessionUpdate;
            if (!started && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(kind)) {
              started = true;
              startWork = markRunning(taskId, entry).then(() => resolveStart(true), () => { client?.child.kill('SIGTERM'); resolveStart(false); });
            }
          },
        });
      } catch (error) { entry.status = 'failed'; entry.lastError = errorText(error); await persist(); return copy(entry); }
      const live = { client, entry, session, completion: null, cancelRequested: false, cancelConfirmed: false, promptPromise: null };
      active.set(taskId, live);
      live.completion = (async () => {
        try {
          await client.initialize();
          const loaded = await client.call('session/load', { sessionId: session.sessionId, cwd, mcpServers: [] });
          if (loaded?.sessionId && loaded.sessionId !== session.sessionId) throw new Error('ACP loaded a different session');
          if (options.evidenceOnly) {
            try { await client.call('session/set_mode', { sessionId: session.sessionId, modeId: 'ask' }); }
            catch { entry.status = 'not_started'; entry.lastError = 'Cursor ACP did not confirm read-only ask mode'; throw new Error(entry.lastError); }
          }
          try {
            const authorization = await authorizeExecution({ taskId, commandId });
            if (authorization === false || (authorization && typeof authorization === 'object' && authorization.maySend !== true) || ledger.isClosed() || live.cancelRequested || entry.pauseRequested) throw new Error('Execution was cancelled before provider start');
          } catch (error) {
            entry.status = 'not_started'; throw error;
          }
          try {
            const validation = await revalidateExecution({ taskId, commandId, expectedRevision: task.revision, expectedConversationId: task.conversationId || null, expectedDirectory: cwd });
            if (validation === false || validation?.allowed === false || validation?.maySend === false || ledger.isClosed() || live.cancelRequested || entry.pauseRequested) throw new Error('Execution was cancelled before provider start');
          } catch (error) {
            entry.status = 'not_started'; throw error;
          }
          live.promptPromise = client.call('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: promptFor(task, options) }] }, saved.config.maxDurationSeconds * 1000);
          const result = await live.promptPromise;
          stopReason = result?.stopReason;
        } catch (error) {
          if (!live.cancelRequested && /auth|login|credential/i.test(errorText(error))) denied = true;
          entry.lastError = errorText(error);
        }
        resolveStart(false);
        await startWork.catch(() => {});
        const ended = await stopProcess(client);
        entry.exitConfirmed = Boolean(ended && !ended.error);
        active.delete(taskId);
        if (entry.status === 'not_started') { await persist(); return; }
        if (live.cancelRequested) {
          if (live.cancelConfirmed && (stopReason === 'cancelled' || stopReason === 'canceled')) await finish(taskId, entry, 'paused');
          else await finish(taskId, entry, 'unknown', 'ACP cancellation was not confirmed');
        } else if (denied) {
          if (started) await finish(taskId, entry, 'awaiting_approval', 'Cursor requires approval or authentication');
          else {
            entry.status = 'awaiting_approval'; entry.lastError = 'Cursor requires approval or authentication';
            const current = await ledger.getTask(taskId);
            if (current.revision === entry.revision && current.contentVersion === entry.contentVersion) await ledger.updateTask(taskId, { status: 'blocked', blockedReason: entry.lastError }, current.revision);
            await persist();
          }
        } else if (started && stopReason === 'end_turn' && ended) await finish(taskId, entry, 'completed');
        else await finish(taskId, entry, started ? 'unknown' : 'failed', entry.lastError || 'Cursor did not confirm a successful prompt');
      })().catch(async error => { active.delete(taskId); resolveStart(false); entry.status = 'unknown'; entry.lastError = errorText(error); await persist(); });
      const confirmed = await startedOrExit;
      if (confirmed) return copy(entry);
      await live.completion;
      return copy(entry);
    });
  }

  async function pause({ taskId, expectedRevision }) {
    const { session } = await taskContext(taskId, expectedRevision);
    const live = active.get(taskId);
    if (!live) {
      const sending = Object.values(saved.commands).find(item => item.taskId === taskId && item.status === 'sending' && item.sessionId === session.sessionId);
      if (sending) { sending.pauseRequested = true; await persist(); return { taskId, status: 'not_started' }; }
      return { taskId, status: 'unknown', lastError: 'No owned live Cursor prompt to cancel' };
    }
    if (live.session.sessionId !== session.sessionId || live.entry.cwd !== session.cwd) return { taskId, status: 'unknown', lastError: 'No owned live Cursor prompt to cancel' };
    live.cancelRequested = true; live.entry.status = 'pausing'; await persist();
    if (!live.promptPromise) { await stopProcess(live.client); await live.completion; return { taskId, status: live.entry.status }; }
    try {
      live.client.notify('session/cancel', { sessionId: session.sessionId });
      let timer;
      try { await Promise.race([live.promptPromise.then(result => { live.cancelConfirmed = ['cancelled', 'canceled'].includes(result?.stopReason); }), new Promise(resolve => { timer = setTimeout(resolve, 2500); })]); }
      finally { clearTimeout(timer); }
    } catch { /* completion reports unknown */ }
    if (!live.cancelConfirmed) await stopProcess(live.client);
    await live.completion;
    return { taskId, status: live.entry.status };
  }

  async function reconcile({ taskId, expectedRevision, confirmStopped = false }) {
    return run(async () => {
      await taskContext(taskId, expectedRevision);
      const unknown = Object.values(saved.commands).filter(item => item.taskId === taskId && item.status === 'unknown');
      if (!unknown.length) return { taskId, status: 'idle' };
      if (active.has(taskId) || confirmStopped !== true) return { taskId, status: 'unknown', lastError: 'Confirm Cursor prompt stopped before reconciliation' };
      for (const entry of unknown) { entry.status = 'reconciled'; entry.updatedAt = iso(now); }
      await persist(); return { taskId, status: 'reconciled' };
    });
  }

  async function shutdown() {
    const results = await Promise.allSettled([...active.values()].map(async live => {
      live.cancelRequested = true;
      if (live.promptPromise) live.client.notify('session/cancel', { sessionId: live.session.sessionId });
      await stopProcess(live.client); await live.completion;
    }).concat([...auxiliaries].map(client => stopProcess(client))));
    const failures = results.filter(item => item.status === 'rejected').map(item => item.reason);
    if (failures.length) throw new AggregateError(failures, 'Cursor process shutdown unconfirmed');
  }

  return {
    state: ledger.state,
    configure(config) { return run(async () => {
      if (active.size) throw new Error('Cannot change Cursor settings during an active prompt');
      if (!config || Object.keys(config).some(key => !configKeys.has(key))) throw new Error('Unsupported Cursor setting');
      if (config.executablePath !== undefined && (typeof config.executablePath !== 'string' || !config.executablePath.trim())) throw new Error('Invalid executablePath');
      if (config.model !== undefined && typeof config.model !== 'string') throw new Error('Invalid model');
      if (config.maxDurationSeconds !== undefined && (!Number.isInteger(config.maxDurationSeconds) || config.maxDurationSeconds < 10 || config.maxDurationSeconds > 14400)) throw new Error('Invalid maxDurationSeconds');
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
