import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHub } from '../server/hub/http.mjs';
import { HubStore } from '../server/hub/store.mjs';
import { createRemoteLink } from '../server/remote-client.mjs';
import { Store } from '../server/store.mjs';

const board=(time=Date.now())=>({projects:[{id:'p1',name:'One',createdAt:new Date().toISOString(),
  conversationStart:{v:1,bootId:'fixture-core-boot',observedAt:new Date(time).toISOString(),state:'ready',reasonCode:null}}],
  tasks:[{id:'t1',projectId:'p1',title:'Task',status:'blocked',revision:1,contentVersion:1,updatedAt:new Date().toISOString(),
    executionWrite:{v:1,bootId:'fixture-core-boot',observedAt:new Date(time).toISOString(),taskRevision:1,contentVersion:1,
      message:{state:'ready',reasonCode:null},continue:{state:'ready',reasonCode:null}}}],capabilities:{conversations:true}});
const command=(id,action='continue',taskId='t1')=>({commandId:id,projectId:'p1',taskId,action,expectedRevision:action==='create_conversation'?0:1,
  expiresAt:new Date(Date.now()+60000).toISOString(),body:action==='create_conversation'?{title:'New',message:'Begin'}:{}});

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'seqivo-recovery-'));
  let clock=Date.now();
  const hub=await createHub({dataDir:join(root,'hub'),host:'127.0.0.1',port:0,now:()=>clock});
  const owner=await readFile(hub.store.bootstrap('tenant-a').tokenPath,'utf8').then(s=>s.trim());
  async function call(method,path,body,secret=owner,expected=200){
    const response=await fetch(`${hub.url}${path}`,{method,headers:{Authorization:`Bearer ${secret}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;
  }
  async function pair(role,projects=['p1']){const p=await call('POST','/api/admin/pairings',{role,projectIds:projects});return call('POST','/api/pairings/redeem',{code:p.code},undefined,undefined);}
  const node=await pair('node'),controller=await pair('controller'),other=await pair('controller');
  return {root,hub,owner,node,controller,other,call,advance:ms=>{clock+=ms;},now:()=>clock,close:async()=>{await hub.close();await rm(root,{recursive:true,force:true});}};
}

test('lost Hub receipt is restored from the original durable result without another callback',async()=>{
  const x=await fixture();let link;const calls=[];
  try{
    link=await createRemoteLink({dataDir:join(x.root,'node'),getState:()=>board(x.now()),request:async()=>{calls.push('called');return {status:'running',taskId:'t1',revision:2,secret:'must not travel'};}});
    const pairing=await x.call('POST','/api/admin/pairings',{role:'node',projectIds:['p1']});
    // Use the paired node from this link as project owner.
    await x.call('POST','/api/admin/subjects/'+x.node.subjectId+'/revoke',{});
    await link.configure({url:x.hub.url,pairingCode:pairing.code,projectIds:['p1']});
    await x.call('POST','/api/commands',command('lost'),x.controller.token);
    const originalFetch=globalThis.fetch;
    try{
      globalThis.fetch=(url,options)=>String(url).endsWith('/api/node/commands/lost/receipt')?Promise.reject(new Error('response lost')):originalFetch(url,options);
      await link.sync();
    }finally{globalThis.fetch=originalFetch;}
    assert.equal(calls.length,1);
    x.advance(301000);
    assert.equal((await x.call('GET','/api/commands/lost',undefined,x.controller.token)).status,'unknown');
    const requested=await x.call('POST','/api/commands/lost/reconcile',{},x.controller.token);
    assert.equal(requested.recovery.outcome,'unknown');assert.equal(requested.recovery.checkedAt,undefined);
    await link.sync();
    const recovered=await x.call('GET','/api/commands/lost',undefined,x.controller.token);
    assert.equal(recovered.status,'running');assert.equal(recovered.recovery.outcome,'applied');assert.equal(recovered.recovery.basis,'durable_receipt');
    assert.ok(recovered.recovery.checkedAt>=recovered.recovery.requestedAt);
    assert.deepEqual(recovered.result,{taskId:'t1',status:'running',revision:2});assert.equal(calls.length,1);
  }finally{await link?.close();await x.close();}
});

for(const knownRunning of [false,true]) test(`verified paused recovery preserves ${knownRunning?'known running':'unknown'} original semantics without replay`,async()=>{
  const x=await fixture();let link;const calls=[];
  try{
    const pairing=await x.call('POST','/api/admin/pairings',{role:'node',projectIds:['p1']});
    await x.call('POST','/api/admin/subjects/'+x.node.subjectId+'/revoke',{});
    link=await createRemoteLink({dataDir:join(x.root,'node'),getState:()=>board(x.now()),request:async(method,path)=>{calls.push(path);return {status:'paused',taskId:'t1'};}});
    await link.configure({url:x.hub.url,pairingCode:pairing.code,projectIds:['p1']});
    const nodeToken=JSON.parse(await readFile(join(x.root,'node','remote-link.json'),'utf8')).token;
    await x.call('POST','/api/commands',command('ongoing'),x.controller.token);
    await x.call('POST','/api/node/commands/ongoing/claim',{},nodeToken);
    await x.call('POST','/api/node/commands/ongoing/sending',{},nodeToken);
    if(knownRunning) await x.call('POST','/api/node/commands/ongoing/receipt',{status:'running',result:{taskId:'t1',status:'running'}},nodeToken);
    await x.call('POST','/api/commands',command('halt','pause'),x.controller.token);
    const originalFetch=globalThis.fetch;
    try{
      globalThis.fetch=(url,options)=>String(url).endsWith('/api/node/commands/halt/receipt')?Promise.reject(new Error('pause acknowledgement lost')):originalFetch(url,options);
      await link.sync();
    }finally{globalThis.fetch=originalFetch;}
    assert.deepEqual(calls,['/api/tasks/t1/pause']);
    assert.equal((await x.call('GET','/api/commands/ongoing',undefined,x.controller.token)).status,knownRunning?'running':'unknown');
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM continue_leases').get().n,1);
    x.advance(301000);
    assert.equal((await x.call('GET','/api/commands/halt',undefined,x.controller.token)).status,'unknown');
    await x.call('POST','/api/commands/halt/reconcile',{},x.controller.token);
    await link.sync();
    const pause=await x.call('GET','/api/commands/halt',undefined,x.controller.token);
    const previous=await x.call('GET','/api/commands/ongoing',undefined,x.controller.token);
    assert.equal(pause.status,'paused');assert.equal(pause.recovery.outcome,'applied');assert.equal(pause.recovery.basis,'durable_receipt');
    assert.equal(previous.status,knownRunning?'paused':'unknown');
    assert.equal(previous.error,knownRunning?'Paused by verified node command':'Pause confirmed; original action outcome remains unknown');
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM continue_leases').get().n,0);
    const followup={...command('followup'),expiresAt:new Date(Date.now()+360000).toISOString()};
    if(knownRunning) assert.equal((await x.call('POST','/api/commands',followup,x.controller.token)).status,'queued');
    else {
      assert.equal((await x.call('POST','/api/commands',followup,x.controller.token,409)).code,'COMMAND_FENCED');
      assert.ok((await x.call('GET','/api/inbox',undefined,x.controller.token)).items.some(item=>item.source?.type==='hub.command'&&item.source.id==='ongoing'));
    }
    assert.deepEqual(calls,['/api/tasks/t1/pause']);
  }finally{await link?.close();await x.close();}
});

test('ordinary verified pause also preserves an unconfirmed prior send as unknown',async()=>{
  const x=await fixture();
  try{
    await x.call('POST','/api/node/snapshot',{...board(),epoch:1,sequence:1},x.node.token);
    await x.call('POST','/api/commands',command('prior'),x.controller.token);
    await x.call('POST','/api/node/commands/prior/claim',{},x.node.token);
    await x.call('POST','/api/node/commands/prior/sending',{},x.node.token);
    await x.call('POST','/api/commands',command('pause-normal','pause'),x.controller.token);
    await x.call('POST','/api/node/commands/pause-normal/claim',{},x.node.token);
    await x.call('POST','/api/node/commands/pause-normal/sending',{},x.node.token);
    assert.equal((await x.call('POST','/api/node/commands/pause-normal/receipt',{status:'paused',result:{taskId:'t1',status:'paused'}},x.node.token)).status,'paused');
    assert.equal((await x.call('GET','/api/commands/prior',undefined,x.controller.token)).status,'unknown');
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM continue_leases').get().n,0);
    assert.equal((await x.call('POST','/api/commands',command('new-write'),x.controller.token,409)).code,'COMMAND_FENCED');
  }finally{await x.close();}
});

test('actual Store update, evidence and review Task results recover after lost Hub acknowledgements',async()=>{
  const root=await mkdtemp(join(tmpdir(),'seqivo-recovery-store-'));
  let clock=Date.now(),hub,link;const calls=[];
  const local=new Store(join(root,'board.sqlite'));
  try{
    const project=local.project({name:'Actual project',goal:'Test',directory:root});
    const task=local.createTask({projectId:project.id,title:'Actual task',goal:'Test'});
    hub=await createHub({dataDir:join(root,'hub'),host:'127.0.0.1',port:0,now:()=>clock});
    const owner=await readFile(hub.store.bootstrap('actual-tenant').tokenPath,'utf8').then(s=>s.trim());
    const call=async(method,path,body,secret=owner,expected=200)=>{
      const response=await fetch(`${hub.url}${path}`,{method,headers:{Authorization:`Bearer ${secret}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;
    };
    const nodePair=await call('POST','/api/admin/pairings',{role:'node',projectIds:[project.id]});
    const controllerPair=await call('POST','/api/admin/pairings',{role:'controller',projectIds:[project.id]});
    const controller=await call('POST','/api/pairings/redeem',{code:controllerPair.code});
    link=await createRemoteLink({dataDir:join(root,'node'),now:()=>clock,getState:()=>({projects:local.projects(),tasks:local.tasks()}),request:async(method,path,body)=>{
      const action=path.endsWith('/evidence')?'evidence':path.endsWith('/review')?'review':'update';calls.push(action);
      return action==='evidence'?local.addEvidence(task.id,body):action==='review'?local.review(task.id,body):local.updateTask(task.id,body,body.expectedRevision);
    }});
    await link.configure({url:hub.url,pairingCode:nodePair.code,projectIds:[project.id]});
    const cases=[['update',{summary:'Changed'}],['evidence',{summary:'Evidence',reference:'local-test'}],['review',{decision:'fail',summary:'Needs revision'}]];
    for(const [action,body] of cases){
      const commandId=`actual-${action}`;
      const before=local.getTask(task.id);
      await call('POST','/api/commands',{commandId,projectId:project.id,taskId:task.id,action,expectedRevision:before.revision,
        expiresAt:new Date(clock+60000).toISOString(),body},controller.token);
      const originalFetch=globalThis.fetch;
      try{
        globalThis.fetch=(url,options)=>String(url).endsWith(`/api/node/commands/${commandId}/receipt`)?Promise.reject(new Error('Hub acknowledgement lost')):originalFetch(url,options);
        await link.sync();
      }finally{globalThis.fetch=originalFetch;}
      assert.equal(calls.filter(value=>value===action).length,1);
      clock+=301000;
      assert.equal((await call('GET',`/api/commands/${commandId}`,undefined,controller.token)).status,'unknown');
      await call('POST',`/api/commands/${commandId}/reconcile`,{},controller.token);
      await link.sync();
      const outcome=await call('GET',`/api/commands/${commandId}`,undefined,controller.token);
      assert.equal(outcome.status,'running');assert.equal(outcome.recovery.outcome,'applied');
      assert.equal(outcome.result.taskId,task.id);assert.equal(outcome.result.revision,before.revision+1);
      assert.equal(calls.filter(value=>value===action).length,1);
    }
  }finally{await link?.close();await hub?.close();local.close();await rm(root,{recursive:true,force:true});}
});

