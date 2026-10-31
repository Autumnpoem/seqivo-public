const MAX_MESSAGES = 80;
const MAX_BYTES = 700_000;
const MAX_CACHE_ENTRIES = 16;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const FINAL_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const MESSAGE_ROLES = new Set(['user', 'assistant', 'tool']);
const MESSAGE_STATUSES = new Set(['inProgress', 'completed', 'failed']);

function validOutput(output, enforceByteLimit = true) {
  if (!output || !Array.isArray(output.messages) || output.messages.length > MAX_MESSAGES ||
      typeof output.truncated !== 'boolean') return false;
  if (!output.messages.every(message => message &&
      Object.keys(message).every(key => ['id', 'role', 'text', 'status'].includes(key)) &&
      typeof message.id === 'string' &&
      message.id.length > 0 && message.id.length <= 80 && MESSAGE_ROLES.has(message.role) &&
      typeof message.text === 'string' && message.text.length <= 6000 &&
      (message.status === undefined || MESSAGE_STATUSES.has(message.status)))) return false;
  return !enforceByteLimit || Buffer.byteLength(JSON.stringify(output)) <= MAX_BYTES;
}

function validSnapshot(snapshot, taskId) {
  return snapshot?.version === 1 && snapshot.taskId === taskId &&
    [snapshot.taskId, snapshot.projectId, snapshot.threadId, snapshot.turnId,
      snapshot.commandId, snapshot.workspace, snapshot.capturedAt].every(value =>
      typeof value === 'string' && value.length > 0) &&
    FINAL_STATUSES.has(snapshot.turnStatus) &&
    Number.isSafeInteger(snapshot.contentVersion) && snapshot.contentVersion > 0 &&
    (snapshot.bridgePid === null || Number.isSafeInteger(snapshot.bridgePid) && snapshot.bridgePid > 0) &&
    (snapshot.worktreeId === null || typeof snapshot.worktreeId === 'string') &&
    validOutput(snapshot.output) && Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_BYTES &&
    Object.keys(snapshot).every(key => ['version', 'taskId', 'projectId', 'threadId',
      'turnId', 'turnStatus', 'commandId', 'bridgePid', 'contentVersion', 'workspace',
      'worktreeId', 'capturedAt', 'output'].includes(key));
}

function finalVerified(snapshot, commands) {
  const command = commands?.[`${snapshot.taskId}:${snapshot.commandId}`];
  return command?.taskId === snapshot.taskId && command.commandId === snapshot.commandId &&
    command.threadId === snapshot.threadId && command.turnId === snapshot.turnId &&
    command.status === snapshot.turnStatus && command.workspace === snapshot.workspace &&
    (command.bridgePid || null) === snapshot.bridgePid && command.turnCompleteEvent === true &&
    command.stopProof?.status === 'verified' &&
    command.stopProof.threadId === snapshot.threadId &&
    command.stopProof.turnId === snapshot.turnId;
}

