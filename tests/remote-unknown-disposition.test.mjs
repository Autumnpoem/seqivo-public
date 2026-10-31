import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHub} from '../server/hub/http.mjs';
import {createRemoteLink} from '../server/remote-client.mjs';

test('returned unknown disposition retries only its receipt before any new instruction after lost ACK',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seqivo-remote-disposition-'));
  const hub=await createHub({dataDir:join(root,'hub')});
  const owner=(await readFile(hub.store.bootstrap('disposable').tokenPath,'utf8')).trim();
  const originalFetch=globalThis.fetch;
  const call=async(method,path,body,token=owner)=>{
    const response=await originalFetch(hub.url+path,{method,headers:{Authorization:`Bearer ${token}`,
      ...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;
  };
  const ready={state:'ready',reasonCode:null};
  const gate=()=>({v:1,bootId:'disposition-test',observedAt:new Date().toISOString(),taskRevision:1,contentVersion:1,
    message:ready,continue:ready,start:ready});
  let returned=false,calls=0,link;
  const proof={v:1,dispositionId:'explicit-original',projectId:'p1',taskId:'t1',localCommandId:'old-root',
    controlGeneration:2,returnedGeneration:2,providerOutcome:'unknown'};
  t.after(async()=>{globalThis.fetch=originalFetch;await link?.close();await hub.close();await rm(root,{recursive:true,force:true});});
  link=await createRemoteLink({dataDir:join(root,'node'),getConversations:async()=>[],
    getState:()=>({projects:[{id:'p1',name:'Disposable'}],tasks:[{id:'t1',projectId:'p1',title:'Task',status:'blocked',
      revision:1,contentVersion:1,executionWrite:gate()}]}),
    getReturnedDispositions:({commandId,dispatchBinding})=>{
      if(commandId!=='old-root'||!returned)return [];
      assert.equal(dispatchBinding.commandId,'old-root');assert.equal(dispatchBinding.action,'message');
      assert.equal(dispatchBinding.projectId,'p1');assert.equal(dispatchBinding.taskId,'t1');
      assert.equal(dispatchBinding.nodeId,link.terminalCredentials().nodeId);
      assert.equal(dispatchBinding.epoch,link.terminalCredentials().epoch);
      return [proof];
    },request:async()=>{calls++;return {taskId:'t1',status:'running'};}});
  const pair=await call('POST','/api/admin/pairings',{role:'node',projectIds:['p1']});
  await link.configure({url:hub.url,pairingCode:pair.code,projectIds:['p1']});
  const controllerPair=await call('POST','/api/admin/pairings',{role:'controller',projectIds:['p1']});
  const controller=await call('POST','/api/pairings/redeem',{code:controllerPair.code});
  const command=commandId=>({commandId,projectId:'p1',taskId:'t1',action:'message',expectedRevision:1,
    expiresAt:new Date(Date.now()+60000).toISOString(),body:{message:'A separate explicit instruction'}});
  const originalCommand=command('old-root');
  await call('POST','/api/commands',originalCommand,controller.token);
  await link.sync();assert.equal(calls,1);
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM continue_leases').get().n,1);
  await link.sync();
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM command_dispositions').get().n,0,'human phase is not reported');
  returned=true;
  let lost=0;
  globalThis.fetch=async(url,options)=>{
    const response=await originalFetch(url,options);
    if(String(url).endsWith('/old-root/dispose-unknown')){await response.arrayBuffer();lost++;throw new Error('Simulated lost ACK after Hub commit');}
    return response;
  };
  await link.sync();assert.equal(lost,1);
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM command_dispositions').get().n,1);
  await call('POST','/api/commands',command('new-root'),controller.token);
  returned=false;
  await link.sync();assert.equal(calls,1,'a pending exact receipt still fences new work while human control resumes');
  assert.equal(lost,1,'a missing current return does not authorize another resolution send');
  returned=true;
  await link.sync();assert.equal(lost,2);assert.equal(calls,1,'new work waits for exact old receipt acknowledgement');
  globalThis.fetch=originalFetch;
  await link.sync();assert.equal(calls,2);
  const old=await call('GET','/api/commands/old-root',undefined,controller.token);
  assert.equal(old.status,'running');assert.equal(old.result.status,'running','original dispatch result is preserved');
  await call('POST','/api/commands',originalCommand,controller.token);await link.sync();assert.equal(calls,2,'old ID never replays');
  const saved=JSON.parse(await readFile(join(root,'node','remote-link.json'),'utf8'));
  assert.equal(saved.receipts['old-root'].unknownDisposition.acknowledged,true);
  assert.equal(saved.receipts['new-root'].unknownDisposition,undefined);
});
