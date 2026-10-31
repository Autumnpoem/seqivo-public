import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {accessSync,constants} from 'node:fs';
import {copyFile,mkdir,mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createCore} from '../server/core.mjs';
import {createTmuxAdapter} from '../server/terminal/tmux.mjs';

const tmux=process.env.TMUX_TEST_EXECUTABLE||resolve('.tools/terminal-build/install/bin/tmux');
async function until(fn,timeout=8000){
  const end=Date.now()+timeout;let last;
  while(Date.now()<end){try{const value=await fn();if(value)return value;}catch(error){last=error;}
    await new Promise(resolve=>setTimeout(resolve,30));}
  throw last||new Error('Condition did not become true');
}
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'seqivo-terminal-plugin-'));
  const workspace=join(root,'workspace'),pluginDir=join(root,'plugins');
  await mkdir(workspace);await mkdir(join(pluginDir,'local-terminal'),{recursive:true});
  await copyFile(resolve('plugins/local-terminal/plugin.json'),join(pluginDir,'local-terminal/plugin.json'));
  let core;
  t.after(async()=>{try{await core?.close();}finally{await rm(root,{recursive:true,force:true});}});
  core=await createCore({dataDir:join(root,'data'),pluginDir,files:false});
  return {root,workspace,core};
}
const pluginState=async core=>(await core.request('GET','/api/plugins')).find(item=>item.id==='local-terminal');
const operate=(core,action)=>core.request('POST',`/api/plugins/local-terminal/${action}`,{});
const nativeIdentity=pid=>execFileSync('/bin/ps',['-p',String(pid),'-o','pid=,lstart='],{encoding:'utf8'}).trim();

