import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { createExecutionLeases } from '../server/execution-leases.mjs';
import { createWorktreeManager } from '../server/worktrees.mjs';
import { prepareControlledBuildView, verifyControlledBuildView } from '../server/preview/controlled-build-profile.mjs';
import { createPreviewRegistry } from '../server/preview/registry.mjs';
import { createControlledPreviewBuilds } from '../server/preview/controlled-build.mjs';
import { checkedRecordRoot, readJobRecord, readRetiredJobRecord, writeJobRecord } from '../server/macos-executor-job-record.mjs';

const sha=data=>createHash('sha256').update(data).digest('hex');
const exec=promisify(execFile);
async function rootFor(t){
  const root=realpathSync(await mkdtemp(join(tmpdir(),'seqivo-controlled-preview-')));
  await chmod(root,0o700);
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}

test('typed preview lease serializes the workspace and generic reconciliation cannot retire it',async t=>{
  const root=await rootFor(t),store=new Store(join(root,'board.sqlite'));
  t.after(()=>store.close());
  const project=store.project({name:'Preview',directory:root});
  const task=store.createTask({projectId:project.id,title:'Build'});
  let inspected=0;
  const leases=createExecutionLeases({store,inspect:async()=>{inspected++;return {status:'completed'};}});
  const id='request-1';
  leases.reservePreviewBuild({taskId:task.id,requestId:id,projectId:project.id,
    workspace:root,expectedRevision:task.revision,contentVersion:task.contentVersion});
  assert.equal(leases.state().active[0].kind,'preview_build');
  assert.equal(leases.state().active[0].workspace,undefined);
  assert.throws(()=>leases.reserve({taskId:task.id,commandId:'ordinary',provider:'fake'}),
    {code:'EXECUTION_PROVIDER_MISMATCH'});
  const other=store.createTask({projectId:project.id,title:'Other',conversationId:'thread',executionProvider:'fake'});
  assert.throws(()=>leases.reserve({taskId:other.id,commandId:'ordinary',provider:'fake'}),
    {code:'EXECUTION_BUSY'});
  assert.deepEqual(await leases.reconcile(),{inspected:0,released:0,active:1});
  assert.equal(inspected,0);
  assert.throws(()=>leases.releaseConfirmed({taskId:task.id,commandId:id,status:'completed'}),
    {code:'BUILD_EXECUTOR_UNKNOWN'});
  leases.updatePreviewBuild({taskId:task.id,requestId:id,status:'running'});
  leases.updatePreviewBuild({taskId:task.id,requestId:id,status:'unknown'});
  assert.equal(leases.state().active.length,1);
  leases.updatePreviewBuild({taskId:task.id,requestId:id,status:'failed'});
  assert.equal(leases.state().active.length,0);
});

