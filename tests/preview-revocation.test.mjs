import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {HubStore} from '../server/hub/store.mjs';
import {AccountService} from '../server/hub/accounts.mjs';
import {createPreviewHub} from '../server/hub/preview.mjs';
import {createPreviewNodeLink} from '../server/preview/node-link.mjs';
import {createLocalPreview} from '../server/preview/local.mjs';
import {Store} from '../server/store.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const payloads={
  'index.html':Buffer.from('<!doctype html><script type="module" src="./app.js"></script>'),
  'app.js':Buffer.from('document.body.dataset.preview="loaded";'),
};

function fixtureManifest(taskId='t1',projectId='p1') {
  const files=Object.entries(payloads).map(([path,bytes])=>({path,size:bytes.length,sha256:sha(bytes)}));
  const digest=createHash('sha256');
  for(const item of [...files].sort((a,b)=>a.path.localeCompare(b.path)))
    digest.update(item.path).update('\0').update(item.sha256).update('\0');
  return {v:1,previewId:'preview1',taskId,projectId,contentVersion:1,sourceCommit:'a'.repeat(40),
    dirtyDigest:'b'.repeat(64),dirty:false,artifactDigest:digest.digest('hex'),environment:'test',
    dataMode:'simulated',capability:'static-interactive',backendApi:'unsupported',createdAt:new Date().toISOString(),files};
}

function controlledRegistry(manifest) {
  let gate=null;
  return {
    hold() { let enter,release; const entered=new Promise(resolve=>{enter=resolve;});
      const blocked=new Promise(resolve=>{release=resolve;});gate={enter,blocked};return {entered,release}; },
    get:async id=>id===manifest.previewId?manifest:null,
    isRegistered:async id=>id===manifest.previewId,
    listRegistered:async()=>[manifest],markRegistered:async()=>{},
    read:async(id,path)=>{
      if(id!==manifest.previewId||!Object.hasOwn(payloads,path))throw Error('Fixture asset unavailable');
      const current=gate;gate=null;
      if(current){current.enter();await current.blocked;}
      const bytes=payloads[path];return {bytes,entry:{path,size:bytes.length,sha256:sha(bytes)}};
    },
  };
}

function tokenFrom(detail) {
  const match=/^\/api\/previews\/preview1\/site\/([A-Za-z0-9_-]{32,100})\/index\.html$/.exec(detail.launchUrl);
  assert.ok(match,'launch URL must contain only the expected preview capability path');
  return match[1];
}

async function listen(handler) {
  const server=createServer(handler);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,origin:`http://127.0.0.1:${server.address().port}`};
}

