import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {Store} from '../server/store.mjs';
import {HubStore} from '../server/hub/store.mjs';
import {AccountService} from '../server/hub/accounts.mjs';
import {createLocalPreview} from '../server/preview/local.mjs';
import {createPreviewHub} from '../server/hub/preview.mjs';
import {createPreviewNodeLink} from '../server/preview/node-link.mjs';

const sample=(store)=>{
  const project=store.project({name:'Recovery project'}),source=store.createTask({projectId:project.id,title:'Source'});
  const manifest={v:1,previewId:'preview1',projectId:project.id,taskId:source.id,contentVersion:1,
    sourceCommit:'a'.repeat(40),dirtyDigest:'b'.repeat(64),dirty:false,artifactDigest:'c'.repeat(64),
    environment:'test',dataMode:'simulated',capability:'static-interactive',backendApi:'unsupported',
    files:[],createdAt:Date.now()};
  const input=(id)=>({idempotencyKey:id,projectId:project.id,sourcePreview:manifest,pagePath:'index.html',
    summary:'Button failed',criterionIds:[],criterionItems:[],reporterUserId:'local_owner'});
  return {project,source,manifest,input};
};

test('Core permanent outcome survives task deletion, source deletion and restart; absent fence rejects late create',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-feedback-store-')),path=join(root,'board.sqlite');
  let store=new Store(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const {source,input}=sample(store),first=store.createPreviewFeedbackTask(input('done'));
  assert.equal(store.reconcilePreviewFeedbackTask(input('done'),{allowFence:true}).status,'confirmed');
  assert.throws(()=>store.reconcilePreviewFeedbackTask({...input('done'),summary:'Different report'},
    {allowFence:true}),{code:'PREVIEW_FEEDBACK_CONFLICT'});
  store.db.prepare('DELETE FROM tasks WHERE id=?').run(first.id);
  store.db.prepare('DELETE FROM tasks WHERE id=?').run(source.id);
  assert.deepEqual(store.reconcilePreviewFeedbackTask(input('done'),{allowFence:true}),
    {status:'created_unavailable',taskId:first.id});
  assert.throws(()=>store.createPreviewFeedbackTask(input('done')),{code:'PREVIEW_FEEDBACK_CREATED_UNAVAILABLE'});
  assert.deepEqual(store.reconcilePreviewFeedbackTask(input('late'),{allowFence:true}),{status:'not_applied'});
  assert.throws(()=>store.reconcilePreviewFeedbackTask({...input('late'),summary:'Different report'},
    {allowFence:true}),{code:'PREVIEW_FEEDBACK_CONFLICT'});
  assert.throws(()=>store.createPreviewFeedbackTask(input('late')),{code:'PREVIEW_FEEDBACK_NOT_APPLIED'});
  const identity=store.previewFeedbackStoreId();store.close();store=new Store(path);
  assert.equal(store.previewFeedbackStoreId(),identity);
  assert.equal(store.reconcilePreviewFeedbackTask(input('done')).status,'created_unavailable');
  assert.equal(store.reconcilePreviewFeedbackTask(input('late')).status,'not_applied');
  assert.equal(store.reconcilePreviewFeedbackTask(input('legacy'),{allowFence:false}).status,'unknown');
});

test('Core archive restore retains later created outcome and migrates only provable old receipts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-feedback-restore-')),path=join(root,'board.sqlite');
  let store=new Store(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const {project,input}=sample(store),archive=store.exportArchive();
  const created=store.createPreviewFeedbackTask(input('restored'));
  assert.equal(coreTaskCount(),2);
  store.restoreArchive(archive);
  assert.equal(coreTaskCount(),1);
  assert.deepEqual(store.reconcilePreviewFeedbackTask(input('restored')),
    {status:'created_unavailable',taskId:created.id});
  assert.throws(()=>store.createPreviewFeedbackTask(input('restored')),{code:'PREVIEW_FEEDBACK_CREATED_UNAVAILABLE'});
  const present=store.createPreviewFeedbackTask(input('legacy-receipt'));
  store.db.prepare('DELETE FROM preview_feedback_outcomes WHERE feedback_id=?').run('legacy-receipt');
  store.close();store=new Store(path);
  assert.deepEqual(store.reconcilePreviewFeedbackTask(input('legacy-receipt')),
    {status:'confirmed',taskId:present.id});
  function coreTaskCount(){return store.tasks(project.id).length;}
});

