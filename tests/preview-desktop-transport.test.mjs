import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCore } from '../server/core.mjs';
import { startHttp } from '../server/http.mjs';
import { createLocalPreview } from '../server/preview/local.mjs';
import { Store } from '../server/store.mjs';

const nativeOrigins=['tauri://localhost','http://tauri.localhost','https://tauri.localhost'];

test('desktop transport uses the actual loopback listener and only the owner may read it',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-desktop-transport-'));
  const desktopDir=join(root,'desktop'),webRoot=root;
  await writeFile(join(root,'index.html'),'<!doctype html><title>Test</title>');
  let desktop,http,standalone;
  t.after(async()=>{
    const failures=[];
    for(const close of [()=>http?.close(),()=>desktop?.close(),()=>standalone?.close()])
      try{await close();}catch(error){failures.push(error);}
    if(!failures.length)await rm(root,{recursive:true,force:true});
    if(failures.length)throw new AggregateError(failures,'Desktop transport fixture cleanup failed');
  });
  desktop=await createCore({dataDir:desktopDir,pluginDir:resolve('plugins'),files:false,desktop:true});
  await assert.rejects(desktop.request('GET','/api/preview/transport',{},'owner'),{code:'PREVIEW_TRANSPORT_UNAVAILABLE'});
  await assert.rejects(desktop.request('GET','/api/preview/transport',{},'viewer'),{code:'PREVIEW_FORBIDDEN'});
  http=await startHttp({core:desktop,dataDir:desktopDir,distDir:webRoot,host:'127.0.0.1',port:0});
  const origin=`http://127.0.0.1:${http.port}`;
  const transport=await desktop.request('GET','/api/preview/transport',{},'owner');
  assert.deepEqual(transport,{kind:'desktop-loopback',origin});
  desktop.previewTransport.bind(http.server);
  assert.deepEqual(await desktop.request('GET','/api/preview/transport'),transport);
  await assert.rejects(startHttp({core:desktop,dataDir:desktopDir,distDir:webRoot,host:'127.0.0.1',port:0}),{code:'PREVIEW_TRANSPORT_CHANGED'});
  assert.throws(()=>desktop.previewTransport.bind({listening:true,address:()=>({address:'::1',port:http.port})}),{code:'PREVIEW_TRANSPORT_UNAVAILABLE'});
  assert.throws(()=>desktop.previewTransport.bind({listening:false,address:()=>({address:'127.0.0.1',port:http.port})}),{code:'PREVIEW_TRANSPORT_UNAVAILABLE'});
  const owner=()=>({Authorization:`Bearer ${http.tokens.owner}`});
  const get=(path,headers)=>fetch(origin+path,{headers});
  assert.deepEqual(await (await get('/api/preview/transport',owner())).json(),transport);
  assert.equal((await get('/api/preview/transport',{Authorization:`Bearer ${http.tokens.viewer}`})).status,403);
  const spoofStatus=await new Promise((resolveStatus,reject)=>{
    const request=httpRequest(origin+'/api/preview/transport',{headers:{...owner(),Host:'other.example'}},response=>{
      response.resume();response.once('end',()=>resolveStatus(response.statusCode));
    });
    request.once('error',reject);request.end();
  });
  assert.equal(spoofStatus,403);
  assert.equal((await get('/api/preview/transport',{...owner(),Origin:nativeOrigins[0]})).status,403);
  assert.deepEqual(await desktop.request('GET','/api/preview/transport'),transport);
  standalone=await createCore({dataDir:join(root,'standalone'),pluginDir:resolve('plugins'),files:false});
  await assert.rejects(standalone.request('GET','/api/preview/transport',{},'owner'),{code:'PREVIEW_TRANSPORT_UNAVAILABLE'});
  assert.equal(standalone.previewTransport,null);
});