for(const phase of ['received','claimed','sending']) test(`restarted ${phase} marker gives only a conservative original-ID outcome`,async()=>{
  const x=await fixture();let link,restarted;const calls=[];
  try{
    link=await createRemoteLink({dataDir:join(x.root,'node'),getState:()=>board(x.now()),request:async()=>{calls.push(1);return {status:'running'};}});
    const pairing=await x.call('POST','/api/admin/pairings',{role:'node',projectIds:['p1']});
    await x.call('POST','/api/admin/subjects/'+x.node.subjectId+'/revoke',{});
    await link.configure({url:x.hub.url,pairingCode:pairing.code,projectIds:['p1']});
    const saved=JSON.parse(await readFile(join(x.root,'node','remote-link.json'),'utf8'));
    await x.call('POST','/api/commands',command('stage'),x.controller.token);
    await x.call('POST','/api/node/commands/stage/claim',{},saved.token);
    await link.close();link=null;
    saved.receipts.stage={phase,status:null,reported:false};
    await writeFile(join(x.root,'node','remote-link.json'),JSON.stringify(saved));
    x.advance(301000);
    assert.equal((await x.call('GET','/api/commands/stage',undefined,x.controller.token)).status,'unknown');
    await x.call('POST','/api/commands/stage/reconcile',{},x.controller.token);
    restarted=await createRemoteLink({dataDir:join(x.root,'node'),getState:()=>board(x.now()),request:async()=>{calls.push(1);return {status:'running'};}});
    await restarted.sync();
    const result=await x.call('GET','/api/commands/stage',undefined,x.controller.token);
    assert.equal(result.recovery.outcome,phase==='sending'?'unknown':'not_applied');
    assert.equal(result.status,phase==='sending'?'unknown':'failed');
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM continue_leases').get().n,phase==='sending'?1:0);
    assert.equal(calls.length,0);
  }finally{await restarted?.close();await link?.close();await x.close();}
});