/** Bound only the optional transcript cache; command and retirement records are untouched. */
export function boundCompletedConversations(raw, commands, { keepTaskId = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const entries = Object.entries(raw).filter(([taskId, snapshot]) => validSnapshot(snapshot, taskId));
  const cache = Object.fromEntries(entries);
  const bytes = () => Buffer.byteLength(JSON.stringify(cache));
  while (Object.keys(cache).length > MAX_CACHE_ENTRIES || bytes() > MAX_CACHE_BYTES) {
    const oldest = Object.entries(cache)
      .filter(([taskId, snapshot]) => taskId !== keepTaskId && finalVerified(snapshot, commands))
      .sort((a, b) => a[1].capturedAt.localeCompare(b[1].capturedAt) || a[0].localeCompare(b[0]))[0];
    if (!oldest) return null;
    delete cache[oldest[0]];
  }
  return cache;
}

export function addCompletedConversation(raw, snapshot, commands) {
  if (!validSnapshot(snapshot, snapshot?.taskId)) return null;
  const candidate = Object.fromEntries([...Object.entries(raw || {})
    .filter(([taskId]) => taskId !== snapshot.taskId), [snapshot.taskId, snapshot]]);
  return boundCompletedConversations(candidate, commands, { keepTaskId: snapshot.taskId });
}

/** Retain only the already-public, bounded transcript from a verified final thread read. */
export function captureCompletedConversation({ task, entry, thread, output, capturedAt }) {
  const lastTurn = Array.isArray(thread?.turns) ? thread.turns.at(-1) : null;
  if (!task || !entry || thread?.status?.type !== 'idle' ||
      lastTurn?.id !== entry.turnId ||
      lastTurn.status !== (entry.status === 'running' ? 'interrupted' : entry.status) ||
      !FINAL_STATUSES.has(lastTurn.status) || !entry.turnCompleteEvent ||
      task.id !== entry.taskId || task.conversationId !== entry.threadId ||
      !Number.isSafeInteger(task.contentVersion) || task.contentVersion < 1 ||
      (entry.startedContentVersion ?? entry.requestedContentVersion) !== task.contentVersion ||
      typeof task.projectId !== 'string' || typeof entry.commandId !== 'string' ||
      typeof entry.workspace !== 'string' || output?.taskId !== task.id ||
      output.status !== task.status || !validOutput(output, false) ||
      typeof capturedAt !== 'string') return null;
  const snapshot = { version: 1, taskId: task.id, projectId: task.projectId,
    threadId: entry.threadId, turnId: entry.turnId, turnStatus: lastTurn.status,
    commandId: entry.commandId, bridgePid: entry.bridgePid || null,
    contentVersion: task.contentVersion, workspace: entry.workspace,
    worktreeId: entry.worktreeId || null, capturedAt,
    output: { messages: structuredClone(output.messages), truncated: output.truncated } };
  // A public transcript can be valid yet exceed the private cache budget with
  // multibyte text. Retain the newest final answer instead of losing all output.
  while (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_BYTES && snapshot.output.messages.length) {
    snapshot.output.messages.shift();
    snapshot.output.truncated = true;
  }
  return Buffer.byteLength(JSON.stringify(snapshot)) <= MAX_BYTES ? snapshot : null;
}

/** A stopped, exact original turn is the only authority for an offline transcript. */
export function completedConversationForTask(snapshot, task, binding, commands) {
  if (!snapshot || snapshot.version !== 1 || !task || !binding ||
      snapshot.taskId !== task.id || snapshot.projectId !== task.projectId ||
      snapshot.threadId !== task.conversationId ||
      snapshot.contentVersion !== task.contentVersion ||
      snapshot.workspace !== binding.directory ||
      snapshot.worktreeId !== (binding.worktreeId || null) ||
      typeof snapshot.capturedAt !== 'string' || !validOutput(snapshot.output)) return null;
  const relevant = Object.values(commands || {}).filter(command => command?.taskId === task.id &&
    command.threadId === task.conversationId);
  const last = relevant.at(-1);
  if (!last || last.commandId !== snapshot.commandId || last.turnId !== snapshot.turnId ||
      last.status !== snapshot.turnStatus ||
      (last.bridgePid || null) !== snapshot.bridgePid ||
      last.workspace !== snapshot.workspace ||
      last.stopProof?.status !== 'verified' ||
      last.stopProof.turnId !== snapshot.turnId ||
      last.stopProof.threadId !== snapshot.threadId ||
      last.turnCompleteEvent !== true || !FINAL_STATUSES.has(last.status) ||
      relevant.some(command => command !== last &&
        ['sending', 'running', 'unknown', 'awaiting_approval'].includes(command.status))) return null;
  return { taskId: task.id, status: task.status,
    messages: structuredClone(snapshot.output.messages),
    updatedAt: snapshot.capturedAt, truncated: snapshot.output.truncated };
}
