import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {createExecutionLeases} from '../server/execution-leases.mjs';
import {createWorkflow} from '../server/workflow.mjs';

const provider='fake';
const recordId='a'.repeat(32);

async function fixture(t,{worktree=false}={}){
  const dir=await realpath(await mkdtemp(join(tmpdir(),'workflow-startup-ready-')));
  const store=new Store(join(dir,'board.sqlite'));
  t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true});});
  const project=store.project({name:'Isolated readiness',directory:dir});
  const task=store.createTask({projectId:project.id,title:'Worker',executionProvider:provider});
  const a=join(dir,'tree-a'),b=join(dir,'tree-b');
  if(worktree){await mkdir(a);await mkdir(b);}
  let fence=false;
  const leases=createExecutionLeases({store,inspect:async()=>({status:'unknown'}),
    beforeReserve:()=>{if(fence)throw Error('human control');},
    resolveWorktree:({worktreeId})=>worktreeId==='tree-a'?a:worktreeId==='tree-b'?b:null});
  const workspace=worktree?a:dir,worktreeId=worktree?'tree-a':null;
  const startup={taskId:task.id,startupId:'startup-1',provider,workspace,worktreeId,
    purpose:'session',expectedRevision:task.revision,expectedHandoffGeneration:null};
  const hint=()=>leases.workflowMayContinue({taskId:task.id,provider,workspace,worktreeId});
  const bind=()=>{
    leases.reserveStartup(startup);
    leases.bindStartup({...startup,recordId});
    leases.confirmStartup({...startup,recordId});
    const updated=store.updateTask(task.id,{conversationId:'thread-worker'},task.revision);
    leases.bindStartupConversation({...startup,recordId,threadId:updated.conversationId});
    return updated;
  };
  return {dir,store,project,task,leases,startup,workspace,worktreeId,hint,bind,
    setFence:value=>{fence=value;},a,b};
}

test('confirmed own startup is only a workflow hint; exact reserve still owns the send',async t=>{
  const f=await fixture(t);
  assert.equal(f.hint(),false,'unbound task cannot continue');
  const task=f.bind();
  assert.equal(f.leases.available({taskId:task.id,workspace:f.workspace}),false,'generic availability remains strict');
  assert.equal(f.hint(),true);
  assert.throws(()=>f.leases.reserve({taskId:task.id,commandId:'wrong-startup',provider,
    workspace:f.workspace,startupId:'different-startup',recordId}),{code:'EXECUTION_COMMAND_CONFLICT'});
  assert.throws(()=>f.leases.reserve({taskId:task.id,commandId:'wrong-record',provider,
    workspace:f.workspace,startupId:f.startup.startupId,recordId:'b'.repeat(32)}),
  {code:'EXECUTION_COMMAND_CONFLICT'});
  let starts=0;
  const workflow=createWorkflow({store:f.store,executors:new Map([[provider,{
    canStart:input=>f.leases.workflowMayContinue({...input,provider}),
    start:async input=>{starts++;const reservation=f.leases.reserve({taskId:input.taskId,commandId:input.commandId,
      provider,workspace:input.workspace,startupId:f.startup.startupId,recordId});
      assert.equal(reservation.maySend,true);return {status:'running'};},
    pause:async()=>({status:'unknown'}),inspect:async()=>({status:'running'}),
  }]])});
  const plan=await workflow.createPlan({projectId:f.project.id,maxConcurrent:1,maxStarts:1,budgetMinutes:2,
    members:[{taskId:task.id,provider,role:'worker'}]});
  await workflow.start(plan.id);
  assert.equal(starts,1);
  assert.equal(workflow.state().plans[0].members[0].status,'running');
  assert.equal(f.hint(),false,'reserved command is never treated as own idle startup');
  assert.equal(f.leases.available({taskId:task.id,workspace:f.workspace}),false);
  assert.throws(()=>f.leases.reserve({taskId:task.id,commandId:'second',provider,
    startupId:f.startup.startupId,recordId}),{code:'EXECUTION_BUSY'});
  await workflow.close();
});

