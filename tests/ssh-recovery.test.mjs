import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSshManager } from '../server/ssh/manager.mjs';
import { initialTmuxSession } from '../server/ssh/session.mjs';

const a={id:'$1',name:'A',server:'a'.repeat(64),windows:1};
const b={id:'$2',name:'B',server:'b'.repeat(64),windows:1};

test('recovery selects exact current B, while a new manual connection selects default A',()=>{
  assert.equal(initialTmuxSession([a,b],a,b),b);
  assert.equal(initialTmuxSession([a,b],a,null),a);
  assert.equal(initialTmuxSession([a],a,b),null,'missing B must not fall back to A');
  assert.equal(initialTmuxSession([a,{...b,server:'c'.repeat(64)}],a,b),null,
    'replacement with the same tmux id and name must not be treated as B');
});

test('recovery ticket rejects malformed identity and changed host revision',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'seqivo-ssh-recovery-'));
  const manager=createSshManager({dataDir:dir,allowPrivateTargets:true});
  const actor={owner:'alice',local:true,binding:'local',validate:()=>true};
  try{
    const host=manager.request('POST','/api/ssh/hosts',{
      name:'Recovery fixture',host:'127.0.0.1',port:22,username:'tester',kind:'server',
      authMethod:'password',tmuxServer:'default',jumpHostId:null,
    },actor);
    const body={hostId:host.id,recoverSession:{id:b.id,server:b.server},expectedHostRevision:host.revision};
    assert.match(manager.request('POST','/api/ssh/tickets',body,actor).ticket,/^[A-Za-z0-9_-]+$/);
    assert.match(manager.request('POST','/api/ssh/tickets',{hostId:host.id},actor).ticket,/^[A-Za-z0-9_-]+$/);
    assert.throws(()=>manager.request('POST','/api/ssh/tickets',{...body,expectedHostRevision:host.revision+1},actor),
      {code:'SSH_CONFLICT'});
    assert.throws(()=>manager.request('POST','/api/ssh/tickets',{...body,recoverSession:{id:'$2',server:'bad'}},actor),
      {code:'SSH_CONFLICT'});
    assert.throws(()=>manager.request('POST','/api/ssh/tickets',{hostId:host.id,expectedHostRevision:host.revision},actor),
      {code:'SSH_CONFLICT'});
  }finally{await manager.close();await rm(dir,{recursive:true,force:true});}
});
