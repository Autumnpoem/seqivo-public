import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, BoardError, confirmedReviewRejectionCode } from '../server/store.mjs';
import { createHub } from '../server/hub/http.mjs';
import { createRemoteLink } from '../server/remote-client.mjs';

async function localFixture(){
  const root=await mkdtemp(join(tmpdir(),'seqivo-review-reject-'));
  const store=new Store(join(root,'board.sqlite'));
  const project=store.project({name:'Review project',goal:'Test',directory:root});
  return {root,store,project,close:async()=>{store.close();await rm(root,{recursive:true,force:true});}};
}

test('only four write-before-pass checks gain proof after a successful top-level rollback',async()=>{
  const x=await localFixture();
  try{
    const cases=[];
    const draft=x.store.createTask({projectId:x.project.id,title:'Draft',goal:'Test',criteria:['Works']});
    cases.push([draft,'REVIEW_NOT_SUBMITTED']);
    const noCriteria=x.store.createTask({projectId:x.project.id,title:'No criteria',goal:'Test'});
    x.store.updateTask(noCriteria.id,{status:'submitted'},noCriteria.revision);
    cases.push([x.store.getTask(noCriteria.id),'REVIEW_CRITERIA_REQUIRED']);
    const noEvidence=x.store.createTask({projectId:x.project.id,title:'No evidence',goal:'Test',criteria:['Works']});
    x.store.updateTask(noEvidence.id,{status:'submitted'},noEvidence.revision);
    cases.push([x.store.getTask(noEvidence.id),'REVIEW_CURRENT_EVIDENCE_REQUIRED']);
    const issue=x.store.createTask({projectId:x.project.id,title:'Open issue',goal:'Test',criteria:['Works']});
    x.store.updateTask(issue.id,{status:'submitted'},issue.revision);
    x.store.addEvidence(issue.id,{summary:'Evidence',reference:'local',expectedRevision:x.store.getTask(issue.id).revision});
    x.store.review(issue.id,{decision:'fail',summary:'Open problem',expectedRevision:x.store.getTask(issue.id).revision});
    cases.push([x.store.getTask(issue.id),'REVIEW_OPEN_ISSUES']);
    for(const [task,code] of cases){
      const before=x.store.getTask(task.id),events=x.store.events();
      assert.throws(()=>x.store.review(task.id,{decision:'pass',summary:'Accept',expectedRevision:before.revision}),error=>{
        assert.equal(error.code,code);assert.equal(confirmedReviewRejectionCode(error,task.id),code);return true;
      });
      assert.deepEqual(x.store.getTask(task.id),before);assert.deepEqual(x.store.events(),events);
    }
    const forged=new BoardError('缺少当前版本的验收证据',409,'REVIEW_CURRENT_EVIDENCE_REQUIRED');
    assert.equal(confirmedReviewRejectionCode(forged),null);
    let nested;
    assert.throws(()=>x.store.transaction(()=>x.store.review(noEvidence.id,{decision:'pass',summary:'Accept',expectedRevision:x.store.getTask(noEvidence.id).revision})),error=>{
      nested=error;return true;
    });
    assert.equal(confirmedReviewRejectionCode(nested),null);
  }finally{await x.close();}
});

test('rollback failure, commit failure and post-commit listener error never become a confirmed rejection',async()=>{
  const x=await localFixture();
  try{
    const task=x.store.createTask({projectId:x.project.id,title:'Task',goal:'Test',criteria:['Works']});
    x.store.updateTask(task.id,{status:'submitted'},task.revision);
    const original=x.store.db.exec.bind(x.store.db);
    x.store.db.exec=sql=>sql==='ROLLBACK'?(()=>{throw new Error('rollback unavailable');})():original(sql);
    let rollbackError;
    try{x.store.review(task.id,{decision:'pass',summary:'Accept',expectedRevision:x.store.getTask(task.id).revision});}
    catch(error){rollbackError=error;}
    finally{x.store.db.exec=original;original('ROLLBACK');}
    assert.equal(rollbackError.message,'rollback unavailable');assert.equal(confirmedReviewRejectionCode(rollbackError),null);
    x.store.addEvidence(task.id,{summary:'Evidence',reference:'local',expectedRevision:x.store.getTask(task.id).revision});
    x.store.db.exec=sql=>sql==='COMMIT'?(()=>{throw new Error('commit unavailable');})():original(sql);
    let commitError;
    try{x.store.review(task.id,{decision:'pass',summary:'Accept',expectedRevision:x.store.getTask(task.id).revision});}
    catch(error){commitError=error;}
    finally{x.store.db.exec=original;}
    assert.equal(commitError.message,'commit unavailable');assert.equal(confirmedReviewRejectionCode(commitError),null);
    assert.equal(x.store.getTask(task.id).acceptance,'unverified');
    x.store.on('change',()=>{throw new Error('listener unavailable');});
    let listenerError;
    try{x.store.review(task.id,{decision:'pass',summary:'Accept',expectedRevision:x.store.getTask(task.id).revision});}
    catch(error){listenerError=error;}
    assert.equal(listenerError.message,'listener unavailable');assert.equal(confirmedReviewRejectionCode(listenerError),null);
    assert.equal(x.store.getTask(task.id).acceptance,'passed');
  }finally{await x.close();}
});

