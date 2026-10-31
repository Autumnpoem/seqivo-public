import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCore} from '../server/core.mjs';
import {loadPlugins,shutdownErrorCategory} from '../server/plugin-loader.mjs';
import {createShutdownStageRecorder} from '../server/shutdown-diagnostics.mjs';

const SIDECAR=fileURLToPath(new URL('../server/sidecar.mjs',import.meta.url));
const SECRET='/private/credential-path TOKEN=do-not-log ' + 'x'.repeat(4096);
function withTimeout(promise,label){
  let timer;
  return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out`)),10000);})])
    .finally(()=>clearTimeout(timer));
}
async function fixture(t,{fail=false}={}){
  const root=await mkdtemp(join(tmpdir(),'seqivo-shutdown-diagnostic-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const pluginDir=join(root,'plugins'),directory=join(pluginDir,'diagnostic-probe'),dataDir=join(root,'data');
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'plugin.json'),JSON.stringify({id:'diagnostic-probe',name:'Diagnostic probe',apiVersion:1,entry:'host.mjs',permissions:[]}));
  await writeFile(join(directory,'host.mjs'),`export function createPlugin(){
    const state=()=>({enabled:false,available:true,status:'idle'});
    return {state,configure:state,enable:state,disable:state,check:state,
      close:async()=>{${fail?`const e=new Error(${JSON.stringify(SECRET)});e.code='SHUTDOWN_UNCONFIRMED';throw e;`:''}}};
  }`);
  return {root,pluginDir,dataDir};
}

test('failed local plugin close names bounded category but Core rejects and retains unsafe lock',async t=>{
  const x=await fixture(t,{fail:true}),events=[];
  const core=await createCore({dataDir:x.dataDir,pluginDir:x.pluginDir,files:false,onShutdown:event=>events.push(event)});
  let failure;
  try{await core.close();}catch(error){failure=error;}
  assert.ok(failure instanceof AggregateError);
  assert.ok(failure.errors.some(error=>error instanceof AggregateError));
  assert.equal(existsSync(join(x.dataDir,'core.lock')),true);
  const probe=events.filter(event=>event.stage==='plugin'&&event.pluginId==='diagnostic-probe');
  assert.deepEqual(probe,[{stage:'plugin',status:'rejected',phase:'close',pluginId:'diagnostic-probe',category:'SHUTDOWN_UNCONFIRMED'}]);
  assert.equal(JSON.stringify(events).includes('TOKEN='),false);
  assert.equal(JSON.stringify(events).includes('/private/credential-path'),false);
  assert.equal(events.some(event=>event.stage==='plugins'&&event.status==='rejected'),true);
});

test('successful local plugin close still clears Core lock and reports fulfillment',async t=>{
  const x=await fixture(t),events=[];
  const core=await createCore({dataDir:x.dataDir,pluginDir:x.pluginDir,files:false,onShutdown:event=>events.push(event)});
  await core.close();
  assert.equal(existsSync(join(x.dataDir,'core.lock')),false);
  assert.deepEqual(events.filter(event=>event.stage==='plugin'&&event.pluginId==='diagnostic-probe'),
    [{stage:'plugin',status:'fulfilled',phase:'close',pluginId:'diagnostic-probe'}]);
});

test('error category traversal is whitelist-only, bounded, and cycle-safe',()=>{
  const secret=new Error(SECRET);secret.code=SECRET;
  const code=new Error(SECRET);code.code='SHUTDOWN_UNCONFIRMED';
  const nested=new AggregateError([secret,code],SECRET);
  nested.errors.push(nested);
  assert.equal(shutdownErrorCategory(nested),'SHUTDOWN_UNCONFIRMED');
  assert.equal(shutdownErrorCategory(new AggregateError([secret],SECRET)),'UNCLASSIFIED');
  const oversized=new AggregateError(Array.from({length:1000},()=>secret),SECRET);
  oversized.errors.push(code);
  assert.equal(shutdownErrorCategory(oversized),'UNCLASSIFIED','late entries exceed the traversal cap');
  const hostile=new Error(SECRET);
  Object.defineProperty(hostile,'code',{get(){throw new Error(SECRET);}});
  assert.equal(shutdownErrorCategory(hostile),'UNCLASSIFIED');
});

test('diagnostic callback rejection cannot change a successful plugin close',async t=>{
  const x=await fixture(t);
  const loader=await loadPlugins({pluginDir:join(x.root,'missing'),dataDir:x.dataDir,context:{},
    coreOwned:{'diagnostic-probe':{close:async()=>{}}},
    onShutdown:()=>Promise.reject(new Error(SECRET))});
  await loader.close();
});

test('Core stage callback rejection cannot change success or unsafe-lock failure',async t=>{
  for(const fail of [false,true]){
    const x=await fixture(t,{fail});
    const core=await createCore({dataDir:x.dataDir,pluginDir:x.pluginDir,files:false,
      onShutdown:()=>Promise.reject(new Error(SECRET))});
    if(fail){
      await assert.rejects(core.close(),AggregateError);
      assert.equal(existsSync(join(x.dataDir,'core.lock')),true);
    }else{
      await core.close();
      assert.equal(existsSync(join(x.dataDir,'core.lock')),false);
    }
  }
});

test('private recorder caps plugin rows and marks truncation while retaining aggregate outcome',async t=>{
  const x=await fixture(t),record=createShutdownStageRecorder({dataDir:x.dataDir,elapsedMs:()=>12.4});
  await mkdir(x.dataDir,{recursive:true});
  record({stage:'core',status:'started'});
  for(let i=0;i<100;i++)record({stage:'plugin',status:'fulfilled',phase:'close',pluginId:`diagnostic-${i}`});
  record({stage:'plugins',status:'rejected'});
  record({stage:'core',status:'rejected'});
  const rows=(await readFile(join(x.dataDir,'shutdown-stages.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(row=>row.stage==='plugin').length,64);
  assert.deepEqual(rows.filter(row=>row.stage==='plugin_diagnostics').map(row=>({status:row.status,limit:row.limit})),
    [{status:'truncated',limit:64}]);
  assert.equal(rows.some(row=>row.stage==='plugins'&&row.status==='rejected'),true);
  assert.equal(rows.some(row=>row.stage==='core'&&row.status==='rejected'),true);
  assert.equal(rows.length,68);
  assert.equal(new Set(rows.map(row=>row.runId)).size,1);
});

test('a late failing plugin is recorded before the success-row cap',async t=>{
  const x=await fixture(t),record=createShutdownStageRecorder({dataDir:x.dataDir,elapsedMs:()=>5});
  await mkdir(x.dataDir,{recursive:true});
  const coreOwned=Object.fromEntries(Array.from({length:80},(_,i)=>[`plugin-${i}`,{close:async()=>{}}]));
  coreOwned['z-failing-plugin']={close:async()=>{const error=new Error(SECRET);error.code='SHUTDOWN_UNCONFIRMED';throw error;}};
  const loader=await loadPlugins({pluginDir:join(x.root,'missing'),dataDir:x.dataDir,context:{},coreOwned,onShutdown:record});
  await assert.rejects(loader.close(),AggregateError);
  record({stage:'plugins',status:'rejected'});
  const rows=(await readFile(join(x.dataDir,'shutdown-stages.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  const firstPlugin=rows.find(row=>row.stage==='plugin');
  assert.deepEqual({pluginId:firstPlugin?.pluginId,status:firstPlugin?.status,category:firstPlugin?.category},
    {pluginId:'z-failing-plugin',status:'rejected',category:'SHUTDOWN_UNCONFIRMED'});
  assert.equal(rows.filter(row=>row.stage==='plugin').length,64);
  assert.equal(rows.filter(row=>row.stage==='plugin_diagnostics').length,1);
  assert.equal(rows.some(row=>row.stage==='plugins'&&row.status==='rejected'),true);
  assert.equal(JSON.stringify(rows).includes('TOKEN='),false);
});

async function sidecarCycle(t,{fail=false}={}){
  const x=await fixture(t,{fail}),child=spawn(process.execPath,[SIDECAR,x.dataDir,x.pluginDir],{
    cwd:resolve('.'),stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',ready;
  child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.includes('"event":"ready"'))ready?.();});
  child.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const exit=new Promise((resolveExit,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolveExit({code,signal}));});
  try{
    await withTimeout(new Promise(resolveReady=>{ready=resolveReady;if(stdout.includes('"event":"ready"'))ready();}),'sidecar ready');
    child.stdin.write('{"event":"shutdown"}\n');
    const outcome=await withTimeout(exit,'sidecar close');
    assert.deepEqual(outcome,{code:fail?1:0,signal:null},stderr);
    const records=(await readFile(join(x.dataDir,'shutdown-stages.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(records.length>2);
    const plugin=records.find(record=>record.stage==='plugin'&&record.pluginId==='diagnostic-probe');
    assert.equal(plugin?.status,fail?'rejected':'fulfilled');
    if(fail){
      assert.equal(plugin.category,'SHUTDOWN_UNCONFIRMED');
      assert.equal(existsSync(join(x.dataDir,'core.lock')),true);
      assert.equal(stdout.includes('shutdown-complete'),false);
    }
    assert.equal(new Set(records.map(record=>record.runId)).size,1);
    assert.match(records[0].runId,/^[0-9a-f]{8}-[0-9a-f-]{27,}$/);
    assert.equal(JSON.stringify(records).includes('TOKEN='),false);
    return records[0].runId;
  }finally{if(child.exitCode===null){child.kill('SIGTERM');await exit.catch(()=>{});}}
}

test('private sidecar shutdown records share a run ID within one process and change across processes',async t=>{
  const first=await sidecarCycle(t);
  const second=await sidecarCycle(t);
  assert.notEqual(first,second);
});

test('private sidecar failure record contains category without hostile message',async t=>{
  await sidecarCycle(t,{fail:true});
});
