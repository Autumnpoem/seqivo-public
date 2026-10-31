import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, mkdir, mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createExecutionLeases } from '../server/execution-leases.mjs';
import { createPreviewRegistry } from '../server/preview/registry.mjs';
import { createControlledPreviewBuilds } from '../server/preview/controlled-build.mjs';
import { prepareExecutorJob, recoverExecutorJob } from '../server/macos-executor-job.mjs';
import { readJobRecord } from '../server/macos-executor-job-record.mjs';

const run=promisify(execFile);
const PYTHON=process.env.SEQIVO_TEST_PYTHON;
const gitEnv=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_')));
const hash=value=>createHash('sha256').update(value).digest('hex');

test('abandon wins before spawn and the exact never-started record remains retired',
  {skip:process.platform!=='darwin'||!PYTHON?'Mac and explicit SEQIVO_TEST_PYTHON are required':false},async t=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-preview-abandon-race-')));
    await chmod(root,0o700);
    const jobRoot=join(root,'preview-build-jobs');
    await mkdir(jobRoot,{mode:0o700});
    const store=new Store(join(root,'board.sqlite'));
    let clean=false;
    t.after(async()=>{store.close();if(clean)await rm(root,{recursive:true,force:true});});
    const taskId='preview-abandon-race';
    const job=await prepareExecutorJob({taskId,command:'/bin/cat',cwd:root,
      pythonPath:PYTHON,recordRoot:jobRoot});
    // A caller-controlled boolean cannot turn an actual prepared record into
    // confirmed retirement at Core shutdown.
    const manager=createControlledPreviewBuilds({store,dataDir:root,pythonPath:PYTHON});
    store.db.prepare('INSERT INTO preview_controlled_builds(request_id,value) VALUES(?,?)')
      .run('forged-retirement',JSON.stringify({requestId:'forged-retirement',state:'ready',
        taskId,recordId:job.recordId,jobWorkspace:root,attempted:true,jobRetired:true}));
    await assert.rejects(manager.close(),error=>error instanceof AggregateError&&
      error.errors.length===1);
    const abandoning=job.abandonPrepared();
    await assert.rejects(job.spawn(),/job_stop_already_requested/);
    assert.deepEqual(await abandoning,{verified:true,retired:true,neverSubmitted:true});
    await assert.rejects(job.abandonPrepared(),/job_prepare_abandon_unconfirmed/);
    const record=await readJobRecord(jobRoot,job.recordId,taskId,root);
    assert.equal(record.phase,'retired');
    assert.equal(record.attempted,false);
    assert.equal(record.identity,null);
    await job.dispose();
    clean=true;
  });

test('a recovered prepared handle cannot claim original-owner never-started authority',
  {skip:process.platform!=='darwin'||!PYTHON?'Mac and explicit SEQIVO_TEST_PYTHON are required':false},async t=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-preview-abandon-recovered-')));
    await chmod(root,0o700);
    let clean=false;
    t.after(async()=>{if(clean)await rm(root,{recursive:true,force:true});});
    const taskId='preview-abandon-recovered';
    const moduleUrl=new URL('../server/macos-executor-job.mjs',import.meta.url).href;
    const script=`import { prepareExecutorJob } from ${JSON.stringify(moduleUrl)};\n`
      +`const job=await prepareExecutorJob({taskId:${JSON.stringify(taskId)},command:'/bin/cat',`
      +`cwd:${JSON.stringify(root)},pythonPath:${JSON.stringify(PYTHON)},recordRoot:${JSON.stringify(root)}});\n`
      +`process.stdout.write(JSON.stringify({recordId:job.recordId})+'\\n');`;
    const {stdout}=await run(process.execPath,['--input-type=module','-e',script],
      {cwd:root,timeout:15000});
    const {recordId}=JSON.parse(stdout.trim());
    const recovered=await recoverExecutorJob({recordRoot:root,recordId,taskId,cwd:root,pythonPath:PYTHON});
    assert.equal(recovered.verified,true);
    await assert.rejects(recovered.job.abandonPrepared(),/job_prepare_abandon_unconfirmed/);
    const record=await readJobRecord(root,recordId,taskId,root);
    assert.equal(record.phase,'prepared');
    assert.equal(record.attempted,false);
    await recovered.job.dispose();
    clean=true;
  });

