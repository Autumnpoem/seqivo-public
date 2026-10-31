import {chromium,webkit} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const dir=await mkdtemp(join(tmpdir(),'seqivo-review-rejection-ui-'));
const qa=process.env.QA_DIR||join(dir,'screenshots');
await mkdir(qa,{recursive:true});
let core,web,browser;
const errors=[];
const fixedReason='本次没有保存验收结论：缺少当前版本的验收证据。请添加证据后重新检查。';
try{
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'验收回执测试',goal:'核对手机端拒绝文案'});
  const draft=core.store.createTask({projectId:project.id,title:'验收证据待补',goal:'验收当前版本',summary:'成果已提交，尚缺当前版本的证据。',criteria:['当前版本有证据']});
  const task=core.store.updateTask(draft.id,{status:'submitted'},draft.revision);
  const localState=await core.state();
  const hubState={...localState,projects:localState.projects.map(p=>({...p,inboxAvailable:true})),connection:{...localState.connection,mode:'hub',offline:false},capabilities:{...localState.capabilities,remote:true,inbox:true,role:'controller'}};
  web=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve(process.env.TEST_DIST_DIR||'dist'),port:0});
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});

  async function scenario(name,initialMode){
    const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
    let mode=initialMode,commandId='',commandPosts=0,reconcilePosts=0,receiptGets=0;
    const requestedAt=new Date(Date.now()-1000).toISOString();
    const receipt=(status,{action='review',taskId=task.id,code='REVIEW_CURRENT_EVIDENCE_REQUIRED',recovery}={})=>({commandId,projectId:project.id,taskId,action,status,result:{taskId,status:'rejected',failureCode:code},...(recovery?{recovery}:{}),createdAt:requestedAt,updatedAt:new Date().toISOString()});
    await page.route('**/api/state',route=>route.fulfill({json:hubState}));
    await page.route('**/api/commands',route=>{commandPosts++;const body=route.request().postDataJSON();commandId=body.commandId;assert.equal(body.action,'review');assert.equal(body.taskId,task.id);return route.fulfill({json:receipt('queued')})});
    await page.route('**/api/commands/*',route=>{receiptGets++;let value;
      if(mode==='failed')value=receipt('failed');
      else if(mode==='wrong-task')value=receipt('failed',{taskId:'other-task'});
      else if(mode==='wrong-action')value=receipt('failed',{action:'evidence'});
      else if(mode==='wrong-code')value=receipt('failed',{code:'UNRECOGNIZED_CODE'});
      else if(mode==='confirmed')value=receipt('failed',{recovery:{outcome:'not_applied',basis:'transaction_rollback',requestedAt,checkedAt:new Date().toISOString()}});
      else value=receipt('unknown');
      return route.fulfill({json:value});
    });
    await page.route('**/api/commands/*/reconcile',route=>{reconcilePosts++;mode='confirmed';return route.fulfill({json:receipt('unknown')})});
    await page.goto(`http://127.0.0.1:${web.port}`);
    const card=page.locator('.inbox-card').filter({has:page.getByRole('heading',{name:'验收证据待补'})});
    await card.getByRole('button',{name:'人工验收'}).click();
    const dialog=page.getByRole('dialog',{name:'人工验收'});
    await dialog.getByLabel('验收说明').fill('检查本次交付');
    await dialog.getByRole('button',{name:'提交结论'}).click();
    await dialog.waitFor({state:'hidden'});
    await page.getByRole('heading',{name:'验收证据待补',exact:true}).waitFor();
    const evidence=page.getByRole('button',{name:'添加证据'});
    assert.equal(commandPosts,1,`${name}: one review command`);
    assert.equal(core.store.getTask(task.id).acceptance==='passed',false,`${name}: no acceptance persisted`);
    return {context,page,evidence,receipt,setMode:value=>{mode=value},counts:()=>({commandPosts,reconcilePosts,receiptGets})};
  }

  const rejected=await scenario('failed','failed');
  await rejected.page.locator('.task-review-feedback').getByText(fixedReason).waitFor();
  await rejected.page.locator('.alert.banner[role="alert"]').getByText(fixedReason).waitFor();
  assert.equal(await rejected.page.locator('.notice.banner').count(),0,'rejection is not a success banner');
  await rejected.page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').length===0);
  assert.equal(await rejected.evidence.isEnabled(),true,'failed review unlocks evidence action');
  assert.equal(core.store.getTask(task.id).acceptance==='passed',false);
  await rejected.page.screenshot({path:join(qa,`review-failed-${engine}.png`),fullPage:true,animations:'disabled'});
  await rejected.context.close();

  const unknown=await scenario('unknown','unknown');
  await unknown.page.getByText('操作结果未知',{exact:false}).waitFor();
  assert.equal(await unknown.page.locator('.notice.banner').count(),0,'unknown is not a success banner');
  assert.equal(await unknown.evidence.isDisabled(),true,'unknown keeps write locked');
  assert.equal(await unknown.page.getByText(fixedReason).count(),0,'unknown failureCode cannot imply rejection');
  assert.equal(unknown.counts().commandPosts,1);
  async function waitForNextReceipt(before){const deadline=Date.now()+6000;while(unknown.counts().receiptGets<=before&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));assert.ok(unknown.counts().receiptGets>before,'poll read the selected receipt fixture');}
  let reads=unknown.counts().receiptGets;
  unknown.setMode('wrong-task');await waitForNextReceipt(reads);
  assert.equal(await unknown.evidence.isDisabled(),true,'wrong task cannot clear intent');
  assert.equal(await unknown.page.getByText('已确认这次操作没有执行',{exact:false}).count(),0);
  reads=unknown.counts().receiptGets;
  unknown.setMode('wrong-action');await waitForNextReceipt(reads);
  assert.equal(await unknown.evidence.isDisabled(),true,'wrong action cannot clear intent');
  assert.equal(await unknown.page.getByText('已确认这次操作没有执行',{exact:false}).count(),0);
  unknown.setMode('unknown');
  await unknown.page.getByRole('button',{name:'核实这次操作'}).click();
  await unknown.page.locator('.task-review-feedback').getByText(fixedReason).waitFor();
  await unknown.page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('tuijin-pending-commands')||'[]').length===0);
  assert.equal(await unknown.evidence.isEnabled(),true,'confirmed rollback unlocks evidence action');
  assert.equal(unknown.counts().reconcilePosts,1);
  assert.equal(unknown.counts().commandPosts,1,'reconcile did not replay review');
  assert.equal(core.store.getTask(task.id).acceptance==='passed',false);
  await unknown.page.screenshot({path:join(qa,`review-reconciled-${engine}.png`),fullPage:true,animations:'disabled'});
  await unknown.context.close();

  const badCode=await scenario('wrong-code','wrong-code');
  await badCode.page.getByText('请求执行失败。',{exact:false}).waitFor();
  assert.equal(await badCode.page.getByText(fixedReason).count(),0);
  assert.equal(await badCode.page.getByText('已确认这次操作没有执行',{exact:false}).count(),0);
  assert.equal(await badCode.evidence.isEnabled(),true);
  await badCode.context.close();
  assert.deepEqual(errors,[]);
  console.log(`PASS [${engine}]: review rejection, unknown lock, scoped mismatch, confirmed rollback, no replay`);
}finally{await browser?.close();await web?.close();await core?.close();await rm(dir,{recursive:true,force:true})}
