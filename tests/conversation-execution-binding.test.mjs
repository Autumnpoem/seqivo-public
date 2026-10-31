import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {createConversations} from '../server/conversations.mjs';

test('durable conversation journal binds the exact original task, thread and local turn',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seqivo-command-binding-')),store=new Store(join(root,'board.sqlite'));
  const project=store.project({name:'Disposable',directory:root});
  const task=store.createTask({projectId:project.id,title:'Original'});
  let conversations;
  t.after(async()=>{await conversations?.close();store.close();await rm(root,{recursive:true,force:true});});
  const plugin={createSession:async input=>{
    store.updateTask(input.taskId,{conversationId:'thread-original'},input.expectedRevision);
    return {...input,status:'created',threadId:'thread-original'};
  },resume:async input=>{
    // The original mapping must exist before the provider can be sent a turn.
    assert.equal(conversations.executionBinding('root').localCommandId,input.commandId);
    return {taskId:input.taskId,status:'running'};
  }};
  conversations=createConversations({store,plugin});
  assert.equal(conversations.executionBinding('root'),null);
  await conversations.startTask(task.id,{commandId:'root',expectedRevision:task.revision,message:'Do work'});
  assert.deepEqual(conversations.executionBinding('root'),{action:'start_task',projectId:project.id,taskId:task.id,
    localCommandId:'root:turn',threadId:'thread-original'});
  assert.equal(conversations.executionBinding('other-root'),null);
  const key='conversation.command.v1.root';
  const old=JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key).value);
  delete old.executionBinding;
  store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(old),key);
  assert.equal(conversations.executionBinding('root').threadId,'thread-original','legacy start journal retains a strong exact binding');
  delete old.sessionThreadId;
  store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(old),key);
  assert.equal(conversations.executionBinding('root'),null,'local suffix and task ID alone are not authority');
});
