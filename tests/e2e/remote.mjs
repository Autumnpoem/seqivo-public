import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,webkit} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';
import {createHub} from '../../server/hub/http.mjs';

const root=await mkdtemp(join(tmpdir(),'tuijin-remote-ui-'));
const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const qa=resolve(process.env.QA_DIR||(engine==='webkit'?'design/qa/v0.2/webkit':'design/qa/v0.2/remote-ui'));
await mkdir(qa,{recursive:true});
let clock=Date.now();
let core,local,hub,browser;
const checks=[];
async function call(base,method,path,body,token,expected=200){
  const response=await fetch(`${base}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();
  assert.equal(response.status,expected,`${method} ${path}: ${response.status} ${data.code||''}`);
  return data;
}
async function loginWithCode(browserInstance,hubUrl,code){
  const context=await browserInstance.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  await page.goto(hubUrl);
  await page.getByText('其他连接方式',{exact:true}).click();
  await page.getByRole('button',{name:'手机配对码'}).click();
  await page.getByLabel('一次性配对码').fill(code);
  const redeemed=page.waitForResponse(response=>response.url().endsWith('/api/pairings/redeem'));
  await page.getByRole('button',{name:'进入看板'}).click();
  const response=await redeemed;
  assert.equal(response.status(),200);
  const subject=await response.json();
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('heading',{name:'手机验收项目'}).waitFor();
  return {context,page,subject};
}
async function syncAndSee(taskId,predicate){
  await core.remote.sync();
  assert.ok(predicate(core.store.getTask(taskId)),'Core SQLite did not apply command');
  await core.remote.sync();
}
try{
  core=await createCore({dataDir:join(root,'node-data'),pluginDir:resolve('plugins'),files:false});
  const selected=core.store.project({name:'手机验收项目',goal:'验证真实远程更新与人工验收。',directory:root});
  const excluded=core.store.project({name:'不授权项目',goal:'不得同步到手机。'});
  const task=core.store.createTask({projectId:selected.id,title:'手机端验收任务',goal:'从手机更新任务并验收。',summary:'等待手机更新',criteria:['真实回执和证据可核对'],conversationId:'test-bound-thread'});
  core.store.createTask({projectId:excluded.id,title:'不可见任务',goal:'只存在于本地项目。',criteria:['不在 Hub 中出现']});
  local=await startHttp({core,dataDir:join(root,'node-data'),distDir:resolve('dist'),port:0});
  const localUrl=`http://127.0.0.1:${local.port}`;
  hub=await createHub({dataDir:join(root,'hub-data'),distDir:resolve('dist'),host:'127.0.0.1',port:0,now:()=>clock});
  const {tokenPath}=hub.store.bootstrap('remote-ui-tenant');
  const owner=(await readFile(tokenPath,'utf8')).trim();
  const nodeCode=await call(hub.url,'POST','/api/admin/pairings',{role:'node',projectIds:[selected.id],ttlSeconds:600},owner);
  const connected=await call(localUrl,'POST','/api/remote/connect',{url:hub.url,pairingCode:nodeCode.code,projectIds:[selected.id]},local.tokens.owner);
  assert.equal(connected.status,'connected');
  const state=await call(hub.url,'GET','/api/state',undefined,owner);
  assert.deepEqual(state.projects.map(project=>project.id),[selected.id]);
  assert.deepEqual(state.tasks.map(item=>item.id),[task.id]);
  assert.equal(state.tasks[0].hasExecutionBinding,true);
  assert.equal(state.tasks[0].conversationId,undefined);
  checks.push('real Core HTTP node pairing and selected-project snapshot');

  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const browserErrors=[];
  const viewerCode=await call(hub.url,'POST','/api/admin/pairings',{role:'viewer',projectIds:[selected.id],ttlSeconds:600},owner);
  const viewer=await loginWithCode(browser,hub.url,viewerCode.code);
  viewer.page.on('pageerror',error=>browserErrors.push(error.message));
  assert.equal(await viewer.page.getByText('不授权项目').count(),0);
  await viewer.page.getByRole('button',{name:/手机端验收任务/}).click();
  assert.equal(await viewer.page.getByRole('button',{name:'编辑任务'}).isDisabled(),true);
  assert.equal(await viewer.page.getByRole('button',{name:'添加证据'}).isDisabled(),true);
  assert.equal(await viewer.page.getByRole('button',{name:'继续任务'}).isDisabled(),true);
  await call(hub.url,'POST','/api/commands',{commandId:'viewer-denied',projectId:selected.id,taskId:task.id,action:'update',expectedRevision:task.revision,expiresAt:new Date(clock+60_000).toISOString(),body:{summary:'must not apply'}},viewer.subject.token,403);
  await viewer.page.getByRole('combobox',{name:'外观模式'}).selectOption('light');
  assert.equal(await viewer.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'viewer mobile overflow');
  await viewer.page.screenshot({path:join(qa,'viewer-light.png'),fullPage:true,animations:'disabled'});
  checks.push('viewer one-use pairing, project isolation, disabled controls and server-side denial');

  const controllerCode=await call(hub.url,'POST','/api/admin/pairings',{role:'controller',projectIds:[selected.id],ttlSeconds:600},owner);
  const controller=await loginWithCode(browser,hub.url,controllerCode.code);
  controller.page.on('pageerror',error=>browserErrors.push(error.message));
  const page=controller.page;
  assert.equal(await page.getByText('不授权项目').count(),0);
  await page.getByRole('button',{name:/手机端验收任务/}).click();
  assert.equal(await page.getByRole('button',{name:'继续任务'}).isEnabled(),true);
  await page.getByRole('button',{name:'编辑任务'}).click();
  await page.getByRole('dialog',{name:'编辑任务'}).waitFor({timeout:5000});
  await page.getByLabel('当前进展',{exact:true}).fill('手机已核对真实接口');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByText('请求已排队').waitFor();
  await syncAndSee(task.id,item=>item.summary==='手机已核对真实接口');
  await page.getByText('目标电脑已确认更改。').waitFor({timeout:10000});
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  assert.equal(core.store.getTask(task.id).goal,'从手机更新任务并验收。');
  checks.push('controller update queued, claimed, receipted and applied to Core SQLite');

  await page.getByRole('button',{name:'添加证据'}).click();
  await page.getByLabel('证据说明',{exact:true}).fill('手机实测回执');
  await page.getByLabel('证据引用',{exact:true}).fill('reports/remote-e2e.json');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByText('请求已排队').waitFor();
  await syncAndSee(task.id,item=>item.evidence.some(value=>value.summary==='手机实测回执'));
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  checks.push('controller evidence command applied to Core SQLite');

  await page.getByRole('button',{name:'提交结果'}).click();
  await page.getByText('请求已排队').waitFor();
  await syncAndSee(task.id,item=>item.status==='submitted');
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByRole('button',{name:'人工验收'}).click();
  await page.getByLabel('验收说明',{exact:true}).fill('手机端已核对真实证据与回执。');
  await page.getByRole('button',{name:'提交结论'}).click();
  await page.getByText('请求已排队').waitFor();
  await syncAndSee(task.id,item=>item.acceptance==='passed');
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  assert.equal(core.store.getTask(task.id).review.actor.subjectId,controller.subject.subjectId);
  await page.waitForFunction(()=>document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')==='1');
  await page.getByRole('combobox',{name:'外观模式'}).selectOption('dark');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'controller mobile overflow');
  await page.screenshot({path:join(qa,'controller-dark.png'),fullPage:true,animations:'disabled'});
  checks.push('controller submit/review receipt, human actor and accepted Core SQLite state');

  await core.remote.close();
  clock+=61_000;
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByText('目标电脑离线，当前内容来自上次同步。').waitFor();
  await page.screenshot({path:join(qa,'offline-mobile.png'),fullPage:true,animations:'disabled'});
  await page.getByRole('checkbox',{name:/允许本次操作排队/}).check();
  await page.getByRole('button',{name:'编辑任务'}).click();
  await page.getByLabel('当前进展',{exact:true}).fill('离线队列不得提前生效');
  const queuedResponse=page.waitForResponse(response=>response.url().endsWith('/api/commands')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  const queued=await (await queuedResponse).json();
  assert.equal(queued.status,'queued');
  assert.notEqual(core.store.getTask(task.id).summary,'离线队列不得提前生效');
  clock+=300_100;
  const expired=await call(hub.url,'GET',`/api/commands/${encodeURIComponent(queued.commandId)}`,undefined,controller.subject.token);
  assert.equal(expired.status,'expired');
  checks.push('offline snapshot warning, explicit queue, no optimistic Core write, expiry');

  await call(hub.url,'POST',`/api/admin/subjects/${encodeURIComponent(controller.subject.subjectId)}/revoke`,{},owner);
  await call(hub.url,'GET','/api/state',undefined,controller.subject.token,401);
  await page.getByRole('button',{name:'刷新',exact:true}).click();
  await page.getByRole('group',{name:'账号操作'}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'手机验收项目',exact:true}).count(),0);
  checks.push('controller revocation denies old token and clears protected UI to login');
  assert.deepEqual(browserErrors,[]);
  await writeFile(join(qa,'summary.json'),JSON.stringify({result:'passed',checks,actualAI:false,physicalDevice:false,engine,headless:true},null,2));
  console.log(`PASS [${engine}]: real Hub+Core phone UI, queue receipts, offline expiry and revocation; no AI turn`);
}finally{
  await browser?.close();
  await local?.close();
  await core?.close();
  await hub?.close();
  await rm(root,{recursive:true,force:true});
}