async function hubFixture(t) {
  const root=await mkdtemp(join(tmpdir(),'preview-revoke-hub-'));
  let store,hub,link,server;
  t.after(async()=>{
    const failures=[];
    try{if(link)await link.close();}catch(error){failures.push(error);}
    try{if(hub)await hub.close();}catch(error){failures.push(error);}
    try{if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}}catch(error){failures.push(error);}
    try{store?.close();}catch(error){failures.push(error);}
    if(!failures.length)await rm(root,{recursive:true,force:true});
    if(failures.length)throw new AggregateError(failures,'Preview Hub fixture cleanup failed');
  });
  const manifest=fixtureManifest(),registry=controlledRegistry(manifest);
  store=new HubStore(join(root,'hub'));
  const accounts=new AccountService(store);
  const password='LocalTest-password-239';
  const owner=await accounts.register({username:'preview_revoke_owner',password,source:'test'});
  const other=await accounts.register({username:'preview_revoke_other',password,source:'test'});
  const sameUser=await accounts.login({username:'preview_revoke_owner',password,source:'test'});
  const subject=store.db.prepare('SELECT s.* FROM subjects s JOIN account_users u ON u.owner_subject_id=s.id WHERE u.id=?').get(owner.user.id);
  const pairing=store.createPairing(subject,{role:'node',projectIds:['p1']}),node=store.redeem(pairing.code);
  store.db.prepare('INSERT INTO project_owners VALUES(?,?,?,?)').run(subject.tenant_id,'p1',node.nodeId,node.epoch);
  hub=createPreviewHub({store,accounts});
  store.db.prepare('INSERT INTO preview_builds VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(manifest.previewId,subject.tenant_id,
    node.nodeId,node.epoch,'p1','t1',1,manifest.artifactDigest,JSON.stringify(manifest),'[]',Date.now());
  const listener=await listen(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try{let raw='';for await(const part of req)raw+=part;
      const path=new URL(req.url,origin).pathname;
      if(!await hub.handleHttp({req,res,method:req.method,path,body:raw?JSON.parse(raw):{},send}))send(404,{code:'NOT_FOUND'});
    }catch(error){if(!res.headersSent)send(error.status||500,{code:error.code||'ERROR'});else res.destroy(error);}
  });
  server=listener.server;const {origin}=listener;
  const hosts=new Set([new URL(origin).host]),origins=new Set([origin]);
  hub.attachServer(server,{allowedHosts:hosts,allowedOrigins:origins});
  link=createPreviewNodeLink({registry,credentials:()=>({url:origin,token:node.token,nodeId:node.nodeId,epoch:node.epoch})});
  await link.refresh();
  async function call(method,path,{as=owner,body,requestOrigin=origin}={}) {
    const response=await fetch(origin+path,{method,headers:{...(as?{Cookie:`hub_session=${as.sessionToken}`} : {}),
      ...(requestOrigin?{Origin:requestOrigin}:{}),...(body?{'Content-Type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    const bytes=Buffer.from(await response.arrayBuffer());
    return {status:response.status,bytes,data:response.headers.get('content-type')?.includes('json')?JSON.parse(bytes):null};
  }
  return {manifest,registry,store,accounts,owner,other,sameUser,node,subject,call};
}

test('Hub revokes only the current session launch, idempotently, without exposing assets',async t=>{
  const x=await hubFixture(t);
  const first=(await x.call('GET','/api/previews/preview1')).data;
  const second=(await x.call('GET','/api/previews/preview1')).data;
  const cap=tokenFrom(first),endpoint='/api/previews/preview1/revoke';
  assert.equal((await x.call('POST',endpoint,{as:x.other,body:{capability:cap}})).status,403);
  assert.equal((await x.call('POST',endpoint,{as:x.sameUser,body:{capability:cap}})).status,403);
  assert.equal((await x.call('POST',endpoint,{body:{capability:cap},requestOrigin:'http://invalid.test'})).status,403);
  assert.equal((await x.call('POST',endpoint,{as:null,body:{capability:cap}})).status,401);
  assert.equal((await x.call('POST',endpoint,{body:{capability:cap,extra:true}})).status,400);
  assert.deepEqual((await x.call('POST',endpoint,{body:{capability:cap}})).data,{revoked:true});
  assert.deepEqual((await x.call('POST',endpoint,{body:{capability:cap}})).data,{revoked:true});
  assert.equal((await x.call('GET',first.launchUrl)).status,403);
  assert.equal((await x.call('GET',first.launchUrl.replace(/index\.html$/,'app.js'),{as:null,requestOrigin:'null'})).status,403);
  assert.equal((await x.call('GET',second.launchUrl)).status,200);
  const expired=(await x.call('GET','/api/previews/preview1')).data;
  const expiredCap=tokenFrom(expired);
  x.store.db.prepare('UPDATE preview_caps SET expires_at=? WHERE token_hash=?').run(Date.now()-1,sha(expiredCap));
  assert.equal((await x.call('POST',endpoint,{body:{capability:expiredCap}})).status,403);
  assert.equal((await x.call('GET',expired.launchUrl)).status,403);
  let oldestRevoked;
  for(let i=0;i<205;i++){
    const next=(await x.call('GET','/api/previews/preview1')).data;
    assert.ok(next?.launchUrl,`launch ${i} remains available after revocation`);
    if(i===0)oldestRevoked=tokenFrom(next);
    assert.equal((await x.call('POST',endpoint,{body:{capability:tokenFrom(next)}})).status,200);
  }
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM preview_caps WHERE user_id=? AND revoked_at IS NOT NULL')
    .get(x.owner.user.id).n,200);
  assert.equal((await x.call('POST',endpoint,{body:{capability:oldestRevoked}})).status,403);
});

test('Hub does not deliver an asset after in-flight cap, session, or node authority changes',async t=>{
  const x=await hubFixture(t);
  const endpoint='/api/previews/preview1/revoke';
  for(const changed of ['cap','session','subject','node']) {
    const detail=(await x.call('GET','/api/previews/preview1')).data;
    const cap=tokenFrom(detail),url=detail.launchUrl.replace(/index\.html$/,'app.js');
    const gate=x.registry.hold();
    const pending=x.call('GET',url,{as:null,requestOrigin:'null'});
    await gate.entered;
    if(changed==='cap') assert.equal((await x.call('POST',endpoint,{body:{capability:cap}})).status,200);
    else if(changed==='session') x.store.db.prepare('UPDATE account_sessions SET revoked_at=? WHERE token_hash=?')
      .run(Date.now(),sha(x.owner.sessionToken));
    else if(changed==='subject') x.store.db.prepare('UPDATE subjects SET revoked_at=? WHERE id=?')
      .run(new Date().toISOString(),x.subject.id);
    else x.store.db.prepare('UPDATE project_owners SET epoch=? WHERE tenant_id=? AND project_id=?')
      .run(x.node.epoch+1,x.subject.tenant_id,'p1');
    gate.release();
    const response=await pending;
    assert.notEqual(response.status,200,`${changed} changed during the node read`);
    assert.equal(response.bytes.includes(payloads['app.js']),false);
    if(changed==='session'){
      const replacement=await x.accounts.login({username:'preview_revoke_owner',password:'LocalTest-password-239',source:'test'});
      x.owner.sessionToken=replacement.sessionToken;
    }
    if(changed==='subject')x.store.db.prepare('UPDATE subjects SET revoked_at=NULL WHERE id=?').run(x.subject.id);
  }
});

test('local preview revocation binds the exact launch and role, including an in-flight read',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-revoke-local-'));
  let store,server;
  t.after(async()=>{
    const failures=[];
    try{if(server){server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}}catch(error){failures.push(error);}
    try{store?.close();}catch(error){failures.push(error);}
    if(!failures.length)await rm(root,{recursive:true,force:true});
    if(failures.length)throw new AggregateError(failures,'Local preview fixture cleanup failed');
  });
  store=new Store(join(root,'board.sqlite'));
  const project=store.project({name:'Preview',directory:root}),task=store.createTask({projectId:project.id,title:'Preview'});
  const manifest=fixtureManifest(task.id,project.id),registry=controlledRegistry(manifest);
  let clock=Date.now();
  const local=createLocalPreview({store,registry,now:()=>clock});local.record(manifest,[]);
  const listener=await listen(async(req,res)=>{
    const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try{let raw='';for await(const part of req)raw+=part;
      const path=new URL(req.url,origin).pathname;
      if(req.method==='GET'&&path.includes('/site/')){await local.handleSite(req,res,path);return;}
      const role=req.headers.authorization==='Bearer owner'?'owner':req.headers.authorization==='Bearer viewer'?'viewer':null;
      const result=await local.request(req.method,path,raw?JSON.parse(raw):{},role);
      send(200,result);
    }catch(error){if(!res.headersSent)send(error.status||500,{code:error.code||'ERROR'});else res.destroy(error);}
  });
  server=listener.server;const {origin}=listener;
  async function call(method,path,{role='owner',body}={}){
    const response=await fetch(origin+path,{method,headers:{Authorization:`Bearer ${role}`,
      ...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const bytes=Buffer.from(await response.arrayBuffer());
    return {status:response.status,data:response.headers.get('content-type')?.includes('json')?JSON.parse(bytes):null,bytes};
  }
  const first=(await call('GET',`/api/previews/${manifest.previewId}`)).data;
  const other=(await call('GET',`/api/previews/${manifest.previewId}`)).data;
  const cap=tokenFrom(first),revoke=`/api/previews/${manifest.previewId}/revoke`;
  assert.equal((await call('POST',revoke,{role:'viewer',body:{capability:cap}})).status,403);
  const gate=registry.hold(),pending=call('GET',first.launchUrl.replace(/index\.html$/,'app.js'));
  await gate.entered;
  assert.deepEqual((await call('POST',revoke,{body:{capability:cap}})).data,{revoked:true});
  gate.release();
  const inFlight=await pending;
  assert.equal(inFlight.status,403);
  assert.equal(inFlight.bytes.includes(payloads['app.js']),false);
  assert.deepEqual((await call('POST',revoke,{body:{capability:cap}})).data,{revoked:true});
  assert.equal((await call('GET',first.launchUrl)).status,403);
  assert.equal((await call('GET',other.launchUrl)).status,200);
  clock+=600_001;
  assert.equal((await call('GET',other.launchUrl)).status,403);
  assert.equal((await call('POST',revoke,{body:{capability:tokenFrom(other)}})).status,403);
  let oldestRevoked;
  for(let i=0;i<205;i++){
    const next=(await call('GET',`/api/previews/${manifest.previewId}`)).data;
    assert.ok(next?.launchUrl,`local launch ${i} remains available after revocation`);
    if(i===0)oldestRevoked=tokenFrom(next);
    assert.equal((await call('POST',revoke,{body:{capability:tokenFrom(next)}})).status,200);
  }
  assert.equal((await call('POST',revoke,{body:{capability:oldestRevoked}})).status,403);
});
