import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore } from '../server/core.mjs';

const node = process.execPath;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 5000 }).trim();

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'workflow-worktrees-'));
  const repo = join(dir, 'repo'), pluginDir = join(dir, 'plugins'), extension = join(pluginDir, 'fake');
  const bindingFile=join(dir,'provider-bindings.json');
  await mkdir(repo); await mkdir(extension, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Integration Test');
  git(repo, 'config', 'user.email', 'integration@example.test');
  await writeFile(join(repo, 'shared.txt'), 'base\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
  await writeFile(join(extension, 'plugin.json'), JSON.stringify({ id:'fake', name:'Fake', version:'1', apiVersion:1,
    entry:'host.mjs', permissions:['tasks.read','task.resume','task.pause'], capabilities:['task.resume','task.pause'] }));
  await writeFile(join(extension, 'host.mjs'), `import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
    export async function createPlugin(context){const commands=new Map();const state=()=>({enabled:false,available:true});
      return {state,configure:async()=>state(),enable:state,disable:state,close:async()=>{},
      check:async()=>state(),resume:async input=>{await context.authorizeExecution(input);
        await context.revalidateExecution({taskId:input.taskId,commandId:input.commandId,expectedDirectory:input.workspace,worktreeId:input.worktreeId});
        await writeFile(join(input.workspace,'role-'+input.taskId+'.txt'),input.taskId+'\\n');
        commands.set(input.commandId,{status:'running',taskId:input.taskId});return {status:'running'};},
      pause:async input=>{for(const item of commands.values())if(item.taskId===input.taskId)item.status='paused';return {status:'paused'};},
      getSessionBinding:async input=>{let rows={};try{rows=JSON.parse(await readFile(${JSON.stringify(bindingFile)},'utf8'));}catch{}
        return rows[input.taskId]||{status:'unbound',verified:false,taskId:input.taskId};},
      getExecution:async input=>commands.get(input.commandId)||{status:'not_started'}};}`);
  const dataDir = join(dir, 'data');
  let core = await createCore({ dataDir, pluginDir, files:false });
  t.after(async () => { await core.close(); await rm(dir, { recursive:true, force:true }); });
  const project = core.store.project({ name:'Git project', directory:repo });
  const tasks = ['A','B'].map(label => core.store.createTask({ projectId:project.id, title:label,
    goal:`Implement ${label}`, criteria:['Reviewed source'], conversationId:`fake-${label}`, executionProvider:'fake' }));
  const base = git(repo, 'rev-parse', 'HEAD');
  const create = (task,role) => core.request('POST','/api/worktrees',
    { projectId:project.id, taskId:task.id, role, requestId:`create-${role}`, expectedBase:base });
  return {dir,repo,dataDir,pluginDir,bindingFile,project,tasks,base,create,
    get core(){return core;},restart:async()=>{await core.close();core=await createCore({dataDir,pluginDir,files:false});}};
}

test('opt-in worktree plan writes two real Git trees concurrently without touching the project root', async t => {
  const f = await fixture(t), [a,b] = f.tasks;
  assert.deepEqual(await f.core.request('GET',`/api/worktrees/base?projectId=${f.project.id}`,{}),
    {projectId:f.project.id,targetHead:f.base,targetBranch:'main',targetDirty:false});
  const wa = await f.create(a,'builder'), wb = await f.create(b,'tester');
  assert.notEqual(wa.path,wb.path);
  const plan = await f.core.request('POST','/api/workflow/plans',{projectId:f.project.id,workspaceMode:'worktree',
    members:[{taskId:a.id,role:'builder',provider:'fake',worktreeId:wa.id},
      {taskId:b.id,role:'tester',provider:'fake',worktreeId:wb.id}],maxConcurrent:2,maxStarts:2,budgetMinutes:10});
  const started = await f.core.request('POST',`/api/workflow/plans/${plan.id}/start`,{});
  assert.deepEqual(started.members.map(item=>item.status),['running','running']);
  assert.equal(f.core.leases.state().active.length,2);
  assert.equal(await readFile(join(wa.path,`role-${a.id}.txt`),'utf8'),`${a.id}\n`);
  assert.equal(await readFile(join(wb.path,`role-${b.id}.txt`),'utf8'),`${b.id}\n`);
  assert.equal(git(f.repo,'status','--porcelain'), '');
  assert.equal(git(wa.path,'status','--porcelain').includes(`role-${b.id}`),false);
  assert.equal(f.core.leases.available({taskId:a.id,worktreeId:wa.id,workspace:wa.path}),false);
  await assert.rejects(f.core.request('POST','/api/workflow/plans',{projectId:f.project.id,workspaceMode:'worktree',
    members:[{taskId:a.id,role:'tester',provider:'fake',worktreeId:wa.id}],maxConcurrent:1,maxStarts:1,budgetMinutes:10}),
    {code:'WORKTREE_BINDING_CHANGED'});
  await f.restart();
  assert.deepEqual(f.core.workflow.state().plans[0].members.map(item=>item.status),['unknown','unknown']);
  assert.equal(f.core.leases.state().active.length,2);
});

test('owner review receipt binds exact commits, survives restart, and conflict keeps the Git merge state', async t => {
  const f = await fixture(t), task=f.tasks[0];
  const tree = await f.create(task,'builder');
  await writeFile(join(tree.path,'shared.txt'),'source\n');
  git(tree.path,'add','.'); git(tree.path,'commit','-qm','source');
  const sourceHead=git(tree.path,'rev-parse','HEAD');
  await writeFile(join(f.repo,'shared.txt'),'target\n');
  git(f.repo,'add','.'); git(f.repo,'commit','-qm','target');
  const targetHead=git(f.repo,'rev-parse','HEAD');
  const submitted=f.core.store.updateTask(task.id,{status:'submitted'},task.revision);
  const evidenced=f.core.store.addEvidence(task.id,{summary:'Reviewed source',reference:'git commit',expectedRevision:submitted.revision});
  f.core.store.review(task.id,{decision:'pass',summary:'Accepted source',expectedRevision:evidenced.revision});
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/review`,
    {sourceHead,targetHead},'reporter'),{status:403});
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/review`,
    {sourceHead:f.base,targetHead}),{code:'WORKTREE_REVIEW_STALE'});
  const review=await f.core.request('POST',`/api/worktrees/${tree.id}/review`,{sourceHead,targetHead});
  assert.equal(review.actor,'owner');
  await f.restart();
  const conflict=await f.core.request('POST',`/api/worktrees/${tree.id}/merge`,
    {expectedTargetHead:targetHead,reviewId:review.reviewId});
  assert.equal(conflict.phase,'conflict');
  assert.equal(git(f.repo,'rev-parse','MERGE_HEAD'),sourceHead);
  assert.match(await readFile(join(f.repo,'shared.txt'),'utf8'),/<<<<<<< HEAD/);
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/cleanup`,{}),{code:'WORKTREE_PHASE'});
  await writeFile(join(f.repo,'shared.txt'),'combined\n');
  git(f.repo,'add','.');
  const inspected=await f.core.request('GET',`/api/worktrees/${tree.id}`,{});
  assert.deepEqual(inspected.conflictFiles,[]);
  assert.equal(inspected.indexTree,git(f.repo,'write-tree'));
  assert.match(inspected.stagedPatch,/combined/);
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/finalize`,{expectedIndexTree:inspected.indexTree}),
    {code:'WORKTREE_INDEX_REVIEW_REQUIRED'});
  const merged=await f.core.request('POST',`/api/worktrees/${tree.id}/finalize`,
    {expectedIndexTree:inspected.indexTree,confirmReviewed:true});
  assert.equal(merged.phase,'merged');
  assert.equal(git(f.repo,'show','HEAD:shared.txt'),'combined');
});

