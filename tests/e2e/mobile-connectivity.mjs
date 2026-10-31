// The default checks repaired behavior. TEST_EXPECT_BASELINE=1 preserves the
// original production-bundle reproduction without weakening this regression.
import {chromium,webkit} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const expectFixed=process.env.TEST_EXPECT_BASELINE!=='1';
const qa=process.env.QA_DIR||resolve('design/qa/v0.4/iphone-connectivity');
const dir=await mkdtemp(join(tmpdir(),'seqivo-mobile-connectivity-'));
await mkdir(qa,{recursive:true});
let core,web,browser,releaseHeldRead;
try{
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'网络检测基线',goal:'验证挂起读取期间的写入状态'});
  const created=core.store.createTask({projectId:project.id,title:'待验收网络状态',goal:'验收当前任务',summary:'已提交，等待人工验收。',criteria:['人工核对']});
  const task=core.store.updateTask(created.id,{status:'submitted'},created.revision);
  const base=await core.state();
  const snapshot={...base,projects:base.projects.map(item=>({...item,inboxAvailable:true})),connection:{...base.connection,mode:'hub',offline:false},capabilities:{...base.capabilities,remote:true,inbox:true,role:'controller'}};
  web=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve(process.env.TEST_DIST_DIR||'dist'),port:0});
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  const page=await context.newPage();
  const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
  let holdNextState=false,stateReads=0,heldStartedAt=0,writePosts=[],stateMode='ok',heldOutcome='fail',fakeUnknownWrite=false;
  await context.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(request.method()==='GET'&&path==='/api/state'){
      stateReads++;
      if(holdNextState){
        holdNextState=false;heldStartedAt=Date.now();
        await new Promise(resolve=>{releaseHeldRead=resolve});
        try{return heldOutcome==='success'?await route.fulfill({json:snapshot}):await route.abort('failed');}catch{return;}
      }
      return stateMode==='fail'?route.abort('failed'):route.fulfill({json:snapshot});
    }
    if(request.method()==='POST'&&(/\/api\/commands(?:\/|$)/.test(path)||/\/api\/tasks\/.+\/review$/.test(path))){
      writePosts.push({path,at:Date.now()});
      if(fakeUnknownWrite){const command=request.postDataJSON();return route.fulfill({json:{commandId:command.commandId,projectId:command.projectId,taskId:command.taskId,action:command.action,status:'unknown'}})}
      return route.abort('blockedbyclient');
    }
    if(request.method()==='GET'&&/\/api\/commands\/[^/]+$/.test(path))return route.fulfill({json:{commandId:path.split('/').pop(),projectId:project.id,taskId:task.id,action:'review',status:'unknown'}});
    return route.continue();
  });
  await page.goto(`http://127.0.0.1:${web.port}`);
  const card=page.locator('.inbox-card').filter({has:page.getByRole('heading',{name:'待验收网络状态'})});
  await card.getByRole('button',{name:'人工验收'}).click();
  const dialog=page.getByRole('dialog',{name:'人工验收'});
  await dialog.getByLabel('验收说明').fill('等待网络读取时保留的草稿');
  const submit=dialog.getByRole('button',{name:'提交结论'});
  assert.equal(await submit.isEnabled(),true,'online review begins enabled');
  const initialReads=stateReads;
  holdNextState=true;
  if(expectFixed){
    stateMode='fail';heldOutcome='success';
    await page.evaluate(()=>{window.dispatchEvent(new Event('pageshow'));document.querySelector('[role="dialog"] form')?.requestSubmit()});
    assert.equal(writePosts.length,0,'resume handler blocks a write before React re-renders');
    await dialog.getByText('正在确认连接；确认前不能提交，草稿会保留。').waitFor();
    assert.equal(await submit.isDisabled(),true,'resume closes the write gate immediately');
  }
  const deadline=Date.now()+6000;
  while(!releaseHeldRead&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
  assert.ok(releaseHeldRead,'a fresh /api/state poll began');
  const readsAtHold=stateReads;
  await new Promise(resolve=>setTimeout(resolve,5500));
  const during={elapsedMs:Date.now()-heldStartedAt,navigatorOnline:await page.evaluate(()=>navigator.onLine),submitEnabled:await submit.isEnabled(),alertCount:await page.locator('.banner.alert').count(),stateReads,readsAtHold,writePosts:writePosts.length,draft:await dialog.getByLabel('验收说明').inputValue()};
  await page.screenshot({path:join(qa,`${expectFixed?'regression':'baseline'}-pending-${engine}.png`),fullPage:true,animations:'disabled'});
  assert.equal(during.navigatorOnline,true,'browser still reports online while Hub read hangs');
  assert.equal(during.submitEnabled,!expectFixed,expectFixed?'fixed: submit stays disabled during a hanging read':'baseline: submit remains enabled during a hanging read');
  if(expectFixed){assert.ok(during.alertCount>=1,'fixed: checking warning remains visible');await page.locator('.banner.alert').filter({hasText:'正在确认手机与目标电脑的连接'}).waitFor();}
  else assert.equal(during.alertCount,0,'baseline: no connectivity warning during a hanging read');
  assert.equal(during.stateReads,during.readsAtHold,'single-flight polling cannot probe again while read hangs');
  assert.equal(during.writePosts,0,'test never attempted a real write');
  assert.equal(during.draft,'等待网络读取时保留的草稿');
  if(expectFixed){
    await page.getByText('连接状态待确认，请恢复连接后刷新。',{exact:false}).first().waitFor({timeout:6000});
    assert.equal(await submit.isDisabled(),true,'deadline ends read without reopening writes');
  }
  releaseHeldRead();releaseHeldRead=null;
  if(!expectFixed)await page.locator('.banner.alert').filter({hasText:'暂时连接不上服务器'}).waitFor({timeout:8000});
  await page.waitForFunction(()=>document.querySelector('[role="dialog"] button[type="submit"]')?.disabled===true);
  const after={navigatorOnline:await page.evaluate(()=>navigator.onLine),submitDisabled:await submit.isDisabled(),writePosts:writePosts.length,stateReads,taskRevision:core.store.getTask(task.id).revision,taskAcceptance:core.store.getTask(task.id).acceptance};
  await page.screenshot({path:join(qa,`${expectFixed?'regression':'baseline'}-failed-${engine}.png`),fullPage:true,animations:'disabled'});
  assert.equal(after.navigatorOnline,true,'failed fetch does not flip navigator.onLine');
  assert.equal(after.submitDisabled,true,'actual fetch failure eventually blocks review');
  assert.equal(after.writePosts,0);
  assert.equal(after.taskRevision,task.revision);
  assert.notEqual(after.taskAcceptance,'passed');
  assert.ok(stateReads>initialReads);
  if(expectFixed){
    stateMode='ok';
    await page.evaluate(()=>document.querySelector('.banner.alert button')?.click());
    await page.waitForFunction(()=>document.querySelector('[role="dialog"] button[type="submit"]')?.disabled===false,{timeout:8000});
    assert.equal(await dialog.getByLabel('验收说明').inputValue(),'等待网络读取时保留的草稿');
    assert.equal(writePosts.length,0,'recovery never auto-submits the old draft');
    holdNextState=true;
    await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
    const secondDeadline=Date.now()+5000;
    while(!releaseHeldRead&&Date.now()<secondDeadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(releaseHeldRead,'second resume started a state read');
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});document.dispatchEvent(new Event('visibilitychange'))});
    assert.equal(await submit.isDisabled(),true,'hiding again invalidates the pending read');
    releaseHeldRead();releaseHeldRead=null;
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.equal(await submit.isDisabled(),true,'late response while hidden cannot reopen writes');
    await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.dispatchEvent(new Event('visibilitychange'))});
    await page.waitForFunction(()=>document.querySelector('[role="dialog"] button[type="submit"]')?.disabled===false,{timeout:8000});
    assert.equal(writePosts.length,0,'second resume also did not submit the draft');
    // A routine poll does not close the gate immediately, but its own deadline
    // must close it even if navigator.onLine stays true and no resume fires.
    holdNextState=true;stateMode='fail';heldOutcome='success';
    const pollDeadline=Date.now()+5000;
    while(!releaseHeldRead&&Date.now()<pollDeadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(releaseHeldRead,'ordinary polling started a state read');
    assert.equal(await submit.isEnabled(),true,'starting an ordinary poll does not flicker the write gate');
    await page.waitForFunction(()=>document.querySelector('[role="dialog"] button[type="submit"]')?.disabled===true,null,{timeout:10000});
    assert.equal(await submit.isDisabled(),true,'ordinary hung poll closes the gate at its deadline');
    assert.ok(Date.now()-heldStartedAt<10500,'ordinary poll is bounded near the eight-second read deadline');
    assert.ok(await page.locator('.banner.alert').count()>0,'a connectivity warning explains the disabled action');
    assert.equal(await page.evaluate(()=>navigator.onLine),true);
    releaseHeldRead();releaseHeldRead=null;
    stateMode='ok';
    await page.evaluate(()=>document.querySelector('.banner.alert button')?.click());
    await page.waitForFunction(()=>document.querySelector('[role="dialog"] button[type="submit"]')?.disabled===false,{timeout:8000});
    assert.equal(writePosts.length,0,'ordinary polling failure and recovery did not submit');
    // A real offline/online pair is stronger than a page resume. Even if the
    // earlier checking read succeeds late, only the post-online read may open.
    holdNextState=true;stateMode='fail';heldOutcome='success';
    await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
    const oldDeadline=Date.now()+4000;
    while(!releaseHeldRead&&Date.now()<oldDeadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(releaseHeldRead,'pre-disconnect checking read began');
    const releaseOldRead=releaseHeldRead;releaseHeldRead=null;
    const readsBeforeTransition=stateReads;
    holdNextState=true;
    await page.evaluate(()=>{
      Object.defineProperty(navigator,'onLine',{configurable:true,value:false});window.dispatchEvent(new Event('offline'));
      Object.defineProperty(navigator,'onLine',{configurable:true,value:true});window.dispatchEvent(new Event('online'));
    });
    const newDeadline=Date.now()+4000;
    while(!releaseHeldRead&&Date.now()<newDeadline)await new Promise(resolve=>setTimeout(resolve,50));
    assert.ok(releaseHeldRead,'online transition began a distinct fresh read');
    assert.ok(stateReads>readsBeforeTransition,'online transition did not reuse the old in-flight GET');
    releaseOldRead();
    await page.waitForTimeout(250);
    assert.equal(await submit.isDisabled(),true,'late pre-offline response cannot reopen writes');
    releaseHeldRead();releaseHeldRead=null;
    stateMode='ok';
    await page.waitForFunction(()=>document.querySelector('[role="dialog"] button[type="submit"]')?.disabled===false,{timeout:8000});
    assert.equal(writePosts.length,0,'offline/online recovery did not submit the draft');
    // One intercepted, synthetic unknown receipt must keep its original intent
    // fenced through another connectivity transition; the Core sees no write.
    fakeUnknownWrite=true;
    await submit.click();
    await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.action==='review'&&item.status==='unknown'));
    const pending=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').find(item=>item.action==='review'));
    assert.equal(writePosts.length,1,'only the intentional fixture POST occurred');
    assert.equal(core.store.getTask(task.id).revision,task.revision,'fixture never wrote to Core');
    await page.evaluate(()=>window.dispatchEvent(new Event('pageshow')));
    await page.waitForTimeout(1000);
    assert.equal(writePosts.length,1,'resume did not replay unknown command');
    assert.equal(await page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),pending.id),true,'same unknown command ID remains fenced');
  }
  assert.deepEqual(pageErrors,[]);
  await writeFile(join(qa,`${expectFixed?'regression':'baseline'}-${engine}.json`),JSON.stringify({engine,distDir:expectFixed?process.env.TEST_DIST_DIR:resolve('dist'),during,after},null,2));
  console.log(expectFixed?`REGRESSION_PASS [${engine}]: resume closed gate, hanging GET timed out, fresh state reopened without POST`:`BASELINE_REPRODUCED [${engine}]: navigator.onLine=true, held state GET ${during.elapsedMs}ms, submit enabled/no warning; fetch failure then disabled; writes=0`);
  await context.close();
}finally{releaseHeldRead?.();await browser?.close();await web?.close();await core?.close();await rm(dir,{recursive:true,force:true})}
