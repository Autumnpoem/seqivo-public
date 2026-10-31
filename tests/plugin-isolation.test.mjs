import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,copyFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createIsolatedPlugin} from '../server/plugin-process.mjs';
import {createCore} from '../server/core.mjs';

async function fixture(t,source,{permissions=[],timeouts={}}={}){
  const dir=await mkdtemp(join(tmpdir(),'tuijin-isolation-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const pluginDir=join(dir,'example');await mkdir(pluginDir);
  const entry=join(pluginDir,'host.mjs');await writeFile(entry,source);
  const seen={emits:0,updates:[]};
  const context={
    getTask:async id=>({id,projectId:'p1',revision:1,status:'blocked'}),
    getProject:async id=>({id,directory:dir}),
    updateTask:async(id,patch,revision)=>{seen.updates.push({id,patch,revision});return {id,revision:revision+1,...patch};},
    emit:()=>{seen.emits++;},
  };
  const options={entry,manifest:{id:'example',name:'Example',version:'1',permissions},context,dataDir:join(dir,'data'),pluginDir,timeouts};
  return {dir,seen,options};
}

test('isolated plugin lifecycle carries allowed callbacks and structured errors',async t=>{
  const x=await fixture(t,`export function createPlugin({getTask,getProject,updateTask,emit}){
    let enabled=false;const state=()=>({enabled,available:true,status:enabled?'ready':'disabled'});
    return {state,configure:state,enable:async()=>{console.log('ordinary plugin log');
      const task=await getTask('t1');const project=await getProject(task.projectId);
      await updateTask(task.id,{status:'running',blockedReason:''},task.revision);emit();enabled=Boolean(project.directory);return state();},
      disable:async()=>{enabled=false;return state()},check:async()=>{const e=Error('revision changed');e.status=409;e.code='REVISION_CONFLICT';throw e},
      createSession:async()=>({status:'created'}),close:async()=>{}};
  }`,{permissions:['tasks.read','task.resume']});
  const plugin=await createIsolatedPlugin(x.options);
  try{
    assert.equal((await plugin.state()).enabled,false);
    assert.equal((await plugin.enable()).enabled,true);
    assert.deepEqual(x.seen.updates,[{id:'t1',patch:{status:'running',blockedReason:''},revision:1}]);
    assert.equal(x.seen.emits,1);
    assert.deepEqual(await plugin.createSession({taskId:'t1'}),{status:'created'});
    await assert.rejects(plugin.check(),e=>e.status===409&&e.code==='REVISION_CONFLICT');
  }finally{await plugin.close();}
});

test('callback whitelist blocks unauthorized reads and baseline writes',async t=>{
  const noRead=await fixture(t,`export function createPlugin({getTask}){const state=()=>({available:true});return {state,configure:state,enable:state,disable:state,check:()=>getTask('t1'),close:async()=>{}}}`);
  const plugin=await createIsolatedPlugin(noRead.options);
  try{await assert.rejects(plugin.check(),e=>e.code==='PERMISSION_DENIED');}finally{await plugin.close();}
  const noBaseline=await fixture(t,`export function createPlugin({updateTask}){const state=()=>({available:true});return {state,configure:state,enable:state,disable:state,check:()=>updateTask('t1',{goal:'lower bar'},1),close:async()=>{}}}`,{permissions:['task.resume']});
  const second=await createIsolatedPlugin(noBaseline.options);
  try{await assert.rejects(second.check(),e=>e.code==='PERMISSION_DENIED');assert.equal(noBaseline.seen.updates.length,0);}finally{await second.close();}
});

test('isolated execution callbacks validate and forward expectedRevision before reservation',async t=>{
  const x=await fixture(t,`export function createPlugin({authorizeExecution,revalidateExecution}){
    const state=()=>({available:true});return {state,configure:state,enable:state,disable:state,
      check:async()=>({authorize:await authorizeExecution({taskId:'t1',commandId:'c1',expectedRevision:3}),
        revalidate:await revalidateExecution({taskId:'t1',commandId:'c1',expectedRevision:3})}),
      resume:async input=>authorizeExecution({taskId:'t1',commandId:'c2',expectedRevision:input.expectedRevision}),
      close:async()=>{}};
  }`,{permissions:['task.resume']});
  const received=[];
  x.options.context.authorizeExecution=async input=>{received.push(['authorize',input]);return {maySend:true};};
  x.options.context.revalidateExecution=async input=>{received.push(['revalidate',input]);return {maySend:true};};
  const plugin=await createIsolatedPlugin(x.options);
  try{
    const result=await plugin.check();
    assert.equal(result.authorize.maySend,true);
    assert.equal(result.revalidate.maySend,true);
    assert.deepEqual(received,[
      ['authorize',{taskId:'t1',commandId:'c1',expectedRevision:3}],
      ['revalidate',{taskId:'t1',commandId:'c1',expectedRevision:3}],
    ]);
    await assert.rejects(plugin.resume({expectedRevision:0}),error=>error.code==='INVALID_CALLBACK');
    assert.equal(received.length,2,'invalid revision must not reach the authorizer');
  }finally{await plugin.close();}
});

test('Core rejects a stale isolated worker authorization before creating a lease',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'tuijin-isolated-revision-'));
  const pluginDir=join(dir,'plugins'),extension=join(pluginDir,'fake');
  await mkdir(extension,{recursive:true});
  await writeFile(join(extension,'plugin.json'),JSON.stringify({id:'fake',name:'Fake execution',version:'1',apiVersion:1,
    entry:'host.mjs',permissions:['tasks.read','task.resume'],capabilities:['task.resume']}));
  await writeFile(join(extension,'host.mjs'),`export function createPlugin({authorizeExecution}){
    const state=()=>({enabled:false,available:true});
    return {state,enable:state,disable:state,check:state,close:async()=>{},
      configure:input=>authorizeExecution(input),getExecution:async()=>({status:'not_started'})};
  }`);
  let core;
  const failures=[];
  try{
    core=await createCore({dataDir:join(dir,'data'),pluginDir,files:false});
    const project=core.store.project({name:'Isolated revision',directory:dir});
    const task=core.store.createTask({projectId:project.id,title:'Revision gate',conversationId:'thread-1',executionProvider:'fake'});
    await assert.rejects(core.request('PATCH','/api/plugins/fake/config',
      {taskId:task.id,commandId:'stale-command',expectedRevision:task.revision+1}),/版本|更新/);
    assert.equal(core.leases.state().active.length,0);
  }catch(error){failures.push(error);}
  try{if(core)await core.close();}catch(error){failures.push(new Error('Core close failed',{cause:error}));}
  try{await rm(dir,{recursive:true,force:true});}catch(error){failures.push(new Error('Fixture cleanup failed',{cause:error}));}
  if(failures.length)throw new AggregateError(failures,'Isolated Core revision gate or cleanup failed');
});