test('registered terminal plugin disables and re-enables real existing tmux without releasing human control or replacing panes',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process identity integration');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('tmux unavailable');return;}
  const x=await fixture(t),serverName=`seqivo-plugin-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']});
  // This is a unique disposable server created by this test, never the user's server.
  t.after(()=>{try{run('kill-server');}catch(error){if(!/no server running|error connecting|No such file/.test(String(error.stderr)))throw error;}});
  const project=x.core.store.project({name:'Disposable plugin acceptance',directory:x.workspace});
  const task=x.core.store.createTask({projectId:project.id,title:'Control remains with the human'});
  await x.core.request('POST','/api/terminal/profiles',{id:'plugin',label:'Plugin acceptance',projectId:project.id,
    enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  run('new-session','-d','-s','A','-c',x.workspace,'/bin/sh');
  run('new-session','-d','-s','B','-c',x.workspace,'/bin/sh');
  const adapter=createTmuxAdapter({executable:tmux,serverName});
  const originals=(await adapter.list()).sessions;
  const ref=originals.find(item=>item.name==='A').sessionRef;
  const identities=await Promise.all(originals.map(async item=>{
    const pane=(await adapter.sessionPanes(item.sessionRef))[0];
    return {ref:item.sessionRef,pid:pane.pid,identity:nativeIdentity(pane.pid)};
  }));
  const context={local:true,profileId:'plugin',connectionId:'plugin-before'},frames=[];
  const send=frame=>frames.push(frame);
  await x.core.terminal.frame(context,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},send);
  await x.core.terminal.frame(context,{v:1,type:'takeover-existing',sessionRefs:originals.map(item=>item.sessionRef)},send);
  assert.equal(frames.filter(frame=>frame.type==='control').at(-1)?.phase,'human');
  await x.core.terminal.frame(context,{v:1,type:'default',sessionRef:ref,expectedRevision:0},send);
  await x.core.terminal.frame(context,{v:1,type:'select',epoch:0,sessionRef:ref},send);
  const ready=frames.filter(frame=>frame.type==='ready').at(-1);assert.ok(ready);
  const marker=join(x.workspace,'plugin.txt');
  await x.core.terminal.frame(context,{v:1,type:'input',epoch:ready.epoch,seq:0,
    data:Buffer.from('printf BEFORE > plugin.txt\n').toString('base64')},send);
  await until(async()=>await readFile(marker,'utf8')==='BEFORE');
  assert.equal((await pluginState(x.core)).enabled,true);
  const defaultsBefore=x.core.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.manager.v1').value;
  await operate(x.core,'disable');
  assert.equal((await pluginState(x.core)).status,'disabled');
  assert.equal(x.core.terminal.hasConnections(),false);
  assert.equal(x.core.leases.available({taskId:task.id}),false,'disabling a plugin is not returning human control');
  await assert.rejects(x.core.terminal.frame(context,{v:1,type:'input',epoch:ready.epoch,seq:1,
    data:Buffer.from('printf BAD >> plugin.txt\n').toString('base64')},send));
  assert.equal(await readFile(marker,'utf8'),'BEFORE');
  await assert.rejects(x.core.request('POST','/api/terminal/tickets',{profileId:'plugin'}));
  assert.equal(x.core.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.manager.v1').value,
    defaultsBefore,'profiles, grants and default identities remain intact');
  for(const item of identities){
    assert.equal((await adapter.sessionPanes(item.ref))[0].pid,item.pid);
    assert.equal(nativeIdentity(item.pid),item.identity);
  }
  await operate(x.core,'enable');
  assert.equal((await pluginState(x.core)).status,'ready');
  assert.equal(x.core.leases.available({taskId:task.id}),false);
  const resumed={...context,connectionId:'plugin-after'},after=[];
  await x.core.terminal.frame(resumed,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},frame=>after.push(frame));
  const resumedReady=after.filter(frame=>frame.type==='ready').at(-1);
  assert.ok(resumedReady,'a new connection attaches the preserved default');
  assert.deepEqual(resumedReady.sessionRef,ref);
  await x.core.terminal.frame(resumed,{v:1,type:'input',epoch:resumedReady.epoch,seq:0,
    data:Buffer.from('printf AFTER >> plugin.txt\n').toString('base64')},frame=>after.push(frame));
  await until(async()=>await readFile(marker,'utf8')==='BEFOREAFTER');
  await x.core.close();
  for(const item of identities){
    assert.equal((await adapter.sessionPanes(item.ref))[0].pid,item.pid);
    assert.equal(nativeIdentity(item.pid),item.identity);
  }
});

test('disabling the registered plugin refuses to terminate an active ordinary Shell',async t=>{
  if(process.platform==='win32'){t.skip('POSIX Shell integration');return;}
  const x=await fixture(t);
  // An unbound disposable directory exercises ordinary Shell independently of managed tmux.
  await x.core.request('POST','/api/terminal/profiles',{id:'shell',label:'Ordinary Shell',cwd:x.workspace,enabled:true,shell:'/bin/sh'});
  const context={local:true,profileId:'shell',connectionId:'ordinary'},frames=[];
  await x.core.terminal.frame(context,{v:1,type:'open',mode:'shell',readOnly:false,cols:80,rows:24},frame=>frames.push(frame));
  const ready=frames.find(frame=>frame.type==='ready');assert.ok(ready);
  await assert.rejects(operate(x.core,'disable'));
  assert.equal((await pluginState(x.core)).enabled,true);
  assert.equal(x.core.terminal.hasConnections(),true);
  await x.core.terminal.frame(context,{v:1,type:'input',epoch:ready.epoch,seq:0,
    data:Buffer.from('printf STILL_RUNNING > shell.txt\n').toString('base64')},frame=>frames.push(frame));
  await until(async()=>await readFile(join(x.workspace,'shell.txt'),'utf8')==='STILL_RUNNING');
  await x.core.terminal.frame(context,{v:1,type:'input',epoch:ready.epoch,seq:1,
    data:Buffer.from('exit\n').toString('base64')},frame=>frames.push(frame));
  await until(()=>frames.some(frame=>frame.type==='exit'));
  await x.core.terminal.closeConnection(context.connectionId);
  await operate(x.core,'disable');
  assert.equal((await pluginState(x.core)).status,'disabled');
});

test('a clean disabled plugin stays disabled across a real Core restart without losing profiles',async t=>{
  const x=await fixture(t);
  await x.core.request('POST','/api/terminal/profiles',{id:'remembered',label:'Preserved profile',cwd:x.workspace,
    enabled:true,shell:'/bin/sh'});
  const original=x.core.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.manager.v1').value;
  await operate(x.core,'disable');
  await x.core.close();
  const restarted=await createCore({dataDir:join(x.root,'data'),pluginDir:join(x.root,'plugins'),files:false});
  try{
    assert.equal((await pluginState(restarted)).status,'disabled');
    assert.equal(restarted.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.manager.v1').value,original);
    assert.equal((await restarted.request('GET','/api/terminal/status')).plugin.enabled,false);
    await assert.rejects(restarted.request('POST','/api/terminal/tickets',{profileId:'remembered'}));
    await operate(restarted,'enable');
    assert.equal((await pluginState(restarted)).status,'ready');
    assert.equal((await restarted.request('GET','/api/terminal/status')).profiles[0].id,'remembered');
  }finally{await restarted.close();}
});
