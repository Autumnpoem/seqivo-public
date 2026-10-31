import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {returnedDispositionPayloads} from '../server/unknown-disposition-sync.mjs';

test('Hub root resolution requires matching local turn, Host receipt and completed human return',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'seqivo-disposition-binding-'));
  const directory=join(dataDir,'plugins','codex-autocontinue');await mkdir(directory,{recursive:true});
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const disposition={version:1,id:'consent-one',projectId:'p',taskId:'actual-task',commandId:'root:turn',
    threadId:'original-thread',turnId:'original-turn',workspace:'/disposable',actorId:'phone',profileId:'managed',generation:4,
    providerOutcome:'unknown',reason:'human_disposition'};
  const command={...disposition,status:'unknown',stopProof:{status:'unverified'},disposition};
  const save=()=>writeFile(join(directory,'codex-autocontinue.json'),JSON.stringify({commands:{'actual-task:root:turn':command}}),{mode:0o600});
  await save();
  let returned=[],binding={action:'start_task',projectId:'p',taskId:'actual-task',localCommandId:'root:turn',threadId:'original-thread'};
  const args={dataDir,identity:{nodeId:'node',epoch:1},commandId:'root',dispatchBinding:null,
    store:{getTask:()=>({id:'actual-task',projectId:'p',conversationId:'original-thread'})},
    leases:{dispositions:()=>[disposition]},control:{returnedUnknownDispositions:()=>returned},
    conversations:{executionBinding:id=>id==='root'?binding:null}};
  assert.deepEqual(returnedDispositionPayloads(args),[],'no early release during human phase');
  returned=[{...disposition,controlGeneration:4,returnedGeneration:5}];
  const [payload]=returnedDispositionPayloads(args);
  assert.equal(payload.localCommandId,'root:turn');assert.equal(payload.taskId,'actual-task');
  assert.equal(payload.returnedGeneration,5);assert.equal(Object.hasOwn(payload,'workspace'),false);
  assert.deepEqual(returnedDispositionPayloads({...args,commandId:'wrong-root'}),[],'suffix guessing without a journal is not allowed');
  binding={...binding,threadId:'wrong-thread'};assert.deepEqual(returnedDispositionPayloads(args),[]);
  binding={...binding,threadId:'original-thread'};
  command.disposition={...disposition,id:'other-consent'};await save();
  assert.deepEqual(returnedDispositionPayloads(args),[],'Host and Core must hold the same disposition');
  command.disposition=disposition;await save();
  const dispatchBinding={commandId:'root',nodeId:'node',epoch:1,action:'start_task',projectId:'p',taskId:'actual-task'};
  assert.deepEqual(returnedDispositionPayloads({...args,dispatchBinding:{...dispatchBinding,epoch:2}}),[]);
  assert.equal(returnedDispositionPayloads({...args,dispatchBinding}).length,1);
  binding={...binding,action:'create_conversation'};
  const created=returnedDispositionPayloads({...args,dispatchBinding:{...dispatchBinding,action:'create_conversation',taskId:'root'}});
  assert.equal(created[0].taskId,'root','Hub request placeholder is distinct from the proved actual created task');
  assert.equal(created[0].localCommandId,'root:turn');
  assert.deepEqual(returnedDispositionPayloads(args),[],'legacy conversation without dispatch identity cannot be guessed');
});
