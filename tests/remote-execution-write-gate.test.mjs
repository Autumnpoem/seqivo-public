import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../server/hub/http.mjs';
import { createCore } from '../server/core.mjs';

const bootId='test-core-boot-1';
const ready=()=>({state:'ready',reasonCode:null});
const blocked=()=>({state:'blocked',reasonCode:'ACTIVE_EXECUTION'});
const projectGate=(at,action=ready())=>({v:1,bootId,observedAt:new Date(at).toISOString(),...action});
const taskGate=(at,action=ready())=>({v:1,bootId,observedAt:new Date(at).toISOString(),taskRevision:1,contentVersion:1,
  message:action,continue:action,start:action});

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'seqivo-remote-write-gate-'));
  let clock=Date.now();
  const hub=await createHub({dataDir:join(root,'hub'),host:'127.0.0.1',port:0,now:()=>clock});
  t.after(async()=>{await hub.close();await rm(root,{recursive:true,force:true});});
  const owner=(await readFile(hub.store.bootstrap('tenant-one').tokenPath,'utf8')).trim();
  async function call(method,path,body,token=owner,expected=200){
    const response=await fetch(`${hub.url}${path}`,{method,redirect:'error',headers:{Authorization:`Bearer ${token}`,
      ...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
  }
  async function pair(role,projectIds=['p1']){
    const {code}=await call('POST','/api/admin/pairings',{role,projectIds});
    return call('POST','/api/pairings/redeem',{code});
  }
  const node=await pair('node'),controller=await pair('controller');
  const command=(commandId,action='message',extra={})=>({commandId,projectId:'p1',taskId:action==='create_conversation'?commandId:'t1',action,
    expectedRevision:action==='create_conversation'?0:1,expiresAt:new Date(clock+60000).toISOString(),
    body:['message','start_task'].includes(action)?{message:'one'}:action==='create_conversation'?{title:'New',message:'one'}:{},...extra});
  let seq=0;
  async function snapshot({projectAction=ready(),taskAction=ready(),observedAt=clock,legacy=false,revision=1,status='blocked',taskStart=false}={}){
    const project={id:'p1',name:'First',...(legacy?{}:{conversationStart:projectGate(observedAt,projectAction)})};
    const task={id:'t1',projectId:'p1',title:'Task',status,revision,contentVersion:1,
      ...(legacy?{}:{executionWrite:{...taskGate(observedAt,taskAction),taskRevision:revision}})};
    return call('POST','/api/node/snapshot',{epoch:1,sequence:++seq,projects:[project],tasks:[task],capabilities:{conversations:true,taskStart}},node.token);
  }
  const rows=()=>hub.store.db.prepare('SELECT count(*) AS n FROM commands').get().n;
  return {hub,node,controller,call,pair,command,snapshot,rows,advance:ms=>{clock+=ms;},now:()=>clock};
}

test('fresh scoped Core observation admits one write; exact retry survives later blocking; pause is unaffected',async t=>{
  const x=await fixture(t);
  await x.snapshot();
  const state=await x.call('GET','/api/state',undefined,x.controller.token);
  assert.equal(state.tasks[0].executionWrite.message.state,'ready');
  assert.equal(state.projects[0].conversationStart.state,'ready');
  assert.equal(JSON.stringify(state).includes('workspace'),false);
  const original=x.command('first');
  assert.equal((await x.call('POST','/api/commands',original,x.controller.token)).status,'queued');
  await x.snapshot({taskAction:blocked()});
  assert.equal((await x.call('POST','/api/commands',original,x.controller.token)).status,'queued');
  assert.equal(x.rows(),1);
  assert.equal((await x.call('POST','/api/commands',x.command('halt','pause'),x.controller.token)).status,'queued');
  assert.equal(x.rows(),2);
  assert.equal((await x.call('POST','/api/commands',x.command('blocked'),x.controller.token,409)).code,'EXECUTION_WRITE_BLOCKED');
  assert.equal(x.rows(),2);
});

test('start_task requires a capable fresh planned task and keeps a lease until verified pause',async t=>{
  const x=await fixture(t),start=x.command('start-one','start_task');
  await x.snapshot({status:'planned'});
  assert.equal((await x.call('POST','/api/commands',start,x.controller.token,409)).code,'NODE_UPDATE_REQUIRED');
  await x.snapshot({status:'planned',taskStart:true,taskAction:blocked()});
  assert.equal((await x.call('POST','/api/commands',start,x.controller.token,409)).code,'EXECUTION_WRITE_BLOCKED');
  await x.snapshot({status:'planned',taskStart:true});
  assert.equal((await x.call('POST','/api/commands',{...start,queueOffline:true},x.controller.token,400)).code,'OFFLINE_NOT_ALLOWED');
  assert.equal((await x.call('POST','/api/commands',{...start,expectedRevision:2},x.controller.token,409)).code,'REVISION_CONFLICT');
  assert.equal((await x.call('POST','/api/commands',start,x.controller.token)).status,'queued');
  assert.equal(x.hub.store.db.prepare('SELECT command_id FROM continue_leases').get().command_id,'start-one');
  assert.equal((await x.call('POST','/api/commands',x.command('second','start_task'),x.controller.token,409)).code,'COMMAND_FENCED');
  assert.equal((await x.call('POST','/api/commands',x.command('stop','pause'),x.controller.token)).status,'queued');
  assert.equal((await x.call('GET','/api/commands/start-one',undefined,x.controller.token)).status,'expired');
  assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM continue_leases').get().n,0);
});

test('start_task rejects viewer and a wrong-task running receipt from the authenticated node',async t=>{
  const x=await fixture(t);await x.snapshot({status:'planned',taskStart:true});
  const viewer=await x.pair('viewer');
  assert.equal((await x.call('POST','/api/commands',x.command('view','start_task'),viewer.token,403)).code,'FORBIDDEN');
  assert.equal((await x.call('POST','/api/commands',x.command('real','start_task'),x.controller.token)).status,'queued');
  assert.equal((await x.call('POST','/api/node/commands/real/claim',{},x.node.token)).status,'received');
  assert.equal((await x.call('POST','/api/node/commands/real/sending',{},x.node.token)).status,'sending');
  await x.call('POST','/api/node/commands/real/receipt',{status:'running',result:{taskId:'other-task',status:'running'}},x.node.token,400);
  assert.equal((await x.call('GET','/api/commands/real',undefined,x.controller.token)).status,'sending');
});

test('missing, blocked, stale, future, offline and wrong-epoch gates never insert new execution commands',async t=>{
  const x=await fixture(t);
  await x.snapshot({legacy:true});
  assert.equal((await x.call('POST','/api/commands',x.command('legacy'),x.controller.token,409)).code,'EXECUTION_GATE_UNAVAILABLE');
  assert.equal(x.rows(),0);
  await x.snapshot({taskAction:blocked(),projectAction:blocked()});
  assert.equal((await x.call('POST','/api/commands',x.command('blocked'),x.controller.token,409)).code,'EXECUTION_WRITE_BLOCKED');
  assert.equal((await x.call('POST','/api/commands',x.command('new','create_conversation'),x.controller.token,409)).code,'EXECUTION_WRITE_BLOCKED');
  await x.snapshot();
  assert.equal((await x.call('POST','/api/commands',x.command('offline','message',{queueOffline:true}),x.controller.token,409)).code,'EXECUTION_GATE_UNAVAILABLE');
  x.advance(11000);
  assert.equal((await x.call('POST','/api/commands',x.command('stale'),x.controller.token,409)).code,'EXECUTION_GATE_UNAVAILABLE');
  await x.snapshot({observedAt:x.now()-11000}); // A persisted pending snapshot received only now.
  assert.equal((await x.call('POST','/api/commands',x.command('old-pending'),x.controller.token,409)).code,'EXECUTION_GATE_UNAVAILABLE');
  await x.snapshot({observedAt:x.now()+3000});
  assert.equal((await x.call('POST','/api/commands',x.command('future'),x.controller.token,409)).code,'EXECUTION_GATE_UNAVAILABLE');
  assert.equal(x.rows(),0);
  await x.call('POST','/api/node/snapshot',{epoch:2,sequence:99,projects:[],tasks:[]},x.node.token,409);
  assert.equal(x.rows(),0);
});

test('task revision, project grant, mixed boot and malformed projections fail closed',async t=>{
  const x=await fixture(t);
  await x.snapshot();
  assert.equal((await x.call('POST','/api/commands',x.command('wrong-revision','continue',{expectedRevision:2}),x.controller.token,409)).code,'REVISION_CONFLICT');
  const outsider=await x.call('POST','/api/admin/pairings',{role:'controller',projectIds:['p2']});
  const other=await x.call('POST','/api/pairings/redeem',{code:outsider.code});
  assert.equal((await x.call('POST','/api/commands',x.command('other'),other.token,403)).code,'GRANT_REQUIRED');
  const invalid={epoch:1,sequence:2,projects:[{id:'p1',name:'First',conversationStart:projectGate(x.now())}],
    tasks:[{id:'t1',projectId:'p1',title:'Task',status:'blocked',revision:1,contentVersion:1,
      executionWrite:{...taskGate(x.now()),bootId:'other-boot'}}],capabilities:{conversations:true}};
  await x.call('POST','/api/node/snapshot',invalid,x.node.token,400);
  assert.equal(x.rows(),0);
});

test('isolated real Core publishes gate through its node link and resyncs a changed lease', {timeout:20000}, async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-core-write-gate-')));
  let core,hub;
  try{
    hub=await createHub({dataDir:join(root,'hub'),host:'127.0.0.1',port:0});
    core=await createCore({dataDir:join(root,'core'),pluginDir:join(root,'empty-plugins'),files:false});
    const owner=(await readFile(hub.store.bootstrap('real-core-gate').tokenPath,'utf8')).trim();
    const project=core.store.project({name:'Isolated',directory:root});
    const task=core.store.createTask({projectId:project.id,title:'Bound',conversationId:'thread-bound',executionProvider:'codex-autocontinue'});
    const request=async(method,path,body,token=owner)=>{
      const response=await fetch(`${hub.url}${path}`,{method,headers:{Authorization:`Bearer ${token}`,
        ...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
    };
    const pairing=await request('POST','/api/admin/pairings',{role:'node',projectIds:[project.id]});
    await core.remote.configure({url:hub.url,pairingCode:pairing.code,projectIds:[project.id]});
    const controllerCode=await request('POST','/api/admin/pairings',{role:'controller',projectIds:[project.id]});
    const controller=await request('POST','/api/pairings/redeem',{code:controllerCode.code});
    const first=await request('GET','/api/state',undefined,controller.token);
    assert.equal(first.tasks[0].id,task.id);
    assert.equal(first.tasks[0].executionWrite.bootId,first.projects[0].conversationStart.bootId);
    assert.equal(first.tasks[0].executionWrite.taskRevision,task.revision);
    assert.equal(first.tasks[0].executionWrite.message.reasonCode,'BINDING_UNAVAILABLE');
    assert.equal(JSON.stringify(first).includes(root),false);
    core.leases.reserve({taskId:task.id,commandId:'isolated-active',provider:'codex-autocontinue'});
    await new Promise(resolve=>setTimeout(resolve,2300)); // the existing healthy node sync defaults to 2 s
    const next=await request('GET','/api/state',undefined,controller.token);
    assert.equal(next.projects[0].conversationStart.state,'blocked');
    assert.equal(next.tasks[0].executionWrite.message.state,'blocked');
    assert.equal(next.tasks[0].executionWrite.message.reasonCode,'ACTIVE_EXECUTION');
    core.leases.releaseConfirmed({taskId:task.id,commandId:'isolated-active',status:'not_started'});
  }finally{
    const errors=[];
    if(core)try{await core.close();}catch(error){errors.push(error);}
    if(hub)try{await hub.close();}catch(error){errors.push(error);}
    if(!errors.length)await rm(root,{recursive:true,force:true});
    else throw new AggregateError(errors,`isolated Core/Hub cleanup failed; fixture retained at ${root}`);
  }
});