test('incomplete historical success receipt ends probe as unknown without replay or sync failure',async()=>{
  const x=await fixture();let link,restarted;let calls=0;
  try{
    link=await createRemoteLink({dataDir:join(x.root,'node'),getState:()=>board(x.now()),request:async()=>{calls++;return {status:'running'};}});
    const pairing=await x.call('POST','/api/admin/pairings',{role:'node',projectIds:['p1']});
    await x.call('POST','/api/admin/subjects/'+x.node.subjectId+'/revoke',{});
    await link.configure({url:x.hub.url,pairingCode:pairing.code,projectIds:['p1']});
    const saved=JSON.parse(await readFile(join(x.root,'node','remote-link.json'),'utf8'));
    await x.call('POST','/api/commands',command('incomplete'),x.controller.token);
    await x.call('POST','/api/node/commands/incomplete/claim',{},saved.token);
    await link.close();link=null;
    saved.receipts.incomplete={phase:'done',status:'running',result:{status:'running'},reported:false};
    await writeFile(join(x.root,'node','remote-link.json'),JSON.stringify(saved));
    x.advance(301000);await x.call('GET','/api/commands/incomplete',undefined,x.controller.token);
    await x.call('POST','/api/commands/incomplete/reconcile',{},x.controller.token);
    restarted=await createRemoteLink({dataDir:join(x.root,'node'),getState:()=>board(x.now()),request:async()=>{calls++;return {status:'running'};}});
    assert.equal((await restarted.sync()).status,'connected');
    const outcome=await x.call('GET','/api/commands/incomplete',undefined,x.controller.token);
    assert.equal(outcome.status,'unknown');assert.equal(outcome.recovery.outcome,'unknown');assert.ok(outcome.recovery.checkedAt);
    assert.equal(calls,0);
  }finally{await restarted?.close();await link?.close();await x.close();}
});

