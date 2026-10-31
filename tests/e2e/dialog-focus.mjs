import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,webkit} from '@playwright/test';
import {createServer} from 'vite';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const dataDir=await mkdtemp(join(tmpdir(),'seqivo-dialog-focus-'));
const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
let core,http,dev,browser;
try{
  core=await createCore({dataDir:join(dataDir,'core'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'Dialog focus test project',goal:'Verify modal keyboard focus without making any edits.'});
  const createdTask=core.store.createTask({projectId:project.id,title:'Dialog focus test task',goal:'Keep the form draft until the user submits it.',criteria:['No write during the focus test.']});
  const originalRevision=createdTask.revision;
  http=await startHttp({core,dataDir:join(dataDir,'http'),distDir:resolve('dist'),port:0});
  let url;
  if(process.env.TEST_DIST==='1')url=`http://127.0.0.1:${http.port}`;
  else{
    dev=await createServer({configFile:resolve('vite.config.mjs'),server:{host:'127.0.0.1',port:0,proxy:{'/api':{target:`http://127.0.0.1:${http.port}`,changeOrigin:true,configure:proxy=>proxy.on('proxyReq',request=>request.removeHeader('origin'))}}}});
    await dev.listen();
    const address=dev.httpServer.address();
    url=`http://127.0.0.1:${address.port}`;
  }
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),http.tokens.owner);
  await page.goto(url);
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('button',{name:'Dialog focus test task'}).click();
  const opener=page.getByRole('button',{name:'编辑任务'});
  await opener.click();
  const dialog=page.getByRole('dialog');
  await dialog.waitFor();
  const close=dialog.getByRole('button',{name:'关闭'});
  const initiallyFocused=await page.evaluate(()=>({tag:document.activeElement?.tagName,aria:document.activeElement?.getAttribute('aria-label'),inside:document.querySelector('[role=dialog]')?.contains(document.activeElement)}));
  console.log(JSON.stringify({engine,initiallyFocused}));
  assert.equal(await close.evaluate(element=>element===document.activeElement),true,'opening the dialog should focus its close button without opening the mobile keyboard');
  assert.equal(await page.locator('.sidebar').evaluate(element=>element.inert),true,'background sidebar should be inert while the modal is open');
  assert.equal(await page.locator('.main').evaluate(element=>element.inert),true,'background main content should be inert while the modal is open');
  assert.equal(await dialog.evaluate(element=>element.inert),false,'the modal itself must remain interactive');

  const draft=dialog.getByLabel('任务名称',{exact:true});
  await draft.fill('Unsaved focus-test draft');
  const refreshResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state'&&response.request().method()==='GET');
  await page.locator('button[aria-label="刷新"]').first().evaluate(element=>element.click());
  await refreshResponse;
  assert.equal(await draft.inputValue(),'Unsaved focus-test draft','background refresh must not reset the dialog draft');

  await close.focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.evaluate(element=>element.contains(document.activeElement)),true,'Shift+Tab must stay inside the dialog');
  await page.keyboard.press('Tab');
  assert.equal(await dialog.evaluate(element=>element.contains(document.activeElement)),true,'Tab must stay inside the dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({state:'detached'});
  assert.equal(await opener.evaluate(element=>element===document.activeElement),true,'Escape must restore focus to the opener');
  assert.equal(await page.locator('.sidebar').evaluate(element=>element.inert),false,'closing the dialog must restore sidebar interactivity');
  assert.equal(await page.locator('.main').evaluate(element=>element.inert),false,'closing the dialog must restore main-content interactivity');
  assert.equal(core.store.tasks().find(item=>item.id===createdTask.id)?.revision,originalRevision,'the focus flow must not mutate task data');
  await opener.click();
  await dialog.waitFor();
  await page.locator('.sidebar-bottom button.quiet').evaluate(element=>element.click());
  await page.locator('.login-screen').waitFor();
  assert.equal(await page.getByRole('dialog').count(),0,'authentication loss must clean up the open dialog');
  await page.getByLabel('访问令牌').fill(http.tokens.owner);
  await page.getByRole('button',{name:'进入看板'}).click();
  await page.getByRole('button',{name:/^更多页面/}).click();
  await page.getByRole('menuitem',{name:'需要我处理'}).waitFor();
  assert.equal(await page.getByRole('dialog').count(),0,'re-authentication must not reopen a previous account dialog or draft');
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('button',{name:'Dialog focus test task'}).click();
  await page.getByRole('button',{name:'编辑任务'}).click();
  assert.equal(await page.getByLabel('任务名称',{exact:true}).inputValue(),'Dialog focus test task','re-authentication must not restore the previous account draft');
  console.log(`PASS [${engine}]: initial focus, tab containment, Escape/restore and draft retention; no submit performed`);
}finally{
  if(browser)await browser.close();
  if(dev)await dev.close();
  if(http)await http.close();
  if(core)await core.close();
  await rm(dataDir,{recursive:true,force:true});
}
