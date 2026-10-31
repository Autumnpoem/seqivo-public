import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BoardError } from '../store.mjs';
import { prepareExecutorJob, recoverExecutorJob } from '../macos-executor-job.mjs';
import { readJobRecord, readRetiredJobRecord } from '../macos-executor-job-record.mjs';
import { createPreviewSourceSnapshot, verifyPreviewSourceSnapshot } from './source-snapshot.mjs';
import { prepareControlledBuildView, verifyControlledBuildView } from './controlled-build-profile.mjs';
import { loadVerifiedPreviewToolchain } from './toolchain.mjs';

const ID=/^[A-Za-z0-9_-]{1,100}$/;
const hash=value=>createHash('sha256').update(value).digest('hex');
const overlaps=(a,b)=>{const part=relative(a,b),back=relative(b,a);
  return part===''||back===''||(!part.startsWith(`..${sep}`)&&part!=='..'&&!isAbsolute(part))||
    (!back.startsWith(`..${sep}`)&&back!=='..'&&!isAbsolute(back));};
const fail=(code,message,status=409)=>{throw new BoardError(message,status,code);};
const worker=fileURLToPath(new URL('./controlled-build-worker.mjs',import.meta.url));
const runner=fileURLToPath(new URL('./controlled-build-runner.mjs',import.meta.url));
const profileDigest=hash('vite-vanilla-v1:configFile=false:envDir=false:envPrefix=[]:publicDir=false:postcss=[]:base=./');
const STATES=new Set(['prepared','snapshot_ready','building','output_ready','registered_local','ready','failed_no_publish','unknown']);
const publicBuild=row=>({id:row.requestId,requestId:row.requestId,projectId:row.projectId,
  taskId:row.taskId,expectedRevision:row.expectedRevision,contentVersion:row.contentVersion,
  worktreeId:row.worktreeId,profile:row.profile,apiTarget:row.apiTarget,dataMode:row.dataMode,
  state:row.state,...(row.previewId?{previewId:row.previewId}:{}),
  ...(row.sourceDigest?{sourceDigest:row.sourceDigest}:{}),
  ...(row.artifactDigest?{artifactDigest:row.artifactDigest}:{}),
  ...(row.errorCode?{errorCode:row.errorCode}:{})});
const parse=row=>row?JSON.parse(row.value):null;
const JOB_ENV_KEYS=['HOME','TMPDIR','LANG','LC_ALL','PATH'];
const errorCode=error=>{
  if(/^BUILD_[A-Z_]+$/.test(error?.code||''))return error.code;
  if(/^PREVIEW_SOURCE_[A-Z_]+$/.test(error?.code||'')||
    /^PREVIEW_(?:BUILD|BASE|FILE|LIMIT|SYMLINK|SOURCEMAP)$/.test(error?.code||''))
    return 'BUILD_SOURCE_INVALID';
  return 'BUILD_EXECUTOR_UNKNOWN';
};
function controlledEnv(){
  const env={};
  for(const key of JOB_ENV_KEYS)if(typeof process.env[key]==='string')env[key]=process.env[key];
  // Preserve the genuine location, never substitute a synthetic auth home.
  if(typeof process.env.CODEX_HOME==='string')env.CODEX_HOME=process.env.CODEX_HOME;
  return env;
}
const toolchain=()=>{
  try{return loadVerifiedPreviewToolchain();}
  catch{fail('BUILD_UNSUPPORTED','当前安装不含受信构建工具链');}
};
const strictInput=input=>{
  const keys=['requestId','projectId','taskId','expectedRevision','contentVersion',
    'worktreeId','profile','apiTarget','dataMode'];
  if(!input||typeof input!=='object'||Array.isArray(input)||
    Object.keys(input).sort().join('|')!==keys.sort().join('|')||
    ![input.requestId,input.projectId,input.taskId].every(value=>ID.test(value))||
    !Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||
    !Number.isSafeInteger(input.contentVersion)||input.contentVersion<1||
    input.worktreeId!==null&&!ID.test(input.worktreeId)||
    !['static','records-v1'].includes(input.apiTarget)||
    !['simulated','real'].includes(input.dataMode)||
    input.dataMode==='real'&&input.apiTarget!=='records-v1')
    fail('BUILD_INVALID','受控构建请求不正确',400);
  if(input.profile!=='vite-vanilla-v1')fail('BUILD_PROFILE_UNSUPPORTED','不支持此受控构建类型');
  return structuredClone(input);
};