test('missing local receipt remains unknown; cross-subject, tenant, grant and epoch requests are denied',async()=>{
  const x=await fixture();
  try{
    await x.call('POST','/api/node/snapshot',{...board(),epoch:1,sequence:1},x.node.token);
    await x.call('POST','/api/commands',command('lost'),x.controller.token);
    await x.call('POST','/api/node/commands/lost/claim',{},x.node.token);
    x.advance(301000);await x.call('GET','/api/commands/lost',undefined,x.controller.token);
    assert.equal((await x.call('POST','/api/commands/lost/reconcile',{},x.other.token,404)).code,'NOT_FOUND');
    const b=await readFile(x.hub.store.bootstrap('tenant-b').tokenPath,'utf8').then(s=>s.trim());
    assert.equal((await x.call('POST','/api/commands/lost/reconcile',{},b,404)).code,'NOT_FOUND');
    assert.equal((await x.call('POST','/api/commands/lost/reconcile',{},x.owner)).recovery.outcome,'unknown');
    const checked=await x.call('POST','/api/node/commands/lost/reconcile',{outcome:'unknown',basis:'insufficient_evidence'},x.node.token);
    assert.equal(checked.status,'unknown');assert.ok(checked.recovery.checkedAt>=checked.recovery.requestedAt);
    await x.call('DELETE',`/api/admin/grants/${x.controller.subjectId}/p1`,undefined,x.owner);
    assert.equal((await x.call('POST','/api/commands/lost/reconcile',{},x.controller.token,403)).code,'GRANT_REQUIRED');
    assert.equal((await x.call('POST','/api/commands/lost/reconcile',{},x.owner,409)).code,'RECOVERY_NODE_UNAVAILABLE');
    await x.call('POST',`/api/admin/subjects/${x.node.subjectId}/revoke`,{},x.owner);
    assert.equal((await x.call('POST','/api/commands/lost/reconcile',{},x.owner,409)).code,'RECOVERY_NODE_UNAVAILABLE');
    assert.equal((await x.call('GET','/api/commands/lost',undefined,x.owner)).status,'unknown');
  }finally{await x.close();}
});

