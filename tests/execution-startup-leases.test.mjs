import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createExecutionLeases } from '../server/execution-leases.mjs';

const recordId='a'.repeat(32);
async function fixture(t, inspected={status:'not_started'}) {
  const directory=await realpath(await mkdtemp(join(tmpdir(),'seqivo-startup-lease-')));
  const store=new Store(join(directory,'board.sqlite'));
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const project=store.project({name:'Startup',directory});
  const task=store.createTask({projectId:project.id,title:'Session',executionProvider:'codex-autocontinue'});
  const other=store.createTask({projectId:project.id,title:'Other',conversationId:'thread-other',executionProvider:'codex-autocontinue'});
  const leases=createExecutionLeases({store,inspect:async()=>inspected});
  return {directory,store,project,task,other,leases};
}

test('session startup is the durable active lease before conversation binding; not_started cannot release it',async t=>{
  const f=await fixture(t);
  const input={taskId:f.task.id,startupId:'startup-one',provider:'codex-autocontinue',workspace:f.directory,
    worktreeId:null,purpose:'session',expectedRevision:f.task.revision,expectedHandoffGeneration:4};
  f.leases.reserveStartup(input);
  assert.equal(f.leases.state().active[0].status,'startup');
  assert.equal(f.leases.available({taskId:f.other.id,workspace:f.directory}),false);
  assert.deepEqual(await f.leases.reconcile(),{inspected:0,released:0,active:1});
  assert.throws(()=>f.leases.releaseConfirmed({taskId:f.task.id,commandId:input.startupId,status:'not_started'}),
    {code:'EXECUTION_UNCONFIRMED'});
  assert.throws(()=>f.leases.reserveStartup({...input,startupId:'startup-two'}),{code:'EXECUTION_BUSY'});
  f.leases.bindStartup({...input,recordId});
  assert.equal(f.leases.startupFor({...input,recordId}).recordId,recordId);
  assert.throws(()=>f.leases.bindStartup({...input,recordId:'b'.repeat(32)}),
    {code:'EXECUTION_NOT_FOUND'});
  f.leases.confirmStartup({...input,recordId});
  assert.equal(f.leases.startupFor({...input,recordId}).ready,true);
  f.store.updateTask(f.task.id,{conversationId:'thread-original'},f.task.revision);
  assert.throws(()=>f.leases.bindStartupConversation({...input,recordId,threadId:'thread-replacement'}),
    {code:'EXECUTION_BINDING_CHANGED'});
  f.leases.bindStartupConversation({...input,recordId,threadId:'thread-original'});
  assert.equal(f.leases.startupFor({...input,recordId}).purpose,'turn');
  f.leases.retireStartup({...input,recordId});
  assert.equal(f.leases.available({taskId:f.other.id,workspace:f.directory}),true);
});

test('a pre-intent startup remains fenced after recreating the lease manager',async t=>{
  const f=await fixture(t);
  const input={taskId:f.task.id,startupId:'startup-no-record',provider:'codex-autocontinue',
    workspace:f.directory,worktreeId:null,purpose:'session',expectedRevision:f.task.revision,
    expectedHandoffGeneration:null};
  f.leases.reserveStartup(input);
  const reopened=createExecutionLeases({store:f.store,inspect:async()=>({status:'not_started'})});
  assert.equal(reopened.startupFor(input).recordId,null);
  assert.deepEqual(await reopened.reconcile(),{inspected:0,released:0,active:1});
  assert.equal(reopened.available({taskId:f.other.id,workspace:f.directory}),false);
  assert.throws(()=>reopened.releaseConfirmed({taskId:f.task.id,
    commandId:input.startupId,status:'not_started'}),{code:'EXECUTION_UNCONFIRMED'});
});

