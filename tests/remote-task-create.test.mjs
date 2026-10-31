import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHub} from '../server/hub/http.mjs';
import {createCore} from '../server/core.mjs';
import {Store} from '../server/store.mjs';

async function hubFixture(){
  const root=await mkdtemp(join(tmpdir(),'seqivo-remote-task-create-'));
  const hub=await createHub({dataDir:join(root,'hub')});
  const owner=(await readFile(hub.store.bootstrap('task-create').tokenPath,'utf8')).trim();
  const call=async(method,path,body,token=owner)=>{
    const response=await fetch(hub.url+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const pair=async(role,projectIds=['p1'])=>{
    const created=await call('POST','/api/admin/pairings',{role,projectIds});
    assert.equal(created.status,200);
    const redeemed=await call('POST','/api/pairings/redeem',{code:created.body.code});
    assert.equal(redeemed.status,200);
    return redeemed.body;
  };
  return {root,hub,owner,call,pair,close:async()=>{await hub.close();await rm(root,{recursive:true,force:true});}};
}

const command=(commandId='create-one')=>({commandId,projectId:'p1',taskId:commandId,action:'create_task',expectedRevision:0,
  expiresAt:new Date(Date.now()+60000).toISOString(),body:{title:'新任务',goal:'人工记录目标',example:'',summary:'',approach:'',criteria:['检查结果']}});

test('remote manual task creation is queued for a capable online node',async()=>{
  const x=await hubFixture();
  try{
    const node=await x.pair('node'),controller=await x.pair('controller');
    const observedAt=new Date().toISOString();
    const snapshot=await x.call('POST','/api/node/snapshot',{epoch:node.epoch,sequence:1,
      projects:[{id:'p1',name:'项目',conversationStart:{v:1,bootId:'core-one',observedAt,state:'ready',reasonCode:null}}],
      tasks:[],capabilities:{taskCreation:true,conversations:true}},node.token);
    assert.equal(snapshot.status,200);
    const created=await x.call('POST','/api/commands',command(),controller.token);
    assert.equal(created.status,200,JSON.stringify(created.body));
    assert.equal(created.body.status,'queued');
    assert.equal((await x.call('POST','/api/commands',command('create-two'),controller.token)).body.code,'CREATE_FENCED');
    const conversation={...command('conversation-two'),action:'create_conversation',body:{title:'对话',message:'继续'} };
    assert.equal((await x.call('POST','/api/commands',conversation,controller.token)).body.code,'CREATE_FENCED');
    assert.equal((await x.call('POST','/api/node/commands/create-one/claim',{},node.token)).status,200);
    const forged=await x.call('POST','/api/node/commands/create-one/receipt',
      {status:'completed',result:{taskId:'create-one',status:'planned',revision:1}},node.token);
    assert.equal(forged.status,400);
  }finally{await x.close();}
});

async function coreFixture(){
  const x=await hubFixture();
  const pluginDir=join(x.root,'empty-plugins');
  await mkdir(pluginDir);
  let core=await createCore({dataDir:join(x.root,'core'),pluginDir,files:false});
  const project=core.store.project({name:'手机任务项目'});
  const pairing=await x.call('POST','/api/admin/pairings',{role:'node',projectIds:[project.id]});
  assert.equal(pairing.status,200);
  await core.remote.configure({url:x.hub.url,pairingCode:pairing.body.code,projectIds:[project.id]});
  const controller=await x.pair('controller',[project.id]);
  return {...x,project,controller,get core(){return core;},
    async restart(){core=await createCore({dataDir:join(x.root,'core'),pluginDir,files:false});return core;},
    async close(){await core.close();await x.close();}};
}

test('real Core creates one ordinary task without starting execution and returns a scoped completed receipt',async()=>{
  const x=await coreFixture();
  try{
    const body={...command('manual-one'),projectId:x.project.id,taskId:'manual-one'};
    await assert.rejects(x.core.request('POST','/api/tasks',{projectId:x.project.id,...body.body},'remote-controller'),
      error=>error.status===403);
    const viewer=await x.pair('viewer',[x.project.id]);
    assert.equal((await x.call('POST','/api/commands',body,viewer.token)).status,403);
    assert.equal((await x.call('POST','/api/commands',{...body,body:{...body.body,conversationId:'private'}},x.controller.token)).status,400);
    assert.equal((await x.call('POST','/api/commands',{...body,queueOffline:true},x.controller.token)).status,400);
    const queued=await x.call('POST','/api/commands',body,x.controller.token);
    assert.equal(queued.status,200,JSON.stringify(queued.body));
    await x.core.remote.sync();
    const receipt=await x.call('GET','/api/commands/manual-one',undefined,x.controller.token);
    assert.equal(receipt.body.status,'completed',JSON.stringify(receipt.body));
    assert.deepEqual(receipt.body.result,{taskId:receipt.body.result.taskId,status:'planned',revision:1});
    const local=x.core.store.tasks(x.project.id);
    assert.equal(local.length,1);
    assert.equal(local[0].id,receipt.body.result.taskId);
    assert.equal(local[0].conversationId,'');
    assert.equal(local[0].sourceConversation,null);
    assert.equal(local[0].status,'planned');
    assert.equal(x.core.leases.state().active.length,0);
    assert.equal((await x.call('POST','/api/commands',body,x.controller.token)).body.status,'completed');
    assert.equal((await x.call('POST','/api/commands',{...body,body:{...body.body,title:'different'}},x.controller.token)).status,409);
    await x.core.remote.sync();
    const state=await x.call('GET','/api/state',undefined,x.controller.token);
    assert.equal(state.body.projects[0].taskCreationAvailable,true);
    assert.equal(state.body.tasks.length,1);
    assert.equal(state.body.tasks[0].hasExecutionBinding,false);
  }finally{await x.close();}
});

test('old capability, revoked controller, and wrong project cannot create a remote task',async()=>{
  const x=await hubFixture();
  try{
    const node=await x.pair('node'),controller=await x.pair('controller'),other=await x.pair('controller',['p2']);
    const snapshot={epoch:node.epoch,sequence:1,projects:[{id:'p1',name:'项目'}],tasks:[]};
    assert.equal((await x.call('POST','/api/node/snapshot',snapshot,node.token)).status,200);
    assert.equal((await x.call('GET','/api/state',undefined,controller.token)).body.projects[0].taskCreationAvailable,false);
    assert.equal((await x.call('POST','/api/commands',command('old-node'),controller.token)).status,409);
    assert.equal((await x.call('POST','/api/commands',command('wrong-project'),other.token)).status,403);
    assert.equal((await x.call('POST','/api/node/snapshot',{...snapshot,sequence:2,capabilities:{taskCreation:true}},node.token)).status,200);
    assert.equal((await x.call('POST','/api/commands',command('revoke'),controller.token)).status,200);
    assert.equal((await x.call('POST',`/api/admin/subjects/${controller.subjectId}/revoke`,{})).status,200);
    assert.equal((await x.call('POST','/api/node/commands/revoke/claim',{},node.token)).status,409);
  }finally{await x.close();}
});

test('restarted Core recovers a lost task receipt from its durable mapping without recreating',async()=>{
  const x=await coreFixture();
  try{
    const body={...command('lost-manual'),projectId:x.project.id,taskId:'lost-manual'};
    assert.equal((await x.call('POST','/api/commands',body,x.controller.token)).status,200);
    const originalFetch=globalThis.fetch;
    globalThis.fetch=(url,options)=>String(url).endsWith('/api/node/commands/lost-manual/receipt')
      ?Promise.reject(Error('simulated lost receipt response')):originalFetch(url,options);
    try{await x.core.remote.sync();}finally{globalThis.fetch=originalFetch;}
    assert.equal(x.core.store.tasks(x.project.id).length,1);
    await x.core.close();
    const path=join(x.root,'core','remote-link.json');
    const saved=JSON.parse(await readFile(path,'utf8'));
    assert.equal(saved.receipts['lost-manual'].phase,'done');
    saved.receipts['lost-manual']={phase:'sending',status:null,reported:false};
    await writeFile(path,JSON.stringify(saved)+'\n');
    await x.restart();
    await x.core.remote.sync();
    const uncertain=await x.call('GET','/api/commands/lost-manual',undefined,x.controller.token);
    assert.equal(uncertain.body.status,'unknown');
    const state=await x.call('GET','/api/state',undefined,x.controller.token);
    assert.ok(state.body.inbox.items.some(item=>item.kind==='unknown'&&item.source.id==='lost-manual'));
    assert.equal((await x.call('POST','/api/commands/lost-manual/reconcile',{},x.controller.token)).status,200);
    await x.core.remote.sync();
    const recovered=await x.call('GET','/api/commands/lost-manual',undefined,x.controller.token);
    assert.equal(recovered.body.status,'completed',JSON.stringify(recovered.body));
    assert.equal(recovered.body.result.status,'planned');
    assert.equal(x.core.store.tasks(x.project.id).length,1);
  }finally{await x.close();}
});

test('durable task origin returns only the original result and never recreates a missing task',async()=>{
  const root=await mkdtemp(join(tmpdir(),'seqivo-remote-task-origin-'));
  const path=join(root,'board.sqlite');
  let store=new Store(path);
  try{
    const project=store.project({name:'原始项目'});
    const input={tenantId:'tenant-one',nodeId:'node-one',subjectId:'controller-one',commandId:'manual-one',
      projectId:project.id,body:{title:'只建一次',criteria:['可核对']}};
    const first=store.createRemoteTask(input);
    store.close();store=new Store(path);
    assert.deepEqual(store.createRemoteTask(input),first);
    assert.equal(store.tasks(project.id).length,1);
    assert.throws(()=>store.createRemoteTask({...input,body:{title:'另一内容',criteria:['可核对']}}),error=>error.code==='COMMAND_CONFLICT');
    store.db.prepare('DELETE FROM tasks WHERE id=?').run(first.taskId);
    assert.equal(store.remoteTaskCreation(input),null);
    assert.throws(()=>store.createRemoteTask(input),error=>error.code==='TASK_CREATE_UNKNOWN');
    assert.equal(store.tasks(project.id).length,0);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
