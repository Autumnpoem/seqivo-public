import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {accessSync,constants,realpathSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WebSocket} from 'ws';
import {createCore} from '../server/core.mjs';
import {createHub} from '../server/hub/http.mjs';

const tmux=process.env.TMUX_TEST_EXECUTABLE||resolve('.tools/terminal-build/install/bin/tmux');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=8000){
  const deadline=Date.now()+timeout;let last;
  while(Date.now()<deadline){try{const result=await fn();if(result)return result;}catch(error){last=error;}await sleep(25);}
  throw last||new Error('Condition timeout');
}
async function browserSocket(url,origin,cookie,ticket){
  const ws=new WebSocket(url,{headers:{Origin:origin,Cookie:cookie}}),frames=[];
  ws.on('message',raw=>frames.push(JSON.parse(raw.toString())));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const client={ws,frames,send:frame=>ws.send(JSON.stringify({v:1,...frame})),
    wait:predicate=>until(()=>frames.find(predicate)).catch(error=>{throw new Error(`${error.message}; frames=${JSON.stringify(frames.slice(-8))}`);})};
  client.send({type:'auth',ticket});await client.wait(frame=>frame.type==='authenticated');
  return client;
}

test('real Hub/Core/tmux failed switch still confirms correlated detach and permits immediate same-device reconnect',async t=>{
  if(process.platform!=='darwin'){t.skip('macOS tmux process proof required');return;}
  try{accessSync(tmux,constants.X_OK);}catch{t.skip('real tmux unavailable');return;}
  const root=await mkdtemp(join(tmpdir(),'terminal-detach-live-'));
  const workspace=join(root,'workspace');await mkdir(workspace);
  const serverName=`seqivo-detach-live-${process.pid}-${randomBytes(4).toString('hex')}`;
  const run=(...args)=>execFileSync(tmux,['-L',serverName,...args],{encoding:'utf8',timeout:5000,stdio:['ignore','pipe','ignore']});
  let core,hub;
  t.after(async()=>{
    await core?.close();await hub?.close();
    try{run('kill-server');}catch{/* Already stopped. */}
    await rm(root,{recursive:true,force:true});
  });
  core=await createCore({dataDir:join(root,'core'),pluginDir:join(root,'plugins'),files:false});
  const project=core.store.project({name:'Disposable detach proof',directory:workspace});
  await core.request('POST','/api/terminal/profiles',{id:'default',label:'Disposable',projectId:project.id,enabled:true,
    serverName,allowSharedServer:true,tmuxExecutable:tmux});
  const otherWorkspace=join(root,'other');await mkdir(otherWorkspace);
  core.store.project({name:'Other managed project',directory:otherWorkspace});
  hub=await createHub({dataDir:join(root,'hub'),port:0});
  const account=await hub.accounts.register({username:`detach_live_${randomBytes(4).toString('hex')}`,
    password:'LocalTest-password-239',source:'isolated'});
  const accountCookie=`hub_session=${account.sessionToken}`;
  const call=async(method,path,body,cookie=accountCookie)=>{
    const response=await fetch(hub.url+path,{method,headers:{Origin:hub.url,Cookie:cookie,
      ...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  await core.remote.login({url:hub.url,username:account.user.username,password:'LocalTest-password-239',projectIds:[project.id]});
  await until(async()=>(await core.request('GET','/api/terminal/status')).link.status==='online');
  const nodeId=core.remote.state().nodeId;
  const enrollment=await call('POST','/api/terminal/devices',{label:'Disposable browser'});
  assert.equal(enrollment.status,200);
  const cookie=`${accountCookie}; ${enrollment.cookie}`;
  await core.request('POST','/api/terminal/grants',{deviceId:enrollment.data.deviceId,profileId:'default',
    scopes:['view','input','create','default','takeover'],confirmationCode:enrollment.data.confirmationCode});
  const ticket=await call('POST','/api/terminal/tickets',{nodeId,profileId:'default',scope:'control'},cookie);
  assert.equal(ticket.status,200);
  const wsUrl=hub.url.replace(/^http/,'ws')+'/api/terminal/ws';
  const first=await browserSocket(wsUrl,hub.url,cookie,ticket.data.ticket);
  t.after(()=>first.ws.terminate());
  first.send({type:'open',mode:'tmux',cols:80,rows:24});
  const initial=await first.wait(frame=>frame.type==='sessions');
  first.send({type:'takeover'});
  await first.wait(frame=>frame.type==='control'&&frame.phase==='human'&&frame.owned);
  first.send({type:'create',epoch:0,name:'A'});
  const aReady=await first.wait(frame=>frame.type==='ready'&&frame.sessionRef);
  const a=aReady.sessionRef;
  const originalPanePid=run('display-message','-p','-t',a.sessionId,'#{pane_pid}').trim();
  assert.match(originalPanePid,/^[1-9]\d*$/);
  first.send({type:'default',sessionRef:a,expectedRevision:initial.defaultRevision});
  await first.wait(frame=>frame.type==='sessions'&&frame.defaultRevision===initial.defaultRevision+1);
  first.send({type:'create',epoch:aReady.epoch,name:'B'});
  const bReady=await first.wait(frame=>frame.type==='ready'&&frame.epoch>aReady.epoch);
  const b=bReady.sessionRef;
  first.send({type:'select',epoch:bReady.epoch,sessionRef:a,requestId:'select-a'});
  const ready=await first.wait(frame=>frame.type==='ready'&&frame.epoch>bReady.epoch&&frame.sessionRef?.sessionId===a.sessionId);
  // A verified B temporarily enters another managed project. The failed
  // switch must advance the epoch without granting input or replacing A.
  run('send-keys','-t',b.sessionId,`cd '${otherWorkspace}'`,'Enter');
  await until(()=>realpathSync(run('display-message','-p','-t',b.sessionId,'#{pane_current_path}').trim())===realpathSync(otherWorkspace));
  first.send({type:'select',epoch:ready.epoch,sessionRef:b,requestId:'select-now-missing-b'});
  const failed=await first.wait(frame=>frame.type==='error'&&frame.code==='PROCESS_PROOF_UNAVAILABLE');
  assert.equal(failed.code,'PROCESS_PROOF_UNAVAILABLE','the real manager advances attachment epoch before failed process proof');
  assert.equal(first.frames.some(frame=>frame.type==='ready'&&frame.epoch>ready.epoch),false,'failed switch emits no new ready');
  run('send-keys','-t',b.sessionId,`cd '${workspace}'`,'Enter');
  await until(()=>realpathSync(run('display-message','-p','-t',b.sessionId,'#{pane_current_path}').trim())===realpathSync(workspace));
  const requestId='detach-after-real-failed-switch';
  const closed=new Promise(resolve=>first.ws.once('close',resolve));
  first.send({type:'detach',epoch:ready.epoch,requestId});
  const ack=await first.wait(frame=>frame.type==='exit'&&frame.reason==='detached'&&frame.requestId===requestId);
  assert.equal(ack.epoch,ready.epoch+1,'ACK uses the manager epoch despite no ready frame');
  assert.equal(await closed,1000,'Hub closes the explicitly detached browser without a resumable attachment');
  await until(()=>!core.terminal.hasConnections());
  const replacement=await call('POST','/api/terminal/tickets',{nodeId,profileId:'default',scope:'control'},cookie);
  assert.equal(replacement.status,200);
  const second=await browserSocket(wsUrl,hub.url,cookie,replacement.data.ticket);
  t.after(()=>second.ws.terminate());
  second.send({type:'open',mode:'tmux',cols:80,rows:24});
  await second.wait(frame=>frame.type==='control'&&frame.phase==='human'&&frame.owned);
  const recovered=await second.wait(frame=>frame.type==='ready'&&frame.sessionRef?.sessionId===a.sessionId);
  assert.ok(recovered.epoch>=1,'same device reclaims original live tmux A after confirmed retirement');
  assert.equal(run('display-message','-p','-t',a.sessionId,'#{pane_pid}').trim(),originalPanePid,
    'recovery attaches to the original pane instead of replacing the CLI');
  const marker=join(workspace,'recovered.txt');
  second.send({type:'input',epoch:recovered.epoch,seq:1,
    data:Buffer.from(`printf RECOVERED > '${marker}'\r`).toString('base64')});
  await second.wait(frame=>frame.type==='inputAck'&&frame.seq===1);
  await until(async()=>await readFile(marker,'utf8').catch(()=>'')==='RECOVERED');
  const recoveredSessions=await second.wait(frame=>frame.type==='sessions'&&frame.items?.some(item=>item.name==='A'));
  assert.equal(recoveredSessions.items.some(item=>item.name==='B'),true,'the temporary B remains available without replacing default A');
});
