import assert from 'node:assert/strict';
import {test} from 'node:test';
import {conversationStartGate,continueGate,freshConversationStartGate,freshTaskGate,messageGate,startTaskGate} from '../src/execution-write-gate.ts';

const bootId='123e4567-e89b-42d3-a456-426614174000';
const now=Date.parse('2026-10-24T12:00:00.000Z');
const observedAt=new Date(now).toISOString();
const ready={state:'ready',reasonCode:null};
const task={id:'task-a',projectId:'project-a',revision:3,contentVersion:2,
  executionWrite:{v:1,bootId,observedAt,taskRevision:3,contentVersion:2,message:ready,continue:ready}};
const project={id:'project-a',conversationStart:{v:1,bootId,observedAt,...ready}};

test('exact current gates enable message, continue and new conversation',()=>{
  assert.equal(messageGate(task,now).ready,true);
  assert.equal(continueGate(task,now).ready,true);
  assert.equal(conversationStartGate(project,now).ready,true);
});

test('unknown result and human control have distinct human reasons',()=>{
  const unknown={...task,executionWrite:{...task.executionWrite,message:{state:'unknown',reasonCode:'ACTIVE_EXECUTION'}}};
  const human={...task,executionWrite:{...task.executionWrite,message:{state:'blocked',reasonCode:'HUMAN_CONTROL'}}};
  const unavailable={...task,executionWrite:{...task.executionWrite,message:{state:'unknown',reasonCode:'CORE_UNAVAILABLE'}}};
  assert.match(messageGate(unknown,now).reason,/结果尚未确认/);
  assert.match(messageGate(human,now).reason,/人工处理/);
  assert.doesNotMatch(messageGate(unavailable,now).reason,/上次执行/);
  assert.equal(messageGate(unknown,now).ready,false);
});

test('missing, malformed, expired or future gates fail closed without changing drafts',()=>{
  for(const value of [undefined,{...task.executionWrite,bootId:'not-a-uuid'},
    {...task.executionWrite,observedAt:new Date(now-10_001).toISOString()},
    {...task.executionWrite,observedAt:new Date(now+2_001).toISOString()},
    {...task.executionWrite,message:{state:'ready',reasonCode:'ACTIVE_EXECUTION'}}]){
    assert.equal(messageGate({...task,executionWrite:value},now).ready,false);
  }
  assert.equal(messageGate({...task,revision:4},now).ready,false);
  assert.equal(messageGate({...task,contentVersion:3},now).ready,false);
  assert.equal(conversationStartGate({...project,conversationStart:undefined},now).ready,false);
  assert.equal(conversationStartGate({...project,conversationStart:{...project.conversationStart,observedAt:new Date(now-10_001).toISOString()}},now).ready,false);
});

test('the action gates are independent and do not imply permission',()=>{
  const partial={...task,executionWrite:{...task.executionWrite,continue:{state:'blocked',reasonCode:'WORKSPACE_BUSY'}}};
  assert.equal(messageGate(partial,now).ready,true);
  assert.equal(continueGate(partial,now).ready,false);
  assert.equal(conversationStartGate({...project,conversationStart:{...project.conversationStart,state:'unknown',reasonCode:'SOURCE_CHANGED'}},now).ready,false);
});

test('starting an existing task requires current start capability and an exact planned unbound Codex task',()=>{
  const planned={...task,status:'planned',conversationId:'',hasExecutionBinding:false,
    executionWrite:{...task.executionWrite,start:ready}};
  const hub={connection:{mode:'hub'},capabilities:{taskStart:true}};
  assert.equal(startTaskGate(planned,hub,now).ready,true);
  assert.match(startTaskGate(planned,{...hub,capabilities:{}},now).reason,/暂不支持启动已有任务/);
  assert.equal(startTaskGate({...planned,status:'running'},hub,now).ready,false);
  assert.equal(startTaskGate({...planned,hasExecutionBinding:true},hub,now).ready,false);
  assert.equal(startTaskGate({...planned,executionProvider:'claude-code'},hub,now).ready,false);
  assert.equal(startTaskGate({...planned,executionWrite:{...planned.executionWrite,start:{state:'blocked',reasonCode:'ACTIVE_EXECUTION'}}},hub,now).ready,false);
  assert.equal(freshTaskGate(planned,bootId,{...hub,projects:[project],tasks:[planned]},'start',now).ready,true);
  assert.equal(freshTaskGate(planned,bootId,{...hub,projects:[project],tasks:[{...planned,revision:4}]},'start',now).ready,false);
});

test('fresh state read before mutation must retain exact task, revision, project and boot',()=>{
  const board={projects:[project],tasks:[task]};
  assert.equal(freshTaskGate(task,bootId,board,'message',now).ready,true);
  assert.equal(freshTaskGate(task,bootId,board,'continue',now).ready,true);
  assert.equal(freshConversationStartGate(project,bootId,board,now).ready,true);
  assert.equal(freshTaskGate(task,bootId,{...board,projects:[]},'message',now).ready,false);
  assert.equal(freshTaskGate(task,bootId,{...board,tasks:[{...task,id:'task-b'}]},'message',now).ready,false);
  assert.equal(freshTaskGate(task,bootId,{...board,tasks:[{...task,revision:4}]},'message',now).ready,false);
  assert.equal(freshTaskGate(task,bootId,{...board,tasks:[{...task,contentVersion:3}]},'message',now).ready,false);
  assert.equal(freshTaskGate(task,bootId,{...board,tasks:[{...task,executionWrite:{...task.executionWrite,bootId:'223e4567-e89b-42d3-a456-426614174000'}}]},'message',now).ready,false);
  assert.equal(freshConversationStartGate(project,bootId,{...board,projects:[{...project,conversationStart:{...project.conversationStart,bootId:'223e4567-e89b-42d3-a456-426614174000'}}]},now).ready,false);
  assert.equal(freshTaskGate(task,bootId,{...board,tasks:[{...task,executionWrite:{...task.executionWrite,message:{state:'unknown',reasonCode:'ACTIVE_EXECUTION'}}}]},'message',now).ready,false);
});
