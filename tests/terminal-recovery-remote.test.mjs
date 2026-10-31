import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {accessSync,constants} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../server/store.mjs';
import {createTerminalManager} from '../server/terminal/manager.mjs';
import {createTerminalControl} from '../server/terminal/control.mjs';
import {createTmuxAdapter} from '../server/terminal/tmux.mjs';

const tmux=process.env.TMUX_TEST_EXECUTABLE||resolve('.tools/terminal-build/install/bin/tmux');

test('same remote actor formally recovers unknown control, while other actors and changed grants stay fenced',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process identity proof is required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('isolated tmux executable unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-remote-recovery-'));
  const serverName=`remote-recovery-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite'));
  const project=store.project({name:'Isolated recovery',directory:dir});
  let manager,snapshots=0;
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-executor'});
  const control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:async()=>clear(),
    inspectExisting:input=>manager.inspectExisting(input),sealHuman:input=>manager.sealProject(input.projectId),
    snapshot:async()=>{if(++snapshots===2)throw Error('fixture process snapshot incomplete');
      return {directory:dir,files:{},count:0,bytes:0,snapshotScope:'directory-tree-excluding-git-metadata'};}});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'managed',label:'Managed',projectId:project.id,
    enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  manager.setLink({state:()=>({nodeId:'node',ownerUserId:'owner',status:'connected'}),
    pending:async()=>({devices:[{deviceId:'phone',userId:'user'},{deviceId:'tablet',userId:'user'},
      {deviceId:'input-only',userId:'user'},{deviceId:'takeover-only',userId:'user'},
      {deviceId:'viewer',userId:'user'}]}),grant:async()=>({revision:1}),refresh:()=>{},close:async()=>{}});
  for(const [deviceId,scopes] of [
    ['phone',['view','input','create','default','takeover']],
    ['tablet',['view','input','takeover']],
    ['input-only',['view','input']],
    ['takeover-only',['view','takeover']],
    ['viewer',['view']],
  ])await manager.request('POST','/api/terminal/grants',{deviceId,profileId:'managed',scopes});
  const context=(deviceId,connectionId)=>({nodeId:'node',deviceId,userId:'user',grantRevision:1,
    profileId:'managed',connectionId,isCurrent:()=>true});
  const phone=context('phone','phone-original'),initial=[],deliver=frame=>initial.push(frame);
  await manager.frame(phone,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  await manager.frame(phone,{v:1,type:'takeover'},deliver);
  assert.equal(initial.filter(frame=>frame.type==='control').at(-1).phase,'human');
  await manager.frame(phone,{v:1,type:'create',epoch:0,name:'A'},deliver);
  const original=initial.filter(frame=>frame.type==='ready').at(-1),ref=original.sessionRef;
  const adapter=createTmuxAdapter({executable:tmux,serverName});
  const originalPid=(await adapter.sessionPanes(ref))[0].pid;
  await manager.frame(phone,{v:1,type:'default',sessionRef:ref,expectedRevision:0},deliver);
  const stored=JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.control.v1').value);
  const originalControl=stored.entries[project.id];
  control.markManagedUnknown({projectId:project.id,token:originalControl.token,generation:originalControl.generation});

  // A first formal check reproduces the observed stopping -> unknown generation
  // advance. The fixture fails only the bounded snapshot, never grants input.
  const same=context('phone','phone-recovery'),frames=[],send=frame=>frames.push(frame);
  await manager.frame(same,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},send);
  assert.equal(frames.find(frame=>frame.type==='control')?.canReconcileAcquire,true);
  assert.equal(frames.find(frame=>frame.type==='error')?.code,'CONTROL_REQUIRED');
  assert.equal(frames.some(frame=>frame.type==='ready'),false);
  await assert.rejects(manager.frame(same,{v:1,type:'input',epoch:0,seq:0,
    data:Buffer.from('premature').toString('base64')},send),{code:'CONTROL_REQUIRED'},
    'unknown control cannot write before formal recovery');
  await assert.rejects(manager.frame(same,{v:1,type:'create',epoch:0,name:'Never-created'},send),
    {code:'CONTROL_REQUIRED'},'unknown control cannot create a replacement session');
  await manager.frame(same,{v:1,type:'reconcile-control',action:'acquire',requestId:'first-check'},send);
  const stillUnknown=frames.filter(frame=>frame.type==='control').at(-1);
  assert.equal(stillUnknown.requestId,'first-check');
  assert.equal(stillUnknown.phase,'unknown');
  assert.equal(stillUnknown.owned,false);
  assert.ok(stillUnknown.generation>originalControl.generation);
  assert.equal(frames.some(frame=>frame.type==='ready'),false);
  assert.equal((await adapter.list()).sessions.length,1,'uncertain recovery creates no new session');

  const tablet=context('tablet','tablet'),other=[];
  await manager.frame(tablet,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},frame=>other.push(frame));
  assert.equal(other.find(frame=>frame.type==='control')?.canReconcileAcquire,false);
  await manager.frame(tablet,{v:1,type:'reconcile-control',action:'acquire',requestId:'wrong-actor'},frame=>other.push(frame));
  assert.equal(other.find(frame=>frame.requestId==='wrong-actor')?.code,'CONTROL_STALE');
  assert.equal(control.state()[0].phase,'unknown');
  for(const [deviceId,readOnly] of [['input-only',false],['takeover-only',true],['viewer',true]]){
    const peer=context(deviceId,`${deviceId}-check`),seen=[];
    await manager.frame(peer,{v:1,type:'open',mode:'tmux',readOnly,cols:80,rows:24},frame=>seen.push(frame));
    assert.equal(seen.find(frame=>frame.type==='control')?.canReconcileAcquire,false,deviceId);
    await manager.frame(peer,{v:1,type:'reconcile-control',action:'acquire',requestId:`${deviceId}-reconcile`},frame=>seen.push(frame));
    assert.equal(seen.find(frame=>frame.requestId===`${deviceId}-reconcile`)?.code,
      readOnly?'READ_ONLY':'GRANT_REQUIRED',deviceId);
  }
  await manager.frame(same,{v:1,type:'reconcile-control',action:'acquire',requestId:'wrong-ref',
    sessionRef:ref},send);
  assert.equal(frames.find(frame=>frame.requestId==='wrong-ref')?.code,'SESSION_NOT_AUTHORIZED',
    'remote selection is never accepted as an unverified reconcile target');

  await manager.frame(same,{v:1,type:'reconcile-control',action:'acquire',requestId:'second-check'},send);
  const recovered=frames.filter(frame=>frame.type==='control').at(-1);
  assert.equal(recovered.requestId,'second-check');
  assert.equal(recovered.phase,'human');
  assert.equal(recovered.owned,true);
  assert.deepEqual(recovered.authorizedSessionRefs,[ref]);
  assert.equal(frames.some(frame=>frame.type==='ready'),false,'control recovery itself never attaches the default');
  assert.equal((await adapter.list()).sessions.length,1);
  await assert.rejects(manager.frame(phone,{v:1,type:'input',epoch:original.epoch,seq:0,
    data:Buffer.from('old').toString('base64')},deliver),{code:'CONTROL_REQUIRED'},
    'old generation cannot write after same-device recovery');
  await manager.frame(same,{v:1,type:'select',epoch:0,sessionRef:ref,requestId:'select-original'},send);
  assert.deepEqual(frames.filter(frame=>frame.type==='ready').at(-1).sessionRef,ref);
  assert.equal((await adapter.sessionPanes(ref))[0].pid,originalPid);
  assert.deepEqual(frames.filter(frame=>frame.type==='sessions').at(-1).defaultRef,ref,
    'explicit recovery selection never changes the saved default');
  await manager.request('DELETE','/api/terminal/grants/phone/managed');
  await assert.rejects(manager.frame(same,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},send),
    {code:'GRANT_REQUIRED'},'revoked grant cannot obtain a new recovery snapshot');
  await assert.rejects(manager.frame(same,{v:1,type:'input',epoch:frames.filter(frame=>frame.type==='ready').at(-1).epoch,
    seq:0,data:Buffer.from('revoked').toString('base64')},send),{code:'GRANT_REQUIRED'});
});
