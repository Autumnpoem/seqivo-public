import {chromium,webkit} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const qa=resolve(process.env.QA_DIR||'design/qa/v0.4/review-feedback');
const dir=await mkdtemp(join(tmpdir(),'seqivo-review-feedback-'));
await mkdir(qa,{recursive:true});
let core,web,browser;
const pageErrors=[];
try{
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'验收反馈',goal:'手机验收回执核对'});
  const first=core.store.createTask({projectId:project.id,title:'缺少证据的任务',goal:'确认拒绝可见',summary:'成果已提交。',criteria:['有当前版本证据']});
  const missing=core.store.updateTask(first.id,{status:'submitted'},first.revision);
  const second=core.store.createTask({projectId:project.id,title:'可以验收的任务',goal:'确认成功反馈',summary:'已有证据。',criteria:['有当前版本证据']});
  const evidenced=core.store.addEvidence(second.id,{expectedRevision:second.revision,summary:'本轮检查',reference:'fixture-check'});
  const ready=core.store.updateTask(second.id,{status:'submitted'},evidenced.revision);
  web=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve(process.env.TEST_DIST_DIR||'dist'),port:0});
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const failureReason='本次没有保存验收结论：缺少当前版本的验收证据。请添加证据后重新检查。';
  const evidence={engine,cases:{}};
  async function scenario(target,initialMode){
    const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
    const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
    await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
    let mode=initialMode,commandId='',posts=0,gets=0;
    const receipt=()=>({commandId,projectId:project.id,taskId:target.id,action:'review',...(mode==='malformed'?{}:{status:mode}),result:mode==='failed'||mode==='unknown'?{taskId:target.id,status:'rejected',failureCode:'REVIEW_CURRENT_EVIDENCE_REQUIRED'}:mode==='running'?{taskId:target.id,status:'submitted',acceptance:'passed'}:null,...(mode==='unknown'?{recovery:{outcome:'not_applied',requestedAt:new Date().toISOString(),checkedAt:new Date(0).toISOString()}}:{})});
    await context.route('**/api/**',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      if(request.method()==='GET'&&path==='/api/state'){
        const state=await core.state();
        return route.fulfill({json:{...state,projects:state.projects.map(item=>({...item,inboxAvailable:true})),connection:{...state.connection,mode:'hub',offline:false},capabilities:{...state.capabilities,remote:true,inbox:true,role:'controller'}}});
      }
      if(request.method()==='POST'&&path==='/api/commands'){
        const body=request.postDataJSON();assert.equal(body.action,'review');assert.equal(body.taskId,target.id);
        posts++;commandId=body.commandId;return route.fulfill({json:{...receipt(),status:'queued',result:null}});
      }
      if(request.method()==='GET'&&path===`/api/commands/${commandId}`){gets++;return route.fulfill({json:receipt()});}
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${web.port}`);
    await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
    await page.getByRole('button',{name:target.title}).click();
    await page.locator('.detail-scroll').evaluate(element=>element.scrollTop=element.scrollHeight);
    await page.getByRole('button',{name:'人工验收'}).click();
    const dialog=page.getByRole('dialog',{name:'人工验收'});
    await dialog.getByLabel('验收说明').fill('我已检查当前结果');
    await dialog.getByRole('button',{name:'提交结论'}).click();
    await dialog.waitFor({state:'hidden'});
    const feedback=page.locator('.task-review-feedback');
    await feedback.getByText('等待目标电脑确认',{exact:false}).waitFor();
    assert.equal(await feedback.getAttribute('role'),'status','queued is informational, not successful');
    assert.equal(await page.locator('.detail-heading .pill.good').count(),0,'queued review must not show accepted');
    assert.equal(posts,1);
    return {context,page,feedback,setMode:value=>{mode=value},commandId:()=>commandId,counts:()=>({posts,gets})};
  }

  const failed=await scenario(missing,'queued');
  evidence.cases.pending={posts:failed.counts().posts,acceptance:core.store.getTask(missing.id).acceptance};
  failed.setMode('failed');
  await failed.feedback.getByText(failureReason).waitFor({timeout:8000});
  const inViewport=await failed.feedback.evaluate(element=>{const box=element.getBoundingClientRect(),scroll=element.closest('.detail-scroll')?.getBoundingClientRect(),nav=document.querySelector('.mobile-nav')?.getBoundingClientRect();return Boolean(scroll&&nav&&box.bottom>scroll.top&&box.top<scroll.bottom&&box.top>=0&&box.bottom<=nav.top)});
  if(!inViewport){console.log(JSON.stringify({engine,layout:await failed.feedback.evaluate(element=>({feedback:element.getBoundingClientRect().toJSON(),scroll:element.closest('.detail-scroll')?.getBoundingClientRect().toJSON(),nav:document.querySelector('.mobile-nav')?.getBoundingClientRect().toJSON(),windowScrollY:scrollY,viewportHeight:innerHeight}))}));await failed.page.screenshot({path:join(qa,`rejected-layout-failure-${engine}.png`),animations:'disabled'});}
  assert.equal(inViewport,true,'rejection remains visible near scrolled task actions');
  assert.equal(await failed.feedback.getAttribute('role'),'alert');
  assert.equal(await failed.page.locator('.detail-heading .pill.good').count(),0);
  assert.equal(core.store.getTask(missing.id).acceptance,'unverified');
  assert.equal(core.store.getTask(missing.id).evidence.length,0);
  assert.equal(core.store.getTask(missing.id).reviewHistory?.length||0,0);
  await failed.page.screenshot({path:join(qa,`rejected-scrolled-${engine}.png`),animations:'disabled'});
  failed.setMode('queued');
  await failed.page.getByRole('button',{name:'人工验收'}).click();
  const retryDialog=failed.page.getByRole('dialog',{name:'人工验收'});
  await retryDialog.getByLabel('验收说明').fill('再次核对');
  await retryDialog.getByRole('button',{name:'提交结论'}).click();
  await retryDialog.waitFor({state:'hidden'});
  await failed.feedback.getByText('等待目标电脑确认',{exact:false}).waitFor();
  assert.equal(await failed.feedback.getByText(failureReason).count(),0,'a newer pending command replaces the old rejection message');
  failed.setMode('failed');
  await failed.feedback.getByText(failureReason).waitFor({timeout:8000});
  await failed.page.locator('.detail-top .back-button').click();
  await failed.page.getByRole('button',{name:ready.title}).click();
  assert.equal(await failed.page.locator('.task-review-feedback').count(),0,'another task cannot inherit the rejection');
  await failed.page.locator('.sidebar-bottom button.quiet').evaluate(element=>element.click());
  await failed.page.locator('.login-screen').waitFor();
  await failed.page.getByLabel('访问令牌').fill(web.tokens.owner);
  await failed.page.getByRole('button',{name:'进入看板'}).click();
  await failed.page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await failed.page.getByRole('button',{name:missing.title}).click();
  assert.equal(await failed.page.locator('.task-review-feedback').count(),0,'new auth generation does not inherit old feedback');
  evidence.cases.failed={visibleAtScroll:inViewport,posts:failed.counts().posts,acceptance:core.store.getTask(missing.id).acceptance};
  await failed.context.close();

  const success=await scenario(ready,'queued');
  const approved=core.store.review(ready.id,{expectedRevision:ready.revision,decision:'pass',summary:'真实 Core 已核对'});
  success.setMode('running');
  await success.feedback.getByText('当前任务已通过验收').waitFor({timeout:8000});
  assert.equal(approved.acceptance,'passed');
  assert.equal(await success.page.locator('.detail-heading .pill.good').count(),1);
  evidence.cases.success={posts:success.counts().posts,acceptance:approved.acceptance};
  await success.context.close();

  const unknown=await scenario(missing,'queued');
  unknown.setMode('unknown');
  await unknown.feedback.getByText('验收结果尚未确认',{exact:false}).waitFor({timeout:8000});
  assert.equal(await unknown.feedback.getByText(failureReason).count(),0,'unproven failureCode cannot imply rejection');
  assert.equal(await unknown.page.getByRole('button',{name:'添加证据'}).isDisabled(),true,'unknown remains fenced');
  assert.equal(unknown.counts().posts,1,'unknown did not replay the command');
  evidence.cases.unknown={posts:unknown.counts().posts,acceptance:core.store.getTask(missing.id).acceptance};
  await unknown.context.close();

  const malformed=await scenario(missing,'queued');
  malformed.setMode('malformed');
  await malformed.page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.action==='review'&&item.status==='unknown'));
  assert.equal(await malformed.page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),malformed.commandId()),true,'malformed GET keeps original ID');
  assert.equal(await malformed.feedback.getByText('验收结果尚未确认',{exact:false}).count(),1);
  assert.equal(await malformed.page.getByText('已通过验收',{exact:false}).count(),0);
  assert.equal(await malformed.page.getByRole('button',{name:'添加证据'}).isDisabled(),true);
  evidence.cases.malformedPoll={posts:malformed.counts().posts,originalIdRetained:true};
  await malformed.context.close();

  async function special(postResponse){
    const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
    const page=await context.newPage();page.on('pageerror',error=>pageErrors.push(error.message));
    await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
    let commandId='',posts=0;
    await context.route('**/api/**',async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      if(request.method()==='GET'&&path==='/api/state'){
        const state=await core.state();return route.fulfill({json:{...state,projects:state.projects.map(item=>({...item,inboxAvailable:true})),connection:{...state.connection,mode:'hub',offline:false},capabilities:{...state.capabilities,remote:true,inbox:true,role:'controller'}}});
      }
      if(request.method()==='POST'&&path==='/api/commands'){
        posts++;const body=request.postDataJSON();commandId=body.commandId;
        return postResponse(route,body);
      }
      if(request.method()==='GET'&&path===`/api/commands/${commandId}`)return route.fulfill({json:{commandId,projectId:project.id,taskId:missing.id,action:'review',status:'unknown'}});
      return route.continue();
    });
    await page.goto(`http://127.0.0.1:${web.port}`);
    await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
    await page.getByRole('button',{name:missing.title}).click();
    await page.getByRole('button',{name:'人工验收'}).click();
    const dialog=page.getByRole('dialog',{name:'人工验收'});
    await dialog.getByLabel('验收说明').fill('继续核对');
    await dialog.getByRole('button',{name:'提交结论'}).click();
    return {context,page,dialog,commandId:()=>commandId,posts:()=>posts};
  }
  const spoof=await special((route,body)=>route.fulfill({json:{commandId:crypto.randomUUID(),projectId:body.projectId,taskId:body.taskId,action:'review',status:'failed',result:{taskId:body.taskId,status:'rejected',failureCode:'REVIEW_CURRENT_EVIDENCE_REQUIRED'}}}));
  await spoof.page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.action==='review'&&item.status==='unknown'));
  assert.equal(await spoof.dialog.isVisible(),true,'wrong command ID cannot close the draft as a confirmed result');
  assert.equal(await spoof.page.getByText(failureReason).count(),0,'wrong command ID cannot attribute a rejection');
  assert.equal(await spoof.page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),spoof.commandId()),true,'original ID stays fenced');
  assert.equal(spoof.posts(),1);
  evidence.cases.wrongCommand={posts:spoof.posts(),originalIdRetained:true};
  await spoof.context.close();

  const missingStatus=await special((route,body)=>route.fulfill({json:{commandId:body.commandId,projectId:body.projectId,taskId:body.taskId,action:'review'}}));
  await missingStatus.page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.action==='review'&&item.status==='unknown'));
  assert.equal(await missingStatus.dialog.isVisible(),true,'missing status cannot close the review draft');
  assert.equal(await missingStatus.page.getByText('已通过验收',{exact:false}).count(),0,'missing status cannot show generic success');
  assert.equal(await missingStatus.page.evaluate(id=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').some(item=>item.id===id),missingStatus.commandId()),true);
  evidence.cases.missingStatus={posts:missingStatus.posts(),originalIdRetained:true};
  await missingStatus.context.close();

  let releaseLatePost;
  const late=await special(async(route,body)=>{await new Promise(resolve=>{releaseLatePost=resolve});return route.fulfill({json:{commandId:body.commandId,projectId:body.projectId,taskId:body.taskId,action:'review',status:'failed',result:{taskId:body.taskId,status:'rejected',failureCode:'REVIEW_CURRENT_EVIDENCE_REQUIRED'}}})});
  assert.ok(releaseLatePost,'old review POST is held before logout');
  await late.page.locator('.sidebar-bottom button.quiet').evaluate(element=>element.click());
  await late.page.locator('.login-screen').waitFor();
  await late.page.getByLabel('访问令牌').fill(web.tokens.owner);
  await late.page.getByRole('button',{name:'进入看板'}).click();
  await late.page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await late.page.getByRole('button',{name:missing.title}).click();
  releaseLatePost();releaseLatePost=null;
  await late.page.waitForTimeout(400);
  assert.equal(await late.page.getByText(failureReason).count(),0,'late response from prior auth generation cannot tag the new session');
  assert.equal(core.store.getTask(missing.id).acceptance,'unverified');
  evidence.cases.lateOldAuth={posts:late.posts(),acceptance:core.store.getTask(missing.id).acceptance};
  await late.context.close();
  let releaseLateError;
  const lateError=await special(async route=>{await new Promise(resolve=>{releaseLateError=resolve});return route.abort('failed')});
  assert.ok(releaseLateError);
  await lateError.page.locator('.sidebar-bottom button.quiet').evaluate(element=>element.click());
  await lateError.page.locator('.login-screen').waitFor();
  await lateError.page.getByLabel('访问令牌').fill(web.tokens.owner);
  await lateError.page.getByRole('button',{name:'进入看板'}).click();
  await lateError.page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await lateError.page.getByRole('button',{name:missing.title}).click();
  releaseLateError();releaseLateError=null;
  await lateError.page.waitForTimeout(400);
  assert.equal(await lateError.page.getByText('暂时连接不上服务器',{exact:false}).count(),0,'old POST network error cannot mark the new auth generation offline');
  assert.equal(core.store.getTask(missing.id).acceptance,'unverified');
  evidence.cases.lateOldAuthError={posts:lateError.posts(),acceptance:core.store.getTask(missing.id).acceptance};
  await lateError.context.close();
  assert.deepEqual(pageErrors,[]);
  await writeFile(join(qa,`review-feedback-${engine}.json`),JSON.stringify(evidence,null,2));
  console.log(`PASS [${engine}]: pending/rejected/success/unknown are task-scoped and visible at scrolled actions`);
}finally{await browser?.close();await web?.close();await core?.close();await rm(dir,{recursive:true,force:true})}
