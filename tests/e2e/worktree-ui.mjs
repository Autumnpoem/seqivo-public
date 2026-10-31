/** UI contract test with isolated HTTP mocks; no Git operation or AI execution is claimed. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createCore} from '../../server/core.mjs';
import {startHttp} from '../../server/http.mjs';

const root=await mkdtemp(join(tmpdir(),'seqivo-worktree-ui-'));
let core,http,browser;
try{
  core=await createCore({dataDir:join(root,'data'),pluginDir:join(root,'empty-plugins'),files:false});
  const project=core.store.project({name:'工作树界面测试',directory:root});
  const boundTask=core.store.createTask({projectId:project.id,title:'已核实的角色任务',criteria:['检查差异'],conversationId:'verified-thread',executionProvider:'codex-autocontinue'});
  const newTask=core.store.createTask({projectId:project.id,title:'待建立会话的任务',criteria:['检查新工作区']});
  http=await startHttp({core,dataDir:join(root,'data'),distDir:resolve('dist'),port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  const context=await browser.newContext({viewport:{width:1100,height:900},serviceWorkers:'block'});
  await context.addInitScript(token=>sessionStorage.setItem('taskboard-token',token),http.tokens.owner);
  const base='a'.repeat(40),source='b'.repeat(40),indexTree='c'.repeat(40);
  const approved={id:'tree-approved',projectId:project.id,taskId:boundTask.id,role:'worker',path:join(root,'approved'),branch:'codex/worker-approved',baseCommit:base,phase:'ready'};
  const rootSession={...approved,id:'tree-root-session',path:join(root,'root-session'),branch:'codex/worker-root'};
  const entries=[approved,rootSession];
  const details=new Map([[approved.id,{...approved,head:source,targetHead:base,targetBranch:'main',dirty:false,targetDirty:false,status:'',targetStatus:'',nameStatus:'M\tfeature.txt',patch:'diff --git a/feature.txt b/feature.txt\n+real change',patchTruncated:false,indexTree,conflictFiles:[],stagedPatch:'',stagedPatchTruncated:false,cleanupEligible:false,cleanupBlockedReason:'工作树有尚未合入的提交'}]]);
  const posts=[];
  let accepted=false;
  let bindingVerified=true;
  await context.route('**/api/state',async route=>{const response=await route.fetch();const state=await response.json();state.tasks=state.tasks.map(task=>task.id===boundTask.id&&accepted?{...task,acceptance:'passed'}:task);await route.fulfill({response,json:state});});
  await context.route('**/api/worktrees**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname,parts=path.split('/').filter(Boolean),method=req.method();
    if(method==='GET'&&path==='/api/worktrees/base')return route.fulfill({json:{projectId:project.id,targetHead:base,targetBranch:'main',targetDirty:false}});
    if(method==='GET'&&path==='/api/worktrees')return route.fulfill({json:entries});
    const id=parts[2],verb=parts[3];
    if(method==='GET'&&verb==='binding')return route.fulfill({json:{worktreeId:id,taskId:boundTask.id,conversationId:id===approved.id?'verified-thread':'root-thread',verified:id===approved.id&&bindingVerified,status:id===approved.id&&bindingVerified?'bound':'unbound'}});
    if(method==='GET'&&id)return route.fulfill({json:details.get(id)||{...entries.find(item=>item.id===id),head:base,targetHead:base,targetBranch:'main',dirty:false,targetDirty:false,status:'',targetStatus:'',nameStatus:'',patch:'',patchTruncated:false,indexTree,conflictFiles:[],stagedPatch:'',stagedPatchTruncated:false,cleanupEligible:true,cleanupBlockedReason:null}});
    if(method==='POST'){
      const body=req.postDataJSON();posts.push({path,body});
      if(path==='/api/worktrees'){
        const entry={id:'tree-created',projectId:project.id,taskId:newTask.id,role:'worker',path:join(root,'created'),branch:'codex/worker-created',baseCommit:base,phase:'ready'};
        entries.push(entry);details.set(entry.id,{...entry,head:base,targetHead:base,targetBranch:'main',dirty:false,targetDirty:false,status:'',targetStatus:'',nameStatus:'',patch:'',patchTruncated:false,indexTree,conflictFiles:[],stagedPatch:'',stagedPatchTruncated:false,cleanupEligible:true,cleanupBlockedReason:null});
        return route.fulfill({json:entry});
      }
      const detail=details.get(id);
      if(verb==='review'){
        const indexed=body.expectedIndexTree!==undefined;
        if(indexed)detail.reviewStatus={valid:true,reason:null,reviewId:'indexed-review-id'};
        return route.fulfill({json:{reviewId:indexed?'indexed-review-id':'server-review-id',worktreeId:id,taskId:boundTask.id,contentVersion:indexed?2:1,sourceHead:source,targetHead:base,indexTree:indexed?indexTree:null,actor:'owner',createdAt:new Date().toISOString()}});
      }
      if(verb==='merge'){detail.phase='merging';detail.mergeSourceHead=source;detail.mergeTargetHead=base;detail.reviewStatus={valid:true,reason:null,reviewId:'server-review-id'};detail.targetDirty=true;detail.stagedPatch='diff --git a/feature.txt b/feature.txt\n+real change';detail.cleanupBlockedReason='当前阶段不能清理';approved.phase='merging';return route.fulfill({json:detail});}
      if(verb==='finalize'){detail.phase='merged';detail.reviewStatus=null;detail.targetDirty=false;detail.cleanupEligible=true;detail.cleanupBlockedReason=null;approved.phase='merged';return route.fulfill({json:detail});}
      if(verb==='cleanup'){detail.phase='removed';approved.phase='removed';return route.fulfill({json:detail});}
    }
    return route.abort();
  });
  await context.route(`**/api/tasks/${newTask.id}/session`,route=>{posts.push({path:new URL(route.request().url()).pathname,body:route.request().postDataJSON()});return route.fulfill({json:{status:'created'}});});
  await context.route('**/api/workflow/plans',route=>{posts.push({path:'/api/workflow/plans',body:route.request().postDataJSON()});return route.fulfill({json:{id:'mock-plan'}});});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${http.port}`);
  await page.getByRole('navigation',{name:'主要导航'}).getByText('更多功能').click();
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'协作计划'}).click();
  await page.getByRole('heading',{name:'独立工作区'}).waitFor();
  assert.equal(await page.getByLabel('工作区安排').inputValue(),'project','old serial mode remains default');
  await page.getByText('建立角色工作区').click();
  await page.locator('.worktree-create select').first().selectOption(newTask.id);
  await page.getByRole('button',{name:'建立工作区'}).click();
  await page.getByText('独立工作区已建立。').waitFor();
  assert.equal(posts.find(item=>item.path==='/api/worktrees').body.expectedBase,base);
  await page.getByRole('button',{name:'在此工作区创建独立会话'}).click();
  await page.getByText('已在该工作树创建独立执行会话。',{exact:false}).waitFor();
  const session=posts.find(item=>item.path.endsWith('/session'))?.body;
  assert.equal(session.worktreeId,'tree-created');assert.equal(session.workspaceWrite,true);
  await page.getByRole('checkbox',{name:/已核实的角色任务/}).check();
  await page.getByLabel('工作区安排').selectOption('worktree');
  const treeSelect=page.getByLabel('已核实的角色任务 独立工作树');
  assert.deepEqual(await treeSelect.locator('option').allTextContents(),['选择工作树','codex/worker-approved · tree-app'],'unverified root session is absent');
  await treeSelect.selectOption(approved.id);
  await page.getByRole('button',{name:'保存草稿'}).click();
  try{await page.getByText('协作计划草稿已保存。',{exact:false}).waitFor({timeout:8000});}
  catch(error){console.error('Plan form diagnostic',{posts:posts.filter(item=>item.path==='/api/workflow/plans'),form:await page.locator('.workflow-builder').innerText(),alert:await page.locator('.workflow-page .alert').allTextContents(),disabled:await page.getByRole('button',{name:'保存草稿'}).isDisabled()});throw error;}
  const plan=posts.find(item=>item.path==='/api/workflow/plans').body;
  assert.equal(plan.workspaceMode,'worktree');assert.equal(plan.members[0].worktreeId,approved.id);
  bindingVerified=false;
  await page.reload();
  await page.getByRole('navigation',{name:'主要导航'}).getByText('更多功能').click();
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'协作计划'}).click();
  await page.getByRole('checkbox',{name:/已核实的角色任务/}).check();
  await page.getByLabel('工作区安排').selectOption('worktree');
  assert.deepEqual(await page.getByLabel('已核实的角色任务 独立工作树').locator('option').allTextContents(),['选择工作树'],'revoked binding cannot be reused after reload');
  assert.equal(await page.getByRole('button',{name:'保存草稿'}).isDisabled(),true);
  bindingVerified=true;
  await page.reload();
  await page.getByRole('navigation',{name:'主要导航'}).getByText('更多功能').click();
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'协作计划'}).click();
  await page.getByRole('checkbox',{name:/已核实的角色任务/}).check();
  await page.getByLabel('工作区安排').selectOption('worktree');
  assert.deepEqual(await page.getByLabel('已核实的角色任务 独立工作树').locator('option').allTextContents(),['选择工作树','codex/worker-approved · tree-app'],'verified binding survives UI reload from server');
  accepted=true;
  await page.reload();
  await page.getByRole('navigation',{name:'主要导航'}).getByText('更多功能').click();
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'协作计划'}).click();
  await page.getByRole('group',{name:'工作树列表'}).getByRole('button',{name:/已核实的角色任务/}).first().click();
  await page.getByText('查看文件变化与补丁').click();
  await page.getByRole('button',{name:'已核对当前差异，登记人工审查'}).click();
  await page.getByText('人工审查已登记到当前源和目标版本。',{exact:false}).waitFor();
  assert.deepEqual(posts.find(item=>item.path.endsWith('/review')).body,{sourceHead:source,targetHead:base});
  await page.getByRole('button',{name:'按审查记录请求合入'}).click();
  await page.getByText('合入已准备。',{exact:false}).waitFor();
  assert.deepEqual(posts.find(item=>item.path.endsWith('/merge')).body,{expectedTargetHead:base,reviewId:'server-review-id'});
  await page.getByRole('button',{name:'已核对暂存差异，完成合入提交'}).waitFor();
  assert.equal(await page.getByRole('button',{name:'已核对暂存差异，完成合入提交'}).isDisabled(),true,'index review is explicit');
  await page.getByText('查看主工作区暂存差异与索引版本').click();
  await expect(page.getByRole('button',{name:'已核对暂存差异，完成合入提交'})).toBeEnabled();
  assert.equal(posts.filter(item=>item.path.endsWith('/review')).length,1);
  accepted=false;
  details.get(approved.id).reviewStatus={valid:false,reason:'task_review_stale',reviewId:'server-review-id'};
  await page.reload();
  await page.getByRole('navigation',{name:'主要导航'}).getByText('更多功能').click();
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'协作计划'}).click();
  await page.getByRole('group',{name:'工作树列表'}).getByRole('button',{name:/已核实的角色任务/}).first().click();
  await page.getByText('查看主工作区暂存差异与索引版本').click();
  assert.equal(await page.getByRole('button',{name:'已核对暂存差异，完成合入提交'}).isDisabled(),true,'stale task review blocks finalize');
  assert.equal(await page.getByRole('button',{name:'已重新验收并核对暂存差异，登记新审查'}).count(),0,'cannot re-review before renewed human acceptance');
  accepted=true;
  await page.reload();
  await page.getByRole('navigation',{name:'主要导航'}).getByText('更多功能').click();
  await page.getByRole('navigation',{name:'主要导航'}).getByRole('button',{name:'协作计划'}).click();
  await page.getByRole('group',{name:'工作树列表'}).getByRole('button',{name:/已核实的角色任务/}).first().click();
  await page.getByText('查看主工作区暂存差异与索引版本').click();
  await page.getByRole('button',{name:'已重新验收并核对暂存差异，登记新审查'}).click();
  await page.getByText('当前暂存版本的人工审查已登记。',{exact:false}).waitFor();
  assert.deepEqual(posts.filter(item=>item.path.endsWith('/review'))[1].body,{sourceHead:source,targetHead:base,expectedIndexTree:indexTree});
  assert.equal(await page.getByRole('button',{name:'已核对暂存差异，完成合入提交'}).isDisabled(),true,'new receipt still requires displaying refreshed index');
  details.get(approved.id).indexTree='d'.repeat(40);
  details.get(approved.id).reviewStatus={valid:false,reason:'index_changed',reviewId:'indexed-review-id'};
  await page.getByRole('button',{name:'重新检查'}).click();
  await page.getByText('暂存内容已变化，需要重新核对并登记当前索引的人工审查。').waitFor();
  assert.equal(await page.getByRole('button',{name:'已核对暂存差异，完成合入提交'}).isDisabled(),true,'changed index invalidates receipt and viewed state');
  details.get(approved.id).indexTree=indexTree;
  details.get(approved.id).reviewStatus={valid:true,reason:null,reviewId:'indexed-review-id'};
  await page.getByRole('button',{name:'重新检查'}).click();
  assert.equal(await page.getByRole('button',{name:'已核对暂存差异，完成合入提交'}).isDisabled(),true,'restored index still requires re-view after inspection');
  await page.getByText('查看主工作区暂存差异与索引版本').click();
  await page.getByRole('button',{name:'已核对暂存差异，完成合入提交'}).click();
  await page.getByText('合入提交已完成。').waitFor();
  assert.deepEqual(posts.find(item=>item.path.endsWith('/finalize')).body,{expectedIndexTree:indexTree,confirmReviewed:true});
  await page.getByRole('button',{name:'安全清理工作区'}).click();
  await page.getByText('工作树已安全清理。').waitFor();
  assert.ok(posts.some(item=>item.path.endsWith('/cleanup')));
  assert.deepEqual(errors,[]);
  console.log('worktree UI mock PASS: default serial, create/base, session request, server-only binding across reload, exact review/merge/index/finalize, safe cleanup');
}finally{await browser?.close();await http?.close();await core?.close();await rm(root,{recursive:true,force:true});}
