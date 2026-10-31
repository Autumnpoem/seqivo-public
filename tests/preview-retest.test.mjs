import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,realpath,rm,writeFile,unlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {createPreviewSourceSnapshot} from '../server/preview/source-snapshot.mjs';
import {createLocalPreview} from '../server/preview/local.mjs';
import {createControlledPreviewBuilds} from '../server/preview/controlled-build.mjs';
import {createPreviewRetest} from '../server/preview/retest.mjs';
import {createCore} from '../server/core.mjs';

const exec=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
const profileDigest=sha('vite-vanilla-v1:configFile=false:envDir=false:envPrefix=[]:publicDir=false:postcss=[]:base=./');
async function fixture(t,{criteriaCount=1}={}){
  const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-retest-')));
  const source=join(root,'source'),data=join(root,'data');
  await mkdir(source);await mkdir(data,{mode:0o700});
  t.after(()=>rm(root,{recursive:true,force:true}));
  const git=async(...args)=>exec('/usr/bin/git',['-c','core.fsmonitor=false','-c','core.hooksPath=/dev/null','-C',source,...args]);
  await git('init','-q');
  await writeFile(join(source,'app.js'),'export const label = "old";\n');
  await writeFile(join(source,'README.md'),'old instructions\n');
  await git('add','app.js','README.md');
  await git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','fixture');
  const before=await createPreviewSourceSnapshot({sourceDir:source,dataDir:data});
  await writeFile(join(source,'app.js'),'export const label = "new";\n');
  await unlink(join(source,'README.md'));
  const after=await createPreviewSourceSnapshot({sourceDir:source,dataDir:data});
  const store=new Store(join(data,'board.sqlite'));t.after(()=>store.close());
  const project=store.project({name:'Fixture',directory:source});
  const task=store.createTask({projectId:project.id,title:'Retest',
    criteria:Array.from({length:criteriaCount},(_,index)=>`Check output ${index}`)});
  const manifests=new Map(),registry={get:async id=>manifests.get(id),isRegistered:async id=>manifests.has(id)};
  const local=createLocalPreview({store,registry});
  const builds=createControlledPreviewBuilds({store,leases:{},registry,local,dataDir:data,
    pythonPath:'/never-used',assertAuthority:()=>{},nodeBinding:()=>null,link:()=>({}),resolveWorktree:()=>source});
  function register(id,snapshot){
    const digest=snapshot.receipt.sourceDigest,artifact=sha(id),input=sha(`input:${id}`),
      tool=sha('tool'),buildReceipt=sha(`build:${id}`);
    const row={requestId:`request-${id}`,previewId:id,projectId:project.id,taskId:task.id,
      expectedRevision:task.revision,contentVersion:task.contentVersion,worktreeId:null,
      workspace:source,projectDirectory:source,state:'ready',snapshotId:snapshot.snapshotId,
      sourceDigest:digest,sourceCommit:snapshot.receipt.sourceCommit,artifactDigest:artifact,
      inputDigest:input,toolDigest:tool,buildReceiptDigest:buildReceipt,
      dataMode:'simulated',apiTarget:'static',dataStoreId:null};
    const manifest={previewId:id,projectId:project.id,taskId:task.id,
      contentVersion:task.contentVersion,sourceTaskRevision:task.revision,
      sourceCommit:snapshot.receipt.sourceCommit,artifactDigest:artifact,
      dataMode:'simulated',apiTarget:'static',dataStoreId:null,
      provenance:{kind:'managed-vite-vanilla-v1',sourceDigest:digest,inputDigest:input,
        toolDigest:tool,profileDigest,buildReceiptDigest:buildReceipt}};
    store.db.prepare('INSERT INTO preview_controlled_builds VALUES(?,?)').run(row.requestId,JSON.stringify(row));
    local.record(manifest,task.criteria,source);manifests.set(id,manifest);
    return row;
  }
  const old=register('preview-old',before),current=register('preview-new',after);
  const retest=createPreviewRetest({store,builds,local});
  local.bindRetestComparator(retest.compare);
  return {root,data,source,store,task,project,local,retest,builds,before,after,old,current,manifests,register};
}

