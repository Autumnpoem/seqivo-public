import test from 'node:test';
import assert from 'node:assert/strict';
import { publicConversation } from '../plugins/codex-autocontinue/host.mjs';
import { captureCompletedConversation, completedConversationForTask,
  boundCompletedConversations, addCompletedConversation } from
  '../plugins/codex-autocontinue/completed-conversation-snapshot.mjs';

const task = { id: 'task-a', projectId: 'project-a', conversationId: 'thread-a',
  contentVersion: 2, status: 'running', updatedAt: '2026-01-01T00:00:00.000Z' };
const entry = { taskId: task.id, threadId: task.conversationId, turnId: 'turn-a',
  commandId: 'command-a', workspace: '/test/workspace', worktreeId: null,
  requestedContentVersion: 2, startedContentVersion: 2,
  status: 'completed', turnCompleteEvent: true };
const thread = { status: { type: 'idle' }, turns: [{ id: entry.turnId,
  status: 'completed', items: [
    { id: 'public', type: 'agentMessage', text: 'Finished /Users/person/private/file' },
    { id: 'secret', type: 'reasoning', text: 'PRIVATE_REASONING' },
  ] }] };
const binding = { directory: entry.workspace, worktreeId: null };
const commands = () => ({ [`${task.id}:${entry.commandId}`]: { ...entry, status: 'completed',
  stopProof: { status: 'verified', threadId: entry.threadId, turnId: entry.turnId } } });
const capture = (overrides = {}) => captureCompletedConversation({ task, entry, thread,
  output: publicConversation(task, thread, commands()),
  capturedAt: '2026-01-01T00:00:05.000Z', ...overrides });

test('final idle thread produces only the bounded public transcript and reads after retirement', () => {
  const snapshot = capture();
  assert.ok(snapshot);
  assert.equal(JSON.stringify(snapshot).includes('PRIVATE_REASONING'), false);
  assert.equal(JSON.stringify(snapshot).includes('/Users/person'), false);
  const result = completedConversationForTask(snapshot, { ...task, status: 'submitted' }, binding, commands());
  assert.equal(result.status, 'submitted');
  assert.deepEqual(result.messages.map(message => message.role), ['assistant']);
  assert.match(result.messages[0].text, /Finished \[local path\]/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 700_000);
});

test('unverified stop, a newer command, or changed task/thread/workspace cannot serve old output as current', () => {
  const snapshot = capture();
  const original = commands();
  assert.equal(completedConversationForTask(snapshot, task, binding,
    { ...original, newer: { taskId: task.id, threadId: entry.threadId,
      commandId: 'newer', status: 'sending' } }), null);
  assert.equal(completedConversationForTask(snapshot, task, binding,
    { [`${task.id}:${entry.commandId}`]: { ...original[`${task.id}:${entry.commandId}`],
      stopProof: { status: 'unverified' } } }), null);
  assert.equal(completedConversationForTask(snapshot, { ...task, conversationId: 'other' }, binding, original), null);
  assert.equal(completedConversationForTask(snapshot, { ...task, contentVersion: 3 }, binding, original), null);
  assert.equal(completedConversationForTask(snapshot, task, { directory: '/other', worktreeId: null }, original), null);
  assert.equal(capture({ entry: { ...entry, startedContentVersion: 1 } }), null);
  assert.equal(capture({ output: { ...publicConversation(task, thread, original), taskId: 'other' } }), null);
  assert.equal(completedConversationForTask(snapshot, task, binding,
    { [`${task.id}:${entry.commandId}`]: { ...original[`${task.id}:${entry.commandId}`], status: 'failed' } }), null);
});

test('incomplete final thread and oversized output never become a durable snapshot', () => {
  assert.equal(capture({ thread: { ...thread, status: { type: 'active' } } }), null);
  assert.equal(capture({ entry: { ...entry, turnCompleteEvent: false } }), null);
  assert.equal(capture({ output: { messages: Array.from({ length: 81 }, (_, index) => ({
    id: String(index), role: 'assistant', text: 'x' })), truncated: true } }), null);
});

test('large multibyte public output keeps the newest completed answer within the durable budget', () => {
  const messages = Array.from({ length: 79 }, (_, index) => ({
    id: String(index), role: 'tool', text: '中'.repeat(6000),
  }));
  messages.push({ id: 'answer', role: 'assistant', text: '最后完成答复' });
  const snapshot = capture({ output: { taskId: task.id, status: task.status,
    messages, truncated: false } });
  assert.ok(snapshot);
  assert.equal(snapshot.output.truncated, true);
  assert.ok(snapshot.output.messages.length < messages.length);
  assert.equal(snapshot.output.messages.at(-1).text, '最后完成答复');
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 700_000);
});

test('global cache evicts only older verified final turns by count and actual JSON bytes', () => {
  const commandsByKey = {};
  let cache = {};
  for (let index = 0; index < 20; index++) {
    const taskId = `task-${index}`;
    const commandId = `command-${index}`;
    const snapshot = { ...capture(), taskId, commandId,
      capturedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString() };
    commandsByKey[`${taskId}:${commandId}`] = { ...entry, taskId, commandId,
      status: 'completed', stopProof: { status: 'verified', threadId: entry.threadId, turnId: entry.turnId } };
    cache = addCompletedConversation(cache, snapshot, commandsByKey);
    assert.ok(cache);
  }
  assert.equal(Object.keys(cache).length, 16);
  assert.equal(cache['task-0'], undefined);
  assert.ok(cache['task-19']);
  assert.equal(Object.keys(commandsByKey).length, 20, 'eviction cannot mutate retirement proofs');

  cache = {};
  for (let index = 0; index < 14; index++) {
    const taskId = `large-${index}`;
    const commandId = `large-command-${index}`;
    const snapshot = { ...capture(), taskId, commandId,
      capturedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
      output: { truncated: false, messages: Array.from({ length: 60 }, (_, number) => ({
        id: String(number), role: 'assistant', text: 'x'.repeat(6000),
      })) } };
    commandsByKey[`${taskId}:${commandId}`] = { ...entry, taskId, commandId,
      status: 'completed', stopProof: { status: 'verified', threadId: entry.threadId, turnId: entry.turnId } };
    cache = addCompletedConversation(cache, snapshot, commandsByKey);
    assert.ok(cache);
  }
  assert.ok(Object.keys(cache).length < 14, 'the byte cap must evict before the entry cap');
  assert.ok(cache['large-13']);
  assert.ok(Buffer.byteLength(JSON.stringify(cache)) <= 4 * 1024 * 1024);
});

test('unverified entries cannot be evicted to admit new output and malformed restored maps fail closed', () => {
  const original = capture();
  const pending = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [
    `pending-${index}`, { ...original, taskId: `pending-${index}`, commandId: `command-${index}` },
  ]));
  const commandsByKey = {};
  const newSnapshot = { ...original, taskId: 'newest', commandId: 'new-command' };
  assert.equal(addCompletedConversation(pending, newSnapshot, commandsByKey), null);
  assert.equal(Object.keys(pending).length, 16);
  const restored = boundCompletedConversations({ ...pending,
    invalid: { ...original, taskId: 'other', extraPrivateField: 'never persist this' } }, commandsByKey);
  assert.ok(restored);
  assert.equal(Object.hasOwn(restored, 'invalid'), false);
  const overBudget = { ...pending, newest: newSnapshot };
  assert.equal(boundCompletedConversations(overBudget, commandsByKey), null);
});
