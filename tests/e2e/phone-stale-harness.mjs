import assert from 'node:assert/strict';
import {cp,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,webkit} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {createHub} from '../../server/hub/http.mjs';
import {generatePhoneStaleHarness} from '../fixtures/phone-stale-harness.mjs';

const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const qa=resolve(process.env.QA_DIR||'design/qa/v0.4/native-shutdown-fix/harness');
const root=await mkdtemp(join(tmpdir(),'seqivo-phone-stale-harness-'));
let core,hub,browser;
const evidence={startedAt:new Date().toISOString(),engine,realAccount:false,realAI:false,physicalPhone:false,sourceBuildChanged:false};
async function call(base,method,path,body,headers={}){
  const response=await fetch(`${base}${path}`,{method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json().catch(()=>({}));return {response,value};
}

try{
  const tempDist=join(root,'dist');await cp(resolve('dist'),tempDist,{recursive:true});
  const builtHtml=await readFile(join(tempDist,'index.html'),'utf8');
  const appScriptPath=builtHtml.match(/src="([^"]+\.js)"/)?.[1]?.replace(/^\.?\//,'/');
  const appStylePath=builtHtml.match(/href="([^"]+\.css)"/)?.[1]?.replace(/^\.?\//,'/');
  assert.ok(appScriptPath&&appStylePath,'built app module and stylesheet paths must be present');
  core=await createCore({dataDir:join(root,'core'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'Disposable phone QA project',goal:'Verify stale decision conflict with a temporary browser fixture.'});
  const task=core.store.createTask({projectId:project.id,title:'Disposable phone QA decision',summary:'Awaiting one disposable decision.',criteria:['Verify the Hub rejects the stale form.']});
  const item=core.inbox.requestDecision(task.id,{expectedRevision:task.revision,requestId:'phone-stale-harness-once',title:'Disposable stale-choice check',summary:'Only an isolated QA choice.',impact:'No real project data.',shareWithRemote:true,options:[{id:'green',label:'Green test option',consequence:'Only temporary'},{id:'blue',label:'Blue test option',consequence:'Only temporary'}]});
  const generated=generatePhoneStaleHarness({projectId:project.id,taskId:task.id,itemId:item.id,appScriptPath,appStylePath});
  await mkdir(join(tempDist,'qa'),{recursive:true});
  await Promise.all([writeFile(join(tempDist,'qa/phone-stale-harness.html'),generated.html),writeFile(join(tempDist,'qa/phone-stale-harness.js'),generated.runtimeScript),writeFile(join(tempDist,'qa/phone-stale-harness.css'),generated.runtimeStyle)]);
  hub=await createHub({dataDir:join(root,'hub'),distDir:tempDist,host:'127.0.0.1',port:0});
  const {tokenPath}=hub.store.bootstrap('phone-stale-harness-test');const owner=(await readFile(tokenPath,'utf8')).trim();
  const pairing=await call(hub.url,'POST','/api/admin/pairings',{role:'node',projectIds:[project.id]}, {authorization:`Bearer ${owner}`});assert.equal(pairing.response.status,200);
  await core.remote.configure({url:hub.url,pairingCode:pairing.value.code,projectIds:[project.id]});
  await core.remote.sync();
  const claim=await call(hub.url,'POST','/api/auth/claim',{username:'qa_phone_owner',password:'temporary-test-password-9283'},{authorization:`Bearer ${owner}`});assert.equal(claim.response.status,200);
  const setCookie=claim.response.headers.get('set-cookie');assert.ok(setCookie?.startsWith('hub_session='));const cookie=setCookie.split(';',1)[0];
  const me=await call(hub.url,'GET','/api/auth/me',undefined,{cookie});assert.equal(me.response.status,200);assert.equal(typeof me.value.user?.tenantId,'string');
  const initial=await call(hub.url,'GET','/api/state',undefined,{cookie});assert.equal(initial.response.status,200);
  assert.equal(typeof initial.value.capabilities.inbox,'boolean');assert.equal(initial.value.capabilities.inbox,true);assert.ok(['owner','controller'].includes(initial.value.capabilities.role));
  const oldTask=initial.value.tasks.find(value=>value.id===task.id);const oldItem=initial.value.inbox.items.find(value=>value.id===item.id);
  assert.equal(oldItem?.state,'open');assert.equal(oldItem?.shareWithRemote,true);
  evidence.shapeSmoke={authMeStatus:me.response.status,tenantIdPresent:Boolean(me.value.user.tenantId),inboxCapability:initial.value.capabilities.inbox,role:initial.value.capabilities.role,oldTaskRevision:oldTask.revision,oldItemRevision:oldItem.itemRevision};

  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'allow'});
  await context.addCookies([{name:'hub_session',value:cookie.slice('hub_session='.length),domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();let postStatus=null,postCode=null;
  page.on('response',async response=>{if(new URL(response.url()).pathname==='/api/commands'&&response.request().method()==='POST'){postStatus=response.status();const value=await response.json().catch(()=>({}));postCode=value.code||null;}});
  await page.goto(`${hub.url}/qa/phone-stale-harness.html`);
  await page.getByRole('heading',{name:'需要我处理'}).waitFor();
  await page.getByRole('button',{name:'冻结当前显示'}).click();
  await page.getByText(/已冻结指定事项/).waitFor();
  assert.equal(await page.evaluate(()=>navigator.serviceWorker?.controller?.scriptURL||''),'','QA wrapper did not register or control with a new service worker');

  const desktop=core.inbox.act(item.id,{actionId:'desktop-green-once',expectedRevision:oldTask.revision,expectedItemRevision:oldItem.itemRevision,action:'answer',optionId:'green'},'owner');
  assert.equal(desktop.status,'completed');await core.remote.sync();
  const fresh=await call(hub.url,'GET','/api/state',undefined,{cookie});assert.equal(fresh.response.status,200);
  assert.equal(fresh.value.inbox.items.find(value=>value.id===item.id).state,'resolved');
  assert.ok(fresh.value.tasks.find(value=>value.id===task.id).revision>oldTask.revision);
  const countBefore=hub.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n;
  await page.locator('button[aria-label="刷新"]').first().click();
  const card=page.locator('.inbox-card').filter({has:page.getByRole('heading',{name:'Disposable stale-choice check'})});
  await card.getByRole('button',{name:'答复决策'}).click();
  await card.getByLabel('选择 Disposable stale-choice check 的答案').selectOption('blue');
  await card.getByRole('button',{name:'提交回答'}).click();
  await page.waitForFunction(()=>document.querySelector('#phone-post-status')?.textContent.includes('HTTP 409'));
  assert.equal(postStatus,409);assert.ok(['REVISION_CONFLICT','INBOX_CONFLICT'].includes(postCode));
  assert.equal(hub.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n,countBefore,'the rejected stale POST must not create a Hub command');
  assert.equal(core.store.getTask(task.id).decisions.length,1);assert.equal(core.store.getTask(task.id).decisions[0].optionId,'green');
  assert.match(await page.locator('#phone-post-status').innerText(),/HTTP 409 · (REVISION_CONFLICT|INBOX_CONFLICT)/);
  evidence.realPost={status:postStatus,code:postCode,commandsBefore:countBefore,commandsAfter:hub.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n,coreDecisionCount:1,coreDecisionOption:'green'};
  await page.getByRole('button',{name:'解除冻结'}).click();
  await page.locator('button[aria-label="刷新"]').first().click();
  await card.getByRole('button',{name:'答复决策'}).waitFor({state:'detached'});
  evidence.status='passed';
  await mkdir(qa,{recursive:true});await writeFile(join(qa,`result-${engine}.json`),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
  await context.close();
}catch(error){
  evidence.status='failed';evidence.error=String(error.message||error);
  await mkdir(qa,{recursive:true});await writeFile(join(qa,`failure-${engine}.json`),JSON.stringify(evidence,null,2));
  throw error;
}finally{await browser?.close();await hub?.close();await core?.close();await rm(root,{recursive:true,force:true});}