test('a build in an external worktree respects another project save fence',async t=>{
  const root=await rootFor(t),data=join(root,'data'),source=join(root,'source'),external=join(root,'external');
  await mkdir(data,{mode:0o700});await mkdir(source);await mkdir(external);
  const store=new Store(join(data,'board.sqlite'));t.after(()=>store.close());
  const a=store.project({name:'A',directory:source});
  const b=store.project({name:'B',directory:external});
  const task=store.createTask({projectId:a.id,title:'Build'});
  const worktrees=createWorktreeManager({store,rootDir:data});
  const leases=createExecutionLeases({store,inspect:async()=>({status:'unknown'}),
    resolveWorktree:()=>external,
    beforeReserve:(projectId,workspace)=>worktrees.assertMayExecute(projectId,[workspace])});
  store.db.prepare('INSERT INTO worktree_fences(project_id,worktree_id,operation,repo,workspace,created_at) VALUES(?,?,?,?,?,?)')
    .run(b.id,'owned-by-b','save',external,external,new Date().toISOString());
  assert.throws(()=>leases.reservePreviewBuild({taskId:task.id,requestId:'build-external',
    projectId:a.id,workspace:external,worktreeId:'external-worktree',
    expectedRevision:task.revision,contentVersion:task.contentVersion}),
  {code:'EXECUTION_BUSY'});
  assert.equal(leases.state().active.length,0);
  store.db.prepare('DELETE FROM worktree_fences WHERE project_id=?').run(b.id);
  leases.reservePreviewBuild({taskId:task.id,requestId:'build-external',
    projectId:a.id,workspace:external,worktreeId:'external-worktree',
    expectedRevision:task.revision,contentVersion:task.contentVersion});
  assert.equal(leases.state().active.length,1);
  store.db.exec('CREATE TABLE IF NOT EXISTS preview_controlled_builds(request_id TEXT PRIMARY KEY,value TEXT NOT NULL)');
  store.db.prepare('INSERT INTO preview_controlled_builds VALUES(?,?)').run('build-external',JSON.stringify({
    requestId:'build-external',projectId:a.id,taskId:task.id,workspace:external,state:'building'}));
  const builds=createControlledPreviewBuilds({store,leases,dataDir:data});
  assert.throws(()=>builds.assertNoUnfencedIntents(b.id),{code:'BUILD_BUSY'});
  const unrelated=join(root,'unrelated');await mkdir(unrelated);
  const c=store.project({name:'C',directory:unrelated});
  assert.doesNotThrow(()=>builds.assertNoUnfencedIntents(c.id));
});

test('profile view preserves only selected bytes and rejects alternate import and resource syntax',async t=>{
  const root=await rootFor(t),source=join(root,'source'),view=join(root,'view');
  await mkdir(source);
  const files=[['index.html','<script type="module" src="./src/main.js"></script>'],
    ['src/main.js','import "./style.css"; document.body.textContent="ready";'],
    ['src/style.css','body{color:#123}']];
  for(const [path,text] of files){await mkdir(join(source,path,'..'),{recursive:true});await writeFile(join(source,path),text);}
  await writeFile(join(source,'.env'),'DO_NOT_LOAD');
  const receipt={files:[...files.map(([path,text])=>({path,kind:'file',size:Buffer.byteLength(text),sha256:sha(text)})),
    {path:'.env',kind:'file',size:11,sha256:sha('DO_NOT_LOAD')}]};
  const prepared=await prepareControlledBuildView({snapshotDir:source,receipt,viewDir:view});
  assert.equal(await verifyControlledBuildView({viewDir:view,...prepared}),true);
  await assert.rejects(readFile(join(view,'.env')),{code:'ENOENT'});
  await writeFile(join(view,'src/main.js'),'tampered');
  await assert.rejects(verifyControlledBuildView({viewDir:view,...prepared}));
  for(const malicious of ['import "react"','import("./style.css")',
    'const x=import.meta.glob("./*.js")','new URL("./x", import.meta.url)',
    'import "../../outside.js"','export*from"../../outside.js"',
    'import{a}from"../../outside.js"']){
    const variant=join(root,`bad-${Math.random().toString(16).slice(2)}`);
    const text=malicious;
    await writeFile(join(source,'src/main.js'),text);
    const changed={files:receipt.files.map(row=>row.path==='src/main.js'?{
      path:row.path,kind:'file',size:Buffer.byteLength(text),sha256:sha(text)}:row)};
    await assert.rejects(prepareControlledBuildView({snapshotDir:source,receipt:changed,viewDir:variant}),
      {code:'BUILD_SOURCE_INVALID'});
  }
  const css='@import"../../outside.css"';
  await writeFile(join(source,'src/main.js'),files[1][1]);
  await writeFile(join(source,'src/style.css'),css);
  const changed={files:receipt.files.map(row=>row.path==='src/style.css'?{
    path:row.path,kind:'file',size:Buffer.byteLength(css),sha256:sha(css)}:row)};
  await assert.rejects(prepareControlledBuildView({snapshotDir:source,receipt:changed,
    viewDir:join(root,'bad-css')}),{code:'BUILD_SOURCE_INVALID'});
  await writeFile(join(source,'src/style.css'),files[2][1]);
  const inline='<script type="module">import "../../outside.js"</script>';
  await writeFile(join(source,'index.html'),inline);
  const htmlReceipt={files:receipt.files.map(row=>row.path==='index.html'?{
    path:row.path,kind:'file',size:Buffer.byteLength(inline),sha256:sha(inline)}:row)};
  await assert.rejects(prepareControlledBuildView({snapshotDir:source,receipt:htmlReceipt,
    viewDir:join(root,'bad-inline')}),{code:'BUILD_SOURCE_INVALID'});
});