/** Private build intent is independent of the Hub; it never stores capabilities. */
export function createControlledPreviewBuilds({store,leases,registry,local,records,
  dataDir,pythonPath,assertAuthority,assertHistoricalAuthority,resolveWorktree,nodeBinding,link,emit=()=>{},isClosing=()=>false,
  prepareJob=prepareExecutorJob}){
  store.db.exec(`CREATE TABLE IF NOT EXISTS preview_controlled_builds(
    request_id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS preview_controlled_build_preview_lookup
      ON preview_controlled_builds(json_extract(value,'$.previewId')) WHERE json_valid(value);`);
  const root=resolve(dataDir,'preview-controlled-builds');
  const jobRoot=resolve(dataDir,'preview-build-jobs');
  const live=new Map(),inflight=new Set();let closingBuilds=false;
  const get=id=>parse(store.db.prepare('SELECT value FROM preview_controlled_builds WHERE request_id=?').get(id));
  const save=row=>store.db.prepare('INSERT INTO preview_controlled_builds(request_id,value) VALUES(?,?) ON CONFLICT(request_id) DO UPDATE SET value=excluded.value')
    .run(row.requestId,JSON.stringify(row));
  const mustGet=id=>{if(!ID.test(id))fail('BUILD_INVALID','构建请求 ID 不正确',400);
    const row=get(id);if(!row)fail('BUILD_INVALID','未找到原构建请求',404);return row;};
  const state=id=>({build:publicBuild(mustGet(id))});
  async function verifiedSourceForPreview(previewId){
    if(!ID.test(previewId))fail('BUILD_INVALID','预览 ID 不正确',400);
    const rows=store.db.prepare(`SELECT value FROM preview_controlled_builds
      WHERE json_valid(value) AND json_extract(value,'$.previewId')=? LIMIT 2`).all(previewId);
    if(rows.length!==1)fail('PREVIEW_SOURCE_UNKNOWN','原预览源码来源不能唯一核实',409);
    const row=parse(rows[0]);
    if(row.state!=='ready'||!row.snapshotId||!row.sourceDigest||!row.previewId)
      fail('PREVIEW_SOURCE_UNKNOWN','原预览没有已完成的受控源码证明',409);
    const manifest=await registry.get(previewId);
    if(!samePublishedManifest(row,manifest)||!await registry.isRegistered(previewId))
      fail('PREVIEW_SOURCE_UNKNOWN','原预览登记与构建证明不一致',409);
    const verified=await verifyPreviewSourceSnapshot({dataDir,snapshotId:row.snapshotId,
      expectedSourceDigest:row.sourceDigest});
    const latest=store.db.prepare(`SELECT value FROM preview_controlled_builds
      WHERE json_valid(value) AND json_extract(value,'$.previewId')=? LIMIT 2`).all(previewId);
    if(!verified||latest.length!==1||latest[0].value!==rows[0].value||
      !samePublishedManifest(row,await registry.get(previewId))||
      !await registry.isRegistered(previewId))
      fail('PREVIEW_SOURCE_UNKNOWN','原预览源码证明已变化',409);
    return {build:row,manifest,receipt:verified.receipt};
  }
  const mark=(id,patch)=>store.transaction(()=>{const row=mustGet(id);
    const next={...row,...patch,updatedAt:new Date().toISOString()};
    if(!STATES.has(next.state))fail('BUILD_INVALID','构建状态不正确',500);
    save(next);return next;});
  const checkBinding=(row,{allowTaskChange=false}={})=>{
    if(isClosing()||closingBuilds)fail('BUILD_BINDING_CHANGED','程序正在关闭');
    const task=store.getTask(row.taskId),project=store.getProject(row.projectId);
    if(task.projectId!==project.id||project.directory!==row.projectDirectory||
      !row.nodeBinding||nodeBinding()!==row.nodeBinding||
      !allowTaskChange&&(task.revision!==row.expectedRevision||task.contentVersion!==row.contentVersion))
      fail('BUILD_BINDING_CHANGED','构建任务或目录已变化');
    const path=row.worktreeId?resolveWorktree({taskId:task.id,worktreeId:row.worktreeId}):project.directory;
    if(path!==row.workspace)fail('BUILD_BINDING_CHANGED','原构建工作树已变化');
    assertAuthority({task,project,row});
    return {task,project};
  };
  const unknown=(row,code='BUILD_EXECUTOR_UNKNOWN')=>{
    try{mark(row.requestId,{state:'unknown',errorCode:code});}catch{/* The old intent and active lease remain. */}
    try{leases.updatePreviewBuild({requestId:row.requestId,taskId:row.taskId,status:'unknown'});}catch{}
    emit();
  };
  const noPublish=(row,code,extra={})=>{
    store.transaction(()=>{
      const current=mustGet(row.requestId);
      if(current.previewId&&current.state!=='prepared'&&current.state!=='snapshot_ready'&&current.state!=='building')
        fail('BUILD_PUBLISH_UNKNOWN','原构建可能已发布');
      save({...current,...extra,state:'failed_no_publish',errorCode:code,updatedAt:new Date().toISOString()});
      leases.updatePreviewBuild({requestId:row.requestId,taskId:row.taskId,status:'failed'});
    });emit();
  };
  const readWorker=async stream=>{
    let bytes='';
    for await(const chunk of stream){bytes+=chunk.toString('utf8');if(bytes.length>1024)throw Error('worker_output_limit');}
    return bytes.trim()==='{"v":1,"status":"built"}';
  };
  const bounded=(promise,ms)=>new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Object.assign(Error('build_timeout'),{code:'BUILD_EXECUTOR_UNKNOWN'})),ms);
    timer.unref?.();
    Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
  async function naturalCompletion(job){
    const deadline=performance.now()+2000;
    let stable=0;
    while(performance.now()<deadline){
      const remaining=Math.max(1,Math.floor(deadline-performance.now()));
      const observed=await bounded(job.inspect(),remaining);
      if(!observed.verified||observed.unknown||observed.ioFault)
        fail('BUILD_EXECUTOR_UNKNOWN','原构建执行器身份不能核实');
      stable=observed.count===0&&observed.members.length===0?stable+1:0;
      if(stable>=2)return;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    fail('BUILD_EXECUTOR_UNKNOWN','原构建执行器未自然退出');
  }
  function samePublishedManifest(row,manifest){
    const provenance=manifest?.provenance;
    return !!manifest&&manifest.previewId===row.previewId&&
      manifest.projectId===row.projectId&&manifest.taskId===row.taskId&&
      manifest.contentVersion===row.contentVersion&&manifest.sourceTaskRevision===row.expectedRevision&&
      manifest.sourceCommit===row.sourceCommit&&
      manifest.artifactDigest===row.artifactDigest&&
      manifest.dataMode===row.dataMode&&(manifest.apiTarget||'static')===row.apiTarget&&
      (manifest.dataStoreId||null)===(row.dataStoreId||null)&&
      provenance?.kind==='managed-vite-vanilla-v1'&&
      provenance.sourceDigest===row.sourceDigest&&provenance.inputDigest===row.inputDigest&&
      provenance.toolDigest===row.toolDigest&&provenance.profileDigest===profileDigest&&
      provenance.buildReceiptDigest===row.buildReceiptDigest;
  }
  function sameIntent(row){
    const current=mustGet(row.requestId);
    for(const key of ['state','projectId','taskId','expectedRevision','contentVersion','workspace',
      'projectDirectory','worktreeId','nodeBinding','recordId','jobWorkspace','attempted',
      'jobRetired','artifactDigest','buildReceiptDigest','previewId','dataStoreId',
      'apiTarget','dataMode','sourceCommit','sourceDigest','inputDigest','toolDigest'])
      if(current[key]!==row[key])fail('BUILD_PUBLISH_UNKNOWN','原构建发布记录已变化');
    return current;
  }
  function checkHistorical(row,manifest){
    if(isClosing()||closingBuilds||!row.nodeBinding||nodeBinding()!==row.nodeBinding)
      fail('BUILD_BINDING_CHANGED','原预览节点授权已变化');
    const task=store.getTask(row.taskId),project=store.getProject(row.projectId);
    if(task.projectId!==project.id||manifest.projectId!==project.id||manifest.taskId!==task.id||
      manifest.previewId!==row.previewId||!samePublishedManifest(row,manifest))
      fail('BUILD_PUBLISH_UNKNOWN','原构建发布身份已变化');
    if(typeof assertHistoricalAuthority==='function')assertHistoricalAuthority({task,project,row});
  }
  async function publish(row){
    const manifest=await registry.get(row.previewId);
    if(!samePublishedManifest(row,manifest))
      fail('BUILD_PUBLISH_UNKNOWN','原构建产物身份不符');
    // The persisted intent and artifact digest do not prove that the original
    // launcher exited. A recovered output_ready row must pass the same private
    // Mac job record check as a fresh publication before either local or Hub
    // receives the artifact.
    try{
      if(row.attempted!==true||row.jobRetired!==true||!row.recordId||!row.jobWorkspace)
        throw Error('build_retirement_receipt_missing');
      const record=await readRetiredJobRecord(jobRoot,row.recordId,row.taskId,row.jobWorkspace);
      if(record.phase!=='retired'||record.attempted!==true||record.ioFault||
        record.pythonPath!==await realpath(pythonPath))
        throw Error('build_retirement_record_unconfirmed');
    }catch{fail('BUILD_EXECUTOR_UNKNOWN','原构建执行器退出记录不能核实');}
    sameIntent(row);
    checkHistorical(row,manifest);
    await link().refresh();
    const guardHistorical=sent=>{sameIntent(row);checkHistorical(row,sent);};
    const found=await link().queryRegistration(manifest.previewId,{beforeSend:guardHistorical});
    if(found){
      sameIntent(row);checkHistorical(row,manifest);
      await registry.markRegistered(manifest.previewId);
    }else{
      checkBinding(row);
      await link().register(manifest.previewId,{beforeSend:sent=>{
        sameIntent(row);if(!samePublishedManifest(row,sent))fail('BUILD_PUBLISH_UNKNOWN','原构建发布身份已变化');
        checkBinding(row);
      }});
    }
    sameIntent(row);checkHistorical(row,manifest);
    if(row.apiTarget==='records-v1')records.bind({previewId:manifest.previewId,projectId:manifest.projectId,
      taskId:manifest.taskId,contentVersion:manifest.contentVersion,artifactDigest:manifest.artifactDigest,
      dataStoreId:manifest.dataStoreId});
    local.record(manifest,row.criteria,row.projectDirectory);
    store.transaction(()=>{
      checkHistorical(row,manifest);
      const current=sameIntent(row);
      if(!['output_ready','registered_local'].includes(current.state)||current.previewId!==manifest.previewId)
        fail('BUILD_PUBLISH_UNKNOWN','原构建发布状态已变化');
      leases.updatePreviewBuild({requestId:row.requestId,taskId:row.taskId,status:'completed'});
      save({...current,state:'ready',errorCode:null,updatedAt:new Date().toISOString()});
    });emit();
  }
  async function execute(row){
    let job=null,attempted=false,prepareStarted=false,jobWorkspace=null;
    try{
      if(process.platform!=='darwin'||typeof pythonPath!=='string'||!pythonPath.startsWith('/'))
        fail('BUILD_UNSUPPORTED','当前平台缺少受管构建退出证明');
      const {viteEntry,toolDigest}=toolchain();
      await mkdir(root,{recursive:true,mode:0o700});
      await mkdir(jobRoot,{recursive:true,mode:0o700});
      checkBinding(row);
      const source=await createPreviewSourceSnapshot({sourceDir:row.workspace,dataDir});
      const verified=await verifyPreviewSourceSnapshot({dataDir,snapshotId:source.snapshotId,
        expectedSourceDigest:source.receipt.sourceDigest});
      if(!verified)fail('BUILD_SOURCE_INVALID','原源码快照无法核验');
      checkBinding(row);
      row=mark(row.requestId,{state:'snapshot_ready',snapshotId:source.snapshotId,
        sourceDigest:source.receipt.sourceDigest,sourceCommit:source.receipt.sourceCommit});
      const work=join(root,row.requestId);
      await mkdir(work,{mode:0o700});
      const view=join(work,'view'),out=join(work,'out'),cache=join(work,'cache');
      const profile=await prepareControlledBuildView({snapshotDir:source.snapshotDir,
        receipt:source.receipt,viewDir:view});
      await mkdir(out,{mode:0o700});
      await mkdir(cache,{mode:0o700});
      await verifyControlledBuildView({viewDir:view,files:profile.files,inputDigest:profile.inputDigest});
      checkBinding(row);
      const canonicalView=await realpath(view),canonicalOut=await realpath(out),canonicalCache=await realpath(cache);
      jobWorkspace=canonicalView;
      const settings=join(work,'worker.json');
      const tsconfig=join(work,'tsconfig.fixed.json');
      await writeFile(tsconfig,JSON.stringify({compilerOptions:{target:'ES2022',module:'ESNext',
        moduleResolution:'Bundler',jsx:'react-jsx',strict:true,noEmit:true}}),{flag:'wx',mode:0o600});
      await writeFile(settings,JSON.stringify({v:1,root:canonicalView,outDir:canonicalOut,cacheDir:canonicalCache,
        tsconfig,viteEntry,toolDigest,files:profile.files,inputDigest:profile.inputDigest,profile:row.profile}),
        {flag:'wx',mode:0o600});
      prepareStarted=true;
      job=await prepareJob({taskId:row.taskId,command:process.execPath,args:[runner,worker,settings],
        cwd:canonicalView,env:controlledEnv(),pythonPath,recordRoot:jobRoot});
      checkBinding(row);
      row=mark(row.requestId,{state:'building',attempted:true,recordId:job.recordId,
        jobWorkspace:canonicalView,inputDigest:profile.inputDigest,toolDigest});
      leases.updatePreviewBuild({requestId:row.requestId,taskId:row.taskId,status:'running'});
      attempted=true;live.set(row.requestId,job);
      const channels=await job.spawn();
      const output=readWorker(channels.stdout),errors=readWorker(channels.stderr).catch(()=>false);
      const built=await bounded(output,90_000);await bounded(errors,5_000);
      if(built)await naturalCompletion(job);
      const retired=await job.stop();
      if(!retired.verified||!retired.retired||retired.unknown||retired.ioFault)
        fail('BUILD_EXECUTOR_UNKNOWN','原构建执行器未能证实退出');
      row=mark(row.requestId,{jobRetired:true});
      live.delete(row.requestId);
      if(!built){noPublish(row,'BUILD_SOURCE_INVALID');return;}
      checkBinding(row);
      const buildReceiptDigest=hash(JSON.stringify({requestId:row.requestId,sourceDigest:row.sourceDigest,
        inputDigest:profile.inputDigest,toolDigest,profileDigest,recordId:row.recordId}));
      const manifest=await registry.registerManaged({previewId:row.previewId,projectId:row.projectId,
        taskId:row.taskId,contentVersion:row.contentVersion,sourceTaskRevision:row.expectedRevision,distDir:out,
        sourceCommit:row.sourceCommit,provenance:{kind:'managed-vite-vanilla-v1',
          sourceDigest:row.sourceDigest,inputDigest:row.inputDigest,buildReceiptDigest,
          toolDigest,profileDigest},dataMode:row.dataMode,apiTarget:row.apiTarget,
        dataStoreId:row.dataStoreId});
      row=mark(row.requestId,{state:'output_ready',buildReceiptDigest,
        artifactDigest:manifest.artifactDigest});
      try{await publish(row);}catch{
        const current=mustGet(row.requestId);
        mark(row.requestId,{state:current.state,errorCode:'BUILD_PUBLISH_UNKNOWN'});
        emit();
      }
    }catch(error){
      const code=errorCode(error);
      if(!prepareStarted&&job===null){try{noPublish(row,code);}catch{unknown(row);}}
      else if(!attempted&&job){
        try{const proof=await job.abandonPrepared();
          if(!proof.verified||!proof.retired||!proof.neverSubmitted)throw Error('job_prepare_abandon_unconfirmed');
          noPublish(row,code,{recordId:job.recordId,jobWorkspace,attempted:false,neverStarted:true});
        }catch{unknown(mustGet(row.requestId),code);}
      }
      else if(attempted&&job){
        let retired;
        try{retired=await job.stop();}catch{}
        const current=mustGet(row.requestId);
        if(retired?.verified&&retired.retired&&!retired.unknown&&!retired.ioFault)
          try{mark(row.requestId,{jobRetired:true});}catch{/* The shutdown fence remains. */}
        if(retired?.verified&&retired.retired&&!retired.unknown&&!retired.ioFault&&current.state==='building'){
          try{noPublish(current,code);}catch{unknown(current,code);}
        }else unknown(current,code);
      }else unknown(row,code);
    }finally{live.delete(row.requestId);emit();}
  }
  function start(input){
    const request=strictInput(input);
    if(isClosing()||closingBuilds)fail('BUILD_BUSY','程序正在关闭');
    const prior=get(request.requestId);
    if(prior){if(JSON.stringify(prior.request)!==JSON.stringify(request))
      fail('BUILD_REQUEST_CONFLICT','此请求 ID 已绑定不同构建',409);
      return {build:publicBuild(prior)};}
    if(process.platform!=='darwin'||typeof pythonPath!=='string'||!pythonPath.startsWith('/'))
      fail('BUILD_UNSUPPORTED','当前平台不支持原执行器退出证明');
    toolchain();
    const task=store.getTask(request.taskId),project=store.getProject(request.projectId);
    if(task.projectId!==project.id||task.revision!==request.expectedRevision||
      task.contentVersion!==request.contentVersion)
      fail('BUILD_BINDING_CHANGED','任务版本已变化');
    let workspace;
    try{workspace=request.worktreeId?
      resolveWorktree({taskId:task.id,worktreeId:request.worktreeId}):project.directory;}
    catch{fail('BUILD_WORKTREE_UNSUPPORTED','工作树绑定无法核实');}
    try{if(typeof workspace!=='string'||!workspace.startsWith('/')||realpathSync(workspace)!==workspace)
      fail('BUILD_BINDING_CHANGED','构建目录真实路径已变化');}
    catch(error){if(error?.code?.startsWith('BUILD_'))throw error;
      fail('BUILD_BINDING_CHANGED','构建目录不能核实');}
    const binding=nodeBinding();if(!binding)fail('BUILD_BINDING_CHANGED','原预览节点不可用');
    const row={...request,request,workspace,projectDirectory:project.directory,nodeBinding:binding,
      previewId:randomUUID(),dataStoreId:request.apiTarget==='records-v1'?randomUUID():null,
      criteria:task.criteria,state:'prepared',attempted:false,createdAt:new Date().toISOString()};
    store.transaction(()=>{
      checkBinding(row);
      leases.reservePreviewBuild({taskId:row.taskId,requestId:row.requestId,
        projectId:row.projectId,workspace:row.workspace,worktreeId:row.worktreeId,
        expectedRevision:row.expectedRevision,contentVersion:row.contentVersion});
      save(row);
    });
    const work=execute(row);inflight.add(work);void work.finally(()=>inflight.delete(work));
    emit();return {build:publicBuild(row)};
  }
  async function reconcile(id){
    const row=mustGet(id);
    if(row.state==='ready'||row.state==='failed_no_publish')return {build:publicBuild(row)};
    if(['output_ready','registered_local'].includes(row.state)){
      try{await publish(row);}catch{
        const current=mustGet(id);
        mark(id,{state:current.state,errorCode:'BUILD_PUBLISH_UNKNOWN'});
      }
      return state(id);
    }
    // A restarted Core has no launch authority. Inspect only the original
    // private job record; never prepare/spawn or infer non-execution from 404.
    if(!row.recordId||!row.attempted)return state(id);
    try{
      const record=await readJobRecord(jobRoot,row.recordId,row.taskId,row.jobWorkspace);
      const recovered=await recoverExecutorJob({recordRoot:jobRoot,recordId:row.recordId,
        taskId:row.taskId,cwd:row.jobWorkspace,pythonPath:record.pythonPath});
      if(!recovered.verified||!recovered.job)return state(id);
      const retired=await recovered.job.recheck();
      if(!retired.verified||!retired.retired)return state(id);
    }catch{return state(id);}
    return state(id);
  }
  async function close(){
    closingBuilds=true;
    const failures=[];
    for(const [id,job] of live){
      try{const result=await job.stop();if(!result.verified||!result.retired||result.unknown||result.ioFault)
        throw Error('build_retirement_unknown');
        mark(id,{jobRetired:true});
        live.delete(id);}catch(error){unknown(mustGet(id));failures.push(error);}
    }
    await Promise.allSettled([...inflight]);
    for(const item of store.db.prepare('SELECT value FROM preview_controlled_builds').all()){
      let row;try{row=JSON.parse(item.value);}catch{failures.push(Error('build_record_unreadable'));continue;}
      try{
        if(row.recordId){
          if(!ID.test(row.recordId)||typeof row.jobWorkspace!=='string')throw Error('build_record_binding_unknown');
          const record=await readRetiredJobRecord(jobRoot,row.recordId,row.taskId,row.jobWorkspace);
          if(row.neverStarted===true){
            if(row.state!=='failed_no_publish'||row.attempted===true||row.jobRetired===true||
              record.attempted!==false)throw Error('build_executor_unresolved');
          }else if(row.attempted===true||row.jobRetired===true||row.state==='ready'){
            if(record.attempted!==true)throw Error('build_executor_unresolved');
          }else throw Error('build_executor_unresolved');
        }else if(row.attempted)throw Error('build_record_missing');
        // A publication may still be pending. The private retirement record,
        // rather than a boolean in our intent, releases the process shutdown.
        if(!['ready','failed_no_publish'].includes(row.state)&&row.jobRetired!==true)
          throw Error('build_executor_unresolved');
      }catch(error){failures.push(error);}
    }
    if(failures.length)throw new AggregateError(failures,'受控构建执行器未能确认退出');
  }
  function assertMetadataReplacementSafe(){
    const rows=store.db.prepare('SELECT value FROM preview_controlled_builds').all();
    for(const item of rows){
      let row;try{row=JSON.parse(item.value);}catch{fail('BUILD_EXECUTOR_UNKNOWN','受控构建记录无法核实');}
      if(!['ready','failed_no_publish'].includes(row.state))
        fail('BUILD_BUSY','受控构建仍未结清');
    }
  }
  function assertNoUnfencedIntents(projectId){
    let target;
    try{target=realpathSync(store.getProject(projectId).directory);}catch{
      fail('BUILD_EXECUTOR_UNKNOWN','项目目录不能核实');}
    for(const item of store.db.prepare('SELECT value FROM preview_controlled_builds').all()){
      let row;try{row=JSON.parse(item.value);}catch{fail('BUILD_EXECUTOR_UNKNOWN','受控构建记录无法核实');}
      if(['ready','failed_no_publish'].includes(row.state))continue;
      const lease=row.requestId&&row.taskId?leases.previewBuildFor({requestId:row.requestId,taskId:row.taskId}):null;
      if(!row.requestId||!row.taskId||!row.projectId||!row.workspace||!lease||
        !['reserved','running','unknown'].includes(lease.status)||lease.workspace!==row.workspace)
        fail('BUILD_EXECUTOR_UNKNOWN','受控构建租约与原记录不一致');
      let workspace;
      try{workspace=realpathSync(row.workspace);}catch{fail('BUILD_EXECUTOR_UNKNOWN','原构建目录不能核实');}
      if(workspace!==row.workspace)fail('BUILD_EXECUTOR_UNKNOWN','原构建目录身份已变化');
      if(row.projectId===projectId||overlaps(target,workspace))fail('BUILD_BUSY','重叠项目仍有受控构建');
    }
  }
  return {start,state,reconcile,close,verifiedSourceForPreview,assertMetadataReplacementSafe,assertNoUnfencedIntents};
}
