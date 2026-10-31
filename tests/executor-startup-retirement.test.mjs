import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlugin, isUnresolvedShutdownTurn } from '../plugins/codex-autocontinue/host.mjs';
import * as taskJobs from '../plugins/codex-autocontinue/job-transport.mjs';
import { bootIdentity, readJobRecord, readRetiredJobRecord, writeJobRecord } from '../server/macos-executor-job-record.mjs';
import { createExecutionLeases } from '../server/execution-leases.mjs';
import { Store } from '../server/store.mjs';

const pythonPath=process.env.TASKBOARD_TEST_PYTHON;
const pluginDir=fileURLToPath(new URL('../plugins/codex-autocontinue/',import.meta.url));
const fakeSource=fileURLToPath(new URL('./plugin-fake-codex.py',import.meta.url));
const thisFile=fileURLToPath(import.meta.url);
const stateFile=root=>join(root,'state','codex-autocontinue.json');
const readState=async root=>JSON.parse(await readFile(stateFile(root),'utf8'));
const fixtureEnv=root=>({
  TASKBOARD_FAKE_SCENARIO:join(root,'scenario.json'),
  TASKBOARD_FAKE_LOG:join(root,'fake.log'),
  TASKBOARD_FAKE_PID:join(root,'fake.pid'),
  TASKBOARD_FAKE_CWD:root,
});
const errorText=error=>String(error?.message||error).slice(0,400);

test('the same late completion event does not invent a final idle proof during shutdown',()=>{
  const intent={taskId:'task-a',commandId:'command-a',threadId:'thread-a',turnId:'turn-a',
    bridgePid:123,workspace:'/private/tmp/fixture',worktreeId:null};
  const command={...intent,status:'running'};
  assert.equal(isUnresolvedShutdownTurn(command,intent),true);
  assert.equal(isUnresolvedShutdownTurn({...command,turnCompleteEvent:true},intent),true,
    'completion before intent is still unverified until the original final idle proof');
  assert.equal(isUnresolvedShutdownTurn({...command,turnCompleteEvent:true},intent,{allowUnknown:true}),true,
    'completion after intent does not invalidate the same original turn receipt');
  assert.equal(isUnresolvedShutdownTurn({...command,status:'unknown'},intent,{allowUnknown:true}),true);
  assert.equal(isUnresolvedShutdownTurn({...command,stopProof:{status:'verified'}},intent),false);
  assert.equal(isUnresolvedShutdownTurn({...command,turnId:'other'},intent),false);
  assert.equal(isUnresolvedShutdownTurn({...command,threadId:'other'},intent),false);
  assert.equal(isUnresolvedShutdownTurn({...command,bridgePid:124},intent),false);
});

function makeHost(root,store,leases,taskId,{beforeStateWrite=()=>{},onRetire=()=>{}}={}){
  return createPlugin({dataDir:join(root,'state'),pluginDir,taskJobBackend:taskJobs,
    beforeStateWrite,
    getTask:async id=>id===taskId?store.getTask(id):null,
    getProject:async id=>({...store.getProject(id),handoff:null,retirementHandoffGeneration:null}),
    updateTask:async(id,patch,revision)=>store.updateTask(id,patch,revision),
    reserveExecutorStartup:async input=>leases.reserveStartup({...input,provider:'codex-autocontinue'}),
    bindExecutorStartup:async input=>leases.bindStartup({...input,provider:'codex-autocontinue'}),
    confirmExecutorStartup:async input=>leases.confirmStartup({...input,provider:'codex-autocontinue'}),
    verifyExecutorStartup:async()=>({verified:true}),
    authorizeExecution:async input=>leases.reserve({...input,provider:'codex-autocontinue'}),
    revalidateExecution:async()=>({verified:true}),
    retireExecutorStartup:async input=>{
      onRetire();
      const marker=(await readState(root)).executors?.[`task:${taskId}`];
      assert.equal(marker?.recordId,input.recordId);
      const startupLease=input.shutdownUnknown?
        leases.startupFor({...input,provider:'codex-autocontinue'}):null;
      const historical=!!input.shutdownUnknown&&startupLease.status==='unknown'&&
        JSON.stringify(startupLease.shutdownStoppedReceipt)===JSON.stringify(input.shutdownUnknown);
      const record=await (historical?readRetiredJobRecord:readJobRecord)(
        marker.recordRoot,input.recordId,taskId,root);
      assert.equal(record.phase,'retired','the original job must actually be retired');
      if(input.shutdownUnknown){
        assert.deepEqual(input.settledCommands,[]);
        assert.deepEqual(marker.shutdownStopProof,input.shutdownUnknown);
        assert.equal(marker.captureComplete,true);
        assert.ok(marker.knownIdentities.length>=2);
        return leases.markShutdownStoppedUnknown({...input,provider:'codex-autocontinue',
          receipt:input.shutdownUnknown});
      }
      let lease;
      try{lease=leases.startupFor({...input,provider:'codex-autocontinue'});}
      catch(error){if(error.code!=='EXECUTION_NOT_FOUND')throw error;
        lease=leases.retiredStartupFor({...input,provider:'codex-autocontinue'});}
      const original=lease.status==='not_started'?lease.retirementReceipt.commandId:lease.commandId;
      const receipt=lease.status==='startup'||original===null?null:
        input.settledCommands.find(row=>row.commandId===original);
      if(lease.status!=='startup'&&!receipt)throw new Error('Original command receipt missing');
      return leases.retireStartup({...input,provider:'codex-autocontinue',
        settledCommandId:receipt?.commandId||null,settledStatus:receipt?.status||null});
    },
  });
}

