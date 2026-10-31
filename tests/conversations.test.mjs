import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createConversations } from '../server/conversations.mjs';
import { createPublicDeltaCache, publicConversation } from '../plugins/codex-autocontinue/host.mjs';

test('large unicode conversation stays below the isolated plugin RPC frame limit',()=>{
  const task={id:'bounded',conversationId:'thread',status:'running'};
  const thread={turns:[{id:'turn',items:Array.from({length:80},(_,i)=>({id:String(i),type:'agentMessage',text:'测'.repeat(6000)}))}]};
  const result=publicConversation(task,thread,{});
  assert.ok(Buffer.byteLength(JSON.stringify(result))<700000);
  assert.equal(result.truncated,true);
});

async function setup({resumeStatus='running'}={}) {
  const dir = await mkdtemp(join(tmpdir(), 'seqivo-conversation-'));
  const store = new Store(join(dir, 'board.sqlite'));
  const project = store.project({ name: 'Selected', directory: dir });
  const other = store.project({ name: 'Other' });
  let sessionCalls = 0, sendCalls = 0;
  const plugin = {
    async createSession({ taskId, expectedRevision,commandId }) {
      sessionCalls++;
      store.updateTask(taskId, { conversationId: 'private-thread' }, expectedRevision);
      return { status: 'created',taskId,expectedRevision,commandId,threadId:'private-thread' };
    },
    async resume({ taskId, expectedRevision }) {
      sendCalls++;
      if(resumeStatus==='running')store.updateTask(taskId, { status: 'running' }, expectedRevision);
      return { status: resumeStatus, threadId: 'private-thread' };
    },
    async conversation({ taskId }) {
      return { taskId, status: 'running', messages: [{ id: '1', role: 'assistant', text: 'Public progress' }], updatedAt: new Date().toISOString() };
    },
  };
  const runtime = createConversations({ store, plugin, selectedProjects: () => [project.id] });
  return { store, project, other, runtime, counts: () => ({ sessionCalls, sendCalls }) };
}

test('new conversation creates one task, one session and one turn across duplicate commands', async () => {
  const x = await setup();
  try {
    const input = { projectId: x.project.id, title: 'Edit code', message: 'Add a safe feature', commandId: 'mobile-1' };
    const first = await x.runtime.create(input, true);
    const second = await x.runtime.create(input, true);
    assert.deepEqual(second, first);
    assert.equal(first.status, 'running');
    assert.equal(x.store.tasks(x.project.id).length, 1);
    assert.deepEqual(x.counts(), { sessionCalls: 1, sendCalls: 1 });
    assert.equal('threadId' in first, false);
    await assert.rejects(x.runtime.create({ ...input, message: 'different' }, true), /commandId/);
  } finally { x.store.close(); }
});

test('startTask binds and starts the original task once while preserving criteria and evidence',async()=>{
  const x=await setup();try{
    const initial=x.store.createTask({projectId:x.project.id,title:'Original',goal:'Keep goal',criteria:['Original criterion']});
    x.store.addEvidence(initial.id,{summary:'Prior evidence',reference:'local',expectedRevision:initial.revision});
    const before=x.store.getTask(initial.id);
    const input={message:'Implement on this task',expectedRevision:before.revision,commandId:'start-original'};
    const first=await x.runtime.startTask(initial.id,input,true);
    assert.deepEqual(first,{taskId:initial.id,status:'running'});
    assert.deepEqual(await x.runtime.startTask(initial.id,input,true),first);
    assert.deepEqual(x.counts(),{sessionCalls:1,sendCalls:1});
    const after=x.store.getTask(initial.id);
    assert.equal(x.store.tasks(x.project.id).length,1);
    assert.equal(after.id,initial.id);
    assert.deepEqual(after.criteria,before.criteria);
    assert.deepEqual(after.evidence,before.evidence);
    assert.equal(after.goal,before.goal);
    assert.equal(after.conversationId,'private-thread');
    await assert.rejects(x.runtime.startTask(initial.id,{...input,message:'different'},true),/commandId/);
  }finally{x.store.close();}
});

test('startTask keeps a confirmed session with unknown first turn fenced from resends',async()=>{
  const x=await setup({resumeStatus:'unknown'});try{
    const task=x.store.createTask({projectId:x.project.id,title:'Original'});
    const input={message:'Do work',expectedRevision:task.revision,commandId:'start-unknown'};
    assert.deepEqual(await x.runtime.startTask(task.id,input,true),{taskId:task.id,status:'unknown'});
    assert.equal(x.store.getTask(task.id).conversationId,'private-thread');
    assert.deepEqual(await x.runtime.startTask(task.id,input,true),{taskId:task.id,status:'unknown'});
    assert.deepEqual(x.counts(),{sessionCalls:1,sendCalls:1});
  }finally{x.store.close();}
});

test('remote conversation access stays within selected projects', async () => {
  const x = await setup();
  try {
    await assert.rejects(x.runtime.create({ projectId: x.other.id, title: 'No', message: 'No', commandId: 'other' }, true), /未授权/);
    const task = x.store.createTask({ projectId: x.other.id, title: 'Other', goal: 'Elsewhere' });
    await assert.rejects(x.runtime.get(task.id, true), /未授权/);
    await assert.rejects(x.runtime.message(task.id, { message: 'Hi', expectedRevision: task.revision, commandId: 'm' }, true), /未授权/);
    assert.deepEqual(x.runtime.getMany([x.project.id], [task.id]), []);
  } finally { x.store.close(); }
});