test('Core never treats a reused task ID without its exact feedback binding as the created task',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-feedback-replaced-'));
  const store=new Store(join(root,'board.sqlite'));
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const {project,input}=sample(store),original=store.createPreviewFeedbackTask(input('replaced'));
  const wrong={...original,previewFeedback:null,title:'Unrelated restored task'};
  store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(wrong),original.id);
  assert.deepEqual(store.reconcilePreviewFeedbackTask(input('replaced')),
    {status:'created_unavailable',taskId:original.id});
  assert.throws(()=>store.createPreviewFeedbackTask(input('replaced')),
    {code:'PREVIEW_FEEDBACK_CREATED_UNAVAILABLE'});
  assert.equal(store.tasks(project.id).length,2);
  assert.equal(store.getTask(original.id).title,'Unrelated restored task');
});

test('local draft and confirmation recovery is fenced, historical and bounded',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-feedback-local-')),path=join(root,'board.sqlite');
  let store=new Store(path);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const {source,manifest}=sample(store);
  const registry={get:async()=>manifest,isRegistered:async()=>true};
  let local=createLocalPreview({store,registry});local.record(manifest,[]);
  const base=`/api/previews/${manifest.previewId}/feedback`,draft={idempotencyKey:'lost-draft',pagePath:'index.html',summary:'Button failed'};
  assert.equal((await local.request('GET',`${base}/by-key/lost-draft`,{},'owner').catch(e=>e)).status,404);
  const before=await local.request('POST',`${base}/by-key/lost-draft/reconcile`,{},'owner');
  assert.equal(before.verification.state,'not_applied');
  await assert.rejects(local.request('POST',base,draft,'owner'),{code:'PREVIEW_FEEDBACK_NOT_APPLIED'});
  const made=await local.request('POST',base,{...draft,idempotencyKey:'created-draft'},'owner');
  assert.equal((await local.request('GET',`${base}/by-key/created-draft`,{},'owner')).feedback.id,made.feedback.id);
  assert.equal((await local.request('POST',`${base}/by-key/created-draft/reconcile`,{},'owner')).feedback.status,'draft');
  const confirmed=await local.request('POST',`${base}/${made.feedback.id}/confirm`,{},'owner');
  assert.equal(confirmed.feedback.status,'confirmed');
  store.db.prepare("UPDATE preview_local_feedback SET status='confirming',task_id=NULL WHERE id=?").run(made.feedback.id);
  store.db.prepare('DELETE FROM tasks WHERE id=?').run(source.id);
  store.close();store=new Store(path);local=createLocalPreview({store,registry});
  assert.equal((await local.request('GET',`${base}/${made.feedback.id}`,{},'owner')).feedback.status,'confirming');
  await assert.rejects(local.request('POST',`${base}/${made.feedback.id}/confirm`,{},'owner'),
    {code:'PREVIEW_FEEDBACK_UNKNOWN'});
  const recovered=await local.request('POST',`${base}/${made.feedback.id}/reconcile`,{},'owner');
  assert.equal(recovered.feedback.status,'confirmed');
  assert.equal(recovered.feedback.taskId,confirmed.feedback.taskId);
  store.db.prepare('UPDATE preview_local_builds SET manifest_json=NULL WHERE preview_id=?').run(manifest.previewId);
  assert.equal((await local.request('GET',`${base}/${made.feedback.id}`,{},'owner')).feedback.taskId,confirmed.feedback.taskId);
  store.db.prepare('DELETE FROM tasks WHERE id=?').run(confirmed.feedback.taskId);
  const deleted=await local.request('POST',`${base}/${made.feedback.id}/reconcile`,{},'owner');
  assert.equal(deleted.feedback.status,'created_unavailable');
  assert.equal(store.tasks().length,0);
  await assert.rejects(local.request('GET',`${base}/${made.feedback.id}`,{},'viewer'),{code:'PREVIEW_FORBIDDEN'});
  for(let i=0;i<198;i++)await local.request('POST',`${base}/by-key/fence${i}/reconcile`,{},'owner');
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM preview_local_feedback').get().n+
    store.db.prepare('SELECT count(*) AS n FROM preview_local_feedback_fences').get().n,200);
  await assert.rejects(local.request('POST',`${base}/by-key/over-limit/reconcile`,{},'owner'),{code:'PREVIEW_LIMIT'});
  assert.equal((await local.request('GET',`${base}/${made.feedback.id}`,{},'owner')).feedback.status,'created_unavailable');
});