test('one startup row upgrades for turns and returns to startup only after confirmed command outcome',async t=>{
  const f=await fixture(t,{status:'completed'});
  f.store.updateTask(f.task.id,{conversationId:'thread-session'},f.task.revision);
  const latest=f.store.getTask(f.task.id);
  const startup={taskId:latest.id,startupId:'startup-three',provider:'codex-autocontinue',workspace:f.directory,
    worktreeId:null,purpose:'turn',expectedRevision:latest.revision,expectedHandoffGeneration:7};
  f.leases.reserveStartup(startup);
  f.leases.bindStartup({...startup,recordId});
  f.leases.confirmStartup({...startup,recordId});
  assert.throws(()=>f.leases.reserve({taskId:latest.id,commandId:'turn-one',provider:'codex-autocontinue'}),
    {code:'EXECUTION_COMMAND_CONFLICT'});
  const turn={taskId:latest.id,commandId:'turn-one',provider:'codex-autocontinue',workspace:f.directory,
    worktreeId:null,startupId:startup.startupId,recordId};
  assert.equal(f.leases.reserve(turn).maySend,true);
  assert.equal(f.leases.state().active[0].status,'reserved');
  assert.throws(()=>f.leases.reserve({...turn,commandId:'turn-two'}),{code:'EXECUTION_BUSY'});
  assert.deepEqual(await f.leases.reconcile(),{inspected:1,released:1,active:1});
  assert.equal(f.leases.state().active[0].status,'startup');
  assert.throws(()=>f.leases.reserve(turn),{code:'EXECUTION_COMMAND_CONFLICT'});
  assert.equal(f.leases.reserve({...turn,commandId:'turn-two'}).maySend,true);
  f.leases.releaseConfirmed({taskId:latest.id,commandId:'turn-two',status:'completed'});
  assert.equal(f.leases.state().active[0].status,'startup');
  f.leases.retireStartup({...startup,recordId});
  assert.equal(f.leases.state().active.length,0);
});

test('original job retirement atomically closes only an exactly settled active command',async t=>{
  const f=await fixture(t);
  f.store.updateTask(f.task.id,{conversationId:'thread-a'},f.task.revision);
  const task=f.store.getTask(f.task.id);
  const startup={taskId:task.id,startupId:'startup-four',provider:'codex-autocontinue',
    workspace:f.directory,worktreeId:null,purpose:'turn',expectedRevision:task.revision,
    expectedHandoffGeneration:null};
  f.leases.reserveStartup(startup);
  f.leases.bindStartup({...startup,recordId});
  f.leases.confirmStartup({...startup,recordId});
  f.leases.reserve({taskId:task.id,commandId:'command-one',provider:'codex-autocontinue',
    workspace:f.directory,worktreeId:null,startupId:startup.startupId,recordId});
  assert.throws(()=>f.leases.retireStartup({...startup,recordId,settledCommandId:'other',settledStatus:'completed'}),
    {code:'EXECUTION_UNCONFIRMED'});
  assert.equal(f.leases.state().active.length,1);
  f.leases.retireStartup({...startup,recordId,settledCommandId:'command-one',settledStatus:'completed'});
  assert.equal(f.leases.state().active.length,0);
  assert.throws(()=>f.leases.reserve({taskId:task.id,commandId:'command-one',provider:'codex-autocontinue'}),
    {code:'EXECUTION_COMMAND_CONFLICT'});
});

