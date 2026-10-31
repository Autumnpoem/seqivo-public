import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHub} from '../server/hub/http.mjs';
import {createRemoteLink} from '../server/remote-client.mjs';
import {sanitizeSnapshot} from '../server/hub/projection.mjs';

const stamp=()=>new Date().toISOString();
const task=(id='t1',projectId='p1')=>({id,projectId,title:id,status:'blocked',revision:1,contentVersion:1});
const item=(id='i1',taskId='t1',projectId='p1')=>({id,taskId,projectId,kind:'decision',state:'open',itemRevision:1,sourceRevision:1,contentVersion:1,
  source:{type:'decision.request',id:'request-1'},dedupKey:'/private/internal-key',priority:70,title:'Choose storage',summary:'Persistence needs a choice',impact:'Implementation is waiting',recommendedAction:'Select an option',
  createdAt:stamp(),updatedAt:stamp(),resolvedAt:null,resolution:null,shareWithRemote:true,options:[{id:'sqlite',label:'SQLite',consequence:'Use local database'}]});
const board=()=>({projects:[{id:'p1',name:'One',conversationStart:{v:1,bootId:'fixture-inbox-boot',observedAt:stamp(),state:'ready',reasonCode:null}},{id:'p2',name:'Two'}],tasks:[task(),task('t2','p2')],capabilities:{inbox:true},inbox:{items:[item(),item('i2','t2','p2')],updatedAt:stamp()}});
async function fixture(now=Date.now){
  const dir=await mkdtemp(join(tmpdir(),'seqivo-inbox-hub-'));
  const hub=await createHub({dataDir:join(dir,'hub'),host:'127.0.0.1',port:0,now});
  async function call(method,path,body,token,expected=200){
    const res=await fetch(`${hub.url}${path}`,{method,headers:{...(token?{Authorization:`Bearer ${token}`} :{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const value=await res.json();assert.equal(res.status,expected,JSON.stringify(value));return value;
  }
  const owner=await readFile(hub.store.bootstrap('tenant-one').tokenPath,'utf8').then(s=>s.trim());
  async function pair(role,projectIds=['p1','p2'],token=owner){const {code}=await call('POST','/api/admin/pairings',{role,projectIds},token);return call('POST','/api/pairings/redeem',{code});}
  return {dir,hub,owner,call,pair,close:async()=>{await hub.close();await rm(dir,{recursive:true,force:true});}};
}
const command=(id='answer',body={itemId:'i1',expectedItemRevision:1,action:'answer',optionId:'sqlite'},clock=Date.now())=>({commandId:id,projectId:'p1',taskId:'t1',action:'inbox_action',expectedRevision:1,expiresAt:new Date(clock+60000).toISOString(),body});

test('inbox projection masks private text and unknown metadata; validates links and malformed records',()=>{
  const input=board();const privateItem=input.inbox.items[0];
  privateItem.shareWithRemote=false;privateItem.title='/private/secret';privateItem.options[0].label='/private/password';
  privateItem.rawProvider={password:'secret'};privateItem.resolution={answer:'/private/answer'};
  const projected=sanitizeSnapshot(input);
  assert.equal(projected.inbox.items[0].id,'i1');assert.equal(projected.inbox.items[0].options,undefined);
  assert.equal(JSON.stringify(projected).includes('/private/'),false);assert.equal(JSON.stringify(projected).includes('rawProvider'),false);
  assert.deepEqual(sanitizeSnapshot(projected),projected,'double projection is stable');
  for(const mutate of [b=>b.inbox.items.push({...b.inbox.items[0]}),b=>b.inbox.items[0].projectId='p2',b=>b.inbox.items[0].sourceRevision=2,
    b=>b.inbox.items[0].contentVersion=2,b=>b.inbox.items[0].state='done',b=>b.inbox.items[0].itemRevision=-1,b=>b.inbox.items[0].source.id='/private/id',
    b=>b.inbox.items[0].options.push({...b.inbox.items[0].options[0]})]){
    const invalid=board();mutate(invalid);assert.throws(()=>sanitizeSnapshot(invalid));
  }
});

test('remote inbox enforces tenant/project/read-only grants, private decisions, CAS and online-only commands',async()=>{
  let clock=Date.now();const x=await fixture(()=>clock);
  try{
    const node=await x.pair('node'),controller=await x.pair('controller',['p1']),viewer=await x.pair('viewer',['p1']);
    const input=board();
    await x.call('POST','/api/node/snapshot',{...input,epoch:1,sequence:1},node.token);
    const state=await x.call('GET','/api/state',undefined,controller.token);
    assert.deepEqual(state.inbox.items.map(i=>i.id),['i1']);assert.equal(state.capabilities.inbox,true);
    const other=await readFile(x.hub.store.bootstrap('tenant-two').tokenPath,'utf8').then(s=>s.trim());
    assert.deepEqual((await x.call('GET','/api/inbox',undefined,other)).items,[]);
    await x.call('POST','/api/commands',command(),viewer.token,403);
    await x.call('POST','/api/commands',{...command(),projectId:'p2',taskId:'t2'},controller.token,403);
    await x.call('POST','/api/commands',{...command(),queueOffline:true},controller.token,400);
    await x.call('POST','/api/commands',command('bad-item',{itemId:'i2',expectedItemRevision:1,action:'answer',optionId:'sqlite'}),controller.token,404);
    await x.call('POST','/api/commands',command('bad-rev',{itemId:'i1',expectedItemRevision:2,action:'answer',optionId:'sqlite'}),controller.token,409);
    await x.call('POST','/api/commands',command('bad-field',{itemId:'i1',expectedItemRevision:1,action:'answer',optionId:'sqlite',resolved:true}),controller.token,400);
    await x.call('POST','/api/commands',command('bad-option',{itemId:'i1',expectedItemRevision:1,action:'answer',optionId:'foreign'}),controller.token,400);
    const requested=command();const first=await x.call('POST','/api/commands',requested,controller.token);
    assert.equal((await x.call('POST','/api/commands',requested,controller.token)).commandId,first.commandId);
    await x.call('POST','/api/commands',{...requested,body:{...requested.body,answer:'different'}},controller.token,409);
    await x.call('POST','/api/node/commands/answer/claim',{},node.token);
    input.inbox.items[0].itemRevision=2;
    await x.call('POST','/api/node/snapshot',{...input,epoch:1,sequence:2},node.token);
    await x.call('POST','/api/node/commands/answer/validate',{},node.token,409);
    input.inbox.items[0].itemRevision=1;input.inbox.items[0].shareWithRemote=false;
    await x.call('POST','/api/node/snapshot',{...input,epoch:1,sequence:3},node.token);
    await x.call('POST','/api/commands',command('private'),controller.token,403);
    clock+=61000;
    await x.call('POST','/api/commands',command('offline',undefined,clock),controller.token,503);
  }finally{await x.close();}
});

test('remote inbox action routes to local CAS once and returns completed receipt; old node requires update',async()=>{
  const x=await fixture();let link;
  try{
    const {code}=await x.call('POST','/api/admin/pairings',{role:'node',projectIds:['p1','p2']},x.owner);
    const state=board(),calls=[];
    link=await createRemoteLink({dataDir:join(x.dir,'node'),getState:()=>state,request:async(method,path,body)=>{
      calls.push({method,path,body});state.inbox.items[0].state='resolved';state.inbox.items[0].itemRevision=2;
      return {taskId:'t1',status:'completed',itemId:'i1',itemRevision:2,private:'must not be sent'};
    }});
    assert.equal((await link.configure({url:x.hub.url,pairingCode:code,projectIds:['p1','p2']})).status,'connected');
    const controller=await x.pair('controller',['p1']);const requested=command();
    await x.call('POST','/api/commands',requested,controller.token);await link.sync();await link.sync();
    assert.equal(calls.length,1);assert.equal(calls[0].path,'/api/tasks/t1/inbox/i1/actions');assert.equal(calls[0].body.actionId,'answer');
    assert.equal(calls[0].body.remoteActor.subjectId,controller.subjectId);
    const receipt=await x.call('GET','/api/commands/answer',undefined,controller.token);
    assert.equal(receipt.status,'completed');assert.equal(receipt.result.itemRevision,2);assert.equal(receipt.result.private,undefined);
    assert.equal((await x.call('POST','/api/commands',requested,controller.token)).status,'completed');
    state.capabilities.inbox=false;await link.sync();
    assert.equal((await x.call('POST','/api/commands',command('old-node'),controller.token,409)).code,'NODE_UPDATE_REQUIRED');
  }finally{await link?.close();await x.close();}
});

test('unknown Hub outcomes appear as read-only, scoped cards and cannot be resolved or resent through inbox',async()=>{
  let clock=Date.now();const x=await fixture(()=>clock);
  try{
    const node=await x.pair('node'),controller=await x.pair('controller',['p1']),unrelated=await x.pair('viewer',['p2']);
    await x.call('POST','/api/node/snapshot',{...board(),epoch:1,sequence:1},node.token);
    await x.call('POST','/api/commands',command(),controller.token);
    await x.call('POST','/api/node/commands/answer/claim',{},node.token);
    clock+=301000;
    const state=await x.call('GET','/api/state',undefined,controller.token);
    const unknown=state.inbox.items.find(i=>i.source.type==='hub.command');
    assert.equal(unknown.readOnly,true);assert.equal(unknown.kind,'unknown');assert.equal(unknown.source.id,'answer');
    assert.equal(JSON.stringify(state).includes('optionId'),false);
    assert.equal((await x.call('GET','/api/inbox',undefined,unrelated.token)).items.some(i=>i.kind==='unknown'),false);
    await x.call('POST','/api/node/snapshot',{...board(),epoch:1,sequence:2},node.token);
    await x.call('POST','/api/commands',command('resolve',{itemId:unknown.id,expectedItemRevision:1,action:'answer',answer:'done'},clock),controller.token,404);
  }finally{await x.close();}
});

test('real Core and Hub roundtrip preserves human answer and rejects stale competing decisions without double effects',async()=>{
  const {createCore}=await import('../server/core.mjs');
  const x=await fixture();let core;
  try{
    core=await createCore({dataDir:join(x.dir,'core'),pluginDir:join(x.dir,'no-plugins'),files:false});
    const p=core.store.project({name:'Inbox integration'}),t=core.store.createTask({projectId:p.id,title:'Storage',criteria:['persists']});
    const i=await core.request('POST',`/api/tasks/${t.id}/decisions`,{expectedRevision:1,requestId:'pick',title:'选择存储',summary:'需要保存数据',impact:'等待确认',shareWithRemote:true,options:[{id:'sqlite',label:'SQLite',consequence:'本地保存'}]},'reporter');
    const {code}=await x.call('POST','/api/admin/pairings',{role:'node',projectIds:[p.id]},x.owner);
    assert.equal((await core.remote.configure({url:x.hub.url,pairingCode:code,projectIds:[p.id]})).status,'connected');
    const controller=await x.pair('controller',[p.id]);
    const input={commandId:'core-answer',projectId:p.id,taskId:t.id,action:'inbox_action',expectedRevision:1,expiresAt:new Date(Date.now()+60000).toISOString(),body:{itemId:i.id,expectedItemRevision:1,action:'answer',optionId:'sqlite'}};
    await x.call('POST','/api/commands',input,controller.token);await core.remote.sync();await core.remote.sync();
    const receipt=await x.call('GET','/api/commands/core-answer',undefined,controller.token);
    assert.equal(receipt.status,'completed',JSON.stringify(receipt));
    assert.equal(core.store.getTask(t.id).decisions.length,1);assert.equal(core.store.getTask(t.id).nextStep,'SQLite');
    assert.equal(core.store.getTask(t.id).acceptance,'unverified');
    assert.equal(core.inbox.state().items.find(value=>value.id===i.id).state,'resolved');
    assert.equal((await x.call('POST','/api/commands',input,controller.token)).status,'completed');
    await x.call('POST','/api/commands',{...input,commandId:'competing-answer'},controller.token,409);
    assert.equal(core.store.getTask(t.id).decisions.length,1);
    assert.match(core.store.context(p.id),/SQLite/);
  }finally{await core?.close();await x.close();}
});

test('large inbox history is transport-bounded with explicit project-scoped omissions; local data unchanged',async()=>{
  const {budgetInboxSnapshot}=await import('../server/hub/projection.mjs');
  const input=board();input.inbox.items=[];
  for(let n=0;n<205;n++)input.inbox.items.push({...item(`large-${n}`),summary:'s'.repeat(5000),impact:'i'.repeat(5000),state:n<5?'open':'resolved'});
  const before=JSON.stringify(input);const projected=budgetInboxSnapshot(sanitizeSnapshot(input));
  assert.ok(Buffer.byteLength(JSON.stringify(projected))<1800000);
  assert.equal(projected.inbox.items.filter(i=>i.state==='open').length,5);
  assert.ok(projected.inbox.omitted[0].history>0);assert.equal(projected.inbox.omitted[0].open,0);
  assert.equal(JSON.stringify(input),before);
  const x=await fixture();try{
    const node=await x.pair('node');await x.call('POST','/api/node/snapshot',{...projected,epoch:1,sequence:1},node.token);
    const viewer=await x.pair('viewer',['p2']);assert.equal((await x.call('GET','/api/inbox',undefined,viewer.token)).omitted,undefined);
    const visible=await x.pair('viewer',['p1']);assert.ok((await x.call('GET','/api/inbox',undefined,visible.token)).omitted[0].history>0);
  }finally{await x.close();}
  const allOpen=structuredClone(input);allOpen.inbox.items.forEach(i=>i.state='open');
  assert.ok(budgetInboxSnapshot(sanitizeSnapshot(allOpen)).inbox.omitted[0].open>0,'overflowing actionable items explicitly counted');
});

test('unknown creation remains visible before a task snapshot and late inbox evidence clears only the matching outcome',async()=>{
  let clock=Date.now();const x=await fixture(()=>clock);
  try{
    const node=await x.pair('node'),controller=await x.pair('controller',['p1']);const b=board();b.capabilities.conversations=true;
    await x.call('POST','/api/node/snapshot',{...b,epoch:1,sequence:1},node.token);
    await x.call('POST','/api/conversations',{projectId:'p1',commandId:'create-lost',title:'New task',message:'Make a change'},controller.token);
    await x.call('POST','/api/node/commands/create-lost/claim',{},node.token);
    await x.call('POST','/api/commands',command('late',undefined,clock),controller.token);
    await x.call('POST','/api/node/commands/late/claim',{},node.token);
    clock+=301000;
    const unknown=(await x.call('GET','/api/inbox',undefined,controller.token)).items.filter(i=>i.kind==='unknown');
    assert.ok(unknown.some(i=>i.taskId==='create-lost'&&i.readOnly));assert.ok(unknown.some(i=>i.source.id==='late'));
    const pending=await x.call('GET','/api/node/commands',undefined,node.token);
    assert.equal(pending.commands.find(c=>c.commandId==='late').status,'unknown');
    await x.call('POST','/api/node/commands/late/receipt',{status:'completed',result:{taskId:'t1',itemId:'wrong',itemRevision:2,status:'completed'}},node.token,400);
    await x.call('POST','/api/node/commands/late/receipt',{status:'completed',result:{taskId:'t1',itemId:'i1',itemRevision:2,status:'completed'}},node.token);
    const after=(await x.call('GET','/api/inbox',undefined,controller.token)).items.filter(i=>i.kind==='unknown');
    assert.ok(after.some(i=>i.taskId==='create-lost'));assert.ok(!after.some(i=>i.source.id==='late'));
    assert.equal((await x.call('GET','/api/commands/late',undefined,controller.token)).status,'completed');
  }finally{await x.close();}
});

test('unknown local execution cards reject direct remote acknowledge and keep warning visible',async()=>{
  const x=await fixture();try{
    const node=await x.pair('node'),controller=await x.pair('controller',['p1']),b=board();b.inbox.items[0].kind='unknown';
    await x.call('POST','/api/node/snapshot',{...b,epoch:1,sequence:1},node.token);
    await x.call('POST','/api/commands',command('hide',{itemId:'i1',expectedItemRevision:1,action:'acknowledge'}),controller.token,409);
    assert.equal((await x.call('GET','/api/inbox',undefined,controller.token)).items.find(i=>i.id==='i1').state,'open');
  }finally{await x.close();}
});
