import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';

async function fixture(targetOverrides={}){
  const source=(await readFile(new URL('../src/terminal-client.ts',import.meta.url),'utf8')).replace(
    "import {ApiError,request} from './api';",
    'class ApiError extends Error {}\nconst request=async()=>{throw Error("network disabled")};');
  const compiled=stripTypeScriptTypes(source,{mode:'transform'});
  const {TerminalClient}=await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
  const sent=[],controls=[],notices=[],states=[];
  class Socket{static OPEN=1;readyState=1;send(raw){sent.push(JSON.parse(raw));}close(){this.readyState=3;}}
  globalThis.WebSocket=Socket;
  globalThis.window={setTimeout,clearTimeout,location:{href:'http://localhost/'}};
  const callbacks=new Proxy({onControl:value=>controls.push(value),onNotice:value=>notices.push(value),onState:(state,message)=>states.push({state,message})},
    {get:(target,key)=>target[key]||(()=>{})});
  const client=new TerminalClient({profileId:'p',mode:'tmux',readOnly:false,ticketControl:true,inputAllowed:true,takeoverAllowed:true,projectId:'project',...targetOverrides},callbacks,()=>({cols:80,rows:24}));
  client.ws=new Socket();client.connectionId='connection-a';client.state='ready';client.epoch=1;
  const control=(phase,generation,extra={})=>client.receive(JSON.stringify({type:'control',v:1,phase,managed:true,owned:phase==='human'||phase==='return_review',mode:'managed',generation,authorizedSessionRefs:[],...extra}));
  control('human',7);
  return {client,sent,controls,notices,states,control};
}
const ref={serverName:'test',instanceId:'a'.repeat(64),sessionId:'$1'};
function review(generation=7){return {reviewId:'a'.repeat(64),expiresAt:Date.now()+60000,generation,
  workspaceRelativeDirectories:[{sessionRef:ref,path:'.'}],changes:[{path:'src/file.txt',kind:'modified'}],
  totalChanges:1,omittedChanges:0,snapshotScope:'git-tracked-and-nonignored-untracked',parkedManagedSessions:1,unownedWorkspaceWriters:0,notes:'待验收'};}

test('prepare freezes input, exact review requires explicit confirmation and old human/ready cannot unlock',async()=>{
  const {client,sent,controls,control}=await fixture();
  assert.equal(client.returnControl('待验收'),true);
  assert.equal(sent.at(-1).type,'return-prepare');assert.equal(client.canInput,false);
  assert.equal(client.input('old'),false);
  control('human',7);assert.equal(client.canInput,false);
  control('return_check',7,{owned:false});
  control('return_review',7,{returnReview:review()});
  assert.equal(client.canConfirmReturn,true);
  assert.equal(controls.at(-1).returnReview.reviewId,'a'.repeat(64));
  assert.equal(client.confirmReturn(),true);
  assert.deepEqual(sent.at(-1),{v:1,type:'return-confirm',reviewId:'a'.repeat(64),expectedGeneration:7});
  assert.equal(client.canInput,false);
  control('return_review',7,{returnReview:review()});assert.equal(client.canInput,false);
  control('ai_ready',7,{owned:false});
  assert.equal(controls.at(-1).returnReview,null);
  assert.equal(client.canInput,false);
  assert.equal(sent.some(item=>item.type==='input'),false);
});

test('already expired review can only cancel; malformed review cannot confirm; offline clears review without auto retry',async()=>{
  const {client,control,controls,sent}=await fixture();
  assert.equal(client.returnControl(''),true);
  control('return_review',7,{returnReview:{...review(),expiresAt:Date.now()-1}});
  assert.equal(client.canConfirmReturn,false);
  assert.equal(client.canCancelReturn,true);
  assert.equal(controls.at(-1).phase,'return_review');
  assert.equal(sent.some(item=>item.type==='return-confirm'),false);
  assert.equal(client.cancelReturn(),true);
  assert.equal(sent.at(-1).type,'return-cancel');
  const invalid=await fixture();
  invalid.client.returnControl('');
  invalid.control('return_review',7,{returnReview:{...review(),changes:[{path:'../outside',kind:'modified'}]}});
  assert.equal(invalid.controls.at(-1).phase,'unknown');
  assert.equal(invalid.client.canCancelReturn,false);
  const next=await fixture();
  next.client.returnControl('');next.control('return_review',7,{returnReview:review()});
  next.client.pauseForOffline();
  assert.equal(next.controls.at(-1).returnReview,null);
  assert.equal(next.client.canConfirmReturn,false);
  assert.equal(next.client.connectionId,null);
  assert.equal(next.client.canInput,false);
});

test('cancel keeps input fenced; formal owner release accepts only echoed newer review',async()=>{
  const first=await fixture();
  first.client.returnControl('');first.control('return_review',7,{returnReview:review()});
  assert.equal(first.client.cancelReturn(),true);
  assert.deepEqual(first.sent.at(-1),{v:1,type:'return-cancel',reviewId:'a'.repeat(64),expectedGeneration:7});
  first.control('unknown',7,{owned:false});assert.equal(first.client.canInput,false);
  const second=await fixture();
  second.control('unknown',7,{owned:true});
  assert.equal(second.client.reconcileControl('release'),true);
  const request=second.sent.at(-1);
  second.control('return_review',8,{returnReview:review(8),requestId:'wrong'});
  assert.equal(second.client.canConfirmReturn,false);
  second.control('return_review',8,{returnReview:review(8),requestId:request.requestId});
  assert.equal(second.client.canConfirmReturn,true);
  assert.equal(second.client.canInput,false);
});

test('readonly, missing takeover scope, and retired socket never confirm a review',async()=>{
  for(const target of [{readOnly:true},{takeoverAllowed:false},{inputAllowed:false}]){
    const {client,sent}=await fixture(target);
    assert.equal(client.returnControl(''),false);
    assert.equal(sent.some(frame=>frame.type==='return-prepare'),false);
  }
  const {client,control,sent}=await fixture();
  assert.equal(client.returnControl(''),true);
  client.generation++;
  control('return_review',7,{returnReview:review()});
  assert.equal(client.canConfirmReturn,false);
  assert.equal(client.confirmReturn(),false);
  assert.equal(sent.some(frame=>frame.type==='return-confirm'),false);
});
