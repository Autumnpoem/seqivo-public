import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocket} from 'ws';
import {createCore} from '../server/core.mjs';
import {startHttp} from '../server/http.mjs';
import {createHub} from '../server/hub/http.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=8000){const end=Date.now()+timeout;let last;while(Date.now()<end){try{const result=await fn();if(result)return result;}catch(e){last=e;}await sleep(25);}throw last||Error('Condition timeout');}
async function socket(url,origin,cookie=''){
  const ws=new WebSocket(url,{headers:{Origin:origin,...(cookie?{Cookie:cookie}:{})}}),frames=[];
  ws.on('message',raw=>frames.push(JSON.parse(raw.toString())));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  return {ws,frames,send:frame=>ws.send(JSON.stringify({v:1,...frame})),wait:predicate=>until(()=>frames.find(predicate)).catch(error=>{throw new Error(`${error.message}; recent frames: ${JSON.stringify(frames.slice(-8).map(({type,code,phase,reason})=>({type,code,phase,reason})))}`);})};
}
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'seqivo-terminal-integration-')),workspace=join(root,'workspace');await mkdir(workspace);
  const core=await createCore({dataDir:join(root,'core'),pluginDir:join(root,'plugins'),files:false});
  const http=await startHttp({core,dataDir:join(root,'core'),distDir:root,port:0});
  const project=core.store.project({name:'Disposable terminal',directory:workspace});
  const origin=`http://127.0.0.1:${http.port}`;
  t.after(async()=>{await http.close();await core.close();await rm(root,{recursive:true,force:true});});
  await core.request('POST','/api/terminal/profiles',{id:'default',label:'Disposable',projectId:project.id,enabled:true,shell:'/bin/sh'});
  return {root,workspace,core,http,project,origin};
}

test('owner-only local transport executes real PTY input and resumes without replay',async t=>{
  const x=await fixture(t);
  for(const role of ['viewer','reporter','remote-controller'])await assert.rejects(x.core.request('GET','/api/terminal/status',{},role),{code:'TERMINAL_FORBIDDEN'});
  const ticket=await x.core.request('POST','/api/terminal/tickets',{profileId:'default'});
  const a=await socket(ticket.wsUrl,x.origin);t.after(()=>a.ws.terminate());
  a.send({type:'auth',ticket:ticket.ticket});await a.wait(f=>f.type==='authenticated');
  a.send({type:'open',mode:'shell',cols:80,rows:24});await a.wait(f=>f.code==='CONTROL_REQUIRED');
  a.send({type:'takeover'});await a.wait(f=>f.type==='control'&&f.phase==='human');
  a.send({type:'open',mode:'shell',cols:80,rows:24});const ready=await a.wait(f=>f.type==='ready');
  assert.equal(ready.lastInputSeq,-1);assert.equal(x.core.terminal.blocksProject(x.project.id),true);
  const path=join(x.workspace,'result.txt');
  a.send({type:'input',epoch:ready.epoch,seq:7,data:Buffer.from(`printf '%s' LOCAL_OK > '${path}'\r`).toString('base64')});
  await a.wait(f=>f.type==='inputAck'&&f.seq===7);await until(async()=>await readFile(path,'utf8')==='LOCAL_OK');
  a.send({type:'input',epoch:ready.epoch,seq:7,data:Buffer.from(`printf BAD >> '${path}'\r`).toString('base64')});
  await a.wait(f=>f.code==='INPUT_STALE');assert.equal(await readFile(path,'utf8'),'LOCAL_OK');
  await new Promise(resolve=>{a.ws.once('close',resolve);a.ws.close();});
  const resumed=await x.core.request('POST','/api/terminal/tickets',{profileId:'default',resumeConnectionId:ticket.connectionId});
  const b=await socket(resumed.wsUrl,x.origin);t.after(()=>b.ws.terminate());
  b.send({type:'auth',ticket:resumed.ticket});await b.wait(f=>f.type==='authenticated');
  b.send({type:'open',mode:'shell',cols:90,rows:25});const second=await b.wait(f=>f.type==='ready');
  assert.equal(second.epoch,ready.epoch);assert.equal(second.lastInputSeq,7);
  b.send({type:'input',epoch:second.epoch,seq:8,data:Buffer.from(`printf '%s' ' 中文✓' >> '${path}'\r`).toString('base64')});
  await b.wait(f=>f.type==='inputAck'&&f.seq===8);await until(async()=>await readFile(path,'utf8')==='LOCAL_OK 中文✓');
  b.send({type:'open',redraw:true,mode:'shell',cols:90,rows:25});await b.wait(f=>f.code==='OUTPUT_GAP');
  b.send({type:'open',acceptGap:true,mode:'shell',cols:90,rows:25});const redrawn=await b.wait(f=>f.type==='ready'&&f.epoch>second.epoch);assert.equal(redrawn.lastInputSeq,-1);
  assert.equal(await readFile(path,'utf8'),'LOCAL_OK 中文✓');
  const task=x.core.store.createTask({projectId:x.project.id,title:'Return review remains fenced'});
  assert.equal(x.core.leases.available({taskId:task.id}),false);
  b.send({type:'return',notes:'已在测试终端增加中文结果。'});
  const review=await b.wait(f=>f.type==='control'&&f.phase==='return_review');
  assert.equal(x.core.leases.available({taskId:task.id}),false,'return review does not release the workspace fence');
  assert.equal(b.frames.filter(f=>f.type==='control').at(-1).phase,'return_review',
    'human return cannot advance to ai_ready before explicit confirmation');
  b.send({type:'return-confirm',reviewId:review.returnReview.reviewId,expectedGeneration:review.generation});
  const returned=await b.wait(f=>f.type==='control'&&f.phase==='ai_ready'&&f.changes?.some(item=>item.path==='result.txt'));
  assert.equal(x.core.leases.available({taskId:task.id}),true,'the proved and confirmed return releases the fence');
  assert.equal(returned.changes[0].kind,'added');
  b.send({type:'detach'});await until(()=>!x.core.terminal.hasConnections());
});