test('owner binding read rechecks provider, current conversation and registered path across restart', async t => {
  const f=await fixture(t), task=f.tasks[0], tree=await f.create(task,'builder');
  const endpoint=`/api/worktrees/${tree.id}/binding`;
  await assert.rejects(f.core.request('GET',endpoint,{},'remote-controller'),{status:403});
  assert.deepEqual(await f.core.request('GET',endpoint,{}),
    {worktreeId:tree.id,taskId:task.id,conversationId:task.conversationId,verified:false,status:'unbound'});
  const report={status:'bound',verified:true,taskId:task.id,conversationId:task.conversationId,
    worktreeId:tree.id,workspace:tree.path,resumable:true};
  await writeFile(f.bindingFile,JSON.stringify({[task.id]:report}));
  assert.deepEqual(await f.core.request('GET',endpoint,{}),
    {worktreeId:tree.id,taskId:task.id,conversationId:task.conversationId,verified:true,status:'bound',resumable:true});
  await f.restart();
  assert.equal((await f.core.request('GET',endpoint,{})).verified,true);
  await writeFile(f.bindingFile,JSON.stringify({[task.id]:{...report,workspace:f.repo}}));
  assert.equal((await f.core.request('GET',endpoint,{})).status,'unconfirmed');
  await writeFile(f.bindingFile,JSON.stringify({[task.id]:report}));
  f.core.store.updateTask(task.id,{conversationId:'old-root-thread'},task.revision);
  assert.equal((await f.core.request('GET',endpoint,{})).status,'unconfirmed');
  const otherRepo=join(f.dir,'other-repo');await mkdir(otherRepo);git(otherRepo,'init','-q','-b','main');
  f.core.store.db.prepare('UPDATE projects SET directory=?,data=? WHERE id=?')
    .run(otherRepo,JSON.stringify({...f.project,directory:otherRepo}),f.project.id);
  await assert.rejects(f.core.request('GET',endpoint,{}),{code:'WORKTREE_BINDING_CHANGED'});
  f.core.store.db.prepare('UPDATE projects SET directory=?,data=? WHERE id=?')
    .run(f.repo,JSON.stringify(f.project),f.project.id);
  const outside=join(f.dir,'outside');await mkdir(outside);
  await rename(tree.path,`${tree.path}.moved`);await symlink(outside,tree.path);
  await assert.rejects(f.core.request('GET',endpoint,{}),{code:'WORKTREE_IDENTITY'});
});

