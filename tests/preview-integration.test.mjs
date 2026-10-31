import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createCore } from '../server/core.mjs';
import { createHub } from '../server/hub/http.mjs';
import { startHttp } from '../server/http.mjs';
import { Store } from '../server/store.mjs';

const vite = join(process.cwd(), 'node_modules/vite/bin/vite.js');
const run = (cmd,args,cwd) => execFileSync(cmd,args,{cwd,stdio:'pipe',timeout:30000});
async function until(fn,timeout=10000) {
  const end=Date.now()+timeout; let last;
  while(Date.now()<end) { try { const value=await fn(); if(value)return value; } catch(error){last=error;} await new Promise(resolve=>setTimeout(resolve,50)); }
  throw last||new Error('Condition timed out');
}

test('real Core and Hub register an immutable Vite build and create feedback exactly once across Core restart',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-integration-'));
  const projectDir=join(root,'project');await mkdir(projectDir);
  await writeFile(join(projectDir,'.gitignore'),'dist/\n');
  await writeFile(join(projectDir,'index.html'),'<button id="go">Click</button><span id="result">waiting</span><img id="asset" src="./image.svg"><script type="module" src="./main.js"></script>');
  await writeFile(join(projectDir,'main.js'),"import './style.css';document.querySelector('#go').onclick=async()=>{const m=await import('./counter.js');document.querySelector('#result').textContent=m.value};");
  await writeFile(join(projectDir,'style.css'),'#go{color:rgb(12,34,56)}');
  await writeFile(join(projectDir,'counter.js'),"export const value='dynamic module worked';\n");
  run('git',['init','-q'],projectDir);run('git',['config','user.email','preview@example.test'],projectDir);
  run('git',['config','user.name','Preview Test'],projectDir);run('git',['add','.'],projectDir);
  run('git',['commit','-qm','Initial preview'],projectDir);run(process.execPath,[vite,'build','--base','./'],projectDir);
  await writeFile(join(projectDir,'dist','image.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  await writeFile(join(projectDir,'dist','attack.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script href="./svg-attack.js"></script><rect width="10" height="10"/></svg>');
  await writeFile(join(projectDir,'dist','svg-attack.js'),'document.documentElement.dataset.attack="ran";fetch("/api/state",{credentials:"include"}).then(()=>document.documentElement.dataset.api="allowed",()=>document.documentElement.dataset.api="blocked")');
  await writeFile(join(projectDir,'dist','attack.HTML'),'<!doctype html><script src="./attack.js"></script>');
  await writeFile(join(projectDir,'dist','attack.js'),'document.documentElement.dataset.storage=(()=>{try{return sessionStorage.getItem("taskboard-token")||"empty"}catch{return "denied"}})();fetch("/api/state",{credentials:"include"}).then(()=>document.documentElement.dataset.api="allowed",()=>document.documentElement.dataset.api="blocked")');
  await writeFile(join(projectDir,'dist','unknown.xhtml'),'<script src="./attack.js"></script>');
  const coreData=join(root,'core'),hub=await createHub({dataDir:join(root,'hub'),port:0});
  let core=await createCore({dataDir:coreData,pluginDir:join(root,'plugins'),files:false});
  t.after(async()=>{await core.close();await hub.close();await rm(root,{recursive:true,force:true});});
  const project=core.store.project({name:'Preview integration',directory:projectDir});
  const task=core.store.createTask({projectId:project.id,title:'Interactive preview',criteria:['Click loads the dynamic module']});
  const username='preview_real',password='LocalTest-password-239';
  const account=await hub.accounts.register({username,password,source:'isolated'});
  const cookie=`hub_session=${account.sessionToken}`;
  const call=async(method,path,body,origin=hub.url)=>{
    const response=await fetch(hub.url+path,{method,headers:{Cookie:cookie,...(origin?{Origin:origin}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const bytes=Buffer.from(await response.arrayBuffer());
    return {status:response.status,headers:response.headers,bytes,data:response.headers.get('content-type')?.includes('json')?JSON.parse(bytes.toString()):null};
  };
  await core.remote.login({url:hub.url,username,password,projectIds:[project.id]});
  await until(()=>hub.store.db.prepare('SELECT received_at FROM snapshots').get()?.received_at);
  await assert.rejects(core.request('POST','/api/preview/builds',{projectId:project.id,taskId:task.id,contentVersion:1,distDir:join(projectDir,'dist'),environment:'test',dataMode:'simulated'},'viewer'),{code:'PREVIEW_FORBIDDEN'});
  const registered=await core.request('POST','/api/preview/builds',{projectId:project.id,taskId:task.id,contentVersion:1,distDir:join(projectDir,'dist'),environment:'本机静态构建',dataMode:'simulated'});
  const id=registered.preview.previewId;
  assert.equal(registered.preview.capability,'static-interactive');
  assert.equal(registered.preview.backendApi,'unsupported');
  assert.equal(JSON.stringify(registered).includes(projectDir),false);
  const local=await startHttp({core,dataDir:coreData,distDir:root,port:0});
  t.after(()=>local.close());
  const localOrigin=`http://127.0.0.1:${local.port}`;
  const localCall=async(method,path,body,token=local.tokens.owner,requestOrigin=localOrigin)=>{
    const response=await fetch(localOrigin+path,{method,headers:{Authorization:`Bearer ${token}`,...(requestOrigin?{Origin:requestOrigin}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const bytes=Buffer.from(await response.arrayBuffer());
    return {status:response.status,headers:response.headers,bytes,data:response.headers.get('content-type')?.includes('json')?JSON.parse(bytes.toString()):null};
  };
  const localList=await localCall('GET',`/api/previews?taskId=${task.id}`);
  assert.equal(localList.status,200);assert.equal(localList.data.previews.length,1);
  const localDetail=await localCall('GET',`/api/previews/${id}`);assert.equal(localDetail.status,200);
  const localHtml=await localCall('GET',localDetail.data.launchUrl,undefined,local.tokens.owner,null);
  assert.equal(localHtml.status,200);assert.match(localHtml.headers.get('content-security-policy'),/sandbox allow-scripts allow-forms;/);
  const unknown=await localCall('GET',localDetail.data.launchUrl.replace(/index\.html$/,'unknown.xhtml'));
  assert.equal(unknown.headers.get('content-disposition'),'attachment');
  assert.match(unknown.headers.get('content-security-policy'),/^sandbox;/);
  assert.equal((await localCall('GET','/api/state',undefined,local.tokens.owner,'null')).status,403);
  assert.equal((await localCall('POST',`/api/previews/${id}/feedback`,{pagePath:'index.html',summary:'viewer cannot submit',idempotencyKey:'viewer'},local.tokens.viewer)).status,403);
  const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  try{const page=await browser.newPage();await page.goto(localOrigin+localDetail.data.launchUrl);await page.locator('#go').click();
    await page.locator('#result').getByText('dynamic module worked').waitFor({timeout:5000});
    assert.equal(await page.locator('#asset').evaluate(image=>image.complete&&image.naturalWidth>0),true);
    assert.equal(await page.locator('#go').evaluate(button=>getComputedStyle(button).color),'rgb(12, 34, 56)');
    assert.equal(await page.evaluate(()=>window.origin),'null');
    assert.equal(await page.evaluate(async()=>{try{await fetch('/api/state',{credentials:'include'});return 'allowed';}catch{return 'blocked';}}),'blocked');
    const assetUrl=file=>localOrigin+localDetail.data.launchUrl.replace(/index\.html$/,file);
    await page.goto(assetUrl('attack.svg'));
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(()=>window.origin),'null');
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.attack),undefined);
    await page.goto(localOrigin+'/api/state');
    await page.evaluate(token=>sessionStorage.setItem('taskboard-token',token),local.tokens.owner);
    await page.goto(assetUrl('attack.HTML'));
    await page.waitForFunction(()=>document.documentElement.dataset.api==='blocked');
    assert.equal(await page.evaluate(()=>window.origin),'null');
    assert.equal(await page.evaluate(()=>document.documentElement.dataset.storage),'denied');
  }finally{await browser.close();}
  const localDraft=await localCall('POST',`/api/previews/${id}/feedback`,{pagePath:'index.html',summary:'Local desktop feedback',idempotencyKey:'local-feedback'});
  assert.equal(localDraft.status,200);assert.equal(core.store.tasks(project.id).length,1);
  const localConfirm=await localCall('POST',`/api/previews/${id}/feedback/${localDraft.data.feedback.id}/confirm`,{});
  assert.equal(localConfirm.status,200,JSON.stringify(localConfirm.data));
  assert.equal(core.store.getTask(localConfirm.data.feedback.taskId).previewFeedback.pagePath,'index.html');
  assert.equal((await localCall('POST',`/api/previews/${id}/feedback/${localDraft.data.feedback.id}/confirm`,{})).data.feedback.taskId,localConfirm.data.feedback.taskId);
  const listing=await call('GET',`/api/previews?taskId=${task.id}`);
  assert.equal(listing.status,200);assert.equal(listing.data.previews.length,1);
  assert.equal(JSON.stringify(listing.data).includes(projectDir),false);
  const detail=await call('GET',`/api/previews/${id}`);assert.equal(detail.status,200);
  const html=await call('GET',detail.data.launchUrl);assert.equal(html.status,200);
  assert.match(html.headers.get('content-security-policy'),/sandbox allow-scripts allow-forms;/);
  assert.equal(html.headers.get('x-frame-options'),null);
  assert.equal((await call('GET','/api/state',undefined,'null')).status,403);
  const draft=await call('POST',`/api/previews/${id}/feedback`,{pagePath:'index.html',summary:'Button failed in review',criterionIds:[task.criteria[0].id],idempotencyKey:'same-feedback'});
  assert.equal(draft.status,200);assert.equal(core.store.tasks(project.id).length,2);
  const feedbackId=draft.data.feedback.id;
  const confirmPath=`/api/previews/${id}/feedback/${feedbackId}/confirm`;
  const first=await call('POST',confirmPath,{});assert.equal(first.status,200,JSON.stringify(first.data));
  const createdId=first.data.feedback.taskId;
  const created=core.store.getTask(createdId);
  assert.equal(created.previewFeedback.feedbackId,feedbackId);
  assert.equal(created.previewFeedback.previewId,id);
  assert.equal(created.previewFeedback.sourceTaskId,task.id);
  assert.equal(core.store.tasks(project.id).length,3);
  const again=await call('POST',confirmPath,{});assert.equal(again.data.feedback.taskId,createdId);
  // Simulate a Hub crash after the Core commit and before Hub saved its confirmation receipt.
  hub.store.db.prepare('UPDATE preview_feedback SET status=?,task_id=NULL,confirmed_at=NULL WHERE id=?').run('confirming',feedbackId);
  // Simulate the equivalent local receipt write being lost after the atomic task commit.
  core.store.db.prepare('UPDATE preview_local_feedback SET status=?,task_id=NULL WHERE id=?').run('confirming',localDraft.data.feedback.id);
  await local.close();await core.close();core=await createCore({dataDir:coreData,pluginDir:join(root,'plugins'),files:false});
  const localFeedbackPath=`/api/previews/${id}/feedback/${localDraft.data.feedback.id}`;
  await assert.rejects(core.request('POST',`${localFeedbackPath}/confirm`,{}),{code:'PREVIEW_FEEDBACK_UNKNOWN'});
  assert.equal((await core.request('GET',localFeedbackPath)).verification.state,'unknown');
  const retriedLocal=await core.request('POST',`${localFeedbackPath}/reconcile`,{});
  assert.equal(retriedLocal.feedback.taskId,localConfirm.data.feedback.taskId);
  await until(()=>hub.store.db.prepare('SELECT received_at FROM snapshots WHERE node_id=?').get(core.remote.state().nodeId)?.received_at);
  const refused=await call('POST',confirmPath,{});
  assert.equal(refused.status,409);assert.equal(refused.data.code,'PREVIEW_FEEDBACK_UNKNOWN');
  const retried=await until(async()=>{const result=await call('POST',`/api/previews/${id}/feedback/${feedbackId}/reconcile`,{});
    return result.status===200&&result.data.feedback.status==='confirmed'?result:null;});
  assert.equal(retried.data.feedback.taskId,createdId);
  assert.equal(core.store.tasks(project.id).length,3);
});

test('preview task receipts survive board journal replay and archive restore',async t=>{
  const root=await mkdtemp(join(tmpdir(),'preview-journal-'));
  const store=new Store(join(root,'board.sqlite'));
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const project=store.project({name:'Preview receipts'}),source=store.createTask({projectId:project.id,title:'Source'});
  const input={idempotencyKey:'feedback1',projectId:project.id,
    sourcePreview:{previewId:'preview1',taskId:source.id,contentVersion:1,artifactDigest:'a'.repeat(64),environment:'本机静态构建',dataMode:'simulated'},
    pagePath:'index.html',summary:'Check interaction',criterionIds:[],criterionItems:[],reporterUserId:'local_owner'};
  const first=store.createPreviewFeedbackTask(input),archive=store.exportArchive();
  store.replay();assert.equal(store.createPreviewFeedbackTask(input).id,first.id);
  store.restoreArchive(archive);assert.equal(store.createPreviewFeedbackTask(input).id,first.id);
  assert.equal(store.tasks(project.id).length,2);
});