test('a forged output-ready intent cannot publish against an original job still prepared',
  {skip:process.platform!=='darwin'||!PYTHON?'Mac and explicit SEQIVO_TEST_PYTHON are required':false},async t=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-preview-unretired-')));
    await chmod(root,0o700);
    const projectDir=join(root,'project'),jobRoot=join(root,'preview-build-jobs');
    await mkdir(projectDir);await mkdir(jobRoot,{mode:0o700});
    const store=new Store(join(root,'board.sqlite'));
    let clean=false;
    t.after(async()=>{store.close();if(clean)await rm(root,{recursive:true,force:true});});
    const project=store.project({name:'Unretired preview',directory:projectDir});
    const task=store.createTask({projectId:project.id,title:'Original job'});
    const job=await prepareExecutorJob({taskId:task.id,command:'/bin/cat',cwd:projectDir,
      pythonPath:PYTHON,recordRoot:jobRoot});
    const digest='a'.repeat(64),requestId='unretired-original',previewId='unretired-preview';
    const row={requestId,state:'output_ready',projectId:project.id,taskId:task.id,
      expectedRevision:task.revision,contentVersion:task.contentVersion,
      workspace:projectDir,projectDirectory:projectDir,worktreeId:null,
      nodeBinding:'isolated-node',recordId:job.recordId,jobWorkspace:projectDir,
      attempted:true,jobRetired:true,previewId,sourceCommit:'b'.repeat(40),
      sourceDigest:digest,inputDigest:digest,toolDigest:digest,buildReceiptDigest:digest,
      artifactDigest:digest,dataMode:'simulated',apiTarget:'static',dataStoreId:null};
    const manifest={previewId,projectId:project.id,taskId:task.id,sourceTaskRevision:task.revision,
      contentVersion:task.contentVersion,sourceCommit:row.sourceCommit,artifactDigest:digest,
      dataMode:'simulated',apiTarget:'static',dataStoreId:null,
      provenance:{kind:'managed-vite-vanilla-v1',sourceDigest:digest,inputDigest:digest,
        toolDigest:digest,buildReceiptDigest:digest,
        profileDigest:hash('vite-vanilla-v1:configFile=false:envDir=false:envPrefix=[]:publicDir=false:postcss=[]:base=./')}};
    const events=[];
    const manager=createControlledPreviewBuilds({store,dataDir:root,pythonPath:PYTHON,
      leases:{updatePreviewBuild:()=>events.push('lease')},
      registry:{get:async()=>manifest},local:{record:()=>events.push('local')},
      records:{bind:()=>events.push('records')},assertAuthority:()=>{},
      resolveWorktree:()=>projectDir,nodeBinding:()=>row.nodeBinding,
      link:()=>({refresh:async()=>events.push('refresh'),queryRegistration:async()=>false,
        register:async()=>events.push('hub')})});
    store.db.prepare('INSERT INTO preview_controlled_builds(request_id,value) VALUES(?,?)')
      .run(requestId,JSON.stringify(row));
    assert.equal((await manager.reconcile(requestId)).build.state,'output_ready');
    assert.deepEqual(events,[]);
    assert.equal((await readJobRecord(jobRoot,job.recordId,task.id,projectDir)).phase,'prepared');
    assert.equal((await job.abandonPrepared()).neverSubmitted,true);
    await assert.rejects(manager.close(),error=>error instanceof AggregateError&&
      error.errors.length===1);
    clean=true;
  });

