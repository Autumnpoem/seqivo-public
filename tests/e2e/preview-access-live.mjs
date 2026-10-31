/** Isolated real Core + Hub + browser access and feedback recovery flow.
 * Faults delay or discard real HTTP responses; they never invent API results.
 * Build the app first, e.g. `node node_modules/vite/bin/vite.js build --outDir .runtime/fix167-web`,
 * then set SEQIVO_TEST_DIST_DIR=.runtime/fix167-web. Without it, the standard dist/ is used.
 */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {createHub} from '../../server/hub/http.mjs';

const root=await mkdtemp(join(tmpdir(),'seqivo-preview-access-'));
const projectDir=join(root,'project');
const distDir=resolve(process.env.SEQIVO_TEST_DIST_DIR||'dist');
const vite=resolve('node_modules/vite/bin/vite.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,label){const end=Date.now()+15000;while(Date.now()<end){if(await check())return;await sleep(100);}throw Error(label);}
let core,hub,browser;
try{
  if(!(await stat(join(distDir,'index.html')).catch(()=>null))?.isFile())throw Error('Build the app first and set SEQIVO_TEST_DIST_DIR to its web directory.');
  await mkdir(projectDir);
  await writeFile(join(projectDir,'.gitignore'),'dist/\n');
  await writeFile(join(projectDir,'index.html'),'<button id="live">真实预览按钮</button><script type="module" src="./main.js"></script>');
  await writeFile(join(projectDir,'main.js'),"document.querySelector('#live').onclick=()=>document.body.dataset.clicked='yes';");
  const run=(bin,args)=>execFileSync(bin,args,{cwd:projectDir,stdio:'pipe',timeout:30000});
  run('git',['init','-q']);run('git',['config','user.email','preview@example.test']);run('git',['config','user.name','Preview Test']);
  run('git',['add','.']);run('git',['commit','-qm','Preview access fixture']);
  run(process.execPath,[vite,'build','--base','./']);
  core=await createCore({dataDir:join(root,'core'),pluginDir:join(root,'empty-plugins'),files:false});
  const project=core.store.project({name:'访问关闭隔离验收',directory:projectDir});
  const task=core.store.createTask({projectId:project.id,title:'核对预览链接关闭',criteria:['按钮可点击']});
  hub=await createHub({dataDir:join(root,'hub'),distDir,port:0});
  const username='preview_access_user',password='LocalTest-password-239';
  const account=await hub.accounts.register({username,password,source:'isolated-preview-access-test'});
  await core.remote.login({url:hub.url,username,password,projectIds:[project.id]});
  await until(()=>Boolean(hub.store.db.prepare('SELECT received_at FROM snapshots').get()),'Hub did not receive task');
  const registered=await core.request('POST','/api/preview/builds',{projectId:project.id,taskId:task.id,contentVersion:task.contentVersion,distDir:join(projectDir,'dist'),environment:'隔离静态构建',dataMode:'simulated'});
  await until(()=>Boolean(hub.store.db.prepare('SELECT preview_id FROM preview_builds WHERE preview_id=?').get(registered.preview.previewId)),'Hub did not receive preview');
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
  await context.addCookies([{name:'hub_session',value:account.sessionToken,url:hub.url,httpOnly:true,sameSite:'Strict'}]);
  const page=await context.newPage();
  await page.goto(hub.url);
  await page.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
  await page.getByRole('button',{name:task.title}).click();
  await page.getByRole('button',{name:'试用运行预览'}).click();
  const frame=page.locator('.preview-stage iframe');
  await frame.waitFor();
  const firstUrl=await frame.getAttribute('src');
  const status=async url=>page.evaluate(async path=>(await fetch(path,{credentials:'same-origin'})).status,url);
  assert.equal(await status(firstUrl),200,'original capability is usable');
  await page.getByRole('button',{name:'关闭本次预览访问'}).click();
  await frame.waitFor({state:'detached'});
  assert.equal(await status(firstUrl),403,'real Hub rejects revoked capability');
  await page.getByRole('button',{name:'重新获取预览链接'}).click();
  await frame.waitFor();
  const secondUrl=await frame.getAttribute('src');
  assert.notEqual(secondUrl,firstUrl,'explicit refresh issues a new link');
  assert.equal(await status(secondUrl),200);
  assert.equal(await status(firstUrl),403,'old link stays denied after refresh');
  await page.getByRole('button',{name:'返回任务'}).click();
  await page.getByRole('heading',{name:task.title}).waitFor();
  assert.equal(await status(secondUrl),403,'return revoked the replacement link');
  // Let the real Hub issue a capability, then lose or delay only its network
  // response. No preview API response or authorization decision is mocked.
  for(const fault of ['lost','late']){
    let captured=null,faultError=null,issueCount=0,releaseResponse,finishedResponse;
    const gate=new Promise(resolve=>{releaseResponse=resolve;});
    const finished=new Promise(resolve=>{finishedResponse=resolve;});
    const pattern='**/api/previews/*/access-intents/*/issue';
    await page.route(pattern,async route=>{
      issueCount++;
      try{
        const response=await route.fetch();
        assert.equal(response.status(),200,'the actual Hub issues the original access');
        const data=await response.json();
        assert.equal(data.intent.state,'issued');
        captured={url:data.launchUrl,intentId:data.intent.id};
        if(fault==='lost')await route.abort('failed');
        else{await gate;await route.fulfill({response});}
      }catch(error){faultError=error;await route.abort().catch(()=>{});}
      finally{finishedResponse();}
    });
    try{
      await page.getByRole('button',{name:'试用运行预览'}).click();
      await until(()=>Boolean(captured||faultError),'Hub issue response was not intercepted');
      if(faultError)throw faultError;
      const intentPath=`/api/previews/${registered.preview.previewId}/access-intents/${captured.intentId}`;
      const readIntent=()=>page.evaluate(async path=>{
        const response=await fetch(path,{credentials:'same-origin'});
        return {status:response.status,data:await response.json()};
      },intentPath);
      const beforeClose=await readIntent();
      assert.equal(beforeClose.status,200);
      assert.equal(beforeClose.data.intent.state,'issued');
      assert.equal(await status(captured.url),200,'response loss does not imply the link was never issued');
      if(fault==='lost'){
        await page.getByRole('button',{name:'核对本次访问'}).click();
        await until(()=>page.getByRole('button',{name:'核对本次访问'}).isEnabled(),'status check did not finish');
      }
      // Returning must close by known intent, independently of the lost or
      // still-pending issue request, and must not mint another capability.
      await page.getByRole('button',{name:'返回任务'}).click();
      await page.getByRole('heading',{name:task.title}).waitFor();
      assert.equal(await status(captured.url),403,`${fault} response: old link is unusable after return`);
      assert.equal((await readIntent()).data.intent.state,'closed');
      releaseResponse();await finished;
      if(faultError)throw faultError;
      assert.equal(await page.locator('.preview-stage iframe').count(),0,'late issue response must not reopen the preview');
      assert.equal(issueCount,1,'network uncertainty must not cause another issue');
    }finally{
      releaseResponse();
      await page.unroute(pattern);
    }
  }
  const feedbackBase=`/api/previews/${registered.preview.previewId}/feedback`;
  const recovery=target=>target.getByRole('region',{name:'反馈恢复'});
  async function openPreview(target){
    await target.goto(hub.url);
    await target.getByRole('navigation',{name:'移动导航'}).getByRole('button',{name:'任务清单'}).click();
    await target.getByRole('button',{name:task.title}).click();
    await target.getByRole('button',{name:'试用运行预览'}).click();
    await target.locator('.preview-stage iframe').waitFor();
  }
  let draftPosts=0,confirmPosts=0,draftReply,confirmReply,feedbackFault;
  context.on('request',req=>{
    const path=new URL(req.url()).pathname;
    if(req.method()==='POST'&&path===feedbackBase)draftPosts++;
    if(req.method()==='POST'&&path.startsWith(feedbackBase+'/')&&path.endsWith('/confirm'))confirmPosts++;
  });
  // Persist a real draft at the Hub, losing only the browser's response.
  const draftPattern=`**${feedbackBase}`;
  await page.route(draftPattern,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    try{
      const reply=await route.fetch();assert.equal(reply.status(),200);
      draftReply=(await reply.json()).feedback;
      assert.equal(draftReply.status,'draft');
      await route.abort('failed');
    }catch(error){feedbackFault=error;await route.abort().catch(()=>{});}
  });
  await openPreview(page);
  await page.getByLabel('遇到的问题或改进建议').fill('请验证刷新后同一条反馈不会生成两个任务');
  await page.getByRole('button',{name:'保存反馈草稿',exact:true}).click();
  await until(()=>Boolean(draftReply||feedbackFault),'real draft did not reach Hub');
  if(feedbackFault)throw feedbackFault;
  await page.locator('.preview-feedback .preview-uncertain').waitFor();
  assert.equal(core.store.tasks(project.id).length,1,'draft does not create a task');
  await page.unroute(draftPattern);
  await page.getByRole('button',{name:'返回任务'}).click();
  await page.getByRole('button',{name:'试用运行预览'}).click();
  await recovery(page).getByRole('button',{name:'确认这份原草稿'}).waitFor();
  assert.equal(draftPosts,1,'remount queries the original draft, without creating another');

  // A second tab captures a genuine old draft result. It must not erase the
  // first tab's later confirmed receipt when that delayed result is delivered.
  const olderPage=await context.newPage();
  let oldRead=false,oldReadAt=0,releaseOld,finishOld,oldReadError;
  const oldGate=new Promise(resolve=>{releaseOld=resolve;});
  const oldFinished=new Promise(resolve=>{finishOld=resolve;});
  const oldPattern=`**${feedbackBase}/${draftReply.id}`;
  await olderPage.route(oldPattern,async route=>{
    if(route.request().method()!=='GET')return route.continue();
    try{
      const reply=await route.fetch();assert.equal(reply.status(),200);
      assert.equal((await reply.json()).feedback.status,'draft');oldRead=true;oldReadAt=Date.now();
      await oldGate;await route.fulfill({response:reply});
    }catch(error){oldReadError=error;await route.abort().catch(()=>{});}
    finally{finishOld();}
  });
  const confirmPattern=`**${feedbackBase}/${draftReply.id}/confirm`;
  await page.route(confirmPattern,async route=>{
    try{
      const reply=await route.fetch();assert.equal(reply.status(),200);
      confirmReply=(await reply.json()).feedback;
      assert.equal(confirmReply.status,'confirmed');await route.abort('failed');
    }catch(error){feedbackFault=error;await route.abort().catch(()=>{});}
  });
  try{
    await openPreview(olderPage);
    await until(()=>oldRead||oldReadError,'old real draft GET was not intercepted');
    if(oldReadError)throw oldReadError;
    await recovery(page).getByRole('button',{name:'确认这份原草稿'}).click();
    await until(()=>Boolean(confirmReply||feedbackFault),'real confirmation did not reach Core');
    if(feedbackFault)throw feedbackFault;
    assert.equal(core.store.tasks(project.id).filter(item=>item.previewFeedback?.feedbackId===draftReply.id).length,1);
    await recovery(page).getByRole('alert').waitFor();
    await page.unroute(confirmPattern);
    await openPreview(page);
    await recovery(page).getByText(`已创建关联任务：${confirmReply.taskId}。请到任务列表核对。`,{exact:true}).waitFor();
    assert.ok(Date.now()-oldReadAt<7000,'deliver the old result before the UI deadline, so this actually tests merging');
    releaseOld();await oldFinished;
    if(oldReadError)throw oldReadError;
    await recovery(olderPage).getByText(`已创建关联任务：${confirmReply.taskId}。请到任务列表核对。`,{exact:true}).waitFor();
    assert.equal(await recovery(olderPage).getByRole('button',{name:'确认这份原草稿'}).count(),0,
      'late old GET must not reopen draft confirmation');
    await openPreview(page);
    await recovery(page).getByText(`已创建关联任务：${confirmReply.taskId}。请到任务列表核对。`,{exact:true}).waitFor();
    assert.equal(draftPosts,1);assert.equal(confirmPosts,1,'reloads must never resend confirmation');
    assert.equal(core.store.tasks(project.id).filter(item=>item.previewFeedback?.feedbackId===draftReply.id).length,1);
  }finally{
    releaseOld();await olderPage.unroute(oldPattern);await olderPage.close();
    await page.unroute(confirmPattern);
  }

  // A request that never reaches the Hub is unknown after a GET 404. Only
  // explicit reconciliation creates a fence that rejects that late request.
  let undelivered;
  await page.route(draftPattern,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    undelivered=route.request().postDataJSON();await route.abort('failed');
  });
  await page.getByLabel('遇到的问题或改进建议').fill('原请求未到达时也不能自行重复创建');
  await page.getByRole('button',{name:'保存反馈草稿',exact:true}).click();
  await page.locator('.preview-feedback .preview-uncertain').waitFor();
  assert.ok(undelivered?.idempotencyKey);
  await page.unroute(draftPattern);await openPreview(page);
  await recovery(page).getByText(/目前未查到原反馈/).waitFor();
  assert.equal(core.store.tasks(project.id).length,2);
  await recovery(page).getByRole('button',{name:'正式核对结果'}).click();
  await recovery(page).getByText('已核实原请求未执行，原编号不会再使用。',{exact:true}).waitFor();
  const late=await context.request.post(hub.url+feedbackBase,{data:undelivered,
    headers:{Origin:hub.url,'X-Preview-Actor-Id':account.user.id}});
  assert.equal(late.status(),409,'the original fenced draft cannot arrive late and create a task');
  assert.equal((await late.json()).code,'PREVIEW_FEEDBACK_NOT_APPLIED');
  assert.equal(core.store.tasks(project.id).length,2);
  assert.equal(confirmPosts,1);
  console.log(JSON.stringify({passed:true,realCore:true,realHub:true,browser:true,checks:[
    'original 200','explicit close old 403','new link 200','old remains 403','return new 403',
    'lost issue response closed without reissue','late issue response closed without reopening',
    'lost draft response recovered by original identity','lost confirmation response recovered after reload',
    'same-operation old tab response cannot roll back confirmed result','only one real linked task',
    'missing draft stays unknown until explicit reconciliation','late fenced draft rejected'
  ],capabilitiesLogged:false}));
  await context.close();
}finally{
  await browser?.close();
  await core?.close();
  await hub?.close();
  await rm(root,{recursive:true,force:true});
}
