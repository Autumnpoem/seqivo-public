import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createExecutionLeases } from '../server/execution-leases.mjs';
import { createExecutionWriteGate } from '../server/execution-write-gate.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'seqivo-write-gate-'));
  const workspace=join(root,'workspace'),otherWorkspace=join(root,'other');
  await mkdir(workspace);await mkdir(otherWorkspace);
  const store=new Store(join(root,'board.sqlite'));
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const project=store.project({name:'First',directory:workspace});
  const other=store.project({name:'Other',directory:otherWorkspace});
  const task=store.createTask({projectId:project.id,title:'Bound',conversationId:'thread-bound',executionProvider:'codex-autocontinue'});
  const second=store.createTask({projectId:project.id,title:'Second',conversationId:'thread-second',executionProvider:'codex-autocontinue'});
  const otherTask=store.createTask({projectId:other.id,title:'Other task',conversationId:'thread-other',executionProvider:'codex-autocontinue'});
  const leases=createExecutionLeases({store,inspect:async()=>({status:'unknown'})});
  let human=false,terminalBusy=false;
  const gate=createExecutionWriteGate({leases,bootId:'boot-1',now:()=>Date.parse('2026-10-24T00:00:00.000Z'),isClosing:()=>false,
    control:{assertMayStart:()=>{if(human)throw Object.assign(new Error('private'),{code:'CONTROL_BUSY'});}},
    terminal:{assertManagedReady:()=>{},blocksProject:()=>terminalBusy},
    worktrees:{assertMayExecute:()=>{}},workflow:{state:()=>({plans:[]})},
    previewBuilds:()=>({assertNoUnfencedIntents:()=>{}})});
  return {store,project,other,task,second,otherTask,leases,gate,setHuman:value=>{human=value;},setTerminal:value=>{terminalBusy=value;}};
}

test('read-only gates are scoped to task/project and never project private execution identities',async t=>{
  const f=await fixture(t),stamp='2026-10-24T00:00:00.000Z';
  assert.deepEqual(f.gate.project(f.project,stamp),{v:1,bootId:'boot-1',observedAt:stamp,state:'ready',reasonCode:null});
  assert.equal(f.gate.task(f.task,f.project,stamp).message.state,'ready');
  f.leases.reserve({taskId:f.task.id,commandId:'original',provider:'codex-autocontinue'});
  assert.equal(f.gate.project(f.project,stamp).state,'blocked');
  assert.equal(f.gate.task(f.second,f.project,stamp).continue.reasonCode,'ACTIVE_EXECUTION');
  assert.equal(f.gate.project(f.other,stamp).state,'ready');
  assert.equal(f.gate.task(f.otherTask,f.other,stamp).message.state,'ready');
  assert.equal(JSON.stringify(f.gate.task(f.task,f.project,stamp)).includes(f.project.directory),false);
  assert.equal(JSON.stringify(f.gate.task(f.task,f.project,stamp)).includes('original'),false);
  await f.leases.reconcile();
  assert.equal(f.gate.task(f.second,f.project,stamp).message.state,'unknown');
});

test('human/terminal ownership and missing binding never appear ready',async t=>{
  const f=await fixture(t);
  f.setHuman(true);
  assert.deepEqual(f.gate.project(f.project),{v:1,bootId:'boot-1',observedAt:'2026-10-24T00:00:00.000Z',state:'blocked',reasonCode:'HUMAN_CONTROL'});
  f.setHuman(false);f.setTerminal(true);
  assert.equal(f.gate.project(f.project).reasonCode,'HUMAN_CONTROL');
  f.setTerminal(false);
  const unbound=f.store.createTask({projectId:f.project.id,title:'Unbound',executionProvider:'codex-autocontinue'});
  assert.equal(f.gate.task(unbound,f.project).message.reasonCode,'BINDING_UNAVAILABLE');
});

test('exact own ready startup is passed to existing continuation predicate',()=>{
  const own={taskId:'task-a',status:'startup',ready:true,worktreeId:'worktree-a'};
  const calls=[];
  const gate=createExecutionWriteGate({leases:{state:()=>({active:[own]}),workflowMayContinue:input=>{calls.push(input);return input.worktreeId==='worktree-a';},activeOverlaps:()=>[own]},
    bootId:'boot-1',isClosing:()=>false,control:{assertMayStart:()=>{}},terminal:{assertManagedReady:()=>{},blocksProject:()=>false},
    worktrees:{assertMayExecute:()=>{},binding:()=>({path:'/tmp/worktree-a'})},workflow:{state:()=>({plans:[]})},previewBuilds:()=>({assertNoUnfencedIntents:()=>{}})});
  const task={id:'task-a',projectId:'project-a',revision:2,contentVersion:1,conversationId:'thread-a',executionProvider:'codex-autocontinue'};
  const project={id:'project-a',directory:'/tmp'};
  assert.equal(gate.task(task,project).continue.state,'ready');
  assert.deepEqual(calls.map(call=>call.worktreeId),['worktree-a','worktree-a']);
});

test('known separate worktrees in one project do not block task writes, but uncertain or overlapping members do',()=>{
  const own={taskId:'task-a',projectId:'project-a',status:'startup',ready:true,worktreeId:'worktree-a'};
  const member={taskId:'task-b',workspace:'/tmp/seqivo-gate-worktree-b',worktreeId:'worktree-b',status:'running'};
  const plan={projectId:'project-a',members:[member]};
  const gate=createExecutionWriteGate({leases:{state:()=>({active:[own]}),workflowMayContinue:input=>input.worktreeId==='worktree-a',activeOverlaps:()=>[own]},
    bootId:'boot-1',isClosing:()=>false,control:{assertMayStart:()=>{}},terminal:{assertManagedReady:()=>{},blocksProject:()=>false},
    worktrees:{assertMayExecute:()=>{},binding:({id,taskId})=>{
      assert.equal(id,'worktree-a');assert.equal(taskId,'task-a');return {path:'/tmp/seqivo-gate-worktree-a'};
    }},workflow:{state:()=>({plans:[plan]})},previewBuilds:()=>({assertNoUnfencedIntents:()=>{}})});
  const task={id:'task-a',projectId:'project-a',revision:2,contentVersion:1,conversationId:'thread-a',executionProvider:'codex-autocontinue'};
  const project={id:'project-a',directory:'/tmp/seqivo-gate-project'};
  assert.equal(gate.task(task,project).message.state,'ready');
  assert.equal(gate.project(project).state,'blocked','new conversations still target the project workspace');
  member.workspace='/tmp/seqivo-gate-worktree-a/nested';
  assert.equal(gate.task(task,project).message.state,'blocked');
  member.workspace='/tmp/seqivo-gate-worktree-b';member.worktreeId=null;
  assert.notEqual(gate.task(task,project).message.state,'ready');
  member.worktreeId='worktree-b';member.workspace=undefined;
  assert.notEqual(gate.task(task,project).message.state,'ready');
  member.workspace='/tmp/seqivo-gate-worktree-b';member.taskId='task-a';
  assert.notEqual(gate.task(task,project).message.state,'ready');
});
