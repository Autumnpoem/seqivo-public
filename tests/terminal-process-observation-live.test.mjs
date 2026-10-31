import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import {access,mkdir,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {createCore} from '../server/core.mjs';
import {createTmuxAdapter} from '../server/terminal/tmux.mjs';
import {connectManagedPane} from '../server/terminal/managed-pane.mjs';

const execAsync=promisify(execFile);
const nodePath=process.execPath;
const pythonPath=process.env.TASKBOARD_TEST_PYTHON||'/usr/bin/python3';
const tmuxPath=resolve(process.env.TMUX_TEST_EXECUTABLE||'.tools/terminal-build/install/bin/tmux');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check,timeout=12000){
  const end=Date.now()+timeout;
  while(Date.now()<end){try{if(await check())return;}catch{}await sleep(50);}
  throw Error('Isolated process observation timed out');
}

test('real managed terminal input ignores one unrelated same-UID process lifetime',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS managed process observation required');return;}
  try{await access(pythonPath,constants.X_OK);await access(tmuxPath,constants.X_OK);}
  catch{t.skip('isolated Python/tmux executables unavailable');return;}
  const root=await mkdtemp(join(tmpdir(),'seqivo-observation-live-'));
  const dataDir=join(root,'data'),workspace=join(root,'workspace');
  await mkdir(dataDir);await mkdir(workspace);
  const serverName=`seqivo_observe_${randomBytes(6).toString('hex')}`;
  const run=(...args)=>execAsync(tmuxPath,['-L',serverName,...args],{timeout:5000});
  let core,unrelated;
  t.after(async()=>{
    if(unrelated?.exitCode===null){unrelated.kill('SIGTERM');await new Promise(resolve=>unrelated.once('exit',resolve));}
    let cleanupFailure=null;
    try{await core?.close();}catch(error){cleanupFailure=error;t.diagnostic(`Isolated Core cleanup failed: ${error.code||'ERROR'}`);}
    const recordsRoot=join(dataDir,'terminal-managed-records');
    let uncertain=false;
    for(const directory of await readdir(recordsRoot).catch(()=>[])){
      let pane;
      try{
        const record=JSON.parse(await readFile(join(recordsRoot,directory,'record.json'),'utf8'));
        pane=await connectManagedPane({socketPath:record.pane.socketPath,capability:record.pane.capability});
        const status=await pane.status();
        if(status.state!=='exited'){
          if(status.state==='stopped'||status.inputFrozen)await pane.resume();
          await run('send-keys','-t',record.tmux.relayPaneId,'exit','Enter');
          await until(async()=>(await pane.status()).state==='exited',3000);
        }
        await pane.shutdown();
        await rm(record.pane.directory,{recursive:true,force:true});
      }catch(error){uncertain=true;t.diagnostic(`Isolated managed process cleanup unconfirmed: ${error.code||'ERROR'}`);}
      finally{pane?.close();}
    }
    if(uncertain||cleanupFailure)throw Error('Isolated process cleanup was not confirmed');
    try{await run('kill-server');}catch{}
    await rm(root,{recursive:true,force:true});
  });
  core=await createCore({dataDir,pluginDir:join(root,'plugins'),files:false,managedPythonPath:pythonPath});
  const project=core.store.project({name:'Process observation only',directory:workspace});
  await core.request('POST','/api/terminal/profiles',{id:'managed',label:'Isolated',projectId:project.id,
    enabled:true,shell:'/bin/sh',serverName,allowSharedServer:true,tmuxExecutable:tmuxPath});
  const ctx={local:true,profileId:'managed',connectionId:'observation-owner'};
  const frames=[],send=frame=>frames.push(frame);
  await core.terminal.frame(ctx,{v:1,type:'open',mode:'tmux',cols:80,rows:24},send);
  await core.terminal.frame(ctx,{v:1,type:'takeover'},send);
  await core.terminal.frame(ctx,{v:1,type:'create',epoch:0,name:'original'},send);
  const ready=frames.filter(frame=>frame.type==='ready').at(-1);
  assert.ok(ready?.sessionRef,'managed shell must be attached');
  const adapter=createTmuxAdapter({executable:tmuxPath,serverName});
  const relayPid=(await adapter.sessionPanes(ready.sessionRef))[0].pid;
  const index=JSON.parse(core.store.db.prepare('SELECT value FROM metadata WHERE key=?')
    .get('terminal.managed-panes.v1').value);
  assert.equal(index.entries.length,1);
  const record=JSON.parse(await readFile(join(dataDir,'terminal-managed-records',index.entries[0].directory,
    'record.json'),'utf8'));
  const shellPid=record.identities.shell.pid;
  assert.ok(Number.isSafeInteger(shellPid)&&shellPid>0);
  const marker=join(workspace,'written.txt');
  const command=`printf '%s\\n' PROC230 > '${marker.replaceAll("'","'\\''")}'\n`;
  let inputSettled=false;
  const input=core.terminal.frame(ctx,{v:1,type:'input',epoch:ready.epoch,seq:1,
    data:Buffer.from(command).toString('base64')},send).finally(()=>{inputSettled=true;});
  // This child is deliberately outside the project and any recorded supervisor
  // ancestry. It is a bounded lifecycle overlap, not machine-wide stress.
  unrelated=spawn('/bin/sh',['-c','sleep 0.08'],{cwd:root,stdio:'ignore'});
  const unrelatedPid=unrelated.pid;
  assert.ok(Number.isSafeInteger(unrelatedPid)&&unrelatedPid>0);
  await new Promise((resolve,reject)=>{unrelated.once('exit',resolve);unrelated.once('error',reject);});
  const exitedWhileInputPending=!inputSettled;
  await input;
  await until(async()=>(await readFile(marker,'utf8').catch(()=>null))==='PROC230\n');
  assert.equal(frames.find(frame=>frame.type==='inputAck'&&frame.seq===1)?.status,'written');
  assert.equal((await adapter.sessionPanes(ready.sessionRef))[0].pid,relayPid);
  assert.equal(JSON.parse(await readFile(join(dataDir,'terminal-managed-records',index.entries[0].directory,
    'record.json'),'utf8')).identities.shell.pid,shellPid);
  assert.equal((await adapter.list()).sessions.length,1);
  assert.equal(exitedWhileInputPending,true,
    'the unrelated same-UID child must exit while the real input proof is pending');
  t.diagnostic(`Observed isolated managed input with unrelated child ${unrelatedPid} retired during the awaited call (Node ${nodePath}).`);
});
