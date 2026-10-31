import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,webkit} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const dir=await mkdtemp(join(tmpdir(),'seqivo-mobile-offline-'));
const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
let core,web,browser;
try{
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'离线写入验收',goal:'验证断网时只读'});
  const decisionTask=core.store.createTask({projectId:project.id,title:'断网后处理的决策',goal:'保持草稿',criteria:['不得离线提交']});
  core.inbox.requestDecision(decisionTask.id,{expectedRevision:decisionTask.revision,requestId:'offline-decision',title:'断网后回答此问题',summary:'检查客户端断网保护。',impact:'不能在客户端离线时提交。',options:[{id:'one',label:'方案一',consequence:'保留待提交'}],shareWithRemote:true});
  const reviewTask=core.store.createTask({projectId:project.id,title:'断网后验收的任务',goal:'保持只读',criteria:['恢复联网后重新读取状态']});
  core.store.updateTask(reviewTask.id,{status:'submitted'},reviewTask.revision);
  web=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve('dist'),port:0});
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
  const base=await core.state();
  const snapshot={...base,projects:base.projects.map(item=>({...item,inboxAvailable:true})),tasks:base.tasks.map(item=>({...item,hasExecutionBinding:true})),inbox:{...base.inbox,items:base.inbox.items,omitted:[]},connection:{...base.connection,mode:'hub',offline:false},capabilities:{...base.capabilities,remote:true,inbox:true,role:'controller'}};
  let stateMode='ok';let stateReads=0;const stateReadsByPage=new WeakMap();const readCount=clientPage=>stateReadsByPage.get(clientPage)||0;let posts=[];let holdNextStateGet=false;let releaseStateGet;let delayNextStateGet=false;
  await context.route('**/api/**',async route=>{
    const request=route.request();const path=new URL(request.url()).pathname;
    if(request.method()==='GET'&&path==='/api/state'){stateReads++;const clientPage=request.frame().page();stateReadsByPage.set(clientPage,readCount(clientPage)+1);if(holdNextStateGet){holdNextStateGet=false;await new Promise(resolve=>{releaseStateGet=resolve;});}if(delayNextStateGet){delayNextStateGet=false;await new Promise(resolve=>setTimeout(resolve,2300));}if(stateMode==='fail')return route.abort('failed');await route.fulfill({json:snapshot});return;}
    if(request.method()==='POST'&&(path==='/api/commands'||path==='/api/conversations'||/\/api\/tasks\/.+\/(inbox\/.+\/actions|review)$/.test(path))){
      const body=request.postDataJSON();posts.push({path,body});
      await route.fulfill({json:path==='/api/conversations'?{status:'created'}:path==='/api/commands'?{commandId:body.commandId,status:'queued'}:{status:'ok'}});return;
    }
    await route.continue();
  });
  await page.goto(`http://127.0.0.1:${web.port}`);
  await page.getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('对话标题',{exact:true}).fill('先在线创建');
  await page.getByLabel('告诉 Codex 要做什么',{exact:true}).fill('验证离线后不能发送。');
  await page.getByRole('button',{name:'创建并开始'}).click();
  await page.waitForTimeout(1000);
  if(posts.length!==1)console.log('BASELINE_DEBUG',await page.locator('body').innerText(),posts);
  assert.equal(posts.length,1,'online baseline should reach the fake command endpoint');
  const baselinePosts=posts.length;
  await page.getByLabel('对话标题',{exact:true}).fill('离线后保留的标题');
  await page.getByLabel('告诉 Codex 要做什么',{exact:true}).fill('离线后保留的消息草稿。');

  const inboxPage=await context.newPage();
  await inboxPage.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
  await inboxPage.goto(`http://127.0.0.1:${web.port}`);
  await inboxPage.getByRole('button',{name:/^更多页面/}).click();
  await inboxPage.getByRole('menuitem',{name:'需要我处理'}).click();
  await inboxPage.getByRole('heading',{name:'需要我处理'}).waitFor();
  const decisionCard=inboxPage.locator('.inbox-card').filter({has:inboxPage.getByRole('heading',{name:'断网后回答此问题'})});
  await decisionCard.getByRole('button',{name:'答复决策'}).click();
  await decisionCard.getByLabel('你的回答').fill('保留我的草稿');
  await context.setOffline(true);
  await page.waitForFunction(()=>navigator.onLine===false);
  await inboxPage.waitForFunction(()=>navigator.onLine===false);
  await inboxPage.locator('.banner.alert').filter({hasText:'连接已中断'}).waitFor();
  await page.locator('.banner.alert').filter({hasText:'连接已中断'}).waitFor();
  assert.equal(await decisionCard.getByRole('button',{name:'提交回答'}).isDisabled(),true,'inbox submit button should be disabled offline');
  assert.equal(await page.getByRole('button',{name:'创建并开始'}).isDisabled(),true,'conversation create should be disabled offline');
  await page.locator('.conversation-compose form').evaluate(form=>form.requestSubmit());
  await page.waitForTimeout(250);
  assert.equal(posts.length,baselinePosts,'offline form submissions must not reach write endpoints');
  assert.equal(await page.locator('#conversation-title').inputValue(),'离线后保留的标题','conversation title draft remains visible');
  assert.equal(await page.locator('#conversation-message').inputValue(),'离线后保留的消息草稿。','conversation message draft remains visible');
  assert.ok(stateReads>0);

  stateMode='fail';
  await context.setOffline(false);
  await page.waitForFunction(()=>navigator.onLine===true);
  await page.waitForFunction(()=>document.querySelector('.banner.alert')?.textContent?.includes('连接已中断'));
  await page.getByRole('button',{name:'创建并开始'}).waitFor();
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button',{name:'创建并开始'}).isDisabled(),true,'failed state refresh must keep writes blocked');
  assert.ok((await page.locator('body').innerText()).includes('暂时连接不上服务器。恢复连接后，请先核对任务状态。'),'network failures should explain the next step in plain Chinese');
  assert.ok(!/Failed to fetch|Load failed|NetworkError when attempting to fetch resource/.test(await page.locator('body').innerText()),'browser network diagnostics must not leak into the user-facing message');
  assert.equal(posts.length,baselinePosts,'coming back online must not replay prior writes');
  stateMode='ok';delayNextStateGet=true;
  const recoveryReads=readCount(page);
  await page.locator('.banner.alert button').first().click();
  while(readCount(page)===recoveryReads)await new Promise(resolve=>setTimeout(resolve,20));
  await page.waitForTimeout(2100);
  assert.equal(readCount(page),recoveryReads+1,'refresh requests must be single-flight when state GET lasts longer than the polling interval');
  assert.equal(await page.getByRole('button',{name:'创建并开始'}).isDisabled(),true,'connection stays blocked until delayed state read succeeds');
  await page.waitForFunction(()=>document.querySelector('.conversation-compose button[type=submit]')?.disabled===false);
  assert.equal(await decisionCard.getByRole('button',{name:'提交回答'}).isDisabled(),false,'writes should resume after successful fresh state read');
  assert.equal(posts.length,baselinePosts,'offline attempts must stay drafts and never be replayed');
  const reviewCard=inboxPage.locator('.inbox-card').filter({has:inboxPage.getByRole('heading',{name:'断网后验收的任务'})});
  await reviewCard.getByRole('button',{name:'人工验收'}).click();
  const reviewForm=inboxPage.getByRole('dialog',{name:'人工验收'}).locator('form');
  await inboxPage.getByLabel('验收说明').fill('离线草稿保留');
  await context.setOffline(true);
  await inboxPage.waitForFunction(()=>navigator.onLine===false);
  // The browser network flag may change before React renders the disabled button.
  // Exercise the handler at that boundary, then wait for the visible offline state.
  await reviewForm.evaluate(form=>form.requestSubmit());
  assert.equal(posts.length,baselinePosts,'review handler must not write while offline UI is still rendering');
  await inboxPage.waitForFunction(()=>document.querySelector('[role=dialog] button[type=submit]')?.disabled===true);
  assert.equal(await reviewForm.getByRole('button',{name:'提交结论'}).isDisabled(),true,'review submit button should be disabled offline');
  await reviewForm.evaluate(form=>form.requestSubmit());
  assert.equal(posts.length,baselinePosts,'offline review form requestSubmit must not write');
  await context.setOffline(false);
  await inboxPage.waitForFunction(()=>navigator.onLine===true);
  await inboxPage.waitForFunction(()=>!document.querySelector('.banner.alert'));
  await inboxPage.getByRole('button',{name:'取消',exact:true}).click();

  await page.getByLabel('已有对话').selectOption(decisionTask.id);
  await page.getByLabel('继续说明需求').fill('断线期间不得补发');
  holdNextStateGet=true;
  await page.getByRole('button',{name:'发送消息'}).click();
  await page.waitForFunction(()=>document.querySelector('.conversation-compose button[type=submit]')?.disabled===true);
  while(!releaseStateGet)await new Promise(resolve=>setTimeout(resolve,20));
  await context.setOffline(true);
  await page.waitForFunction(()=>navigator.onLine===false);
  await context.setOffline(false);
  await page.waitForFunction(()=>navigator.onLine===true);
  await page.waitForFunction(()=>!document.querySelector('.banner.alert'));
  releaseStateGet();
  await page.waitForTimeout(250);
  assert.equal(posts.length,baselinePosts,'send whose fresh-state GET crossed a disconnect must not POST after reconnect');
  assert.equal(await page.getByLabel('继续说明需求').inputValue(),'断线期间不得补发','cancelled send keeps its draft for explicit confirmation');

  const desktopPage=await context.newPage();const localSnapshot=await core.state();
  await desktopPage.addInitScript(data=>{
    Object.defineProperty(Navigator.prototype,'onLine',{configurable:true,get:()=>false});
    window.taskboard={request:async()=>{window.__desktopReads=(window.__desktopReads||0)+1;return structuredClone(data);},subscribe:callback=>{window.__desktopNotify=callback;return()=>{};}};
  },localSnapshot);
  await desktopPage.goto(`http://127.0.0.1:${web.port}`);
  await desktopPage.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'需要我处理'}).click();
  await desktopPage.getByRole('heading',{name:'需要我处理'}).waitFor();
  await desktopPage.waitForFunction(()=>typeof window.__desktopNotify==='function'&&window.__desktopReads>0);
  const desktopReads=await desktopPage.evaluate(()=>window.__desktopReads);
  await desktopPage.evaluate(()=>window.__desktopNotify());
  await desktopPage.waitForFunction(count=>window.__desktopReads>count,desktopReads);
  assert.equal(await desktopPage.evaluate(()=>navigator.onLine),false);
  assert.ok(await desktopPage.evaluate(()=>window.__desktopReads)>=desktopReads+1,'Tauri bridge refresh must work independently of browser network status');
  assert.deepEqual(errors,[]);
  console.log(`PASS [${engine}]: context offline blocks writes and preserves drafts; failed reconnect read stays blocked; delayed refresh is single-flight; stale send does not POST; Tauri bridge refresh works with navigator.onLine=false`);
  await context.close();
}finally{await browser?.close();await web?.close();await core?.close();await rm(dir,{recursive:true,force:true});}