if(process.env.SEQIVO_RETIRE_OWNER_CHILD!=='1')test('closing a live original turn retains an active unknown lease after exact job retirement',
  {skip:process.platform!=='darwin'},async t=>{
    assert.ok(pythonPath?.startsWith('/'),'Set absolute TASKBOARD_TEST_PYTHON');
    const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-shutdown-unknown-')));
    await mkdir(join(root,'state'));
    const fake=join(root,'fake-codex.py');
    await copyFile(fakeSource,fake);await chmod(fake,0o700);
    await writeFile(join(root,'scenario.json'),JSON.stringify({}));
    await writeFile(join(root,'fake.log'),'');
    const environment=fixtureEnv(root);
    const previous=Object.fromEntries(Object.keys(environment).map(key=>[key,process.env[key]]));
    Object.assign(process.env,environment);
    let store,plugin,closed=false,bodyPassed=false;
    t.after(async()=>{
      const failures=[];
      if(plugin&&!closed)try{await plugin.close();}catch(error){failures.push(error);}
      try{store?.close();}catch(error){failures.push(error);}
      for(const [key,value] of Object.entries(previous)){
        if(value===undefined)delete process.env[key];else process.env[key]=value;
      }
      if(bodyPassed&&failures.length===0){
        try{await rm(root,{recursive:true,force:true});}catch(error){failures.push(error);}
      } else t.diagnostic(`Shutdown fixture retained for diagnosis: ${root}`);
      if(failures.length)throw new AggregateError(failures,'Shutdown fixture cleanup failed');
    });
    store=new Store(join(root,'board.sqlite'));
    const project=store.project({name:'Shutdown unknown',directory:root});
    const created=store.createTask({projectId:project.id,title:'One in-flight turn',
      conversationId:'thread-original',executionProvider:'codex-autocontinue'});
    const task=store.updateTask(created.id,{status:'blocked'},created.revision);
    const leases=createExecutionLeases({store,inspect:async()=>({status:'completed'})});
    plugin=makeHost(root,store,leases,task.id);
    await plugin.configure({pythonPath,codexPath:fake,pollSeconds:86400});
    const commandId='shutdown-live-turn';
    assert.equal((await plugin.resume({taskId:task.id,expectedRevision:task.revision,commandId})).status,'running');
    const before=await readState(root);
    assert.equal(before.commands[`${task.id}:${commandId}`].turnCompleteEvent,undefined);
    await plugin.close();closed=true;
    const after=await readState(root),marker=after.executors[`task:${task.id}`];
    assert.equal(marker.status,'stopped_unknown');
    assert.deepEqual(marker.shutdownStoppedReceipt,marker.shutdownStopProof);
    assert.equal(after.commands[`${task.id}:${commandId}`].status,'unknown');
    assert.equal(after.commands[`${task.id}:${commandId}`].turnCompleteEvent,undefined);
    assert.equal(after.policies.find(row=>row.taskId===task.id)?.status,'unknown');
    assert.equal(leases.state().active.length,1);
    assert.equal(leases.state().active[0].status,'unknown');
    assert.deepEqual(await leases.reconcile(),{inspected:0,released:0,active:1});
    assert.equal((await readJobRecord(marker.recordRoot,marker.recordId,task.id,root)).phase,'retired');
    const requests=(await readFile(join(root,'fake.log'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(requests.filter(row=>row.method==='turn/start').length,1);
    bodyPassed=true;
  });

if(process.env.SEQIVO_RETIRE_OWNER_CHILD!=='1')test('failed pre-stop shutdown intent cannot become a post-stop receipt',
  {skip:process.platform!=='darwin'},async t=>{
    assert.ok(pythonPath?.startsWith('/'),'Set absolute TASKBOARD_TEST_PYTHON');
    const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-shutdown-intent-fault-')));
    const fake=join(root,'fake-codex.py');
    await mkdir(join(root,'state'));
    await copyFile(fakeSource,fake);await chmod(fake,0o700);
    await writeFile(join(root,'scenario.json'),JSON.stringify({}));
    await writeFile(join(root,'fake.log'),'');
    const environment=fixtureEnv(root);
    const previous=Object.fromEntries(Object.keys(environment).map(key=>[key,process.env[key]]));
    Object.assign(process.env,environment);
    let store,plugin,bodyPassed=false,closeAttempted=false,armed=false;
    t.after(async()=>{
      const failures=[];
      if(plugin&&!closeAttempted)try{await plugin.close();}catch(error){failures.push(error);}
      try{store?.close();}catch(error){failures.push(error);}
      for(const [key,value] of Object.entries(previous)){
        if(value===undefined)delete process.env[key];else process.env[key]=value;
      }
      if(bodyPassed&&failures.length===0){
        try{await rm(root,{recursive:true,force:true});}catch(error){failures.push(error);}
      }else t.diagnostic(`Shutdown fault fixture retained: ${root}`);
      if(failures.length)throw new AggregateError(failures,'Shutdown fault fixture cleanup failed');
    });
    store=new Store(join(root,'board.sqlite'));
    const project=store.project({name:'Shutdown intent fault',directory:root});
    const created=store.createTask({projectId:project.id,title:'One in-flight turn',
      conversationId:'thread-original',executionProvider:'codex-autocontinue'});
    const task=store.updateTask(created.id,{status:'blocked'},created.revision);
    const leases=createExecutionLeases({store,inspect:async()=>({status:'completed'})});
    plugin=makeHost(root,store,leases,task.id,{beforeStateWrite(image){
      if(armed&&JSON.parse(image).executors?.[`task:${task.id}`]?.shutdownStopIntent)
        throw new Error('fixture_intent_write_failed');
    }});
    await plugin.configure({pythonPath,codexPath:fake,pollSeconds:86400});
    const commandId='intent-fault-turn';
    assert.equal((await plugin.resume({taskId:task.id,expectedRevision:task.revision,commandId})).status,'running');
    armed=true;closeAttempted=true;
    await assert.rejects(plugin.close(),/fixture_intent_write_failed|retirement is unconfirmed|receipt missing/i);
    const marker=(await readState(root)).executors[`task:${task.id}`];
    assert.equal(marker?.shutdownStopIntent,undefined);
    assert.equal(marker?.shutdownStopProof,undefined);
    assert.equal(marker?.shutdownStoppedReceipt,undefined);
    assert.equal(leases.state().active.length,1);
    assert.notEqual(leases.state().active[0].status,'not_started');
    assert.equal((await readJobRecord(marker.recordRoot,marker.recordId,task.id,root)).phase,'retired');
    bodyPassed=true;
  });

async function ownerPhase(root){
  const store=new Store(join(root,'board.sqlite'));
  let armed=false,losses=0;
  try{
    const project=store.project({name:'Retirement receipt',directory:root});
    const created=store.createTask({projectId:project.id,title:'One original job',
      conversationId:'thread-original',executionProvider:'codex-autocontinue'});
    const task=store.updateTask(created.id,{status:'blocked'},created.revision);
    const leases=createExecutionLeases({store,inspect:async()=>({status:'unknown'})});
    const plugin=makeHost(root,store,leases,task.id,{beforeStateWrite(image){
      const state=JSON.parse(image);
      if(armed&&!state.executors?.[`task:${task.id}`]){
        losses++;throw new Error('fixture_marker_delete_receipt_lost');
      }
    }});
    await plugin.configure({pythonPath,codexPath:join(root,'fake-codex.py'),pollSeconds:86400});
    const commandId='original-turn';
    assert.equal((await plugin.resume({taskId:task.id,expectedRevision:task.revision,commandId})).status,'running');
    assert.equal(leases.state().active.length,1);
    armed=true;
    const paused=await plugin.pause({taskId:task.id,expectedRevision:store.getTask(task.id).revision});
    assert.equal(paused.status,'unknown');
    assert.equal(losses,1);
    const state=await readState(root),marker=state.executors?.[`task:${task.id}`];
    assert.equal(marker?.status,'retirement_unknown');
    assert.equal(marker.finalTurnProof?.commandKey,`${task.id}:${commandId}`);
    assert.equal((await readJobRecord(marker.recordRoot,marker.recordId,task.id,root)).phase,'retired');
    assert.equal(leases.state().active.length,0);
    assert.notEqual(state.commands[`${task.id}:${commandId}`].stopProof?.status,'verified');
    await writeFile(join(root,'owner-phase.json'),JSON.stringify({taskId:task.id,projectId:project.id}),{mode:0o600});
  }finally{store.close();}
  // Deliberately leave the original host unclosed, as a crash would. The
  // independently proven job is retired; process exit makes owner death real.
}

async function shutdownOwnerPhase(root){
  const store=new Store(join(root,'board.sqlite'));
  try{
    const project=store.project({name:'Shutdown owner',directory:root});
    const created=store.createTask({projectId:project.id,title:'One in-flight turn',
      conversationId:'thread-original',executionProvider:'codex-autocontinue'});
    const task=store.updateTask(created.id,{status:'blocked'},created.revision);
    const leases=createExecutionLeases({store,inspect:async()=>({status:'unknown'})});
    const loseFinal=process.env.SEQIVO_RETIRE_SHUTDOWN_FINAL_WRITE_FAIL==='1';
    let armed=false,losses=0;
    const plugin=makeHost(root,store,leases,task.id,{beforeStateWrite(image){
      if(loseFinal&&armed&&losses===0&&
          JSON.parse(image).executors?.[`task:${task.id}`]?.status==='stopped_unknown'){
        losses++;throw new Error('fixture_final_host_receipt_write_failed');
      }
    }});
    await plugin.configure({pythonPath,codexPath:join(root,'fake-codex.py'),pollSeconds:86400});
    assert.equal((await plugin.resume({taskId:task.id,expectedRevision:task.revision,
      commandId:'shutdown-original-turn'})).status,'running');
    armed=true;
    if(loseFinal){
      await assert.rejects(plugin.close(),/fixture_final_host_receipt_write_failed/);
      assert.equal(losses,1);
    }else await plugin.close();
    assert.equal(leases.state().active[0].status,'unknown');
    const marker=(await readState(root)).executors[`task:${task.id}`];
    assert.equal((await readJobRecord(marker.recordRoot,marker.recordId,task.id,root)).phase,'retired');
    await writeFile(join(root,'shutdown-owner.json'),JSON.stringify({taskId:task.id,
      finalWriteFailed:loseFinal}),{mode:0o600});
  }finally{store.close();}
}

if(process.env.SEQIVO_RETIRE_OWNER_CHILD==='1'){
  try{
    if(process.env.SEQIVO_RETIRE_SHUTDOWN_CHILD==='1')await shutdownOwnerPhase(process.env.SEQIVO_RETIRE_ROOT);
    else await ownerPhase(process.env.SEQIVO_RETIRE_ROOT);
    process.exit(0);
  }
  catch(error){
    await writeFile(join(process.env.SEQIVO_RETIRE_ROOT,'owner-error.txt'),
      `${error?.code||'ERROR'}: ${errorText(error)}\n`,{mode:0o600}).catch(()=>{});
    process.exit(1);
  }
}else for(const variant of ['complete','final-write-fail'])test(`a stopped-unknown original job stays fenced after owner exit and simulated boot change (${variant})`,
  {skip:process.platform!=='darwin'},async t=>{
    assert.ok(pythonPath?.startsWith('/'),'Set absolute TASKBOARD_TEST_PYTHON');
    const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-shutdown-reopen-')));
    await mkdir(join(root,'state'));
    const fake=join(root,'fake-codex.py');await copyFile(fakeSource,fake);await chmod(fake,0o700);
    await writeFile(join(root,'scenario.json'),JSON.stringify({}));
    await writeFile(join(root,'fake.log'),'');
    const environment=fixtureEnv(root),previous=Object.fromEntries(Object.keys(environment).map(key=>[key,process.env[key]]));
    Object.assign(process.env,environment);
    let store,plugin,bodyPassed=false;
    t.after(async()=>{
      const failures=[];
      try{await plugin?.close();}catch(error){failures.push(error);}
      try{store?.close();}catch(error){failures.push(error);}
      for(const [key,value] of Object.entries(previous)){
        if(value===undefined)delete process.env[key];else process.env[key]=value;
      }
      if(bodyPassed&&failures.length===0){
        try{await rm(root,{recursive:true,force:true});}catch(error){failures.push(error);}
      }else t.diagnostic(`Shutdown reopening fixture retained: ${root}`);
      if(failures.length)throw new AggregateError(failures,'Shutdown reopening cleanup failed');
    });
    const child=spawn(process.execPath,[thisFile],{env:{...process.env,...environment,
      SEQIVO_RETIRE_OWNER_CHILD:'1',SEQIVO_RETIRE_SHUTDOWN_CHILD:'1',
      SEQIVO_RETIRE_SHUTDOWN_FINAL_WRITE_FAIL:variant==='final-write-fail'?'1':'0',
      SEQIVO_RETIRE_ROOT:root},
      stdio:['ignore','pipe','pipe']});
    let childStderr='';child.stderr.on('data',chunk=>{childStderr+=chunk.toString().slice(0,1000);});
    child.stdout.resume();
    const childExit=await new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
    });
    await writeFile(join(root,'shutdown-owner-stderr.txt'),childStderr.slice(0,2000),{mode:0o600});
    assert.deepEqual(childExit,{code:0,signal:null});
    const {taskId}=JSON.parse(await readFile(join(root,'shutdown-owner.json'),'utf8'));
    store=new Store(join(root,'board.sqlite'));
    const leases=createExecutionLeases({store,inspect:async()=>({status:'unknown'})});
    const marker=(await readState(root)).executors[`task:${taskId}`];
    if(variant==='complete'){
      plugin=makeHost(root,store,leases,taskId);
      await plugin.close();plugin=null;
      assert.equal(leases.state().active[0].status,'unknown');
    }else{
      assert.notEqual(marker.status,'stopped_unknown');
      assert.equal(marker.shutdownStoppedReceipt,undefined);
      assert.deepEqual(leases.startupFor({taskId,startupId:marker.startupId,
        provider:'codex-autocontinue',recordId:marker.recordId}).shutdownStoppedReceipt,
        marker.shutdownStopProof);
    }
    const original=await readJobRecord(marker.recordRoot,marker.recordId,taskId,root);
    const [sec,usec]=(await bootIdentity()).split(':');
    await writeJobRecord(marker.recordRoot,{...original,boot:`${BigInt(sec)-1n}:${usec}`,
      generation:original.generation+1},original.generation);
    plugin=makeHost(root,store,leases,taskId);
    await plugin.close();plugin=null;
    assert.equal(leases.state().active[0].status,'unknown');
    assert.equal((await readRetiredJobRecord(marker.recordRoot,marker.recordId,taskId,root)).phase,'retired');
    const requests=(await readFile(join(root,'fake.log'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(requests.filter(row=>row.method==='turn/start').length,1);
    if(variant==='complete'){
      const historical=await readRetiredJobRecord(marker.recordRoot,marker.recordId,taskId,root);
      await writeJobRecord(marker.recordRoot,{...historical,phase:'stop_intent',
        generation:historical.generation+1},historical.generation);
      await assert.rejects(taskJobs.auditTaskJobIndex(marker.recordRoot,(await readState(root)).executors),
        /job_record_binding_unconfirmed/,'old-boot nonretired jobs must remain unknown');
    }
    bodyPassed=true;
  });

if(process.env.SEQIVO_RETIRE_OWNER_CHILD!=='1')for(const variant of ['original-pause','startup-policy','other-unknown']){
  test(`a crashed owner rechecks retired job without replay (${variant})`,
    {skip:process.platform!=='darwin'},async t=>{
      assert.ok(pythonPath?.startsWith('/'),'Set absolute TASKBOARD_TEST_PYTHON');
      const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-startup-retire-')));
      const stateDir=join(root,'state'),fake=join(root,'fake-codex.py');
      await mkdir(stateDir);await copyFile(fakeSource,fake);await chmod(fake,0o700);
      await writeFile(join(root,'scenario.json'),JSON.stringify({notifyInterrupted:true}));
      await writeFile(join(root,'fake.log'),'');
      const environment=fixtureEnv(root);
      const previous=Object.fromEntries(Object.keys(environment).map(key=>[key,process.env[key]]));
      Object.assign(process.env,environment);
      let store=null,plugin=null,otherRoot=null,bodyPassed=false,retireCalls=0;
      t.after(async()=>{
        const failures=[];
        try{if(plugin)await plugin.close();}catch(error){failures.push(new Error('Reopened host close unconfirmed',{cause:error}));}
        try{store?.close();}catch(error){failures.push(new Error('Isolated Store close failed',{cause:error}));}
        if(otherRoot)try{await rm(otherRoot,{recursive:true,force:true});}
        catch(error){failures.push(new Error('Independent fixture cleanup failed',{cause:error}));}
        for(const [key,value] of Object.entries(previous)){
          if(value===undefined)delete process.env[key];else process.env[key]=value;
        }
        if(failures.length||!bodyPassed){
          t.diagnostic(`Retained isolated retirement fixture: ${root}`);
          if(failures.length)throw new AggregateError(failures,'Isolated retirement cleanup unconfirmed');
          return;
        }
        await rm(root,{recursive:true,force:true});
      });
      const child=spawn(process.execPath,[thisFile],{
        env:{...process.env,...environment,SEQIVO_RETIRE_OWNER_CHILD:'1',SEQIVO_RETIRE_ROOT:root},
        stdio:['ignore','pipe','pipe']});
      let childStderr='';
      child.stderr.on('data',chunk=>{childStderr+=chunk.toString().slice(0,1000);});
      child.stdout.resume();
      const childExit=await new Promise((resolve,reject)=>{
        child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));
      });
      await writeFile(join(root,'owner-stderr.txt'),childStderr.slice(0,2000),{mode:0o600});
      assert.deepEqual(childExit,{code:0,signal:null},
        'original host must terminate after the lost marker receipt');
      const {taskId}=JSON.parse(await readFile(join(root,'owner-phase.json'),'utf8'));
      store=new Store(join(root,'board.sqlite'));
      const leases=createExecutionLeases({store,inspect:async()=>({status:'unknown'})});
      const original=(await readState(root)).executors[`task:${taskId}`].finalTurnProof;
      const startupImage=await readState(root),startupMarker=startupImage.executors[`task:${taskId}`];
      const startupPolicy=startupImage.policies.find(policy=>policy.taskId===taskId);
      assert.equal(startupPolicy?.status,'unknown');
      assert.equal(startupPolicy.executorRetirementUnknown?.commandId,'original-turn',
        'the original pause path must durably identify its uncertain command');
      if(variant==='startup-policy'){
        // Separately exercise a startup-origin reminder against the same real
        // retired job. Never substitute this fixture for the original case.
        delete startupPolicy.executorRetirementUnknown;
        startupPolicy.executorStartupUnknown={startupId:startupMarker.startupId,
          recordId:startupMarker.recordId,priorUnknown:false};
        await writeFile(stateFile(root),`${JSON.stringify(startupImage)}\n`,{mode:0o600});
      }else if(variant==='other-unknown'){
        startupImage.commands[`${taskId}:other-command`]={taskId,commandId:'other-command',
          status:'unknown',bridgePid:-1,workspace:root};
        await writeFile(stateFile(root),`${JSON.stringify(startupImage)}\n`,{mode:0o600});
      }
      otherRoot=await realpath(await mkdtemp(join(tmpdir(),'seqivo-independent-startup-')));
      const otherProject=store.project({name:'Independent workspace',directory:otherRoot});
      const otherTask=store.createTask({projectId:otherProject.id,title:'Independent lease',
        executionProvider:'codex-autocontinue'});
      leases.reserveStartup({taskId:otherTask.id,startupId:'independent-startup',
        provider:'codex-autocontinue',workspace:otherRoot,worktreeId:null,purpose:'session',
        expectedRevision:otherTask.revision,expectedHandoffGeneration:null});
      assert.equal(leases.state().active.length,1);
      const beforeRetry=store.db.prepare('SELECT value FROM metadata WHERE key=?')
        .get('execution.leases.v1').value;
      const corrupted=await readState(root);
      corrupted.executors[`task:${taskId}`].finalTurnProof={...original,turnId:'wrong-turn'};
      await writeFile(stateFile(root),`${JSON.stringify(corrupted)}\n`,{mode:0o600});
      plugin=makeHost(root,store,leases,taskId,{onRetire:()=>retireCalls++});
      const wrongTurn=await plugin.reconcile({taskId,
        expectedRevision:store.getTask(taskId).revision});
      assert.equal(wrongTurn.status,'unknown');
      assert.equal(plugin.state().policies.find(policy=>policy.taskId===taskId)?.status,'unknown');
      assert.ok((await readState(root)).executors?.[`task:${taskId}`]);
      assert.notEqual((await readState(root)).commands[`${taskId}:original-turn`].stopProof?.status,'verified');
      await assert.rejects(plugin.close(), {
        message: 'Original final turn proof is unavailable or changed',
      });
      plugin=null;
      const restored=await readState(root);
      restored.executors[`task:${taskId}`].finalTurnProof=original;
      await writeFile(stateFile(root),`${JSON.stringify(restored)}\n`,{mode:0o600});
      const beforeEdit=store.getTask(taskId);
      const edited=store.updateTask(taskId,{summary:'New requirements after original turn retired'},
        beforeEdit.revision);
      assert.ok(edited.contentVersion>beforeEdit.contentVersion);
      plugin=makeHost(root,store,leases,taskId,{onRetire:()=>retireCalls++});
      const recovered=await plugin.reconcile({taskId,
        expectedRevision:store.getTask(taskId).revision});
      assert.equal(recovered.status,variant==='other-unknown'?'unknown':'stale_result');
      assert.ok(retireCalls>=1);
      const finalState=await readState(root);
      assert.equal(finalState.executors?.[`task:${taskId}`],undefined);
      assert.equal(finalState.commands[`${taskId}:original-turn`].stopProof?.status,'verified');
      assert.equal(finalState.commands[`${taskId}:original-turn`].stale,true);
      assert.equal(finalState.policies.find(policy=>policy.taskId===taskId)?.status,
        variant==='other-unknown'?'unknown':'stale_result');
      assert.equal(finalState.policies.find(policy=>policy.taskId===taskId)?.executorStartupUnknown,undefined);
      assert.equal(finalState.policies.find(policy=>policy.taskId===taskId)?.executorRetirementUnknown,undefined);
      assert.equal(store.getTask(taskId).status,edited.status);
      assert.equal(store.getTask(taskId).contentVersion,edited.contentVersion);
      assert.equal(store.db.prepare('SELECT value FROM metadata WHERE key=?')
        .get('execution.leases.v1').value,beforeRetry);
      assert.equal(leases.state().active[0].taskId,otherTask.id);
      const requests=(await readFile(join(root,'fake.log'),'utf8')).trim()
        .split('\n').filter(Boolean).map(JSON.parse);
      assert.equal(requests.filter(row=>row.method==='turn/start').length,1);
      bodyPassed=true;
    });
}
