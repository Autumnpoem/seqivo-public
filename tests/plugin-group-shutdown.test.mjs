import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createIsolatedPlugin} from '../server/plugin-process.mjs';
import {createPlugin} from '../plugins/codex-autocontinue/host.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function alive(pid){try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}}
// This child must finish its own delayed SIGTERM handler after its parent exits.
// An early SIGKILL destroys the completion marker and catches leader-only waits.
const descendant=`const fs=require('node:fs');const marker=process.argv[1];
process.on('SIGTERM',()=>setTimeout(()=>{fs.writeFileSync(marker,'graceful');process.exit(0)},350));
fs.writeFileSync(marker+'.pid',String(process.pid));process.stdout.write('ready\\n');setInterval(()=>{},1000);`;
async function fixture(t){
  const dir=await mkdtemp(join(tmpdir(),'seqivo-group-shutdown-')),marker=join(dir,'descendant');
  t.after(async()=>{const pid=Number(await readFile(marker+'.pid','utf8').catch(()=>0));
    if(pid&&alive(pid)){process.kill(pid,'SIGKILL');for(let i=0;i<100&&alive(pid);i++)await sleep(10);}
    await rm(dir,{recursive:true,force:true});});
  return {dir,marker};
}

test('isolated plugin shutdown waits for descendants after worker exits', {skip:process.platform==='win32'}, async t=>{
  const {dir,marker}=await fixture(t),entry=join(dir,'host.mjs');
  await writeFile(entry,`import {spawn} from 'node:child_process';
export async function createPlugin(){
  const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)},${JSON.stringify(marker)}],{stdio:['ignore','pipe','ignore']});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject)});
  const state=()=>({available:true});return {state,configure:state,enable:state,disable:state,check:state,close:async()=>{}};
}`);
  const plugin=await createIsolatedPlugin({entry,pluginDir:dir,dataDir:dir,manifest:{id:'delayed-descendant',permissions:[]},context:{}});
  try{
    const started=Date.now();await plugin.close();
    assert.equal(await readFile(marker,'utf8'),'graceful');
    assert.equal(alive(Number(await readFile(marker+'.pid','utf8'))),false);
    assert.ok(Date.now()-started<3000,'normal group shutdown should finish within its grace period');
  }finally{await plugin.close().catch(()=>{});}
});

for(const emitClosed of [false,true]) test(`Codex bridge shutdown waits for its process group ${emitClosed?'after a closed event':'after bridge exits'}`, {skip:process.platform==='win32'}, async t=>{
  const {dir,marker}=await fixture(t);
  // A protocol-only bridge fixture. It never invokes a provider or AI model.
  await writeFile(join(dir,'bridge.py'),`import json,os,subprocess,sys,time
child=subprocess.Popen(${JSON.stringify([process.execPath,'-e',descendant,marker])},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,text=True)
child.stdout.readline()
for line in sys.stdin:
    request=json.loads(line)
    if request['method']=='close': os._exit(0)
    result={'windows':[],'ready':True,'checkedAt':int(time.time())} if request['method']=='quota' else {'appServerPid':child.pid}
    print(json.dumps({'id':request['id'],'result':result}),flush=True)
    if request['method']=='quota' and ${emitClosed?'True':'False'}: print(json.dumps({'event':'closed'}),flush=True)
`);
  await mkdir(join(dir,'state'));
  const plugin=createPlugin({dataDir:join(dir,'state'),pluginDir:dir,getTask:async()=>null,getProject:async()=>null,updateTask:async()=>null});
  try{
    await plugin.configure({pythonPath:process.env.TASKBOARD_TEST_PYTHON||'python3',pollSeconds:86400});
    const checked=await plugin.check();
    if(emitClosed){
      const deadline=Date.now()+2000;
      while(plugin.state().status!=='unavailable'&&Date.now()<deadline)await sleep(10);
      assert.equal(plugin.state().status,'unavailable');
    }else assert.equal(checked.status,'ready');
    const started=Date.now();await plugin.close();
    assert.equal(await readFile(marker,'utf8'),'graceful');
    assert.equal(alive(Number(await readFile(marker+'.pid','utf8'))),false);
    assert.ok(Date.now()-started<5000,'bridge group shutdown should finish within its existing limit');
  }finally{await plugin.close().catch(()=>{});}
});

test('close during bridge startup drains and stops the late process group', {skip:process.platform==='win32'}, async t=>{
  const {dir,marker}=await fixture(t);
  await writeFile(join(dir,'bridge.py'),`import json,os,subprocess,sys,time
child=subprocess.Popen(${JSON.stringify([process.execPath,'-e',descendant,marker])},stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,text=True)
child.stdout.readline()
for line in sys.stdin:
    request=json.loads(line)
    if request['method']=='close': os._exit(0)
    if request['method']=='open': time.sleep(0.4)
    result={'windows':[],'ready':True,'checkedAt':int(time.time())} if request['method']=='quota' else {'appServerPid':child.pid}
    print(json.dumps({'id':request['id'],'result':result}),flush=True)
`);
  const dataDir=join(dir,'state'),plugin=createPlugin({dataDir,pluginDir:dir,getTask:async()=>null,getProject:async()=>null,updateTask:async()=>null});
  await plugin.configure({pythonPath:process.env.TASKBOARD_TEST_PYTHON||'python3',pollSeconds:86400});
  const checking=plugin.check();
  try{
    const deadline=Date.now()+2000;
    while(!(await readFile(marker+'.pid','utf8').catch(()=>''))&&Date.now()<deadline)await sleep(10);
    const pid=Number(await readFile(marker+'.pid','utf8'));assert.equal(alive(pid),true);
    await plugin.close();await checking;
    assert.equal(await readFile(marker,'utf8'),'graceful');
    assert.equal(alive(pid),false);
    const state=JSON.parse(await readFile(join(dataDir,'codex-autocontinue.json'),'utf8'));
    assert.equal(state.executor,null);
  }finally{await plugin.close().catch(()=>{});await checking.catch(()=>{});}
});