test('legacy local draft with a lost confirmation receipt remains verifiable but cannot be fenced absent proof',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-feedback-legacy-'));
  const store=new Store(join(root,'board.sqlite'));
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const {manifest}=sample(store),registry={get:async()=>manifest,isRegistered:async()=>true};
  const local=createLocalPreview({store,registry});local.record(manifest,[]);
  const base=`/api/previews/${manifest.previewId}/feedback`;
  const draft=await local.request('POST',base,{idempotencyKey:'old-created',pagePath:'index.html',summary:'Button failed'},'owner');
  const input={idempotencyKey:draft.feedback.id,projectId:manifest.projectId,sourcePreview:manifest,
    pagePath:'index.html',summary:'Button failed',criterionIds:[],criterionItems:[],reporterUserId:'local_owner'};
  const created=store.createPreviewFeedbackTask(input);
  store.db.prepare('UPDATE preview_local_feedback SET protocol_version=1,status=? WHERE id=?').run('draft',draft.feedback.id);
  const verified=await local.request('POST',`${base}/${draft.feedback.id}/reconcile`,{},'owner');
  assert.equal(verified.feedback.status,'confirmed');
  assert.equal(verified.feedback.taskId,created.id);
  const uncertain=await local.request('POST',base,{idempotencyKey:'old-unknown',pagePath:'index.html',summary:'Unproven'},'owner');
  store.db.prepare('UPDATE preview_local_feedback SET protocol_version=1,status=? WHERE id=?').run('draft',uncertain.feedback.id);
  const unknown=await local.request('POST',`${base}/${uncertain.feedback.id}/reconcile`,{},'owner');
  assert.equal(unknown.verification.state,'unknown');
  await assert.rejects(local.request('POST',`${base}/${uncertain.feedback.id}/confirm`,{},'owner'),
    {code:'PREVIEW_FEEDBACK_UNKNOWN'});
  assert.equal(store.tasks(manifest.projectId).length,2);
});