test('same-task and project create fences block different IDs; a late original receipt wins recovery race',async()=>{
  const x=await fixture();
  try{
    await x.call('POST','/api/node/snapshot',{...board(),epoch:1,sequence:1},x.node.token);
    const original=command('first','update');
    await x.call('POST','/api/commands',original,x.controller.token);
    assert.equal((await x.call('POST','/api/commands',command('second','update'),x.other.token,409)).code,'COMMAND_FENCED');
    assert.equal((await x.call('POST','/api/commands',original,x.controller.token)).status,'queued');
    await x.call('POST','/api/conversations',{projectId:'p1',commandId:'create-one',title:'One',message:'Start'},x.controller.token);
    assert.equal((await x.call('POST','/api/conversations',{projectId:'p1',commandId:'create-two',title:'Two',message:'Start'},x.other.token,409)).code,'CREATE_FENCED');
    await x.call('POST','/api/node/commands/first/claim',{},x.node.token);
    x.advance(301000);await x.call('GET','/api/commands/first',undefined,x.controller.token);
    await x.call('POST','/api/commands/first/reconcile',{},x.controller.token);
    await x.call('POST','/api/node/commands/first/receipt',{status:'running',result:{taskId:'t1',status:'running',revision:2,privatePath:'/secret'}},x.node.token);
    const late=await x.call('POST','/api/node/commands/first/reconcile',{outcome:'unknown',basis:'insufficient_evidence'},x.node.token);
    assert.equal(late.status,'running');assert.equal(late.recovery.outcome,'applied');assert.deepEqual(late.result,{taskId:'t1',status:'running',revision:2});
  }finally{await x.close();}
});