test('publication refresh barrier keeps changed revision historical-only and missing registration unknown',
  {skip:process.platform!=='darwin'||!PYTHON?'Mac and explicit SEQIVO_TEST_PYTHON are required':false},async t=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-preview-publish-barrier-')));
    await chmod(root,0o700);
    const projectDir=join(root,'project'),dataDir=join(root,'data'),jobRoot=join(dataDir,'preview-build-jobs');
    await mkdir(projectDir);await mkdir(dataDir,{mode:0o700});await mkdir(jobRoot,{mode:0o700});
    const store=new Store(join(dataDir,'board.sqlite'));
    let clean=false;
    t.after(async()=>{store.close();if(clean)await rm(root,{recursive:true,force:true});});
    const project=store.project({name:'Barrier preview',directory:projectDir});
    const events=[];
    for(const found of [true,false]){
      const task=store.createTask({projectId:project.id,title:`Revision ${found}`});
      const job=await prepareExecutorJob({taskId:task.id,command:'/bin/cat',cwd:projectDir,
        pythonPath:PYTHON,recordRoot:jobRoot});
      await job.spawn();
      const retired=await job.stop();
      assert.equal(retired.retired,true);
      const requestId=`barrier-${found}`,previewId=`preview-${found}`,digest='a'.repeat(64);
      const row={requestId,state:'output_ready',projectId:project.id,taskId:task.id,
        expectedRevision:task.revision,contentVersion:task.contentVersion,
        workspace:projectDir,projectDirectory:projectDir,worktreeId:null,nodeBinding:'original-node',
        recordId:job.recordId,jobWorkspace:projectDir,attempted:true,jobRetired:true,
        previewId,sourceCommit:'b'.repeat(40),sourceDigest:digest,inputDigest:digest,
        toolDigest:digest,buildReceiptDigest:digest,artifactDigest:digest,dataMode:'simulated',
        apiTarget:'static',dataStoreId:null,criteria:[]};
      const manifest={previewId,projectId:project.id,taskId:task.id,
        contentVersion:task.contentVersion,sourceTaskRevision:task.revision,sourceCommit:row.sourceCommit,
        artifactDigest:digest,dataMode:'simulated',apiTarget:'static',dataStoreId:null,
        provenance:{kind:'managed-vite-vanilla-v1',sourceDigest:digest,inputDigest:digest,
          toolDigest:digest,buildReceiptDigest:digest,
          profileDigest:hash('vite-vanilla-v1:configFile=false:envDir=false:envPrefix=[]:publicDir=false:postcss=[]:base=./')}};
      let entered;const atRefresh=new Promise(resolve=>{entered=resolve;});
      let release;const gate=new Promise(resolve=>{release=resolve;});
      const manager=createControlledPreviewBuilds({store,dataDir,pythonPath:PYTHON,
        leases:{updatePreviewBuild:()=>events.push(['lease',requestId])},
        registry:{get:async()=>manifest,markRegistered:async()=>events.push(['mark',requestId])},
        local:{record:()=>events.push(['local',requestId])},
        records:{bind:()=>assert.fail('static build')},assertAuthority:()=>{},
        assertHistoricalAuthority:()=>{},resolveWorktree:()=>projectDir,
        nodeBinding:()=>row.nodeBinding,
        link:()=>({refresh:async()=>{entered();await gate;},
          queryRegistration:async(_id,{beforeSend})=>{beforeSend(manifest);return found;},
          register:async()=>events.push(['register',requestId])})});
      store.db.prepare('INSERT INTO preview_controlled_builds(request_id,value) VALUES(?,?)')
        .run(requestId,JSON.stringify(row));
      const pending=manager.reconcile(requestId);
      await atRefresh;
      const revised=store.updateTask(task.id,{nextStep:'Edited during registration refresh'},task.revision);
      assert.equal(revised.revision,task.revision+1);
      assert.equal(revised.contentVersion,task.contentVersion);
      release();
      const result=await pending;
      assert.equal(events.some(item=>item[0]==='register'&&item[1]===requestId),false);
      assert.equal(events.some(item=>item[0]==='local'&&item[1]===requestId),found);
      assert.equal(result.build.state,found?'ready':'output_ready');
      await manager.close();
    }
    clean=true;
  });

