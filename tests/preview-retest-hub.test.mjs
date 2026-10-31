import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {HubStore} from '../server/hub/store.mjs';
import {AccountService} from '../server/hub/accounts.mjs';
import {createPreviewHub} from '../server/hub/preview.mjs';
import {createPreviewNodeLink} from '../server/preview/node-link.mjs';
import {previewCriteriaDigest} from '../server/preview/retest-contract.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
async function fixture(t,{compare,trace=false}={}){
  const root=await mkdtemp(join(tmpdir(),'preview-retest-hub-'));
  const store=new HubStore(join(root,'hub')),accounts=new AccountService(store);
  const owner=await accounts.register({username:'retestowner',password:'Local isolated test password 123',source:'test'});
  const subject=store.db.prepare('SELECT s.* FROM subjects s JOIN account_users u ON u.owner_subject_id=s.id WHERE u.id=?')
    .get(owner.user.id);
  const pairing=store.createPairing(subject,{role:'node',projectIds:['project1']});
  const node=store.redeem(pairing.code);
  store.db.prepare('INSERT INTO project_owners VALUES(?,?,?,?)').run(subject.tenant_id,'project1',node.nodeId,node.epoch);
  const criteria=[{id:'criterion1',text:'保存后可读回'}];
  const snapshot=(version)=>store.db.prepare('INSERT OR REPLACE INTO snapshots VALUES(?,?,?,?,?,?,?)')
    .run(node.nodeId,subject.tenant_id,node.epoch,version,'test',Date.now(),
      JSON.stringify({tasks:[{id:'task1',projectId:'project1',contentVersion:version,revision:version,criteria}]}));
  const fileSha=sha('index'),artifactDigest=sha(`index.html\0${fileSha}\0`);
  const manifest=(id,version)=>({v:2,previewId:id,projectId:'project1',taskId:'task1',contentVersion:version,
    sourceTaskRevision:version,sourceCommit:'a'.repeat(40),artifactDigest,environment:'受控构建 · 隔离预览',
    dataMode:'simulated',capability:'records-v1',backendApi:'records-v1',apiTarget:'records-v1',
    dataStoreId:`store${version}`,createdAt:new Date().toISOString(),
    provenance:{kind:'managed-vite-vanilla-v1',sourceDigest:sha(`source${version}`),
      inputDigest:sha(`input${version}`),buildReceiptDigest:sha(`receipt${version}`),
      toolDigest:sha('tool'),profileDigest:sha('profile')},
    files:[{path:'index.html',size:5,sha256:fileSha}]});
  const previous=manifest('previewOld',1),current=manifest('previewNew',2);
  const manifests=new Map([[previous.previewId,previous],[current.previewId,current]]),registered=new Set();
  const registry={get:async id=>manifests.get(id),isRegistered:async id=>registered.has(id),
    markRegistered:async id=>registered.add(id),read:async()=>({bytes:Buffer.from('index'),entry:current.files[0]})};
  const hub=createPreviewHub({store,accounts});
  const server=createServer(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
    try{const path=new URL(req.url,'http://localhost').pathname;
      if(!await hub.handleHttp({req,res,method:req.method,path,send}))send(404,{code:'NOT_FOUND'});
    }catch(error){if(!res.headersSent)send(error.status||500,{code:error.code||'ERROR'});else res.destroy(error);}
  });
  const hosts=new Set(),origins=new Set();hub.attachServer(server,{allowedHosts:hosts,allowedOrigins:origins});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  hosts.add(new URL(origin).host);origins.add(origin);
  let identity={url:origin,token:node.token,nodeId:node.nodeId,epoch:node.epoch};
  const defaultResult=pair=>({previewId:pair[0].previewId,previousPreviewId:pair[1].previewId,
    sourceState:'verified',reasonCode:null,reason:null,currentTaskMatchesPreview:true,
    binding:{projectId:'project1',taskId:'task1',contentVersion:2,
      criteriaDigest:previewCriteriaDigest(criteria),sourceDigest:current.provenance.sourceDigest},
    comparisonDigest:sha('comparison'),changedFiles:[{path:'src/app.js',change:'modified'}],
    totalCriteria:1,truncated:false,items:[{criterionId:'criterion1',text:'保存后可读回',
      status:'needs_retest',reasonCode:'mapped_file_changed',reason:'node text must be ignored',
      changedPaths:[{path:'src/app.js',change:'modified'}],checkSteps:['保存并刷新读回']}]});
  const sentFrames=[];
  class TracedWebSocket extends WebSocket{
    send(data,...args){
      if(trace){try{const frame=JSON.parse(data);if(frame.type?.startsWith('retest-'))sentFrames.push(frame.type);}
        catch{/* test recorder never changes transport behavior */}}
      return super.send(data,...args);
    }
  }
  const link=createPreviewNodeLink({registry,credentials:()=>identity,
    retestAuthority:async pair=>{if(pair.some(m=>m.projectId!=='project1'))throw Error('scope changed');},
    compareRetest:async pair=>compare?compare(pair,defaultResult):defaultResult(pair),
    WebSocketImpl:TracedWebSocket});
  t.after(async()=>{
    const errors=[];
    for(const cleanup of [()=>link.close(),()=>hub.close(),()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())),
      ()=>{store.close();},()=>rm(root,{recursive:true,force:true})])
      try{await cleanup();}catch(error){errors.push(error);}
    if(errors.length)throw new AggregateError(errors,'Preview retest fixture cleanup failed');
  });
  await link.refresh();snapshot(1);await link.register(previous.previewId);
  snapshot(2);await link.register(current.previewId);
  const call=async()=>{const response=await fetch(`${origin}/api/previews/${current.previewId}/retest?previous=${previous.previewId}`,
    {headers:{Cookie:`hub_session=${owner.sessionToken}`}});
    return {status:response.status,data:await response.json()};};
  const issue=async()=>{
    const headers={Cookie:`hub_session=${owner.sessionToken}`,Origin:origin,'Content-Type':'application/json'};
    const created=await fetch(`${origin}/api/previews/${current.previewId}/access-intents`,
      {method:'POST',headers,body:'{}'});
    assert.equal(created.status,200);
    const {intent}=await created.json();
    const issued=await fetch(`${origin}/api/previews/${current.previewId}/access-intents/${intent.id}/issue`,
      {method:'POST',headers,body:'{}'});
    assert.equal(issued.status,200);
    return (await issued.json()).launchUrl;
  };
  const asset=async launchUrl=>{
    const response=await fetch(origin+launchUrl,{headers:{Cookie:`hub_session=${owner.sessionToken}`}});
    return {status:response.status,body:await response.text()};
  };
  return {call,issue,asset,sentFrames,store,accounts,owner,subject,node,current,previous,manifests,registry,link,
    identity:()=>identity,setIdentity:value=>{identity=value;},criteria};
}

