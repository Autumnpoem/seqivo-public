import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'tuijin-core-execution-'));
  const pluginDir=join(dir,'plugins'), extension=join(pluginDir,'fake');
  await mkdir(extension,{recursive:true});
  await writeFile(join(extension,'plugin.json'),JSON.stringify({id:'fake',name:'Fake execution',version:'1',apiVersion:1,entry:'host.mjs',permissions:['tasks.read','task.resume','task.pause'],capabilities:['task.resume','task.pause']}));
  await writeFile(join(extension,'host.mjs'),`export async function createPlugin(context){
    const executions=new Map();let starts=0;
    const state=()=>({enabled:false,available:true,starts});
    const resume=async input=>{await context.authorizeExecution(input);starts++;executions.set(input.commandId,{status:'running',taskId:input.taskId});return {status:'running'};};
    return {state,configure:async input=>input?.revalidate?context.revalidateExecution(input.revalidate):input?.send?resume(input.send):state(),enable:state,disable:state,close:async()=>{},resume,
      check:async input=>{if(input?.send)return resume(input.send);return state()},
      pause:async input=>{for(const e of executions.values())if(e.taskId===input.taskId)e.status='paused';return {status:'paused'}},
      getExecution:async input=>executions.get(input.commandId)||{status:'unknown'}};
  }`);
  let core=await createCore({dataDir:join(dir,'data'),pluginDir,files:false});
  t.after(async()=>{await core.close();await rm(dir,{recursive:true,force:true});});
  const project=core.store.project({name:'shared directory',directory:dir});
  const a=core.store.createTask({projectId:project.id,title:'Workflow task',conversationId:'thread-a',executionProvider:'fake'});
  const b=core.store.createTask({projectId:project.id,title:'Automatic task',conversationId:'thread-b',executionProvider:'fake'});
  return {get core(){return core;},project,a,b,restart:async()=>{await core.close();core=await createCore({dataDir:join(dir,'data'),pluginDir,files:false});}};
}
const planInput=f=>({projectId:f.project.id,members:[{taskId:f.a.id,role:'worker',provider:'fake'}],maxConcurrent:1,maxStarts:2,budgetMinutes:10});
const send=(core,task,commandId)=>core.request('POST',`/api/tasks/${task.id}/continue`,{expectedRevision:core.store.getTask(task.id).revision,commandId});
async function attemptTakeover(core, projectId, existing=false) {
  const profileId=`test_${projectId.replaceAll('-', '_')}`.slice(0,80);
  await core.request('POST','/api/terminal/profiles',{id:profileId,label:'Test',enabled:true,projectId});
  const ctx={local:true,profileId,connectionId:'test-connection'};
  const frames=[];const deliver=frame=>frames.push(frame);
  await core.terminal.frame(ctx,{type:'open',v:1,mode:'tmux',cols:80,rows:24},deliver);
  const serverName=(await core.request('GET','/api/terminal/status')).profiles.find(p=>p.id===profileId).serverName;
  await core.terminal.frame(ctx,existing?{type:'takeover-existing',v:1,sessionRefs:[{serverName,instanceId:'a'.repeat(64),sessionId:'$1'}]}:{type:'takeover',v:1},deliver);
  return frames.filter(frame=>frame.type==='control').at(-1);
}

test('isolated provider final permission compares current revision, binding and directory',async t=>{
  const f=await fixture(t);
  const baseline={taskId:f.a.id,commandId:'final-check',expectedRevision:f.a.revision,expectedConversationId:f.a.conversationId,expectedDirectory:f.project.directory};
  const check=value=>f.core.request('PATCH','/api/plugins/fake/config',{revalidate:value});
  await check(baseline);
  const unbound=f.core.store.createTask({projectId:f.project.id,title:'Unbound'});
  assert.equal(unbound.conversationId,'');
  await check({...baseline,taskId:unbound.id,expectedRevision:unbound.revision,expectedConversationId:null});
  await assert.rejects(check({...baseline,expectedRevision:baseline.expectedRevision+1}),/版本|更新/);
  await assert.rejects(check({...baseline,expectedConversationId:'other-thread'}),/会话已变更/);
  await assert.rejects(check({...baseline,expectedDirectory:'/changed-project'}),/目录已变更/);
  f.core.store.updateTask(f.a.id,{summary:'changed while waiting'},f.a.revision);
  await assert.rejects(check(baseline),/版本|更新/);
  assert.equal((await f.core.request('GET','/api/plugins')).find(p=>p.id==='fake').starts,0);
});

test('project context includes only returned handoff and final execution validates generation',async t=>{
  const f=await fixture(t);
  const handoff={projectId:f.project.id,workspace:f.project.directory,phase:'ai_ready',generation:4,since:'2026-10-17T00:00:00.000Z',
    snapshotScope:'git-tracked-and-nonignored-untracked',changes:[{path:'new.txt',kind:'added'}],notes:'Human changed the plan',token:'secret-must-not-leak'};
  const write=entry=>f.core.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('terminal.control.v1',JSON.stringify({version:1,entries:{[f.project.id]:entry}}));
  write(handoff);
  const context=f.core.store.context(f.project.id);
  assert.match(context,/Control generation: 4/);assert.match(context,/new\.txt/);
  assert.match(context,/Human changed the plan/);assert.doesNotMatch(context,/secret-must-not-leak/);
  const baseline={taskId:f.a.id,commandId:'handoff-check',expectedHandoffGeneration:4};
  const check=value=>f.core.request('PATCH','/api/plugins/fake/config',{revalidate:value});
  await check(baseline);
  write({...handoff,generation:5});
  await assert.rejects(check(baseline),/交还摘要已变更/);
  write({...handoff,phase:'human'});
  assert.doesNotMatch(f.core.store.context(f.project.id),/Human terminal handoff/);
  await assert.rejects(check({...baseline,expectedHandoffGeneration:5}),/人工接管/);
});