test('Hub draft key fence is transactional and scoped to account and current actor',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-feedback-hub-'));
  const store=new HubStore(join(root,'hub')),accounts=new AccountService(store);
  const owner=await accounts.register({username:'feedbackowner',password:'correct horse long',source:'test'});
  const other=await accounts.register({username:'feedbackother',password:'correct horse long',source:'test'});
  const subject=store.db.prepare('SELECT s.* FROM subjects s JOIN account_users u ON s.id=u.owner_subject_id WHERE u.id=?').get(owner.user.id);
  const pair=store.createPairing(subject,{role:'node',projectIds:['project1']}),node=store.redeem(pair.code);
  store.db.prepare('INSERT INTO project_owners VALUES(?,?,?,?)').run(subject.tenant_id,'project1',node.nodeId,node.epoch);
  const manifest={v:1,previewId:'preview1',projectId:'project1',taskId:'source1',contentVersion:1,
    artifactDigest:'c'.repeat(64),environment:'test',dataMode:'simulated',capability:'static-interactive',backendApi:'unsupported'};
  const hub=createPreviewHub({store,accounts});
  store.db.prepare('INSERT INTO preview_builds VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('preview1',subject.tenant_id,node.nodeId,node.epoch,'project1','source1',1,manifest.artifactDigest,
      JSON.stringify(manifest),'[]',Date.now());
  const server=createServer(async(req,res)=>{const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    try{let raw='';for await(const chunk of req)raw+=chunk;const path=new URL(req.url,'http://local').pathname;
      if(!await hub.handleHttp({req,res,method:req.method,path,body:raw?JSON.parse(raw):{},send}))send(404,{code:'NOT_FOUND'});
    }catch(error){send(error.status||500,{code:error.code||'ERROR'});}});
  const hosts=new Set(),origins=new Set();hub.attachServer(server,{allowedHosts:hosts,allowedOrigins:origins});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  hosts.add(new URL(origin).host);origins.add(origin);
  t.after(async()=>{await hub.close();await new Promise(resolve=>server.close(resolve));store.close();await rm(root,{recursive:true,force:true});});
  const call=async(method,path,body,user=owner,actor=user.user.id)=>{const response=await fetch(origin+path,{method,
    headers:{Cookie:`hub_session=${user.sessionToken}`,Origin:origin,'X-Preview-Actor-Id':actor,
      ...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json()};};
  const base='/api/previews/preview1/feedback';
  assert.equal((await call('GET',`${base}/by-key/late`)).status,404);
  const closed=await call('POST',`${base}/by-key/late/reconcile`,{});
  assert.equal(closed.data.verification.state,'not_applied');
  assert.equal((await call('POST',base,{idempotencyKey:'late',pagePath:'index.html',summary:'late'})).status,409);
  const made=await call('POST',base,{idempotencyKey:'known',pagePath:'index.html',summary:'known'});
  assert.equal(made.status,200,JSON.stringify(made.data));
  assert.equal((await call('GET',`${base}/by-key/known`)).data.feedback.id,made.data.feedback.id);
  assert.equal((await call('GET',`${base}/by-key/known`,undefined,other)).status,403);
  assert.equal((await call('POST',`${base}/by-key/another/reconcile`,{},other)).status,403);
  assert.equal((await call('POST',`${base}/by-key/known/reconcile`,{},owner,'wrong-user')).data.code,'PREVIEW_ACTOR_CHANGED');
  assert.equal((await call('GET',`${base}/by-key/known`,undefined,owner,'wrong-user')).data.code,'PREVIEW_ACTOR_CHANGED');
  assert.equal((await call('POST',`${base}/by-key/known/reconcile`,{unexpected:true})).status,400);
  assert.equal((await call('GET',`${base}/${made.data.feedback.id}`)).status,200);
  assert.equal((await call('POST',`${base}/by-key/known/reconcile`,{})).data.feedback.status,'draft');
  let result={status:'confirmed',taskId:'original-task'},createGate=null,createStarted=null,createCount=0;
  const link=createPreviewNodeLink({registry:{get:async()=>manifest,isRegistered:async()=>true,read:async()=>{},markRegistered:async()=>{}},
    credentials:()=>({url:origin,token:node.token,nodeId:node.nodeId,epoch:node.epoch}),
    recoveryStoreId:'original-store',createFeedbackTask:async()=>{
      createCount++;
      if(createGate){createStarted();await createGate;}
      return {taskId:'original-task'};
    },
    reconcileFeedbackTask:async()=>result});
  await link.refresh();t.after(()=>link.close());
  store.db.prepare('UPDATE preview_feedback SET status=?,protocol_version=1,recovery_store_id=NULL WHERE id=?')
    .run('draft',made.data.feedback.id);
  const legacy=await call('POST',`${base}/${made.data.feedback.id}/reconcile`,{});
  assert.equal(legacy.data.feedback.status,'confirmed');
  assert.equal(store.db.prepare('SELECT protocol_version FROM preview_feedback WHERE id=?').get(made.data.feedback.id).protocol_version,1);
  result={status:'not_applied'};
  const contradiction=await call('POST',`${base}/${made.data.feedback.id}/reconcile`,{});
  assert.equal(contradiction.data.feedback.status,'confirmed');
  assert.equal(contradiction.data.verification.state,'unknown');
  store.db.prepare("UPDATE preview_feedback SET status='draft',protocol_version=1,recovery_store_id=NULL WHERE id=?")
    .run(made.data.feedback.id);
  const countBeforeLegacyRetry=createCount;
  const resent=await call('POST',`${base}/${made.data.feedback.id}/confirm`,{});
  assert.equal(resent.status,409,JSON.stringify(resent.data));
  assert.equal(resent.data.code,'PREVIEW_FEEDBACK_UNKNOWN');
  assert.equal(createCount,countBeforeLegacyRetry);
  assert.equal(store.db.prepare('SELECT protocol_version FROM preview_feedback WHERE id=?').get(made.data.feedback.id).protocol_version,1);
  const late=await call('POST',base,{idempotencyKey:'late-ack',pagePath:'index.html',summary:'late ACK'});
  assert.equal(late.status,200);
  let releaseCreate;createGate=new Promise(resolve=>{releaseCreate=resolve;});
  const began=new Promise(resolve=>{createStarted=resolve;});
  const pending=call('POST',`${base}/${late.data.feedback.id}/confirm`,{});
  await Promise.race([began,new Promise((_,reject)=>setTimeout(()=>reject(new Error('create barrier not reached')),3000))]);
  result={status:'not_applied'};
  const terminal=await call('POST',`${base}/${late.data.feedback.id}/reconcile`,{});
  assert.equal(terminal.data.feedback.status,'not_applied');
  releaseCreate();
  const lateAck=await pending;
  assert.equal(lateAck.status,409,JSON.stringify(lateAck.data));
  assert.equal(store.db.prepare('SELECT status FROM preview_feedback WHERE id=?').get(late.data.feedback.id).status,'not_applied');
  createGate=null;
  for(let i=0;i<197;i++)assert.equal((await call('POST',`${base}/by-key/fence${i}/reconcile`,{})).status,200);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM preview_feedback').get().n+
    store.db.prepare('SELECT count(*) AS n FROM preview_feedback_fences').get().n,200);
  assert.equal((await call('POST',`${base}/by-key/too-many/reconcile`,{})).status,429);
  store.db.prepare('UPDATE subjects SET revoked_at=? WHERE id=?').run(new Date().toISOString(),subject.id);
  assert.notEqual((await call('GET',`${base}/${made.data.feedback.id}`)).status,200);
});

