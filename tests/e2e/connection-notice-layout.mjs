import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

// Run against an isolated Vite output via TEST_DIST_DIR. The same assertion
// fails against the pre-fix output when focus inserts an in-flow banner.
const dir=await mkdtemp(join(tmpdir(),'seqivo-connection-layout-'));
const qa=resolve(process.env.QA_DIR||'.runtime/android/app205/qa');
let core,web,browser,releaseRead;
try{
  await mkdir(qa,{recursive:true});
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'焦点布局验证',goal:'检查首次触摸时目标不移动'});
  const created=core.store.createTask({projectId:project.id,title:'待人工验收',goal:'只验证界面门禁',summary:'已提交',criteria:['核对']});
  core.store.updateTask(created.id,{status:'submitted'},created.revision);
  const base=await core.state();
  let snapshot={...base,projects:base.projects.map(item=>({...item,inboxAvailable:true})),connection:{...base.connection,mode:'hub',offline:false},capabilities:{...base.capabilities,remote:true,inbox:true,role:'controller'}};
  web=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve(process.env.TEST_DIST_DIR||'.runtime/android/app205/web'),port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
  let holdNext=false,posts=0;
  await context.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(request.method()==='GET'&&path==='/api/state'){
      if(holdNext){holdNext=false;await new Promise(resolve=>{releaseRead=resolve});}
      return route.fulfill({json:snapshot});
    }
    if(request.method()==='POST'&&path!=='/api/auth/logout')posts++;
    return route.continue();
  });
  await page.goto(`http://127.0.0.1:${web.port}`);
  const card=page.locator('.inbox-card').filter({has:page.getByRole('heading',{name:'待人工验收'})});
  const view=card.getByRole('button',{name:'查看任务'});
  await view.waitFor();
  await view.scrollIntoViewIfNeeded();
  const before=await view.boundingBox();
  assert.ok(before,'navigation action has a visible box');
  const beforeHeader=await page.locator('.main-header').boundingBox();
  holdNext=true;
  await page.mouse.move(before.x+before.width/2,before.y+before.height/2);
  await page.mouse.down();
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.locator('.banner.alert').filter({hasText:'正在确认手机与目标电脑的连接'}).waitFor();
  const after=await view.boundingBox();
  assert.ok(after,'navigation action still exists during the connection check');
  const movement=after.y-before.y;
  if(Math.abs(movement)>=2)console.error('LAYOUT_DIAGNOSTIC',JSON.stringify({beforeHeader,afterHeader:await page.locator('.main-header').boundingBox(),components:await page.evaluate(()=>Object.fromEntries(['.mobile-top','.main-header','.header-status-slot','.inbox-filter','.inbox-card'].map(selector=>{const element=document.querySelector(selector),box=element?.getBoundingClientRect();return [selector,box?{top:box.top,height:box.height,width:box.width}:null]})))}));
  assert.ok(Math.abs(movement)<2,`focus check moved the touched button by ${movement.toFixed(1)}px`);
  assert.equal(await card.getByRole('button',{name:'人工验收'}).isDisabled(),true,'pending connection check keeps writes blocked');
  await page.mouse.up();
  await page.locator('.work-area.show-detail').waitFor();
  assert.equal(await page.getByRole('button',{name:'人工验收'}).isDisabled(),true,'pending connection check keeps writes blocked');
  assert.equal(posts,0,'one ordinary tap did not submit another action');

  // A narrow viewport and enlarged text keep the status readable in a
  // keyboard-accessible scroll region without moving the task area.
  await page.setViewportSize({width:320,height:600});
  await page.addStyleTag({content:'html{font-size:24px}'});
  await page.waitForTimeout(100);
  const slot=page.getByRole('region',{name:'连接与操作提示'});
  const slotBefore=await slot.boundingBox();
  assert.ok(slotBefore&&slotBefore.height>=90,'status slot scales with large text');
  const alert=page.locator('.banner.alert').first();
  assert.equal(await alert.isVisible(),true);
  assert.equal(await alert.evaluate(element=>{
    const node=Array.from(element.childNodes).find(child=>child.nodeType===Node.TEXT_NODE&&child.textContent?.includes('正在确认'));
    if(!node)return false;
    const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(6,node.textContent?.length||0));
    const text=range.getBoundingClientRect(),slot=element.closest('.header-status-slot')?.getBoundingClientRect();
    return Boolean(slot&&text.width>40&&text.top>=slot.top&&text.top<slot.bottom&&text.right<=slot.right);
  }),true,'the beginning of the warning is visibly readable at large text size');
  await page.screenshot({path:join(qa,'connection-mobile-large-text.png'),animations:'disabled'});
  const retry=alert.getByRole('button',{name:'重试'});
  await retry.focus();
  assert.equal(await retry.evaluate(element=>document.activeElement===element),true,'retry remains keyboard reachable');
  assert.equal(await slot.evaluate(element=>getComputedStyle(element).overflowY),'auto');
  const narrowActions=await page.locator('.header-actions').boundingBox();
  assert.ok(narrowActions&&slotBefore.y>=narrowActions.y+narrowActions.height,'large-text mobile status sits below header actions');
  await page.screenshot({path:join(qa,'connection-mobile-retry-focus.png'),animations:'disabled'});
  await page.setViewportSize({width:1280,height:800});
  const desktopSlot=await slot.boundingBox(),desktopActions=await page.locator('.header-actions').boundingBox();
  assert.ok(desktopSlot&&desktopActions&&desktopSlot.y>=desktopActions.y+desktopActions.height,'desktop status sits below header actions');
  await page.screenshot({path:join(qa,'connection-desktop.png'),animations:'disabled'});
  assert.equal(posts,0);
  releaseRead?.();releaseRead=null;

  // A stable permission warning remains in the Inbox while the connection
  // check appears in the header. It must not disappear on the first focus.
  snapshot={...snapshot,capabilities:{...snapshot.capabilities,role:'viewer'}};
  await page.locator('.main-header').getByRole('button',{name:'刷新'}).click();
  await page.locator('.sidebar nav').getByRole('button',{name:'需要我处理'}).click();
  await page.setViewportSize({width:390,height:844});
  await page.addStyleTag({content:'html{font-size:16px}'});
  const viewerCard=page.locator('.inbox-card').filter({has:page.getByRole('heading',{name:'待人工验收'})});
  const viewerView=viewerCard.getByRole('button',{name:'查看任务'});
  await viewerView.waitFor();
  await page.getByText('当前连接只有查看权限，处理按钮已停用。').waitFor();
  const viewerBefore=await viewerView.boundingBox();
  assert.ok(viewerBefore);
  holdNext=true;
  await page.mouse.move(viewerBefore.x+viewerBefore.width/2,viewerBefore.y+viewerBefore.height/2);
  await page.mouse.down();
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await page.locator('.banner.alert').filter({hasText:'正在确认手机与目标电脑的连接'}).waitFor();
  const viewerAfter=await viewerView.boundingBox();
  assert.ok(viewerAfter&&Math.abs(viewerAfter.y-viewerBefore.y)<2,'viewer warning stays in place during focus check');
  assert.equal(await viewerCard.getByRole('button',{name:'人工验收'}).isDisabled(),true);
  assert.equal(await page.getByText('当前连接只有查看权限，处理按钮已停用。').isVisible(),true);
  await page.mouse.up();
  releaseRead?.();releaseRead=null;
  assert.equal(posts,0);
  console.log(JSON.stringify({result:'PASS',movement,slotHeight:slotBefore.height,posts}));
  await context.close();
}finally{
  releaseRead?.();
  await browser?.close();
  await web?.close();
  await core?.close();
  await rm(dir,{recursive:true,force:true});
}
