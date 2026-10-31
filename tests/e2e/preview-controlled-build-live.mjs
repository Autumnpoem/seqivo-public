/** Real local-owner UI → controlled Core build → Hub iframe → one feedback task.
 * Run from a source tree with the fixed preview-toolchain stage installed:
 * SEQIVO_TEST_PYTHON=/absolute/managed-wrapper \
 * SEQIVO_TEST_DIST_DIR=/absolute/built-web CHROME_PATH=/absolute/Chrome node tests/e2e/preview-controlled-build-live.mjs
 * No terminal, AI, external service, build-response mock, or project build script.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,stat,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';
import {createHub} from '../../server/hub/http.mjs';
import {loadVerifiedPreviewToolchain} from '../../server/preview/toolchain.mjs';

const distDir=process.env.SEQIVO_TEST_DIST_DIR&&resolve(process.env.SEQIVO_TEST_DIST_DIR);
const pythonPath=process.env.SEQIVO_TEST_PYTHON;
if(!distDir||!(await stat(join(distDir,'index.html')).catch(()=>null))?.isFile())
  throw Error('Build the web app first and set SEQIVO_TEST_DIST_DIR to its isolated output.');
if(!pythonPath||!pythonPath.startsWith('/')||!(await stat(pythonPath).catch(()=>null))?.isFile())
  throw Error('Set SEQIVO_TEST_PYTHON to the isolated managed preview wrapper.');
loadVerifiedPreviewToolchain();

const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-controlled-preview-live-')));
const qa=resolve('.runtime/preview-controlled-build-live');
const projectDir=join(root,'project');
const result={passed:false,realCore:true,realHub:true,realWorker:true,physicalPhone:false,checks:[]};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label,timeout=120000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await sleep(150);}throw Error(label);}
const git=(...args)=>execFileSync('git',args,{cwd:projectDir,stdio:'pipe',timeout:10000,
  env:Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')))});
let core,http,hub,browser;
try{
  await mkdir(projectDir);await mkdir(qa,{recursive:true});
  await writeFile(join(projectDir,'index.html'),
    '<!doctype html><html><body><button id="go">试用按钮</button><span id="result">等待点击</span><script type="module" src="./main.js"></script></body></html>');
  await writeFile(join(projectDir,'main.js'),
    'import "./style.css";document.getElementById("go").addEventListener("click",()=>{document.getElementById("result").textContent="受控构建已响应";});');
  await writeFile(join(projectDir,'style.css'),'body{background:#f8fafc;color:#243048}');
  git('init','-q');git('add','index.html','main.js','style.css');
  git('-c','user.name=Preview Test','-c','user.email=preview@example.invalid','commit','-qm','Controlled preview fixture');
  core=await createCore({dataDir:join(root,'core'),pluginDir:join(root,'empty-plugins'),files:false,previewPythonPath:pythonPath});
  const project=core.store.project({name:'受控预览界面隔离测试',directory:projectDir});
  const task=core.store.createTask({projectId:project.id,title:'亲自试用受控构建',criteria:['点击后出现受控构建响应']});
  http=await startHttp({core,dataDir:join(root,'core'),distDir,port:0});
  hub=await createHub({dataDir:join(root,'hub'),distDir,port:0});
  const username=`preview_${randomBytes(8).toString('hex')}`,password=randomBytes(24).toString('base64url');
  const account=await hub.accounts.register({username,password,source:'isolated-controlled-preview-test'});
  await core.remote.login({url:hub.url,username,password,projectIds:[project.id]});
  await until(()=>Boolean(hub.store.db.prepare('SELECT received_at FROM snapshots').get()),'Hub did not receive the original task',20000);
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const desktop=await browser.newContext({viewport:{width:1120,height:900},serviceWorkers:'block'});
  await desktop.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),http.tokens.owner);
  const local=await desktop.newPage();
  async function openTaskPreview(page,url,mobile){
    await page.goto(url);
    await page.getByRole('navigation',{name:mobile?'移动导航':'主要导航'}).getByRole('button',{name:'任务清单'}).click();
    await page.getByRole('button',{name:task.title}).click();
    await page.getByRole('button',{name:'试用运行预览'}).click();
    await page.getByRole('heading',{name:'在提交验收前亲自试用'}).waitFor();
  }
  await openTaskPreview(local,`http://127.0.0.1:${http.port}`,false);
  const buildRequest=local.waitForRequest(req=>new URL(req.url()).pathname==='/api/preview/controlled-builds'&&req.method()==='POST');
  await local.getByRole('button',{name:'从当前代码构建'}).click();
  const posted=(await buildRequest).postDataJSON();
  assert.deepEqual({...posted,requestId:null},{requestId:null,projectId:project.id,taskId:task.id,
    expectedRevision:task.revision,contentVersion:task.contentVersion,worktreeId:null,
    profile:'vite-vanilla-v1',apiTarget:'static',dataMode:'simulated'});
  const build=await until(async()=>{
    const {build}=await core.request('GET',`/api/preview/controlled-builds/${encodeURIComponent(posted.requestId)}`);
    if(['failed_no_publish','unknown'].includes(build.state))throw Error(`Real controlled build stopped in ${build.state}: ${build.errorCode||'unknown'}`);
    return build.state==='ready'?build:null;
  },'Controlled build did not reach ready');
  assert.equal(build.requestId,posted.requestId);assert.ok(build.previewId);
  await local.getByRole('button',{name:'读取原结果'}).click();
  await local.getByRole('button',{name:'打开这个预览'}).waitFor();
  await local.getByRole('button',{name:'打开这个预览'}).click();
  await local.locator('.preview-stage iframe').waitFor();
  assert.equal(await local.locator('.preview-toolbar select').inputValue(),build.previewId,'owner opens only the built receipt version');
  const localFrame=local.frameLocator('.preview-stage iframe');
  await localFrame.locator('#go').click();await localFrame.getByText('受控构建已响应').waitFor();
  assert.equal(await local.locator('.preview-stage iframe').getAttribute('sandbox'),'allow-scripts allow-forms');
  await local.screenshot({path:join(qa,'owner-ready.png'),fullPage:true});
  result.checks.push('owner clicked fixed-profile build; original request reached ready and exact preview iframe changed text');

  const mobile=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await mobile.addCookies([{name:'hub_session',value:account.sessionToken,url:hub.url,httpOnly:true,sameSite:'Strict'}]);
  const phone=await mobile.newPage();
  await openTaskPreview(phone,hub.url,true);
  await until(async()=>{
    const options=await phone.locator('.preview-toolbar option').evaluateAll(items=>items.map(item=>item.value));
    return options.includes(build.previewId);
  },'Hub did not list the controlled preview',20000);
  assert.equal(await phone.locator('.preview-toolbar select').inputValue(),build.previewId,'Hub opens the matching build');
  await phone.getByText('查看构建来源与版本记录').waitFor();
  await phone.frameLocator('.preview-stage iframe').locator('#go').click();
  await phone.frameLocator('.preview-stage iframe').getByText('受控构建已响应').waitFor();
  assert.equal(await phone.getByRole('button',{name:'从当前代码构建'}).count(),0,'remote phone cannot start a local build');
  await phone.getByLabel('遇到的问题或改进建议').fill('请核对按钮文字');
  await phone.getByRole('button',{name:'保存反馈草稿'}).click();
  await phone.getByText('反馈草稿待确认').waitFor();
  assert.equal(core.store.tasks(project.id).length,1,'draft does not create a task');
  await phone.getByRole('button',{name:'确认并创建关联任务'}).click();
  await until(()=>core.store.tasks(project.id).length===2,'Confirmed feedback did not create exactly one linked task',20000);
  const linked=core.store.tasks(project.id).find(item=>item.id!==task.id);
  assert.equal(linked.previewFeedback.sourceTaskId,task.id);
  assert.equal(linked.previewFeedback.previewId,build.previewId);
  assert.notEqual(core.store.getTask(task.id).acceptance,'passed');
  await phone.screenshot({path:join(qa,'hub-feedback-confirmed.png'),fullPage:true});
  result.checks.push('Hub phone opened same controlled preview; draft kept one task, explicit confirm created exactly one linked task');
  result.passed=true;
}catch(error){result.error=error.message;process.exitCode=1;}
finally{
  const cleanup=[];
  for(const [name,close] of [
    ['browser',()=>browser?.close()],['http',()=>http?.close()],
    ['core',()=>core?.close()],['hub',()=>hub?.close()],
  ])try{await close();cleanup.push({name,closed:true});}
  catch(error){cleanup.push({name,closed:false,reason:error.message});}
  result.cleanShutdown=cleanup.every(item=>item.closed);
  if(!result.cleanShutdown)result.cleanup=cleanup;
  if(!result.cleanShutdown){result.passed=false;process.exitCode=1;}
  await mkdir(qa,{recursive:true});await writeFile(join(qa,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
  if(result.passed&&result.cleanShutdown)await rm(root,{recursive:true,force:true});
}