test('managed registry keeps provenance separate from imported dirty fields',async t=>{
  const root=await rootFor(t),dist=join(root,'dist'),dataDir=join(root,'data');
  await mkdir(dist);await mkdir(dataDir,{mode:0o700});
  await writeFile(join(dist,'index.html'),'<script type="module" src="./bundle.js"></script>');
  await writeFile(join(dist,'bundle.js'),'console.log("built")');
  const registry=createPreviewRegistry({dataDir});
  const digest=sha('receipt');
  const input={previewId:'controlled-1',projectId:'project-1',taskId:'task-1',contentVersion:1,sourceTaskRevision:2,
    distDir:dist,sourceCommit:'a'.repeat(40),dataMode:'simulated',apiTarget:'static',
    provenance:{kind:'managed-vite-vanilla-v1',sourceDigest:digest,inputDigest:digest,
      buildReceiptDigest:digest,toolDigest:digest,profileDigest:digest}};
  const manifest=await registry.registerManaged(input);
  assert.equal(manifest.dirty,undefined);
  assert.equal(manifest.dirtyDigest,undefined);
  assert.equal(manifest.provenance.sourceDigest,digest);
  assert.equal(manifest.sourceTaskRevision,2);
  await assert.rejects(registry.registerManaged({...input,sourceTaskRevision:3}),{code:'PREVIEW_MANIFEST'});
  assert.equal((await registry.registerManaged(input)).previewId,manifest.previewId);
  assert.deepEqual((await registry.read(manifest.previewId,'bundle.js')).bytes,
    Buffer.from('console.log("built")'));
  await assert.rejects(registry.registerManaged({...input,provenance:{...input.provenance,inputDigest:sha('other')}}),
    {code:'PREVIEW_MANIFEST'});
});

test('fixed runner only acknowledges a worker that exits normally with code zero',async t=>{
  const root=await rootFor(t),runner=fileURLToPath(new URL('../server/preview/controlled-build-runner.mjs',import.meta.url));
  const worker=join(root,'worker.mjs'),settings=join(root,'settings.json');
  await writeFile(settings,'{}');
  await writeFile(worker,'process.stdout.write(JSON.stringify({v:1,status:"built"})+"\\n"); process.exitCode=1;');
  await assert.rejects(exec(process.execPath,[runner,worker,settings],{timeout:5000}),error=>{
    assert.equal(error.code,1);
    assert.equal(error.stdout,'');
    return true;
  });
  await writeFile(worker,'process.stdout.write(JSON.stringify({v:1,status:"built"})+"\\n"); process.stdout.end(); setTimeout(()=>process.exit(1),250);');
  await assert.rejects(exec(process.execPath,[runner,worker,settings],{timeout:5000}),error=>{
    assert.equal(error.code,1);
    assert.equal(error.stdout,'');
    return true;
  });
  await writeFile(worker,'process.stdout.write(JSON.stringify({v:1,status:"built"})+"\\n");');
  const result=await exec(process.execPath,[runner,worker,settings],{timeout:5000});
  assert.equal(result.stdout.trim(),'{"v":1,"status":"built"}');
});