test('automatic plugin sends cannot bypass workflow or shared workspace leases',async t=>{
  const f=await fixture(t), plan=await f.core.workflow.createPlan(planInput(f));
  await f.core.workflow.start(plan.id);
  assert.equal(f.core.leases.state().active.length,1);
  await assert.rejects(f.core.request('PATCH','/api/plugins/fake/config',{send:{taskId:f.b.id,commandId:'auto'}}),/协作计划/);
  assert.equal((await f.core.request('GET','/api/plugins')).find(p=>p.id==='fake').starts,1);
  await f.core.workflow.pause(plan.id);await f.core.leases.reconcile();
  assert.equal(f.core.leases.state().active.length,0);
  await f.core.request('PATCH','/api/plugins/fake/config',{send:{taskId:f.b.id,commandId:'auto'}});
  await assert.rejects(send(f.core,f.a,'manual'),/租约/);
  assert.equal((await f.core.request('GET','/api/plugins')).find(p=>p.id==='fake').starts,2);
});

test('simultaneous manual and automatic starts allow only one external send; unknown persists after restart',async t=>{
  const f=await fixture(t);
  const results=await Promise.allSettled([send(f.core,f.a,'manual'),f.core.request('PATCH','/api/plugins/fake/config',{send:{taskId:f.b.id,commandId:'auto'}})]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal((await f.core.request('GET','/api/plugins')).find(p=>p.id==='fake').starts,1);
  const reserved=f.core.leases.state().active[0];
  await f.restart();await f.core.leases.reconcile();
  assert.equal(f.core.leases.state().active[0].status,'unknown');
  await assert.rejects(f.core.request('PATCH','/api/plugins/fake/config',{send:{taskId:reserved.taskId,commandId:reserved.commandId}}),/已取得过执行许可/);
  await assert.rejects(send(f.core,f.b,'new'),/租约/);
  await assert.rejects(f.core.request('POST','/api/maintenance/replay',{confirm:true}),/租约/);
  assert.equal((await f.core.request('GET','/api/plugins')).find(p=>p.id==='fake').starts,0);
});

test('workflow remains pending while automatic execution owns its workspace',async t=>{
  const f=await fixture(t);
  await f.core.request('PATCH','/api/plugins/fake/config',{send:{taskId:f.b.id,commandId:'auto'}});
  const plan=await f.core.workflow.createPlan(planInput(f));await f.core.workflow.start(plan.id);
  assert.equal(f.core.workflow.state().plans[0].members[0].status,'pending');
  await f.core.request('POST',`/api/tasks/${f.b.id}/pause`,{expectedRevision:f.b.revision});
  await f.core.leases.reconcile();await f.core.workflow.tick();
  assert.equal(f.core.workflow.state().plans[0].members[0].status,'running');
  assert.equal((await f.core.request('GET','/api/plugins')).find(p=>p.id==='fake').starts,2);
});

test('takeover of a nested project refuses an ancestor project active lease',async t=>{
  const f=await fixture(t);
  const nested=join(f.project.directory,'nested');await mkdir(nested);
  const child=f.core.store.project({name:'Nested',directory:nested});
  f.core.store.createTask({projectId:child.id,title:'Child',conversationId:'thread-child',executionProvider:'fake'});
  await send(f.core,f.a,'ancestor-active');
  const control=await attemptTakeover(f.core,child.id);
  assert.equal(control.phase,'unknown');
  assert.match(control.reason,/重叠项目仍有执行租约/);
  assert.equal(f.core.leases.state().active[0].projectId,f.project.id);
});

test('existing-session adoption cannot bypass an overlapping project lease',async t=>{
  const f=await fixture(t),nested=join(f.project.directory,'existing-child');await mkdir(nested);
  const child=f.core.store.project({name:'Nested external session',directory:nested});
  await send(f.core,f.a,'ancestor-existing-block');
  const control=await attemptTakeover(f.core,child.id,true);
  assert.equal(control.phase,'unknown');
  assert.equal(control.mode,'existing');
  assert.match(control.reason,/重叠项目仍有执行租约/);
  assert.equal(f.core.leases.state().active[0].projectId,f.project.id);
});

test('takeover of a nested project refuses an ancestor running task without a lease',async t=>{
  const f=await fixture(t);
  const nested=join(f.project.directory,'nested');await mkdir(nested);
  const child=f.core.store.project({name:'Nested',directory:nested});
  f.core.store.updateTask(f.a.id,{status:'running'},f.a.revision);
  assert.equal(f.core.leases.state().active.length,0);
  const control=await attemptTakeover(f.core,child.id);
  assert.equal(control.phase,'unknown');
  assert.match(control.reason,/重叠项目仍有运行中任务/);
});
