import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,webkit} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {createHub} from '../../server/hub/http.mjs';

const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const baseline=process.env.BASELINE==='1';
const qa=resolve(process.env.QA_DIR||'design/qa/v0.4/phone-remainder/decision-conflict');
const root=await mkdtemp(join(tmpdir(),'seqivo-decision-conflict-'));
await mkdir(qa,{recursive:true});
let core,hub,browser;
const observed={engine,baseline,cases:{}};
async function until(predicate,label){for(let n=0;n<80;n++){if(await predicate())return;await new Promise(r=>setTimeout(r,150));}throw Error(label)}
try{
  core=await createCore({dataDir:join(root,'core'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'旧决策冲突测试'});
  const task=core.store.createTask({projectId:project.id,title:'选择测试方案',summary:'仍在选择方案。',criteria:['决定唯一方案']});
  const item=core.inbox.requestDecision(task.id,{expectedRevision:task.revision,requestId:'one-choice',title:'决定采用哪个方案',summary:'请选一个方案。',impact:'后续工作取决于选择。',shareWithRemote:true,options:[{id:'green',label:'绿色',consequence:'采用绿色'},{id:'blue',label:'蓝色',consequence:'采用蓝色'}]});
  hub=await createHub({dataDir:join(root,'hub'),distDir:resolve(process.env.TEST_DIST_DIR||'dist'),host:'127.0.0.1',port:0});
  async function call(method,path,body,token){const response=await fetch(hub.url+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,value:await response.json()}}
  const owner=(await readFile(hub.store.bootstrap('decision-conflict').tokenPath,'utf8')).trim();
  const nodePair=await call('POST','/api/admin/pairings',{role:'node',projectIds:[project.id]},owner);
  assert.equal(nodePair.status,200);
  const configured=await core.remote.configure({url:hub.url,pairingCode:nodePair.value.code,projectIds:[project.id]});assert.equal(configured.status,'connected');
  const controllerPair=await call('POST','/api/admin/pairings',{role:'controller',projectIds:[project.id]},owner);
  const controller=await call('POST','/api/pairings/redeem',{code:controllerPair.value.code});assert.equal(controller.status,200);
  const token=controller.value.token;
  await core.remote.sync();
  const oldState=(await call('GET','/api/state',undefined,token)).value;
  assert.equal(oldState.inbox.items.find(x=>x.id===item.id)?.state,'open');
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();
  await page.addInitScript(value=>sessionStorage.setItem('taskboard-token',value),token);
  let frozen=true,postCount=0,lastPostStatus=null,lastPostCode=null,dropNext=false;
  await page.route('**/api/state',route=>frozen?route.fulfill({json:oldState}):route.continue());
  await page.route('**/api/commands',async route=>{
    if(route.request().method()!=='POST')return route.continue();
    postCount++;
    const response=await route.fetch();const data=await response.json();lastPostStatus=response.status();lastPostCode=data.code;
    if(dropNext){dropNext=false;return route.abort('failed')}
    return route.fulfill({status:response.status(),headers:{...response.headers(),'content-type':'application/json'},body:JSON.stringify(data)});
  });
  await page.goto(hub.url);await page.getByRole('button',{name:/^更多页面/}).click();await page.getByRole('menuitem',{name:'需要我处理'}).click();await page.getByRole('heading',{name:'需要我处理'}).waitFor();
  const card=page.locator('.inbox-card').filter({has:page.getByRole('heading',{name:'决定采用哪个方案'})});
  await card.getByRole('button',{name:'答复决策'}).click();
  await card.getByLabel('选择 决定采用哪个方案 的答案').selectOption('blue');
  const oldRevision=oldState.tasks.find(x=>x.id===task.id).revision;
  const actual=core.inbox.act(item.id,{actionId:'desktop-green',expectedRevision:oldRevision,expectedItemRevision:item.itemRevision,action:'answer',optionId:'green'},'owner');
  assert.equal(actual.status,'completed');
  await core.remote.sync();
  const latest=(await call('GET','/api/state',undefined,token)).value;
  assert.equal(latest.inbox.items.find(x=>x.id===item.id)?.state,'resolved');
  assert.ok(latest.tasks.find(x=>x.id===task.id).revision>oldRevision);
  const before=hub.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n;
  await card.getByRole('button',{name:'提交回答'}).click();
  await until(()=>lastPostStatus!==null,'old form did not submit');
  assert.equal(lastPostStatus,409);assert.ok(['REVISION_CONFLICT','INBOX_CONFLICT'].includes(lastPostCode));
  assert.equal(hub.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n,before,'Hub did not create a command');
  assert.equal(core.store.getTask(task.id).decisions.length,1);
  assert.equal(core.store.getTask(task.id).decisions[0].optionId,'green');
  const alertText=await card.locator('.inbox-message-error').innerText();
  if(baseline)assert.match(alertText,/提交回执未确认；已保留命令 ID/);
  else{assert.match(alertText,/任务或事项已变化.*本次未提交.*刷新后核对/);assert.doesNotMatch(alertText,/回执未确认|命令 ID 已保留/)}
  if(!baseline){const pendingAfterRejection=await page.evaluate(()=>Object.entries(sessionStorage).filter(([k])=>k.startsWith('seqivo-inbox-commands-v1:')).flatMap(([,v])=>JSON.parse(v)));assert.equal(pendingAfterRejection.length,0,'proven pre-insert conflict clears only its pending intent')}
  observed.cases.conflict={httpStatus:lastPostStatus,code:lastPostCode,commandsBefore:before,commandsAfter:hub.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n,decisionCount:core.store.getTask(task.id).decisions.length,alertText};
  await page.screenshot({path:join(qa,`${baseline?'baseline-':''}conflict-${engine}.png`),fullPage:true,animations:'disabled'});
  frozen=false;await page.getByRole('button',{name:/现在 /}).click();
  await page.getByRole('button',{name:'已处理'}).click();
  await card.waitFor();assert.equal(await card.getByRole('button',{name:'提交回答'}).count(),0);
  observed.cases.synced={oldFormRemoved:true};
  await context.close();
  // A separate fresh request loses only its response after Hub accepts it. The original ID must stay fenced.
  const task2=core.store.createTask({projectId:project.id,title:'网络回执测试',summary:'待决策'});
  const item2=core.inbox.requestDecision(task2.id,{expectedRevision:task2.revision,requestId:'lost-answer',title:'断网时选择',summary:'确认回执未知',impact:'避免重复提交',shareWithRemote:true,options:[{id:'one',label:'一号',consequence:'只选一次'}]});
  await core.remote.sync();
  const context2=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page2=await context2.newPage();await page2.addInitScript(value=>sessionStorage.setItem('taskboard-token',value),token);
  await page2.route('**/api/commands',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();assert.equal(response.status(),200);return route.abort('failed')});
  await page2.goto(hub.url);await page2.getByRole('button',{name:/^更多页面/}).click();await page2.getByRole('menuitem',{name:'需要我处理'}).click();await page2.getByRole('heading',{name:'需要我处理'}).waitFor();
  const second=page2.locator('.inbox-card').filter({has:page2.getByRole('heading',{name:'断网时选择'})});
  await second.getByRole('button',{name:'答复决策'}).click();await second.getByLabel('选择 断网时选择 的答案').selectOption('one');
  const count2=hub.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n;
  await second.getByRole('button',{name:'提交回答'}).click();
  await second.getByText('命令 ID',{exact:false}).waitFor();
  const records=await page2.evaluate(()=>Object.entries(sessionStorage).filter(([k])=>k.startsWith('seqivo-inbox-commands-v1:')).flatMap(([,v])=>JSON.parse(v)));
  assert.equal(records.length,1);assert.equal(records[0].itemId,item2.id);
  assert.equal(hub.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n,count2+1);
  assert.equal(await second.getByRole('button',{name:'答复决策'}).isDisabled(),true,'unknown response keeps answer fenced');
  assert.equal(await second.getByRole('button',{name:'提交回答'}).count(),0,'no second submit entry while result is unknown');
  await page2.screenshot({path:join(qa,`${baseline?'baseline-':''}lost-receipt-${engine}.png`),fullPage:true,animations:'disabled'});
  observed.cases.lostReceipt={pendingCommandCount:records.length,hubCommandDelta:1};
  await context2.close();
  await writeFile(join(qa,`${baseline?'baseline-':''}result-${engine}.json`),JSON.stringify(observed,null,2));
  console.log(`PASS [${engine}] conflict 409 no Hub command, lost receipt fenced, old form removed`);
}finally{await browser?.close();await hub?.close();await core?.close();await rm(root,{recursive:true,force:true})}
