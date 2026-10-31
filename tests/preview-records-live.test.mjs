import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';
import { createHub } from '../server/hub/http.mjs';
import { startHttp } from '../server/http.mjs';

const node=process.execPath;
const vite=join(process.cwd(),'node_modules/vite/bin/vite.js');
const run=(command,args,cwd)=>execFileSync(command,args,{cwd,stdio:'pipe',timeout:30000});
const until=async(check)=>{const end=Date.now()+10000;while(Date.now()<end){try{const found=await check();if(found)return found;}catch{}await new Promise(resolve=>setTimeout(resolve,40));}throw Error('Preview integration timed out');};

test('real Core, Hub and local adapter persist records-v1 and fence closed data access',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-records-live-'));
  let core,hub,local;
  t.after(async()=>{const errors=[];
    for(const close of [()=>local?.close(),()=>core?.close(),()=>hub?.close()])try{await close();}catch(error){errors.push(error);}
    if(!errors.length)try{await rm(root,{recursive:true,force:true});}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Preview live cleanup failed');
  });
  const projectDir=join(root,'project');await mkdir(projectDir);
  await writeFile(join(projectDir,'.gitignore'),'dist/\n');
  await writeFile(join(projectDir,'index.html'),'<!doctype html><button id="save">Save</button><script type="module" src="./main.js"></script>');
  await writeFile(join(projectDir,'main.js'),'document.querySelector("#save").onclick=()=>{};');
  run('git',['init','-q'],projectDir);run('git',['config','user.email','preview@example.test'],projectDir);
  run('git',['config','user.name','Preview Test'],projectDir);run('git',['add','.'],projectDir);
  run('git',['commit','-qm','Initial'],projectDir);run(node,[vite,'build','--base','./'],projectDir);
  hub=await createHub({dataDir:join(root,'hub'),port:0});
  core=await createCore({dataDir:join(root,'core'),pluginDir:join(root,'plugins'),files:false});
  const project=core.store.project({name:'Dynamic records',directory:projectDir});
  const task=core.store.createTask({projectId:project.id,title:'Save a record'});
  const username='records_user',password='LocalTest-password-239';
  const account=await hub.accounts.register({username,password,source:'isolated'});
  const cookie=`hub_session=${account.sessionToken}`;
  const call=async(method,path,body,headers={})=>{
    const response=await fetch(hub.url+path,{method,headers:Object.fromEntries(Object.entries({Cookie:cookie,Origin:hub.url,
      ...(body?{'Content-Type':'application/json'}:{}),...headers}).filter(([,value])=>value!==undefined)),
      ...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:response.status===204?null:await response.json(),headers:response.headers};
  };
  await core.remote.login({url:hub.url,username,password,projectIds:[project.id]});
  await until(()=>hub.store.db.prepare('SELECT received_at FROM snapshots').get()?.received_at);
  const registered=await core.request('POST','/api/preview/builds',{projectId:project.id,taskId:task.id,
    contentVersion:1,distDir:join(projectDir,'dist'),environment:'test',dataMode:'real',apiTarget:'records-v1'});
  const manifest=registered.preview,id=manifest.previewId;
  assert.equal(manifest.apiTarget,'records-v1');assert.equal(manifest.capability,'records-v1');
  assert.equal(manifest.dataStoreId?.length>0,true);
  const intent=(await call('POST',`/api/previews/${id}/access-intents`,{})).data.intent;
  const issued=await call('POST',`/api/previews/${id}/access-intents/${intent.id}/issue`,{});
  assert.equal(issued.status,200,JSON.stringify(issued.data));
  assert.match(issued.data.dataCapability,/^[A-Za-z0-9_-]{43}$/);
  const dataPath=`/api/previews/${id}/data/records`;
  const dataHeaders={Origin:'null',Cookie:undefined,'X-Seqivo-Preview-Data':issued.data.dataCapability};
  const preflight=await call('OPTIONS',dataPath,undefined,{Origin:'null',Cookie:undefined,
    'Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'content-type, x-seqivo-preview-data'});
  assert.equal(preflight.status,204);
  const first=await call('POST',dataPath,{clientMutationId:'save1',title:'真实保存'},dataHeaders);
  assert.equal(first.status,200,JSON.stringify(first.data));
  assert.equal(first.data.record.title,'真实保存');
  for(const headers of [
    {...dataHeaders,Cookie:cookie},
    {...dataHeaders,Authorization:'Bearer invalid'},
    {...dataHeaders,Origin:hub.url},
    {...dataHeaders,'X-Seqivo-Preview-Data':'A'.repeat(43)},
  ]){
    const denied=await call('POST',dataPath,{clientMutationId:'denied',title:'Denied'},headers);
    assert.equal(denied.status,403,JSON.stringify(denied.data));
  }
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n,1);
  const listing=await call('GET',dataPath,undefined,dataHeaders);
  assert.equal(listing.status,200,JSON.stringify(listing.data));
  assert.equal(listing.data.records.length,1);assert.equal(listing.data.records[0].id,first.data.record.id);
  const recovery=`/api/previews/${id}/data/stores/${manifest.dataStoreId}/operations/by-key/save1`;
  const known=await call('GET',recovery);
  assert.equal(known.status,200);assert.equal(known.data.operation.state,'confirmed');
  assert.equal(known.data.operation.recordId,first.data.record.id);
  const changed=await call('POST',dataPath,{clientMutationId:'save1',title:'changed'},dataHeaders);
  assert.equal(changed.status,409);assert.equal(changed.data.code,'PREVIEW_RECORD_CONFLICT');
  const secondSession=await hub.accounts.login({username,password,source:'isolated'});
  assert.equal((await call('GET',recovery,undefined,{Cookie:`hub_session=${secondSession.sessionToken}`})).data.operation.state,'confirmed');
  const otherAccount=await hub.accounts.register({username:'records_other',password,source:'isolated'});
  assert.notEqual((await call('GET',recovery,undefined,{Cookie:`hub_session=${otherAccount.sessionToken}`})).status,200);
  const missing=await call('GET',recovery.replace('save1','missing'));
  assert.equal(missing.status,404);assert.equal(missing.data.code,'PREVIEW_RECORD_UNKNOWN');
  const missingReconcile=await call('POST',recovery.replace('save1','missing')+'/reconcile',{});
  assert.equal(missingReconcile.status,404);assert.equal(missingReconcile.data.code,'PREVIEW_RECORD_UNKNOWN');
  const originalGet=core.previewRegistry.get;
  let releaseCreate,enteredCreate=false;
  const gate=new Promise(resolve=>{releaseCreate=resolve;});
  core.previewRegistry.get=async previewId=>{if(previewId===id){enteredCreate=true;await gate;}
    return originalGet(previewId);};
  let inFlight;
  try{
    inFlight=call('POST',dataPath,{clientMutationId:'save2',title:'Admitted before close'},dataHeaders);
    await until(()=>enteredCreate);
    await until(()=>hub.store.db.prepare(`SELECT status FROM preview_record_operations
      WHERE preview_id=? AND client_mutation_id='save2'`).get(id)?.status==='dispatched');
    const closing=await call('POST',`/api/previews/${id}/access-intents/${intent.id}/close`,{});
    assert.equal(closing.status,200);assert.equal(closing.data.inactive,true);
    assert.equal(closing.data.dataWrites,'unknown');
  }finally{releaseCreate();core.previewRegistry.get=originalGet;}
  const late=await inFlight;
  assert.equal(late.status,403,'closed cap must not return in-flight record bytes');
  const lateKnown=await call('GET',recovery.replace('save1','save2'));
  assert.equal(lateKnown.status,200);assert.equal(lateKnown.data.operation.state,'confirmed');
  assert.equal(hub.store.db.prepare("SELECT count(*) AS n FROM preview_record_operations WHERE status='confirmed'").get().n,2);
  const postClose=await call('POST',dataPath,{clientMutationId:'save3',title:'Too late'},dataHeaders);
  assert.equal(postClose.status,403);
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n,2);
  const closed=await call('POST',`/api/previews/${id}/access-intents/${intent.id}/close`,{});
  assert.equal(closed.status,200);assert.equal(closed.data.inactive,true);
  assert.equal((await call('GET',dataPath,undefined,dataHeaders)).status,403);
  assert.equal((await call('GET',recovery)).data.operation.state,'confirmed');
  local=await startHttp({core,dataDir:join(root,'core'),distDir:root,port:0});
  const localOrigin=`http://127.0.0.1:${local.port}`;
  const localCall=async(method,path,body,headers={})=>{const response=await fetch(localOrigin+path,{method,
    headers:Object.fromEntries(Object.entries({Origin:localOrigin,Authorization:`Bearer ${local.tokens.owner}`,
      ...(body?{'Content-Type':'application/json'}:{}),...headers}).filter(([,value])=>value!==undefined)),
    ...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,data:response.status===204?null:await response.json()};};
  const localIntent=(await localCall('POST',`/api/previews/${id}/access-intents`,{})).data.intent;
  const localIssue=await localCall('POST',`/api/previews/${id}/access-intents/${localIntent.id}/issue`,{});
  assert.equal(localIssue.status,200);
  const localData={Origin:'null',Authorization:undefined,'X-Seqivo-Preview-Data':localIssue.data.dataCapability};
  const localList=await localCall('GET',dataPath,undefined,localData);
  assert.equal(localList.status,200,JSON.stringify(localList.data));
  assert.equal(localList.data.records[0].id,first.data.record.id);
  const localWrite=await localCall('POST',dataPath,{clientMutationId:'local1',title:'本机保存'},localData);
  assert.equal(localWrite.status,200,JSON.stringify(localWrite.data));
  assert.equal((await localCall('GET',dataPath,undefined,localData)).data.records.length,3);
  const viewerIntent=(await localCall('POST',`/api/previews/${id}/access-intents`,{},
    {Authorization:`Bearer ${local.tokens.viewer}`})).data.intent;
  const viewerIssue=await localCall('POST',`/api/previews/${id}/access-intents/${viewerIntent.id}/issue`,{},
    {Authorization:`Bearer ${local.tokens.viewer}`});
  assert.equal(viewerIssue.status,200);
  const viewerData={Origin:'null',Authorization:undefined,'X-Seqivo-Preview-Data':viewerIssue.data.dataCapability};
  assert.equal((await localCall('GET',dataPath,undefined,viewerData)).status,200);
  assert.equal((await localCall('POST',dataPath,{clientMutationId:'viewer1',title:'Denied'},viewerData)).status,403);
  assert.equal((await localCall('GET','/api/state',undefined,{Origin:'null'})).status,403);
  const quotaIntent=(await call('POST',`/api/previews/${id}/access-intents`,{})).data.intent;
  const quotaIssue=await call('POST',`/api/previews/${id}/access-intents/${quotaIntent.id}/issue`,{});
  assert.equal(quotaIssue.status,200);
  const quotaHeaders={Origin:'null',Cookie:undefined,'X-Seqivo-Preview-Data':quotaIssue.data.dataCapability};
  const beforeLimit=hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n;
  const fill=100000-beforeLimit;
  hub.store.db.prepare(`WITH RECURSIVE seq(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM seq WHERE x<?)
    INSERT INTO preview_record_operations
    SELECT 'quota_'||x,'quota_other','quota_store','quota_tenant','quota_actor','quota_session',
      'quota_mutation_'||x,?, 'fixture','quota_node',1,1,x,'not_applied',NULL,1 FROM seq`)
    .run(fill,'a'.repeat(64));
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n,100000);
  const full=await call('POST',dataPath,{clientMutationId:'overlimit',title:'Must not create'},quotaHeaders);
  assert.equal(full.status,429,JSON.stringify(full.data));
  assert.equal(full.data.code,'PREVIEW_RECORD_OPERATION_LIMIT');
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n,100000);
  assert.equal((await localCall('GET',dataPath,undefined,localData)).data.records.length,3);
  const exactAtLimit=await call('POST',dataPath,{clientMutationId:'save1',title:'真实保存'},quotaHeaders);
  assert.equal(exactAtLimit.status,200,JSON.stringify(exactAtLimit.data));
  assert.equal(exactAtLimit.data.record.id,first.data.record.id);
  assert.equal((await call('GET',recovery)).data.operation.state,'confirmed');
  assert.equal((await call('POST',recovery+'/reconcile',{})).data.operation.state,'confirmed');
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n,100000);
  await local.close();local=null;await core.close();core=null;
  core=await createCore({dataDir:join(root,'core'),pluginDir:join(root,'plugins'),files:false});
  const after=await core.previewLocal.request('GET',`/api/previews/${id}/data/stores/${manifest.dataStoreId}/operations/by-key/local1`,{},'owner');
  assert.equal(after.operation.state,'confirmed');
  await hub.close();hub=null;
  hub=await createHub({dataDir:join(root,'hub'),port:0});
  const afterHubRestart=await call('GET',recovery.replace('save1','save2'));
  assert.equal(afterHubRestart.status,200,JSON.stringify(afterHubRestart.data));
  assert.equal(afterHubRestart.data.operation.state,'confirmed');
  assert.equal((await call('GET',recovery.replace('save1','missing'))).status,404);
});
