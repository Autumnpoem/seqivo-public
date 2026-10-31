import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {chromium, webkit} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const temporary = await mkdtemp(join(tmpdir(), 'seqivo-verification-ui-'));
const engine = process.env.TEST_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const output = resolve(process.env.QA_DIR || `design/qa/release-readiness/verification-${engine}`);
await mkdir(output, {recursive:true});
let core, web, browser;
try {
  core = await createCore({dataDir:join(temporary, 'data'), pluginDir:join(temporary, 'no-plugins'), files:false});
  const project = core.store.project({name:'测试验证状态', goal:'区分真实测试结果、覆盖范围和人工验收。'});
  for (const status of ['passed','partial','failed','unverified','stale']) {
    let task = core.store.createTask({projectId:project.id,title:`验证场景 ${status}`,goal:'测试两个标准',criteria:['能保存数据','能恢复数据']});
    task = core.store.updateTask(task.id,{status:'submitted'},task.revision);
    if (status !== 'unverified') task = await core.request('POST',`/api/tasks/${task.id}/verify`,{
      expectedRevision:task.revision,status:status==='stale'?'partial':status,summary:'独立测试记录，保留验收权。',reference:'tests/e2e/verification.mjs',
      criterionIds:status==='partial'||status==='stale'?[task.criteria[0].id]:status==='failed'?[]:task.criteria.map(c=>c.id),
      ...(['partial','stale'].includes(status)?{pendingChecks:[
        {id:'api-regression',kind:'test',title:'复核保存与恢复流程',criterionIds:[task.criteria[1].id],steps:['执行保存操作','重新打开记录并核对内容'],expectedResult:'记录内容完整恢复',blockedReason:''},
        {id:'error-handling',kind:'implementation',title:'补齐失败时的错误提示',criterionIds:[task.criteria[1].id],steps:['实现错误提示后触发保存失败'],expectedResult:'显示可理解的错误信息',blockedReason:'需要可复现的保存失败条件'},
        {id:'deferred-tools',kind:'decision',title:'Claude / Cursor 延后复核',criterionIds:[task.criteria[1].id],steps:['待条件提供后分别复核'],expectedResult:'记录两种工具的复核结论',blockedReason:'需提供 Claude 与 Cursor 的可用会话'},
      ]}:{}),
    });
    if (status === 'stale') task = core.store.updateTask(task.id,{criteria:['保存符合新格式','按新规则恢复数据']},task.revision);
    assert.equal(task.acceptance,'unverified');
    assert.ok(task.criteria.every(c=>!c.passed));
  }
  let legacyPartial = core.store.createTask({projectId:project.id,title:'旧版部分验证无待办',goal:'存在覆盖记录但未整理后续计划',criteria:['标准甲','标准乙']});
  legacyPartial = core.store.updateTask(legacyPartial.id,{status:'submitted'},legacyPartial.revision);
  legacyPartial = await core.request('POST',`/api/tasks/${legacyPartial.id}/verify`,{
    expectedRevision:legacyPartial.revision,status:'partial',summary:'旧记录覆盖了标准，但没有后续步骤。',reference:'旧版验证记录',criterionIds:legacyPartial.criteria.map(c=>c.id),
  });
  assert.deepEqual(legacyPartial.verification.pendingChecks,[]);
  let staleSameIds = core.store.createTask({projectId:project.id,title:'旧计划关联 ID 未变',goal:'原目标',criteria:['保留的标准甲','仍适用的标准乙']});
  staleSameIds = core.store.updateTask(staleSameIds.id,{status:'submitted'},staleSameIds.revision);
  staleSameIds = await core.request('POST',`/api/tasks/${staleSameIds.id}/verify`,{
    expectedRevision:staleSameIds.revision,status:'partial',summary:'目标更改后关联标准 ID 暂未改变。',reference:'版本变化测试',criterionIds:[staleSameIds.criteria[0].id],
    pendingChecks:[{id:'old-plan-same-ids',kind:'test',title:'复用旧版本步骤',criterionIds:[staleSameIds.criteria[1].id],steps:['按旧目标执行'],expectedResult:'满足旧目标',blockedReason:''}],
  });
  const staleCriterionIds=staleSameIds.criteria.map(c=>c.id);
  staleSameIds = core.store.updateTask(staleSameIds.id,{goal:'已变更的新目标'},staleSameIds.revision);
  assert.deepEqual(staleSameIds.criteria.map(c=>c.id),staleCriterionIds);
  let planOnly = core.store.createTask({projectId:project.id,title:'仅有验证计划',goal:'尚未执行验证',criteria:['能按计划复核记录']});
  planOnly = await core.request('POST',`/api/tasks/${planOnly.id}/verify`,{
    expectedRevision:planOnly.revision,status:'unverified',summary:'这条计划尚未执行。',reference:'验证计划',criterionIds:[],
    pendingChecks:[{id:'plan-only',kind:'test',title:'补充验证步骤',criterionIds:[planOnly.criteria[0].id],steps:['按计划执行保存后重新读取'],expectedResult:'记录包含预期字段',blockedReason:'尚需提供可用测试环境'}],
  });
  assert.equal(planOnly.verification.status,'unverified');
  assert.deepEqual(planOnly.verification.criterionIds,[]);
  let toggleTask = core.store.createTask({projectId:project.id,title:'可切换的验证待办',goal:'验证待办仅记录人工进度',criteria:['任务状态保持待验收']});
  toggleTask = core.store.updateTask(toggleTask.id,{status:'submitted'},toggleTask.revision);
  toggleTask = await core.request('POST',`/api/tasks/${toggleTask.id}/verify`,{
    expectedRevision:toggleTask.revision,status:'partial',summary:'只记录部分验证，不代表人工验收。',reference:'验证待办切换检查',criterionIds:[],
    pendingChecks:[{id:'toggle-check',kind:'test',title:'复核待办切换行为',criterionIds:[toggleTask.criteria[0].id],steps:['点击空心圆','刷新后确认状态'],expectedResult:'状态持久化且不影响验收',blockedReason:''}],
  });
  const untouchedTask = core.store.createTask({projectId:project.id,title:'未触碰的验证待办',goal:'作为隔离检查',criteria:['保持待开始']});
  const originalToggleStatus = {status:toggleTask.status,acceptance:toggleTask.acceptance,verificationStatus:toggleTask.verification.status,createdAt:toggleTask.verification.createdAt,criterionIds:[...toggleTask.verification.criterionIds]};
  web = await startHttp({core, dataDir:join(temporary,'data'),distDir:resolve('dist'),port:0});
  browser = await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page = await browser.newPage({viewport:{width:1280,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
  await page.goto(`http://127.0.0.1:${web.port}`);
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('heading',{name:project.name,exact:true}).waitFor();
  const filter=page.getByLabel('测试状态',{exact:true});
  for(const status of ['passed','partial','failed','unverified','stale']) {
    await filter.selectOption(status);
    const row=page.locator('.task-row');
    const targetRow=row.filter({hasText:`验证场景 ${status}`});
    await targetRow.waitFor();
    assert.equal(await row.count(),status==='partial'||status==='unverified'?3:status==='stale'?2:1);
    await targetRow.click();
    const detail=page.getByRole('region',{name:'测试验证',exact:true});
    await detail.waitFor();
    assert.equal(await detail.locator(`[data-verification="${status}"]`).count(),1);
    if(status!=='unverified') {
      await detail.getByText('查看验证范围与证据',{exact:true}).click();
      await detail.getByText('tests/e2e/verification.mjs',{exact:true}).waitFor();
      const expected={passed:2,partial:1,failed:0,stale:0}[status];
      await detail.getByText(`已验证 ${expected} / 2 项标准`,{exact:true}).waitFor();
    }
    if(status==='partial') {
      await detail.getByRole('heading',{name:'验证待办 · 已办结 0 / 3 项'}).waitFor();
      await detail.getByText('复核保存与恢复流程',{exact:true}).waitFor();
      const deferred=detail.locator('.verification-todo').filter({hasText:'Claude / Cursor 延后复核'});
      await deferred.locator('summary').click();
      await deferred.locator('.verification-blocker').filter({hasText:'需提供 Claude 与 Cursor 的可用会话'}).waitFor();
      await detail.getByText('补齐失败时的错误提示',{exact:true}).waitFor();
    }
    if(status==='stale') {
      await detail.getByRole('heading',{name:/验证待办/}).waitFor();
      await detail.getByText('旧版本计划',{exact:false}).first().waitFor();
      const currentPlan=detail.locator('.verification-plan-gap').filter({hasText:'保存符合新格式'});
      await currentPlan.locator('summary').click();
      await currentPlan.getByText('当前版本的标准；旧版本结果不能覆盖此项。',{exact:true}).waitFor();
      await detail.getByText('待补充验证计划：保存符合新格式',{exact:true}).waitFor();
      assert.equal(await detail.locator('.verification-todo-criteria').count(),0,'stale plans must not claim that changed criteria are current coverage');
    }
  }
  await filter.selectOption('unverified');
  await page.locator('.task-row').filter({hasText:'仅有验证计划'}).click();
  const planDetail=page.getByRole('region',{name:'测试验证',exact:true});
  await planDetail.getByText('验证计划已记录，尚未执行。',{exact:false}).waitFor();
  await planDetail.getByText('补充验证步骤',{exact:true}).waitFor();
  await planDetail.getByText('按计划执行保存后重新读取',{exact:true}).waitFor();
  await planDetail.getByText('记录包含预期字段',{exact:true}).waitFor();
  await filter.selectOption('unverified');
  await page.locator('.task-row').filter({hasText:'验证场景 unverified'}).click();
  const legacyDetail=page.getByRole('region',{name:'测试验证',exact:true});
  await legacyDetail.getByRole('heading',{name:'验证待办 · 已办结 0 / 2 项'}).waitFor();
  await legacyDetail.getByText('待补充验证计划：能保存数据',{exact:true}).waitFor();
  await filter.selectOption('partial');
  await page.locator('.task-row').filter({hasText:'旧版部分验证无待办'}).click();
  const legacyPartialDetail=page.getByRole('region',{name:'测试验证',exact:true});
  await legacyPartialDetail.getByRole('heading',{name:'验证待办 · 已办结 0 / 1 项'}).waitFor();
  await legacyPartialDetail.getByText('待补充后续验证计划',{exact:true}).waitFor();
  await legacyPartialDetail.getByText('后续步骤尚未记录，请补充计划后再继续。',{exact:false}).waitFor();
  await filter.selectOption('stale');
  await page.locator('.task-row').filter({hasText:'旧计划关联 ID 未变'}).click();
  const sameIdsDetail=page.getByRole('region',{name:'测试验证',exact:true});
  const changedRequirement=sameIdsDetail.locator('.verification-plan-gap').filter({hasText:'保留的标准甲'});
  await changedRequirement.locator('summary').click();
  await changedRequirement.getByText('当前版本的标准；旧版本结果不能覆盖此项。',{exact:true}).waitFor();
  assert.equal(await sameIdsDetail.locator('.verification-todo-criteria').count(),0,'stale checks sharing criterion IDs must not be shown as current methods');
  assert.equal(await sameIdsDetail.locator('.verification-check-toggle').count(),0,'stale plans must remain read-only');
  await filter.selectOption('partial');
  await page.locator('.task-row').filter({hasText:'可切换的验证待办'}).click();
  const toggleDetail=page.getByRole('region',{name:'测试验证',exact:true});
  const toggleCard=toggleDetail.locator('.verification-todo-row').filter({hasText:'复核待办切换行为'});
  const toggleButton=toggleDetail.getByRole('button',{name:'标记为已办结：复核待办切换行为'});
  await toggleButton.waitFor();
  assert.equal(await toggleCard.locator('details').getAttribute('open'),'');
  await toggleButton.click();
  const reopenButton=toggleDetail.getByRole('button',{name:'重新打开：复核待办切换行为'});
  await reopenButton.waitFor();
  await toggleDetail.getByRole('heading',{name:'验证待办 · 已办结 1 / 1 项'}).waitFor();
  assert.equal(await toggleCard.locator('details').getAttribute('open'),'','toggling the circle must not collapse plan details');
  assert.equal(await toggleDetail.locator('[data-verification="partial"]').count(),1);
  assert.equal(await page.locator('.detail-heading .pill').innerText(),'待验收');
  await reopenButton.click();
  const emptyButton=toggleDetail.getByRole('button',{name:'标记为已办结：复核待办切换行为'});
  await emptyButton.waitFor();
  await emptyButton.focus();
  await page.keyboard.press('Space');
  await toggleDetail.getByRole('button',{name:'重新打开：复核待办切换行为'}).waitFor();
  await page.reload();await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('heading',{name:project.name,exact:true}).waitFor();
  await page.getByLabel('测试状态',{exact:true}).selectOption('partial');
  await page.locator('.task-row').filter({hasText:'可切换的验证待办'}).click();
  const persistedDetail=page.getByRole('region',{name:'测试验证',exact:true});
  await persistedDetail.getByRole('button',{name:'重新打开：复核待办切换行为'}).waitFor();
  const failedPath=`/api/tasks/${toggleTask.id}/verification-checks/toggle-check`;
  await page.evaluate(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.viewer);
  const deniedResponsePromise=page.waitForResponse(response=>response.url().endsWith(failedPath)&&response.status()===403,{timeout:5000});
  await persistedDetail.getByRole('button',{name:'重新打开：复核待办切换行为'}).click();
  const deniedResponse=await deniedResponsePromise;
  const deniedBody=await deniedResponse.json();
  await page.getByRole('alert').filter({hasText:deniedBody.error}).waitFor({timeout:5000});
  await persistedDetail.getByRole('button',{name:'重新打开：复核待办切换行为'}).waitFor();
  assert.equal(core.store.getTask(toggleTask.id).verification.pendingChecks[0].completed,true,'a failed request must not update persisted state');
  await page.evaluate(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
  await persistedDetail.getByRole('button',{name:'重新打开：复核待办切换行为'}).click();
  await persistedDetail.getByRole('button',{name:'标记为已办结：复核待办切换行为'}).waitFor();
  const finalToggleTask=core.store.getTask(toggleTask.id);
  const finalUntouchedTask=core.store.getTask(untouchedTask.id);
  assert.equal(finalToggleTask.verification.pendingChecks[0].completed,false);
  assert.deepEqual({status:finalToggleTask.status,acceptance:finalToggleTask.acceptance,verificationStatus:finalToggleTask.verification.status,createdAt:finalToggleTask.verification.createdAt,criterionIds:finalToggleTask.verification.criterionIds},originalToggleStatus,'manual checklist changes must not affect parent verification or acceptance');
  assert.equal(finalUntouchedTask.status,'planned');
  assert.equal(finalUntouchedTask.acceptance,'unverified');
  await filter.selectOption('passed');
  await page.locator('.task-row').click();
  await page.getByRole('button',{name:'编辑任务',exact:true}).click();
  await page.getByLabel('当前进展',{exact:true}).fill('用户修改后，原测试应自动失效');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByText('当前筛选条件下暂无任务。',{exact:true}).waitFor();
  await filter.selectOption('stale');
  await page.locator('.task-row').filter({hasText:'验证场景 passed'}).click();
  await page.getByRole('region',{name:'测试验证',exact:true}).getByText('需重新验证',{exact:true}).waitFor();
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuenow'),'0');
  for(const theme of ['浅色','深色']) {
    await page.getByRole('button',{name:theme,exact:true}).click();
    await page.screenshot({path:join(output,`${theme==='浅色'?'light':'dark'}.png`),fullPage:true,animations:'disabled'});
  }
  for(const width of [320,390,760,1024]) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);
    if(width===390)await page.screenshot({path:join(output,'mobile.png'),fullPage:true,animations:'disabled'});
  }
  assert.deepEqual(errors,[]);
  const summary={passed:true,engine,physicalDevice:false,actualAI:false,checks:['5 verification statuses and filters','structured partial plans and deferred Claude/Cursor conditions','plan-only unverified records and honest legacy fallback','legacy partial records with full coverage receive an honest follow-up-plan placeholder','stored verification checks toggle by click and Space and can be reopened','toggle leaves details expanded and persists across reload','failed save keeps completed state unchanged','stale plans stay read-only','other task, parent verification status, timestamp, coverage and acceptance stay unchanged','stale plans clearly separated from current criteria when IDs change or persist','criterion coverage and evidence','UI edit invalidates prior verification','human acceptance remains untouched','light/dark and 320–1024px overflow','no browser errors']};
  await writeFile(join(output,'summary.json'),JSON.stringify(summary,null,2));
  console.log(JSON.stringify(summary));
} finally {await browser?.close();await web?.close();await core?.close();await rm(temporary,{recursive:true,force:true});}
