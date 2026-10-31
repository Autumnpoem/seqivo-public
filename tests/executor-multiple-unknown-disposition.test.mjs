import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {access,chmod,cp,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const fakeSource=new URL('./plugin-fake-codex.py',import.meta.url);
const hostState=dataDir=>join(dataDir,'plugins','codex-autocontinue','codex-autocontinue.json');

async function until(read,accept,label){
  const deadline=Date.now()+20000;
  while(Date.now()<deadline){
    try{const value=await read();if(accept(value))return value;}catch{/* Atomic state can be between writes. */}
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test('cross-project isolation: two original unknown turns need separate exact takeover and never replay',{
  skip:process.platform!=='darwin',timeout:150000,
},async t=>{
  const sourcePython=process.env.TASKBOARD_TEST_PYTHON;
  const tmuxPath=resolve(process.env.TASKBOARD_TEST_TMUX||'.tools/terminal-build/install/bin/tmux');
  if(!sourcePython||!sourcePython.startsWith('/')){t.skip('Absolute TASKBOARD_TEST_PYTHON required');return;}
  try{await access(sourcePython,constants.X_OK);await access(tmuxPath,constants.X_OK);}
  catch{t.skip('Isolated Python/tmux runtime unavailable');return;}
  const root=await realpath(await mkdtemp('/private/tmp/seqivo-flow1108-'));
  const dataDir=join(root,'data'),fake=join(root,'fake-codex.py');
  const resources=resolve(sourcePython,'../../..');
  for(const name of ['server','plugins'])
    await cp(join(sourceRoot,name),join(root,name),{recursive:true,errorOnExist:true,force:false});
  for(const name of ['preview-python','preview-toolchain'])
    await cp(join(resources,name),join(root,name),{recursive:true,errorOnExist:true,force:false});
  await symlink(join(resources,'node_modules'),join(root,'node_modules'),'dir');
  const pluginDir=join(root,'plugins'),pythonPath=join(root,'preview-python/bin/seqivo-python');
  await access(join(pluginDir,'codex-autocontinue','executor_job.py'),constants.R_OK);
  const {createCore}=await import(pathToFileURL(join(root,'server','core.mjs')).href);
  const {readJobRecord}=await import(pathToFileURL(join(root,'server','macos-executor-job-record.mjs')).href);
  await mkdir(dataDir,{mode:0o700});
  const workspaces={a:join(root,'workspace-a'),b:join(root,'workspace-b')};
  for(const workspace of Object.values(workspaces))await mkdir(workspace,{mode:0o700});
  const fakeText=(await readFile(fakeSource,'utf8')).replace(/^#![^\n]*/,`#!${pythonPath}`);
  const setFake=async(tag,turn)=>{
    await writeFile(fake,fakeText.replaceAll('new-thread',`thread-${tag}`)
      .replaceAll('fake-turn-1',`turn-${tag}-${turn}`),{mode:0o700});
    await chmod(fake,0o700);
    process.env.TASKBOARD_FAKE_CWD=workspaces[tag];
  };
  const env={TASKBOARD_FAKE_SCENARIO:join(root,'scenario.json'),TASKBOARD_FAKE_LOG:join(root,'fake-provider.jsonl'),
    TASKBOARD_FAKE_PID:join(root,'provider.pid'),TASKBOARD_FAKE_CWD:workspaces.a,
    TASKBOARD_FAKE_APPROVAL_GATE:join(root,'approval-gate')};
  const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
  const threadCwds={'thread-a':workspaces.a,'thread-b':workspaces.b};
  await writeFile(env.TASKBOARD_FAKE_SCENARIO,JSON.stringify({approval:true,approvalWithTurnId:true,
    approvalAfterGate:true,threadCwds}),{mode:0o600});
  await writeFile(env.TASKBOARD_FAKE_LOG,'',{mode:0o600});
  Object.assign(process.env,env);
  let core,closed=false,finished=false;
  t.after(async()=>{
    for(const [key,value] of Object.entries(previous))value===undefined?delete process.env[key]:process.env[key]=value;
    if(core){
      try{await core.close();closed=true;}catch(error){
        t.diagnostic(`Core close unconfirmed; retained fixture ${root}: ${error.code||error.message}`);
        assert.fail('Core close must confirm original process retirement');
      }
    }
    if(closed&&finished)await rm(root,{recursive:true,force:true});
    else t.diagnostic(`Retained cross-project fixture for diagnosis: ${root}`);
  });
  core=await createCore({dataDir,pluginDir,files:false,managedPythonPath:pythonPath});
  await core.plugin.configure({pythonPath,codexPath:fake,pollSeconds:86400});
  const cases={};
  for(const tag of ['a','b']){
    const project=core.store.project({name:`Disposable ${tag}`,directory:workspaces[tag]});
    const created=core.store.createTask({projectId:project.id,title:`Original ${tag}`,
      executionProvider:'codex-autocontinue'});
    const task=core.store.updateTask(created.id,{status:'blocked'},created.revision);
    cases[tag]={tag,project,task,commandId:`unknown-${tag}`,nextId:`next-${tag}`,
      profileId:`managed-${tag}`,workspace:workspaces[tag]};
  }
  for(const tag of ['a','b']){
    const item=cases[tag];
    await rm(env.TASKBOARD_FAKE_APPROVAL_GATE,{force:true});
    await setFake(tag,1);
    const session=await core.request('POST',`/api/tasks/${item.task.id}/session`,{
      expectedRevision:item.task.revision,commandId:`session-${tag}`,workspaceWrite:false});
    assert.equal(session.status,'created');
    const live=core.store.getTask(item.task.id);
    const started=await core.request('POST',`/api/tasks/${item.task.id}/continue`,{
      expectedRevision:live.revision,commandId:item.commandId});
    assert.ok(['running','unknown','awaiting_approval'].includes(started.status));
    await until(async()=>JSON.parse(await readFile(hostState(dataDir),'utf8')),image=>{
      const marker=image.executors?.[`task:${item.task.id}`],command=image.commands?.[`${item.task.id}:${item.commandId}`];
      return marker?.status==='starting'&&command?.status==='running'&&command.turnId===`turn-${tag}-1`;
    },`${tag} original turn started`);
    await writeFile(env.TASKBOARD_FAKE_APPROVAL_GATE,'ready',{mode:0o600,flag:'wx'});
    const stopped=await until(async()=>JSON.parse(await readFile(hostState(dataDir),'utf8')),image=>
      image.executors?.[`task:${item.task.id}`]?.status==='stopped_unknown'&&
      image.commands?.[`${item.task.id}:${item.commandId}`]?.status==='unknown',`${tag} original stop receipt`);
    const marker=stopped.executors[`task:${item.task.id}`];
    assert.deepEqual(marker.shutdownStoppedReceipt,marker.shutdownStopProof);
    assert.equal((await readJobRecord(marker.recordRoot,marker.recordId,item.task.id,item.workspace)).phase,'retired');
  }
  await core.close();core=null;closed=true;
  closed=false;
  core=await createCore({dataDir,pluginDir,files:false,managedPythonPath:pythonPath});
  for(const item of Object.values(cases)){
    assert.equal(core.leases.state().active.find(row=>row.taskId===item.task.id)?.status,'unknown');
    await core.request('POST','/api/terminal/profiles',{id:item.profileId,label:`Disposable ${item.tag}`,
      projectId:item.project.id,enabled:true,shell:'/bin/sh',
      serverName:`seqivo_flow1108_${item.tag}_${randomBytes(5).toString('hex')}`,
      allowSharedServer:true,tmuxExecutable:tmuxPath});
    item.frames=[];item.ctx={local:true,profileId:item.profileId,connectionId:`owner-${item.tag}`};
    await core.terminal.frame(item.ctx,{v:1,type:'open',mode:'tmux',cols:80,rows:24},frame=>item.frames.push(frame));
  }
  const a=cases.a,b=cases.b;
  const leaseA=core.leases.state().active.find(row=>row.taskId===a.task.id);
  const leaseB=core.leases.state().active.find(row=>row.taskId===b.task.id);
  const bHostState=image=>({
    command:image.commands?.[`${b.task.id}:${b.commandId}`],
    marker:image.executors?.[`task:${b.task.id}`],
    policy:image.policies?.find(row=>row.taskId===b.task.id),
  });
  const bBefore=bHostState(JSON.parse(await readFile(hostState(dataDir),'utf8')));
  const phase=projectId=>{
    const row=core.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.control.v1');
    return row?JSON.parse(row.value).entries?.[projectId]?.phase||'ai_ready':'ai_ready';
  };
  await assert.rejects(core.terminal.frame(a.ctx,{v:1,type:'takeover',endUnknownCommands:[
    {taskId:a.task.id,commandId:a.commandId},{taskId:b.task.id,commandId:b.commandId}]},
  frame=>a.frames.push(frame)),error=>{
    assert.equal(error.code,'CONTROL_STALE');
    assert.equal(error.message,'旧轮次已变化，请重新打开接管确认');
    return true;
  });
  assert.equal(phase(a.project.id),'ai_ready');
  assert.equal(phase(b.project.id),'ai_ready');
  assert.deepEqual(core.leases.state().active.find(row=>row.taskId===a.task.id),leaseA);
  assert.deepEqual(core.leases.state().active.find(row=>row.taskId===b.task.id),leaseB);
  assert.deepEqual(core.leases.dispositions(),[]);
  assert.deepEqual(bHostState(JSON.parse(await readFile(hostState(dataDir),'utf8'))),bBefore);
  const takeOver=async item=>{
    const send=frame=>item.frames.push(frame);
    await core.terminal.frame(item.ctx,{v:1,type:'takeover',endUnknownCommands:[
      {taskId:item.task.id,commandId:item.commandId}]},send);
    assert.equal(item.frames.filter(frame=>frame.type==='control').at(-1)?.phase,'human');
    assert.equal(core.leases.state().active.find(row=>row.taskId===item.task.id),undefined);
    const disposition=core.leases.dispositions().find(row=>row.taskId===item.task.id&&row.commandId===item.commandId);
    assert.equal(disposition?.providerOutcome,'unknown');
    assert.equal(JSON.parse(await readFile(hostState(dataDir),'utf8')).commands[`${item.task.id}:${item.commandId}`].status,'unknown');
    await core.terminal.frame(item.ctx,{v:1,type:'return',notes:'No manual files changed'},send);
    const review=item.frames.filter(frame=>frame.type==='control').at(-1);
    assert.equal(review.phase,'return_review',review.reason);
    await core.terminal.frame(item.ctx,{v:1,type:'return-confirm',reviewId:review.returnReview.reviewId,
      expectedGeneration:review.generation},send);
    assert.equal(item.frames.filter(frame=>frame.type==='control').at(-1)?.phase,'ai_ready');
  };
  const newTurn=async item=>{
    await setFake(item.tag,2);
    const current=core.store.getTask(item.task.id);
    const result=await core.request('POST',`/api/tasks/${item.task.id}/continue`,{
      expectedRevision:current.revision,commandId:item.nextId});
    assert.ok(['running','unknown','awaiting_approval'].includes(result.status));
    await until(async()=>JSON.parse(await readFile(hostState(dataDir),'utf8')),image=>
      image.commands?.[`${item.task.id}:${item.nextId}`]?.status==='completed',`${item.tag} new turn completion`);
    const host=JSON.parse(await readFile(hostState(dataDir),'utf8'));
    assert.equal(host.commands[`${item.task.id}:${item.commandId}`].status,'unknown');
    assert.equal(host.policies.find(row=>row.taskId===item.task.id)?.enabled,false);
  };
  await takeOver(a);
  await writeFile(env.TASKBOARD_FAKE_SCENARIO,JSON.stringify({completeStatus:'completed',threadCwds}),{mode:0o600});
  await newTurn(a);
  const afterA=JSON.parse(await readFile(hostState(dataDir),'utf8'));
  assert.deepEqual(core.leases.state().active.find(row=>row.taskId===b.task.id),leaseB);
  assert.equal(phase(b.project.id),'ai_ready');
  assert.deepEqual(bHostState(afterA),bBefore);
  await takeOver(b);
  await newTurn(b);
  assert.equal(core.leases.dispositions().length,2);
  const requests=(await readFile(env.TASKBOARD_FAKE_LOG,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(requests.filter(row=>row.method==='turn/start').length,4,
    'each original and each new instruction must start exactly once');
  for(const item of Object.values(cases))
    assert.equal((await core.plugin.getExecution({taskId:item.task.id,commandId:item.commandId})).status,'unknown');
  await core.close();core=null;closed=true;finished=true;
});
