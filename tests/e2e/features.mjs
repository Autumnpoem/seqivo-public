import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,webkit} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const directory=await mkdtemp(join(tmpdir(),'tuijin-features-'));
const engine=process.env.TEST_BROWSER==='webkit'?'webkit':'chromium';
const qa=resolve(process.env.QA_DIR||'design/qa/v0.2/webkit');
const capture=engine==='webkit'||Boolean(process.env.QA_DIR);
async function openMobilePage(page,name){await page.getByRole('button',{name:/^更多页面/}).click();await page.getByRole('menuitem',{name,exact:true}).click();}
const dataDir=join(directory,'data');
const workflowCalls=[];
let startOutcome='running';
let inspectOutcome='running';
const workflowExecutors=new Map([['codex-autocontinue',{
  start:async input=>{workflowCalls.push({kind:'start',...input});return {status:startOutcome}},
  pause:async input=>{workflowCalls.push({kind:'pause',...input});return {status:'paused'}},
  inspect:async input=>{workflowCalls.push({kind:'inspect',...input});return {status:inspectOutcome}},
}]]);
let core;
let web;
let browser;
try{
  core=await createCore({dataDir,pluginDir:resolve('plugins'),workflowExecutors});
  web=await startHttp({core,dataDir,distDir:resolve('dist'),port:0});
  browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'&&process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const page=await browser.newPage({viewport:{width:390,height:844},acceptDownloads:true});
  const pageErrors=[];
  page.on('pageerror',error=>pageErrors.push(error.message));
  await page.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),web.tokens.owner);
  await page.goto(`http://127.0.0.1:${web.port}`);
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('heading',{name:'从一个真实项目开始'}).waitFor();
  await page.getByRole('button',{name:'新建项目',exact:true}).click();
  await page.getByLabel('项目名称',{exact:true}).fill('会话与备份验证');
  await page.getByLabel('项目目标',{exact:true}).fill('验证新功能走真实 HTTP 和 SQLite。');
  await page.getByLabel('项目目录',{exact:true}).fill(directory);
  await page.getByRole('button',{name:'保存',exact:true}).click();

  await page.getByRole('button',{name:'新建任务',exact:true}).click();
  await page.getByLabel('任务名称',{exact:true}).fill('来自原会话');
  await page.getByLabel('期望结果',{exact:true}).fill('按真实记录筛选任务。');
  await page.getByLabel('验收标准（每行一条）',{exact:true}).fill('来源正确');
  await page.getByText('来源会话（可选）').click();
  await page.getByLabel('来源工具',{exact:true}).fill('Codex');
  await page.getByLabel('来源会话 ID',{exact:true}).fill('source-1');
  await page.getByLabel('Codex 会话 ID',{exact:true}).fill('control-1');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  await page.getByRole('button',{name:'编辑任务'}).click();
  assert.equal(await page.getByLabel('执行工具').isDisabled(),true);
  await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByRole('button',{name:'返回清单'}).click();

  await page.getByRole('button',{name:'新建任务',exact:true}).click();
  await page.getByLabel('任务名称',{exact:true}).fill('尚未绑定');
  await page.getByLabel('期望结果',{exact:true}).fill('等待绑定会话。');
  await page.getByLabel('验收标准（每行一条）',{exact:true}).fill('可见未绑定任务');
  await page.getByLabel('执行工具').selectOption('claude-code');
  await page.getByRole('button',{name:'保存',exact:true}).click();
  assert.equal(core.store.tasks().find(task=>task.title==='尚未绑定').executionProvider,'claude-code');
  await page.getByRole('button',{name:'返回清单'}).click();
  const filter=page.getByLabel('会话范围');
  await filter.selectOption('unbound');
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuemax'),'1');
  await page.getByText('尚未绑定',{exact:true}).first().waitFor();
  const sourceOption=await filter.locator('option').filter({hasText:'来源 · Codex / source-1'}).getAttribute('value');
  assert.ok(sourceOption);
  await filter.selectOption(sourceOption);
  assert.equal(await page.getByRole('progressbar').getAttribute('aria-valuemax'),'1');
  await page.getByText('来自原会话',{exact:true}).first().waitFor();
  await filter.selectOption('all');

  await openMobilePage(page,'接入与插件');
  const claude=page.locator('.generic-plugins article').filter({has:page.getByRole('heading',{name:'Claude Code',exact:true})});
  await claude.locator('summary').click();
  await claude.getByLabel('单次预算美元（可选）').fill('2.5');
  await claude.getByRole('button',{name:'保存插件设置'}).click();
  await page.getByText('插件设置已保存。').waitFor();
  const plugins=await core.request('GET','/api/plugins');
  assert.equal(plugins.find(plugin=>plugin.id==='claude-code').config.maxBudgetUsd,2.5);

  await openMobilePage(page,'协作计划');
  const candidate=page.locator('.workflow-candidate').filter({hasText:'来自原会话'});
  await candidate.locator('input[type=checkbox]').first().check();
  await candidate.getByLabel('来自原会话 请求模型').fill('fake-requested-model');
  await page.getByRole('button',{name:'保存草稿'}).click();
  await page.getByText('协作计划草稿已保存。').waitFor();
  assert.equal(workflowCalls.filter(call=>call.kind==='start').length,0);
  assert.equal(core.workflow.state().plans[0].status,'draft');
  await page.getByRole('button',{name:'明确启动'}).click();
  await page.getByText('启动请求已提交').waitFor();
  assert.equal(workflowCalls.filter(call=>call.kind==='start').length,1);
  assert.equal(workflowCalls.find(call=>call.kind==='start').model,'fake-requested-model');
  assert.equal(core.workflow.state().plans[0].members[0].status,'running');
  await page.getByRole('button',{name:'暂停计划'}).click();
  await page.getByText('暂停请求已提交').waitFor();
  assert.equal(core.workflow.state().plans[0].status,'paused');

  startOutcome='unknown';inspectOutcome='unknown';
  await candidate.locator('input[type=checkbox]').first().check();
  await page.getByRole('button',{name:'保存草稿'}).click();
  await page.getByText('协作计划草稿已保存。').waitFor();
  const newestPlan=page.locator('.workflow-plan').first();
  await newestPlan.getByRole('button',{name:'明确启动'}).click();
  await newestPlan.getByRole('button',{name:'核对执行状态'}).click();
  await page.getByRole('alert').filter({hasText:'执行器尚未确认'}).waitFor();
  assert.equal(core.workflow.state().plans.at(-1).members[0].status,'unknown');
  inspectOutcome='paused';
  await newestPlan.getByRole('button',{name:'核对执行状态'}).click();
  await page.getByText('已根据执行工具的可核实状态更新记录。').waitFor();
  assert.equal(core.workflow.state().plans.at(-1).members[0].status,'paused');
  await newestPlan.getByRole('button',{name:'暂停计划'}).click();
  await page.getByText('暂停请求已提交').waitFor();
  assert.equal(workflowCalls.filter(call=>call.kind==='start').length,2);
  if(capture){
    await mkdir(qa,{recursive:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'workflow mobile overflow');
    await page.screenshot({path:join(qa,'workflow-mobile.png'),fullPage:true,animations:'disabled'});
  }

  await openMobilePage(page,'记录备份');
  await page.getByRole('button',{name:'查看历史'}).click();
  await page.getByRole('dialog',{name:'历史记录'}).getByText('创建任务').first().waitFor();
  await page.getByRole('button',{name:'关闭历史记录'}).click();
  const downloadPromise=page.waitForEvent('download');
  await page.getByRole('button',{name:'下载备份'}).click();
  const download=await downloadPromise;
  const archivePath=await download.path();
  assert.ok(archivePath);
  await page.getByLabel('备份文件').setInputFiles(archivePath);
  await page.getByLabel('输入“恢复”以确认替换当前记录').fill('恢复');
  await page.getByRole('button',{name:'确认恢复'}).click();
  await page.getByText('备份已恢复。请重新绑定项目目录').waitFor();
  assert.equal(core.store.projects()[0].directory,null);
  assert.equal(core.store.tasks().find(task=>task.title==='来自原会话').conversationId,'');
  assert.ok(core.workflow.state().plans.every(plan=>plan.status==='restored'));
  await page.getByLabel('会话与备份验证 的目录').fill(directory);
  await page.getByRole('button',{name:'绑定目录'}).click();
  await page.getByText('项目目录已绑定。').waitFor();
  assert.equal(core.store.projects()[0].directory,await realpath(directory));
  for(const width of [320,390,760,1024]){
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);
    if(capture&&width===1024)await page.screenshot({path:join(qa,'local-desktop.png'),fullPage:true,animations:'disabled'});
  }
  // An isolated plugin can fail while the task service remains healthy.
  await page.route('**/api/state',async route=>{
    const response=await route.fetch();const data=await response.json();
    await route.fulfill({response,json:{...data,plugin:{id:'codex-autocontinue',name:'Codex Auto Continue',version:'test',enabled:false,available:false,status:'unavailable',lastError:'Plugin state timed out'}}});
  });
  await page.reload();await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('heading',{name:'会话与备份验证',exact:true}).waitFor();
  assert.equal(await page.getByText('连接已中断，当前显示上次同步的内容',{exact:false}).count(),0);
  assert.equal(await page.locator('.alert.banner').count(),0);
  await page.getByRole('navigation',{name:'主要导航'}).getByText('更多功能').click();await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'接入与插件',exact:true}).click();
  await page.getByRole('heading',{name:'按任务自动继续',exact:true}).waitFor();
  assert.equal(await page.locator('.policy-row').count(),1);
  assert.deepEqual(pageErrors,[]);
  if(capture)await writeFile(join(qa,'features-summary.json'),JSON.stringify({result:'passed',engine,headless:true,physicalDevice:false,actualAI:false,checks:['local Core HTTP and SQLite task UI','source conversation filtering','fake workflow draft, start, pause and provider inspection','history, backup restore and directory rebind','unavailable plugin preserves board and plugin panel','no horizontal overflow at 320, 390, 760 and 1024 pixels','no browser page errors']},null,2));
  console.log(`PASS [${engine}]: filtering, provider/config, fake-executor workflow draft/start/pause/inspect, history/restore/rebind, 320–1024px, unavailable plugin does not break board; no AI turns`);
}finally{
  await browser?.close();
  await web?.close();
  await core?.close();
  await rm(directory,{recursive:true,force:true});
}