test('verified source comparison and owner CAS map retain changed file and tracked deletion evidence',async t=>{
  const x=await fixture(t);
  const initial=await x.retest.mapping('preview-new');
  assert.equal(initial.editable,true);
  assert.deepEqual(initial.eligiblePaths.map(item=>[item.path,item.kind]),
    [['app.js','file'],['README.md','deleted']]);
  const input={expectedTaskRevision:x.task.revision,contentVersion:x.task.contentVersion,
    sourceDigest:x.after.receipt.sourceDigest,expectedMapRevision:0,
    items:[{criterionId:x.task.criteria[0].id,paths:['app.js','README.md'],checkSteps:['Open the page']} ]};
  const saved=await x.retest.put('preview-new',input);
  assert.equal(saved.mapRevision,1);
  await assert.rejects(x.retest.put('preview-new',input),{code:'PREVIEW_RETEST_STALE'});
  const compare=await x.local.request('GET','/api/previews/preview-new/retest?previous=preview-old',{},'viewer');
  assert.equal(compare.sourceState,'verified');
  assert.equal(compare.items[0].status,'needs_retest');
  assert.deepEqual(compare.items[0].changedPaths.map(item=>item.path),['README.md','app.js']);
  assert.deepEqual(compare.changedFiles.map(item=>item.change),['deleted','modified']);
  assert.equal(JSON.stringify(compare).includes(x.root),false);
  assert.equal(JSON.stringify(compare).includes(x.after.snapshotId),false);
  const revoked=await x.retest.put('preview-new',{...input,expectedMapRevision:1,items:[]});
  assert.equal(revoked.mapRevision,2);
  const afterRevoke=await x.local.request('GET','/api/previews/preview-new/retest?previous=preview-old',{},'viewer');
  assert.equal(afterRevoke.items[0].status,'unknown');
  await x.retest.put('preview-new',{...input,expectedMapRevision:2,
    items:[{criterionId:x.task.criteria[0].id,paths:['app.js'],checkSteps:[]}]});
  const missingSteps=await x.local.request('GET','/api/previews/preview-new/retest?previous=preview-old',{},'viewer');
  assert.equal(missingSteps.items[0].status,'unknown');
  assert.equal(missingSteps.items[0].reasonCode,'check_steps_missing');
});

test('missing or duplicate controlled source, imported preview, and changed task stay unknown',async t=>{
  const x=await fixture(t);
  const duplicate={...x.current,requestId:'duplicate-new'};
  x.store.db.prepare('INSERT INTO preview_controlled_builds VALUES(?,?)')
    .run(duplicate.requestId,JSON.stringify(duplicate));
  const duplicateResult=await x.local.request('GET','/api/previews/preview-new/retest?previous=preview-old',{},'viewer');
  assert.equal(duplicateResult.sourceState,'unknown');
  await assert.rejects(x.retest.mapping('preview-new'),{code:'PREVIEW_RETEST_SOURCE_UNKNOWN'});
  x.store.db.prepare('DELETE FROM preview_controlled_builds WHERE request_id=?').run(duplicate.requestId);
  x.store.updateTask(x.task.id,{criteria:['Rewritten criterion']},x.task.revision);
  const changed=await x.local.request('GET','/api/previews/preview-new/retest?previous=preview-old',{},'viewer');
  assert.equal(changed.currentTaskMatchesPreview,false);
  assert.equal(changed.items[0].status,'unknown');
  const same=await x.local.request('GET','/api/previews/preview-new/retest?previous=preview-new',{},'viewer');
  assert.equal(same.items[0].status,'unknown');
});

test('one-ended source entries and private paths cannot become a no-retest conclusion',async t=>{
  const x=await fixture(t);
  await writeFile(join(x.source,'new.txt'),'new untracked file\n');
  const newer=await createPreviewSourceSnapshot({sourceDir:x.source,dataDir:x.data});
  x.register('preview-newer',newer);
  const result=await x.local.request('GET','/api/previews/preview-newer/retest?previous=preview-new',{},'viewer');
  assert.equal(result.sourceState,'unknown');
  assert.equal(result.changedFiles.length,0);
  assert.equal(result.items[0].status,'unknown');
  await assert.rejects(x.retest.put('preview-newer',{expectedTaskRevision:x.task.revision,
    contentVersion:x.task.contentVersion,sourceDigest:newer.receipt.sourceDigest,
    expectedMapRevision:0,items:[{criterionId:x.task.criteria[0].id,paths:['secret.srl'],checkSteps:[]}] }),
  {code:'PREVIEW_RETEST_INPUT'});
});