test('durable merge fence excludes worktree and project-root leases throughout an awaited review', async t => {
  const f=await fixture(t), [task,other]=f.tasks, tree=await f.create(task,'builder');
  await writeFile(join(tree.path,'shared.txt'),'source\n');
  git(tree.path,'add','.');git(tree.path,'commit','-qm','source');
  const sourceHead=git(tree.path,'rev-parse','HEAD');
  const submitted=f.core.store.updateTask(task.id,{status:'submitted'},task.revision);
  const evidenced=f.core.store.addEvidence(task.id,{summary:'Reviewed source',reference:'git commit',expectedRevision:submitted.revision});
  f.core.store.review(task.id,{decision:'pass',summary:'Accepted',expectedRevision:evidenced.revision});
  const review=await f.core.request('POST',`/api/worktrees/${tree.id}/review`,{sourceHead,targetHead:f.base});
  let entered;const reached=new Promise(resolve=>{entered=resolve;});
  let release;const barrier=new Promise(resolve=>{release=resolve;});
  const original=f.core.worktrees.reviewDecision;
  f.core.worktrees.reviewDecision=async input=>{entered();await barrier;return original(input);};
  const merging=f.core.request('POST',`/api/worktrees/${tree.id}/merge`,{expectedTargetHead:f.base,reviewId:review.reviewId});
  await Promise.race([reached,merging.then(()=>{throw new Error('merge completed before review barrier');},error=>{throw error;}),
    new Promise((_,reject)=>setTimeout(()=>reject(new Error('review barrier was not reached')),5000))]);
  try {
    const fence=f.core.store.db.prepare('SELECT * FROM worktree_fences WHERE project_id=?').get(f.project.id);
    assert.equal(fence.worktree_id,tree.id);
    assert.equal(f.core.leases.available({taskId:task.id,worktreeId:tree.id,workspace:tree.path}),false);
    assert.throws(()=>f.core.leases.reserve({taskId:task.id,commandId:'fenced-tree',provider:'fake',workspace:tree.path,worktreeId:tree.id}),{code:'EXECUTION_BUSY'});
    assert.throws(()=>f.core.leases.reserve({taskId:other.id,commandId:'fenced-root',provider:'fake',workspace:f.project.directory}),{code:'EXECUTION_BUSY'});
  } finally { release(); }
  const result=await merging;
  assert.equal(result.phase,'merging');
  assert.equal(f.core.leases.state().active.length,0);
  await f.restart();
  assert.throws(()=>f.core.leases.reserve({taskId:other.id,commandId:'fenced-restart',provider:'fake',workspace:f.project.directory}),{code:'EXECUTION_BUSY'});
  const detail=await f.core.request('GET',`/api/worktrees/${tree.id}`,{});
  assert.deepEqual(detail.reviewStatus,{valid:true,reason:null,reviewId:review.reviewId});
  const merged=await f.core.request('POST',`/api/worktrees/${tree.id}/finalize`,{expectedIndexTree:detail.indexTree,confirmReviewed:true});
  assert.equal(merged.phase,'merged');
  assert.equal(f.core.store.db.prepare('SELECT * FROM worktree_fences WHERE project_id=?').get(f.project.id),undefined);
  assert.equal(f.core.leases.available({taskId:other.id,workspace:f.project.directory}),true);
  const cleanupLease=f.core.leases.reserve({taskId:other.id,commandId:'cleanup-root',provider:'fake',workspace:f.project.directory});
  assert.equal(cleanupLease.maySend,true);
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/cleanup`,{}),{code:'EXECUTION_BUSY'});
  f.core.leases.releaseConfirmed({taskId:other.id,commandId:'cleanup-root',status:'not_started'});
  assert.equal((await f.core.request('POST',`/api/worktrees/${tree.id}/cleanup`,{})).phase,'removed');
  assert.equal(f.core.store.db.prepare('SELECT * FROM worktree_fences WHERE project_id=?').get(f.project.id),undefined);
});

test('active lease wins merge race; stale task review blocks commit until fresh owner receipt', async t => {
  const f=await fixture(t), [task,other]=f.tasks, tree=await f.create(task,'builder');
  await writeFile(join(tree.path,'shared.txt'),'source\n');git(tree.path,'add','.');git(tree.path,'commit','-qm','source');
  const sourceHead=git(tree.path,'rev-parse','HEAD');
  await writeFile(join(f.repo,'shared.txt'),'target\n');git(f.repo,'add','.');git(f.repo,'commit','-qm','target');
  const targetHead=git(f.repo,'rev-parse','HEAD');
  let submitted=f.core.store.updateTask(task.id,{status:'submitted'},task.revision);
  let evidenced=f.core.store.addEvidence(task.id,{summary:'Reviewed source',reference:'git commit',expectedRevision:submitted.revision});
  f.core.store.review(task.id,{decision:'pass',summary:'Accepted',expectedRevision:evidenced.revision});
  const review=await f.core.request('POST',`/api/worktrees/${tree.id}/review`,{sourceHead,targetHead});
  const reservation=f.core.leases.reserve({taskId:other.id,commandId:'before-merge',provider:'fake',workspace:f.project.directory});
  assert.equal(reservation.maySend,true);
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/merge`,{expectedTargetHead:targetHead,reviewId:review.reviewId}),{code:'EXECUTION_BUSY'});
  assert.equal(git(f.repo,'rev-parse','HEAD'),targetHead);
  f.core.leases.releaseConfirmed({taskId:other.id,commandId:'before-merge',status:'not_started'});
  const conflict=await f.core.request('POST',`/api/worktrees/${tree.id}/merge`,{expectedTargetHead:targetHead,reviewId:review.reviewId});
  assert.equal(conflict.phase,'conflict');
  const changed=f.core.store.updateTask(task.id,{goal:'Changed after review'},f.core.store.getTask(task.id).revision);
  await writeFile(join(f.repo,'shared.txt'),'resolved\n');git(f.repo,'add','.');
  let detail=await f.core.request('GET',`/api/worktrees/${tree.id}`,{});
  assert.deepEqual(detail.reviewStatus,{valid:false,reason:'task_review_stale',reviewId:review.reviewId});
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/finalize`,{expectedIndexTree:detail.indexTree,confirmReviewed:true}),{code:'WORKTREE_REVIEW_STALE'});
  assert.equal(git(f.repo,'rev-parse','MERGE_HEAD'),sourceHead);
  assert.equal(f.core.store.db.prepare('SELECT operation FROM worktree_fences WHERE project_id=?').get(f.project.id).operation,'merge');
  await f.restart();
  assert.throws(()=>f.core.leases.reserve({taskId:other.id,commandId:'stale-restart',provider:'fake',workspace:f.project.directory}),{code:'EXECUTION_BUSY'});
  submitted=f.core.store.updateTask(task.id,{status:'submitted'},changed.revision);
  evidenced=f.core.store.addEvidence(task.id,{summary:'Reviewed updated task and staged merge',reference:'git index',expectedRevision:submitted.revision});
  f.core.store.review(task.id,{decision:'pass',summary:'Accepted updated result',expectedRevision:evidenced.revision});
  detail=await f.core.request('GET',`/api/worktrees/${tree.id}`,{});
  const renewed=await f.core.request('POST',`/api/worktrees/${tree.id}/review`,
    {sourceHead,targetHead,expectedIndexTree:detail.indexTree});
  assert.equal(renewed.indexTree,detail.indexTree);
  assert.deepEqual((await f.core.request('GET',`/api/worktrees/${tree.id}`,{})).reviewStatus,
    {valid:true,reason:null,reviewId:renewed.reviewId});
  const merged=await f.core.request('POST',`/api/worktrees/${tree.id}/finalize`,{expectedIndexTree:detail.indexTree,confirmReviewed:true});
  assert.equal(merged.phase,'merged');
  assert.equal(git(f.repo,'show','HEAD:shared.txt'),'resolved');
});

test('a second project bound to the registered worktree path cannot bypass its merge fence', async t => {
  const f=await fixture(t), task=f.tasks[0], tree=await f.create(task,'builder');
  const aliasProject=f.core.store.project({name:'Alias project',directory:tree.path});
  const aliasTask=f.core.store.createTask({projectId:aliasProject.id,title:'Alias writer',goal:'Write',
    criteria:['Done'],conversationId:'fake-alias',executionProvider:'fake'});
  const unrelated=join(f.dir,'unrelated');await mkdir(unrelated);git(unrelated,'init','-q','-b','main');
  const unrelatedProject=f.core.store.project({name:'Unrelated project',directory:unrelated});
  const unrelatedTask=f.core.store.createTask({projectId:unrelatedProject.id,title:'Independent writer',goal:'Write',criteria:['Done']});
  f.core.store.updateTask(unrelatedTask.id,{status:'running'},unrelatedTask.revision);
  await writeFile(join(tree.path,'shared.txt'),'source\n');git(tree.path,'add','.');git(tree.path,'commit','-qm','source');
  const sourceHead=git(tree.path,'rev-parse','HEAD');
  const submitted=f.core.store.updateTask(task.id,{status:'submitted'},task.revision);
  const evidenced=f.core.store.addEvidence(task.id,{summary:'Reviewed source',reference:'git commit',expectedRevision:submitted.revision});
  f.core.store.review(task.id,{decision:'pass',summary:'Accepted',expectedRevision:evidenced.revision});
  const review=await f.core.request('POST',`/api/worktrees/${tree.id}/review`,{sourceHead,targetHead:f.base});
  let aliasState=f.core.store.updateTask(aliasTask.id,{status:'running'},aliasTask.revision);
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/merge`,
    {expectedTargetHead:f.base,reviewId:review.reviewId}),{code:'EXECUTION_BUSY'});
  aliasState=f.core.store.updateTask(aliasTask.id,{status:'paused'},aliasState.revision);
  await rename(unrelated,`${unrelated}.missing`);
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/merge`,
    {expectedTargetHead:f.base,reviewId:review.reviewId}),{code:'EXECUTION_WORKSPACE_CHANGED'});
  await rename(`${unrelated}.missing`,unrelated);
  const aliasLease=f.core.leases.reserve({taskId:aliasTask.id,commandId:'alias-first',provider:'fake',workspace:tree.path});
  assert.equal(aliasLease.maySend,true);
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/merge`,
    {expectedTargetHead:f.base,reviewId:review.reviewId}),{code:'EXECUTION_BUSY'});
  f.core.leases.releaseConfirmed({taskId:aliasTask.id,commandId:'alias-first',status:'not_started'});
  let entered;const reached=new Promise(resolve=>{entered=resolve;});
  let release;const barrier=new Promise(resolve=>{release=resolve;});
  const original=f.core.worktrees.reviewDecision;
  f.core.worktrees.reviewDecision=async input=>{entered();await barrier;return original(input);};
  const merging=f.core.request('POST',`/api/worktrees/${tree.id}/merge`,{expectedTargetHead:f.base,reviewId:review.reviewId});
  await Promise.race([reached,merging.then(()=>{throw new Error('merge finished before barrier');},error=>{throw error;})]);
  try {
    assert.throws(()=>f.core.leases.reserve({taskId:aliasTask.id,commandId:'alias-second',provider:'fake',workspace:tree.path}),
      {code:'EXECUTION_BUSY'});
  } finally { release(); }
  assert.equal((await merging).phase,'merging');
  const detail=await f.core.request('GET',`/api/worktrees/${tree.id}`,{});
  assert.equal((await f.core.request('POST',`/api/worktrees/${tree.id}/finalize`,
    {expectedIndexTree:detail.indexTree,confirmReviewed:true})).phase,'merged');
  aliasState=f.core.store.updateTask(aliasTask.id,{status:'running'},aliasState.revision);
  await assert.rejects(f.core.request('POST',`/api/worktrees/${tree.id}/cleanup`,{}),{code:'EXECUTION_BUSY'});
  assert.equal(existsSync(tree.path),true);
  f.core.store.updateTask(aliasTask.id,{status:'paused'},aliasState.revision);
  assert.equal((await f.core.request('POST',`/api/worktrees/${tree.id}/cleanup`,{})).phase,'removed');
});
