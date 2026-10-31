/** Mock transport only. Native WebView, CSP, Core authorization and real preview serving need separate acceptance. */
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {createServer} from 'vite';

const loopback='http://127.0.0.1:43127';
const capability='A'.repeat(43),intentId='I'.repeat(43);
const manifest=(id,createdAt)=>({previewId:id,projectId:'project-1',taskId:'task-1',contentVersion:1,
  sourceCommit:'a'.repeat(40),artifactDigest:'b'.repeat(64),environment:'隔离测试',dataMode:'simulated',
  capability:'static-interactive',backendApi:'unsupported',createdAt});
const previews=[manifest('p1','2026-10-18T02:00:00Z'),manifest('p2','2026-10-18T01:00:00Z')];
const entry=id=>`/api/previews/${id}/site/${capability}/index.html`;
let vite,browser;
try{
  vite=await createServer({configFile:false,root:process.cwd(),server:{host:'127.0.0.1',port:0},
    plugins:[{name:'preview-desktop-harness',configureServer(server){server.middlewares.use('/preview-desktop-harness',async(_req,res)=>{
      const html=await server.transformIndexHtml('/preview-desktop-harness',`<!doctype html><html><div id="root"></div><script type="module">import React from 'react';import{createRoot}from'react-dom/client';import PreviewPanel from '/src/PreviewPanel.tsx';createRoot(document.getElementById('root')).render(React.createElement(PreviewPanel,{taskId:'task-1',projectId:'project-1',accountScope:'local-owner',connectionMode:'local',expectedRevision:1,contentVersion:1}));</script></html>`);
      res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);
    });}}]});
  await vite.listen();
  const pageUrl=new URL('/preview-desktop-harness',vite.resolvedUrls.local[0]).href;
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});

  async function nativePage(transport,{holdFirst=false,holdFirstIssue=false}={}){
    const context=await browser.newContext({serviceWorkers:'block'});
    await context.addInitScript(({transport,previews,capability,intentId,holdFirst,holdFirstIssue})=>{
      window.__transport=transport;window.__calls=[];window.__holdFirst=holdFirst;window.__holdFirstIssue=holdFirstIssue;window.__transportCalls=0;
      window.taskboard={request:async(method,path)=>{
        window.__calls.push({method,path});
        if(path==='/api/preview/transport'){
          window.__transportCalls++;
          if(window.__holdFirst&&window.__transportCalls===1)return new Promise(resolve=>{window.__releaseTransport=resolve;});
          return window.__transport;
        }
        if(path.startsWith('/api/previews?'))return {previews};
        const id=path.split('/')[3];
        const base=`/api/previews/${id}/access-intents`;
        if(method==='POST'&&path===base)return {intent:{id:intentId,previewId:id,projectId:'project-1',taskId:'task-1',state:'registered',expiresAt:Date.now()+600000}};
        if(method==='POST'&&path===`${base}/${intentId}/close`)return {intent:{id:intentId,previewId:id,projectId:'project-1',taskId:'task-1',state:'closed',expiresAt:Date.now()+600000},inactive:true};
        if(method==='POST'&&path===`${base}/${intentId}/issue`){
          const result={preview:previews.find(item=>item.previewId===id),launchUrl:`/api/previews/${id}/site/${capability}/index.html`,
            intent:{id:intentId,previewId:id,projectId:'project-1',taskId:'task-1',state:'issued',expiresAt:Date.now()+600000}};
          if(window.__holdFirstIssue&&id==='p1'){window.__issueHeld=true;return new Promise(resolve=>{window.__releaseIssue=()=>resolve(result);});}
          return result;
        }
        throw Error(`Unexpected mock request: ${method} ${path}`);
      }};
    },{transport,previews,capability,intentId,holdFirst,holdFirstIssue});
    await context.route(`${loopback}/api/previews/**`,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><button id="go" onclick="document.body.dataset.done=\'yes\'">试用</button></body></html>'}));
    const page=await context.newPage();await page.goto(pageUrl);return {context,page};
  }
  const good=await nativePage({kind:'desktop-loopback',origin:loopback});
  const iframe=good.page.locator('.preview-stage iframe');await iframe.waitFor();
  assert.equal((await iframe.getAttribute('src')).startsWith(`${loopback}${entry('p1')}`),true,'native iframe uses only the checked loopback origin');
  assert.equal(await iframe.getAttribute('sandbox'),'allow-scripts allow-forms');
  await good.page.frameLocator('.preview-stage iframe').locator('#go').click();
  assert.equal(await good.page.frameLocator('.preview-stage iframe').locator('body').getAttribute('data-done'),'yes');
  const calls=await good.page.evaluate(()=>window.__calls);
  assert.equal(calls[0].path,'/api/previews?taskId=task-1');
  assert.ok(calls.findIndex(item=>item.path==='/api/preview/transport')<calls.findIndex(item=>item.path.endsWith('/access-intents')),'transport precedes access registration');
  assert.equal(calls.filter(item=>item.path.endsWith('/issue')).length,1);
  await good.context.close();

  for(const badOrigin of [
    {kind:'desktop-loopback',origin:'http://localhost:43127'},
    {kind:'desktop-loopback',origin:'http://127.0.0.1:43127/extra'},
    {kind:'desktop-loopback',origin:'http://127.0.0.1:43127?x=1'},
    {kind:'desktop-loopback',origin:'http://127.0.0.1:43127#x'},
    {kind:'desktop-loopback',origin:'http://user@127.0.0.1:43127'},
    {kind:'desktop-loopback',origin:'https://127.0.0.1:43127'},
    {kind:'desktop-loopback',origin:'http://127.0.0.1:0'},
    {kind:'wrong',origin:loopback},
    {origin:loopback},
  ]){
    const {context,page}=await nativePage(badOrigin);
    await page.getByText('桌面预览连接暂不可用',{exact:false}).first().waitFor();
    assert.equal(await page.locator('iframe').count(),0);
    const paths=await page.evaluate(()=>window.__calls.map(item=>item.path));
    assert.equal(paths.some(path=>path.includes('/access-intents')),false,'invalid transport cannot register or issue a link');
    await context.close();
  }

  const retry=await nativePage({kind:'desktop-loopback',origin:'http://evil.invalid:43127'});
  await retry.page.getByRole('button',{name:'重新连接预览'}).waitFor();
  await retry.page.evaluate(value=>{window.__transport=value;},{kind:'desktop-loopback',origin:loopback});
  await retry.page.getByRole('button',{name:'重新连接预览'}).click();
  await retry.page.locator('.preview-stage iframe').waitFor();
  assert.equal((await retry.page.locator('iframe').getAttribute('src')).startsWith(`${loopback}${entry('p1')}`),true);
  await retry.context.close();

  const stale=await nativePage({kind:'desktop-loopback',origin:loopback},{holdFirst:true});
  await stale.page.waitForFunction(()=>window.__transportCalls===1);
  await stale.page.getByLabel('预览版本').selectOption('p2');
  await stale.page.evaluate(()=>window.__releaseTransport(window.__transport));
  await stale.page.locator('.preview-stage iframe').waitFor();
  assert.equal((await stale.page.locator('iframe').getAttribute('src')).startsWith(`${loopback}${entry('p2')}`),true);
  assert.deepEqual((await stale.page.evaluate(()=>window.__calls.filter(item=>item.path.endsWith('/access-intents')).map(item=>item.path))),['/api/previews/p2/access-intents'],'late transport cannot issue for the old selected preview');
  await stale.context.close();

  const lateIssue=await nativePage({kind:'desktop-loopback',origin:loopback},{holdFirstIssue:true});
  await lateIssue.page.waitForFunction(()=>window.__issueHeld===true);
  await lateIssue.page.getByLabel('预览版本').selectOption('p2');
  await lateIssue.page.locator('.preview-stage iframe').waitFor();
  await lateIssue.page.evaluate(()=>window.__releaseIssue());
  assert.equal((await lateIssue.page.locator('iframe').getAttribute('src')).startsWith(`${loopback}${entry('p2')}`),true,'late p1 issue cannot replace p2 iframe');
  await lateIssue.context.close();

  const web=await browser.newContext({serviceWorkers:'block'});
  const webCalls=[];
  await web.route('**/api/preview/transport',route=>{webCalls.push('transport');return route.fulfill({status:500,json:{error:'must not be called'}});});
  await web.route('**/api/previews**',route=>{
    const {pathname}=new URL(route.request().url());
    if(pathname==='/api/previews')return route.fulfill({json:{previews:[previews[0]]}});
    if(pathname.endsWith('/access-intents'))return route.fulfill({json:{intent:{id:intentId,previewId:'p1',projectId:'project-1',taskId:'task-1',state:'registered',expiresAt:Date.now()+600000}}});
    if(pathname.endsWith('/issue'))return route.fulfill({json:{preview:previews[0],launchUrl:entry('p1'),intent:{id:intentId,previewId:'p1',projectId:'project-1',taskId:'task-1',state:'issued',expiresAt:Date.now()+600000}}});
    if(pathname===entry('p1'))return route.fulfill({contentType:'text/html',body:'<!doctype html><html><body>web preview</body></html>'});
    return route.fulfill({status:404,json:{error:'not found'}});
  });
  const webPage=await web.newPage();await webPage.goto(pageUrl);
  await webPage.locator('.preview-stage iframe').waitFor();
  assert.equal((await webPage.locator('iframe').getAttribute('src')).startsWith(new URL(pageUrl).origin+entry('p1')),true);
  assert.deepEqual(webCalls,[],'ordinary web must not call or accept the native transport getter');
  await web.close();
  console.log('Preview desktop transport mock PASS: strict origin; no link before verification; stale response; web unchanged');
}finally{await browser?.close();await vite?.close();}