test('plugin crash becomes unavailable and does not crash the host',async t=>{
  const x=await fixture(t,`export function createPlugin(){const state=()=>({available:true});return {state,configure:state,enable:state,disable:state,check:()=>process.exit(7),close:async()=>{}}}`);
  const plugin=await createIsolatedPlugin(x.options);
  await assert.rejects(plugin.check(),e=>e.code==='PLUGIN_UNAVAILABLE');
  assert.equal((await plugin.state()).status,'unavailable');
  await assert.rejects(plugin.close(),e=>e.code==='SHUTDOWN_UNCONFIRMED');
  const other=await fixture(t,`export function createPlugin(){const state=()=>({available:true,status:'ready'});return {state,configure:state,enable:state,disable:state,check:state,close:async()=>{}}}`);
  const healthy=await createIsolatedPlugin(other.options);
  try{assert.equal((await healthy.check()).status,'ready');}finally{await healthy.close();}
});

test('timed-out resume is unknown and is never retried by the process wrapper',async t=>{
  const x=await fixture(t,`import {appendFileSync} from 'node:fs';export function createPlugin({dataDir}){
    const file=dataDir+'/attempts';const state=()=>({available:true});
    return {state,configure:state,enable:state,disable:state,check:state,
      resume:async()=>{appendFileSync(file,'send\\n');await new Promise(()=>{})},close:async()=>{}};
  }`,{timeouts:{resume:80}});
  await mkdir(x.options.dataDir,{recursive:true});
  const plugin=await createIsolatedPlugin(x.options);
  await assert.rejects(plugin.resume({taskId:'t1',commandId:'c1'}),e=>e.code==='UNKNOWN_RESULT');
  await assert.rejects(plugin.close(),e=>e.code==='SHUTDOWN_UNCONFIRMED');
  assert.equal(await readFile(join(x.options.dataDir,'attempts'),'utf8'),'send\n');
  assert.equal((await plugin.state()).status,'unavailable');
});

test('close errors are surfaced even when the worker is terminated',async t=>{
  const x=await fixture(t,`export function createPlugin(){const state=()=>({available:true});return {state,configure:state,enable:state,disable:state,check:state,close:async()=>{throw Error('descendant shutdown unconfirmed')}}}`);
  const plugin=await createIsolatedPlugin(x.options);
  await assert.rejects(plugin.close(),/descendant shutdown unconfirmed/);
});

test('isolated Codex host keeps its task callbacks with a fake app-server',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'tuijin-isolated-codex-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const pluginDir=fileURLToPath(new URL('../plugins/codex-autocontinue/',import.meta.url));
  const executable=join(dir,'fake-codex');
  await copyFile(fileURLToPath(new URL('./plugin-fake-codex.py',import.meta.url)),executable);await chmod(executable,0o700);
  const scenario=join(dir,'scenario.json'),log=join(dir,'codex.log');
  await writeFile(scenario,'{}');await writeFile(log,'');
  process.env.TASKBOARD_FAKE_SCENARIO=scenario;
  process.env.TASKBOARD_FAKE_LOG=log;
  process.env.TASKBOARD_FAKE_CWD=dir;
  process.env.TASKBOARD_FAKE_PID=join(dir,'fake.pid');
  let task={id:'t1',projectId:'p1',title:'Fake test',goal:'Only fake protocol',conversationId:'thread-1',status:'blocked',blockedReason:'Codex quota exhausted',acceptance:'unverified',revision:1};
  const context={getTask:async()=>task,getProject:async()=>({id:'p1',directory:dir}),updateTask:async(_id,patch,revision)=>{assert.equal(task.revision,revision);task={...task,...patch,revision:revision+1};return task;},emit:()=>{}};
  const manifest=JSON.parse(await readFile(join(pluginDir,'plugin.json'),'utf8'));
  const plugin=await createIsolatedPlugin({entry:join(pluginDir,'host.mjs'),manifest,context,dataDir:join(dir,'state'),pluginDir});
  try{
    await plugin.configure({pythonPath:process.env.TASKBOARD_TEST_PYTHON||'python3',codexPath:executable,pollSeconds:86400});
    const result=await plugin.resume({taskId:'t1',expectedRevision:1,commandId:'fake-command'});
    assert.equal(result.status,'running');
    assert.equal(task.status,'running');
    assert.equal((await readFile(log,'utf8')).split('\n').filter(line=>line.includes('"turn/start"')).length,1);
  }finally{await plugin.close();}
});