test('local socket refuses hostile Origin, reused tickets and pending auth is closed at shutdown',async t=>{
  const x=await fixture(t),ticket=await x.core.request('POST','/api/terminal/tickets',{profileId:'default'});
  await assert.rejects(startHttp({core:x.core,dataDir:x.root,distDir:x.root,host:'0.0.0.0',port:0}),/仅允许回环/);
  await assert.rejects(x.core.request('POST','/api/terminal/profiles',{id:'shared',label:'Shared',cwd:x.workspace,enabled:true,serverName:'default'}),{code:'SHARED_SERVER_CONFIRMATION'});
  await x.core.request('POST','/api/terminal/profiles',{id:'separate',label:'Separate',projectId:x.project.id,enabled:true});
  const status=await x.core.request('GET','/api/terminal/status');assert.notEqual(status.profiles[0].serverName,status.profiles[1].serverName);
  await assert.rejects(socket(ticket.wsUrl,'https://untrusted.example'));
  const a=await socket(ticket.wsUrl,x.origin),b=await socket(ticket.wsUrl,x.origin);t.after(()=>{a.ws.terminate();b.ws.terminate();});
  a.send({type:'auth',ticket:ticket.ticket});await a.wait(f=>f.type==='authenticated');
  b.send({type:'auth',ticket:ticket.ticket});await b.wait(f=>f.type==='error');
  const pending=await socket(ticket.wsUrl,x.origin);t.after(()=>pending.ws.terminate());
  await x.http.close();await until(()=>pending.ws.readyState===WebSocket.CLOSED);
});

