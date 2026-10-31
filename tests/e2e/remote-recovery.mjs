import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {chromium,webkit} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {createHub} from '../../server/hub/http.mjs';

const root=await mkdtemp(join(tmpdir(),'seqivo-command-recovery-'));
const qa=resolve(process.env.QA_DIR||'design/qa/v0.4/remote-recovery');
const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
await mkdir(qa,{recursive:true});
const checks=[];let core,hub,browser,page;
const testDistDir=resolve(process.env.TEST_DIST_DIR||'dist');
async function openMobilePage(page,name){await page.getByRole('button',{name:/^更多页面/}).click();await page.getByRole('menuitem',{name,exact:true}).click();}
const call=async(base,method,path,body,token,expected=200)=>{
  const response=await fetch(`${base}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{}) ,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const data=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${response.status} ${data.code||''}`);return data;
};
const until=async(predicate,label)=>{for(let i=0;i<100;i++){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,100));}throw Error(label);};

try{
  const evidence={startedAt:new Date().toISOString(),scenarios:['unknown remains locked after inconclusive check','confirmed recovery notice survives a later unchanged unknown poll while that task remains locked','not_applied and applied resolve only matching intent','reconcile never replays original command','320px and 390px layout has no horizontal overflow','Inbox, task detail and Conversation reconcile the original ID','late recovery response is discarded after account scope changes','receipt polling restarts after offline-to-online epoch change'],realAI:false,realAccount:false,physicalPhone:false,originalCommandPosts:[],reconcilePosts:[],recoveryReports:[],status:'running'};
  evidence.scriptSha256=createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex');
  core=await createCore({dataDir:join(root,'node'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'远程核实验收项目',goal:'核对原操作回执'});
  const task=core.store.createTask({projectId:project.id,title:'核实原命令',goal:'手机只读取原命令回执',summary:'等待核实',criteria:['核实不重放原操作'],conversationId:'fake-session'});
  const notAppliedTask=core.store.createTask({projectId:project.id,title:'未执行核实任务',goal:'核对未执行原命令',criteria:['逐条核实'],conversationId:'fake-session-2'});
  const appliedTask=core.store.createTask({projectId:project.id,title:'已执行核实任务',goal:'核对已执行原命令',criteria:['逐条核实'],conversationId:'fake-session-3'});
  const reconnectTask=core.store.createTask({projectId:project.id,title:'断网恢复核实任务',goal:'恢复连接后读原回执',criteria:['只清当前意图']});
  hub=await createHub({dataDir:join(root,'hub'),distDir:testDistDir,host:'127.0.0.1',port:0});
  const {tokenPath}=hub.store.bootstrap('remote-recovery-test');const owner=(await readFile(tokenPath,'utf8')).trim();
  const nodePair=await call(hub.url,'POST','/api/admin/pairings',{role:'node',projectIds:[project.id],ttlSeconds:600},owner);
  const node=await call(hub.url,'POST','/api/pairings/redeem',{code:nodePair.code,projectIds:[project.id]});
  const snapshot=await core.state();
  await call(hub.url,'POST','/api/node/snapshot',{sequence:1,epoch:node.epoch,projects:snapshot.projects,tasks:snapshot.tasks,settings:snapshot.settings,inbox:snapshot.inbox,capabilities:{...snapshot.capabilities,conversations:true},conversations:[]},node.token);
  const controllerPair=await call(hub.url,'POST','/api/admin/pairings',{role:'controller',projectIds:[project.id],ttlSeconds:600},owner);
  const controller=await call(hub.url,'POST','/api/pairings/redeem',{code:controllerPair.code});

  async function createUnknown(id,commandTask){
    await call(hub.url,'POST','/api/commands',{commandId:id,projectId:project.id,taskId:commandTask.id,action:'update',expectedRevision:commandTask.revision,expiresAt:new Date(Date.now()+300000).toISOString(),body:{summary:`command ${id}`}},controller.token);
    await call(hub.url,'GET','/api/node/commands',undefined,node.token);
    await call(hub.url,'POST',`/api/node/commands/${id}/claim`,{},node.token);
    await call(hub.url,'POST',`/api/node/commands/${id}/sending`,{},node.token);
    await call(hub.url,'POST',`/api/node/commands/${id}/receipt`,{status:'unknown'},node.token);
  }
  const unknownId='recovery-still-unknown',notAppliedId='recovery-not-applied',appliedId='recovery-applied',reconnectId='recovery-reconnect';
  await createUnknown(unknownId,task);await createUnknown(notAppliedId,notAppliedTask);await createUnknown(appliedId,appliedTask);await createUnknown(reconnectId,reconnectTask);
  const controllerScope=`legacy-token:${createHash('sha256').update(controller.token).digest('hex')}`;
  const taskById=new Map([[unknownId,task],[notAppliedId,notAppliedTask],[appliedId,appliedTask],[reconnectId,reconnectTask]]);
  const pagePending=[unknownId,notAppliedId,appliedId,reconnectId].map(id=>({id,action:'update',taskId:taskById.get(id).id,projectId:project.id,accountId:controllerScope,status:'unknown'}));

  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});page=await context.newPage();
  const browserRequests=[],receiptResponses=[];page.on('request',request=>{const path=new URL(request.url()).pathname;if(path==='/api/commands'&&request.method()==='POST')browserRequests.push({kind:'original',body:request.postDataJSON()});if(path.endsWith('/reconcile')&&request.method()==='POST')browserRequests.push({kind:'reconcile',path});if(/^\/api\/commands\/[^/]+$/.test(path)&&request.method()==='GET')browserRequests.push({kind:'receipt',path});});
  page.on('response',response=>{const request=response.request(),path=new URL(response.url()).pathname;if(request.method()==='GET'&&/^\/api\/commands\/[^/]+$/.test(path))receiptResponses.push(response);});
  await page.addInitScript(({token,pending})=>{if(!sessionStorage.getItem('recovery-fixture-initialized')){sessionStorage.setItem('taskboard-token',token);sessionStorage.setItem('tuijin-pending-commands',JSON.stringify(pending));sessionStorage.setItem('recovery-fixture-initialized','true');}}, {token:controller.token,pending:pagePending});
  await page.goto(hub.url);await page.getByRole('button',{name:/^更多页面/}).click();await page.getByRole('menuitem',{name:'需要我处理'}).click();await page.getByRole('heading',{name:'需要我处理'}).waitFor();
  const inboxCard=page.locator('.inbox-card').filter({has:page.getByRole('heading',{name:'远程操作结果尚未确认'})}).filter({has:page.locator(`.command-recovery[data-command-id="${unknownId}"]`)});
  const inboxReconCount=browserRequests.filter(item=>item.kind==='reconcile'&&item.path.endsWith(`/${unknownId}/reconcile`)).length;
  await inboxCard.locator(`.command-recovery[data-command-id="${unknownId}"]`).getByRole('button',{name:'核实这次操作'}).click();
  await until(()=>browserRequests.filter(item=>item.kind==='reconcile'&&item.path.endsWith(`/${unknownId}/reconcile`)).length>inboxReconCount,'Inbox did not reconcile the original command ID');
  await until(async()=>{const nodeState=await call(hub.url,'GET','/api/node/commands',undefined,node.token);return nodeState.recoveryProbes?.some(item=>item.commandId===unknownId);},'Hub did not deliver Inbox recovery probe');
  await call(hub.url,'POST',`/api/node/commands/${unknownId}/reconcile`,{outcome:'unknown',basis:'insufficient_evidence'},node.token);
  await inboxCard.getByText(/已核对，但仍无法确定结果/).waitFor();
  checks.push('Inbox reconciles the original command ID and retains the intent when node evidence stays unknown');
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('button',{name:/核实原命令/}).click();
  await page.getByRole('heading',{name:'核实原命令'}).waitFor();
  const pageRecovery=id=>page.locator(`.command-recovery[data-command-id="${id}"]`);

  async function selectTask(target){
    const returned=Boolean(await page.getByRole('button',{name:'返回清单'}).count());
    if(returned)await page.getByRole('button',{name:'返回清单'}).click();
    if(returned||target.id!==task.id)await page.getByRole('button',{name:new RegExp(target.title)}).click();
  }
  async function reconcile(id,outcome,target=task){
    await selectTask(target);
    const before=browserRequests.filter(item=>item.kind==='reconcile'&&item.path.endsWith(`/${id}/reconcile`)).length;
    await pageRecovery(id).getByRole('button',{name:'核实这次操作'}).click();
    await until(()=>browserRequests.filter(item=>item.kind==='reconcile'&&item.path.endsWith(`/${id}/reconcile`)).length>before,`UI did not request recovery for ${id}`);
    await until(async()=>{
      const nodeState=await call(hub.url,'GET','/api/node/commands',undefined,node.token);
      return nodeState.recoveryProbes?.some(item=>item.commandId===id);
    },`Hub did not deliver the recovery probe for ${id}`);
    const report=outcome==='applied'?{outcome,basis:'durable_receipt',status:'running',result:{taskId:taskById.get(id).id,status:'running'}}:outcome==='not_applied'?{outcome,basis:'pre_dispatch_marker'}:{outcome:'unknown',basis:'insufficient_evidence'};
    // Exercise a persisted sending intent separately from the held unknown GET below.
    // Combining both unmounts the recovery CTA and blocks the sequential fallback poll.
    if(outcome==='applied')await page.evaluate(id=>{const pending=JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]');sessionStorage.setItem('tuijin-pending-commands',JSON.stringify(pending.map(item=>item.id===id?{...item,status:'sending'}:item)));},id);
    await call(hub.url,'POST',`/api/node/commands/${id}/reconcile`,report,node.token);
    evidence.recoveryReports.push({id,outcome});
  }

  await reconcile(unknownId,'unknown');
  await pageRecovery(unknownId).getByText(/已核对，但仍无法确定结果/).waitFor();
  await page.getByRole('button',{name:'编辑任务'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'编辑任务'}).isDisabled(),true,'inconclusive result must preserve the write lock');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'390px layout overflows horizontally');
  await page.setViewportSize({width:320,height:740});await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'320px layout overflows horizontally');
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:join(qa,`recovery-${engine}.png`),fullPage:true});
  checks.push('unknown stays locked after explicit inconclusive node evidence; 320px/390px layouts fit');

  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('已有对话').selectOption(task.id);
  await page.locator(`.command-recovery[data-command-id="${unknownId}"]`).getByRole('button',{name:'核实这次操作'}).click();
  await until(()=>browserRequests.filter(item=>item.kind==='reconcile'&&item.path.endsWith(`/${unknownId}/reconcile`)).length>=2,'Conversation did not reconcile the original command ID');
  await until(async()=>{const nodeState=await call(hub.url,'GET','/api/node/commands',undefined,node.token);return nodeState.recoveryProbes?.some(item=>item.commandId===unknownId);},'Hub did not deliver Conversation recovery probe');
  await call(hub.url,'POST',`/api/node/commands/${unknownId}/reconcile`,{outcome:'unknown',basis:'insufficient_evidence'},node.token);
  await page.locator(`.command-recovery[data-command-id="${unknownId}"]`).getByText(/已核对，但仍无法确定结果/).waitFor();
  checks.push('Conversation also checks the same original ID and leaves unknown intent locked');
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await selectTask(reconnectTask);
  await pageRecovery(reconnectId).getByRole('button',{name:'核实这次操作'}).click();
  await until(async()=>{const nodeState=await call(hub.url,'GET','/api/node/commands',undefined,node.token);return nodeState.recoveryProbes?.some(item=>item.commandId===reconnectId);},'Hub did not deliver reconnect recovery probe');
  await openMobilePage(page,'手机连接');
  const receiptCountBeforeOffline=browserRequests.filter(item=>item.kind==='receipt'&&item.path.endsWith(`/${reconnectId}`)).length;
  await context.setOffline(true);await page.getByText(/连接已中断，当前显示/).waitFor({timeout:5000});
  await call(hub.url,'POST',`/api/node/commands/${reconnectId}/reconcile`,{outcome:'applied',basis:'durable_receipt',status:'running',result:{taskId:reconnectTask.id,status:'running',revision:2}},node.token);
  await context.setOffline(false);
  await until(()=>browserRequests.filter(item=>item.kind==='receipt'&&item.path.endsWith(`/${reconnectId}`)).length>receiptCountBeforeOffline,'receipt poll did not restart after reconnect');
  await until(async()=>!(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),reconnectId)),'reconnected poll did not apply final receipt to the original intent');
  checks.push('pending receipt polling restarts after offline/online epoch change and resolves the original intent');
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  let holdUnknownPoll=true;const heldUnknownPolls=[];
  await page.route(`**/api/commands/${unknownId}`,async route=>{
    if(route.request().method()==='GET'&&holdUnknownPoll)await new Promise(resolve=>heldUnknownPolls.push(resolve));
    await route.continue();
  });
  await reconcile(notAppliedId,'not_applied',notAppliedTask);
  await page.getByText(/电脑已确认这次操作没有执行/).waitFor();
  await until(()=>heldUnknownPolls.length>0,'an unchanged unknown receipt poll was not held after the not_applied confirmation');
  const unknownResponses=receiptResponses.filter(response=>new URL(response.url()).pathname.endsWith(`/${unknownId}`)).length;
  holdUnknownPoll=false;for(const release of heldUnknownPolls)release();
  await until(()=>receiptResponses.filter(response=>new URL(response.url()).pathname.endsWith(`/${unknownId}`)).length>unknownResponses,'the subsequent unknown receipt response did not arrive');
  const laterUnknownResponse=receiptResponses.filter(response=>new URL(response.url()).pathname.endsWith(`/${unknownId}`)).at(-1);
  await laterUnknownResponse.finished();
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await page.getByText(/电脑已确认这次操作没有执行/).waitFor();
  await page.unroute(`**/api/commands/${unknownId}`);
  assert.equal(await page.getByRole('button',{name:'编辑任务'}).isEnabled(),true,'not_applied should release only its own task intent');
  await until(async()=>!(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),notAppliedId)),'not_applied intent was not removed');
  assert.ok(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),unknownId),'resolving one ID must preserve another unknown intent');
  await selectTask(task);
  assert.equal(await page.getByRole('button',{name:'编辑任务'}).isDisabled(),true,'the unchanged unknown intent must continue locking its own task after another ID resolves');
  checks.push('not_applied confirmation survives another unchanged unknown poll while the other task remains locked');
  await reconcile(appliedId,'applied',appliedTask);
  await page.getByText(/电脑已确认这次操作已执行/).waitFor();
  assert.equal(await page.getByRole('button',{name:'编辑任务'}).isEnabled(),true,'applied should release only its own task intent');
  await until(async()=>!(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),appliedId)),'applied intent was not removed');
  assert.ok(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),unknownId),'finalizing another ID must preserve unknown intent');
  assert.equal(browserRequests.filter(item=>item.kind==='original').length,0,'reconciliation must never replay POST /api/commands');
  assert.equal(browserRequests.filter(item=>item.kind==='reconcile').length,6,'each requested check should use only the original command ID');
  checks.push('not_applied/applied release only their matching original intent; no original command POST replayed');

  // Hold both a receipt GET and logout response. Logout invalidates the old session synchronously,
  // so the late receipt must not remove the pending command before logout finishes.
  const secondPair=await call(hub.url,'POST','/api/admin/pairings',{role:'controller',projectIds:[project.id],ttlSeconds:600},owner);
  const second=await call(hub.url,'POST','/api/pairings/redeem',{code:secondPair.code});
  let releaseLogout,logoutHeld=false,lateReceipt;const heldReceipts=[];
  await page.route(`**/api/commands/${unknownId}`,async route=>{
    if(route.request().method()!=='GET')return route.continue();
    await new Promise(resolve=>heldReceipts.push(resolve));
    await route.fulfill({json:lateReceipt});
  });
  await selectTask(task);await pageRecovery(unknownId).getByRole('button',{name:'核实这次操作'}).click();
  await until(()=>heldReceipts.length>0,'recovery GET response was not held');
  await until(async()=>{const nodeState=await call(hub.url,'GET','/api/node/commands',undefined,node.token);return nodeState.recoveryProbes?.some(item=>item.commandId===unknownId);},'logout scenario recovery was not requested');
  await call(hub.url,'POST',`/api/node/commands/${unknownId}/reconcile`,{outcome:'applied',basis:'durable_receipt',status:'running',result:{taskId:task.id,status:'running',revision:2}},node.token);
  lateReceipt=await call(hub.url,'GET',`/api/commands/${unknownId}`,undefined,controller.token);
  assert.equal(lateReceipt.recovery.outcome,'applied');
  await page.route('**/api/auth/logout',async route=>{const response=await route.fetch();logoutHeld=true;await new Promise(resolve=>{releaseLogout=resolve;});await route.fulfill({response});});
  await openMobilePage(page,'账号');
  await page.getByRole('button',{name:'退出登录',exact:true}).click();
  await until(()=>logoutHeld,'logout did not reach the Hub');
  for(const release of heldReceipts)release();await page.waitForTimeout(300);
  assert.ok(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),unknownId),'late applied receipt must not delete journal while logout is pending');
  releaseLogout?.();
  await page.locator('.login-screen').waitFor();
  await page.evaluate(token=>sessionStorage.setItem('taskboard-token',token),second.token);
  await page.unroute(`**/api/commands/${unknownId}`);await page.reload();await page.getByRole('button',{name:/^更多页面/}).click();await page.getByRole('menuitem',{name:'需要我处理'}).click();await page.getByRole('heading',{name:'需要我处理'}).waitFor();
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('button',{name:/核实原命令/}).click();
  assert.equal(await page.locator(`.command-recovery[data-command-id="${unknownId}"]`).count(),0,'another paired identity must not see the first identity journal');
  assert.ok(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),unknownId),'logout and new identity must preserve the original scoped journal');
  assert.equal(browserRequests.filter(item=>item.kind==='original').length,0);
  checks.push('late receipt GET cannot delete journal during logout; different pairing cannot see the old intent');
  evidence.status='passed';evidence.checks=checks;evidence.browserRequests=browserRequests;evidence.commandIds={unknownId,notAppliedId,appliedId};
  evidence.engine=engine;await writeFile(join(qa,`result-${engine}.json`),JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
}catch(error){
  await writeFile(join(qa,`failure-${engine}.txt`),String(error.stack||error)+"\n"+(page?await page.locator('body').innerText().catch(()=>'unavailable'):'no page'));
  if(page)await page.screenshot({path:join(qa,`failure-${engine}.png`),fullPage:true}).catch(()=>{});
  throw error;
}finally{
  if(browser)await browser.close();if(hub)await hub.close();if(core)await core.close();await rm(root,{recursive:true,force:true});
}
