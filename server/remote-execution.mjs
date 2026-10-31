import { BoardError } from './store.mjs';

// Persist the remote origin, but never a credential or a callable permission.
// A late plugin callback after a timeout/restart must fail closed.
const PREFIX = 'execution.remote.v1.';
export function createRemoteExecution({ store, isClosing = () => false }) {
  const active = new Map();
  const denied = () => { throw new BoardError('远程执行授权已失效，请重新发送指令', 403, 'REMOTE_EXECUTION_REVOKED'); };
  const read = id => {
    const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(PREFIX + id);
    return row ? JSON.parse(row.value) : null;
  };
  async function check({ commandId, taskId, projectId, required = false }) {
    const origin = read(commandId);
    if (!origin) { if (required) denied(); return; }
    const guard = active.get(commandId);
    if (!guard || isClosing()) denied();
    const matches = () => {
      const project = taskId ? store.getTask(taskId).projectId : projectId;
      if (project !== origin.projectId || origin.taskId && origin.taskId !== taskId) denied();
    };
    matches();
    let stage;
    if (guard.action==='start_task' && commandId===`${guard.commandId}:session`)
      stage={stage:'confirmed-start-session'};
    if (guard.action==='start_task' && commandId===`${guard.commandId}:turn`) {
      const command=store.db.prepare('SELECT value FROM metadata WHERE key=?').get(`conversation.command.v1.${guard.commandId}`);
      const record=command&&JSON.parse(command.value),task=store.getTask(taskId);
      if (record?.taskId!==taskId || record.expectedRevision!==guard.expectedRevision ||
          record.phase!=='session' || record.status!=='unknown' ||
          record.turnRevision!==task.revision || record.sessionThreadId!==task.conversationId ||
          !task.conversationId || task.projectId!==guard.projectId) denied();
      stage={stage:'confirmed-start-turn',taskRevision:task.revision,threadId:task.conversationId};
    }
    await guard.revalidate(stage);
    if (active.get(commandId) !== guard || isClosing()) denied();
    matches();
  }
  async function run(authorization, operation) {
    if (isClosing() || !authorization || typeof authorization.revalidate !== 'function') denied();
    const { commandId, projectId, taskId, action } = authorization;
    const ids = ['create_conversation','start_task'].includes(action) ? [commandId, `${commandId}:session`, `${commandId}:turn`] : [commandId];
    const origin = { projectId, taskId: action === 'create_conversation' ? null : taskId };
    store.transaction(() => {
      for (const id of ids) {
        const previous = read(id);
        if (active.has(id) || previous && JSON.stringify(previous) !== JSON.stringify(origin)) denied();
        store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(PREFIX + id, JSON.stringify(origin));
      }
    });
    for (const id of ids) active.set(id, authorization);
    try { return await operation(); }
    finally { for (const id of ids) active.delete(id); }
  }
  return { check, run };
}
