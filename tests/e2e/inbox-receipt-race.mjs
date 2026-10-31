import assert from 'node:assert/strict';
import {cp,mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,webkit} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {createHub} from '../../server/hub/http.mjs';
import {generatePhoneStaleHarness} from '../fixtures/phone-stale-harness.mjs';

const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const qa=resolve(process.env.QA_DIR||'design/qa/v0.4/native-shutdown-fix/inbox-receipt-race');
const root=await mkdtemp(join(tmpdir(),'seqivo-inbox-receipt-race-'));
let core,hub,browser;
const evidence={startedAt:new Date().toISOString(),engine,realAccount:false,realAI:false,physicalPhone:false};
async function call(base,method,path,body,headers={}){
  const response=await fetch(`${base}${path}`,{method,headers:{...headers,...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json().catch(()=>({}));return {response,value};
}

try{
  const tempDist=join(root,'dist');await cp(resolve(process.env.TEST_DIST||'dist'),tempDist,{recursive:true});
  const builtHtml=await readFile(join(tempDist,'index.html'),'utf8');
  const appScriptPath=builtHtml.match(/src="([^"]+\.js)"/)?.[1]?.replace(/^\.?\//,'/');
  const appStylePath=builtHtml.match(/href="([^"]+\.css)"/)?.[1]?.replace(/^\.?\//,'/');
  assert.ok(appScriptPath&&appStylePath,'built app bundle paths must be present');
  core=await createCore({dataDir:join(root,'core'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'Disposable receipt race project',goal:'Exercise a stale inbox response race.'});
  const task=core.store.createTask({projectId:project.id,title:'Disposable stale decision',summary:'One disposable decision.',criteria:['Keep the desktop answer.']});
  const item=core.inbox.requestDecision(task.id,{expectedRevision:task.revision,requestId:'inbox-receipt-race-once',title:'Disposable receipt race choice',summary:'Temporary QA only.',impact:'No real data.',shareWithRemote:true,options:[{id:'green',label:'Green',consequence:'Keep'},{id:'blue',label:'Blue',consequence:'Stale'}]});
  const generated=generatePhoneStaleHarness({projectId:project.id,taskId:task.id,itemId:item.id,appScriptPath,appStylePath});
  await mkdir(join(tempDist,'qa'),{recursive:true});
  await Promise.all([writeFile(join(tempDist,'qa/phone-stale-harness.html'),generated.html),writeFile(join(tempDist,'qa/phone-stale-harness.js'),generated.runtimeScript),writeFile(join(tempDist,'qa/phone-stale-harness.css'),generated.runtimeStyle)]);
  hub=await createHub({dataDir:join(root,'hub'),distDir:tempDist,host:'127.0.0.1',port:0});
  const {tokenPath}=hub.store.bootstrap('inbox-receipt-race-test');const owner=(await readFile(tokenPath,'utf8')).trim();
  const pairing=await call(hub.url,'POST','/api/admin/pairings',{role:'node',projectIds:[project.id]},{authorization:`Bearer ${owner}`});assert.equal(pairing.response.status,200);
  await core.remote.configure({url:hub.url,pairingCode:pairing.value.code,projectIds:[project.id]});await core.remote.sync();
  const claim=await call(hub.url,'POST','/api/auth/claim',{username:'qa_receipt_race_owner',password:'temporary-test-password-9283'},{authorization:`Bearer ${owner}`});assert.equal(claim.response.status,200);
  const cookie=claim.response.headers.get('set-cookie').split(';',1)[0];
  const initial=await call(hub.url,'GET','/api/state',undefined,{cookie});assert.equal(initial.response.status,200);
  const oldTask=initial.value.tasks.find(value=>value.id===task.id);const oldItem=initial.value.inbox.items.find(value=>value.id===item.id);

  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844}});
  await context.addCookies([{name:'hub_session',value:cookie.slice('hub_session='.length),domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();
  await page.goto(`${hub.url}/qa/phone-stale-harness.html`);
  await page.getByRole('heading',{name:'需要我处理'}).waitFor();
  await page.getByRole('button',{name:'冻结当前显示'}).click();await page.getByText(/已冻结指定事项/).waitFor();

  const desktop=core.inbox.act(item.id,{actionId:'race-desktop-green',expectedRevision:oldTask.revision,expectedItemRevision:oldItem.itemRevision,action:'answer',optionId:'green'},'owner');
  assert.equal(desktop.status,'completed');await core.remote.sync();
  const commandCountBefore=hub.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n;

  // Hold real response JSON bodies, then release both in one browser task.
  // This deterministically exercises the interval before React effect cleanup.
  await page.evaluate(()=>{
    const upstream=window.fetch.bind(window);const gates={};
    window.__receiptRace={gates,release(){gates.post.release();gates.get.release();}};
    window.fetch=async(input,init)=>{
      const response=await upstream(input,init);const url=new URL(typeof input==='string'?input:input.url,location.href);
      const method=init?.method||'GET';
      const key=url.pathname==='/api/commands'&&method==='POST'?'post':/^\/api\/commands\/[^/]+$/.test(url.pathname)&&method==='GET'?'get':null;
      if(!key||gates[key])return response;
      const data=await response.clone().json();let release;
      const body=new Promise(resolve=>{release=()=>resolve(data)});
      const gate=gates[key]={status:response.status,code:data.code||'',id:url.pathname.split('/').at(-1),waiting:false,release};
      response.json=()=>{gate.waiting=true;return body;};
      return response;
    };
  });
  await page.locator('button[aria-label="刷新"]').first().click();
  const card=page.locator('.inbox-card').filter({has:page.getByRole('heading',{name:'Disposable receipt race choice'})});
  await card.getByRole('button',{name:'答复决策'}).click();
  await card.getByLabel('选择 Disposable receipt race choice 的答案').selectOption('blue');
  await card.getByRole('button',{name:'提交回答'}).click();
  await page.waitForFunction(()=>window.__receiptRace.gates.post?.waiting&&window.__receiptRace.gates.get?.waiting,{},{timeout:6000});
  const observed=await page.evaluate(()=>Object.fromEntries(Object.entries(window.__receiptRace.gates).map(([k,v])=>[k,{status:v.status,code:v.code,id:v.id}])));
  const {status:postStatus,code:postCode}=observed.post;const getStatus=observed.get.status;
  assert.equal(postStatus,409);assert.ok(['REVISION_CONFLICT','INBOX_CONFLICT'].includes(postCode));assert.equal(getStatus,404);
  await page.evaluate(()=>window.__receiptRace.release());
  await page.waitForFunction(()=>sessionStorage.getItem(Object.keys(sessionStorage).find(key=>key.startsWith('seqivo-inbox-commands-v1:'))||'')==='[]');
  await page.waitForFunction(()=>/任务或事项已变化|无法查询原命令回执/.test(document.querySelector('.inbox-message')?.textContent||''),{},{timeout:2000});
  await page.waitForTimeout(100);
  evidence.observedMessage=await card.locator('.inbox-message').innerText();
  evidence.responses=observed;
  assert.equal(evidence.observedMessage,'任务或事项已变化；本次未提交。请刷新后核对最新状态。');
  assert.equal(await card.getByRole('button',{name:'答复决策'}).isEnabled(),true,'known 409 must unlock the stale card');
  assert.equal(await card.getByText('任务或事项已变化；本次未提交。请刷新后核对最新状态。',{exact:true}).count(),1,'late 404 must not overwrite the known rejection');
  assert.equal(hub.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n,commandCountBefore,'stale rejection must create no Hub command');
  assert.equal(core.store.getTask(task.id).decisions.length,1);assert.equal(core.store.getTask(task.id).decisions[0].optionId,'green');

  evidence.status='passed';evidence.commandIdObserved=true;evidence.post={status:postStatus,code:postCode};evidence.poll={status:getStatus,releasedInSameBrowserTask:true};evidence.commandCountUnchanged=true;evidence.desktopDecision='green';
  await mkdir(qa,{recursive:true});await writeFile(join(qa,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
  await context.close();
}catch(error){
  evidence.status='failed';evidence.error=String(error.message||error);await mkdir(qa,{recursive:true});await writeFile(join(qa,'failure.json'),JSON.stringify(evidence,null,2));throw error;
}finally{await browser?.close();await hub?.close();await core?.close();await rm(root,{recursive:true,force:true});}
