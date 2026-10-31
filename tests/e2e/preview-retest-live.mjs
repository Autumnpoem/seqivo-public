/** Actual Mac controlled builds, Core/Hub HTTP + WS and the product preview panel.
 * Requires the fixed preview toolchain, SEQIVO_TEST_PYTHON, SEQIVO_TEST_DIST_DIR,
 * and a fresh SEQIVO_TEST_QA_DIR. Browser sessions use disposable fixture tokens.
 * No AI, physical phone, production service or mocked comparison responses.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
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
const qa=process.env.SEQIVO_TEST_QA_DIR&&resolve(process.env.SEQIVO_TEST_QA_DIR);
if(!distDir||!(await stat(join(distDir,'index.html')).catch(()=>null))?.isFile())throw Error('Build the web app into an isolated dist directory.');
if(!pythonPath||!pythonPath.startsWith('/')||!(await stat(pythonPath).catch(()=>null))?.isFile())throw Error('Provide the fixed managed Python wrapper.');
if(!qa||await stat(qa).catch(()=>null))throw Error('Provide a fresh SEQIVO_TEST_QA_DIR; prior evidence must not be overwritten.');
loadVerifiedPreviewToolchain();
await mkdir(qa,{recursive:true,mode:0o700});
const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-retest-live-'))),projectDir=join(root,'project');
const result={passed:false,realCore:true,realHub:true,realControlledBuilds:true,physicalPhone:false,nativeApp:false,checks:[]};
let core,http,hub,browser;
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label,timeout=30000){const end=Date.now()+timeout;while(Date.now()<end){const value=await check();if(value)return value;await pause(100);}throw Error(label);}
const git=(...args)=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',...args],{cwd:projectDir,stdio:'pipe',timeout:10000,
  env:{...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))),GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
try{
  await mkdir(projectDir);
  await writeFile(join(projectDir,'index.html'),'<!doctype html><html><body><button id="go">试用按钮</button><span id="result">等待点击</span><script type="module" src="./main.js"></script></body></html>');
  const source=label=>`import "./style.css";document.getElementById("go").addEventListener("click",()=>{document.getElementById("result").textContent=${JSON.stringify(label)};});`;
  await writeFile(join(projectDir,'main.js'),source('第一版按钮已响应'));
  await writeFile(join(projectDir,'style.css'),'body{background:#f8fafc;color:#243048}');
  git('init','-q');git('add','index.html','main.js','style.css');
  git('-c','user.name=Preview Test','-c','user.email=preview@example.invalid','commit','-qm','Retest fixture');
  core=await createCore({dataDir:join(root,'core'),pluginDir:join(root,'empty-plugins'),files:false,previewPythonPath:pythonPath});
  const project=core.store.project({name:'重验说明隔离测试',directory:projectDir});
  const task=core.store.createTask({projectId:project.id,title:'按当前版本逐项核对',criteria:['点击按钮显示当前版本的结果','权限与外部数据仍符合要求']});
  const originalTask=core.store.getTask(task.id);
  http=await startHttp({core,dataDir:join(root,'core'),distDir,port:0});
  hub=await createHub({dataDir:join(root,'hub'),distDir,port:0});
  const username=`retest_${randomBytes(6).toString('hex')}`,password=randomBytes(24).toString('base64url');
  const account=await hub.accounts.register({username,password,source:'isolated-retest-live'});
  await core.remote.login({url:hub.url,username,password,projectIds:[project.id]});
  await until(()=>hub.store.db.prepare('SELECT received_at FROM snapshots').get(),'Hub snapshot missing');
  async function build(){
    const requestId=randomUUID();
    await core.request('POST','/api/preview/controlled-builds',{requestId,projectId:project.id,taskId:task.id,
      expectedRevision:task.revision,contentVersion:task.contentVersion,worktreeId:null,profile:'vite-vanilla-v1',apiTarget:'static',dataMode:'simulated'});
    const ready=await until(async()=>{
      const {build}=await core.request('GET',`/api/preview/controlled-builds/${requestId}`);
      if(['failed_no_publish','unknown'].includes(build.state))throw Error(`Controlled build ${build.state}: ${build.errorCode||'unknown'}`);
      return build.state==='ready'?build:null;
    },'Controlled build did not finish');
    await until(()=>hub.store.db.prepare('SELECT preview_id FROM preview_builds WHERE preview_id=?').get(ready.previewId),'Hub registration missing');
    return ready;
  }
  const previous=await build();
  await writeFile(join(projectDir,'main.js'),source('第二版按钮已响应'));
  const current=await build();
  assert.notEqual(previous.previewId,current.previewId);assert.notEqual(previous.sourceDigest,current.sourceDigest);
  result.checks.push('Two original managed builds reached ready with distinct source digests and immutable registrations');
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  // Fresh contexts retain the browser default. Playwright 1.63's block option
  // injects a navigator.serviceWorker getter that itself throws in opaque frames.
  const desktop=await browser.newContext({viewport:{width:1120,height:900}});
  await desktop.addInitScript(token=>{if(window===window.top)sessionStorage.setItem('taskboard-token',token);},http.tokens.owner);
  const local=await desktop.newPage(),errors=[];local.on('pageerror',error=>errors.push(error.message));
  async function openPreview(page,url,mobile){
    await page.goto(url);
    await page.getByRole('navigation',{name:mobile?'移动导航':'主要导航'}).getByRole('button',{name:'任务清单'}).click();
    await page.getByRole('button',{name:task.title}).click();
    await page.getByRole('button',{name:'试用运行预览'}).click();
    await page.locator('.preview-stage iframe').waitFor();
    assert.equal(await page.getByLabel('预览版本').inputValue(),current.previewId);
  }
  await openPreview(local,`http://127.0.0.1:${http.port}`,false);
  const section=local.getByRole('region',{name:'逐项重验清单'});
  await section.getByText('影响尚不确定',{exact:true}).first().waitFor();
  await local.frameLocator('.preview-stage iframe').locator('#go').click();
  await local.frameLocator('.preview-stage iframe').getByText('第二版按钮已响应').waitFor();
  const iframeBefore=await local.locator('.preview-stage iframe').getAttribute('src');
  const intentsBefore=core.store.db.prepare('SELECT count(*) AS n FROM preview_local_access_intents').get().n;
  await section.getByText('指定这版的对应文件和检查方法',{exact:true}).click();
  await section.getByLabel('选择要填写的标准').selectOption(task.criteria[0].id);
  await section.getByLabel('搜索可选文件').fill('main.js');
  await section.locator('.preview-retest-candidates input[type=checkbox]').check();
  await section.getByLabel('检查步骤（每行一步，最多 5 步）').fill('点击试用按钮，确认显示第二版按钮已响应');
  await section.getByRole('button',{name:'保存这版的检查说明'}).click();
  await section.getByText('请重新检查',{exact:true}).waitFor();
  await section.locator('.preview-retest-steps').getByText('点击试用按钮，确认显示第二版按钮已响应',{exact:true}).waitFor();
  assert.equal(await section.getByText('影响尚不确定',{exact:true}).count(),1);
  assert.equal(await local.locator('.preview-stage iframe').getAttribute('src'),iframeBefore);
  assert.equal(core.store.db.prepare('SELECT count(*) AS n FROM preview_local_access_intents').get().n,intentsBefore);
  await local.frameLocator('.preview-stage iframe').getByText('第二版按钮已响应').waitFor();
  const localComparison=await core.request('GET',`/api/previews/${current.previewId}/retest?previous=${previous.previewId}`);
  assert.equal(localComparison.sourceState,'verified');assert.equal(localComparison.reasonCode,null);
  assert.deepEqual(localComparison.changedFiles,[{path:'main.js',change:'modified'}]);
  assert.equal(localComparison.items[0].status,'needs_retest');assert.equal(localComparison.items[1].status,'unknown');
  result.checks.push('Product panel saved and read back the mapping; recomputed one affected criterion and one unknown without renewing access or reloading iframe');
  await local.screenshot({path:join(qa,'local-mapping.png'),fullPage:true});
  const mobile=await browser.newContext({viewport:{width:390,height:844}});
  await mobile.addCookies([{name:'hub_session',value:account.sessionToken,url:hub.url,httpOnly:true,sameSite:'Strict'}]);
  const phone=await mobile.newPage();phone.on('pageerror',error=>errors.push(error.message));
  await openPreview(phone,hub.url,true);
  const remote=phone.getByRole('region',{name:'逐项重验清单'});
  await remote.getByText('请重新检查',{exact:true}).waitFor();
  await remote.getByText('点击试用按钮，确认显示第二版按钮已响应',{exact:true}).waitFor();
  assert.equal(await remote.getByText('指定这版的对应文件和检查方法',{exact:true}).count(),0);
  await remote.getByText('查看关联文件（1）').click();
  await remote.getByText('main.js · 修改',{exact:true}).waitFor();
  assert.ok(await remote.evaluate(element=>element.scrollWidth<=element.clientWidth+1),'mobile retest section must not overflow horizontally');
  await phone.screenshot({path:join(qa,'hub-retest.png'),fullPage:true});
  result.checks.push('Authorized mobile-size Hub page read the exact comparison through the live node and exposed no mapping editor');
  const phoneFrameBefore=await phone.locator('.preview-stage iframe').getAttribute('src');
  const hubCapsBefore=hub.store.db.prepare('SELECT count(*) AS n FROM preview_caps').get().n;
  await section.getByRole('button',{name:'移除',exact:true}).click();
  const comparePath=`/api/previews/${current.previewId}/retest`;
  const localRefresh=local.waitForResponse(response=>new URL(response.url()).pathname===comparePath&&response.request().method()==='GET');
  await section.getByRole('button',{name:'保存这版的检查说明'}).click();
  const localReply=await localRefresh;assert.equal(localReply.status(),200);
  assert.equal((await localReply.json()).items[0].status,'unknown');
  await until(async()=>await section.getByText('请重新检查',{exact:true}).count()===0,'Removed mapping left a positive comparison');
  const phoneRefresh=phone.waitForResponse(response=>new URL(response.url()).pathname===comparePath&&response.request().method()==='GET');
  await remote.getByRole('button',{name:'重新读取重验说明'}).click();
  const phoneReply=await phoneRefresh;assert.equal(phoneReply.status(),200);
  assert.equal((await phoneReply.json()).items[0].status,'unknown');
  await until(async()=>!await remote.getByRole('button',{name:'重新读取重验说明'}).isDisabled(),'Comparison refresh stayed busy');
  await until(async()=>await remote.getByText('影响尚不确定',{exact:true}).count()===2,'Hub did not reflect the removed mapping');
  assert.equal(await phone.locator('.preview-stage iframe').getAttribute('src'),phoneFrameBefore);
  assert.equal(hub.store.db.prepare('SELECT count(*) AS n FROM preview_caps').get().n,hubCapsBefore);
  assert.equal(core.store.tasks(project.id).length,1);
  assert.deepEqual(core.store.getTask(task.id),originalTask,'Comparison metadata must not alter task, evidence or acceptance');
  assert.deepEqual(errors,[]);
  result.checks.push('Removing the mapping restored unknown locally and remotely, with no task/evidence/acceptance mutation');
  result.passed=true;
}catch(error){result.error=error.message;result.stack=error.stack;process.exitCode=1;}
finally{
  const cleanup=[];
  for(const [name,close] of [['browser',()=>browser?.close()],['http',()=>http?.close()],['core',()=>core?.close()],['hub',()=>hub?.close()]])
    try{await close();cleanup.push({name,closed:true});}catch(error){cleanup.push({name,closed:false,error:error.message});}
  result.cleanup=cleanup;result.cleanShutdown=cleanup.every(item=>item.closed);
  if(!result.cleanShutdown){result.passed=false;process.exitCode=1;}
  await writeFile(join(qa,'result.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify({passed:result.passed,checks:result.checks,cleanShutdown:result.cleanShutdown,error:result.error}));
  if(result.passed&&result.cleanShutdown)await rm(root,{recursive:true,force:true});
}