test('lost first Hub ACK recovers the original Vite artifact and serves HTML and JavaScript',
  {skip:process.platform!=='darwin'||!PYTHON?'Mac and explicit SEQIVO_TEST_PYTHON are required':false},async t=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-preview-controlled-native-')));
    await chmod(root,0o700);
    const projectDir=join(root,'project'),dataDir=join(root,'data');
    await mkdir(projectDir);await mkdir(dataDir,{mode:0o700});
    let store,manager,bodySucceeded=false;
    t.after(async()=>{
      const failures=[];
      try{if(manager)await manager.close();}catch(error){failures.push(error);}
      try{store?.close();}catch(error){failures.push(error);}
      if(bodySucceeded&&!failures.length)await rm(root,{recursive:true,force:true});
      if(failures.length)throw new AggregateError(failures,`Controlled preview cleanup unconfirmed; private fixture retained: ${root}`);
    });
    const git=async(...args)=>run('/usr/bin/git',args,{cwd:projectDir,env:gitEnv,timeout:10000});
    await git('init','-q');
    await mkdir(join(projectDir,'src'));
    await writeFile(join(projectDir,'index.html'),
      '<!doctype html><html><body><div id="app"></div><script type="module" src="./src/main.js"></script></body></html>');
    await writeFile(join(projectDir,'src/main.js'),
      'import "./style.css"; document.getElementById("app").textContent="controlled build ready";');
    await writeFile(join(projectDir,'src/style.css'),'body{color:#123456}');
    await git('add','index.html','src/main.js','src/style.css');
    await git('-c','user.name=Preview Test','-c','user.email=preview@example.invalid',
      'commit','-qm','fixture');
    store=new Store(join(dataDir,'board.sqlite'));
    const project=store.project({name:'Controlled preview',directory:projectDir});
    const task=store.createTask({projectId:project.id,title:'Build test'});
    const leases=createExecutionLeases({store,inspect:async()=>({status:'unknown'})});
    const registry=createPreviewRegistry({dataDir});
    const published=[];let hubHasOriginal=false,registerCalls=0;
    manager=createControlledPreviewBuilds({store,leases,registry,
      local:{record:manifest=>published.push(['local',manifest.previewId])},
      records:{bind:()=>assert.fail('static build must not bind records')},
      dataDir,pythonPath:PYTHON,assertAuthority:()=>{},
      resolveWorktree:()=>assert.fail('no worktree selected'),
      nodeBinding:()=> 'isolated-node-binding',
      prepareJob:async options=>{
        const original=await prepareExecutorJob(options);
        return {recordId:original.recordId,abandonPrepared:()=>original.abandonPrepared(),
          inspect:()=>original.inspect(),stop:()=>original.stop(),
          spawn:async()=>{
            const starting=original.spawn();
            await assert.rejects(original.abandonPrepared(),/job_prepare_abandon_unconfirmed/);
            return starting;
          }};
      },
      link:()=>({refresh:async()=>{},queryRegistration:async()=>hubHasOriginal,
        register:async id=>{registerCalls++;hubHasOriginal=true;published.push(['hub',id]);
          throw Error('simulated_original_hub_ack_lost');}})});
    const requestId='controlled-build-native-1';
    const started=manager.start({requestId,projectId:project.id,taskId:task.id,
      expectedRevision:task.revision,contentVersion:task.contentVersion,
      worktreeId:null,profile:'vite-vanilla-v1',apiTarget:'static',dataMode:'simulated'});
    assert.equal(started.build.requestId,requestId);
    let current;
    const deadline=Date.now()+90000;
    do{
      await new Promise(resolve=>setTimeout(resolve,150));
      current=manager.state(requestId).build;
      if(['failed_no_publish','unknown'].includes(current.state)||
        current.state==='output_ready'&&current.errorCode==='BUILD_PUBLISH_UNKNOWN')break;
    }while(current.state!=='ready'&&Date.now()<deadline);
    assert.equal(current.state,'output_ready');
    assert.equal(current.errorCode,'BUILD_PUBLISH_UNKNOWN');
    assert.equal(await registry.isRegistered(current.previewId),false);
    assert.equal(registerCalls,1);
    current=(await manager.reconcile(requestId)).build;
    assert.equal(current.state,'ready',`controlled build state: ${current.state} (${current.errorCode||'none'})`);
    const manifest=await registry.get(current.previewId);
    assert.equal(manifest.environment,'受控构建 · 隔离预览');
    assert.equal(manifest.artifactDigest,current.artifactDigest);
    assert.equal(manifest.provenance.kind,'managed-vite-vanilla-v1');
    assert.equal(await registry.isRegistered(current.previewId),true);
    assert.equal((await registry.read(current.previewId,'index.html')).bytes.includes(Buffer.from('src=')),true);
    const jsPath=manifest.files.find(file=>file.path.endsWith('.js'))?.path;
    assert.ok(jsPath);
    assert.equal((await registry.read(current.previewId,jsPath)).bytes.includes(Buffer.from('controlled build ready')),true);
    assert.deepEqual(published.map(item=>item[0]),['hub','local']);
    assert.equal(registerCalls,1);
    assert.equal(leases.state().active.length,0);
    bodySucceeded=true;
  });