test('Hub and Core WS recovery orders lost ACK, restart, late create and old protocol without duplicate tasks',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-feedback-link-'));
  const coreStore=new Store(join(root,'board.sqlite'));
  const {project,source,manifest}=sample(coreStore);
  let hubStore=new HubStore(join(root,'hub')),accounts=new AccountService(hubStore);
  const owner=await accounts.register({username:'wsfeedbackowner',password:'correct horse long',source:'test'});
  const subject=hubStore.db.prepare('SELECT s.* FROM subjects s JOIN account_users u ON s.id=u.owner_subject_id WHERE u.id=?')
    .get(owner.user.id);
  const pair=hubStore.createPairing(subject,{role:'node',projectIds:[project.id]}),node=hubStore.redeem(pair.code);
  hubStore.db.prepare('INSERT INTO project_owners VALUES(?,?,?,?)').run(subject.tenant_id,project.id,node.nodeId,node.epoch);
  let hub=createPreviewHub({store:hubStore,accounts});
  hubStore.db.prepare('INSERT INTO preview_builds VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(manifest.previewId,subject.tenant_id,node.nodeId,node.epoch,project.id,source.id,1,manifest.artifactDigest,
      JSON.stringify(manifest),'[]',Date.now());
  const server=createServer(async(req,res)=>{
    const send=(status,data)=>{if(!res.headersSent){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}};
    try{let raw='';for await(const part of req)raw+=part;
      const path=new URL(req.url,'http://local').pathname;
      if(!await hub.handleHttp({req,res,method:req.method,path,body:raw?JSON.parse(raw):{},send}))send(404,{code:'NOT_FOUND'});
    }catch(error){send(error.status||500,{code:error.code||'ERROR'});}
  });
  const hosts=new Set(),origins=new Set();hub.attachServer(server,{allowedHosts:hosts,allowedOrigins:origins});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;hosts.add(new URL(origin).host);origins.add(origin);
  let link=null,mode='normal',started=null,release=null;
  const registry={get:async()=>manifest,isRegistered:async()=>true,read:async()=>{},markRegistered:async()=>{}};
  const connect=async()=>{
    link=createPreviewNodeLink({registry,recoveryStoreId:coreStore.previewFeedbackStoreId(),
      credentials:()=>({url:origin,token:node.token,nodeId:node.nodeId,epoch:node.epoch}),
      createFeedbackTask:async input=>{
        if(mode==='before-create'){
          started.resolve();await release.promise;
          return {taskId:coreStore.createPreviewFeedbackTask(input).id};
        }
        const task=coreStore.createPreviewFeedbackTask(input);
        if(mode==='after-create'){started.resolve();await release.promise;}
        if(mode==='drop-ack'){mode='normal';await link.close();}
        return {taskId:task.id};
      },reconcileFeedbackTask:(input,options)=>coreStore.reconcilePreviewFeedbackTask(input,options)});
    await link.refresh();
  };
  const barrier=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
  const waitStarted=async()=>Promise.race([started.promise,new Promise((_,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Feedback create did not reach the test barrier')),3000);timer.unref?.();
  })]);
  const call=async(method,path,body={})=>{const response=await fetch(origin+path,{method,
    headers:{Cookie:`hub_session=${owner.sessionToken}`,Origin:origin,'X-Preview-Actor-Id':owner.user.id,'Content-Type':'application/json'},
    ...(method==='POST'?{body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};};
  const base=`/api/previews/${manifest.previewId}/feedback`;
  const draft=async key=>{const response=await call('POST',base,{idempotencyKey:key,pagePath:'index.html',summary:key});
    assert.equal(response.status,200,JSON.stringify(response.data));return response.data.feedback.id;};
  t.after(async()=>{if(link)await link.close();await hub.close();await new Promise(resolve=>server.close(resolve));
    hubStore.close();coreStore.close();await rm(root,{recursive:true,force:true});});
  await connect();

  const lost=await draft('lost-ack');mode='drop-ack';
  const failed=await call('POST',`${base}/${lost}/confirm`);
  assert.equal(failed.status,503,JSON.stringify(failed.data));
  assert.equal(hubStore.db.prepare('SELECT status FROM preview_feedback WHERE id=?').get(lost).status,'confirming');
  assert.equal(coreStore.tasks(project.id).length,2);
  await hub.close();hubStore.close();
  hubStore=new HubStore(join(root,'hub'));accounts=new AccountService(hubStore);
  hub=createPreviewHub({store:hubStore,accounts});hub.attachServer(server,{allowedHosts:hosts,allowedOrigins:origins});
  await connect();
  const afterRestartRetry=await call('POST',`${base}/${lost}/confirm`);
  assert.equal(afterRestartRetry.status,409);
  assert.equal(afterRestartRetry.data.code,'PREVIEW_FEEDBACK_UNKNOWN');
  assert.equal(coreStore.tasks(project.id).length,2);
  const recovered=await call('POST',`${base}/${lost}/reconcile`);
  assert.equal(recovered.status,200,JSON.stringify(recovered.data));
  assert.equal(recovered.data.feedback.status,'confirmed');
  assert.equal(coreStore.tasks(project.id).length,2);

  const fenced=await draft('fence-first');mode='before-create';started=barrier();release=barrier();
  const pendingConfirm=call('POST',`${base}/${fenced}/confirm`);
  await waitStarted();
  const notApplied=await call('POST',`${base}/${fenced}/reconcile`);
  assert.equal(notApplied.data.verification.state,'not_applied',JSON.stringify(notApplied.data));
  release.resolve();assert.equal((await pendingConfirm).status,503);
  assert.equal(coreStore.tasks(project.id).length,2);
  assert.equal((await call('POST',`${base}/${fenced}/reconcile`)).data.feedback.status,'not_applied');

  const created=await draft('create-first');mode='after-create';started=barrier();release=barrier();
  const laterAck=call('POST',`${base}/${created}/confirm`);await waitStarted();
  const firstProof=await call('POST',`${base}/${created}/reconcile`);
  assert.equal(firstProof.data.feedback.status,'confirmed',JSON.stringify(firstProof.data));
  release.resolve();assert.equal((await laterAck).status,200);
  assert.equal(coreStore.tasks(project.id).length,3);

  const legacy=await draft('legacy-sent');
  hubStore.db.prepare("UPDATE preview_feedback SET status='confirming',protocol_version=1,recovery_store_id=NULL WHERE id=?").run(legacy);
  const oldUnknown=await call('POST',`${base}/${legacy}/reconcile`);
  assert.equal(oldUnknown.data.verification.state,'unknown');
  assert.equal(coreStore.tasks(project.id).length,3);
  const oldRetry=await call('POST',`${base}/${legacy}/confirm`);
  assert.equal(oldRetry.status,409);
  assert.equal(oldRetry.data.code,'PREVIEW_FEEDBACK_UNKNOWN');
  assert.equal(coreStore.tasks(project.id).length,3);
  const oldInput={idempotencyKey:legacy,projectId:project.id,sourcePreview:manifest,pagePath:'index.html',
    summary:'legacy-sent',criterionIds:[],criterionItems:[],reporterUserId:owner.user.id};
  const oldCreated=coreStore.createPreviewFeedbackTask(oldInput);
  assert.ok(oldCreated.id);
  assert.equal(hubStore.db.prepare('SELECT protocol_version FROM preview_feedback WHERE id=?').get(legacy).protocol_version,1);
  assert.equal((await call('POST',`${base}/${legacy}/reconcile`)).data.feedback.status,'confirmed');
  assert.equal(coreStore.tasks(project.id).length,4);

  const revoked=await draft('revoked-inflight');mode='after-create';started=barrier();release=barrier();
  const staleResponse=call('POST',`${base}/${revoked}/confirm`);await waitStarted();
  hubStore.db.prepare('UPDATE account_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL')
    .run(Date.now(),owner.user.id);
  release.resolve();
  const denied=await staleResponse;
  assert.equal(denied.status,401,JSON.stringify(denied.data));
  assert.equal(JSON.stringify(denied.data).includes(coreStore.tasks(project.id).at(-1).id),false);
  assert.equal(hubStore.db.prepare('SELECT status FROM preview_feedback WHERE id=?').get(revoked).status,'confirmed');
  const freshLogin=await accounts.login({username:'wsfeedbackowner',password:'correct horse long',source:'test'});
  owner.sessionToken=freshLogin.sessionToken;

  await link.close();
  hubStore.db.prepare('UPDATE subjects SET epoch=epoch+1 WHERE id=?').run(node.nodeId);
  hubStore.db.prepare('UPDATE project_owners SET epoch=epoch+1 WHERE node_id=? AND project_id=?').run(node.nodeId,project.id);
  node.epoch++;
  await connect();
  assert.equal((await call('POST',`${base}/${lost}/reconcile`)).data.feedback.status,'confirmed');

  coreStore.db.prepare('DELETE FROM tasks WHERE id=?').run(source.id);
  coreStore.db.prepare('DELETE FROM tasks WHERE id=?').run(recovered.data.feedback.taskId);
  const unavailable=await call('POST',`${base}/${lost}/reconcile`);
  assert.equal(unavailable.data.feedback.status,'created_unavailable');
  assert.equal(coreStore.tasks(project.id).length,3);
});
