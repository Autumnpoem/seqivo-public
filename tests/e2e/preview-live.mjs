/** Real App + Core + Hub + immutable Vite build. No API or iframe mocks. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,cp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';
import {createHub} from '../../server/hub/http.mjs';

const root=await mkdtemp(join(tmpdir(),'seqivo-preview-live-')),projectDir=join(root,'project');
const qa=resolve('design/qa/preview-live');
const run=(cmd,args)=>execFileSync(cmd,args,{cwd:projectDir,stdio:'pipe',timeout:30000});
const vite=resolve('node_modules/vite/bin/vite.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await sleep(100);}throw Error(label);}
let core,http,hub,browser;
const evidence={checks:[],passed:false,realHub:true,physicalPhone:false};
try{
  await mkdir(projectDir);await mkdir(qa,{recursive:true});
  await writeFile(join(projectDir,'.gitignore'),'dist/\n');
  await writeFile(join(projectDir,'index.html'),'<button id="go">试用按钮</button><span id="result">等待点击</span><script type="module" src="./main.js"></script>');
  await writeFile(join(projectDir,'main.js'),"document.querySelector('#go').onclick=async()=>{const {value}=await import('./value.js');document.querySelector('#result').textContent=value};");
  await writeFile(join(projectDir,'value.js'),"export const value='第一版响应';\n");
  run('git',['init','-q']);run('git',['config','user.email','preview@example.test']);run('git',['config','user.name','Preview Test']);
  run('git',['add','.']);run('git',['commit','-qm','Initial preview']);run(process.execPath,[vite,'build','--base','./']);
  core=await createCore({dataDir:join(root,'core'),pluginDir:join(root,'empty-plugins'),files:false});
  const project=core.store.project({name:'运行预览实测',directory:projectDir});
  const task=core.store.createTask({projectId:project.id,title:'检查真实构建的按钮',criteria:['按钮点击后显示当前版本的响应']});
  const appDist=join(root,'app-dist');
  await cp(resolve('dist'),appDist,{recursive:true});
  http=await startHttp({core,dataDir:join(root,'core'),distDir:appDist,port:0});
  hub=await createHub({dataDir:join(root,'hub'),distDir:appDist,port:0});
  const username='preview_user',password='LocalTest-password-239';
  const account=await hub.accounts.register({username,password,source:'isolated-preview-test'});
  await core.remote.login({url:hub.url,username,password,projectIds:[project.id]});
  await until(()=>Boolean(hub.store.db.prepare('SELECT received_at FROM snapshots').get()),'Hub did not receive task');
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const desktop=await browser.newContext({viewport:{width:1100,height:900},serviceWorkers:'block'});
  await desktop.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),http.tokens.owner);
  const local=await desktop.newPage();
  async function openPreview(page,url,mobile){
    await page.goto(url);
    await page.getByRole('navigation',{name:mobile?'移动导航':'主要导航'}).getByRole('button',{name:'任务清单'}).click();
    await page.getByRole('button',{name:task.title}).click();
    await page.getByRole('button',{name:'试用运行预览'}).click();
    await page.getByRole('heading',{name:'在提交验收前亲自试用'}).waitFor();
  }
  await openPreview(local,`http://127.0.0.1:${http.port}`,false);
  await local.getByText('登记本机构建（owner）').click();
  await local.getByLabel('静态构建目录').fill(join(projectDir,'dist'));
  // Leave the real Chinese environment default intact to cover UI/API agreement.
  await local.getByRole('button',{name:'登记静态构建'}).click();
  const firstFrame=local.frameLocator('.preview-stage iframe');
  await firstFrame.locator('#go').click();await firstFrame.getByText('第一版响应').waitFor();
  assert.equal(await local.locator('.preview-stage iframe').getAttribute('sandbox'),'allow-scripts allow-forms');
  await local.locator('.preview-provenance span').filter({hasText:'本机静态构建'}).waitFor();
  await local.screenshot({path:join(qa,'desktop-preview.png'),fullPage:true});
  evidence.checks.push('desktop task detail registered a real Vite build with Chinese environment and rendered dynamic module interaction');
  const mobile=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await mobile.addCookies([{name:'hub_session',value:account.sessionToken,url:hub.url,httpOnly:true,sameSite:'Strict'}]);
  const phone=await mobile.newPage();await openPreview(phone,hub.url,true);
  const frame=phone.frameLocator('.preview-stage iframe');await frame.locator('#go').click();await frame.getByText('第一版响应').waitFor();
  assert.equal(await phone.getByText('登记本机构建（owner）').count(),0);
  await phone.getByRole('button',{name:'手机',exact:true}).click();
  await phone.getByLabel('遇到的问题或改进建议').fill('请把按钮响应更新为第二版');
  await phone.getByRole('checkbox',{name:task.criteria[0].text}).check();
  await phone.getByRole('button',{name:'保存反馈草稿'}).click();
  await phone.getByText('反馈草稿待确认').waitFor();assert.equal(core.store.tasks(project.id).length,1);
  await phone.getByRole('button',{name:'确认并创建关联任务'}).click();
  await until(()=>core.store.tasks(project.id).length===2,'Confirmed preview feedback did not create a task');
  const linked=core.store.tasks(project.id).find(item=>item.id!==task.id);
  assert.equal(linked.previewFeedback.sourceTaskId,task.id);assert.equal(linked.previewFeedback.pagePath,'index.html');
  assert.notEqual(core.store.getTask(task.id).acceptance,'passed');
  evidence.checks.push('phone viewport used real Hub preview, saved draft without task creation, explicitly confirmed one linked task');
  await writeFile(join(projectDir,'value.js'),"export const value='第二版响应';\n");
  run(process.execPath,[vite,'build','--base','./']);
  const old=core.store.getTask(task.id);
  core.store.updateTask(task.id,{summary:'按钮响应更新，需重新体验第二版'},old.revision);
  const latest=core.store.getTask(task.id);
  await until(()=>{
    const row=hub.store.db.prepare('SELECT data_json FROM snapshots').get();
    return Boolean(row&&JSON.parse(row.data_json).tasks?.some(item=>item.id===task.id&&item.contentVersion===latest.contentVersion));
  },'Hub did not receive the new task version before registration');
  await openPreview(local,`http://127.0.0.1:${http.port}`,false);
  await local.getByText('登记本机构建（owner）').click();
  await local.getByLabel('静态构建目录').fill(join(projectDir,'dist'));
  await local.getByRole('button',{name:'登记静态构建'}).click();
  await local.frameLocator('.preview-stage iframe').locator('#go').click();
  try{await local.frameLocator('.preview-stage iframe').getByText('第二版响应').waitFor({timeout:10000});}
  catch(error){
    const ui=await local.evaluate(()=>({text:document.querySelector('.preview-panel')?.textContent,selected:document.querySelector('.preview-toolbar select')?.value,options:[...document.querySelectorAll('.preview-toolbar option')].map(option=>({value:option.value,text:option.textContent})),iframePresent:Boolean(document.querySelector('.preview-stage iframe'))}));
    const frameText=await local.frameLocator('.preview-stage iframe').locator('body').innerText().catch(cause=>`frame read error: ${cause.message}`);
    const builds=hub.store.db.prepare('SELECT preview_id,content_version,artifact_digest,created_at FROM preview_builds ORDER BY created_at DESC').all();
    await writeFile(join(qa,'second-version-diagnostic.json'),JSON.stringify({ui,frameText,builds,expectedContentVersion:latest.contentVersion},null,2));
    await local.screenshot({path:join(qa,'second-version-diagnostic.png'),fullPage:true});
    console.error('Second version diagnostic',{selected:ui.selected,options:ui.options,frameText,builds:builds.map(({preview_id,content_version,artifact_digest})=>({preview_id,content_version,artifact_digest})),uiText:ui.text?.slice(0,1200)});
    throw error;
  }
  await openPreview(phone,hub.url,true);
  await phone.frameLocator('.preview-stage iframe').locator('#go').click();
  await phone.frameLocator('.preview-stage iframe').getByText('第二版响应').waitFor();
  await phone.getByRole('heading',{name:'版本变化后需要重验'}).waitFor();
  await phone.locator('.preview-retest').getByText(task.criteria[0].text,{exact:true}).waitFor();
  assert.equal(core.store.tasks(project.id).length,2);
  await phone.screenshot({path:join(qa,'phone-retest.png'),fullPage:true});
  evidence.checks.push('rebuilt source produced a new immutable preview; phone opened second build and linked criterion needs retest; original human acceptance unchanged');
  const selectedPreviewId=await phone.locator('.preview-toolbar select').inputValue();
  const expiredLink=await phone.locator('.preview-stage iframe').getAttribute('src');
  hub.store.db.prepare('UPDATE preview_caps SET expires_at=? WHERE preview_id=?').run(Date.now()-1,selectedPreviewId);
  const expiredStatus=await phone.evaluate(async url=>(await fetch(url,{credentials:'same-origin'})).status,expiredLink);
  assert.equal(expiredStatus,403,'Expired preview capability should be denied by the real Hub');
  await phone.getByRole('button',{name:'重新获取预览链接'}).click();
  await until(async()=>Boolean(await phone.locator('.preview-stage iframe').getAttribute('src'))&&(await phone.locator('.preview-stage iframe').getAttribute('src'))!==expiredLink,'Preview link was not renewed after expiry');
  await phone.frameLocator('.preview-stage iframe').locator('#go').click();
  await phone.frameLocator('.preview-stage iframe').getByText('第二版响应').waitFor();
  assert.equal(core.store.tasks(project.id).length,2);
  evidence.checks.push('expired Hub capability returned 403; explicit renewal restored the second build without resubmitting feedback');
  hub.store.db.prepare('UPDATE account_sessions SET revoked_at=? WHERE user_id=?').run(Date.now(),account.user.id);
  await phone.getByRole('button',{name:'重新获取预览链接'}).click();
  await phone.getByRole('alert').getByText('登录已失效。请重新登录后刷新预览；反馈不会自动补交。').waitFor();
  assert.equal(await phone.locator('.preview-stage iframe').count(),0);
  await phone.screenshot({path:join(qa,'phone-permission-error.png'),fullPage:true});
  evidence.checks.push('revoked real Hub login hid the iframe and showed a readable no-auto-retry error');
  evidence.passed=true;
}catch(error){evidence.error=error.message;process.exitCode=1;}
finally{
  await browser?.close();
  const cleanup=await Promise.allSettled([http?.close(),core?.close(),hub?.close()]);
  evidence.cleanShutdown=cleanup.every(item=>item.status==='fulfilled');
  if(!evidence.cleanShutdown){evidence.passed=false;process.exitCode=1;}
  await writeFile(join(qa,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
  if(evidence.cleanShutdown)await rm(root,{recursive:true,force:true});
}