test('output-ready recovery rejects a changed artifact or publication target',async t=>{
  const root=await rootFor(t),data=join(root,'data'),projectDir=join(root,'project');
  await mkdir(data,{mode:0o700});await mkdir(projectDir);
  const store=new Store(join(data,'board.sqlite'));t.after(()=>store.close());
  const project=store.project({name:'Preview',directory:projectDir});
  const task=store.createTask({projectId:project.id,title:'Build'});
  const digest=sha('original'),requestId='build-original',previewId='preview-original';
  const row={requestId,request:{requestId},state:'output_ready',projectId:project.id,taskId:task.id,
    expectedRevision:task.revision,contentVersion:task.contentVersion,worktreeId:null,
    workspace:projectDir,projectDirectory:projectDir,nodeBinding:'original-node',previewId,
    sourceCommit:'a'.repeat(40),sourceDigest:digest,inputDigest:digest,toolDigest:digest,
    buildReceiptDigest:digest,artifactDigest:digest,dataStoreId:null,dataMode:'simulated',
    apiTarget:'static',profile:'vite-vanilla-v1',criteria:[],attempted:true,
    recordId:'original-record',jobRetired:true};
  const provenance={kind:'managed-vite-vanilla-v1',sourceDigest:digest,inputDigest:digest,
    toolDigest:digest,profileDigest:sha('vite-vanilla-v1:configFile=false:envDir=false:envPrefix=[]:publicDir=false:postcss=[]:base=./'),buildReceiptDigest:digest};
  let manifest={previewId,projectId:project.id,taskId:task.id,contentVersion:task.contentVersion,
    sourceTaskRevision:task.revision,
    sourceCommit:row.sourceCommit,artifactDigest:digest,dataMode:'simulated',apiTarget:'static',
    provenance};
  const events=[];
  const manager=createControlledPreviewBuilds({store,dataDir:data,pythonPath:'/unused',
    leases:{updatePreviewBuild:()=>events.push('lease')},
    registry:{get:async()=>manifest},local:{record:()=>events.push('local')},
    records:{bind:()=>events.push('records')},assertAuthority:()=>{},
    resolveWorktree:()=>projectDir,nodeBinding:()=>row.nodeBinding,
    link:()=>({refresh:async()=>events.push('refresh'),register:async()=>events.push('hub')})});
  store.db.prepare('INSERT INTO preview_controlled_builds(request_id,value) VALUES(?,?)')
    .run(requestId,JSON.stringify(row));
  manifest={...manifest,artifactDigest:sha('tampered')};
  assert.equal((await manager.reconcile(requestId)).build.state,'output_ready');
  assert.deepEqual(events,[]);
  manifest={...manifest,artifactDigest:digest,projectId:'other-project'};
  assert.equal((await manager.reconcile(requestId)).build.state,'output_ready');
  assert.deepEqual(events,[]);
  manifest={...manifest,projectId:project.id};
  // Matching artifact metadata cannot replace the original Mac job's durable
  // retirement proof. This forged intent points to no private job record.
  assert.equal((await manager.reconcile(requestId)).build.state,'output_ready');
  assert.deepEqual(events,[]);
  // A boolean in the intent is insufficient: this fake record does not exist.
  await assert.rejects(manager.close(),error=>error instanceof AggregateError&&
    error.errors.length===1);
});

