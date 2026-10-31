import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../server/store.mjs';
import { createTerminalControl } from '../server/terminal/control.mjs';
import { verifyTaskJobRetired } from '../plugins/codex-autocontinue/job-transport.mjs';
import { createIsolatedPlugin } from '../server/plugin-process.mjs';

const scope='macos-parked-managed-pane-and-visible-writers';
const ref={serverName:'managed_retirement',instanceId:'a'.repeat(64),sessionId:'$0'};
const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-owned'});
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture(t){
  const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-retirement-lineage-')));
  const store=new Store(join(root,'board.sqlite'));
  const project=store.project({name:'Retirement lineage',directory:root});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  let resume;
  const gate=new Promise(resolve=>{resume=()=>resolve(clear());});
  const options={store,quiesce:()=>gate,inspectWriters:async()=>clear(),
    inspectExisting:async()=>({verified:true,authorized:true,unknown:false,unownedWriters:[],
      sessionEvidence:[{sessionRef:ref}],scope:'test-managed-identity'}),
    snapshot:async()=>({directory:root,files:{},count:0,bytes:0,snapshotScope:'test',capturedAt:new Date().toISOString()})};
  const control=createTerminalControl(options);
  const image={version:1,entries:{}};
  const evidence=[{sessionRef:ref}];
  image.entries[project.id]={projectId:project.id,workspace:root,actorId:'owner',mode:'managed',
    phase:'ai_ready',generation:7,since:new Date().toISOString(),profileId:'profile',
    sessionRefs:[ref],sessionEvidence:evidence,
    returnEvidence:{scope,checkedAt:new Date().toISOString()},
    managedParkedReturn:{version:1,generation:7,workspace:root,profileId:'profile',
      sessionEvidenceDigest:digest(evidence),scope}};
  const write=()=>store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('terminal.control.v1',JSON.stringify(image));
  write();
  return {root,store,project,control,image,write,resume,options};
}

test('complete parked return carries original G through stopping, then clears on human grant',async t=>{
  const f=await fixture(t),id=f.project.id;
  assert.equal(f.control.retirementHandoff(id,7)?.phase,'ai_ready');
  const pending=f.control.acquire({projectId:id,actorId:'owner'});
  const stopping=f.control.retirementHandoff(id,7);
  assert.equal(stopping?.phase,'stopping');
  assert.equal(stopping?.currentGeneration,8);
  f.resume();
  const human=await pending;
  assert.equal(human.phase,'human');
  assert.equal(f.control.retirementHandoff(id,7),null);
});

test('restart during stopping keeps the original G fenced until explicit reconciliation',async t=>{
  const f=await fixture(t),id=f.project.id;
  const pending=f.control.acquire({projectId:id,actorId:'owner'});
  assert.equal(f.control.retirementHandoff(id,7)?.phase,'stopping');
  const restarted=createTerminalControl({...f.options,quiesce:async()=>clear()});
  assert.equal(restarted.retirementHandoff(id,7)?.phase,'unknown');
  assert.throws(()=>restarted.assertMayStart(id),{code:'CONTROL_BUSY'});
  f.resume();
  assert.equal((await pending).phase,'unknown');
  const next=await restarted.reconcile({projectId:id,actorId:'owner',action:'acquire'});
  assert.equal(next.phase,'human');
  assert.equal(restarted.retirementHandoff(id,7),null);
});

test('missing original receipt and malformed or duplicate refs cannot mint retirement lineage',async t=>{
  const f=await fixture(t),id=f.project.id,entry=f.image.entries[id];
  delete entry.managedParkedReturn;f.write();
  assert.equal(f.control.retirementHandoff(id,7),null);
  entry.managedParkedReturn={version:1,generation:7,workspace:f.root,profileId:'profile',
    sessionEvidenceDigest:digest(entry.sessionEvidence),scope};
  entry.sessionRefs=[{},{}];entry.sessionEvidence=[{sessionRef:{}},{sessionRef:{}}];
  entry.managedParkedReturn.sessionEvidenceDigest=digest(entry.sessionEvidence);f.write();
  assert.equal(f.control.retirementHandoff(id,7),null);
  entry.sessionRefs=[ref,ref];entry.sessionEvidence=[{sessionRef:ref},{sessionRef:ref}];
  entry.managedParkedReturn.sessionEvidenceDigest=digest(entry.sessionEvidence);f.write();
  assert.equal(f.control.retirementHandoff(id,7),null);
});

test('an unknown managed creation erases any inherited retired handoff authority',async t=>{
  const f=await fixture(t),id=f.project.id,entry=f.image.entries[id];
  entry.phase='unknown';entry.generation=8;entry.token='original-token';
  entry.parkedHandoffOrigin={generation:7,workspace:f.root,profileId:'profile',
    sessionRefs:[ref],sessionEvidenceDigest:digest(entry.sessionEvidence)};
  f.write();
  assert.equal(f.control.retirementHandoff(id,7)?.phase,'unknown');
  f.control.markManagedUnknown({projectId:id,token:'original-token',generation:8});
  assert.equal(f.control.retirementHandoff(id,7),null);
});

test('unknown reconciliation rotates the current generation even when original lineage stays G',async t=>{
  const f=await fixture(t),id=f.project.id,entry=f.image.entries[id];
  entry.phase='unknown';entry.generation=8;entry.actorId='owner';entry.token='original-token';
  entry.parkedHandoffOrigin={generation:7,workspace:f.root,profileId:'profile',
    sessionRefs:[ref],sessionEvidenceDigest:digest(entry.sessionEvidence)};
  f.write();
  const before=f.control.retirementHandoff(id,7);
  assert.equal(before.currentGeneration,8);
  const pending=f.control.reconcile({projectId:id,actorId:'owner',token:'original-token',action:'acquire'});
  const after=f.control.retirementHandoff(id,7);
  assert.equal(after.phase,'stopping');
  assert.equal(after.generation,before.generation);
  assert.notEqual(after.currentGeneration,before.currentGeneration);
  f.resume();assert.equal((await pending).phase,'human');
});