test('different recorded worktree bindings cannot yield a path-level conclusion',async t=>{
  const x=await fixture(t),other=join(x.root,'other-worktree');
  await mkdir(other);
  x.store.db.prepare('UPDATE preview_controlled_builds SET value=? WHERE request_id=?')
    .run(JSON.stringify({...x.old,worktreeId:'other',workspace:other}),x.old.requestId);
  const comparator=createPreviewRetest({store:x.store,builds:x.builds,local:x.local,
    resolveWorktree:()=>other});
  const result=await comparator.compare(await x.local.build('preview-new'),await x.local.build('preview-old'));
  assert.equal(result.sourceState,'unknown');
  assert.equal(result.reasonCode,'source_binding_changed');
  assert.equal(result.items[0].status,'unknown');
});

test('multibyte mapping limits reject new writes and explicitly retain older oversized settings',async t=>{
  const x=await fixture(t,{criteriaCount:100});
  const input={expectedTaskRevision:x.task.revision,contentVersion:x.task.contentVersion,
    sourceDigest:x.after.receipt.sourceDigest,expectedMapRevision:0,
    items:[{criterionId:x.task.criteria[0].id,paths:['app.js'],checkSteps:['Open page']}]};
  await x.retest.put('preview-new',input);
  const before=x.store.db.prepare('SELECT * FROM preview_retest_maps WHERE preview_id=?').get('preview-new');
  const large=x.task.criteria.map(item=>({criterionId:item.id,paths:['app.js','README.md'],
    checkSteps:Array.from({length:5},()=> '测'.repeat(300))})).sort((a,b)=>a.criterionId.localeCompare(b.criterionId));
  await assert.rejects(x.retest.put('preview-new',{...input,expectedMapRevision:1,items:large}),
    {code:'PREVIEW_RETEST_LIMIT'});
  assert.deepEqual(x.store.db.prepare('SELECT * FROM preview_retest_maps WHERE preview_id=?').get('preview-new'),before);
  x.store.db.prepare('UPDATE preview_retest_maps SET items_json=?,mapping_digest=? WHERE preview_id=?')
    .run(JSON.stringify(large),sha(JSON.stringify(large)),'preview-new');
  const read=await x.retest.mapping('preview-new');
  assert.equal(read.editable,false);
  assert.equal(read.blockedReason,'mapping_limit');
  assert.equal(read.mappingRetained,true);
  assert.equal(x.store.db.prepare('SELECT items_json FROM preview_retest_maps WHERE preview_id=?')
    .get('preview-new').items_json,JSON.stringify(large));
});

test('a mapping accepted by PUT always fits the complete editable GET DTO',async t=>{
  const x=await fixture(t,{criteriaCount:100});
  const before=await x.retest.mapping('preview-new');
  const make=length=>x.task.criteria.map(item=>({criterionId:item.id,paths:['app.js'],
    checkSteps:['测'.repeat(length)]})).sort((a,b)=>a.criterionId.localeCompare(b.criterionId));
  const putSize=items=>Buffer.byteLength(JSON.stringify({items,eligiblePaths:before.eligiblePaths}));
  const getSize=items=>Buffer.byteLength(JSON.stringify({...before,mapRevision:1,
    mappingDigest:sha(JSON.stringify(items)),items,mappingRetained:true}));
  let low=1,high=300;
  while(low<high){const middle=Math.ceil((low+high)/2);
    if(putSize(make(middle))<=65536)low=middle;else high=middle-1;}
  const borderline=make(low);
  assert.ok(putSize(borderline)<=65536,'fixture must satisfy the previous PUT budget');
  assert.ok(getSize(borderline)>65536,'fixture must exceed the complete GET budget');
  const input={expectedTaskRevision:x.task.revision,contentVersion:x.task.contentVersion,
    sourceDigest:x.after.receipt.sourceDigest,expectedMapRevision:0,items:borderline};
  await assert.rejects(x.retest.put('preview-new',input),{code:'PREVIEW_RETEST_LIMIT'});
  assert.equal(x.store.db.prepare('SELECT count(*) AS n FROM preview_retest_maps').get().n,0);
  let fitting=low-1;
  while(fitting>=1&&getSize(make(fitting))>65536)fitting--;
  assert.ok(fitting>=1);
  const accepted=make(fitting);
  const saved=await x.retest.put('preview-new',{...input,items:accepted});
  const read=await x.retest.mapping('preview-new');
  assert.equal(read.editable,true);
  assert.equal(read.blockedReason,undefined);
  assert.equal(read.mapRevision,saved.mapRevision);
  assert.equal(read.mappingDigest,saved.mappingDigest);
  assert.deepEqual(read.items,accepted);
  assert.ok(Buffer.byteLength(JSON.stringify(read))<=65536);
});

