/** Browser UI contract test. Plugin policy writes are mocked; no AI turn runs. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const dir=await mkdtemp(join(tmpdir(),'seqivo-autocontinue-policy-ui-'));
async function openMobilePage(page,name){await page.getByRole('button',{name:/^更多页面/}).click();await page.getByRole('menuitem',{name,exact:true}).click();}
let core,server,browser;
try {
  core=await createCore({dataDir:join(dir,'data'),pluginDir:resolve('plugins'),files:false});
  const project=core.store.project({name:'自动继续界面测试',goal:'验证计划预算与停止门禁。',directory:dir});
  const task=core.store.createTask({projectId:project.id,title:'已绑定的任务',goal:'继续已绑定会话。',criteria:['核对进展'],conversationId:'test-thread',executionProvider:'codex-autocontinue'});
  core.store.createTask({projectId:project.id,title:'尚未绑定的任务',goal:'等待绑定。',criteria:['绑定会话'],executionProvider:'codex-autocontinue'});
  server=await startHttp({core,dataDir:join(dir,'data'),distDir:resolve('dist'),port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:390,height:844}});
  const errors=[],writes=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),server.tokens.owner);
  let policy=null,taskState='planned',pluginEnabled=true,inboxCard=null,rejectRestart=false;
  const pluginActions=[];
  const startedAt=new Date(Date.now()-60000).toISOString(),deadlineAt=new Date(Date.now()+89*60000).toISOString();
  const plugin=()=>({id:'codex-autocontinue',name:'Codex Auto Continue',version:'test',enabled:pluginEnabled,available:true,status:'ready',lastError:'',quota:{blocked:false,checkedAt:new Date().toISOString(),windows:[]},config:{pythonPath:'',codexPath:'',graceSeconds:30,pollSeconds:60},policies:policy?[policy]:[],capabilities:['per-task-policy']});
  const snapshot=data=>({...data,tasks:data.tasks.map(item=>item.id===task.id?{...item,status:taskState}:item),plugin:plugin(),capabilities:{...data.capabilities,inbox:true},inbox:inboxCard?{items:[inboxCard],updatedAt:new Date().toISOString()}:data.inbox});
  await page.route('**/api/state',async route=>{const response=await route.fetch();const data=await response.json();await route.fulfill({response,json:snapshot(data)});});
  await page.route('**/api/plugin/disable',async route=>{pluginActions.push('disable');pluginEnabled=false;await route.fulfill({json:plugin()});});
  await page.route('**/api/plugin/enable',async route=>{pluginActions.push('enable');pluginEnabled=true;await route.fulfill({json:plugin()});});
  await page.route('**/api/plugin/policy',async route=>{
    const body=route.request().postDataJSON();writes.push(body);
    if(body.restart&&rejectRestart){await route.fulfill({status:409,json:{code:'POLICY_RESTART_BLOCKED',error:'Original task executor is not confirmed idle; policy cannot restart'}});return;}
    if(body.enabled&&body.restart||body.enabled&&!policy){
      policy={taskId:task.id,enabled:true,status:'waiting_quota',lastError:null,wakeAt:new Date(Date.now()+60000).toISOString(),attempts:0,maxAttempts:body.maxAttempts,budgetMinutes:body.budgetMinutes,startedAt:body.restart?new Date().toISOString():startedAt,deadlineAt:body.restart?new Date(Date.now()+body.budgetMinutes*60000).toISOString():deadlineAt,remainingSeconds:body.restart?body.budgetMinutes*60:5400,stopReason:null};
    }else if(!body.enabled&&policy){policy={...policy,enabled:false,status:'disabled'};}
    else if(policy){policy={...policy,enabled:true};}
    await route.fulfill({json:plugin()});
  });
  await page.goto(`http://127.0.0.1:${server.port}`);
  await openMobilePage(page,'接入与插件');
  const panel=page.getByRole('region',{name:'按任务自动继续'});
  await panel.getByRole('heading',{name:'按任务自动继续'}).waitFor();
  assert.equal(await panel.locator('.policy-row').count(),2);
  const bound=panel.locator('.policy-row').filter({hasText:'已绑定的任务'});
  const unbound=panel.locator('.policy-row').filter({hasText:'尚未绑定的任务'});
  assert.equal(await unbound.getByRole('button',{name:'启用自动继续'}).isDisabled(),true,'unbound task cannot enable');
  await panel.getByLabel('最多尝试次数').fill('4');
  await panel.getByLabel('计划时长（分钟，含等待额度）').fill('90');
  await bound.getByRole('button',{name:'启用自动继续'}).click();
  await bound.getByText('等待额度恢复').waitFor();
  assert.deepEqual(writes[0],{taskId:task.id,enabled:true,maxAttempts:4,budgetMinutes:90},'new plan sends explicit attempts and wall-clock budget');
  await panel.getByText(/下一次检查：已绑定的任务/).waitFor();
  await bound.getByText(/计划时长：1 小时 30 分钟/).waitFor();
  await bound.getByText(/当前剩余：1 小时/).waitFor();
  await bound.getByText(/仅停止后续轮次，不会暂停正在运行的 AI/).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'390px page has no horizontal overflow');
  policy={...policy,wakeAt:null};
  await page.reload();
  await openMobilePage(page,'接入与插件');
  await page.getByText(/下一次检查：已绑定的任务 · 待下一次检查/).waitFor();
  await page.getByLabel('最多尝试次数').fill('4');
  await page.getByLabel('计划时长（分钟，含等待额度）').fill('90');
  await bound.getByRole('button',{name:'停止自动继续'}).click();
  await bound.getByText('已停用').waitFor();
  assert.equal(writes[1].enabled,false,'stop disables only future rounds');
  assert.equal(writes[1].restart,undefined,'ordinary stop never restarts the plan');
  await page.getByText(/正在运行的 AI 不会因此暂停/).first().waitFor();
  const restart=bound.getByRole('button',{name:'重新开始「已绑定的任务」计划（4 次、90 分钟）'});
  await restart.waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'task and budget restart label fits 390px');
  await bound.getByText(/只重新开始「已绑定的任务」的计划，不影响其他任务/).waitFor();
  rejectRestart=true;
  await restart.click();
  await page.getByText(/本次重新开始尚未确认，请刷新核对任务与计划，不要连续重试/).waitFor();
  await page.getByText(/Original task executor is not confirmed idle/).waitFor();
  assert.equal(policy.enabled,false,'server rejection keeps the old plan stopped');
  assert.deepEqual(pluginActions,[],'task restart never silently disables the whole plugin');
  rejectRestart=false;
  await restart.click();
  assert.deepEqual(writes[3],{taskId:task.id,enabled:true,maxAttempts:4,budgetMinutes:90,restart:true},'task-scoped restart uses the visible fresh budget');
  assert.deepEqual(pluginActions,[],'successful task restart leaves other plugin state untouched');
  await bound.getByRole('button',{name:'停止自动继续'}).click();
  await bound.getByText('已停用').waitFor();
  await page.getByRole('button',{name:'停用插件'}).click();
  await page.getByRole('button',{name:'启用插件'}).waitFor();
  await bound.getByText(/只重新开始「已绑定的任务」的计划；插件仍停用/).waitFor();
  await restart.click();
  assert.equal(writes[5].restart,true,'explicit restart while plugin disabled only saves the plan');
  assert.equal(writes[5].budgetMinutes,90);
  assert.notEqual(policy.deadlineAt,deadlineAt,'explicit restart receives a new deadline from the server snapshot');
  await page.getByText(/计划已保存。插件仍停用/).waitFor();
  assert.equal(pluginEnabled,false,'restart saves the policy while the plugin remains disabled');
  await page.getByRole('button',{name:'启用插件'}).click();
  assert.deepEqual(pluginActions,['disable','enable'],'recovery explicitly disables, restarts, then enables');
  policy={...policy,enabled:false,status:'unknown',lastError:'provider status uncertain',stopReason:'attempt_unconfirmed'};
  await page.reload();
  await openMobilePage(page,'接入与插件');
  const unknown=page.locator('.policy-row').filter({hasText:'已绑定的任务'});
  await unknown.getByText('结果待核实').waitFor();
  assert.equal(await unknown.getByRole('button',{name:/重新开始「已绑定的任务」计划/}).count(),0,'unknown cannot offer restart');
  assert.equal(await unknown.getByRole('button',{name:'继续原计划'}).isDisabled(),true,'unknown cannot re-enable');
  await unknown.getByRole('button',{name:'核实会话状态'}).waitFor();
  for(const [status,reason,label] of [['retry_stopped','retry_failed','自动重试已停止'],['budget_exhausted','budget_expired','时间预算已用尽'],['attempts_exhausted','attempt_limit','尝试次数已用尽'],['retry_stopped','restart_binding_changed','任务或执行位置已变化，请核对后重新开始计划']]){
    policy={...policy,enabled:false,status,stopReason:reason,lastError:'provider detail'};
    await page.reload();
    await openMobilePage(page,'接入与插件');
    const stopped=page.locator('.policy-row').filter({hasText:'已绑定的任务'});
    await stopped.getByText(label).waitFor();
    await stopped.getByRole('button',{name:/重新开始「已绑定的任务」计划/}).waitFor();
    assert.equal(await stopped.getByRole('button',{name:'继续原计划'}).count(),0,'terminal stop cannot be silently re-enabled');
    assert.equal(await stopped.getByText('provider detail').isVisible(),false,'raw provider error stays collapsed');
    await stopped.getByText('查看技术原因').click();
    await stopped.getByText('provider detail').waitFor();
  }
  policy={...policy,enabled:false,status:'disabled',deadlineAt:null,stopReason:'legacy_plan_missing_deadline'};
  await page.reload();
  await openMobilePage(page,'接入与插件');
  const legacy=page.locator('.policy-row').filter({hasText:'已绑定的任务'});
  await legacy.getByText(/旧计划缺少截止时间/).waitFor();
  assert.equal(await legacy.getByRole('button',{name:'继续原计划'}).count(),0,'missing deadline needs explicit restart');
  await legacy.getByRole('button',{name:/重新开始「已绑定的任务」计划/}).waitFor();
  policy={...policy,deadlineAt:new Date(Date.now()+60000).toISOString(),stopReason:'retry_failed'};
  await page.reload();
  await openMobilePage(page,'接入与插件');
  const stoppedWithDeadline=page.locator('.policy-row').filter({hasText:'已绑定的任务'});
  assert.equal(await stoppedWithDeadline.getByRole('button',{name:'继续原计划'}).count(),0,'stopReason fences re-enable even with a future deadline');
  await stoppedWithDeadline.getByRole('button',{name:/重新开始「已绑定的任务」计划/}).waitFor();
  for(const status of ['sending','awaiting_approval']){
    policy={...policy,status};
    await page.reload();
    await openMobilePage(page,'接入与插件');
    const unsafe=page.locator('.policy-row').filter({hasText:'已绑定的任务'});
    assert.equal(await unsafe.getByRole('button',{name:/重新开始「已绑定的任务」计划/}).count(),0,`${status} cannot restart`);
    assert.equal(await unsafe.getByRole('button',{name:'继续原计划'}).isDisabled(),true,`${status} cannot resume original plan`);
  }
  policy=null;
  for(const status of ['paused','running','submitted','cancelled']){
    taskState=status;
    await page.reload();
    await openMobilePage(page,'接入与插件');
    const row=page.locator('.policy-row').filter({hasText:'已绑定的任务'});
    if(status==='cancelled')assert.equal(await row.count(),0,'cancelled task is excluded');
    else assert.equal(await row.getByRole('button',{name:'启用自动继续'}).isDisabled(),true,`${status} task cannot enable`);
  }
  taskState='planned';
  inboxCard={id:'policy-stop-card',projectId:project.id,taskId:task.id,kind:'blocked',state:'open',itemRevision:1,sourceRevision:task.revision,contentVersion:task.contentVersion,source:{type:'plugin.autocontinue',id:task.id},dedupKey:'policy-stop',priority:90,title:'自动继续已停止',summary:'需要核对计划。',impact:'后续轮次不会自动开始。',recommendedAction:'在电脑上核对自动继续计划。',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),resolvedAt:null,resolution:null,shareWithRemote:true,readOnly:true};
  await page.reload();
  const localCard=page.locator('.inbox-card').filter({has:page.getByRole('heading',{name:'自动继续已停止'})});
  await localCard.getByRole('button',{name:'查看自动继续计划'}).click();
  await panel.getByRole('heading',{name:'按任务自动继续'}).waitFor();
  const hubPage=await browser.newPage({viewport:{width:390,height:844}});
  await hubPage.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),server.tokens.owner);
  const hubBase=snapshot(await core.state());
  await hubPage.route('**/api/state',route=>route.fulfill({json:{...hubBase,connection:{...hubBase.connection,mode:'hub'},capabilities:{...hubBase.capabilities,remote:true,role:'controller'},projects:hubBase.projects.map(item=>({...item,inboxAvailable:true}))}}));
  await hubPage.goto(`http://127.0.0.1:${server.port}`);
  const remoteCard=hubPage.locator('.inbox-card').filter({has:hubPage.getByRole('heading',{name:'自动继续已停止'})});
  await remoteCard.getByRole('heading',{name:'自动继续已停止'}).waitFor();
  assert.equal(await remoteCard.getByRole('button',{name:'查看自动继续计划'}).count(),0,'Hub card has no unusable plugin management button');
  await hubPage.close();
  assert.deepEqual(errors,[]);
  console.log('auto-continue policy UI mock: budget request, task-only restart/error, disabled plugin save, unknown fence, three stop reasons, 390px passed');
}finally{
  await browser?.close();
  await server?.close();
  await core?.close();
  await rm(dir,{recursive:true,force:true});
}
