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

const tmux=process.env.TMUX_TEST_EXECUTABLE||resolve('.tools/terminal-build/install/bin/tmux');

test('unknown writer with a live default receives an explicit recovery gate, never ready',async t=>{
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('isolated tmux executable unavailable');return;}
  const dir=await mkdtemp(join(tmpdir(),'terminal-ui222-'));
  const serverName=`ui222-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000});
  const store=new Store(join(dir,'board.sqlite'));
  const project=store.project({name:'Recovery gate',directory:dir});
  const entry={projectId:project.id,phase:'unknown',actorId:'local-owner',generation:2,mode:'managed',authorizedSessionRefs:[]};
  const control={state:()=>[entry],hasManagedSessionRefs:()=>true};
  const manager=createTerminalManager({store,control});
  t.after(async()=>{await manager.close();try{run('kill-server');}catch{}store.close();await rm(dir,{recursive:true,force:true});});
  await manager.request('POST','/api/terminal/profiles',{id:'default',label:'Recovery',projectId:project.id,enabled:true,serverName,allowSharedServer:true,tmuxExecutable:tmux});
  run('new-session','-d','-s','A');
  const viewer={local:true,profileId:'default',connectionId:'ui222-viewer'};
  const seen=[];
  await manager.frame(viewer,{v:1,type:'open',mode:'tmux',readOnly:true,cols:80,rows:24},frame=>seen.push(frame));
  const ref=seen.find(frame=>frame.type==='sessions').items[0].sessionRef;
  await manager.frame(viewer,{v:1,type:'default',sessionRef:ref,expectedRevision:0},frame=>seen.push(frame));
  const writerFrames=[];
  await manager.frame({local:true,profileId:'default',connectionId:'ui222-writer'},
    {v:1,type:'open',mode:'tmux',readOnly:false,cols:80,rows:24},frame=>writerFrames.push(frame));
  assert.equal(writerFrames.find(frame=>frame.type==='control')?.canReconcileAcquire,true);
  assert.equal(writerFrames.find(frame=>frame.type==='error')?.code,'CONTROL_REQUIRED');
  assert.equal(writerFrames.some(frame=>frame.type==='ready'),false);
});
