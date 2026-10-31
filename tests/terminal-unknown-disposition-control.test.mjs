import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {createTerminalControl} from '../server/terminal/control.mjs';

const clear={verified:true,quiescent:true,unknown:false,livePids:[],scope:'disposable-test-proof'};
async function fixture(t,quiesce){
  const root=await mkdtemp(join(tmpdir(),'seqivo-disposition-control-')),workspace=join(root,'work');
  await mkdir(workspace);
  const store=new Store(join(root,'board.sqlite')),project=store.project({name:'Disposable',directory:workspace});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const options={store,quiesce,inspectWriters:async()=>clear,
    inspectDirectories:async()=>({verified:true,directories:[]})};
  return {store,project,options,control:createTerminalControl(options)};
}

test('explicit old-turn consent is exact, private and reported only after confirmed return',async t=>{
  let f,seen;
  f=await fixture(t,async input=>{
    const {id,projectId}=input.unknownDispositionConsent;
    seen=f.control.authorizeUnknownDisposition({projectId,consentId:id,taskId:'task-one',commandId:'old:turn'});
    assert.throws(()=>f.control.authorizeUnknownDisposition({projectId,consentId:id,taskId:'task-one',commandId:'new:turn'}),{code:'CONTROL_STALE'});
    return {...clear,dispositions:[{id,taskId:'task-one',commandId:'old:turn'}]};
  });
  let authorized=0;
  const human=await f.control.acquire({projectId:f.project.id,profileId:'managed',actorId:'phone',
    endUnknownCommands:[{taskId:'task-one',commandId:'old:turn'}],authorize:()=>{authorized++;}});
  assert.equal(human.phase,'human',human.reason);
  assert.ok(authorized>=2);
  assert.equal(seen.actorId,'phone');assert.equal(seen.generation,human.generation);
  assert.equal(seen.token,human.token);
  assert.equal(JSON.stringify(f.control.state()).includes(seen.id),false);
  assert.deepEqual(f.control.returnedUnknownDispositions(),[]);
  const review=await f.control.release({projectId:f.project.id,token:human.token,profileId:'managed',notes:'Manual repair'});
  assert.equal(review.phase,'return_review',review.reason);
  assert.deepEqual(f.control.returnedUnknownDispositions(),[]);
  const returned=await f.control.confirmReturn({projectId:f.project.id,token:human.token,profileId:'managed',actorId:'phone',
    expectedGeneration:review.generation,reviewId:review.returnReview.reviewId});
  assert.equal(returned.phase,'ai_ready',returned.reason);
  const [record]=f.control.returnedUnknownDispositions();
  assert.equal(record.id,seen.id);assert.equal(record.commandId,'old:turn');
  assert.equal(record.controlGeneration,human.generation);assert.equal(record.returnedGeneration,returned.generation);
  assert.equal(record.workspace,seen.workspace);
  // Opening an existing tmux session must not erase an unacknowledged return.
  const ref={serverName:'disposable',instanceId:'a'.repeat(64),sessionId:'$0'};
  const next=createTerminalControl({...f.options,quiesce:async()=>clear,
    inspectExisting:async()=>({verified:true,authorized:true,unknown:false,unownedWriters:[],
      sessionEvidence:[{sessionRef:ref}],scope:'disposable-existing-proof'}),
    inspectDirectories:async()=>({verified:true,directories:[{sessionRef:ref,path:'.'}]})});
  const existing=await next.acquireExisting({projectId:f.project.id,actorId:'phone',profileId:'existing',sessionRefs:[ref]});
  assert.equal(existing.phase,'human',existing.reason);
  assert.deepEqual(next.returnedUnknownDispositions(),[]);
  const existingReview=await next.release({projectId:f.project.id,token:existing.token,profileId:'existing',notes:''});
  assert.equal(existingReview.phase,'return_review',existingReview.reason);
  const existingReturn=await next.confirmReturn({projectId:f.project.id,token:existing.token,profileId:'existing',actorId:'phone',
    expectedGeneration:existingReview.generation,reviewId:existingReview.returnReview.reviewId});
  assert.equal(existingReturn.phase,'ai_ready',existingReturn.reason);
  assert.deepEqual(next.returnedUnknownDispositions(),[record]);
});

test('connection loss during stop freezes takeover and cannot become fresh consent on recovery',async t=>{
  let f,consent,live=true;
  f=await fixture(t,async input=>{
    if(input.unknownDispositionConsent){
      consent=input.unknownDispositionConsent;
      if(live){f.control.authorizeUnknownDisposition({projectId:f.project.id,consentId:consent.id,taskId:'t',commandId:'c'});live=false;}
      else assert.throws(()=>f.control.authorizeUnknownDisposition({projectId:f.project.id,consentId:consent.id,taskId:'t',commandId:'c'}),{code:'CONTROL_STALE'});
    }
    return clear;
  });
  const result=await f.control.acquire({projectId:f.project.id,profileId:'managed',actorId:'phone',
    endUnknownCommands:[{taskId:'t',commandId:'c'}],authorize:()=>{if(!live)throw new Error('Connection lost');}});
  assert.equal(result.phase,'unknown');
  const recovered=await f.control.reconcile({projectId:f.project.id,actorId:'local-owner',trustedOwner:true,action:'acquire'});
  assert.equal(recovered.phase,'human',recovered.reason);
  assert.equal(f.control.unknownDispositionConsent(f.project.id).id,consent.id);
  assert.deepEqual(f.control.returnedUnknownDispositions(),[]);
});

test('ordinary takeover never grants disposal authority and duplicate selections are rejected',async t=>{
  const f=await fixture(t,async input=>{assert.equal(input.unknownDispositionConsent,undefined);return clear;});
  await assert.rejects(f.control.acquire({projectId:f.project.id,profileId:'managed',actorId:'phone',
    endUnknownCommands:[{taskId:'t',commandId:'c'},{taskId:'t',commandId:'c'}],authorize:()=>{}}));
  const human=await f.control.acquire({projectId:f.project.id,actorId:'phone'});
  assert.equal(human.phase,'human');
  assert.equal(f.control.unknownDispositionConsent(f.project.id),null);
});