test('a task edit after preparing the original Mac job abandons the unstarted record without spawning',
  {skip:process.platform!=='darwin'||!PYTHON?'Mac and explicit SEQIVO_TEST_PYTHON are required':false},async t=>{
    const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-preview-abandon-native-')));
    await chmod(root,0o700);
    const projectDir=join(root,'project'),dataDir=join(root,'data');
    await mkdir(projectDir);await mkdir(dataDir,{mode:0o700});
    let store,manager,clean=false;
    t.after(async()=>{
      const failures=[];
      try{await manager?.close();}catch(error){failures.push(error);}
      try{store?.close();}catch(error){failures.push(error);}
      if(clean&&!failures.length)await rm(root,{recursive:true,force:true});
      if(failures.length)throw new AggregateError(failures,`Prepared job cleanup unconfirmed; fixture retained: ${root}`);
    });
    const git=async(...args)=>run('/usr/bin/git',args,{cwd:projectDir,env:gitEnv,timeout:10000});
    await git('init','-q');
    await writeFile(join(projectDir,'index.html'),'<script type="module" src="./main.js"></script>');
    await writeFile(join(projectDir,'main.js'),'document.body.textContent="ready";');
    await git('add','index.html','main.js');
    await git('-c','user.name=Preview Test','-c','user.email=preview@example.invalid','commit','-qm','fixture');
    store=new Store(join(dataDir,'board.sqlite'));
    const project=store.project({name:'Abandon preview',directory:projectDir});
    const task=store.createTask({projectId:project.id,title:'Before edit'});
    const leases=createExecutionLeases({store,inspect:async()=>({status:'unknown'})});
    let spawnCalls=0;
    manager=createControlledPreviewBuilds({store,leases,
      registry:createPreviewRegistry({dataDir}),local:{record:()=>assert.fail('must not publish')},
      records:{bind:()=>assert.fail('must not bind')},dataDir,pythonPath:PYTHON,
      resolveWorktree:()=>assert.fail('no worktree'),nodeBinding:()=> 'isolated-node-binding',
      assertAuthority:()=>{},link:()=>({refresh:async()=>{},register:async()=>{}}),
      prepareJob:async options=>{
        const original=await prepareExecutorJob(options);
        store.updateTask(task.id,{summary:'Edited after prepare'},task.revision);
        return {recordId:original.recordId,
          abandonPrepared:()=>original.abandonPrepared(),
          spawn:()=>{spawnCalls++;return original.spawn();},stop:()=>original.stop()};
      }});
    const requestId='controlled-abandon-1';
    manager.start({requestId,projectId:project.id,taskId:task.id,
      expectedRevision:task.revision,contentVersion:task.contentVersion,worktreeId:null,
      profile:'vite-vanilla-v1',apiTarget:'static',dataMode:'simulated'});
    let current;
    const deadline=Date.now()+30000;
    do{await new Promise(resolve=>setTimeout(resolve,100));current=manager.state(requestId).build;}
    while(!['failed_no_publish','unknown'].includes(current.state)&&Date.now()<deadline);
    assert.equal(current.state,'failed_no_publish');
    assert.equal(spawnCalls,0);
    assert.equal(leases.state().active.length,0);
    const row=JSON.parse(store.db.prepare('SELECT value FROM preview_controlled_builds WHERE request_id=?')
      .get(requestId).value);
    assert.equal(row.neverStarted,true);
    const record=await readJobRecord(join(dataDir,'preview-build-jobs'),row.recordId,task.id,row.jobWorkspace);
    assert.equal(record.phase,'retired');assert.equal(record.attempted,false);assert.equal(record.identity,null);
    clean=true;
  });
