/** Real Core + Hub + Chrome: a disposable Vite page saves through records-v1. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { createCore } from '../../server/core.mjs';
import { createHub } from '../../server/hub/http.mjs';

const root=await mkdtemp(join(tmpdir(),'preview-records-browser-'));
const node=process.execPath;
const vite=join(process.cwd(),'node_modules/vite/bin/vite.js');
const run=(cmd,args,cwd)=>execFileSync(cmd,args,{cwd,stdio:'pipe',timeout:30000});
const until=async(check,label)=>{const end=Date.now()+12000;while(Date.now()<end){try{if(await check())return;}catch{}
  await new Promise(resolve=>setTimeout(resolve,60));}throw Error(label);};
let core,hub,browser;
try{
  const projectDir=join(root,'project'),webDir=join(root,'board-web');await mkdir(projectDir);
  await writeFile(join(projectDir,'.gitignore'),'dist/\n');
  await writeFile(join(projectDir,'index.html'),`<!doctype html><label>Record title<input id="title" value="Browser saved"/></label>
    <button id="save">Save record</button><div id="status">starting</div><ul id="records"></ul>
    <script type="module" src="./main.js"></script>`);
  await writeFile(join(projectDir,'main.js'),`
    const nonce=new URLSearchParams(location.hash.slice(1)).get('seqivo');
    const status=document.querySelector('#status'),list=document.querySelector('#records');
    const boardOrigin=new URL(import.meta.url).origin;
    let scope=null,cap=null,attempt=null;
    const hello=()=>{if(!cap)parent.postMessage({v:1,type:'seqivo-records-ready',nonce,
      previewId:document.body.dataset.previewId,dataStoreId:document.body.dataset.dataStoreId,
      projectId:document.body.dataset.projectId},'*');};
    // The immutable build does not know the IDs until the parent starts it. The
    // IDs come from a nonsecret fragment, while the data cap arrives in memory.
    const fragment=new URLSearchParams(location.hash.slice(1));
    document.body.dataset.previewId=fragment.get('previewId')||'';
    document.body.dataset.dataStoreId=fragment.get('dataStoreId')||'';
    document.body.dataset.projectId=fragment.get('projectId')||'';
    window.addEventListener('message',async event=>{
      if(event.source!==parent||event.origin!==boardOrigin)return;
      const message=event.data;
      if(message?.v!==1||message.nonce!==nonce||message.previewId!==document.body.dataset.previewId||
        message.dataStoreId!==document.body.dataset.dataStoreId||message.projectId!==document.body.dataset.projectId)return;
      if(message.type==='seqivo-records-init'){
        cap=message.dataCapability;scope=message;
        const reply=await fetch('/api/previews/'+scope.previewId+'/data/records',
          {credentials:'omit',headers:{'X-Seqivo-Preview-Data':cap}});
        const body=await reply.json();
        list.replaceChildren(...(body.records||[]).map(record=>{const li=document.createElement('li');li.textContent=record.title;return li;}));
        status.textContent='ready';
      }
      if(message.type==='seqivo-records-save-ack'&&attempt&&message.intentId===attempt.id){
        const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({title:attempt.title})));
        const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
        if(hash!==message.payloadHash)return;
        const reply=await fetch('/api/previews/'+scope.previewId+'/data/records',{method:'POST',credentials:'omit',
          headers:{'Content-Type':'application/json','X-Seqivo-Preview-Data':cap},
          body:JSON.stringify({clientMutationId:message.clientMutationId,title:attempt.title})});
        const body=await reply.json();status.textContent=reply.ok?'saved:'+body.record.id:'error:'+body.code;
      }
    });
    document.querySelector('#save').onclick=()=>{if(!cap)return;attempt={id:crypto.randomUUID(),title:document.querySelector('#title').value.trim()};
      parent.postMessage({v:1,type:'seqivo-records-save-intent',nonce,previewId:scope.previewId,
        dataStoreId:scope.dataStoreId,projectId:scope.projectId,intentId:attempt.id,title:attempt.title},'*');};
    setInterval(hello,100);hello();
  `);
  run('git',['init','-q'],projectDir);run('git',['config','user.email','preview@example.test'],projectDir);
  run('git',['config','user.name','Preview Test'],projectDir);run('git',['add','.'],projectDir);
  run('git',['commit','-qm','Initial'],projectDir);run(node,[vite,'build','--base','./'],projectDir);
  run(node,[vite,'build','--outDir',webDir],process.cwd());
  hub=await createHub({dataDir:join(root,'hub'),distDir:webDir,port:0});
  core=await createCore({dataDir:join(root,'core'),pluginDir:join(root,'plugins'),files:false});
  const project=core.store.project({name:'Records browser',directory:projectDir});
  const task=core.store.createTask({projectId:project.id,title:'Persist record'});
  const username='records_browser',password='LocalTest-password-239';
  const account=await hub.accounts.register({username,password,source:'isolated'});
  await core.remote.login({url:hub.url,username,password,projectIds:[project.id]});
  await until(()=>Boolean(hub.store.db.prepare('SELECT received_at FROM snapshots').get()),'Hub snapshot missing');
  const registered=await core.request('POST','/api/preview/builds',{projectId:project.id,taskId:task.id,
    contentVersion:1,distDir:join(projectDir,'dist'),environment:'isolated',dataMode:'real',apiTarget:'records-v1'});
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.addCookies([{name:'hub_session',value:account.sessionToken,url:hub.url,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();
  const open=async()=>{await page.goto(hub.url);await page.getByRole('button',{name:'任务清单'}).first().click();
    await page.getByRole('button',{name:task.title}).click();await page.getByRole('button',{name:'试用运行预览'}).click();
    await page.frameLocator('.preview-stage iframe').locator('#status').getByText('ready').waitFor();};
  await open();
  const frame=page.frameLocator('.preview-stage iframe');
  await frame.locator('#save').click();
  await until(async()=>/saved:/.test(await frame.locator('#status').innerText()),'Browser save not confirmed');
  const persisted=await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('seqivo-preview-record-v1:'))
    .map(key=>JSON.parse(localStorage.getItem(key))));
  assert.equal(persisted.length,1);
  assert.match(persisted[0].payloadHash,/^[a-f0-9]{64}$/);
  assert.equal('dataCapability' in persisted[0],false);
  assert.equal('title' in persisted[0],false);
  await page.reload();
  await page.getByRole('button',{name:'任务清单'}).first().click();
  await page.getByRole('button',{name:task.title}).click();await page.getByRole('button',{name:'试用运行预览'}).click();
  await page.frameLocator('.preview-stage iframe').locator('#records li').getByText('Browser saved').waitFor();
  await page.getByRole('region',{name:'动态记录恢复'}).getByRole('button',{name:'读取原结果'}).click();
  await page.getByRole('region',{name:'动态记录恢复'}).getByText(/保存 已确认/).waitFor();
  let lostResponse=null,routeError=null,postCount=0;
  const recordRoute='**/api/previews/*/data/records';
  await page.route(recordRoute,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    postCount++;
    try{
      const request=route.request(),url=new URL(request.url()),headers=request.headers(),body=request.postData();
      assert.equal(url.origin,hub.url);
      assert.equal(url.pathname,`/api/previews/${registered.preview.previewId}/data/records`);
      assert.equal(request.method(),'POST');assert.equal(headers.origin,'null');
      assert.equal(headers['content-type'],'application/json');
      assert.match(headers['x-seqivo-preview-data']||'',/^[A-Za-z0-9_-]{43}$/);
      assert.equal(typeof body,'string');
      const response=await fetch(url,{method:'POST',redirect:'error',headers:{
        Origin:headers.origin,'Content-Type':headers['content-type'],
        'X-Seqivo-Preview-Data':headers['x-seqivo-preview-data']},body});
      if(response.status!==200){const result=await response.json();
        throw Error(`Original save rejected: ${response.status} ${result.code||'UNKNOWN'}`);}
      lostResponse=await response.json();
      assert.equal(lostResponse.record?.title,'Lost reply record');
      assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n,2);
      await route.abort('failed');
    }
    catch(error){routeError=error;await route.abort().catch(()=>{});}
  });
  const lostFrame=page.frameLocator('.preview-stage iframe');
  await lostFrame.locator('#title').fill('Lost reply record');await lostFrame.locator('#save').click();
  await until(()=>Boolean(lostResponse||routeError),'Original save did not reach Hub');
  if(routeError)throw routeError;
  await page.unroute(recordRoute);
  assert.equal(postCount,1,'response loss must not auto-resend');
  await page.reload();
  await page.getByRole('button',{name:'任务清单'}).first().click();
  await page.getByRole('button',{name:task.title}).click();await page.getByRole('button',{name:'试用运行预览'}).click();
  await page.frameLocator('.preview-stage iframe').locator('#records li').getByText('Lost reply record').waitFor();
  await page.getByRole('region',{name:'动态记录恢复'}).getByRole('button',{name:'读取原结果'}).click();
  await until(async()=>await page.getByRole('region',{name:'动态记录恢复'}).getByText(/保存 已确认/).count()===2,
    'Lost response was not recovered by original mutation key');
  const records=core.previewLocal;
  assert.ok(records);
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_record_operations').get().n,2);
  console.log('records-v1 browser save/reload confirmed',registered.preview.previewId);
}finally{
  const failures=[];for(const close of [()=>browser?.close(),()=>core?.close(),()=>hub?.close()])
    try{await close();}catch(error){failures.push(error);}
  if(!failures.length)try{await rm(root,{recursive:true,force:true});}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Preview browser cleanup failed');
}
