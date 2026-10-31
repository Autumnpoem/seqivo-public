/** Browser UI contract test. Worktree endpoints are mocked; no Git write or AI runs. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const root=await mkdtemp(join(tmpdir(),'seqivo-worktree-save-ui-'));
let core,http,browser;
try{
  core=await createCore({dataDir:join(root,'data'),pluginDir:join(root,'empty-plugins'),files:false});
  const project=core.store.project({name:'审查版本界面测试',directory:root});
  const task=core.store.createTask({projectId:project.id,title:'实现角色任务',criteria:['人工验收差异']});
  http=await startHttp({core,dataDir:join(root,'data'),distDir:resolve(process.env.SEQIVO_TEST_DIST_DIR||'dist'),port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1050,height:850},serviceWorkers:'block'});
  await context.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),http.tokens.owner);
  const base='a'.repeat(40),source='b'.repeat(40),digest='e'.repeat(64);
  const entry={id:'tree-save-ui',projectId:project.id,taskId:task.id,role:'worker',path:join(root,'tree'),branch:'codex/worker-save-ui',baseCommit:base,phase:'ready'};
  const detail={...entry,head:source,targetHead:base,targetBranch:'main',dirty:true,targetDirty:false,status:' M feature.txt',targetStatus:'',nameStatus:'',patch:'',patchTruncated:false,indexTree:null,conflictFiles:[],stagedPatch:'',stagedPatchTruncated:false,reviewStatus:null,cleanupEligible:false,cleanupBlockedReason:'未合入'};
  const receipts=new Map();
  const posts=[];
  let saveMode='success',previewWorktreeId=entry.id,previewDigest=digest,statusPhase='ready',blockedReason='',saveCounter=0;
  const makePreview=()=>({worktreeId:previewWorktreeId,head:detail.head,taskRevision:task.revision,contentVersion:task.contentVersion,
    sourceDigest:blockedReason?'':previewDigest,changedFiles:blockedReason?[]:[{path:'feature.txt',kind:'modified',bytes:15}],
    patch:blockedReason?'':'diff --git a/feature.txt b/feature.txt\n+reviewed version\n',saveable:!blockedReason,blockedReason:blockedReason||null});
  const saveResult=(requestId,sourceHead,previousHead)=>({phase:'ready',requestId,worktreeId:entry.id,saveId:`save-${requestId}`,sourceHead,previousHead,sourceDigest:previewDigest,changedFileCount:1});
  await context.route('**/api/worktrees**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname,method=req.method();
    if(method==='GET'&&path==='/api/worktrees/base')return route.fulfill({json:{projectId:project.id,targetHead:base,targetBranch:'main',targetDirty:false}});
    if(method==='GET'&&path==='/api/worktrees')return route.fulfill({json:[entry]});
    if(method==='GET'&&path.endsWith('/binding'))return route.fulfill({json:{worktreeId:entry.id,taskId:task.id,conversationId:null,verified:false,status:'unbound'}});
    if(method==='GET'&&path.endsWith('/save-preview'))return route.fulfill({json:makePreview()});
    if(method==='GET'&&path.endsWith('/save')){
      const requestId=url.searchParams.get('requestId');
      return route.fulfill({json:receipts.get(requestId)||{phase:'not_found',requestId}});
    }
    if(method==='POST'&&path.endsWith('/save/reconcile')){
      const {requestId}=req.postDataJSON();
      const response=receipts.get(requestId)||{phase:'not_found',requestId};
      if(statusPhase==='not_found')return route.fulfill({json:{phase:'not_found',requestId}});
      if(statusPhase==='not_saved')return route.fulfill({json:{phase:'not_saved',requestId,worktreeId:entry.id,reason:'原请求未发布'}});
      return route.fulfill({json:response});
    }
    if(method==='POST'&&path.endsWith('/save')){
      const body=req.postDataJSON();posts.push({path,body});
      assert.equal(body.expectedHead,detail.head);
      assert.equal(body.expectedTaskRevision,task.revision);
      assert.equal(body.expectedContentVersion,task.contentVersion);
      assert.equal(body.expectedSourceDigest,previewDigest);
      if(saveMode==='not_saved'||saveMode==='lost_not_saved'){
        const rejected={phase:'not_saved',requestId:body.requestId,worktreeId:entry.id,reason:'保存前任务版本已变化'};
        receipts.set(body.requestId,rejected);
        return saveMode==='not_saved'?route.fulfill({json:rejected}):route.abort('failed');
      }
      const nextHead=(++saveCounter).toString(16).padStart(40,'0');
      const response=saveResult(body.requestId,nextHead,detail.head);
      if(saveMode!=='not_found'){
        receipts.set(body.requestId,saveMode==='prepared'?{phase:'prepared',requestId:body.requestId}:response);
        if(saveMode!=='prepared'){detail.head=response.sourceHead;detail.dirty=false;detail.nameStatus='M\tfeature.txt';detail.patch='diff --git a/feature.txt b/feature.txt\n+reviewed version\n';}
      }
      if(saveMode==='success')return route.fulfill({json:response});
      if(saveMode==='invalid_receipt')return route.fulfill({json:{phase:'ready',requestId:body.requestId,sourceHead:response.sourceHead,sourceDigest:response.sourceDigest,changedFileCount:1}});
      if(saveMode==='wrong_digest')return route.fulfill({json:{...response,sourceDigest:'f'.repeat(64)}});
      if(saveMode==='wrong_worktree')return route.fulfill({json:{...response,worktreeId:'another-tree'}});
      if(saveMode==='wrong_previous')return route.fulfill({json:{...response,previousHead:'a'.repeat(40)}});
      return route.abort('failed');
    }
    if(method==='GET'&&path===`/api/worktrees/${entry.id}`)return route.fulfill({json:detail});
    if(method==='POST')posts.push({path,body:req.postDataJSON()});
    return route.abort();
  });
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  const openWorkflow=async()=>{
    await page.getByRole('navigation',{name:'主要导航'}).getByText('更多功能').click();
    await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'协作计划'}).click();
    await page.getByRole('heading',{name:'独立工作区'}).waitFor();
  };
  await page.goto(`http://127.0.0.1:${http.port}`);
  await openWorkflow();
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'已核对当前差异，登记人工审查'}).isDisabled(),true,'dirty source cannot be reviewed');
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByText('feature.txt · 修改 · 15 字节').waitFor();
  await page.getByText('+reviewed version',{exact:false}).waitFor();
  await page.getByRole('button',{name:'确认保存为审查版本'}).click();
  await page.getByText(/已保存审查版本/).waitFor();
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,1);
  assert.equal(posts.filter(item=>item.path.endsWith('/review')||item.path.endsWith('/merge')).length,0,'save neither records review nor merges');
  assert.equal(core.store.getTask(task.id).acceptance,'unverified','save never marks task accepted');
  assert.equal(core.store.getTask(task.id).status,'planned','save never submits task result');
  assert.equal(await page.getByRole('button',{name:'已核对当前差异，登记人工审查'}).isDisabled(),true,'human acceptance remains separate');

  // The server commits the exact original request, but its response is lost.
  // A remount may only query that request ID; it may not POST a new save.
  detail.dirty=true;previewDigest='1'.repeat(64);saveMode='lost_ready';
  await page.getByRole('button',{name:'重新检查'}).click();
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByRole('button',{name:'确认保存为审查版本'}).click();
  await page.getByRole('heading',{name:'上次保存结果待核对'}).waitFor();
  const original=posts.at(-1).body;
  assert.ok(original.requestId);
  await page.reload();await openWorkflow();
  await page.getByRole('heading',{name:'上次保存结果待核对'}).waitFor();
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,2,'reload never resends save');
  await page.getByRole('button',{name:'核对上次保存'}).click();
  await page.getByText(/已保存审查版本/).waitFor();
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,2,'GET result resolves the original request without resending');

  // A missing status record does not prove that an earlier POST never arrived.
  // Keep the same operation locked across reload until a definitive receipt.
  detail.dirty=true;previewDigest='2'.repeat(64);saveMode='prepared';statusPhase='not_found';
  await page.getByRole('button',{name:'重新检查'}).click();
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByRole('button',{name:'确认保存为审查版本'}).click();
  await page.getByRole('heading',{name:'上次保存结果待核对'}).waitFor();
  await page.getByRole('button',{name:'核对上次保存'}).click();
  await page.getByText(/已找到原保存请求/).waitFor();
  assert.equal(await page.getByRole('button',{name:'查看待保存文件和完整差异'}).isDisabled(),true);
  await page.getByRole('button',{name:'进一步核对保存现场'}).click();
  await page.getByText(/暂未找到原请求记录，不能确认是否执行过/).waitFor();
  assert.equal(await page.getByRole('button',{name:'查看待保存文件和完整差异'}).isDisabled(),true,'not_found retains the original save lock');
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,3,'reconcile does not repeat original save');
  await page.reload();await openWorkflow();
  await page.getByRole('heading',{name:'上次保存结果待核对'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'查看待保存文件和完整差异'}).isDisabled(),true,'reload cannot turn not_found into a fresh save');
  await page.getByRole('button',{name:'核对上次保存'}).click();
  await page.getByText(/已找到原保存请求/).waitFor();
  statusPhase='not_saved';
  await page.getByRole('button',{name:'进一步核对保存现场'}).click();
  await page.getByText(/已核实这次请求未保存：原请求未发布/).waitFor();
  assert.equal(await page.getByRole('button',{name:'确认保存为审查版本'}).count(),0,'not_saved releases only the original intent and requires a new preview');
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,3);

  // A local persistence failure stops before POST.
  await page.evaluate(()=>{
    const prior=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){if(key.startsWith('seqivo-worktree-save-v1:'))throw new DOMException('quota','QuotaExceededError');return prior.call(this,key,value);};
  });
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByRole('button',{name:'确认保存为审查版本'}).click();
  await page.getByText(/保存请求未发送/).waitFor();
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,3);

  await page.reload();await openWorkflow();
  blockedReason='暂存内容尚未处理，不能保存审查版本。';
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByText(blockedReason).waitFor();
  assert.equal(await page.getByRole('button',{name:'确认保存为审查版本'}).isDisabled(),true,'blocked preview is visible but cannot save');
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,3);
  blockedReason='';
  previewWorktreeId='another-tree';
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByText(/待保存版本与当前工作区或任务不匹配/).waitFor();
  assert.equal(await page.getByRole('button',{name:'确认保存为审查版本'}).count(),0,'mismatched preview cannot be submitted');
  previewWorktreeId=entry.id;saveMode='invalid_receipt';
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByRole('button',{name:'确认保存为审查版本'}).click();
  await page.getByText(/保存回执与原请求或文件数不匹配/).waitFor();
  assert.equal(await page.getByRole('button',{name:'查看待保存文件和完整差异'}).isDisabled(),true,'partial receipt keeps original save intent locked');
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,4);
  await page.getByRole('button',{name:'核对上次保存'}).click();
  await page.getByText(/已保存审查版本/).waitFor();
  detail.dirty=true;previewDigest='3'.repeat(64);saveMode='wrong_digest';
  await page.getByRole('button',{name:'重新检查'}).click();
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByRole('button',{name:'确认保存为审查版本'}).click();
  await page.getByText(/保存回执与原请求或文件数不匹配/).waitFor();
  assert.equal(await page.getByRole('button',{name:'查看待保存文件和完整差异'}).isDisabled(),true,'same-ID receipt with wrong digest remains locked');
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,5);
  detail.head='a'.repeat(40);detail.dirty=true; // The live Git scene changed after the original save.
  await page.getByRole('button',{name:'核对上次保存'}).click();
  await page.getByText(/原请求已保存审查版本.*当前工作区现场仍需重新检查/).waitFor();
  detail.dirty=true;previewDigest='4'.repeat(64);saveMode='not_saved';
  await page.getByRole('button',{name:'重新检查'}).click();
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByRole('button',{name:'确认保存为审查版本'}).click();
  await page.getByText(/已核实这次请求未保存：保存前任务版本已变化/).waitFor();
  assert.equal(await page.getByRole('button',{name:'确认保存为审查版本'}).count(),0,'definitive rejection still requires a fresh preview');
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,6);
  saveMode='lost_not_saved';
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByRole('button',{name:'确认保存为审查版本'}).click();
  await page.getByRole('heading',{name:'上次保存结果待核对'}).waitFor();
  await page.getByRole('button',{name:'核对上次保存'}).click();
  await page.getByText(/已核实这次请求未保存：保存前任务版本已变化/).waitFor();
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,7,'lost rejection result is resolved by same-ID GET without resending');
  detail.dirty=true;previewDigest='5'.repeat(64);saveMode='wrong_worktree';
  await page.getByRole('button',{name:'重新检查'}).click();
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByRole('button',{name:'确认保存为审查版本'}).click();
  await page.getByText(/保存回执与原请求或文件数不匹配/).waitFor();
  assert.equal(await page.getByRole('button',{name:'查看待保存文件和完整差异'}).isDisabled(),true,'same request with another worktree stays locked');
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,8);
  await page.getByRole('button',{name:'核对上次保存'}).click();
  await page.getByText(/原请求已保存审查版本/).waitFor();
  detail.dirty=true;previewDigest='6'.repeat(64);saveMode='wrong_previous';
  await page.getByRole('button',{name:'重新检查'}).click();
  await page.getByRole('button',{name:'查看待保存文件和完整差异'}).click();
  await page.getByRole('button',{name:'确认保存为审查版本'}).click();
  await page.getByText(/保存回执与原请求或文件数不匹配/).waitFor();
  assert.equal(await page.getByRole('button',{name:'查看待保存文件和完整差异'}).isDisabled(),true,'same request with another previous head stays locked');
  assert.equal(posts.filter(item=>item.path.endsWith('/save')).length,9);
  assert.deepEqual(errors,[]);
  console.log('worktree save UI mock PASS: full preview, exact version save, lost response recovery, explicit reconcile, no acceptance/review/merge, local persistence and identity gates');
}finally{
  await browser?.close();await http?.close();await core?.close();await rm(root,{recursive:true,force:true});
}
