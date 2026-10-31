import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HubStore } from '../server/hub/store.mjs';
import { AccountService } from '../server/hub/accounts.mjs';
import { createPreviewHub } from '../server/hub/preview.mjs';
import { createPreviewNodeLink } from '../server/preview/node-link.mjs';
import { createLocalPreview } from '../server/preview/local.mjs';
import { Store } from '../server/store.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const payload=Buffer.from('<!doctype html><h1>real asset</h1>');
function manifest(taskId='t1',projectId='p1') {
  const assetHash=hash(payload),digest=createHash('sha256').update('index.html').update('\0').update(assetHash).update('\0').digest('hex');
  return {v:1,previewId:'preview1',taskId,projectId,contentVersion:1,sourceCommit:'a'.repeat(40),
    dirtyDigest:'b'.repeat(64),dirty:false,artifactDigest:digest,environment:'test',dataMode:'simulated',
    capability:'static-interactive',backendApi:'unsupported',createdAt:new Date().toISOString(),
    files:[{path:'index.html',size:payload.length,sha256:assetHash}]};
}
function registry(m) {
  let gate;
  return {hold(){let entered,release;const enteredPromise=new Promise(resolve=>entered=resolve);
      const blocked=new Promise(resolve=>release=resolve);gate={entered,blocked};return {entered:enteredPromise,release};},
    get:async id=>{const current=gate;gate=null;if(current){current.entered();await current.blocked;}
      return id===m.previewId?m:null;},
    isRegistered:async id=>id===m.previewId,listRegistered:async()=>[m],markRegistered:async()=>{},
    read:async(id,path)=>{assert.equal(id,m.previewId);assert.equal(path,'index.html');
      return {bytes:payload,entry:m.files[0]};}};
}
function capability(detail) {
  const match=/^\/api\/previews\/preview1\/site\/([A-Za-z0-9_-]{43})\/index\.html$/.exec(detail.launchUrl);
  assert.ok(match);return match[1];
}
async function listen(handler) {
  const server=createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,origin:`http://127.0.0.1:${server.address().port}`};
}
async function hubFixture(t) {
  const root=await mkdtemp(join(tmpdir(),'preview-intent-hub-'));
  let store,hub,link,server,clock=Date.now();
  t.after(async()=>{
    const errors=[];
    try{if(link)await link.close();}catch(error){errors.push(error);}
    try{if(hub)await hub.close();}catch(error){errors.push(error);}
    try{if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}}catch(error){errors.push(error);}
    try{store?.close();}catch(error){errors.push(error);}
    if(!errors.length)await rm(root,{recursive:true,force:true});
    if(errors.length)throw new AggregateError(errors,'Hub intent fixture cleanup failed');
  });
  const m=manifest(),reg=registry(m);
  store=new HubStore(join(root,'hub'));
  const accounts=new AccountService(store),password='LocalTest-password-239';
  const owner=await accounts.register({username:'intent_owner',password,source:'test'});
  const other=await accounts.register({username:'intent_other',password,source:'test'});
  const sameUser=await accounts.login({username:'intent_owner',password,source:'test'});
  const subject=store.db.prepare('SELECT s.* FROM subjects s JOIN account_users u ON u.owner_subject_id=s.id WHERE u.id=?')
    .get(owner.user.id);
  const pairing=store.createPairing(subject,{role:'node',projectIds:['p1']}),node=store.redeem(pairing.code);
  store.db.prepare('INSERT INTO project_owners VALUES(?,?,?,?)').run(subject.tenant_id,'p1',node.nodeId,node.epoch);
  hub=createPreviewHub({store,accounts,now:()=>clock});
  store.db.prepare('INSERT INTO preview_builds VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(m.previewId,subject.tenant_id,
    node.nodeId,node.epoch,'p1','t1',1,m.artifactDigest,JSON.stringify(m),'[]',clock);
  const listener=await listen(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try{let raw='';for await(const part of req)raw+=part;
      const path=new URL(req.url,origin).pathname;
      if(!await hub.handleHttp({req,res,method:req.method,path,body:raw?JSON.parse(raw):{},send}))send(404,{code:'NOT_FOUND'});
    }catch(error){if(!res.headersSent)send(error.status||500,{code:error.code||'ERROR'});else res.destroy(error);}
  });
  server=listener.server;const {origin}=listener;
  const policy={allowedHosts:new Set([new URL(origin).host]),allowedOrigins:new Set([origin])};
  hub.attachServer(server,policy);
  link=createPreviewNodeLink({registry:reg,credentials:()=>({url:origin,token:node.token,nodeId:node.nodeId,epoch:node.epoch})});
  await link.refresh();
  async function call(method,path,{as=owner,body,requestOrigin=origin}={}) {
    const response=await fetch(origin+path,{method,headers:{...(as?{Cookie:`hub_session=${as.sessionToken}`} : {}),
      ...(requestOrigin?{Origin:requestOrigin}:{}),...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const bytes=Buffer.from(await response.arrayBuffer());
    return {status:response.status,bytes,data:response.headers.get('content-type')?.includes('json')?JSON.parse(bytes):null};
  }
  async function restart(){await link.close();link=null;await hub.close();hub=createPreviewHub({store,accounts,now:()=>clock});hub.attachServer(server,policy);}
  return {store,owner,other,sameUser,subject,call,restart,advance:ms=>clock+=ms};
}
async function localFixture(t) {
  const root=await mkdtemp(join(tmpdir(),'preview-intent-local-'));
  let store,server,clock=Date.now(),local;
  t.after(async()=>{
    const errors=[];
    try{if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}}catch(error){errors.push(error);}
    try{store?.close();}catch(error){errors.push(error);}
    if(!errors.length)await rm(root,{recursive:true,force:true});
    if(errors.length)throw new AggregateError(errors,'Local intent fixture cleanup failed');
  });
  store=new Store(join(root,'board.sqlite'));
  const project=store.project({name:'Preview',directory:root}),task=store.createTask({projectId:project.id,title:'Preview'});
  const m=manifest(task.id,project.id),reg=registry(m);
  local=createLocalPreview({store,registry:reg,now:()=>clock});local.record(m,[]);
  const listener=await listen(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try{let raw='';for await(const part of req)raw+=part;
      const path=new URL(req.url,origin).pathname;
      if(req.method==='GET'&&path.includes('/site/')){await local.handleSite(req,res,path);return;}
      const role=req.headers.authorization==='Bearer owner'?'owner':req.headers.authorization==='Bearer viewer'?'viewer':null;
      send(200,await local.request(req.method,path,raw?JSON.parse(raw):{},role));
    }catch(error){if(!res.headersSent)send(error.status||500,{code:error.code||'ERROR'});else res.destroy(error);}
  });
  server=listener.server;const {origin}=listener;
  async function call(method,path,{role='owner',body}={}) {
    const response=await fetch(origin+path,{method,headers:{Authorization:`Bearer ${role}`,
      ...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const bytes=Buffer.from(await response.arrayBuffer());
    return {status:response.status,bytes,data:response.headers.get('content-type')?.includes('json')?JSON.parse(bytes):null};
  }
  const reboot=()=>{local=createLocalPreview({store,registry:reg,now:()=>clock});};
  return {store,reg,call,reboot,advance:ms=>clock+=ms};
}

const base='/api/previews/preview1/access-intents';

test('Hub lost issue receipt is inspectable and close revokes only its exact launch across restart',async t=>{
  const x=await hubFixture(t);
  const registered=await x.call('POST',base,{body:{}});
  assert.equal(registered.status,200);
  const intent=registered.data.intent;
  assert.match(intent.id,/^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(intent).sort(),['expiresAt','id','previewId','projectId','state','taskId']);
  assert.equal(intent.state,'registered');
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM preview_caps').get().n,0);
  const path=`${base}/${intent.id}`;
  assert.equal((await x.call('GET',path)).data.intent.state,'registered');
  const issued=await x.call('POST',`${path}/issue`,{body:{}});
  assert.equal(issued.status,200);
  assert.equal(issued.data.intent.state,'issued');
  assert.equal(issued.data.expiresAt,intent.expiresAt);
  assert.equal((await x.call('POST',`${path}/issue`,{body:{}})).status,409);
  const status=await x.call('GET',path);
  assert.deepEqual(status.data,{intent:{...intent,state:'issued'}});
  assert.equal(JSON.stringify(status.data).includes(capability(issued.data)),false);
  assert.equal((await x.call('GET',issued.data.launchUrl)).status,200);
  assert.deepEqual((await x.call('POST',`${path}/close`,{body:{}})).data,
    {intent:{...intent,state:'closed'},inactive:true});
  assert.equal((await x.call('GET',issued.data.launchUrl)).status,403);
  assert.equal((await x.call('POST',`${path}/close`,{body:{}})).data.inactive,true);
  await x.restart();
  assert.equal((await x.call('GET',path)).data.intent.state,'closed');
  assert.equal((await x.call('POST',`${path}/issue`,{body:{}})).status,409);
});

test('Hub intents bind account, original login, project and exact empty requests',async t=>{
  const x=await hubFixture(t);
  const intent=(await x.call('POST',base,{body:{}})).data.intent,path=`${base}/${intent.id}`;
  for(const as of [x.other,x.sameUser,null]) {
    assert.notEqual((await x.call('GET',path,{as})).status,200);
    assert.notEqual((await x.call('POST',`${path}/close`,{as,body:{}})).status,200);
  }
  assert.equal((await x.call('POST',base,{body:{},requestOrigin:'http://wrong.test'})).status,403);
  assert.equal((await x.call('POST',base,{body:{extra:true}})).status,400);
  assert.equal((await x.call('POST',`${path}/issue`,{body:{extra:true}})).status,400);
  assert.equal((await x.call('POST',`${path}/close`,{body:{extra:true}})).status,400);
  assert.equal((await x.call('GET',`${path}?extra=1`)).status,400);
  const untouched=(await x.call('POST',base,{body:{}})).data.intent;
  assert.equal((await x.call('POST',`${base}/${untouched.id}/close`,{body:{}})).data.intent.state,'closed');
  assert.equal((await x.call('POST',`${base}/${untouched.id}/issue`,{body:{}})).status,409);
  const second={...manifest(),previewId:'preview2'};
  x.store.db.prepare('INSERT INTO preview_builds VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(second.previewId,x.subject.tenant_id,
    x.store.db.prepare('SELECT node_id FROM preview_builds WHERE preview_id=?').get('preview1').node_id,
    x.store.db.prepare('SELECT node_epoch FROM preview_builds WHERE preview_id=?').get('preview1').node_epoch,
    'p1','t1',1,second.artifactDigest,JSON.stringify(second),'[]',Date.now());
  assert.equal((await x.call('GET',`/api/previews/preview2/access-intents/${intent.id}`)).status,404);
  assert.equal((await x.call('POST',`/api/previews/preview2/access-intents/${intent.id}/issue`,{body:{}})).status,404);
  x.store.db.prepare('UPDATE subjects SET revoked_at=? WHERE id=?').run(new Date().toISOString(),x.subject.id);
  const revokedGet=await x.call('GET',path),revokedIssue=await x.call('POST',`${path}/issue`,{body:{}});
  for(const response of [revokedGet,revokedIssue]){
    assert.equal(response.status,401);assert.equal(response.data?.code,'UNAUTHORIZED');
  }
});

test('Hub transaction failures cannot half-issue or falsely close, and expiration cannot reissue',async t=>{
  const x=await hubFixture(t);
  const intent=(await x.call('POST',base,{body:{}})).data.intent,path=`${base}/${intent.id}`;
  x.store.db.exec(`CREATE TRIGGER deny_intent_issue BEFORE UPDATE OF state ON preview_access_intents
    WHEN NEW.state='issued' BEGIN SELECT RAISE(ABORT,'intent write failed'); END;`);
  assert.equal((await x.call('POST',`${path}/issue`,{body:{}})).status,500);
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM preview_caps').get().n,0);
  assert.equal((await x.call('GET',path)).data.intent.state,'registered');
  x.store.db.exec('DROP TRIGGER deny_intent_issue');
  const issued=(await x.call('POST',`${path}/issue`,{body:{}})).data;
  x.store.db.exec(`CREATE TRIGGER deny_intent_close BEFORE UPDATE OF revoked_at ON preview_caps
    BEGIN SELECT RAISE(ABORT,'cap write failed'); END;`);
  assert.equal((await x.call('POST',`${path}/close`,{body:{}})).status,500);
  assert.equal((await x.call('GET',path)).data.intent.state,'issued');
  assert.equal((await x.call('GET',issued.launchUrl)).status,200);
  x.store.db.exec('DROP TRIGGER deny_intent_close');
  assert.equal((await x.call('POST',`${path}/close`,{body:{}})).data.inactive,true);
  const expiring=(await x.call('POST',base,{body:{}})).data.intent;
  x.advance(600_001);
  assert.equal((await x.call('GET',`${base}/${expiring.id}`)).data.intent.state,'expired');
  assert.equal((await x.call('POST',`${base}/${expiring.id}/issue`,{body:{}})).status,409);
  assert.equal((await x.call('POST',`${base}/${expiring.id}/close`,{body:{}})).data.inactive,true);
});

test('Hub caps and intents stay bounded after repeated issue and close; pruned IDs never issue',async t=>{
  const x=await hubFixture(t),active=[];
  for(let i=0;i<20;i++)active.push((await x.call('POST',base,{body:{}})).data.intent);
  assert.equal((await x.call('POST',base,{body:{}})).status,429);
  for(const intent of active)assert.equal((await x.call('POST',`${base}/${intent.id}/close`,{body:{}})).data.inactive,true);
  let oldest;
  for(let i=0;i<205;i++){
    const intent=(await x.call('POST',base,{body:{}})).data.intent;
    if(i===0)oldest=intent.id;
    const issued=await x.call('POST',`${base}/${intent.id}/issue`,{body:{}});
    assert.equal(issued.status,200,`issue ${i}`);
    const closed=await x.call('POST',`${base}/${intent.id}/close`,{body:{}});
    assert.equal(closed.status,200,`close ${i}`);
    assert.equal(closed.data.inactive,true);
  }
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM preview_caps WHERE user_id=? AND revoked_at IS NOT NULL')
    .get(x.owner.user.id).n,200);
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM preview_access_intents WHERE user_id=?')
    .get(x.owner.user.id).n,200);
  assert.equal((await x.call('GET',`${base}/${oldest}`)).status,404);
  assert.equal((await x.call('POST',`${base}/${oldest}/issue`,{body:{}})).status,404);
  assert.equal((await x.call('POST',base,{body:{}})).status,200);
});

test('local close wins over an issue delayed in build; reboot invalidates active intentions',async t=>{
  const x=await localFixture(t);
  const intent=(await x.call('POST',base,{body:{}})).data.intent,path=`${base}/${intent.id}`;
  const gate=x.reg.hold(),pending=x.call('POST',`${path}/issue`,{body:{}});
  await gate.entered;
  assert.equal((await x.call('POST',`${path}/close`,{body:{}})).data.intent.state,'closed');
  gate.release();
  assert.equal((await pending).status,409);
  const second=(await x.call('POST',base,{body:{}})).data.intent;
  const issue=(await x.call('POST',`${base}/${second.id}/issue`,{body:{}})).data;
  assert.equal((await x.call('GET',issue.launchUrl)).status,200);
  assert.equal((await x.call('POST',`${base}/${second.id}/issue`,{body:{}})).status,409);
  assert.equal((await x.call('GET',`${base}/${second.id}`,{role:'viewer'})).status,403);
  x.reboot();
  assert.equal((await x.call('GET',`${base}/${second.id}`)).data.intent.state,'invalidated');
  assert.equal((await x.call('POST',`${base}/${second.id}/close`,{body:{}})).data.inactive,true);
  assert.equal((await x.call('GET',issue.launchUrl)).status,403);
  assert.equal((await x.call('POST',`${base}/${second.id}/issue`,{body:{}})).status,409);
});

test('local intent storage errors preserve the original state and capability',async t=>{
  const x=await localFixture(t);
  const intent=(await x.call('POST',base,{body:{}})).data.intent,path=`${base}/${intent.id}`;
  x.store.db.exec(`CREATE TRIGGER deny_local_issue BEFORE UPDATE OF state ON preview_local_access_intents
    WHEN NEW.state='issued' BEGIN SELECT RAISE(ABORT,'intent write failed'); END;`);
  assert.equal((await x.call('POST',`${path}/issue`,{body:{}})).status,500);
  assert.equal((await x.call('GET',path)).data.intent.state,'registered');
  x.store.db.exec('DROP TRIGGER deny_local_issue');
  const issue=(await x.call('POST',`${path}/issue`,{body:{}})).data;
  x.store.db.exec(`CREATE TRIGGER deny_local_close BEFORE UPDATE OF state ON preview_local_access_intents
    WHEN NEW.state='closed' BEGIN SELECT RAISE(ABORT,'intent write failed'); END;`);
  assert.equal((await x.call('POST',`${path}/close`,{body:{}})).status,500);
  assert.equal((await x.call('GET',issue.launchUrl)).status,200);
  assert.equal((await x.call('GET',path)).data.intent.state,'issued');
  x.store.db.exec('DROP TRIGGER deny_local_close');
  assert.equal((await x.call('POST',`${path}/close`,{body:{}})).data.inactive,true);
  assert.equal((await x.call('GET',issue.launchUrl)).status,403);
});

test('local role and active limit are exact, with bounded closed intentions',async t=>{
  const x=await localFixture(t),active=[];
  for(let i=0;i<20;i++)active.push((await x.call('POST',base,{body:{}})).data.intent);
  assert.equal((await x.call('POST',base,{body:{}})).status,429);
  const first=active[0],path=`${base}/${first.id}`;
  assert.equal((await x.call('GET',path,{role:'viewer'})).status,403);
  assert.equal((await x.call('POST',`${path}/issue`,{role:'viewer',body:{}})).status,403);
  assert.equal((await x.call('POST',`${path}/close`,{role:'viewer',body:{}})).status,403);
  for(const intent of active)assert.equal((await x.call('POST',`${base}/${intent.id}/close`,{body:{}})).data.inactive,true);
  let oldest;
  for(let i=0;i<205;i++){
    const intent=(await x.call('POST',base,{body:{}})).data.intent;
    if(i===0)oldest=intent.id;
    assert.equal((await x.call('POST',`${base}/${intent.id}/issue`,{body:{}})).status,200);
    assert.equal((await x.call('POST',`${base}/${intent.id}/close`,{body:{}})).data.inactive,true);
  }
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM preview_local_access_intents').get().n,200);
  assert.equal((await x.call('GET',`${base}/${oldest}`)).status,404);
  assert.equal((await x.call('POST',`${base}/${oldest}/issue`,{body:{}})).status,404);
  assert.equal((await x.call('POST',base,{body:{}})).status,200);
});