test('old-boot retired proof permits historical publish and close but never live recovery',
  {skip:process.platform!=='darwin'?'Mac boot identity is required':false},async t=>{
    const root=await rootFor(t),data=join(root,'data'),projectDir=join(root,'project'),jobRoot=join(data,'preview-build-jobs');
    await mkdir(data,{mode:0o700});await mkdir(projectDir);await mkdir(jobRoot,{mode:0o700});
    const store=new Store(join(data,'board.sqlite'));t.after(()=>store.close());
    const project=store.project({name:'Historical',directory:projectDir});
    const task=store.createTask({projectId:project.id,title:'Old boot preview'});
    const checked=await checkedRecordRoot(jobRoot),digest=sha('original');
    const recordId='a'.repeat(32),previewId='historical-preview',requestId='historical-build';
    const record={schemaVersion:1,recordId,taskId:task.id,workspace:projectDir,
      recordRoot:checked.path,rootIdentity:checked.identity,
      directory:join(await realpath(tmpdir()),'seqivo-executor-job-historical-absent'),
      directoryIdentity:{dev:'1',ino:'1',uid:process.geteuid(),mode:0o700},
      label:`com.seqivo.executor.${recordId}`,pythonPath:await realpath(process.execPath),
      boot:'1:2',generation:0,phase:'retired',attempted:true,identity:null,
      ioFault:false,resultUnknown:true};
    await writeJobRecord(jobRoot,record);
    await assert.rejects(readJobRecord(jobRoot,recordId,task.id,projectDir),/job_record_binding_unconfirmed/);
    assert.equal((await readRetiredJobRecord(jobRoot,recordId,task.id,projectDir)).phase,'retired');
    await assert.rejects(readRetiredJobRecord(jobRoot,recordId,task.id,root));
    await assert.rejects(readRetiredJobRecord(jobRoot,'b'.repeat(32),task.id,projectDir),{code:'ENOENT'});
    const row={requestId,state:'output_ready',projectId:project.id,taskId:task.id,
      expectedRevision:task.revision,contentVersion:task.contentVersion,worktreeId:null,
      workspace:projectDir,projectDirectory:projectDir,nodeBinding:'same-node',previewId,
      sourceCommit:'a'.repeat(40),sourceDigest:digest,inputDigest:digest,toolDigest:digest,
      buildReceiptDigest:digest,artifactDigest:digest,dataStoreId:null,dataMode:'simulated',
      apiTarget:'static',criteria:[],attempted:true,recordId,jobWorkspace:projectDir,jobRetired:true};
    const manifest={previewId,projectId:project.id,taskId:task.id,contentVersion:task.contentVersion,
      sourceTaskRevision:task.revision,sourceCommit:row.sourceCommit,artifactDigest:digest,
      dataMode:'simulated',apiTarget:'static',dataStoreId:null,
      provenance:{kind:'managed-vite-vanilla-v1',sourceDigest:digest,inputDigest:digest,
        toolDigest:digest,buildReceiptDigest:digest,
        profileDigest:sha('vite-vanilla-v1:configFile=false:envDir=false:envPrefix=[]:publicDir=false:postcss=[]:base=./')}};
    const calls=[];
    const manager=createControlledPreviewBuilds({store,dataDir:data,pythonPath:process.execPath,
      leases:{updatePreviewBuild:()=>calls.push('lease')},registry:{get:async()=>manifest,
        markRegistered:async()=>calls.push('registered')},local:{record:()=>calls.push('local')},
      records:{bind:()=>assert.fail('static build')},assertAuthority:()=>{},
      assertHistoricalAuthority:()=>{},resolveWorktree:()=>projectDir,nodeBinding:()=>row.nodeBinding,
      link:()=>({refresh:async()=>{},queryRegistration:async()=>true,
        register:async()=>assert.fail('historical lookup must not re-register')})});
    store.db.prepare('INSERT INTO preview_controlled_builds(request_id,value) VALUES(?,?)')
      .run(requestId,JSON.stringify(row));
    assert.equal((await manager.reconcile(requestId)).build.state,'ready');
    assert.deepEqual(calls,['registered','local','lease']);
    await manager.close();
    const notRetired={...record,recordId:'c'.repeat(32),label:`com.seqivo.executor.${'c'.repeat(32)}`,
      phase:'identity'};
    await writeJobRecord(jobRoot,notRetired);
    await assert.rejects(readRetiredJobRecord(jobRoot,notRetired.recordId,task.id,projectDir),
      /job_record_binding_unconfirmed/);
    const unresolved=createControlledPreviewBuilds({store,dataDir:data,pythonPath:process.execPath});
    store.db.prepare('INSERT INTO preview_controlled_builds(request_id,value) VALUES(?,?)')
      .run('unretired-build',JSON.stringify({...row,requestId:'unretired-build',recordId:notRetired.recordId}));
    await assert.rejects(unresolved.close(),error=>error instanceof AggregateError&&error.errors.length===1);
  });