test('bound task message uses revision and command ID, then exposes bounded transcript', async () => {
  const x = await setup();
  try {
    const task = x.store.createTask({ projectId: x.project.id, title: 'Existing', goal: 'Continue', conversationId: 'private-thread' });
    const input = { message: 'Please continue', expectedRevision: task.revision, commandId: 'message-1' };
    assert.equal((await x.runtime.message(task.id, input, true)).status, 'running');
    assert.equal((await x.runtime.message(task.id, input, true)).status, 'running');
    assert.equal(x.counts().sendCalls, 1);
    const conversation = await x.runtime.get(task.id, true);
    assert.deepEqual(conversation.messages.map(message => message.text), ['Public progress']);
    assert.equal('threadId' in conversation, false);
    assert.equal(x.runtime.getMany([x.project.id], [task.id]).length, 1);
  } finally { x.store.close(); }
});

test('Codex transcript includes public progress and tool output but excludes reasoning and paths', () => {
  const task = { id: 'task-id', conversationId: 'secret-thread-id', status: 'running', updatedAt: '2026-01-01T00:00:00Z' };
  const thread = { turns: [{ id: 'secret-turn-id', items: [
    { type: 'userMessage', content: [{ type: 'text', text: 'Please edit' }] },
    { type: 'reasoning', text: 'private chain of thought' },
    { type: 'agentMessage', text: 'Editing /Users/person/code/file.js' },
    { type: 'commandExecution', command: 'cat /tmp/private.log', aggregatedOutput: 'public output' },
    { type: 'fileChange', changes: [{ path: '/tmp/private.log' }] },
  ] }] };
  const result = publicConversation(task, thread, {});
  assert.deepEqual(result.messages.map(item => item.role), ['user', 'assistant', 'tool', 'tool']);
  assert.equal(JSON.stringify(result).includes('private chain of thought'), false);
  assert.equal(JSON.stringify(result).includes('/Users/person'), false);
  assert.equal(JSON.stringify(result).includes('/tmp/private.log'), false);
  assert.equal(JSON.stringify(result).includes('secret-thread-id'), false);
  assert.equal(JSON.stringify(result).includes('secret-turn-id'), false);
  assert.ok(result.messages.some(item => item.text.includes('public output')));
});

test('public deltas stream within one owned turn and merge without duplicate text', () => {
  const cache = createPublicDeltaCache();
  const commands = { owned: { taskId: 'task-1', threadId: 'thread-1', turnId: 'turn-1', status: 'running', displayText: 'Continue' } };
  const event = (method, itemId, delta, threadId = 'thread-1') => ({ method, params: { threadId, turnId: 'turn-1', itemId, delta } });
  assert.equal(cache.add(event('item/agentMessage/delta', 'agent-1', 'Hello '), commands), true);
  assert.equal(cache.add(event('item/agentMessage/delta', 'agent-1', 'world'), commands), true);
  assert.equal(cache.add(event('item/commandExecution/outputDelta', 'cmd-1', 'passed'), commands), true);
  assert.equal(cache.add(event('item/reasoning/textDelta', 'secret', 'PRIVATE_REASONING'), commands), false);
  assert.equal(cache.add(event('item/agentMessage/delta', 'agent-2', 'foreign', 'other-thread'), commands), false);
  const task = { id: 'task-1', conversationId: 'thread-1', status: 'running' };
  const partial = { status: { type: 'active' }, turns: [{ id: 'turn-1', status: 'inProgress', items: [
    { id: 'agent-1', type: 'agentMessage', text: 'Hello ' },
    { id: 'cmd-1', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'pas' },
  ] }] };
  const streamed = publicConversation(task, partial, commands, cache.forTask(task));
  assert.deepEqual(streamed.messages.map(item => item.text), ['Continue', 'Hello world', 'npm test\npassed']);
  assert.equal(JSON.stringify(streamed).includes('PRIVATE_REASONING'), false);
  const completed = publicConversation(task, { status: { type: 'idle' }, turns: [{ id: 'turn-1', status: 'completed', items: [
    { id: 'agent-1', type: 'agentMessage', text: 'Hello world' },
    { id: 'cmd-1', type: 'commandExecution', command: 'npm test', aggregatedOutput: 'passed' },
  ] }] }, commands, cache.forTask(task));
  assert.deepEqual(completed.messages.map(item => item.text), ['Continue', 'Hello world', 'npm test\npassed']);
});

test('public delta cache is bounded and masks assembled local paths', () => {
  const cache = createPublicDeltaCache();
  const commands = { owned: { taskId: 'task-1', threadId: 'thread-1', turnId: 'turn-1', status: 'running' } };
  const add = (itemId, delta) => cache.add({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', turnId: 'turn-1', itemId, delta } }, commands);
  assert.equal(add('agent', 'Open /Users/'), true);
  assert.equal(add('agent', 'person/private/file.js'), true);
  const task = { id: 'task-1', conversationId: 'thread-1', status: 'running' };
  const pathSnapshot = publicConversation(task, { status: { type: 'active' }, turns: [{ id: 'turn-1', status: 'inProgress', items: [] }] }, commands, cache.forTask(task));
  assert.equal(JSON.stringify(pathSnapshot).includes('/Users/person/private'), false);
  assert.equal(add('agent', 'a'.repeat(6000)), true);
  assert.equal(cache.forTask(task)[0].items.get('agent').text.length, 6000);
  for (let i = 0; i < 100; i++) add(`item-${i}`, 'x'.repeat(100));
  assert.ok(cache.forTask(task)[0].items.size <= 80);
  const message = publicConversation(task, { status: { type: 'active' }, turns: [{ id: 'turn-1', status: 'inProgress', items: [] }] }, commands, cache.forTask(task));
  assert.ok(message.messages.length <= 80);
  assert.equal(add('oversized', 'z'.repeat(6001)), false);
});
