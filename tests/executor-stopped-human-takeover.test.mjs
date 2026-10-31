import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {constants} from 'node:fs';
import {access,chmod,cp,mkdir,mkdtemp,readFile,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const sourceRoot=fileURLToPath(new URL('../',import.meta.url));
const fakeSource=new URL('./plugin-fake-codex.py',import.meta.url);
const hostState=dataDir=>join(dataDir,'plugins','codex-autocontinue','codex-autocontinue.json');

async function until(read,accept,label){
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){
    try{const value=await read();if(accept(value))return value;}catch{/* Atomic fixture state may not exist yet. */}
    await new Promise(resolve=>setTimeout(resolve,40));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

async function exerciseStoppedTakeover(t,variant){
  const refusal=variant!=='valid';
  let writer;
  const sourcePython=process.env.TASKBOARD_TEST_PYTHON;
  const tmuxPath=resolve(process.env.TASKBOARD_TEST_TMUX||'.tools/terminal-build/install/bin/tmux');
  if(!sourcePython||!sourcePython.startsWith('/')){t.skip('Absolute TASKBOARD_TEST_PYTHON required');return;}
  try{await access(sourcePython,constants.X_OK);await access(tmuxPath,constants.X_OK);}
  catch{t.skip('Isolated Python/tmux runtime unavailable');return;}
  const root=await realpath(await mkdtemp('/private/tmp/seqivo-stopped-human-'));
  const dataDir=join(root,'data'),workspace=join(root,'workspace'),fake=join(root,'fake-codex.py');
  const resources=resolve(sourcePython,'../../..');
  for(const name of ['server','plugins'])
    await cp(join(sourceRoot,name),join(root,name),{recursive:true,errorOnExist:true,force:false});
  for(const name of ['preview-python','preview-toolchain'])
    await cp(join(resources,name),join(root,name),{recursive:true,errorOnExist:true,force:false});
  await symlink(join(resources,'node_modules'),join(root,'node_modules'),'dir');
  const pluginDir=join(root,'plugins');
  const helper=join(pluginDir,'codex-autocontinue','executor_job.py');
  await access(helper,constants.R_OK);
  t.diagnostic(`Isolated launchctl helper: ${helper}`);
  const {createCore}=await import(pathToFileURL(join(root,'server','core.mjs')).href);
  const {readJobRecord}=await import(pathToFileURL(join(root,'server','macos-executor-job-record.mjs')).href);
  const pythonPath=join(root,'preview-python/bin/seqivo-python');
  await mkdir(dataDir,{mode:0o700});await mkdir(workspace,{mode:0o700});
  const fakeText=(await readFile(fakeSource,'utf8')).replace(/^#![^\n]*/,`#!${pythonPath}`);
  await writeFile(fake,fakeText,{mode:0o700});await chmod(fake,0o700);
  const env={TASKBOARD_FAKE_SCENARIO:join(root,'scenario.json'),TASKBOARD_FAKE_LOG:join(root,'fake-provider.jsonl'),
    TASKBOARD_FAKE_PID:join(root,'provider.pid'),TASKBOARD_FAKE_CWD:workspace,
    TASKBOARD_FAKE_APPROVAL_GATE:join(root,'approval-gate')};
  const previous=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));
  await writeFile(env.TASKBOARD_FAKE_SCENARIO,JSON.stringify({approval:true,approvalWithTurnId:true,approvalAfterGate:true}),{mode:0o600});
  await writeFile(env.TASKBOARD_FAKE_LOG,'',{mode:0o600});
  Object.assign(process.env,env);
  let core,closed=false;
  t.after(async()=>{
    if(writer&&writer.exitCode===null&&writer.signalCode===null){writer.stdin.end();await once(writer,'exit');}
    for(const [key,value] of Object.entries(previous))value===undefined?delete process.env[key]:process.env[key]=value;
    try{if(core){await core.close();closed=true;}}
    catch(error){t.diagnostic(`Core close unconfirmed: ${error.code||error.message}`);}
    if(closed)await rm(root,{recursive:true,force:true});
    else{
      t.diagnostic(`Retained stopped-human fixture for diagnosis: ${root}`);
      if(['valid','extra-workspace-writer'].includes(variant))
        assert.fail('A clean human takeover fixture must confirm Core close');
    }
  });
  core=await createCore({dataDir,pluginDir,files:false,managedPythonPath:pythonPath});
  const project=core.store.project({name:'Disposable approval stop',directory:workspace});
  const created=core.store.createTask({projectId:project.id,title:'Original turn',executionProvider:'codex-autocontinue'});
  const task=core.store.updateTask(created.id,{status:'blocked'},created.revision);
  await core.plugin.configure({pythonPath,codexPath:fake,pollSeconds:86400});
  const session=await core.request('POST',`/api/tasks/${task.id}/session`,{
    expectedRevision:task.revision,commandId:'stopped-human-session',workspaceWrite:false});
  assert.equal(session.status,'created');
  const live=core.store.getTask(task.id),commandId='stopped-human-turn';
  const started=await core.request('POST',`/api/tasks/${task.id}/continue`,{
    expectedRevision:live.revision,commandId});
  assert.ok(['running','unknown','awaiting_approval'].includes(started.status));
  await until(async()=>JSON.parse(await readFile(hostState(dataDir),'utf8')),image=>{
    const command=image.commands?.[`${task.id}:${commandId}`],marker=image.executors?.[`task:${task.id}`];
    return marker?.status==='starting'&&command?.status==='running'&&typeof command.turnId==='string';
  },'durably running exact turn');
  await writeFile(env.TASKBOARD_FAKE_APPROVAL_GATE,'ready',{mode:0o600,flag:'wx'});
  const stopped=await until(async()=>JSON.parse(await readFile(hostState(dataDir),'utf8')),image=>
    image.executors?.[`task:${task.id}`]?.status==='stopped_unknown'&&
    image.commands?.[`${task.id}:${commandId}`]?.status==='unknown','approval-stop receipt');
  const marker=stopped.executors[`task:${task.id}`],command=stopped.commands[`${task.id}:${commandId}`];
  assert.deepEqual(marker.shutdownStoppedReceipt,marker.shutdownStopProof);
  assert.notEqual(command.stopProof?.status,'verified');
  assert.equal((await readJobRecord(marker.recordRoot,marker.recordId,task.id,workspace)).phase,'retired');
  await core.close();core=null;closed=true;
  if(variant==='missing-capture'){
    stopped.executors[`task:${task.id}`].captureComplete=false;
  }else if(variant==='mismatched-receipt'){
    stopped.executors[`task:${task.id}`].shutdownStoppedReceipt={
      ...marker.shutdownStoppedReceipt,commandId:'different-command'};
  }else if(variant==='other-unknown-command'){
    stopped.commands[`${task.id}:other-unknown`]={...command,commandId:'other-unknown'};
  }
  if(['missing-capture','mismatched-receipt','other-unknown-command'].includes(variant))
    await writeFile(hostState(dataDir),JSON.stringify(stopped),{mode:0o600});
  closed=false;
  core=await createCore({dataDir,pluginDir,files:false,managedPythonPath:pythonPath});
  assert.equal(core.leases.state().active.find(row=>row.taskId===task.id)?.status,'unknown');
  const serverName=`seqivo_stopped_${randomBytes(6).toString('hex')}`;
  await core.request('POST','/api/terminal/profiles',{id:'managed',label:'Disposable managed',
    projectId:project.id,enabled:true,shell:'/bin/sh',serverName,allowSharedServer:true,tmuxExecutable:tmuxPath});
  const frames=[],ctx={local:true,profileId:'managed',connectionId:'original-owner'},send=frame=>frames.push(frame);
  await core.terminal.frame(ctx,{v:1,type:'open',mode:'tmux',cols:80,rows:24},send);
  if(variant==='extra-workspace-writer'){
    writer=spawn('/bin/sh',['-c','read line'],{cwd:workspace,stdio:['pipe','ignore','ignore']});
    await once(writer,'spawn');
    await new Promise(resolve=>setTimeout(resolve,150));
  }
  await core.terminal.frame(ctx,{v:1,type:'takeover'},send);
  const control=frames.filter(frame=>frame.type==='control').at(-1);
  assert.equal(control?.phase,refusal?'unknown':'human',control?.reason||'No control frame');
  assert.equal(core.leases.state().active.find(row=>row.taskId===task.id)?.status,'unknown');
  assert.equal(core.leases.available({taskId:task.id,workspace}),false);
  if(!refusal){
    const policy=JSON.parse(await readFile(hostState(dataDir),'utf8')).policies.find(row=>row.taskId===task.id);
    assert.equal(policy?.status,'unknown');
    assert.equal(policy?.enabled,false);
    await core.terminal.frame(ctx,{v:1,type:'create',epoch:0,name:'human-after-stop'},send);
    const ready=frames.filter(frame=>frame.type==='ready').at(-1);
    assert.ok(ready?.sessionRef);
    const written=join(workspace,'human-after-stop.txt');
    await core.terminal.frame(ctx,{v:1,type:'input',epoch:ready.epoch,seq:1,
      data:Buffer.from(`printf HUMAN > '${written}'\n`).toString('base64')},send);
    await until(()=>readFile(written,'utf8'),text=>text==='HUMAN','human terminal input');
    await core.terminal.frame(ctx,{v:1,type:'input',epoch:ready.epoch,seq:2,
      data:Buffer.from('exit\n').toString('base64')},send);
  }
  const requests=(await readFile(env.TASKBOARD_FAKE_LOG,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(requests.filter(row=>row.method==='turn/start').length,1);
}

for(const variant of ['valid','missing-capture','mismatched-receipt','other-unknown-command','extra-workspace-writer']){
  test(`approval-stop human takeover: ${variant}`,{
    skip:process.platform!=='darwin',timeout:60000,
  },t=>exerciseStoppedTakeover(t,variant));
}