test('tampered map digest or path cannot turn a comparison into needs_retest',async t=>{
  const x=await fixture(t),empty={expectedTaskRevision:x.task.revision,
    contentVersion:x.task.contentVersion,sourceDigest:x.after.receipt.sourceDigest,
    expectedMapRevision:0,items:[]};
  await x.retest.put('preview-new',empty);
  const forged=[{criterionId:x.task.criteria[0].id,paths:['app.js'],checkSteps:['Open page']}];
  x.store.db.prepare('UPDATE preview_retest_maps SET items_json=? WHERE preview_id=?')
    .run(JSON.stringify(forged),'preview-new');
  const result=await x.local.request('GET','/api/previews/preview-new/retest?previous=preview-old',{},'viewer');
  assert.equal(result.sourceState,'unknown');
  assert.equal(result.reasonCode,'mapping_invalid');
  assert.equal(result.items[0].status,'unknown');
  const invalid=[{criterionId:x.task.criteria[0].id,paths:['not-in-snapshot.js'],checkSteps:['Open page']}];
  x.store.db.prepare('UPDATE preview_retest_maps SET items_json=?,mapping_digest=? WHERE preview_id=?')
    .run(JSON.stringify(invalid),sha(JSON.stringify(invalid)),'preview-new');
  const missing=await x.local.request('GET','/api/previews/preview-new/retest?previous=preview-old',{},'viewer');
  assert.equal(missing.sourceState,'unknown');
  assert.equal(missing.reasonCode,'mapping_invalid');
  x.store.db.prepare('UPDATE preview_retest_maps SET items_json=?,mapping_digest=?,schema_version=2 WHERE preview_id=?')
    .run('[]',sha('[]'),'preview-new');
  const schema=await x.local.request('GET','/api/previews/preview-new/retest?previous=preview-old',{},'viewer');
  assert.equal(schema.sourceState,'unknown');
  x.store.db.prepare('UPDATE preview_retest_maps SET schema_version=1,map_revision=0 WHERE preview_id=?')
    .run('preview-new');
  const revision=await x.local.request('GET','/api/previews/preview-new/retest?previous=preview-old',{},'viewer');
  assert.equal(revision.sourceState,'unknown');
});

test('Core exposes owner-only mapping route without granting preview access or creating a cap',async t=>{
  const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-retest-core-')));
  const data=join(root,'data'),plugins=join(root,'plugins');
  await mkdir(data,{mode:0o700});await mkdir(plugins,{mode:0o700});
  let core;
  try{
    core=await createCore({dataDir:data,pluginDir:plugins,files:false});
    await assert.rejects(core.request('GET','/api/preview/retest-mappings/test-preview',{},'viewer'),
      {code:'PREVIEW_FORBIDDEN'});
    await assert.rejects(core.request('PUT','/api/preview/retest-mappings/test-preview',{},'viewer'),
      {code:'PREVIEW_FORBIDDEN'});
    await assert.rejects(core.request('GET','/api/preview/retest-mappings/test-preview',{},'owner'),
      {code:'PREVIEW_NOT_FOUND'});
  }finally{
    let cleanup;
    try{if(core)await core.close();}catch(error){cleanup=error;}
    try{await rm(root,{recursive:true,force:true});}catch(error){cleanup=cleanup?new AggregateError([cleanup,error]):error;}
    if(cleanup)throw cleanup;
  }
});