test('an inconclusive completed probe can be upgraded only by a valid late original success',async()=>{
  const x=await fixture();
  try{
    await x.call('POST','/api/node/snapshot',{...board(),epoch:1,sequence:1},x.node.token);
    await x.call('POST','/api/commands',command('late-after-check','update'),x.controller.token);
    await x.call('POST','/api/node/commands/late-after-check/claim',{},x.node.token);
    x.advance(301000);await x.call('GET','/api/commands/late-after-check',undefined,x.controller.token);
    await x.call('POST','/api/commands/late-after-check/reconcile',{},x.controller.token);
    const inconclusive=await x.call('POST','/api/node/commands/late-after-check/reconcile',{outcome:'unknown',basis:'insufficient_evidence'},x.node.token);
    assert.equal(inconclusive.recovery.outcome,'unknown');assert.ok(inconclusive.recovery.checkedAt);
    assert.equal((await x.call('POST','/api/node/commands/late-after-check/receipt',{status:'running',result:{}},x.node.token,400)).code,'INVALID_REQUEST');
    assert.equal((await x.call('POST','/api/node/commands/late-after-check/receipt',{status:'running',result:{status:'running'},error:'callback failed'},x.node.token,400)).code,'INVALID_REQUEST');
    const applied=await x.call('POST','/api/node/commands/late-after-check/receipt',{status:'running',result:{status:'blocked',revision:2}},x.node.token);
    assert.equal(applied.status,'running');assert.equal(applied.recovery.outcome,'applied');assert.equal(applied.recovery.basis,'durable_receipt');
    const duplicateProbe=await x.call('POST','/api/node/commands/late-after-check/reconcile',{outcome:'unknown',basis:'insufficient_evidence'},x.node.token);
    assert.equal(duplicateProbe.recovery.outcome,'applied');
  }finally{await x.close();}
});

for (const partialStatus of ['unknown','created']) test(`partial conversation creation (${partialStatus}) stays unknown and fences another create`,async()=>{
  const x=await fixture();let link;const calls=[];
  try{
    const pairing=await x.call('POST','/api/admin/pairings',{role:'node',projectIds:['p1']});
    await x.call('POST','/api/admin/subjects/'+x.node.subjectId+'/revoke',{});
    link=await createRemoteLink({dataDir:join(x.root,'node'),getState:()=>board(x.now()),getConversations:async()=>[],request:async()=>{calls.push(1);return {status:partialStatus,taskId:'partially-created'};}});
    await link.configure({url:x.hub.url,pairingCode:pairing.code,projectIds:['p1']});
    await x.call('POST','/api/conversations',{projectId:'p1',commandId:'partial',title:'Partial',message:'Start'},x.controller.token);
    await link.sync();
    assert.equal((await x.call('GET','/api/commands/partial',undefined,x.controller.token)).status,'unknown');
    assert.equal((await x.call('POST','/api/conversations',{projectId:'p1',commandId:'again',title:'Again',message:'Start'},x.controller.token,409)).code,'CREATE_FENCED');
    assert.equal(calls.length,1);
  }finally{await link?.close();await x.close();}
});

test('reopening an old Hub database adds recovery metadata without changing positional command rows',async()=>{
  const root=await mkdtemp(join(tmpdir(),'seqivo-recovery-schema-'));
  try{
    let store=new HubStore(root);
    const ownerToken=await readFile(store.bootstrap('migration-tenant').tokenPath,'utf8').then(s=>s.trim());
    const owner=store.authenticate(ownerToken);
    const nodePair=store.createPairing(owner,{role:'node',projectIds:['p1']});
    const controllerPair=store.createPairing(owner,{role:'controller',projectIds:['p1']});
    const node=store.authenticate(store.redeem(nodePair.code).token);
    const controller=store.authenticate(store.redeem(controllerPair.code).token);
    store.snapshot(node,{...board(),epoch:1,sequence:1});
    store.command(controller,command('retained','update'));
    const tables=['subjects','grants','snapshots','project_owners','commands'];
    const before=Object.fromEntries(tables.map(name=>[name,store.db.prepare(`SELECT * FROM ${name}`).all()]));
    store.db.exec('DROP TABLE command_recovery');store.close();
    store=new HubStore(root);
    for(const name of tables) assert.deepEqual(store.db.prepare(`SELECT * FROM ${name}`).all(),before[name],`${name} survives migration`);
    assert.equal(store.commandStatus(store.authenticate(ownerToken),'retained').status,'queued');
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='command_recovery'").get().name,'command_recovery');
    assert.equal(store.db.prepare('PRAGMA table_info(commands)').all().length,18);
    store.close();
  }finally{await rm(root,{recursive:true,force:true});}
});