test('native origins affect only desktop preview site GET and its HTML frame ancestors',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-desktop-site-'));
  const store=new Store(join(root,'board.sqlite'));
  const project=store.project({name:'Transport fixture',directory:root});
  const task=store.createTask({projectId:project.id,title:'Preview',criteria:['loads']});
  const html=Buffer.from('<!doctype html><script type="module" src="./app.js"></script>');
  const js=Buffer.from('document.body.dataset.loaded="yes"');
  const manifest={previewId:'transport-preview',projectId:project.id,taskId:task.id,
    contentVersion:task.contentVersion,artifactDigest:'a'.repeat(64),sourceCommit:'b'.repeat(40),
    environment:'test',dataMode:'simulated',capability:'static-interactive',backendApi:'unsupported',
    files:[],createdAt:new Date().toISOString()};
  const registry={get:async id=>id===manifest.previewId?manifest:null,
    isRegistered:async id=>id===manifest.previewId,
    read:async(id,path)=>{
      if(id!==manifest.previewId||!['index.html','app.js'].includes(path))throw Error('Missing test asset');
      return {bytes:path==='index.html'?html:js};
    }};
  const desktopLocal=createLocalPreview({store,registry,desktop:true});
  const standaloneLocal=createLocalPreview({store,registry});
  desktopLocal.record(manifest,task.criteria,root);
  let desktopHttp,standaloneHttp;
  t.after(async()=>{
    const failures=[];
    for(const close of [()=>desktopHttp?.close(),()=>standaloneHttp?.close(),()=>store.close()])
      try{await close();}catch(error){failures.push(error);}
    if(!failures.length)await rm(root,{recursive:true,force:true});
    if(failures.length)throw new AggregateError(failures,'Preview site fixture cleanup failed');
  });
  const fakeCore=(previewLocal,desktop)=>({previewLocal,events:new EventEmitter(),terminal:null,
    previewTransport:desktop?{bind(listener){assert.equal(listener.address().address,'127.0.0.1');}}:null,
    request:async()=>({ok:true})});
  desktopHttp=await startHttp({core:fakeCore(desktopLocal,true),dataDir:join(root,'desktop-http'),distDir:root,port:0});
  standaloneHttp=await startHttp({core:fakeCore(standaloneLocal,false),dataDir:join(root,'standalone-http'),distDir:root,port:0});
  const desktopOrigin=`http://127.0.0.1:${desktopHttp.port}`;
  const standaloneOrigin=`http://127.0.0.1:${standaloneHttp.port}`;
  const desktopDetail=await desktopLocal.request('GET',`/api/previews/${manifest.previewId}`,{},'owner');
  const standaloneDetail=await standaloneLocal.request('GET',`/api/previews/${manifest.previewId}`,{},'owner');
  assert.match(desktopDetail.launchUrl,/^\/api\/previews\/transport-preview\/site\//);
  assert.match(standaloneDetail.launchUrl,/^\/api\/previews\/transport-preview\/site\//);
  for(const nativeOrigin of nativeOrigins){
    const site=await fetch(desktopOrigin+desktopDetail.launchUrl,{headers:{Origin:nativeOrigin}});
    assert.equal(site.status,200);
    assert.equal(await site.text(),html.toString());
    assert.equal(site.headers.get('x-frame-options'),null);
    const csp=site.headers.get('content-security-policy');
    assert.match(csp,/sandbox allow-scripts allow-forms;/);
    assert.match(csp,new RegExp(`frame-ancestors http:\\/\\/127\\.0\\.0\\.1:${desktopHttp.port} tauri:\\/\\/localhost http:\\/\\/tauri\\.localhost https:\\/\\/tauri\\.localhost;`));
    assert.doesNotMatch(csp,/allow-same-origin/);
    const standaloneSite=await fetch(standaloneOrigin+standaloneDetail.launchUrl,{headers:{Origin:nativeOrigin}});
    assert.equal(standaloneSite.status,403);
    assert.equal((await fetch(desktopOrigin+'/api/state',{headers:{Origin:nativeOrigin,Authorization:`Bearer ${desktopHttp.tokens.owner}`}})).status,403);
    assert.equal((await fetch(desktopOrigin+'/api/previews/transport-preview/data/records',{headers:{Origin:nativeOrigin}})).status,403);
    assert.equal((await fetch(desktopOrigin+desktopDetail.launchUrl,{method:'POST',headers:{Origin:nativeOrigin}})).status,403);
  }
  const ordinary=await fetch(standaloneOrigin+standaloneDetail.launchUrl);
  assert.equal(ordinary.status,200);
  assert.doesNotMatch(ordinary.headers.get('content-security-policy'),/tauri/);
  const desktopBrowser=await fetch(desktopOrigin+desktopDetail.launchUrl);
  assert.equal(desktopBrowser.status,200);
});
