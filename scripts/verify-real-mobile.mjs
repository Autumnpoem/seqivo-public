// Opt-in live acceptance: two tiny Codex turns in a newly-created disposable project.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium} from '@playwright/test';
import {createCore} from '../server/core.mjs';
import {createHub} from '../server/hub/http.mjs';

if(process.env.SEQIVO_REAL_MOBILE_TEST!=='1')throw Error('Set SEQIVO_REAL_MOBILE_TEST=1 to authorize two isolated real Codex turns');
const codexPath=process.env.SEQIVO_TEST_CODEX,pythonPath=process.env.SEQIVO_TEST_PYTHON;
if(!codexPath||!pythonPath)throw Error('Provide local Codex/Python executable paths; no credentials are accepted');
const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-live-mobile-')));
const qa=resolve(process.env.QA_DIR||'design/qa/account-conversations/real-codex');await mkdir(qa,{recursive:true});
const evidence={startedAt:new Date().toISOString(),test:'mobile browser -> Hub -> desktop Core -> real Codex edits scratch file -> phone output',realAI:true,physicalPhone:false,checks:[],passed:false};
let core,hub,browser,page;
async function until(fn,label,ms=120000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,1000));}throw Error(label);}
try{
  await writeFile(join(root,'demo.js'),'module.exports = 1;\n');
  core=await createCore({dataDir:join(root,'state'),pluginDir:resolve('plugins'),files:false});
  await core.plugin.configure({codexPath,pythonPath});
  const project=core.store.project({name:'手机真实 Codex 验收',directory:root});
  hub=await createHub({dataDir:join(root,'hub'),distDir:resolve('dist')});
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:390,height:844}});page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(hub.url);await page.getByRole('button',{name:'注册',exact:true}).click();
  const password=randomBytes(24).toString('base64url');
  await page.getByLabel('用户名',{exact:true}).fill('live_mobile_test');await page.getByLabel('密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'创建账号',exact:true}).click();await page.getByRole('button',{name:'对话',exact:true}).waitFor();
  await core.request('POST','/api/remote/login',{url:hub.url,username:'live_mobile_test',password,projectIds:[project.id]});
  await page.getByRole('combobox',{name:'选择项目'}).locator('option').filter({hasText:project.name}).waitFor({state:'attached',timeout:15000});await page.getByRole('button',{name:'对话',exact:true}).click();
  await page.getByLabel('对话标题',{exact:true}).fill('验证手机修改隔离文件');
  await page.getByLabel('告诉 Codex 要做什么',{exact:true}).fill('这是隔离验收：仅将当前项目 demo.js 的内容改成 module.exports = 2;，不要修改其他文件，不要联网，不要委派 Agent。完成后只回复 SEQIVO_MOBILE_EDIT_2。');
  await page.getByRole('button',{name:'创建并开始',exact:true}).click();
  try {
    await until(async()=>{const task=core.store.tasks(project.id)[0];if(task&&['blocked','failed'].includes(task.status))throw Error('Live turn blocked/failed; approval or provider setup needs attention');return task?.status==='submitted';},'First live turn did not complete',240000);
  } catch (error) {
    const task=core.store.tasks(project.id)[0];
    evidence.diagnostics={taskStatus:task?.status,blockedReason:task?.blockedReason||null,fileChangedTo2:/module\.exports\s*=\s*2\s*;/.test(await readFile(join(root,'demo.js'),'utf8'))};
    await core.plugin.check().catch(()=>{});
    evidence.diagnostics.afterCheckStatus=task?core.store.getTask(task.id).status:null;
    evidence.diagnostics.executions=(await core.request('GET','/api/executions')).active.map(({status,actualModel})=>({status,actualModel}));
    if(evidence.diagnostics.afterCheckStatus!=='submitted')throw error;
  }
  let task=core.store.tasks(project.id)[0];assert.match(await readFile(join(root,'demo.js'),'utf8'),/module\.exports\s*=\s*2\s*;/);assert.notEqual(task.acceptance,'passed');
  await page.getByText('SEQIVO_MOBILE_EDIT_2',{exact:true}).waitFor({timeout:30000});
  evidence.checks.push('phone created actual task/session and real Codex changed only test file to 2; output returned; acceptance remains unverified');
  await page.getByLabel('继续说明需求',{exact:true}).fill('继续隔离验收：仅将 demo.js 中导出的值改为 3，不改其他文件、不联网、不委派 Agent。完成后只回复 SEQIVO_MOBILE_EDIT_3。');
  await page.getByRole('button',{name:'发送消息',exact:true}).click();
  await until(async()=>/module\.exports\s*=\s*3\s*;/.test(await readFile(join(root,'demo.js'),'utf8')),'Followup did not edit test file');
  await until(()=>core.store.getTask(task.id).status==='submitted','Followup not completed');
  await page.getByText('SEQIVO_MOBILE_EDIT_3',{exact:true}).waitFor({timeout:30000});
  task=core.store.getTask(task.id);assert.notEqual(task.acceptance,'passed');assert.equal(core.store.tasks(project.id).length,1);
  evidence.checks.push('phone followup resumed same session and edited file to 3 without duplicate task');
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:join(qa,'phone-real-output.png'),fullPage:true});
  evidence.passed=true;
}catch(error){evidence.error=error.message;process.exitCode=1;await page?.screenshot({path:join(qa,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
  await browser?.close();try{await core?.close();evidence.cleanShutdown=true;}catch(error){evidence.cleanShutdown=false;evidence.shutdownError=error.message;process.exitCode=1;}
  await hub?.close();await rm(root,{recursive:true,force:true});evidence.finishedAt=new Date().toISOString();
  await writeFile(join(qa,'results.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}