test('owner recovery from human never carries an older parked lineage into stopping',async t=>{
  const f=await fixture(t),id=f.project.id,entry=f.image.entries[id];
  entry.phase='human';entry.generation=8;entry.actorId='owner';entry.token='human-token';
  entry.parkedHandoffOrigin={generation:7,workspace:f.root,profileId:'profile',
    sessionRefs:[ref],sessionEvidenceDigest:digest(entry.sessionEvidence)};
  f.write();
  const pending=f.control.reconcile({projectId:id,actorId:'owner',token:'human-token',
    action:'acquire',trustedOwner:true});
  assert.equal(f.control.retirementHandoff(id,7),null);
  f.resume();assert.equal((await pending).phase,'human');
});

test('job retirement calls scoped proof only after original job retirement and refuses missing proof',async()=>{
  let called=0;
  const binding={taskId:'task',recordId:'a'.repeat(32),workspace:'/tmp/isolated-task',
    worktreeId:null,expectedHandoffGeneration:7};
  const verifyRetirementWorkspace=async received=>{called++;assert.deepEqual(received,binding);
    return {verified:true,quiescent:true,unknown:false,livePids:[],scope};};
  const job={recordId:binding.recordId,stop:async()=>({verified:true,retired:true})};
  const result=await verifyTaskJobRetired({job,workspace:binding.workspace,knownIdentities:[],
    retirementBinding:binding,verifyRetirementWorkspace});
  assert.equal(result.verified,true);assert.equal(called,1);
  const missing=await verifyTaskJobRetired({job,workspace:binding.workspace,knownIdentities:[],retirementBinding:binding});
  assert.equal(missing.unknown,true);
  const failed=await verifyTaskJobRetired({job:{...job,stop:async()=>({verified:false,retired:false,reason:'still live'})},
    workspace:binding.workspace,knownIdentities:[],retirementBinding:binding,verifyRetirementWorkspace});
  assert.equal(failed.unknown,true);assert.equal(called,1);
});

test('built-in retirement callback remains available while its worker closes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seqivo-retirement-rpc-'));
  const entry=join(root,'plugin.mjs');
  const binding={taskId:'task',recordId:'a'.repeat(32),workspace:root,worktreeId:null,expectedHandoffGeneration:7};
  await writeFile(entry,`export async function createPlugin(context){
    const state=()=>({available:true});let closed;return {state,configure:state,enable:state,disable:state,check:state,
      close:()=>closed??=context.verifyRetirementWorkspace(${JSON.stringify(binding)})};}`);
  let called=0;
  const plugin=await createIsolatedPlugin({entry,pluginDir:root,dataDir:root,trustedBuiltIn:true,
    manifest:{id:'codex-autocontinue',permissions:['task.resume']},
    context:{verifyRetirementWorkspace:input=>{called++;assert.deepEqual(input,binding);
      return {verified:true,quiescent:true,unknown:false};}}});
  t.after(async()=>{await plugin.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
  await plugin.close();
  assert.equal(called,1);
});

test('retirement callback cannot be requested by an extension or with extra authority fields',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seqivo-retirement-rpc-deny-'));
  const entry=join(root,'plugin.mjs');
  await writeFile(entry,`export async function createPlugin(context){
    const state=()=>({available:true});return {state,configure:state,enable:state,disable:state,check:state,
      close:()=>context.verifyRetirementWorkspace({taskId:'t',recordId:'${'a'.repeat(32)}',workspace:${JSON.stringify(root)},
        worktreeId:null,expectedHandoffGeneration:7,sessionRef:{}})};}`);
  let called=0;
  const plugin=await createIsolatedPlugin({entry,pluginDir:root,dataDir:root,trustedBuiltIn:false,
    manifest:{id:'codex-autocontinue',permissions:['task.resume']},
    context:{verifyRetirementWorkspace:()=>{called++;return {verified:true};}}});
  t.after(async()=>{await plugin.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
  await assert.rejects(plugin.close(),/permission|Retirement proof|not available/i);
  assert.equal(called,0);
  const builtIn=await createIsolatedPlugin({entry,pluginDir:root,dataDir:root,trustedBuiltIn:true,
    manifest:{id:'codex-autocontinue',permissions:['task.resume']},
    context:{verifyRetirementWorkspace:()=>{called++;return {verified:true};}}});
  t.after(()=>builtIn.close().catch(()=>{}));
  await assert.rejects(builtIn.close(),/Invalid retirement proof request/i);
  assert.equal(called,0);
});

test('bounded worker close timeout is reported as an unconfirmed shutdown',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seqivo-retirement-timeout-'));
  const entry=join(root,'plugin.mjs');
  await writeFile(entry,`export async function createPlugin(){const state=()=>({available:true});
    return {state,configure:state,enable:state,disable:state,check:state,
      close:()=>new Promise(resolve=>setTimeout(resolve,500))};}`);
  const plugin=await createIsolatedPlugin({entry,pluginDir:root,dataDir:root,trustedBuiltIn:true,
    manifest:{id:'codex-autocontinue',permissions:['task.resume']},context:{},timeouts:{close:20}});
  t.after(async()=>{await plugin.close().catch(()=>{});await rm(root,{recursive:true,force:true});});
  await assert.rejects(plugin.close(),error=>error.code==='PLUGIN_TIMEOUT'||error instanceof AggregateError);
});