test('Hub and NodeLink compare registered previews over the read-only WS route',async t=>{
  const x=await fixture(t),result=await x.call();
  assert.equal(result.status,200);
  assert.equal(result.data.sourceState,'verified');
  assert.equal(result.data.items[0].status,'needs_retest');
  assert.equal(result.data.items[0].reason,'已映射源码路径发生可核实变化，需要按步骤重验');
  assert.equal(result.data.changedFiles[0].path,'src/app.js');
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM preview_feedback').get().n,0);
});

test('malformed node result is all unknown; disconnect never reuses old positive result',async t=>{
  const x=await fixture(t,{compare:async pair=>({previewId:pair[0].previewId,previousPreviewId:pair[1].previewId,
    sourceState:'verified',binding:{projectId:'project1',taskId:'task1',contentVersion:2,
      criteriaDigest:previewCriteriaDigest([{id:'criterion1',text:'保存后可读回'}]),
      sourceDigest:pair[0].provenance.sourceDigest},comparisonDigest:sha('bad'),
    currentTaskMatchesPreview:true,changedFiles:[{path:'../private',change:'modified'}],
    totalCriteria:1,truncated:false,items:[{criterionId:'criterion1',text:'保存后可读回',
      status:'needs_retest',reasonCode:'mapped_file_changed',changedPaths:[],checkSteps:['x']}]} )});
  const malformed=await x.call();assert.equal(malformed.status,200);
  assert.equal(malformed.data.sourceState,'unknown');
  assert.equal(malformed.data.items[0].status,'unknown');
  await x.link.close();await pause();
  const offline=await x.call();assert.equal(offline.status,200);
  assert.equal(offline.data.reasonCode,'node_offline');
  assert.equal(offline.data.items[0].status,'unknown');
});