test('real Hub-to-node relay reaches PTY, enforces local grants and revokes an active device',async t=>{
  const x=await fixture(t),hub=await createHub({dataDir:join(x.root,'hub'),port:0});t.after(()=>hub.close());
  const slowTmux=join(x.root,'slow-test-tmux'),listStarted=join(x.root,'list-started');
  await writeFile(slowTmux,`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('-V')){console.log('tmux test-fixture');}else{fs.writeFileSync(${JSON.stringify(listStarted)},'started');setTimeout(()=>{process.stderr.write('no server running');process.exit(1);},500);}\n`);
  await chmod(slowTmux,0o700);
  await x.core.request('POST','/api/terminal/profiles',{id:'default',label:'Disposable',projectId:x.project.id,enabled:true,shell:'/bin/sh',tmuxExecutable:slowTmux});
  const account=await hub.accounts.register({username:'terminal_real',password:'LocalTest-password-239',source:'isolated'});
  const accountCookie=`hub_session=${account.sessionToken}`;
  const call=async(method,path,body,cookie=accountCookie)=>{
    const response=await fetch(hub.url+path,{method,headers:{Origin:hub.url,Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  await x.core.remote.login({url:hub.url,username:'terminal_real',password:'LocalTest-password-239',projectIds:[x.project.id]});
  await until(async()=>(await x.core.request('GET','/api/terminal/status')).link.status==='online');
  const nodeId=x.core.remote.state().nodeId;
  const enrollment=await call('POST','/api/terminal/devices',{label:'Isolated browser'});assert.equal(enrollment.status,200);
  const cookie=accountCookie+'; '+enrollment.cookie;
  assert.equal((await call('POST','/api/terminal/tickets',{nodeId,profileId:'default',scope:'control'},cookie)).status,403);
  await x.core.request('POST','/api/terminal/grants',{deviceId:enrollment.data.deviceId,profileId:'default',scopes:['view','input','create','default','takeover'],confirmationCode:enrollment.data.confirmationCode});
  const ticket=await call('POST','/api/terminal/tickets',{nodeId,profileId:'default',scope:'control'},cookie);assert.equal(ticket.status,200);
  const browser=await socket(hub.url.replace(/^http/,'ws')+'/api/terminal/ws',hub.url,cookie);t.after(()=>browser.ws.terminate());
  browser.send({type:'auth',ticket:ticket.data.ticket});await browser.wait(f=>f.type==='authenticated');
  browser.send({type:'open',mode:'shell',cols:80,rows:24});await browser.wait(f=>f.code==='CONTROL_REQUIRED');
  browser.send({type:'takeover'});await browser.wait(f=>f.type==='control'&&f.phase==='human');
  browser.send({type:'open',mode:'shell',cols:80,rows:24});const ready=await browser.wait(f=>f.type==='ready');
  const path=join(x.workspace,'remote.txt');browser.send({type:'input',epoch:ready.epoch,seq:1,data:Buffer.from(`printf REMOTE_OK > '${path}'\r`).toString('base64')});
  await browser.wait(f=>f.type==='inputAck');await until(async()=>await readFile(path,'utf8')==='REMOTE_OK');
  await rm(listStarted,{force:true});
  for(let n=0;n<24;n++)browser.send({type:'list',requestId:`queued-${n}`});
  await until(async()=>await readFile(listStarted,'utf8').catch(()=>'')==='started');
  const revokeStarted=Date.now();
  await x.core.request('DELETE',`/api/terminal/grants/${enrollment.data.deviceId}/default`);
  assert.ok(Date.now()-revokeStarted<2000,'revocation must bypass the backlog of 24 slow listing calls');
  await until(()=>browser.ws.readyState===WebSocket.CLOSED);
  assert.equal((await call('POST','/api/terminal/tickets',{nodeId,profileId:'default',scope:'control'},cookie)).status,403);
  assert.equal(await readFile(path,'utf8'),'REMOTE_OK');
  const task=x.core.store.createTask({projectId:x.project.id,title:'Execution remains fenced after revocation'});
  assert.equal(x.core.leases.available({taskId:task.id}),false,'revoking a device is not proof that human control was returned');
  const localTicket=await x.core.request('POST','/api/terminal/tickets',{profileId:'default'});
  const local=await socket(localTicket.wsUrl,x.origin);t.after(()=>local.ws.terminate());
  local.send({type:'auth',ticket:localTicket.ticket});await local.wait(f=>f.type==='authenticated');
  local.send({type:'open',mode:'shell',cols:80,rows:24});await local.wait(f=>f.code==='CONTROL_REQUIRED');
  assert.ok(local.frames.some(f=>f.type==='control'&&f.phase==='human'&&!f.owned));
  local.send({type:'reconcile-control',action:'acquire'});await local.wait(f=>f.type==='control'&&f.phase==='human'&&f.owned);
  local.send({type:'return',notes:'Recovered revoked disposable device locally.'});
  const review=await local.wait(f=>f.type==='control'&&f.phase==='return_review');
  assert.equal(x.core.leases.available({taskId:task.id}),false,'return review remains fenced until explicitly confirmed');
  assert.equal(local.frames.filter(f=>f.type==='control').at(-1).phase,'return_review',
    'the owner confirmation is required before ai_ready');
  local.send({type:'return-confirm',reviewId:review.returnReview.reviewId,expectedGeneration:review.generation});
  const returned=await local.wait(f=>f.type==='control'&&f.phase==='ai_ready');
  assert.ok(returned.changes.some(item=>item.path==='remote.txt'),'recovery retains the original pre-human file baseline');
  assert.equal(x.core.leases.available({taskId:task.id}),true);
});

test('independent Core instances do not share an implicit tmux server',async t=>{
  const a=await fixture(t),b=await fixture(t);
  const [first,second]=await Promise.all([a.core.request('GET','/api/terminal/status'),b.core.request('GET','/api/terminal/status')]);
  assert.notEqual(first.profiles[0].serverName,second.profiles[0].serverName);
});
