import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {createRemoteExecution} from '../server/remote-execution.mjs';
import {createConversations} from '../server/conversations.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
async function setup(){
  const dir=await mkdtemp(join(tmpdir(),'seqivo-remote-gate-'));const store=new Store(join(dir,'board.sqlite'));
  const project=store.project({name:'Test',directory:dir});
  const task=store.createTask({projectId:project.id,title:'Existing',goal:'Edit',conversationId:'thread'});
  return{store,project,task,close:async()=>{store.close();await rm(dir,{recursive:true,force:true});}};
}

test('remote authorization is checked again at provider send and fails closed after completion or restart',async()=>{
  const x=await setup();try{
    let allowed=true,checks=0;
    const gate=createRemoteExecution({store:x.store});
    const input={commandId:'remote-1',taskId:x.task.id};
    const authorization={...input,projectId:x.project.id,action:'message',revalidate:async()=>{checks++;if(!allowed)throw Error('Hub revoked');}};
    await gate.run(authorization,async()=>{
      await gate.check({...input,required:true}); // before local queue/provider work
      allowed=false;
      await assert.rejects(gate.check(input),/Hub revoked/); // immediately before real send
    });
    assert.equal(checks,2);
    await assert.rejects(gate.check(input),/授权已失效/);
    await assert.rejects(createRemoteExecution({store:x.store}).check(input),/授权已失效/);
    await gate.check({commandId:'local-only',taskId:x.task.id});
    await assert.rejects(gate.check({commandId:'forged',taskId:x.task.id,required:true}),/授权已失效/);
  }finally{await x.close();}
});

test('queued remote creation and message revalidate before creating tasks or resuming providers',async()=>{
  const x=await setup();const entered=deferred(),release=deferred();let sends=0,allowed=true;
  const gate=createRemoteExecution({store:x.store});
  const runtime=createConversations({store:x.store,selectedProjects:()=>[x.project.id],beforeRemoteOperation:input=>gate.check({...input,required:true}),plugin:{
    resume:async()=>{sends++;entered.resolve();await release.promise;return{status:'running'};},
    createSession:async()=>{throw Error('revoked creation must not reach provider');},
  }});
  try{
    const first=runtime.message(x.task.id,{message:'Local',commandId:'local-1',expectedRevision:x.task.revision});
    await entered.promise;
    const authorization={projectId:x.project.id,revalidate:async()=>{if(!allowed)throw Error('Hub revoked');}};
    const queuedMessage=gate.run({...authorization,action:'message',commandId:'remote-2',taskId:x.task.id},()=>runtime.message(x.task.id,{message:'Remote',commandId:'remote-2',expectedRevision:x.task.revision},true));
    const queuedCreate=gate.run({...authorization,action:'create_conversation',commandId:'remote-3',taskId:'remote-3'},()=>runtime.create({projectId:x.project.id,message:'Create',commandId:'remote-3'},true));
    const rejected=Promise.all([assert.rejects(queuedMessage,/Hub revoked/),assert.rejects(queuedCreate,/Hub revoked/)]);
    allowed=false;release.resolve();await first;await rejected;
    assert.equal(sends,1);assert.equal(x.store.tasks().length,1);
  }finally{release.resolve();await runtime.close();await x.close();}
});

test('shutdown rejects not-yet-started conversation queue entries',async()=>{
  const x=await setup();const entered=deferred(),release=deferred();let sends=0;
  const runtime=createConversations({store:x.store,plugin:{resume:async()=>{sends++;entered.resolve();await release.promise;return{status:'running'};}}});
  try{
    const first=runtime.message(x.task.id,{message:'First',commandId:'first',expectedRevision:x.task.revision});await entered.promise;
    const queued=runtime.message(x.task.id,{message:'Queued',commandId:'queued',expectedRevision:x.task.revision});
    const rejected=assert.rejects(queued,/关闭/);const closing=runtime.close();release.resolve();await first;await rejected;await closing;assert.equal(sends,1);
  }finally{release.resolve();await runtime.close();await x.close();}
});