async function remoteFixture(){
  const x=await localFixture();let clock=Date.now();
  const task=x.store.createTask({projectId:x.project.id,title:'Submitted task',goal:'Test',criteria:['Works']});
  x.store.updateTask(task.id,{status:'submitted'},task.revision);
  const hub=await createHub({dataDir:join(x.root,'hub'),host:'127.0.0.1',port:0,now:()=>clock});
  const owner=await readFile(hub.store.bootstrap('review-tenant').tokenPath,'utf8').then(s=>s.trim());
  async function call(method,path,body,secret=owner,expected=200){
    const response=await fetch(`${hub.url}${path}`,{method,headers:{Authorization:`Bearer ${secret}`,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const data=await response.json();assert.equal(response.status,expected,JSON.stringify(data));return data;
  }
  const nodePair=await call('POST','/api/admin/pairings',{role:'node',projectIds:[x.project.id]});
  const controllerPair=await call('POST','/api/admin/pairings',{role:'controller',projectIds:[x.project.id]});
  const controller=await call('POST','/api/pairings/redeem',{code:controllerPair.code});
  let link;const calls=[];
  function linkOptions(request){return {dataDir:join(x.root,'node'),now:()=>clock,getState:()=>({projects:x.store.projects(),tasks:x.store.tasks()}),request:request||((method,path,body)=>{
    const action=path.endsWith('/review')?'review':path.endsWith('/evidence')?'evidence':'other';calls.push(action);
    return action==='review'?x.store.review(task.id,body):x.store.addEvidence(task.id,body);
  })};}
  link=await createRemoteLink(linkOptions());
  await link.configure({url:hub.url,pairingCode:nodePair.code,projectIds:[x.project.id]});
  return {...x,task,hub,owner,controller,call,calls,linkOptions,get link(){return link;},set link(value){link=value;},
    advance:ms=>{clock+=ms;},expiry:()=>new Date(clock+60000).toISOString(),
    command:(id,action,body,revision=x.store.getTask(task.id).revision)=>({commandId:id,projectId:x.project.id,taskId:task.id,action,expectedRevision:revision,expiresAt:new Date(clock+60000).toISOString(),body}),
    close:async()=>{await link?.close();await hub.close();await x.close();}};
}

test('confirmed missing-evidence rejection has no review write, releases fence and permits evidence then review',async()=>{
  const x=await remoteFixture();
  try{
    const before=x.store.getTask(x.task.id),events=x.store.events();
    await x.call('POST','/api/commands',x.command('reject','review',{decision:'pass',summary:'Accept'}),x.controller.token);
    await x.link.sync();
    const denied=await x.call('GET','/api/commands/reject',undefined,x.controller.token);
    assert.equal(denied.status,'failed');assert.deepEqual(denied.result,{taskId:x.task.id,status:'rejected',failureCode:'REVIEW_CURRENT_EVIDENCE_REQUIRED'});
    assert.equal(denied.error,'Review rejected before change');assert.equal(x.calls.filter(value=>value==='review').length,1);
    assert.deepEqual(x.store.getTask(x.task.id),before);assert.deepEqual(x.store.events(),events);
    await x.call('POST','/api/commands',x.command('add-evidence','evidence',{summary:'Test output',reference:'local'}),x.controller.token);
    await x.link.sync();assert.equal((await x.call('GET','/api/commands/add-evidence',undefined,x.controller.token)).status,'running');
    await x.call('POST','/api/commands',x.command('accept','review',{decision:'pass',summary:'Accepted'}),x.controller.token);
    await x.link.sync();
    assert.equal((await x.call('GET','/api/commands/accept',undefined,x.controller.token)).status,'running');
    assert.equal(x.store.getTask(x.task.id).acceptance,'passed');
    assert.equal(x.calls.filter(value=>value==='review').length,2);
  }finally{await x.close();}
});

test('lost rejection receipt recovers the same ID after restart without review replay',async()=>{
  const x=await remoteFixture();
  try{
    await x.call('POST','/api/commands',x.command('lost-rejection','review',{decision:'pass',summary:'Accept'}),x.controller.token);
    const originalFetch=globalThis.fetch;
    try{globalThis.fetch=(url,options)=>String(url).endsWith('/api/node/commands/lost-rejection/receipt')?Promise.reject(new Error('Hub ACK lost')):originalFetch(url,options);await x.link.sync();}
    finally{globalThis.fetch=originalFetch;}
    const saved=JSON.parse(await readFile(join(x.root,'node','remote-link.json'),'utf8'));
    assert.equal(saved.receipts['lost-rejection'].phase,'done');assert.equal(saved.receipts['lost-rejection'].status,'failed');
    assert.equal(saved.receipts['lost-rejection'].reviewBinding.commandId,'lost-rejection');
    await x.link.close();x.link=null;
    x.advance(301000);
    assert.equal((await x.call('GET','/api/commands/lost-rejection',undefined,x.controller.token)).status,'unknown');
    await x.call('POST','/api/commands/lost-rejection/reconcile',{},x.controller.token);
    x.link=await createRemoteLink(x.linkOptions());
    await x.link.sync();
    const recovered=await x.call('GET','/api/commands/lost-rejection',undefined,x.controller.token);
    assert.equal(recovered.status,'failed');assert.equal(recovered.recovery.outcome,'not_applied');assert.equal(recovered.recovery.basis,'transaction_rollback');
    assert.equal(recovered.result.failureCode,'REVIEW_CURRENT_EVIDENCE_REQUIRED');
    assert.equal(x.calls.filter(value=>value==='review').length,1);
  }finally{await x.close();}
});

test('forged and wrong-action rejection receipts are denied; old unknown remains unknown',async()=>{
  const x=await remoteFixture();
  try{
    const nodeToken=JSON.parse(await readFile(join(x.root,'node','remote-link.json'),'utf8')).token;
    await x.call('POST','/api/commands',x.command('forged','review',{decision:'pass',summary:'Accept'}),x.controller.token);
    await x.call('POST','/api/node/commands/forged/claim',{},nodeToken);
    await x.call('POST','/api/node/commands/forged/sending',{},nodeToken);
    const valid={taskId:x.task.id,status:'rejected',failureCode:'REVIEW_CURRENT_EVIDENCE_REQUIRED'};
    for(const result of [{...valid,failureCode:'NOT_ALLOWED'},{...valid,taskId:'wrong'},{...valid,detail:'/secret/path'}])
      await x.call('POST','/api/node/commands/forged/receipt',{status:'failed',result},nodeToken,400);
    await x.call('POST','/api/commands',x.command('wrong-action','update',{}),x.controller.token,409); // original sending write fence
    x.advance(301000);await x.call('GET','/api/commands/forged',undefined,x.controller.token);
    await x.call('POST','/api/commands/forged/reconcile',{},x.controller.token);
    for(const result of [{...valid,failureCode:'NOT_ALLOWED'},{...valid,taskId:'wrong'}])
      await x.call('POST','/api/node/commands/forged/reconcile',{outcome:'not_applied',basis:'transaction_rollback',result},nodeToken,400);
    await x.call('POST','/api/node/commands/forged/reconcile',{outcome:'unknown',basis:'insufficient_evidence'},nodeToken);
    assert.equal((await x.call('GET','/api/commands/forged',undefined,x.controller.token)).status,'unknown');
    assert.equal(x.calls.length,0);
  }finally{await x.close();}
});

test('review fail decision cannot use rollback rejection proof in receipt or recovery',async()=>{
  const x=await remoteFixture();
  try{
    const nodeToken=JSON.parse(await readFile(join(x.root,'node','remote-link.json'),'utf8')).token;
    await x.call('POST','/api/commands',x.command('fail-decision','review',{decision:'fail',summary:'Needs work'}),x.controller.token);
    await x.call('POST','/api/node/commands/fail-decision/claim',{},nodeToken);
    await x.call('POST','/api/node/commands/fail-decision/sending',{},nodeToken);
    const result={taskId:x.task.id,status:'rejected',failureCode:'REVIEW_CURRENT_EVIDENCE_REQUIRED'};
    await x.call('POST','/api/node/commands/fail-decision/receipt',{status:'failed',result},nodeToken,400);
    x.advance(301000);
    assert.equal((await x.call('GET','/api/commands/fail-decision',undefined,x.controller.token)).status,'unknown');
    await x.call('POST','/api/commands/fail-decision/reconcile',{},x.controller.token);
    await x.call('POST','/api/node/commands/fail-decision/reconcile',{outcome:'not_applied',basis:'transaction_rollback',result},nodeToken,400);
    const pending=await x.call('GET','/api/node/commands',undefined,nodeToken);
    assert.equal(pending.recoveryProbes.find(probe=>probe.commandId==='fail-decision')?.reviewDecision,'fail');
    await x.link.sync();
    await x.call('POST','/api/commands',x.command('after-fail','evidence',{summary:'Evidence',reference:'local'}),x.controller.token,409);
    const command=await x.call('GET','/api/commands/fail-decision',undefined,x.controller.token);
    assert.equal(command.status,'unknown');assert.equal(command.recovery.outcome,'unknown');
    assert.equal(x.calls.length,0);
  }finally{await x.close();}
});

test('non-review command cannot use rollback rejection proof',async()=>{
  const x=await remoteFixture();
  try{
    const nodeToken=JSON.parse(await readFile(join(x.root,'node','remote-link.json'),'utf8')).token;
    await x.call('POST','/api/commands',x.command('update-command','update',{title:'Change'}),x.controller.token);
    await x.call('POST','/api/node/commands/update-command/claim',{},nodeToken);
    await x.call('POST','/api/node/commands/update-command/sending',{},nodeToken);
    const result={taskId:x.task.id,status:'rejected',failureCode:'REVIEW_CURRENT_EVIDENCE_REQUIRED'};
    await x.call('POST','/api/node/commands/update-command/receipt',{status:'failed',result},nodeToken,400);
    x.advance(301000);await x.call('GET','/api/commands/update-command',undefined,x.controller.token);
    await x.call('POST','/api/commands/update-command/reconcile',{},x.controller.token);
    await x.call('POST','/api/node/commands/update-command/reconcile',{outcome:'not_applied',basis:'transaction_rollback',result},nodeToken,400);
    assert.equal((await x.call('GET','/api/commands/update-command',undefined,x.controller.token)).status,'unknown');
  }finally{await x.close();}
});

test('a generic BoardError with a matching code remains unknown',async()=>{
  const x=await remoteFixture();
  try{
    await x.link.close();
    x.link=await createRemoteLink(x.linkOptions(()=>{throw new BoardError('same code, no rollback proof',409,'REVIEW_CURRENT_EVIDENCE_REQUIRED');}));
    await x.call('POST','/api/commands',x.command('generic-error','review',{decision:'pass',summary:'Accept'}),x.controller.token);
    await x.link.sync();
    const command=await x.call('GET','/api/commands/generic-error',undefined,x.controller.token);
    assert.equal(command.status,'unknown');assert.equal(command.result,null);
    assert.equal(x.store.getTask(x.task.id).acceptance,'unverified');
  }finally{await x.close();}
});

test('review rollback receipt is denied after creator grant or node epoch changes',async()=>{
  for(const change of ['creator-grant','node-epoch']){
    const x=await remoteFixture();
    try{
      const nodeState=JSON.parse(await readFile(join(x.root,'node','remote-link.json'),'utf8'));
      const result={taskId:x.task.id,status:'rejected',failureCode:'REVIEW_CURRENT_EVIDENCE_REQUIRED'};
      await x.call('POST','/api/commands',x.command(`changed-${change}`,'review',{decision:'pass',summary:'Accept'}),x.controller.token);
      await x.call('POST',`/api/node/commands/changed-${change}/claim`,{},nodeState.token);
      await x.call('POST',`/api/node/commands/changed-${change}/sending`,{},nodeState.token);
      if(change==='creator-grant') await x.call('DELETE',`/api/admin/grants/${x.controller.subjectId}/${x.project.id}`,undefined,x.owner);
      else await x.call('POST','/api/admin/grants',{subjectId:nodeState.nodeId,projectId:'other-project'},x.owner);
      await x.call('POST',`/api/node/commands/changed-${change}/receipt`,{status:'failed',result},nodeState.token,403);
    }finally{await x.close();}
  }
});