test('login revoked during node comparison cannot receive paths',async t=>{
  let entered,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const x=await fixture(t,{compare:async()=>{entered();await gate;return {sourceState:'unknown'};}});
  const pending=x.call();await started;
  x.accounts.logout(x.owner.sessionToken);release();
  const result=await pending;
  assert.equal(result.status,401);
  assert.equal(JSON.stringify(result.data).includes('src/app.js'),false);
});

test('registered source scope replaced while compare waits cannot yield a positive impact',async t=>{
  let entered,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const x=await fixture(t,{compare:async()=>{entered();await gate;return {sourceState:'unknown'};}});
  const pending=x.call();await started;
  x.manifests.set(x.current.previewId,{...x.current,artifactDigest:sha('different-artifact')});
  release();
  const result=await pending;
  assert.equal(result.status,200);
  assert.equal(result.data.sourceState,'unknown');
  assert.equal(result.data.items[0].status,'unknown');
});

test('node disconnect during comparison returns bounded unknown, not stale positive',async t=>{
  let entered,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const x=await fixture(t,{compare:async()=>{entered();await gate;return {sourceState:'unknown'};}});
  const pending=x.call();await started;
  await x.link.close();release();
  const result=await pending;
  assert.equal(result.status,200);
  assert.equal(result.data.sourceState,'unknown');
  assert.equal(result.data.reasonCode,'node_offline');
});

test('oversized node reply cannot produce a positive comparison',async t=>{
  const x=await fixture(t,{compare:async()=>({sourceState:'verified',padding:'x'.repeat(70_000)})});
  const result=await x.call();
  assert.equal(result.status,200);
  assert.equal(result.data.sourceState,'unknown');
  assert.equal(result.data.reasonCode,'result_invalid');
  assert.equal(result.data.items[0].status,'unknown');
});

test('node project grant revoked while comparison waits exposes no source paths',async t=>{
  let entered,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const started=new Promise(resolve=>{entered=resolve;});
  const x=await fixture(t,{compare:async()=>{entered();await gate;return {sourceState:'unknown'};}});
  const pending=x.call();await started;
  x.store.db.prepare('DELETE FROM grants WHERE subject_id=? AND project_id=?')
    .run(x.node.nodeId,'project1');
  release();
  const result=await pending;
  assert.equal(result.status,409);
  assert.equal(JSON.stringify(result.data).includes('src/app.js'),false);
});

test('hung comparisons have two independent slots; assets work and late results stay dropped after rotation',async t=>{
  const held=[];let entered;
  const firstTwo=new Promise(resolve=>{entered=resolve;});
  let calls=0;
  const x=await fixture(t,{trace:true,compare:(pair,normal)=>{
    if(++calls>2)return normal(pair);
    return new Promise(resolve=>{held.push(()=>resolve(normal(pair)));if(held.length===2)entered();});
  }});
  // Release test-only deferred work during cleanup even when an assertion fails.
  t.after(()=>held.forEach(release=>release()));
  const first=x.call(),second=x.call();await firstTwo;
  const busy=await x.call();
  assert.equal(busy.status,200);assert.equal(busy.data.reasonCode,'node_busy');
  const launchUrl=await x.issue(),asset=await x.asset(launchUrl);
  assert.equal(asset.status,200);assert.equal(asset.body,'index');
  const timed=await Promise.all([first,second]);
  assert.deepEqual(timed.map(item=>item.data.reasonCode),['node_timeout','node_timeout']);
  assert.equal(x.sentFrames.filter(type=>type==='retest-error').length,3);
  x.setIdentity({...x.identity(),url:`${x.identity().url}/`});
  await x.link.refresh();
  const rotatedBusy=await x.call();
  assert.equal(rotatedBusy.data.reasonCode,'node_busy');
  held.forEach(release=>release());
  await pause();
  assert.equal(x.sentFrames.filter(type=>type==='retest-result').length,0,
    'expired work must not send a late positive receipt');
  const recovered=await x.call();
  assert.equal(recovered.status,200);assert.equal(recovered.data.sourceState,'verified');
  assert.equal(x.sentFrames.filter(type=>type==='retest-result').length,1);
});