test('pre-bind, unconfirmed, wrong provider, changed conversation, and control fence never receive a hint',async t=>{
  const f=await fixture(t);
  f.leases.reserveStartup(f.startup);
  assert.equal(f.hint(),false);
  f.leases.bindStartup({...f.startup,recordId});
  assert.equal(f.hint(),false);
  f.leases.confirmStartup({...f.startup,recordId});
  assert.equal(f.hint(),false,'session-purpose startup is not a turn continuation');
  const bound=f.store.updateTask(f.task.id,{conversationId:'thread-worker'},f.task.revision);
  f.leases.bindStartupConversation({...f.startup,recordId,threadId:bound.conversationId});
  assert.equal(f.hint(),true);
  assert.equal(f.leases.workflowMayContinue({taskId:bound.id,provider:'other',workspace:f.workspace}),false);
  f.setFence(true);assert.equal(f.hint(),false);f.setFence(false);
  f.store.updateTask(bound.id,{conversationId:'thread-replaced'},bound.revision);
  assert.equal(f.hint(),false,'old startup cannot follow a new conversation');
  assert.equal(f.leases.available({taskId:bound.id,workspace:f.workspace}),false);
});

test('existing conversation startup records its thread transactionally and remains continuable after settled command',async t=>{
  const f=await fixture(t);
  const bound=f.store.updateTask(f.task.id,{conversationId:'thread-existing'},f.task.revision);
  const startup={...f.startup,purpose:'turn',expectedRevision:bound.revision};
  f.leases.reserveStartup(startup);
  f.leases.bindStartup({...startup,recordId});
  f.leases.confirmStartup({...startup,recordId});
  assert.equal(f.leases.startupFor({...startup,recordId}).conversationId,bound.conversationId);
  assert.equal(f.leases.state().active[0].conversationId,undefined,'public lease state does not expose thread identity');
  assert.equal(f.hint(),true);
  const command={taskId:bound.id,commandId:'turn-one',provider,workspace:f.workspace,
    startupId:startup.startupId,recordId};
  assert.equal(f.leases.reserve(command).maySend,true);
  assert.equal(f.hint(),false);
  f.leases.releaseConfirmed({...command,status:'completed'});
  assert.equal(f.hint(),true,'settled command returns to its exact ready startup');
  f.store.updateTask(bound.id,{goal:'Next iteration'},bound.revision);
  assert.equal(f.hint(),true,'task revision advances do not replace the bound conversation');
  const image=JSON.parse(f.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('execution.leases.v1').value);
  delete image.reservations[0].conversationId;
  f.store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(image),'execution.leases.v1');
  assert.equal(f.hint(),false,'legacy missing thread binding is unknown, not inferred');
});

test('two disjoint worktree startups may continue but other overlapping or corrupt leases block',async t=>{
  const f=await fixture(t,{worktree:true});
  const bound=f.bind();
  const other=f.store.createTask({projectId:f.project.id,title:'Other',conversationId:'thread-other',executionProvider:provider});
  f.leases.reserve({taskId:other.id,commandId:'other',provider,workspace:f.b,worktreeId:'tree-b'});
  assert.equal(f.hint(),true,'a disjoint worktree does not serialize the project');
  assert.equal(f.leases.workflowMayContinue({taskId:bound.id,provider,workspace:f.b,worktreeId:'tree-a'}),false);
  assert.equal(f.leases.workflowMayContinue({taskId:bound.id,provider,workspace:f.a,worktreeId:'tree-b'}),false);
  const image=JSON.parse(f.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('execution.leases.v1').value);
  image.reservations.push({taskId:'foreign',projectId:f.project.id,provider,commandId:'foreign',status:'unknown',
    workspace:f.dir,worktreeId:null});
  f.store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(image),'execution.leases.v1');
  assert.equal(f.hint(),false,'overlapping persisted unknown is not ignored');
  image.reservations.at(-1).workspace=null;
  f.store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(image),'execution.leases.v1');
  assert.equal(f.hint(),false,'missing original workspace is not proof of disjointness');
});

test('workflow revision check still prevents stale task from consuming a startup hint',async t=>{
  const f=await fixture(t);
  const bound=f.bind();
  let starts=0;
  const workflow=createWorkflow({store:f.store,executors:new Map([[provider,{
    canStart:input=>f.leases.workflowMayContinue({...input,provider}),
    start:async()=>{starts++;return {status:'running'};},
    pause:async()=>({status:'unknown'}),inspect:async()=>({status:'running'}),
  }]])});
  const plan=await workflow.createPlan({projectId:f.project.id,maxConcurrent:1,maxStarts:1,budgetMinutes:2,
    members:[{taskId:bound.id,provider,role:'worker'}]});
  f.store.updateTask(bound.id,{goal:'Changed after plan creation'},bound.revision);
  assert.equal(f.hint(),true,'hint alone does not grant a send');
  await workflow.start(plan.id);
  assert.equal(starts,0);
  assert.equal(workflow.state().plans[0].members[0].status,'pending');
  await workflow.close();
});
