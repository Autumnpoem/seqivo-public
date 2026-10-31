import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nativeProcessTable,nativeTerminalProcessObservation} from '../server/codex-process-proof.mjs';
import {verifyManagedObservedWriters} from '../server/terminal/manager.mjs';

const python=process.env.TASKBOARD_TEST_PYTHON||'python3';
const helper=fileURLToPath(new URL('../plugins/codex-autocontinue/process_snapshot.py',import.meta.url));
const fixture=fileURLToPath(new URL('./fixtures/process-snapshot-observation-diagnostic.py',import.meta.url));
const birth=(pid,ppid,startUsec=1)=>({pid,ppid,pgid:pid,euid:501,ruid:501,startSec:12345,startUsec});
const map=(...rows)=>new Map(rows.map(row=>[row.pid,row]));
const proof={identities:{shell:{pid:10},supervisor:{pid:9}},sessionRef:{serverName:'test',instanceId:'a',sessionId:'$1'}};

test('single complete bulk observation tolerates unrelated churn; original stable proof still rejects it',()=>{
  const result=spawnSync(python,[fixture,helper],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.stderr||result.stdout);
  assert.match(result.stdout,/terminal-observation-contract: passed/);
});

test('writer ancestry accepts unrelated table changes but fails closed on root, chain or writer change',()=>{
  const base=map(birth(9,1),birth(10,9),birth(11,10),birth(12,11),birth(80,1));
  const unrelated=map(birth(9,1),birth(10,9),birth(11,10),birth(12,11),birth(81,1));
  const result=()=>({verified:true,unknown:false,unownedWriters:[{pid:12}],scope:'test'});
  assert.deepEqual(verifyManagedObservedWriters({proofs:[proof],nativeBefore:base,nativeAfter:unrelated,result:result()}).unownedWriters,[]);
  for(const after of [
    map(birth(9,1),birth(11,10),birth(12,11)),
    map(birth(9,1),birth(10,9,2),birth(11,10),birth(12,11)),
    map(birth(9,1),birth(10,9),birth(11,10,2),birth(12,11)),
    map(birth(9,1),birth(10,9),birth(11,99),birth(12,11)),
    map(birth(9,1),birth(10,9),birth(11,10)),
    map(birth(9,1),birth(10,9),birth(11,10),birth(12,11,2)),
  ]){
    try{
      const checked=verifyManagedObservedWriters({proofs:[proof],nativeBefore:base,nativeAfter:after,result:result()});
      assert.deepEqual(checked.unownedWriters,[{pid:12}]);
      assert.equal(checked.authorized,false);
    }catch(error){assert.equal(error.code,'PROCESS_PROOF_UNAVAILABLE');}
  }
  const foreign=map(birth(9,1),birth(10,9),birth(11,10),birth(12,11));
  foreign.get(12).euid=502;
  assert.deepEqual(verifyManagedObservedWriters({proofs:[proof],nativeBefore:base,nativeAfter:foreign,result:result()}).unownedWriters,[{pid:12}]);
});

test('the stable snapshot entrypoint remains separate',()=>{
  assert.notEqual(nativeTerminalProcessObservation,nativeProcessTable);
});

test('real macOS single observation contains the calling process with exact native birth',
  {skip:process.platform!=='darwin'},async()=>{
    const table=await nativeTerminalProcessObservation(python,15000);
    const own=table.get(process.pid);
    assert.ok(own);
    assert.equal(own.euid,process.geteuid());
    assert.ok(own.startSec>0);
    assert.ok(own.startUsec>=0&&own.startUsec<1_000_000);
  });

test('JS accepts only the distinct complete-observation protocol and rejects malformed rows',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'terminal-native-observation-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const stub=join(dir,'python-stub');
  const uid=process.geteuid();
  const valid={schemaVersion:1,uid,observerPid:999999,ignoredObserverPid:999999,
    scope:'macos-current-effective-uid-complete-observation',verified:true,reason:null,attempts:1,
    rows:[{pid:123,ppid:1,pgid:123,euid:uid,ruid:uid,startSec:12345,startUsec:1}]};
  async function sample(result){
    await writeFile(stub,`#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify(result))});\n`,{mode:0o700});
    return nativeTerminalProcessObservation(stub,1000);
  }
  assert.deepEqual([...await sample(valid)].map(([pid])=>pid),[123]);
  for(const result of [
    {...valid,scope:'macos-current-effective-uid-two-observed-enumerations'},
    {...valid,attempts:2},
    {...valid,rows:[...valid.rows,...valid.rows]},
    {...valid,rows:[{...valid.rows[0],euid:uid+1}]},
    {...valid,rows:[{...valid.rows[0],startUsec:1_000_000}]},
  ])await assert.rejects(sample(result),/Unverified|Invalid native/);
  await assert.rejects(nativeProcessTable(stub,1000),/Unverified native process snapshot/);
});
