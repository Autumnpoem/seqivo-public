import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLinuxManagedWriters } from '../server/terminal/linux-managed-writers.mjs';

const ref={serverName:'test',instanceId:'a'.repeat(64),sessionId:'$0'};
const row=(pid,ppid,startTicks=String(pid))=>({kind:'linux-proc',pid,ppid,pgid:100,euid:1000,ruid:1000,
  bootId:'12345678-1234-1234-1234-123456789abc',startTicks});
const identities=new Map([[100,row(100,1)],[101,row(101,100)],[102,row(102,1)],[103,row(103,101)],
  [104,row(104,1)],[105,row(105,100)],[106,row(106,102)]]);
const proof={sessionRef:ref,relayPaneId:'%0',relayPanePid:102,
  identities:{supervisor:identities.get(100),shell:identities.get(101),relay:identities.get(102)}};
const session={sessionRef:ref,panes:[{paneId:'%0',pid:102,cwd:'/workspace'}]};
const writer=pid=>({pid,reason:'cwd',path:'/workspace'});
const inspect=({writers=[writer(103)],selected=async pids=>new Map(pids.map(pid=>[pid,identities.get(pid)])),previousEvidence=null}={})=>{
  const inspectWriters=async()=>({verified:true,unknown:false,writers});
  return inspectLinuxManagedWriters({workspace:'/workspace',sessions:[session],proofs:[proof],previousEvidence,
    selectedIdentities:selected,inspectWriters});
};

test('Linux managed writer proof accepts stable original ancestry and records Linux pane birth',async()=>{
  const result=await inspect();
  assert.equal(result.verified,true);assert.equal(result.authorized,true);assert.equal(result.unknown,false);
  assert.deepEqual(result.sessionEvidence,[{sessionRef:ref,panes:[{kind:'linux-proc',paneId:'%0',pid:102,
    bootId:identities.get(102).bootId,startTicks:'102'}]}]);
  assert.equal((await inspect({previousEvidence:result.sessionEvidence})).authorized,true);
});

test('Linux managed writer proof rejects unrelated writers and changed or missing original identities',async()=>{
  const foreign=await inspect({writers:[writer(104)]});
  assert.equal(foreign.verified,true);assert.equal(foreign.authorized,false);
  assert.deepEqual(foreign.unownedWriters,[writer(104)]);
  let calls=0;
  const changed=await inspect({selected:async pids=>{
    calls++;
    return new Map(pids.map(pid=>[pid,pid===103&&calls>1?row(103,101,'999'):identities.get(pid)]));
  }});
  assert.equal(changed.unknown,true);
  assert.equal((await inspect({selected:async pids=>new Map(pids.filter(pid=>pid!==102).map(pid=>[pid,identities.get(pid)]))})).unknown,true);
  assert.equal((await inspect({previousEvidence:[{sessionRef:ref,panes:[{kind:'linux-proc',paneId:'%0',pid:102,
    bootId:identities.get(102).bootId,startTicks:'999'}]}]})).unknown,true);
});

test('Linux writer proof does not authorize supervisor siblings or relay descendants',async()=>{
  for (const pid of [105,106]) {
    const result=await inspect({writers:[writer(pid)]});
    assert.equal(result.verified,true);
    assert.equal(result.authorized,false);
    assert.deepEqual(result.unownedWriters,[writer(pid)]);
  }
  for (const pid of [100,102]) assert.equal((await inspect({writers:[writer(pid)]})).authorized,true);
});