test('verified shutdown keeps an in-flight original turn unknown and blocks generic release and replay',async t=>{
  const f=await fixture(t,{status:'completed'});
  f.store.updateTask(f.task.id,{conversationId:'thread-shutdown'},f.task.revision);
  const task=f.store.getTask(f.task.id);
  const startup={taskId:task.id,startupId:'startup-shutdown',provider:'codex-autocontinue',
    workspace:f.directory,worktreeId:null,purpose:'turn',expectedRevision:task.revision,
    expectedHandoffGeneration:null};
  f.leases.reserveStartup(startup);
  f.leases.bindStartup({...startup,recordId});
  f.leases.confirmStartup({...startup,recordId});
  const commandId='turn-shutdown';
  f.leases.reserve({taskId:task.id,commandId,provider:startup.provider,
    workspace:f.directory,worktreeId:null,startupId:startup.startupId,recordId});
  const receipt={version:1,taskId:task.id,projectId:task.projectId,
    startupId:startup.startupId,recordId,commandId,threadId:task.conversationId,
    turnId:'turn-original',bridgePid:4321,workspace:f.directory,worktreeId:null,
    expectedHandoffGeneration:null,recordGeneration:5,
    proofScope:'macos-original-task-job-coalition-known-descendants-and-current-writers'};
  assert.throws(()=>f.leases.markShutdownStoppedUnknown({...startup,recordId,
    receipt:{...receipt,recordId:'b'.repeat(32)}}),{code:'EXECUTION_STARTUP_UNKNOWN'});
  assert.throws(()=>f.leases.markShutdownStoppedUnknown({...startup,recordId,
    receipt:{...receipt,commandId:'another-command'}}),{code:'EXECUTION_STARTUP_UNKNOWN'});
  const result=f.leases.markShutdownStoppedUnknown({...startup,recordId,receipt});
  assert.equal(result.status,'unknown');
  assert.equal(result.shutdownStoppedReceipt,undefined);
  assert.equal(f.leases.markShutdownStoppedUnknown({...startup,recordId,receipt}).status,'unknown');
  assert.deepEqual(await f.leases.reconcile(),{inspected:0,released:0,active:1});
  assert.equal(f.leases.available({taskId:f.other.id,workspace:f.directory}),false);
  assert.equal(f.leases.workflowMayContinue({taskId:task.id,provider:startup.provider,
    workspace:f.directory}),false);
  assert.throws(()=>f.leases.releaseConfirmed({taskId:task.id,commandId,status:'completed'}),
    {code:'EXECUTION_UNCONFIRMED'});
  assert.throws(()=>f.leases.retireStartup({...startup,recordId,settledCommandId:commandId,
    settledStatus:'completed'}),{code:'EXECUTION_UNCONFIRMED'});
  assert.throws(()=>f.leases.reserve({taskId:task.id,commandId:'new-turn',provider:startup.provider,
    workspace:f.directory,worktreeId:null,startupId:startup.startupId,recordId}),
  {code:'EXECUTION_BUSY'});
});

test('a retired startup receipt is idempotent only for its exact original job and command',async t=>{
  const f=await fixture(t);
  f.store.updateTask(f.task.id,{conversationId:'thread-a'},f.task.revision);
  const task=f.store.getTask(f.task.id);
  const startup={taskId:task.id,startupId:'startup-retire-retry',provider:'codex-autocontinue',
    workspace:f.directory,worktreeId:null,purpose:'turn',expectedRevision:task.revision,
    expectedHandoffGeneration:null};
  f.leases.reserveStartup(startup);
  f.leases.bindStartup({...startup,recordId});
  f.leases.confirmStartup({...startup,recordId});
  f.leases.reserve({taskId:task.id,commandId:'turn-to-pause',provider:startup.provider,
    workspace:f.directory,worktreeId:null,startupId:startup.startupId,recordId});
  const retirement={...startup,recordId,settledCommandId:'turn-to-pause',settledStatus:'paused'};
  const publicRetirement=f.leases.retireStartup(retirement);
  assert.equal(publicRetirement.retirementReceipt,undefined);
  assert.equal(publicRetirement.workspace,undefined);
  assert.equal(publicRetirement.recordId,undefined);
  const stored=()=>f.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('execution.leases.v1').value;
  const original=stored();
  const reopened=createExecutionLeases({store:f.store,inspect:async()=>({status:'unknown'})});
  assert.equal(reopened.retiredStartupFor(retirement).retirementReceipt.commandId,'turn-to-pause');
  assert.equal(reopened.state().recent[0].retirementReceipt,undefined);
  reopened.retireStartup(retirement);
  assert.equal(stored(),original,'exact retry must not mutate the durable ledger or repeat an event');
  assert.throws(()=>reopened.retireStartup({...retirement,settledStatus:'completed'}),
    {code:'EXECUTION_STARTUP_UNKNOWN'});
  assert.throws(()=>reopened.retireStartup({...retirement,recordId:'b'.repeat(32)}),
    {code:'EXECUTION_STARTUP_UNKNOWN'});
  reopened.reserveStartup({...startup,startupId:'new-job',expectedRevision:task.revision});
  assert.throws(()=>reopened.retiredStartupFor(retirement),{code:'EXECUTION_STARTUP_UNKNOWN'});
  assert.throws(()=>reopened.retireStartup(retirement),{code:'EXECUTION_STARTUP_UNKNOWN'});
});
