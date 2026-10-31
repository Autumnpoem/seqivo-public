import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {accessSync,constants,realpathSync} from 'node:fs';
import {homedir,tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {Store} from '../server/store.mjs';
import {createTerminalManager} from '../server/terminal/manager.mjs';
import {inspectWorkspaceWriters} from '../server/terminal/process-inspection.mjs';
import {createTerminalControl} from '../server/terminal/control.mjs';
import {createTmuxAdapter} from '../server/terminal/tmux.mjs';

const tmux=process.env.TMUX_TEST_EXECUTABLE||resolve('.tools/terminal-build/install/bin/tmux');
test('owner can formally reconcile an unknown managed project before any session was established',async t=>{
  try{accessSync(tmux,constants.X_OK);}catch{t.skip(`tmux test executable is unavailable: ${tmux}`);return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-empty-recovery-'));
  const store=new Store(join(dir,'board.sqlite'));
  const project=store.project({name:'Empty managed project',directory:dir});
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  let snapshotCalls=0,manager;
  const control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:async()=>clear(),
    snapshot:async()=>{if(++snapshotCalls===1)throw new Error('initial snapshot failed');return {directory:dir,files:{},count:0,bytes:0,snapshotScope:'directory-tree-excluding-git-metadata'};},
    sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'empty',label:'Empty',projectId:project.id,enabled:true,tmuxExecutable:tmux});
  const ctx={local:true,profileId:'empty',connectionId:'empty-owner'},frames=[],send=frame=>frames.push(frame);
  await manager.frame(ctx,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},send);
  assert.equal(frames.find(frame=>frame.type==='control').requiresSessionSelection,true,'no control record is not proof of absent historical sessions');
  await manager.frame(ctx,{v:1,type:'takeover'},send);
  const unknown=frames.filter(frame=>frame.type==='control').at(-1);
  assert.equal(unknown.phase,'unknown');
  assert.equal(unknown.mode,'managed');
  assert.equal(unknown.requiresSessionSelection,false,'only internal absence of managed-session identity waives selection');
  assert.equal(control.hasManagedSessionRefs(project.id),false);
  const readyBefore=frames.filter(frame=>frame.type==='ready').length;
  await manager.frame(ctx,{v:1,type:'reconcile-control',action:'acquire',requestId:'empty-recovery'},send);
  const recovered=frames.filter(frame=>frame.type==='control').at(-1);
  assert.equal(recovered.requestId,'empty-recovery');
  assert.equal(recovered.phase,'human',recovered.reason);
  assert.equal(recovered.owned,true);
  assert.equal(recovered.requiresSessionSelection,false);
  assert.equal(frames.filter(frame=>frame.type==='ready').length,readyBefore,'reconciliation alone does not create or attach a terminal');
  assert.equal(control.hasManagedSessionRefs(project.id),false);
});
for(const interruption of ['disconnect','closeConnection'])test(`return confirmation cannot commit after ${interruption} interrupts its connection`,async t=>{
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('tmux test executable is unavailable');return;}
  const workspace=await mkdtemp(join(tmpdir(),'terminal-return-race-workspace-'));
  const dbRoot=await mkdtemp(join(tmpdir(),'terminal-return-race-db-'));
  const store=new Store(join(dbRoot,'board.sqlite'));
  const project=store.project({name:'Return race',directory:workspace});
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-complete-writer-observation'});
  let snapshotCalls=0,manager,enterSnapshot,leaveSnapshot;
  const entered=new Promise(resolve=>{enterSnapshot=resolve;});
  const gate=new Promise(resolve=>{leaveSnapshot=resolve;});
  const control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:async()=>clear(),
    inspectDirectories:async()=>({verified:true,directories:[]}),
    snapshot:async()=>{if(++snapshotCalls===3){enterSnapshot();await gate;}
      return {directory:workspace,files:{},count:0,bytes:0,snapshotScope:'directory-tree-excluding-git-metadata'};},
    sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{leaveSnapshot();await manager.close();store.close();await rm(workspace,{recursive:true,force:true});
    await rm(dbRoot,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'return-race',label:'Return race',projectId:project.id,
    enabled:true,tmuxExecutable:tmux});
  const ctx={local:true,profileId:'return-race',connectionId:`return-race-${interruption}`};
  const frames=[],send=frame=>frames.push(frame);
  await manager.frame(ctx,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},send);
  await manager.frame(ctx,{v:1,type:'takeover'},send);
  assert.equal(frames.filter(frame=>frame.type==='control').at(-1).phase,'human');
  await manager.frame(ctx,{v:1,type:'return-prepare',notes:'Ready for review'},send);
  const review=frames.filter(frame=>frame.type==='control').at(-1);
  assert.equal(review.phase,'return_review');
  const confirming=manager.frame(ctx,{v:1,type:'return-confirm',reviewId:review.returnReview.reviewId,
    expectedGeneration:review.generation},send);
  await entered;
  const closing=interruption==='disconnect'?(manager.disconnect(ctx.connectionId),null):manager.closeConnection(ctx.connectionId);
  leaveSnapshot();
  await confirming;
  if(closing)await closing;
  assert.equal(control.state().find(entry=>entry.projectId===project.id).phase,'unknown',
    'the interrupted confirmation must not publish ai_ready');
  assert.throws(()=>control.assertMayStart(project.id),{code:'CONTROL_BUSY'});
});
test('read-only tmux is immutable and default revisions reject a stale writer',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS lsof process proof is required for this integration test');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip(`tmux test executable is unavailable: ${tmux}`);return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-manager-'));
  const serverName=`seqivo-manager-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000});
  const store=new Store(join(dir,'board.sqlite'));
  const project=store.project({name:'受管项目',directory:dir});
  const manager=createTerminalManager({store});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{/* Already stopped. */}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'default',label:'隔离测试',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  await assert.rejects(manager.request('POST','/api/terminal/profiles',{id:'overlap',label:'不应绕过',cwd:dir,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux}),{code:'CONTROL_BINDING_REQUIRED'});
  const lateWorkspace=await mkdtemp(join(tmpdir(),'terminal-manager-late-'));
  t.after(()=>rm(lateWorkspace,{recursive:true,force:true}));
  await manager.request('POST','/api/terminal/profiles',{id:'late',label:'稍后关联',cwd:lateWorkspace,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  store.project({name:'稍后加入受管项目',directory:lateWorkspace});
  await assert.rejects(manager.frame({local:true,profileId:'late',connectionId:'late-check'},{v:1,type:'open',mode:'shell',readOnly:false,cols:80,rows:24},()=>{}),{code:'CONTROL_BINDING_REQUIRED'},'late project binding also fences the existing unbound profile');
  run('new-session','-d','-s','A','-c',homedir());run('new-session','-d','-s','B','-c',homedir());
  const first=[],second=[];
  const a={local:true,profileId:'default',connectionId:'readonly-a'};
  const b={local:true,profileId:'default',connectionId:'readonly-b'};
  await manager.frame(a,{v:1,type:'open',mode:'tmux',readOnly:true,cols:80,rows:24},frame=>first.push(frame));
  const sessions=first.find(frame=>frame.type==='sessions');
  assert.equal(sessions.defaultRevision,0,'legacy or new defaults start at revision zero');
  const refA=sessions.items.find(item=>item.name==='A').sessionRef;
  const refB=sessions.items.find(item=>item.name==='B').sessionRef;
  await manager.frame(a,{v:1,type:'select',epoch:0,sessionRef:refA},frame=>first.push(frame));
  assert.equal(first.find(frame=>frame.type==='ready')?.readOnly,true);
  assert.equal(manager.blocksProject(project.id),false,'read-only attachment cannot fence AI execution');
  const inspection=await inspectWorkspaceWriters({workspace:dir});
  assert.equal(inspection.verified&&inspection.quiescent,true,'read-only tmux client cwd stays outside managed workspace');
  await manager.sealProject(project.id);
  assert.equal((await manager.request('GET','/api/terminal/status')).connections.find(item=>item.id===a.connectionId)?.ready,true,'sealing human writers preserves read-only viewers');
  await assert.rejects(manager.frame(a,{v:1,type:'input',epoch:1,seq:0,data:Buffer.from('x').toString('base64')},frame=>first.push(frame)),{code:'READ_ONLY'});
  await assert.rejects(manager.frame(a,{v:1,type:'create',epoch:1,name:'C'},frame=>first.push(frame)),{code:'READ_ONLY'});
  await assert.rejects(manager.frame(a,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},frame=>first.push(frame)),{code:'READ_ONLY'});
  await assert.rejects(manager.frame(a,{v:1,type:'takeover'},frame=>first.push(frame)),{code:'READ_ONLY'});
  await manager.frame(a,{v:1,type:'default',sessionRef:refA,expectedRevision:0},frame=>first.push(frame));
  assert.equal(first.filter(frame=>frame.type==='sessions').at(-1).defaultRevision,1);
  await manager.frame(b,{v:1,type:'open',mode:'tmux',readOnly:true,cols:80,rows:24},frame=>second.push(frame));
  await manager.frame(b,{v:1,type:'default',sessionRef:refB,expectedRevision:1},frame=>second.push(frame));
  assert.equal(second.filter(frame=>frame.type==='sessions').at(-1).defaultRevision,2);
  await assert.rejects(manager.frame(a,{v:1,type:'default',sessionRef:refA,expectedRevision:1},frame=>first.push(frame)),{code:'DEFAULT_CONFLICT'});
  await manager.frame(a,{v:1,type:'list'},frame=>first.push(frame));
  const refreshed=first.filter(frame=>frame.type==='sessions').at(-1);
  assert.equal(refreshed.defaultRevision,2);
  assert.deepEqual(refreshed.defaultRef,refB,'stale default request does not overwrite the newer choice');
  await manager.bindOwner({nodeId:'bound-node',userId:'bound-user'});
  manager.setLink({state:()=>({nodeId:'bound-node',ownerUserId:'bound-user',status:'connected'}),close:async()=>{}});
  await manager.frame(a,{v:1,type:'list'},frame=>first.push(frame));
  const migrated=first.filter(frame=>frame.type==='sessions').at(-1);
  assert.equal(migrated.defaultRevision,2,'binding owner migrates the default revision');
  assert.deepEqual(migrated.defaultRef,refB,'binding owner preserves the selected default');
});

test('explicit A/B existing-session takeover preserves original panes and fences AI until all writers leave',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-existing-'));
  const dbRoot=await mkdtemp(join(tmpdir(),'terminal-existing-db-'));
  const serverName=`seqivo-existing-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000});
  const store=new Store(join(dbRoot,'board.sqlite'));
  const project=store.project({name:'Original CLI',directory:dir});
  let manager;
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  const control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:inspectWorkspaceWriters,
    inspectExisting:input=>manager.inspectExisting(input),inspectDirectories:input=>manager.inspectReturnDirectories(input),
    sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});await rm(dbRoot,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'existing',label:'Original CLI',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  run('new-session','-d','-s','A','-c',dir);run('new-session','-d','-s','B','-c',dir);
  const adapter=createTmuxAdapter({executable:tmux,serverName});
  const original=(await adapter.list()).sessions;
  const a=original.find(item=>item.name==='A').sessionRef,b=original.find(item=>item.name==='B').sessionRef;
  const pidA=(await adapter.sessionPanes(a))[0].pid,pidB=(await adapter.sessionPanes(b))[0].pid;
  const ctx={local:true,profileId:'existing',connectionId:'existing-controller'};
  const frames=[],deliver=frame=>frames.push(frame);
  await manager.frame(ctx,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  await manager.frame(ctx,{v:1,type:'takeover-existing',sessionRefs:[a,b]},deliver);
  const granted=frames.filter(f=>f.type==='control').at(-1);
  assert.equal(granted.phase,'human',granted.reason);
  assert.equal(granted.mode,'existing');assert.equal(granted.owned,true);
  assert.equal(granted.authorizedSessionRefs.length,2);
  assert.throws(()=>control.assertMayStart(project.id),{code:'CONTROL_BUSY'});
  await assert.rejects(manager.frame(ctx,{v:1,type:'open',mode:'shell',readOnly:false,cols:80,rows:24},deliver),{code:'SESSION_NOT_AUTHORIZED'});
  await manager.frame(ctx,{v:1,type:'select',epoch:0,sessionRef:a},deliver);
  let ready=frames.filter(f=>f.type==='ready').at(-1);
  await manager.frame(ctx,{v:1,type:'input',epoch:ready.epoch,seq:0,data:Buffer.from("printf A > a.txt\n").toString('base64')},deliver);
  for(let i=0;i<50;i++){try{if(await readFile(join(dir,'a.txt'),'utf8')==='A')break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(await readFile(join(dir,'a.txt'),'utf8'),'A');
  await manager.frame(ctx,{v:1,type:'select',epoch:ready.epoch,sessionRef:b},deliver);
  ready=frames.filter(f=>f.type==='ready').at(-1);
  await manager.frame(ctx,{v:1,type:'input',epoch:ready.epoch,seq:0,data:Buffer.from("printf B > b.txt\n").toString('base64')},deliver);
  for(let i=0;i<50;i++){try{if(await readFile(join(dir,'b.txt'),'utf8')==='B')break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(await readFile(join(dir,'b.txt'),'utf8'),'B');
  assert.equal((await adapter.sessionPanes(a))[0].pid,pidA);
  assert.equal((await adapter.sessionPanes(b))[0].pid,pidB);
  await manager.frame(ctx,{v:1,type:'detach'},deliver);
  const reconnected={...ctx,connectionId:'local-reconnected'};
  await manager.frame(reconnected,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  assert.equal(frames.filter(f=>f.type==='control').at(-1).owned,true,'local owner reclaims only after old client was destroyed');
  await manager.frame(reconnected,{v:1,type:'select',epoch:0,sessionRef:a},deliver);
  await manager.frame(reconnected,{v:1,type:'return',notes:'Both original CLIs remain'},deliver);
  assert.equal(frames.filter(f=>f.type==='control').at(-1).phase,'unknown');
  assert.throws(()=>control.assertMayStart(project.id),{code:'CONTROL_BUSY'});
  run('send-keys','-t',a.sessionId,'exit','Enter');run('send-keys','-t',b.sessionId,'exit','Enter');
  for(let i=0;i<50;i++){if(!(await adapter.list()).sessions.length)break;await new Promise(resolve=>setTimeout(resolve,50));}
  await manager.frame(reconnected,{v:1,type:'reconcile-control',action:'release'},deliver);
  const review=frames.filter(f=>f.type==='control').at(-1);
  assert.equal(review.phase,'return_review',review.reason);
  assert.deepEqual(review.returnReview.workspaceRelativeDirectories,[],'original sessions are proved retired');
  await manager.frame(reconnected,{v:1,type:'return-confirm',reviewId:review.returnReview.reviewId,
    expectedGeneration:review.generation},deliver);
  const completed=frames.filter(f=>f.type==='control').at(-1);
  assert.equal(completed.phase,'ai_ready',completed.reason);
});

test('unknown workspace writer blocks adoption, and a new B requires explicit extension',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-existing-expand-'));
  const serverName=`seqivo-expand-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite')),project=store.project({name:'Work',directory:dir});
  let manager;
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  const control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:inspectWorkspaceWriters,
    inspectExisting:input=>manager.inspectExisting(input),sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'existing',label:'Existing',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  run('new-session','-d','-s','A','-c',dir);
  const adapter=createTmuxAdapter({executable:tmux,serverName});
  const a=(await adapter.list()).sessions[0].sessionRef;
  const outsider=spawn('/bin/sleep',['30'],{cwd:dir,stdio:'ignore'});
  await new Promise((resolve,reject)=>{outsider.once('spawn',resolve);outsider.once('error',reject);});
  t.after(async()=>{if(outsider.exitCode===null&&outsider.signalCode===null){outsider.kill();await new Promise(resolve=>outsider.once('exit',resolve));}});
  const ctx={local:true,profileId:'existing',connectionId:'controller'},frames=[],deliver=f=>frames.push(f);
  await manager.frame(ctx,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  await manager.frame(ctx,{v:1,type:'takeover-existing',sessionRefs:[a]},deliver);
  assert.equal(frames.filter(f=>f.type==='control').at(-1).phase,'unknown');
  assert.match(frames.filter(f=>f.type==='control').at(-1).reason,/归属|写入|核实/);
  outsider.kill();await new Promise(resolve=>outsider.once('exit',resolve));
  await manager.frame(ctx,{v:1,type:'reconcile-control',action:'acquire'},deliver);
  assert.equal(frames.filter(f=>f.type==='control').at(-1).phase,'human');
  await manager.frame(ctx,{v:1,type:'select',epoch:0,sessionRef:a},deliver);
  const ready=frames.filter(f=>f.type==='ready').at(-1);
  run('new-session','-d','-s','B','-c',dir);
  const b=(await adapter.list()).sessions.find(item=>item.name==='B').sessionRef;
  await manager.frame(ctx,{v:1,type:'select',epoch:ready.epoch,sessionRef:b,requestId:'select-b'},deliver);
  assert.equal(frames.at(-1).code,'SESSION_NOT_AUTHORIZED');
  assert.equal(frames.at(-1).requestId,'select-b');
  assert.deepEqual(frames.at(-1).sessionRef,b);
  await manager.frame(ctx,{v:1,type:'extend-existing',sessionRefs:[b]},deliver);
  const extended=frames.filter(f=>f.type==='control').at(-1);
  assert.equal(extended.phase,'human',extended.reason);
  assert.equal(extended.authorizedSessionRefs.length,2);
  await manager.frame(ctx,{v:1,type:'select',epoch:ready.epoch,sessionRef:b},deliver);
  const bReady=frames.filter(f=>f.type==='ready').at(-1);
  assert.deepEqual(bReady.sessionRef,b);
  run('kill-session','-t',b.sessionId);run('new-session','-d','-s','B','-c',dir);
  const recreated=(await adapter.list()).sessions.find(item=>item.name==='B').sessionRef;
  assert.notDeepEqual(recreated,b);
  await assert.rejects(manager.frame(ctx,{v:1,type:'input',epoch:bReady.epoch,seq:0,data:Buffer.from('wrong-target\n').toString('base64')},deliver));
  await manager.frame(ctx,{v:1,type:'select',epoch:bReady.epoch,sessionRef:recreated,requestId:'new-b'},deliver);
  assert.equal(frames.at(-1).code,'SESSION_NOT_AUTHORIZED');
});

test('existing session adoption and input reject a pane in another managed project',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-cross-project-'));
  const aDir=join(dir,'A'),aChild=join(aDir,'child'),bDir=join(dir,'B');
  await mkdir(aChild,{recursive:true});await mkdir(bDir);
  const serverName=`seqivo-cross-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite'));
  const projectA=store.project({name:'Project A',directory:aDir});
  store.project({name:'Project B',directory:bDir});
  let manager;
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  const control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:inspectWorkspaceWriters,
    inspectExisting:input=>manager.inspectExisting(input),sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'A',label:'A',projectId:projectA.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  run('new-session','-d','-s','wrong','-c',bDir);
  run('new-session','-d','-s','right','-c',aChild);
  const adapter=createTmuxAdapter({executable:tmux,serverName});
  const rows=(await adapter.list()).sessions;
  const wrong=rows.find(row=>row.name==='wrong').sessionRef,right=rows.find(row=>row.name==='right').sessionRef;
  const ctx={local:true,profileId:'A',connectionId:'cross-project'},frames=[],deliver=frame=>frames.push(frame);
  await manager.frame(ctx,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  await manager.frame(ctx,{v:1,type:'takeover-existing',sessionRefs:[wrong]},deliver);
  assert.equal(frames.filter(frame=>frame.type==='control').at(-1).phase,'unknown');
  assert.match(frames.filter(frame=>frame.type==='control').at(-1).reason,/其他受管项目/);
  await manager.frame(ctx,{v:1,type:'takeover-existing',sessionRefs:[right]},deliver);
  assert.equal(frames.filter(frame=>frame.type==='control').at(-1).phase,'human','a pane in a project subdirectory is permitted');
  await manager.frame(ctx,{v:1,type:'select',epoch:0,sessionRef:right},deliver);
  const ready=frames.filter(frame=>frame.type==='ready').at(-1);
  run('send-keys','-t',right.sessionId,`cd ${bDir}`,'Enter');
  // Observe the pane's actual process cwd, rather than assuming tmux has
  // processed send-keys within a fixed number of scheduler ticks.
  const cwdDeadline=Date.now()+5000;
  let observedCwd;
  do{
    observedCwd=realpathSync((await adapter.sessionPanes(right))[0].cwd);
    if(observedCwd===realpathSync(bDir))break;
    await new Promise(resolve=>setTimeout(resolve,25));
  }while(Date.now()<cwdDeadline);
  assert.equal(observedCwd,realpathSync(bDir),'tmux pane must actually move to the other managed project before the input guard is tested');
  assert.equal(realpathSync((await adapter.sessionPanes(right))[0].cwd),realpathSync(bDir));
  await assert.rejects(manager.frame(ctx,{v:1,type:'input',epoch:ready.epoch,seq:0,
    data:Buffer.from('touch wrong-project-marker\n').toString('base64')},deliver),{code:'PROCESS_PROOF_UNAVAILABLE'});
  await assert.rejects(readFile(join(bDir,'wrong-project-marker')),{code:'ENOENT'});
});

test('revoking an existing-session controller preserves the pane and requires owner reinspection',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-existing-revoke-'));
  const serverName=`seqivo-revoke-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite')),project=store.project({name:'Work',directory:dir});
  let manager,stops=0,inspections=0;
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  const control=createTerminalControl({store,quiesce:async()=>{stops++;return clear();},inspectWriters:inspectWorkspaceWriters,
    inspectExisting:async input=>{inspections++;return manager.inspectExisting(input);},sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'existing',label:'Existing',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  run('new-session','-d','-s','A','-c',dir);
  const adapter=createTmuxAdapter({executable:tmux,serverName}),a=(await adapter.list()).sessions[0].sessionRef;
  const panePid=(await adapter.sessionPanes(a))[0].pid;
  manager.setLink({state:()=>({nodeId:'node',ownerUserId:'owner',status:'connected'}),pending:async()=>({devices:[{deviceId:'phone',userId:'user'}]}),
    grant:async()=>({revision:1}),refresh:()=>{},close:async()=>{}});
  await manager.request('POST','/api/terminal/grants',{deviceId:'phone',profileId:'existing',scopes:['view','input','takeover','default']});
  const remote={nodeId:'node',deviceId:'phone',userId:'user',grantRevision:1,profileId:'existing',connectionId:'remote-controller',isCurrent:()=>true};
  const frames=[],deliver=f=>frames.push(f);
  await manager.frame(remote,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  await manager.frame(remote,{v:1,type:'takeover-existing',sessionRefs:[a]},deliver);
  assert.equal(frames.filter(f=>f.type==='control').at(-1).phase,'human');
  await manager.frame(remote,{v:1,type:'select',epoch:0,sessionRef:a},deliver);
  await manager.frame(remote,{v:1,type:'default',sessionRef:a,expectedRevision:0},deliver);
  await manager.frame(remote,{v:1,type:'detach'},deliver);
  const renewed={...remote,connectionId:'renewed-controller'},renewedFrames=[];
  await manager.frame(renewed,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>renewedFrames.push(f));
  assert.equal(renewedFrames.find(f=>f.type==='control').owned,true,'same device reclaims after old PTY exits');
  assert.deepEqual(renewedFrames.find(f=>f.type==='ready').sessionRef,a,'new ticket attaches saved default');
  await assert.rejects(manager.frame(remote,{v:1,type:'input',epoch:1,seq:0,data:Buffer.from('stale').toString('base64')},deliver),{code:'OPEN_REQUIRED'});
  const sameDevice={...remote,connectionId:'second-controller'},secondFrames=[];
  await manager.frame(sameDevice,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>secondFrames.push(f));
  assert.equal(secondFrames.find(f=>f.type==='control').owned,false,'same device cannot drive a second simultaneous writer');
  assert.equal(secondFrames.some(f=>f.type==='ready'),false,'unowned connection does not autoattach the default');
  await manager.closeConnection(sameDevice.connectionId);
  manager.disconnect(renewed.connectionId,0);
  for(let i=0;i<50;i++){if(!(await manager.request('GET','/api/terminal/status')).connections.some(c=>c.id===renewed.connectionId))break;
    await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal((await manager.request('GET','/api/terminal/status')).connections.some(c=>c.id===renewed.connectionId),false);
  const afterExpiry={...remote,connectionId:'after-expiry'},expiryFrames=[];
  await manager.frame(afterExpiry,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>expiryFrames.push(f));
  assert.equal(expiryFrames.find(f=>f.type==='control').owned,true,'expired connection may rejoin only after PTY retirement and reinspection');
  assert.deepEqual(expiryFrames.find(f=>f.type==='ready').sessionRef,a);
  await manager.request('DELETE','/api/terminal/grants/phone/existing');
  assert.equal((await adapter.sessionPanes(a))[0].pid,panePid,'revocation detached only this app client');
  assert.throws(()=>control.assertMayStart(project.id),{code:'CONTROL_BUSY'});
  await assert.rejects(manager.frame(afterExpiry,{v:1,type:'list'},deliver),{code:'GRANT_REQUIRED'});
  const local={local:true,profileId:'existing',connectionId:'local-owner'},ownerFrames=[];
  await manager.frame(local,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>ownerFrames.push(f));
  await manager.frame(local,{v:1,type:'reconcile-control',action:'acquire'},f=>ownerFrames.push(f));
  assert.equal(ownerFrames.filter(f=>f.type==='control').at(-1).phase,'human');
  assert.equal(ownerFrames.filter(f=>f.type==='control').at(-1).owned,true);
  assert.equal(stops,2);assert.ok(inspections>=2);
  assert.equal((await adapter.sessionPanes(a))[0].pid,panePid);
});

test('same remote device recovers managed Shell after PTY retirement and retains a managed tmux pane',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-managed-reclaim-'));
  const serverName=`seqivo-managed-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite')),project=store.project({name:'Work',directory:dir});
  let manager,quiesces=0;
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  const control=createTerminalControl({store,quiesce:async()=>{quiesces++;return clear();},inspectWriters:inspectWorkspaceWriters,
    inspectExisting:input=>manager.inspectExisting(input),sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'managed',label:'Managed',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  manager.setLink({state:()=>({nodeId:'node',ownerUserId:'owner',status:'connected'}),pending:async()=>({devices:[{deviceId:'phone',userId:'user'}]}),
    grant:async()=>({revision:1}),refresh:()=>{},close:async()=>{}});
  await manager.request('POST','/api/terminal/grants',{deviceId:'phone',profileId:'managed',scopes:['view','input','create','takeover','default']});
  const remote={nodeId:'node',deviceId:'phone',userId:'user',grantRevision:1,profileId:'managed',connectionId:'first',isCurrent:()=>true};
  const frames=[],deliver=f=>frames.push(f);
  await manager.frame(remote,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  await manager.frame(remote,{v:1,type:'takeover'},deliver);
  assert.equal(frames.filter(f=>f.type==='control').at(-1).phase,'human');
  await manager.frame(remote,{v:1,type:'open',mode:'shell',readOnly:false,cols:80,rows:24},deliver);
  assert.equal(frames.filter(f=>f.type==='ready').at(-1).mode,'shell');
  await manager.frame(remote,{v:1,type:'detach'},deliver);
  const shellAgain={...remote,connectionId:'shell-again'},shellFrames=[];
  await manager.frame(shellAgain,{v:1,type:'open',mode:'shell',readOnly:false,cols:80,rows:24},f=>shellFrames.push(f));
  assert.equal(shellFrames.find(f=>f.type==='control').owned,true);
  assert.equal(shellFrames.find(f=>f.type==='ready').mode,'shell');
  assert.ok(quiesces>=2,'new Shell ownership repeats managed executor quiesce');
  assert.throws(()=>control.assertMayStart(project.id),{code:'CONTROL_BUSY'});
  const shellEpoch=shellFrames.find(f=>f.type==='ready').epoch;
  await manager.frame(shellAgain,{v:1,type:'create',epoch:shellEpoch,name:'retained'},f=>shellFrames.push(f));
  const adapter=createTmuxAdapter({executable:tmux,serverName}),ref=(await adapter.list()).sessions[0].sessionRef;
  const panePid=(await adapter.sessionPanes(ref))[0].pid;
  await manager.frame(shellAgain,{v:1,type:'detach'},f=>shellFrames.push(f));
  const tmuxAgain={...remote,connectionId:'tmux-again'},tmuxFrames=[];
  await manager.frame(tmuxAgain,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>tmuxFrames.push(f));
  assert.equal(tmuxFrames.find(f=>f.type==='control').owned,true);
  assert.equal(tmuxFrames.find(f=>f.type==='control').mode,'managed');
  assert.deepEqual(tmuxFrames.find(f=>f.type==='ready').sessionRef,ref);
  assert.equal((await adapter.sessionPanes(ref))[0].pid,panePid,'original pane stays alive across client recovery');
  await assert.rejects(manager.frame(shellAgain,{v:1,type:'input',epoch:2,seq:0,data:Buffer.from('stale').toString('base64')},()=>{}),{code:'OPEN_REQUIRED'});
});

test('managed A and B survive remote reclaim; default A is retained and unregistered sessions stay denied',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-managed-ab-'));
  const serverName=`seqivo-managed-ab-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite')),project=store.project({name:'Work',directory:dir});
  let manager,revision=1;
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  const control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:inspectWorkspaceWriters,
    inspectExisting:input=>manager.inspectExisting(input),sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'managed',label:'Managed',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  manager.setLink({state:()=>({nodeId:'node',ownerUserId:'owner',status:'connected'}),pending:async()=>({devices:[{deviceId:'phone',userId:'user'}]}),
    grant:async()=>({revision:revision++}),refresh:()=>{},close:async()=>{}});
  const grantBody={deviceId:'phone',profileId:'managed',scopes:['view','input','create','takeover','default']};
  await manager.request('POST','/api/terminal/grants',grantBody);
  const remote={nodeId:'node',deviceId:'phone',userId:'user',grantRevision:1,profileId:'managed',connectionId:'first',isCurrent:()=>true};
  const frames=[],deliver=f=>frames.push(f),adapter=createTmuxAdapter({executable:tmux,serverName});
  await manager.frame(remote,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  await manager.frame(remote,{v:1,type:'takeover'},deliver);
  await manager.frame(remote,{v:1,type:'create',epoch:0,name:'A'},deliver);
  const a=frames.filter(f=>f.type==='ready').at(-1).sessionRef;
  const aPid=(await adapter.sessionPanes(a))[0].pid;
  await manager.frame(remote,{v:1,type:'default',sessionRef:a,expectedRevision:0},deliver);
  const aEpoch=frames.filter(f=>f.type==='ready').at(-1).epoch;
  await manager.frame(remote,{v:1,type:'create',epoch:aEpoch,name:'B'},deliver);
  const b=frames.filter(f=>f.type==='ready').at(-1).sessionRef;
  const bPid=(await adapter.sessionPanes(b))[0].pid;
  assert.notDeepEqual(a,b);
  assert.deepEqual(frames.filter(f=>f.type==='sessions').at(-1).defaultRef,a,'temporary B must not alter default A');
  assert.deepEqual(control.state()[0].authorizedSessionRefs,[a,b]);
  run('new-session','-d','-s','C','-c',dir);
  const c=(await adapter.list()).sessions.find(item=>item.name==='C').sessionRef;
  await manager.frame(remote,{v:1,type:'select',epoch:frames.filter(f=>f.type==='ready').at(-1).epoch,sessionRef:c,requestId:'unknown-c'},deliver);
  assert.equal(frames.at(-1).code,'SESSION_NOT_AUTHORIZED');
  run('kill-session','-t',c.sessionId);
  await manager.frame(remote,{v:1,type:'detach',requestId:'leave-b'},deliver);
  const renewed={...remote,connectionId:'renewed'},renewedFrames=[];
  await manager.frame(renewed,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>renewedFrames.push(f));
  assert.equal(renewedFrames.find(f=>f.type==='control').owned,true,renewedFrames.find(f=>f.type==='control').reason);
  assert.deepEqual(renewedFrames.find(f=>f.type==='ready').sessionRef,a,'reclaim must open the saved default A');
  assert.equal((await adapter.sessionPanes(a))[0].pid,aPid);
  assert.equal((await adapter.sessionPanes(b))[0].pid,bPid);
  const fakeInstance={...b,instanceId:'0'.repeat(64)};
  await manager.frame(renewed,{v:1,type:'select',epoch:renewedFrames.find(f=>f.type==='ready').epoch,sessionRef:fakeInstance,requestId:'wrong-instance'},f=>renewedFrames.push(f));
  assert.equal(renewedFrames.at(-1).code,'SESSION_NOT_AUTHORIZED');
  run('kill-session','-t',b.sessionId);run('new-session','-d','-s','B','-c',dir);
  const recreated=(await adapter.list()).sessions.find(item=>item.name==='B').sessionRef;
  assert.notDeepEqual(recreated,b,'same display name is a different session identity');
  await manager.frame(renewed,{v:1,type:'select',epoch:renewedFrames.find(f=>f.type==='ready').epoch,sessionRef:recreated,requestId:'recreated-b'},f=>renewedFrames.push(f));
  assert.equal(renewedFrames.at(-1).code,'SESSION_NOT_AUTHORIZED');
  run('kill-session','-t',recreated.sessionId);
  await manager.request('DELETE','/api/terminal/grants/phone/managed');
  await assert.rejects(manager.frame(renewed,{v:1,type:'list'},()=>{}),{code:'GRANT_REQUIRED'});
  const nextGrant=await manager.request('POST','/api/terminal/grants',grantBody);
  const afterRegrant={...remote,grantRevision:nextGrant.revision,connectionId:'after-regrant'},regrantFrames=[];
  await manager.frame(afterRegrant,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>regrantFrames.push(f));
  assert.equal(regrantFrames.find(f=>f.type==='control').owned,false,'regrant cannot restore the old control token');
  assert.equal(regrantFrames.some(f=>f.type==='ready'),false);
  assert.equal((await adapter.sessionPanes(a))[0].pid,aPid);
});

test('a retired B client can explicitly recover the original A after B exits',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-expired-default-'));
  const serverName=`seqivo-expired-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite')),project=store.project({name:'Work',directory:dir});
  let manager;
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  const control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:inspectWorkspaceWriters,
    inspectExisting:input=>manager.inspectExisting(input),sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'managed',label:'Managed',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  manager.setLink({state:()=>({nodeId:'node',ownerUserId:'owner',status:'connected'}),pending:async()=>({devices:[{deviceId:'phone',userId:'user'},{deviceId:'tablet',userId:'other'}]}),
    grant:async()=>({revision:1}),refresh:()=>{},close:async()=>{}});
  await manager.request('POST','/api/terminal/grants',{deviceId:'phone',profileId:'managed',scopes:['view','input','create','takeover','default']});
  await manager.request('POST','/api/terminal/grants',{deviceId:'tablet',profileId:'managed',scopes:['view','input','takeover','default']});
  const remote={nodeId:'node',deviceId:'phone',userId:'user',grantRevision:1,profileId:'managed',connectionId:'first',isCurrent:()=>true};
  const frames=[],deliver=f=>frames.push(f),adapter=createTmuxAdapter({executable:tmux,serverName});
  await manager.frame(remote,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  await manager.frame(remote,{v:1,type:'takeover'},deliver);
  await manager.frame(remote,{v:1,type:'create',epoch:0,name:'A'},deliver);
  const a=frames.filter(f=>f.type==='ready').at(-1).sessionRef,aPid=(await adapter.sessionPanes(a))[0].pid;
  await manager.frame(remote,{v:1,type:'create',epoch:frames.filter(f=>f.type==='ready').at(-1).epoch,name:'B'},deliver);
  const b=frames.filter(f=>f.type==='ready').at(-1).sessionRef;
  await manager.frame(remote,{v:1,type:'default',sessionRef:b,expectedRevision:0},deliver);
  const oldGeneration=control.state()[0].generation;
  const premature={...remote,connectionId:'premature'},prematureFrames=[];
  await manager.frame(premature,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>prematureFrames.push(f));
  assert.equal(prematureFrames.find(f=>f.type==='control').owned,false,'a live old client retains its claim');
  await assert.rejects(manager.frame(premature,{v:1,type:'select',epoch:0,sessionRef:a},f=>prematureFrames.push(f)),
    {code:'CONTROL_STALE'},'an active B writer prevents premature A transfer');
  await manager.closeConnection(premature.connectionId);
  run('send-keys','-t',b.sessionId,'exit','Enter');
  for(let i=0;i<40&&(await adapter.list()).sessions.some(s=>s.sessionRef.sessionId===b.sessionId);i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal((await adapter.list()).sessions.some(s=>s.sessionRef.sessionId===b.sessionId),false,'B exited normally');
  for(let i=0;i<40&&!frames.some(f=>f.type==='exit'&&f.reason==='process_exited');i++)await new Promise(resolve=>setTimeout(resolve,25));
  assert.ok(frames.some(f=>f.type==='exit'&&f.reason==='process_exited'),'original app client observed B PTY exit');
  run('new-session','-d','-s','B','-c',homedir());
  const replacement=(await adapter.list()).sessions.find(s=>s.name==='B').sessionRef;
  assert.notDeepEqual(replacement,b,'replacement B must have a new exact identity');
  manager.disconnect(remote.connectionId,30_000);
  for(let i=0;i<40&&(await manager.request('GET','/api/terminal/status')).connections.some(c=>c.id===remote.connectionId);i++)
    await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal((await manager.request('GET','/api/terminal/status')).connections.some(c=>c.id===remote.connectionId),false,
    'closed socket with exited PTY retires promptly instead of holding the claim for TTL');
  const renewed={...remote,connectionId:'renewed'},renewedFrames=[],send=f=>renewedFrames.push(f);
  await manager.frame(renewed,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},send);
  assert.equal(renewedFrames.some(f=>f.type==='ready'),false,'old B default is unavailable');
  assert.equal(renewedFrames.find(f=>f.type==='control')?.owned,false,'expired default does not silently recover a claim');
  await manager.frame(renewed,{v:1,type:'default',sessionRef:a,expectedRevision:1},send);
  await manager.frame(renewed,{v:1,type:'select',epoch:0,sessionRef:a},send);
  assert.deepEqual(renewedFrames.find(f=>f.type==='ready')?.sessionRef,a,'explicit A selection reclaims the retired same-device claim');
  assert.equal(control.state()[0].generation,oldGeneration+1,'recovery rotates the persistent generation');
  const recoveredControl=renewedFrames.filter(f=>f.type==='control').at(-1);
  assert.equal(recoveredControl?.owned,true,'recovered authority is reported to the selected connection');
  assert.equal(recoveredControl.generation,oldGeneration+1);
  assert.deepEqual(control.state()[0].authorizedSessionRefs,[a],'retired B is removed, never replaced by a name match');
  await assert.rejects(manager.frame(remote,{v:1,type:'input',epoch:frames.filter(f=>f.type==='ready').at(-1).epoch,
    seq:0,data:Buffer.from('stale').toString('base64')},deliver),{code:'OPEN_REQUIRED'},'retired connection cannot input');
  await manager.frame(renewed,{v:1,type:'select',epoch:renewedFrames.find(f=>f.type==='ready').epoch,
    sessionRef:replacement,requestId:'replacement-b'},send);
  assert.equal(renewedFrames.at(-1).code,'SESSION_NOT_AUTHORIZED');
  assert.deepEqual(renewedFrames.filter(f=>f.type==='sessions').at(-1).defaultRef,a,'B exit and recovery do not override saved A');
  const other={...remote,deviceId:'tablet',userId:'other',connectionId:'other-device'},otherFrames=[];
  await manager.frame(other,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>otherFrames.push(f));
  assert.equal(otherFrames.find(f=>f.type==='control').owned,false,'another device cannot inherit the rotated token');
  await assert.rejects(manager.frame(other,{v:1,type:'select',epoch:0,sessionRef:a},f=>otherFrames.push(f)),{code:'CONTROL_STALE'});
  assert.equal((await adapter.sessionPanes(a))[0].pid,aPid,'A pane identity is preserved');
});

test('owner restart recovery selects surviving managed A after registered B exits',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-owner-recovery-'));
  const serverName=`seqivo-owner-recovery-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite')),project=store.project({name:'Work',directory:dir});
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  let manager,control;
  const start=()=>{
    control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:inspectWorkspaceWriters,
      inspectExisting:input=>manager.inspectExisting(input),sealHuman:input=>manager.sealProject(input.projectId)});
    manager=createTerminalManager({store,control});
  };
  start();
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'managed',label:'Managed',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  const owner={local:true,profileId:'managed',connectionId:'owner-before'},frames=[],deliver=f=>frames.push(f);
  await manager.frame(owner,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  await manager.frame(owner,{v:1,type:'takeover'},deliver);
  await manager.frame(owner,{v:1,type:'create',epoch:0,name:'A'},deliver);
  const adapter=createTmuxAdapter({executable:tmux,serverName});
  const a=frames.filter(f=>f.type==='ready').at(-1).sessionRef,aPid=(await adapter.sessionPanes(a))[0].pid;
  await manager.frame(owner,{v:1,type:'create',epoch:frames.filter(f=>f.type==='ready').at(-1).epoch,name:'B'},deliver);
  const b=frames.filter(f=>f.type==='ready').at(-1).sessionRef;
  await manager.frame(owner,{v:1,type:'default',sessionRef:b,expectedRevision:0},deliver);
  const before=control.state()[0].generation;
  run('send-keys','-t',b.sessionId,'exit','Enter');
  for(let i=0;i<60&&(await adapter.list()).sessions.some(s=>s.sessionRef.sessionId===b.sessionId);i++)await new Promise(resolve=>setTimeout(resolve,50));
  assert.equal((await adapter.list()).sessions.some(s=>s.sessionRef.sessionId===b.sessionId),false);
  await manager.close();start();
  assert.equal(control.state()[0].phase,'unknown');
  const resumed={local:true,profileId:'managed',connectionId:'owner-after'},after=[],send=f=>after.push(f);
  await manager.frame(resumed,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},send);
  assert.equal(after.filter(f=>f.type==='control').at(-1).requiresSessionSelection,true,'recorded managed A/B requires explicit surviving-session selection');
  await manager.frame(resumed,{v:1,type:'reconcile-control',action:'acquire',requestId:'recover-dead-default'},send);
  assert.equal(after.filter(f=>f.type==='error').at(-1)?.requestId,'recover-dead-default','failed recovery is correlated to its request');
  assert.equal(control.state()[0].phase,'unknown','dead default does not silently restore control');
  await manager.frame(resumed,{v:1,type:'reconcile-control',action:'acquire',sessionRef:{...a,sessionId:'invalid'},requestId:'recover-invalid-ref'},send);
  assert.equal(after.filter(f=>f.type==='error').at(-1)?.requestId,'recover-invalid-ref','invalid explicit identity receives a correlated refusal');
  assert.equal(control.state()[0].phase,'unknown');
  await manager.frame(resumed,{v:1,type:'reconcile-control',action:'acquire',sessionRef:a,requestId:'recover-surviving-a'},send);
  assert.equal(after.filter(f=>f.type==='control').at(-1)?.requestId,'recover-surviving-a','final recovery control is correlated');
  assert.equal(control.state()[0].phase,'human',control.state()[0].reason);
  assert.equal(control.state()[0].generation,before+1);
  assert.deepEqual(control.state()[0].authorizedSessionRefs,[a]);
  assert.deepEqual(after.filter(f=>f.type==='sessions').at(-1).defaultRef,b,'dead B default is preserved until a separate explicit default change');
  await manager.frame(resumed,{v:1,type:'select',epoch:0,sessionRef:a},send);
  const ready=after.filter(f=>f.type==='ready').at(-1);
  assert.deepEqual(ready.sessionRef,a);
  await manager.frame(resumed,{v:1,type:'input',epoch:ready.epoch,seq:0,
    data:Buffer.from('printf recovered > recovered.txt\n').toString('base64')},send);
  for(let i=0;i<40;i++){try{if(await readFile(join(dir,'recovered.txt'),'utf8')==='recovered')break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(await readFile(join(dir,'recovered.txt'),'utf8'),'recovered');
  await assert.rejects(manager.frame(owner,{v:1,type:'input',epoch:frames.filter(f=>f.type==='ready').at(-1).epoch,
    seq:1,data:Buffer.from('old').toString('base64')},deliver),{code:'OPEN_REQUIRED'});
  run('new-session','-d','-s','B','-c',homedir());
  const replacement=(await adapter.list()).sessions.find(s=>s.name==='B').sessionRef;
  assert.notDeepEqual(replacement,b);
  await manager.frame(resumed,{v:1,type:'select',epoch:ready.epoch,sessionRef:replacement,requestId:'replacement'},send);
  assert.equal(after.at(-1).code,'SESSION_NOT_AUTHORIZED','same-name replacement cannot inherit B authorization');
  assert.equal((await adapter.sessionPanes(a))[0].pid,aPid);
});

test('fresh authenticated open recovers exact A without attaching live default B',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-exact-recovery-'));
  const serverName=`seqivo-exact-recovery-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite')),project=store.project({name:'Work',directory:dir});
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  let manager,control;
  control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:inspectWorkspaceWriters,
    inspectExisting:input=>manager.inspectExisting(input),sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'managed',label:'Managed',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  const original={local:true,profileId:'managed',connectionId:'exact-before'},frames=[],send=f=>frames.push(f);
  await manager.frame(original,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},send);
  await manager.frame(original,{v:1,type:'takeover'},send);
  await manager.frame(original,{v:1,type:'create',epoch:0,name:'A'},send);
  const a=frames.filter(f=>f.type==='ready').at(-1).sessionRef;
  await manager.frame(original,{v:1,type:'create',epoch:frames.filter(f=>f.type==='ready').at(-1).epoch,name:'B'},send);
  const b=frames.filter(f=>f.type==='ready').at(-1).sessionRef;
  await manager.frame(original,{v:1,type:'default',sessionRef:b,expectedRevision:0},send);
  const competing={local:true,profileId:'managed',connectionId:'exact-competing'},blocked=[],blockedReply=f=>blocked.push(f);
  await manager.frame(competing,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24,recoverSessionRef:a},blockedReply);
  assert.equal(blocked.some(f=>f.type==='ready'),false,'new connection cannot steal an active owner attachment');
  assert.equal(blocked.filter(f=>f.type==='error').at(-1)?.code,'CONTROL_REQUIRED');
  await manager.closeConnection(competing.connectionId);
  await manager.closeConnection(original.connectionId);
  const fresh={local:true,profileId:'managed',connectionId:'exact-after'},after=[],reply=f=>after.push(f);
  await manager.frame(fresh,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24,recoverSessionRef:a},reply);
  assert.deepEqual(after.filter(f=>f.type==='ready').at(-1)?.sessionRef,a,'fresh connection must attach exact former A');
  assert.deepEqual(after.filter(f=>f.type==='sessions').at(-1)?.defaultRef,b,'saved default B remains unchanged');
  await manager.closeConnection(fresh.connectionId);
  run('send-keys','-t',a.sessionId,'exit','Enter');
  const adapter=createTmuxAdapter({executable:tmux,serverName});
  for(let i=0;i<60&&(await adapter.list()).sessions.some(s=>s.sessionRef.sessionId===a.sessionId);i++)await new Promise(resolve=>setTimeout(resolve,50));
  run('new-session','-d','-s','A','-c',homedir());
  assert.equal((await adapter.list()).sessions.some(s=>s.name==='A'&&s.sessionRef.sessionId===a.sessionId),false,'same-name replacement has a new identity');
  const missing={local:true,profileId:'managed',connectionId:'exact-missing'},failed=[],failReply=f=>failed.push(f);
  await manager.frame(missing,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24,recoverSessionRef:a},failReply);
  assert.equal(failed.some(f=>f.type==='ready'),false,'missing A cannot silently attach default B');
  assert.equal(failed.filter(f=>f.type==='error').at(-1)?.code,'SESSION_NOT_FOUND');
});

test('explicit owner-phone-owner transfer keeps the same tmux pane and closes old input first',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-human-transfer-'));
  const serverName=`seqivo-transfer-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite')),project=store.project({name:'Work',directory:dir});
  let manager;
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  const control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:inspectWorkspaceWriters,
    inspectExisting:input=>manager.inspectExisting(input),sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'managed',label:'Managed',projectId:project.id,enabled:true,
    serverName,allowSharedServer:true,tmuxExecutable:tmux});
  await manager.request('POST','/api/terminal/profiles',{id:'other-profile',label:'Other',projectId:project.id,enabled:true,
    serverName,allowSharedServer:true,tmuxExecutable:tmux});
  manager.setLink({state:()=>({nodeId:'node',ownerUserId:'owner',status:'connected'}),
    pending:async()=>({devices:[{deviceId:'phone',userId:'owner'},{deviceId:'foreign',userId:'other'},
      {deviceId:'viewer',userId:'owner'},{deviceId:'shell-phone',userId:'owner'}]}),
    grant:async()=>({revision:1}),refresh:()=>{},close:async()=>{}});
  await manager.request('POST','/api/terminal/grants',{deviceId:'phone',profileId:'managed',
    scopes:['view','input','takeover']});
  await manager.request('POST','/api/terminal/grants',{deviceId:'foreign',profileId:'managed',
    scopes:['view','input','takeover']});
  await manager.request('POST','/api/terminal/grants',{deviceId:'viewer',profileId:'managed',scopes:['view']});
  await manager.request('POST','/api/terminal/grants',{deviceId:'phone',profileId:'other-profile',scopes:['view','input','takeover']});
  await manager.request('POST','/api/terminal/grants',{deviceId:'shell-phone',profileId:'managed',scopes:['view','input','takeover']});
  const owner={local:true,profileId:'managed',connectionId:'owner-first'},of=[],os=f=>of.push(f);
  await manager.frame(owner,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},os);
  await manager.frame(owner,{v:1,type:'takeover'},os);
  await manager.frame(owner,{v:1,type:'create',epoch:0,name:'A'},os);
  const a=of.filter(f=>f.type==='ready').at(-1).sessionRef,adapter=createTmuxAdapter({executable:tmux,serverName});
  const aPid=(await adapter.sessionPanes(a))[0].pid,oldEpoch=of.filter(f=>f.type==='ready').at(-1).epoch;
  const phone={nodeId:'node',deviceId:'phone',userId:'owner',grantRevision:1,profileId:'managed',connectionId:'phone',isCurrent:()=>true};
  const pf=[],ps=f=>pf.push(f);
  await manager.frame(phone,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},ps);
  assert.equal(pf.some(f=>f.type==='ready'),false,'target waits without a human claim');
  const foreign={...phone,deviceId:'foreign',userId:'other',connectionId:'foreign'},ff=[];
  await manager.frame(foreign,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>ff.push(f));
  const viewer={...phone,deviceId:'viewer',connectionId:'viewer'},vf=[];
  await manager.frame(viewer,{v:1,type:'open',mode:'tmux',readOnly:true,cols:80,rows:24},f=>vf.push(f));
  const readOnly={...phone,connectionId:'phone-readonly'},rf=[];
  await manager.frame(readOnly,{v:1,type:'open',mode:'tmux',readOnly:true,cols:80,rows:24},f=>rf.push(f));
  const otherProfile={...phone,profileId:'other-profile',connectionId:'phone-other-profile'},op=[];
  await manager.frame(otherProfile,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>op.push(f));
  const shellTarget={...phone,deviceId:'shell-phone',connectionId:'shell-target'},sf=[];
  await assert.rejects(manager.frame(shellTarget,{v:1,type:'open',mode:'shell',readOnly:false,cols:80,rows:24},
    f=>sf.push(f)),{code:'CONTROL_REQUIRED'},'waiting Shell cannot acquire another holder\'s managed project');
  await manager.frame(owner,{v:1,type:'list-control-targets',requestId:'targets-one'},os);
  const targets=of.filter(f=>f.type==='controlTargets').at(-1);
  assert.deepEqual(targets.items.map(item=>item.connectionId),['phone']);
  for(const targetConnectionId of ['phone-other-profile','shell-target','phone-readonly','viewer'])
    await assert.rejects(manager.frame(owner,{v:1,type:'transfer-control',targetConnectionId,
      expectedGeneration:control.state()[0].generation},os),{code:'TRANSFER_TARGET_UNAVAILABLE'});
  await assert.rejects(manager.frame(owner,{v:1,type:'transfer-control',targetConnectionId:'foreign',
    expectedGeneration:control.state()[0].generation},os),{code:'TRANSFER_TARGET_UNAVAILABLE'});
  assert.equal(control.state()[0].phase,'human','invalid target never freezes the valid holder');
  await manager.frame(owner,{v:1,type:'transfer-control',targetConnectionId:'phone',
    expectedGeneration:control.state()[0].generation,requestId:'transfer-one'},os);
  const offer=pf.find(f=>f.type==='controlOffer');
  assert.ok(offer?.transferId);
  assert.equal(of.filter(f=>f.type==='control').at(-1).phase,'transfer_pending');
  await assert.rejects(manager.frame(owner,{v:1,type:'input',epoch:oldEpoch,seq:0,
    data:Buffer.from('old').toString('base64')},os),{code:'CONTROL_REQUIRED'});
  await manager.frame(phone,{v:1,type:'accept-control',transferId:offer.transferId,requestId:'accept-one'},ps);
  assert.ok(pf.findIndex(f=>f.type==='transferAccepted')<pf.findIndex(f=>f.type==='control'&&f.owned===true),
    'offer acceptance must precede Hub owned-control release');
  assert.equal(pf.filter(f=>f.type==='control').at(-1).owned,true);
  await assert.rejects(manager.frame(phone,{v:1,type:'accept-control',transferId:offer.transferId},ps),{code:'CONTROL_STALE'});
  await manager.frame(phone,{v:1,type:'select',epoch:0,sessionRef:a},ps);
  const ready=pf.filter(f=>f.type==='ready').at(-1);
  await manager.frame(phone,{v:1,type:'input',epoch:ready.epoch,seq:0,
    data:Buffer.from('printf phone > phone.txt\n').toString('base64')},ps);
  for(let i=0;i<40;i++){try{if(await readFile(join(dir,'phone.txt'),'utf8')==='phone')break;}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.equal(await readFile(join(dir,'phone.txt'),'utf8'),'phone');
  assert.equal((await adapter.sessionPanes(a))[0].pid,aPid);
  const ownerNext={...owner,connectionId:'owner-next'},nf=[],ns=f=>nf.push(f);
  await manager.frame(ownerNext,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},ns);
  await manager.frame(phone,{v:1,type:'list-control-targets',requestId:'targets-two'},ps);
  assert.ok(pf.filter(f=>f.type==='controlTargets').at(-1).items.some(item=>item.connectionId==='owner-next'&&item.local===true),
    'the newly opened local owner is a valid explicit target');
  await manager.frame(phone,{v:1,type:'transfer-control',targetConnectionId:'owner-next',
    expectedGeneration:control.state()[0].generation},ps);
  const back=nf.find(f=>f.type==='controlOffer');assert.ok(back?.transferId);
  await assert.rejects(manager.frame(phone,{v:1,type:'input',epoch:ready.epoch,seq:1,
    data:Buffer.from('late').toString('base64')},ps),{code:'CONTROL_REQUIRED'});
  await manager.frame(ownerNext,{v:1,type:'accept-control',transferId:back.transferId},ns);
  await manager.frame(ownerNext,{v:1,type:'select',epoch:0,sessionRef:a},ns);
  assert.equal(nf.filter(f=>f.type==='control').at(-1).owned,true);
  assert.equal((await adapter.sessionPanes(a))[0].pid,aPid);
  assert.throws(()=>control.assertMayStart(project.id),{code:'CONTROL_BUSY'});
  await manager.frame(ownerNext,{v:1,type:'transfer-control',targetConnectionId:'phone',
    expectedGeneration:control.state()[0].generation},ns);
  assert.equal(control.state()[0].phase,'transfer_pending');
  manager.disconnect(phone.connectionId,0);
  for(let i=0;i<40&&control.state()[0].phase!=='unknown';i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(control.state()[0].phase,'unknown','target disconnection freezes the unfinished transfer');
  assert.equal((await adapter.sessionPanes(a))[0].pid,aPid,'failed transfer leaves tmux A alive');
});

test('pending transfer rejects a revoked target, replaced source socket, or cancellation',async t=>{
  for(const change of ['revoke-target','replace-source','cancel'])await t.test(change,async sub=>{
    const dir=await mkdtemp(join(tmpdir(),'terminal-transfer-auth-'));
    const store=new Store(join(dir,'board.sqlite')),project=store.project({name:'Work',directory:dir});
    const sessionRef={serverName:`test-${randomBytes(4).toString('hex')}`,instanceId:'a'.repeat(64),sessionId:'$0'};
    const proof=async input=>({verified:true,authorized:true,unknown:false,unownedWriters:[],scope:'injected-auth-test',
      sessionEvidence:input.sessionRefs.map(ref=>({sessionRef:ref,panes:[{paneId:'%0',pid:123,startedAt:'fixture'}]}))});
    const control=createTerminalControl({store,quiesce:async()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'injected-auth-test'}),
      inspectWriters:async()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'injected-auth-test'}),inspectExisting:proof});
    const manager=createTerminalManager({store,control});
    sub.after(async()=>{await manager.close();store.close();await rm(dir,{recursive:true,force:true});});
    await manager.request('POST','/api/terminal/profiles',{id:'managed',label:'Managed',projectId:project.id,enabled:true,
      serverName:sessionRef.serverName,allowSharedServer:true,tmuxExecutable:tmux});
    manager.setLink({state:()=>({nodeId:'node',ownerUserId:'owner',status:'connected'}),
      pending:async()=>({devices:[{deviceId:'phone',userId:'owner'}]}),grant:async()=>({revision:1}),refresh:()=>{},close:async()=>{}});
    await manager.request('POST','/api/terminal/grants',{deviceId:'phone',profileId:'managed',scopes:['view','input','takeover']});
    let sourceCurrent=true;
    const source={local:true,profileId:'managed',connectionId:'source',isCurrent:()=>sourceCurrent},sf=[];
    await manager.frame(source,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>sf.push(f));
    await manager.frame(source,{v:1,type:'takeover'},f=>sf.push(f));
    const token=JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('terminal.control.v1').value)
      .entries[project.id].token;
    await control.registerManagedSession({projectId:project.id,token,actorId:'local-owner',profileId:'managed',sessionRef});
    const target={nodeId:'node',deviceId:'phone',userId:'owner',grantRevision:1,profileId:'managed',
      connectionId:'target',isCurrent:()=>true},tf=[];
    await manager.frame(target,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>tf.push(f));
    await manager.frame(source,{v:1,type:'transfer-control',targetConnectionId:'target',
      expectedGeneration:control.state()[0].generation},f=>sf.push(f));
    const offer=tf.find(f=>f.type==='controlOffer');assert.ok(offer?.transferId);
    if(change==='revoke-target')await manager.request('DELETE','/api/terminal/grants/phone/managed');
    else if(change==='replace-source')sourceCurrent=false;
    else await manager.frame(source,{v:1,type:'cancel-transfer',transferId:offer.transferId},f=>sf.push(f));
    if(change==='revoke-target')await assert.rejects(manager.frame(target,{v:1,type:'accept-control',
      transferId:offer.transferId},f=>tf.push(f)),{code:'GRANT_REQUIRED'});
    else if(change==='replace-source')await manager.frame(target,{v:1,type:'accept-control',transferId:offer.transferId},f=>tf.push(f));
    else await assert.rejects(manager.frame(target,{v:1,type:'accept-control',transferId:offer.transferId},
      f=>tf.push(f)),{code:'CONTROL_STALE'});
    assert.equal(control.state()[0].phase,'unknown');
    assert.equal(tf.some(f=>f.type==='transferAccepted'),false);
    assert.throws(()=>control.assertMayStart(project.id),{code:'CONTROL_BUSY'});
  });
});

test('explicit detach confirms PTY retirement before immediate same-device reconnect',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-detach-ack-'));
  const serverName=`seqivo-detach-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  const store=new Store(join(dir,'board.sqlite')),project=store.project({name:'Work',directory:dir});
  let manager;
  const clear=()=>({verified:true,quiescent:true,unknown:false,livePids:[],scope:'test-no-managed-executor'});
  const control=createTerminalControl({store,quiesce:async()=>clear(),inspectWriters:inspectWorkspaceWriters,
    inspectExisting:input=>manager.inspectExisting(input),sealHuman:input=>manager.sealProject(input.projectId)});
  manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'existing',label:'Existing',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  run('new-session','-d','-s','A','-c',dir);
  const adapter=createTmuxAdapter({executable:tmux,serverName}),a=(await adapter.list()).sessions[0].sessionRef;
  const panePid=(await adapter.sessionPanes(a))[0].pid;
  manager.setLink({state:()=>({nodeId:'node',ownerUserId:'owner',status:'connected'}),pending:async()=>({devices:[{deviceId:'phone',userId:'user'},{deviceId:'tablet',userId:'other'}]}),
    grant:async()=>({revision:1}),refresh:()=>{},close:async()=>{}});
  await manager.request('POST','/api/terminal/grants',{deviceId:'phone',profileId:'existing',scopes:['view','input','takeover','default']});
  let current=true;
  const remote={nodeId:'node',deviceId:'phone',userId:'user',grantRevision:1,profileId:'existing',connectionId:'first',isCurrent:()=>current};
  const frames=[],deliver=f=>frames.push(f);
  await manager.frame(remote,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},deliver);
  await manager.frame(remote,{v:1,type:'takeover-existing',sessionRefs:[a]},deliver);
  await manager.frame(remote,{v:1,type:'select',epoch:0,sessionRef:a},deliver);
  await manager.frame(remote,{v:1,type:'default',sessionRef:a,expectedRevision:0},deliver);
  current=false;
  await assert.rejects(manager.frame(remote,{v:1,type:'detach'},deliver),{code:'CONNECTION_CHANGED'});
  manager.disconnect(remote.connectionId,30_000);
  const premature={...remote,connectionId:'premature',isCurrent:()=>true},prematureFrames=[];
  await manager.frame(premature,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>prematureFrames.push(f));
  assert.equal(prematureFrames.find(f=>f.type==='control').owned,false,'closed socket cannot detach a retained PTY or transfer claim');
  await manager.closeConnection(premature.connectionId);
  await manager.closeConnection(remote.connectionId);
  const second={...remote,connectionId:'second',isCurrent:()=>true},secondFrames=[];
  await manager.frame(second,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>secondFrames.push(f));
  assert.equal(secondFrames.find(f=>f.type==='control').owned,true);
  assert.deepEqual(secondFrames.find(f=>f.type==='ready').sessionRef,a);
  await manager.frame(second,{v:1,type:'detach',requestId:'confirmed-close'},f=>secondFrames.push(f));
  assert.equal(secondFrames.at(-1).type,'exit','server must acknowledge completed PTY close before browser closes its socket');
  assert.equal(secondFrames.at(-1).reason,'detached');
  assert.equal(secondFrames.at(-1).requestId,'confirmed-close');
  await assert.rejects(manager.frame(second,{v:1,type:'input',epoch:2,seq:0,data:Buffer.from('stale').toString('base64')},()=>{}),{code:'OPEN_REQUIRED'});
  const third={...remote,connectionId:'third',isCurrent:()=>true},thirdFrames=[];
  await manager.frame(third,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>thirdFrames.push(f));
  assert.equal(thirdFrames.find(f=>f.type==='control').owned,true);
  assert.deepEqual(thirdFrames.find(f=>f.type==='ready').sessionRef,a);
  assert.equal((await adapter.sessionPanes(a))[0].pid,panePid);
  await manager.request('POST','/api/terminal/grants',{deviceId:'tablet',profileId:'existing',scopes:['view','input','takeover','default']});
  const other={...remote,deviceId:'tablet',userId:'other',connectionId:'other-device',isCurrent:()=>true},otherFrames=[];
  await manager.frame(other,{v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},f=>otherFrames.push(f));
  assert.equal(otherFrames.find(f=>f.type==='control').owned,false,'another authorized device cannot steal this human control generation');
  assert.equal(otherFrames.some(f=>f.type==='ready'),false);
  await manager.request('DELETE','/api/terminal/grants/phone/existing');
  await assert.rejects(manager.frame(third,{v:1,type:'input',epoch:1,seq:0,data:Buffer.from('revoked').toString('base64')},()=>{}),{code:'GRANT_REQUIRED'});
  assert.equal((await adapter.sessionPanes(a))[0].pid,panePid,'revocation closes only the app client');
});
