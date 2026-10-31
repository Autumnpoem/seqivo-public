import { createHash } from 'node:crypto';
import { BoardError, text } from './store.mjs';

const PREFIX = 'conversation.command.v1.';
const MAX_WATCHED = 5;
const CACHE_MS = 2000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const publicStatus = value => ['running', 'created', 'awaiting_approval', 'unknown', 'failed', 'waiting_quota', 'completed', 'submitted'].includes(value) ? value : 'unknown';

export function createConversations({ store, plugin, selectedProjects = () => [], beforeRemoteOperation = async () => {}, emit = () => {} }) {
  const cache = new Map();
  const pending = new Map();
  let closed = false;
  let serial = Promise.resolve();
  const ensureOpen = () => { if (closed) throw new BoardError('程序正在关闭，不能启动会话', 503, 'CONVERSATION_CLOSED'); };
  const queue = fn => { const result = serial.then(() => { ensureOpen(); return fn(); }); serial = result.catch(() => {}); return result; };
  async function beforeOperation(input, remote) {
    ensureOpen();
    if (remote) await beforeRemoteOperation(input);
    ensureOpen();
    if (input.taskId) scopedTask(input.taskId, remote); else scope(input.projectId, remote);
  }

  function scope(projectId, remote) {
    const project = store.getProject(projectId);
    if (remote && !selectedProjects().includes(projectId)) throw new BoardError('项目未授权远程访问', 403, 'PROJECT_FORBIDDEN');
    if (!project.directory) throw new BoardError('项目尚未绑定本地目录', 409, 'PROJECT_UNBOUND');
    return project;
  }
  function scopedTask(taskId, remote) {
    const task = store.getTask(taskId);
    scope(task.projectId, remote);
    return task;
  }
  function record(commandId) {
    const row = store.db.prepare('SELECT value FROM metadata WHERE key=?').get(PREFIX + commandId);
    return row ? JSON.parse(row.value) : null;
  }
  function save(commandId, value) {
    store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(PREFIX + commandId, JSON.stringify(value));
  }
  function validCommand(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9._:-]{1,160}$/.test(value)) throw new BoardError('commandId 格式不正确');
    return value;
  }
  function snapshot(command) { return { taskId: command.taskId, status: publicStatus(command.status) }; }

  async function create(input, remote = false) {
    const projectId = text(input.projectId, '项目 ID', 300, true);
    const message = text(input.message, '指令', 10000, true);
    const title = text(input.title || message.slice(0, 80), '会话标题', 240, true);
    const commandId = validCommand(input.commandId);
    scope(projectId, remote);
    const requestHash = hash({ projectId, title, message });
    return queue(async () => {
      await beforeOperation({commandId,projectId},remote);
      let command = record(commandId);
      if (command && command.requestHash !== requestHash) throw new BoardError('commandId 已用于其他指令', 409, 'COMMAND_CONFLICT');
      if (!command) {
        store.transaction(() => {
          const task = store.createTask({ projectId, title, goal: message, executionProvider: 'codex-autocontinue' });
          command = { taskId: task.id, requestHash, status: 'created', phase: 'task', message, expectedRevision: task.revision };
          save(commandId, command);
        });
        emit();
      }
      const task = scopedTask(command.taskId, remote);
      if (['running', 'awaiting_approval', 'unknown', 'failed', 'waiting_quota'].includes(command.status)) return snapshot(command);
      if (!task.conversationId) {
        await beforeOperation({commandId,taskId:task.id},remote);
        let session;
        try { session = await plugin.createSession({ taskId: task.id, expectedRevision: command.expectedRevision, commandId: `${commandId}:session`, workspaceWrite: true }); }
        catch { command.status = 'unknown'; save(commandId, command); return snapshot(command); }
        if (session?.status !== 'created') {
          command.status = session?.status === 'unknown' ? 'unknown' : 'failed';
          save(commandId, command);
          return snapshot(command);
        }
      }
      if (!command.turnRevision) { command.turnRevision = store.getTask(task.id).revision; command.phase = 'session'; save(commandId, command); }
      const bound=store.getTask(task.id);
      command.executionBinding={action:'create_conversation',projectId:bound.projectId,taskId:bound.id,
        localCommandId:`${commandId}:turn`,threadId:bound.conversationId};
      save(commandId,command);
      let result;
      await beforeOperation({commandId,taskId:task.id},remote);
      try { result = await plugin.resume({ taskId: task.id, expectedRevision: command.turnRevision, commandId: `${commandId}:turn`, instructions: message }); }
      catch { command.status = 'unknown'; save(commandId, command); return snapshot(command); }
      command.status = publicStatus(result?.status);
      save(commandId, command); emit();
      return snapshot(command);
    });
  }

  async function startTask(taskId, input, remote = false) {
    const message = text(input.message, '指令', 10000, true);
    const commandId = validCommand(input.commandId);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)
      throw new BoardError('expectedRevision 必填');
    scopedTask(taskId, remote);
    const requestHash = hash({taskId,expectedRevision:input.expectedRevision,message});
    return queue(async () => {
      await beforeOperation({commandId,taskId},remote);
      let command = record(commandId);
      if (command && command.requestHash !== requestHash) throw new BoardError('commandId 已用于其他指令',409,'COMMAND_CONFLICT');
      if (!command) {
        const task = scopedTask(taskId,remote);
        store.checkRevision(task,input.expectedRevision);
        if (task.status !== 'planned' || task.conversationId ||
            (task.executionProvider || 'codex-autocontinue') !== 'codex-autocontinue')
          throw new BoardError('任务不能启动新的 Codex 会话',409,'TASK_START_UNAVAILABLE');
        command={taskId,requestHash,status:'created',phase:'task',expectedRevision:input.expectedRevision};
        save(commandId,command);
      }
      if (['running','awaiting_approval','unknown','failed','waiting_quota','completed','submitted'].includes(command.status)) return snapshot(command);
      const task = scopedTask(taskId,remote);
      if (!task.conversationId) {
        await beforeOperation({commandId,taskId},remote);
        let session;
        try { session=await plugin.createSession({taskId,expectedRevision:command.expectedRevision,commandId:`${commandId}:session`,workspaceWrite:true}); }
        catch { command.status='unknown';save(commandId,command);return snapshot(command); }
        if (session?.status!=='created') {
          command.status=session?.status==='unknown'?'unknown':'failed';save(commandId,command);return snapshot(command);
        }
        const bound=store.getTask(taskId);
        if (session.taskId!==taskId || session.expectedRevision!==command.expectedRevision ||
            session.commandId!==`${commandId}:session` || !session.threadId ||
            bound.conversationId!==session.threadId || bound.projectId!==task.projectId) {
          command.status='unknown';save(commandId,command);return snapshot(command);
        }
        command.sessionThreadId=session.threadId;
      }
      if (!command.sessionThreadId) {command.status='unknown';save(commandId,command);return snapshot(command);}
      if (!command.turnRevision) {command.turnRevision=store.getTask(taskId).revision;command.phase='session';}
      command.executionBinding={action:'start_task',projectId:task.projectId,taskId,
        localCommandId:`${commandId}:turn`,threadId:command.sessionThreadId};
      command.status='unknown';save(commandId,command);
      await beforeOperation({commandId:`${commandId}:turn`,taskId},remote);
      let result;
      try {result=await plugin.resume({taskId,expectedRevision:command.turnRevision,commandId:`${commandId}:turn`,instructions:message});}
      catch {command.status='unknown';save(commandId,command);return snapshot(command);}
      command.status=publicStatus(result?.status);save(commandId,command);emit();
      return snapshot(command);
    });
  }

  async function message(taskId, input, remote = false) {
    const task = scopedTask(taskId, remote);
    if ((task.executionProvider || 'codex-autocontinue') !== 'codex-autocontinue') throw new BoardError('任务未使用 Codex 会话', 409);
    if (!task.conversationId) throw new BoardError('任务尚未绑定 Codex 会话', 409);
    const instructions = text(input.message, '指令', 10000, true);
    const commandId = validCommand(input.commandId);
    if (!Number.isInteger(input.expectedRevision)) throw new BoardError('expectedRevision 必填');
    if (task.revision !== input.expectedRevision) {
      // A retried command may have changed the task's revision itself. The
      // plugin checks its persisted command hash before attempting another send.
      const prior = record(commandId);
      if (!prior || prior.requestHash !== hash({ taskId, instructions, expectedRevision: input.expectedRevision })) throw new BoardError('任务版本已更新', 409, 'REVISION_CONFLICT');
    }
    return queue(async () => {
      await beforeOperation({commandId,taskId},remote);
      const requestHash = hash({ taskId, instructions, expectedRevision: input.expectedRevision });
      let command = record(commandId);
      if (command && command.requestHash !== requestHash) throw new BoardError('commandId 已用于其他指令', 409, 'COMMAND_CONFLICT');
      if (command) return snapshot(command);
      command = { taskId, requestHash, status: 'unknown',executionBinding:{action:'message',projectId:task.projectId,
        taskId,localCommandId:commandId,threadId:task.conversationId} };
      save(commandId, command);
      let result;
      try {
        result = await plugin.resume({ taskId, expectedRevision: input.expectedRevision, commandId, instructions, allowSubmitted: true });
      } catch (error) {
        // The plugin records sending before its external RPC. A failure here
        // remains unknown until a local operator reconciles the Codex turn.
        command.status = ['EXECUTION_DUPLICATE', 'UNKNOWN_RESULT', 'PLUGIN_TIMEOUT', 'PLUGIN_UNAVAILABLE'].includes(error?.code) ? 'unknown' : 'failed';
        save(commandId, command);
        return snapshot(command);
      }
      command.status = publicStatus(result?.status);
      save(commandId, command); emit();
      return snapshot(command);
    });
  }

  async function refresh(taskId) {
    if (closed) throw new Error('Conversation runtime closed');
    if (pending.has(taskId)) return pending.get(taskId);
    const task = store.getTask(taskId);
    const promise = (async () => {
      const fallback = { taskId, projectId: task.projectId, status: task.status, messages: [], updatedAt: task.updatedAt, truncated: false };
      if (!task.conversationId || (task.executionProvider || 'codex-autocontinue') !== 'codex-autocontinue') return fallback;
      const result = await plugin.conversation({ taskId });
      if (!result || result.taskId !== taskId || !Array.isArray(result.messages)) throw new Error('Invalid conversation response');
      const previous = cache.get(taskId)?.value;
      const unchanged = previous && previous.status === result.status && previous.truncated === (result.truncated === true) && hash(previous.messages) === hash(result.messages);
      const safe = { taskId, projectId: task.projectId, status: result.status, messages: result.messages, updatedAt: unchanged ? previous.updatedAt : new Date().toISOString(), truncated: result.truncated === true };
      cache.set(taskId, { at: Date.now(), value: safe }); emit();
      return safe;
    })().finally(() => pending.delete(taskId));
    pending.set(taskId, promise);
    return promise;
  }
  async function get(taskId, remote = false) {
    scopedTask(taskId, remote);
    try { return await refresh(taskId); }
    catch { const existing = cache.get(taskId)?.value; if (existing) return existing; throw new BoardError('Codex 会话暂不可读取', 503, 'CONVERSATION_UNAVAILABLE'); }
  }
  function getMany(projectIds, taskIds = []) {
    const allowed = new Set(projectIds);
    const ids = [...new Set(taskIds)].slice(0, MAX_WATCHED);
    const result = [];
    for (const id of ids) {
      let task;
      try { task = store.getTask(id); } catch { continue; }
      if (!allowed.has(task.projectId)) continue;
      const cached = cache.get(id);
      if (!closed && (!cached || Date.now() - cached.at > CACHE_MS)) void refresh(id).catch(() => {});
      result.push(cached?.value || { taskId: id, projectId: task.projectId, status: task.status, messages: [], updatedAt: task.updatedAt, truncated: false });
    }
    return result;
  }
  async function close() { closed = true; await Promise.allSettled([...pending.values(), serial]); }
  function executionBinding(commandId) {
    const command=record(validCommand(commandId));
    if(!command||!command.requestHash||!command.taskId)return null;
    if(command.executionBinding)return structuredClone(command.executionBinding);
    // Old start-task journals already durably bound the created thread before
    // dispatch. A suffix by itself is never a binding to a Hub command.
    if(command.phase==='session'&&typeof command.sessionThreadId==='string'&&command.sessionThreadId&&
      Number.isSafeInteger(command.expectedRevision)&&Number.isSafeInteger(command.turnRevision)){
      const task=store.getTask(command.taskId);
      return {action:'start_task',projectId:task.projectId,taskId:task.id,
        localCommandId:`${commandId}:turn`,threadId:command.sessionThreadId};
    }
    return null;
  }
  return { create, startTask, message, get, getMany, close, executionBinding };
}
