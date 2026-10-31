/** Browser component contract only: controlled-build transport is mocked, not a Core build. */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

let vite,browser;
try{
  vite=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:0},plugins:[{name:'controlled-build-ui',configureServer(server){server.middlewares.use('/controlled-build-harness',async(_req,res)=>{
    const html=await server.transformIndexHtml('/controlled-build-harness',`<!doctype html><html><body><div id="root"></div><script type="module">import React from 'react';import{createRoot}from'react-dom/client';import PreviewPanel from '/src/PreviewPanel.tsx';const root=createRoot(document.getElementById('root'));window.renderBuild=(props={})=>root.render(React.createElement(PreviewPanel,{taskId:'task-a',projectId:'project-a',accountScope:'local-owner',connectionMode:'local',expectedRevision:7,contentVersion:3,canRegister:true,...props}));window.renderBuild();</script></body></html>`);
    res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
  });}}]});
  await vite.listen();
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await context.addInitScript(origin=>{
    window.__buildPosts=[];window.__buildReads=[];window.__buildRecords=new Map();window.__buildPostMode='lost';window.__list=[];window.__accessPosts=[];
    window.taskboard={request:async(method,path,body)=>{
      if(method==='GET'&&path==='/api/preview/transport')return {kind:'desktop-loopback',origin};
      if(path.startsWith('/api/previews?'))return {previews:structuredClone(window.__list)};
      if(path.includes('/access-intents')&&method==='POST'){
        window.__accessPosts.push(path);
        const intent={id:'i'.repeat(43),previewId:'built-preview',projectId:'project-a',taskId:'task-a',state:path.endsWith('/issue')?'issued':'registered',expiresAt:Date.now()+600000};
        if(path.endsWith('/issue'))return {preview:{...structuredClone(window.__list[0]),provenance:{...window.__list[0].provenance,sourceDigest:'c'.repeat(64)}},launchUrl:`/api/previews/built-preview/site/${'A'.repeat(43)}/index.html`,intent};
        return {intent};
      }
      if(path==='/api/preview/controlled-builds'&&method==='POST'){
        window.__buildPosts.push(body);
        const base={id:body.requestId,...body,state:'unknown'};
        window.__buildRecords.set(body.requestId,base);
        if(window.__buildPostMode==='lost')throw new Error('构建回执丢失');
        return {build:base};
      }
      if(path.startsWith('/api/preview/controlled-builds/')&&['GET','POST'].includes(method)){
        const id=path.split('/')[4];window.__buildReads.push({method,path,id});
        const record=window.__buildRecords.get(id);
        if(!record)throw Object.assign(new Error('暂未找到'),{status:404});
        return {build:record};
      }
      throw new Error(`unexpected ${method} ${path}`);
    }};
  },new URL(vite.resolvedUrls.local[0]).origin);
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(new URL('/controlled-build-harness',vite.resolvedUrls.local[0]).href);
  const start=page.getByRole('button',{name:'从当前代码构建'});
  await start.click();
  await page.getByText('结果待核对',{exact:false}).first().waitFor();
  assert.equal(await page.evaluate(()=>window.__buildPosts.length),1);
  const body=await page.evaluate(()=>window.__buildPosts[0]);
  assert.deepEqual({...body,requestId:null},{requestId:null,projectId:'project-a',taskId:'task-a',expectedRevision:7,contentVersion:3,worktreeId:null,profile:'vite-vanilla-v1',apiTarget:'static',dataMode:'simulated'});
  assert.equal(await start.isDisabled(),true,'unknown build remains locked');
  await page.reload();
  await page.getByText('结果待核对',{exact:false}).first().waitFor();
  assert.equal(await page.evaluate(()=>window.__buildPosts.length),0,'remount never resends POST');
  assert.equal(await start.isDisabled(),true);
  const storedId=await page.evaluate(()=>JSON.parse(localStorage.getItem(localStorage.key(0))).requestId);
  await page.getByRole('button',{name:'读取原结果'}).click();
  assert.equal(await start.isDisabled(),true,'missing GET record does not prove the build was not published');
  await page.evaluate(id=>window.__buildRecords.set(id,{id,requestId:id,projectId:'project-a',taskId:'task-a',expectedRevision:7,contentVersion:3,worktreeId:null,profile:'vite-vanilla-v1',apiTarget:'static',dataMode:'simulated',state:'ready',previewId:'built-preview',sourceDigest:'a'.repeat(64),artifactDigest:'b'.repeat(64)}),storedId);
  await page.evaluate(id=>{const record=window.__buildRecords.get(id);window.__buildRecords.set(id,{...record,taskId:'other-task'});},storedId);
  await page.getByRole('button',{name:'读取原结果'}).click();
  await page.getByText('原构建回执与任务',{exact:false}).waitFor();
  assert.equal(await start.isDisabled(),true,'wrong task receipt must not unlock a new build');
  await page.evaluate(id=>{const record=window.__buildRecords.get(id);window.__buildRecords.set(id,{...record,taskId:'task-a'});},storedId);
  await page.getByRole('button',{name:'读取原结果'}).click();
  await page.getByText('源码快照 aaaaaaaaaaaa',{exact:false}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('.preview-build-controls button')?.disabled);
  assert.equal(await start.isEnabled(),true,'confirmed ready receipt releases the new-start lock');
  await page.evaluate(()=>{window.__list=[{previewId:'other-preview',projectId:'project-a',taskId:'task-a',contentVersion:3,sourceCommit:'a'.repeat(40),artifactDigest:'b'.repeat(64),environment:'测试',dataMode:'simulated',capability:'static-interactive',backendApi:'unsupported',createdAt:'2026-10-18T00:00:00Z'}];});
  await page.getByRole('button',{name:'打开这个预览'}).click();
  await page.getByText('原构建版本或摘要当前无法匹配',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__accessPosts.length),0,'missing saved preview must not issue another preview access');
  assert.equal(await page.locator('iframe').count(),0,'missing saved preview leaves access closed');
  await page.evaluate(()=>{window.__list=[{previewId:'built-preview',projectId:'project-a',taskId:'task-a',contentVersion:3,sourceTaskRevision:7,sourceCommit:'a'.repeat(40),artifactDigest:'c'.repeat(64),environment:'测试',dataMode:'simulated',capability:'static-interactive',backendApi:'unsupported',createdAt:'2026-10-18T00:00:00Z',provenance:{kind:'managed-vite-vanilla-v1',sourceDigest:'a'.repeat(64),inputDigest:'d'.repeat(64),buildReceiptDigest:'e'.repeat(64),toolDigest:'f'.repeat(64),profileDigest:'1'.repeat(64)}}];});
  await page.getByRole('button',{name:'打开这个预览'}).click();
  await page.getByText('原构建版本或摘要当前无法匹配',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__accessPosts.length),0,'same preview ID with changed artifact must not issue access');
  await page.evaluate(()=>{window.__list[0].artifactDigest='b'.repeat(64);});
  await page.evaluate(()=>{delete window.__list[0].sourceTaskRevision;});
  await page.getByRole('button',{name:'打开这个预览'}).click();
  await page.getByText('原构建版本或摘要当前无法匹配',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__accessPosts.length),0,'missing source task revision must not issue access');
  await page.evaluate(()=>{window.__list[0].sourceTaskRevision=8;});
  await page.getByRole('button',{name:'打开这个预览'}).click();
  assert.equal(await page.evaluate(()=>window.__accessPosts.length),0,'wrong source task revision must not issue access');
  await page.evaluate(()=>{window.__list[0].sourceTaskRevision=7;});
  await page.getByRole('button',{name:'打开这个预览'}).click();
  await page.getByText('预览版本与原构建回执',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__accessPosts.filter(path=>path.endsWith('/issue')).length),1,'list artifact and detail artifact agree; source digest mismatch reaches the saved-receipt guard');
  assert.equal(await page.locator('iframe').count(),0,'detail changed after exact list read must not open iframe');
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw new Error('storage denied');};});
  await start.click();
  await page.getByText('storage denied',{exact:false}).waitFor();
  assert.equal(await page.evaluate(()=>window.__buildPosts.length),0,'storage failure must stop POST before sending');
  await page.evaluate(()=>window.renderBuild({taskId:'task-b',expectedRevision:9,contentVersion:4,canRegister:false,connectionMode:'hub',accountScope:'another-account'}));
  await page.getByText('当前设备只可查看').waitFor();
  assert.equal(await page.getByRole('button',{name:'从当前代码构建'}).count(),0,'remote account cannot start a build');
  assert.equal(await page.getByText('源码快照 aaaaaaaaaaaa',{exact:false}).count(),0,'old task receipt cannot enter another task');
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({passed:true,checks:['send-once','exact-body','unknown-lock','reload-read-only','404-lock','wrong-identity-lock','ready-receipt','missing-preview-does-not-open-another','same-id-digest-mismatch','missing-and-wrong-source-revision','late-detail-digest-mismatch','storage-failure-no-post','account-task-isolation'],requestId:storedId}));
  await context.close();
}finally{await browser?.close();await vite?.close();}
