import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHub} from '../server/hub/http.mjs';
import {createRemoteLink} from '../server/remote-client.mjs';

const gateBase=()=>({v:1,bootId:'fixture-conversation-boot',observedAt:new Date().toISOString()});
const ready={state:'ready',reasonCode:null};
const taskGate=task=>({...gateBase(),taskRevision:task.revision,contentVersion:task.contentVersion,message:ready,continue:ready});

async function setup({beforeRequest}={}) {
  const root=await mkdtemp(join(tmpdir(),'seqivo-conversation-hub-'));
  const hub=await createHub({dataDir:join(root,'hub')});
  const owner=(await readFile(hub.store.bootstrap('personal').tokenPath,'utf8')).trim();
  async function call(method,path,body,token=owner,expected=200) {
    const res=await fetch(hub.url+path,{method,headers:{...(token?{Authorization:`Bearer ${token}`}:{ }),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const data=await res.json(); assert.equal(res.status,expected,JSON.stringify(data)); return data;
  }
  const pair=async(role,projectIds=['p1'])=>{const {code}=await call('POST','/api/admin/pairings',{role,projectIds});return call('POST','/api/pairings/redeem',{code},null);};
  const board={projects:[{id:'p1',name:'Project',conversationStart:{...gateBase(),...ready}}],tasks:[]};
  const calls=[],watched=[];let transcript=[];
  const link=await createRemoteLink({dataDir:join(root,'node'),getState:()=>board,
    getConversations:async(projectIds,ids)=>{watched.push({projectIds,ids});return transcript.filter(t=>ids.includes(t.taskId));},
    request:async(method,path,body,authorization)=>{
      await beforeRequest?.(authorization);
      calls.push({method,path,body});
      if(path==='/api/conversations'){
        const task={id:'new-task',projectId:body.projectId,title:body.title,revision:1,contentVersion:1,status:'running',conversationId:'secret-thread'};
        task.executionWrite=taskGate(task);board.tasks.push(task);
        return {taskId:task.id,status:'running',revision:task.revision};
      }
      if(path==='/api/tasks/planned-task/start'){
        const task=board.tasks.find(item=>item.id==='planned-task');
        task.conversationId='private-thread';task.status='running';task.revision++;
        task.executionWrite=taskGate(task);
        return {taskId:task.id,status:'running'};
      }
      if(path.endsWith('/message')){const task=board.tasks[0];task.status='running';task.revision++;task.executionWrite=taskGate(task);return{taskId:task.id,status:'running',revision:task.revision};}
      return{status:'paused'};
    }});
  const {code}=await call('POST','/api/admin/pairings',{role:'node',projectIds:['p1']});
  await link.configure({url:hub.url,pairingCode:code,projectIds:['p1']});
  return {root,hub,owner,call,pair,board,link,calls,watched,setTranscript:value=>transcript=value,close:async()=>{await link.close();await hub.close();await rm(root,{recursive:true,force:true});}};
}

test('account owner can create a conversation once and watch only scoped visible output',async()=>{
  const x=await setup();try{
    const input={projectId:'p1',commandId:'create-1',title:'Change button',message:'Make the button rounded'};
    assert.equal((await x.call('POST','/api/conversations',input)).status,'queued');
    await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal((await x.call('POST','/api/conversations',input)).status,'queued');
    await x.call('POST','/api/conversations',{...input,message:'different'},x.owner,409);
    await x.link.sync();
    const receipt=await x.call('GET','/api/commands/create-1');
    assert.equal(receipt.status,'running');assert.equal(receipt.result.taskId,'new-task');
    assert.equal(x.calls.length,1);assert.equal(x.calls[0].path,'/api/conversations');assert.equal(x.calls[0].body.projectId,'p1');
    const viewer=await x.pair('controller');
    const readonly=await x.pair('viewer');
    await x.call('GET','/api/tasks/new-task/conversation',null,readonly.token,403);
    assert.equal((await x.call('GET','/api/tasks/new-task/conversation',null,viewer.token)).status,'loading');
    x.setTranscript([{taskId:'new-task',projectId:'p1',status:'running',messages:[
      {id:'1',role:'assistant',text:'Editing the component',rawProviderSecret:'hidden'},
      {id:'2',role:'reasoning',text:'private reasoning'},
    ],updatedAt:new Date().toISOString(),privateThreadId:'secret-thread'}]);
    await x.link.sync();
    const view=await x.call('GET','/api/tasks/new-task/conversation',null,viewer.token);
    assert.deepEqual(view.messages,[{id:'1',role:'assistant',text:'Editing the component'}]);
    assert.equal(JSON.stringify(view).includes('secret-thread'),false);
    assert.deepEqual(x.watched.at(-1).ids,['new-task']);
    await x.call('POST','/api/conversations',{...input,commandId:'viewer-create'},readonly.token,403);
    const other=(await readFile(x.hub.store.bootstrap('other').tokenPath,'utf8')).trim();
    await x.call('GET','/api/tasks/new-task/conversation',null,other,404);
    await x.call('POST','/api/conversations',{...input,commandId:'foreign'},other,503);
    await x.call('POST','/api/conversations',{...input,commandId:'bad',cwd:'/tmp/escape'},x.owner,400);
  }finally{await x.close();}
});

test('last-send online revalidation rejects a controller revoked after initial command preflight',async()=>{
  let release,entered;
  const waiting=new Promise(resolve=>entered=resolve),resume=new Promise(resolve=>release=resolve);
  const x=await setup({beforeRequest:async authorization=>{entered();await resume;await authorization.revalidate();}});
  try{
    const controller=await x.pair('controller');
    await x.call('POST','/api/conversations',{projectId:'p1',commandId:'queued-revoke',title:'Edit',message:'Change file'},controller.token);
    const sync=x.link.sync();await waiting;
    await x.call('POST',`/api/admin/subjects/${controller.subjectId}/revoke`,{});
    release();await sync;
    assert.equal(x.calls.length,0);assert.equal(x.board.tasks.length,0);
    assert.notEqual((await x.call('GET','/api/commands/queued-revoke')).status,'running');
  }finally{release();await x.close();}
});

test('message shares execution lease with continue and terminal pre-send snapshots cannot release it',async()=>{
  const x=await setup();try{
    x.board.tasks.push({id:'done-task',projectId:'p1',title:'Done task',revision:7,contentVersion:2,status:'submitted',conversationId:'bound'});
    x.board.tasks[0].executionWrite=taskGate(x.board.tasks[0]);
    await x.link.sync();
    const controller=await x.pair('controller');
    const input={commandId:'message-1',projectId:'p1',taskId:'done-task',action:'message',expectedRevision:7,expiresAt:new Date(Date.now()+60000).toISOString(),body:{message:'Please improve spacing'}};
    await x.call('POST','/api/commands',input,controller.token);
    await x.call('POST','/api/commands',{...input,commandId:'continue-1',action:'continue',body:{}},controller.token,409);
    await x.link.sync();
    assert.equal(x.calls.length,1);assert.equal(x.calls[0].body.message,'Please improve spacing');
    assert.equal((await x.call('GET','/api/commands/message-1',null,controller.token)).status,'running');
    const lease=x.hub.store.db.prepare('SELECT command_id FROM continue_leases').get();assert.equal(lease.command_id,'message-1');
    x.board.tasks[0].status='submitted';x.board.tasks[0].revision++;x.board.tasks[0].executionWrite=taskGate(x.board.tasks[0]);
    await x.link.sync();
    assert.equal(x.hub.store.db.prepare('SELECT count(*) AS n FROM continue_leases').get().n,0);
  }finally{await x.close();}
});

test('queued message is rejected if local revision changes; revoked viewers cannot read transcripts',async()=>{
  const x=await setup();try{
    x.board.tasks.push({id:'existing',projectId:'p1',title:'Existing',revision:1,contentVersion:1,status:'planned'});
    x.board.tasks[0].executionWrite=taskGate(x.board.tasks[0]);
    await x.link.sync();
    const controller=await x.pair('controller');
    await x.call('POST','/api/commands',{commandId:'stale-message',projectId:'p1',taskId:'existing',action:'message',expectedRevision:1,expiresAt:new Date(Date.now()+60000).toISOString(),body:{message:'Edit'}},controller.token);
    x.board.tasks[0].revision++;x.board.tasks[0].executionWrite=taskGate(x.board.tasks[0]);
    await x.link.sync();assert.equal(x.calls.length,0);
    assert.equal((await x.call('GET','/api/commands/stale-message',null,controller.token)).status,'failed');
    const viewer=await x.pair('viewer');
    await x.call('POST',`/api/admin/subjects/${viewer.subjectId}/revoke`,{});
    await x.call('GET','/api/tasks/existing/conversation',null,viewer.token,401);
  }finally{await x.close();}
});

test('start_task starts the original planned task without creating a second task',async()=>{
  const x=await setup();try{
    const task={id:'planned-task',projectId:'p1',title:'Original',revision:1,contentVersion:1,status:'planned',criteria:[{id:'c1',text:'Done'}],evidence:[]};
    task.executionWrite={...taskGate(task),start:ready};
    x.board.tasks.push(task);x.board.capabilities={taskStart:true};
    await x.link.sync();
    const controller=await x.pair('controller');
    const input={commandId:'start-original',projectId:'p1',taskId:task.id,action:'start_task',expectedRevision:1,
      expiresAt:new Date(Date.now()+60000).toISOString(),queueOffline:false,body:{message:'Implement the original task'}};
    assert.equal((await x.call('POST','/api/commands',input,controller.token)).status,'queued');
    await x.link.sync();
    assert.equal(x.calls.length,1);
    assert.equal(x.calls[0].path,'/api/tasks/planned-task/start');
    assert.equal((await x.call('GET','/api/commands/start-original',null,controller.token)).result.taskId,task.id);
    assert.equal(x.board.tasks.length,1);
  }finally{await x.close();}
});

test('start_task session revalidation permits only the original command after its own startup blocks the global gate',async()=>{
  let x,sessionChecks=0;
  x=await setup({beforeRequest:async authorization=>{
    if(authorization?.action!=='start_task')return;
    const gate=x.board.tasks[0].executionWrite;
    gate.start={state:'blocked',reasonCode:'ACTIVE_EXECUTION'};
    await assert.rejects(authorization.revalidate(),/Local task start changed/);
    await authorization.revalidate({stage:'confirmed-start-session'});
    sessionChecks++;
    gate.start=ready;
  }});
  try{
    const task={id:'planned-task',projectId:'p1',title:'Original',revision:1,contentVersion:1,status:'planned'};
    task.executionWrite={...taskGate(task),start:ready};x.board.tasks.push(task);x.board.capabilities={taskStart:true};
    await x.link.sync();
    const controller=await x.pair('controller');
    await x.call('POST','/api/commands',{commandId:'own-startup',projectId:'p1',taskId:task.id,
      action:'start_task',expectedRevision:1,expiresAt:new Date(Date.now()+60000).toISOString(),
      body:{message:'Run after startup'},queueOffline:false},controller.token);
    await x.link.sync();
    assert.equal(sessionChecks,1);
    assert.equal((await x.call('GET','/api/commands/own-startup',null,controller.token)).status,'running');
  }finally{await x.close();}
});

test('start_task restores a lost running receipt from the durable original result without another start',async()=>{
  const x=await setup();try{
    const task={id:'planned-task',projectId:'p1',title:'Original',revision:1,contentVersion:1,status:'planned'};
    task.executionWrite={...taskGate(task),start:ready};x.board.tasks.push(task);x.board.capabilities={taskStart:true};
    await x.link.sync();
    const controller=await x.pair('controller');
    await x.call('POST','/api/commands',{commandId:'lost-start',projectId:'p1',taskId:task.id,
      action:'start_task',expectedRevision:1,expiresAt:new Date(Date.now()+60000).toISOString(),
      body:{message:'Start once'},queueOffline:false},controller.token);
    const originalFetch=globalThis.fetch;
    try{
      globalThis.fetch=(url,options)=>String(url).endsWith('/api/node/commands/lost-start/receipt')
        ?Promise.reject(new Error('Acknowledgement lost')):originalFetch(url,options);
      await x.link.sync();
    }finally{globalThis.fetch=originalFetch;}
    assert.equal(x.calls.length,1);
    x.hub.store.now=()=>Date.now()+301000;
    assert.equal((await x.call('GET','/api/commands/lost-start',null,controller.token)).status,'unknown');
    await x.call('POST','/api/commands/lost-start/reconcile',{},controller.token);
    await x.link.sync();
    const recovered=await x.call('GET','/api/commands/lost-start',null,controller.token);
    assert.equal(recovered.status,'running');
    assert.equal(recovered.recovery.outcome,'applied');
    assert.equal(recovered.result.taskId,task.id);
    assert.equal(x.calls.length,1);
  }finally{await x.close();}
});
