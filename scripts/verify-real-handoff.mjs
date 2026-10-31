// Explicit opt-in. Two real Codex turns and one manual PTY edit in a new scratch project.
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WebSocket} from 'ws';
import {createCore} from '../server/core.mjs';
import {startHttp} from '../server/http.mjs';

if(process.env.SEQIVO_REAL_HANDOFF_TEST!=='1')throw Error('Set SEQIVO_REAL_HANDOFF_TEST=1 to run two isolated real Codex turns');
const codexPath=process.env.SEQIVO_TEST_CODEX,pythonPath=process.env.SEQIVO_TEST_PYTHON;
if(!codexPath||!pythonPath)throw Error('Provide Codex and Python executable paths, never credentials');
const root=await realpath(await mkdtemp(join(tmpdir(),'seqivo-real-handoff-'))),workspace=join(root,'project');
const qa=resolve(process.env.QA_DIR||'design/qa/terminal-real-handoff');await mkdir(qa,{recursive:true});await mkdir(workspace);
const evidence={startedAt:new Date().toISOString(),realProvider:true,physicalPhone:false,checks:[],passed:false};
let core,http,ws,clean=false,taskId,commandId,executionCommandId,nextConversationRead=0,phase='first-turn';
const safeText=value=>String(value||'').replace(/https?:\/\/[^\s]+/g,'[endpoint]').replaceAll(root,'[fixture]').slice(0,1000);
const safeError=(error,depth=0)=>({message:safeText(error?.message||error),...(error?.code?{code:String(error.code)}:{}),
  ...(depth<3&&Array.isArray(error?.errors)?{causes:error.errors.slice(0,8).map(child=>safeError(child,depth+1))}:{})});
async function until(check,label,ms=120000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,100));}throw Error(label);}
try{
  core=await createCore({dataDir:join(root,'data'),pluginDir:resolve('plugins'),files:false});
  await core.plugin.configure({codexPath,pythonPath});
  // Retain the provider error before the conversation API deliberately maps an
  // ambiguous exception to "unknown". Only this isolated test proxy is wrapped.
  for(const method of ['createSession','resume']){
    const original=core.plugin[method].bind(core.plugin);
    core.plugin[method]=async input=>{try{return await original(input);}catch(error){
      evidence.providerFailure={operation:method,code:error.code||null,message:safeText(error.message)};
      throw error;
    }};
  }
  http=await startHttp({core,dataDir:join(root,'data'),distDir:resolve('dist'),port:0});
  const project=core.store.project({name:'真实交还验收（可丢弃）',directory:workspace});
  commandId=randomUUID();
  const first=await core.request('POST','/api/conversations',{projectId:project.id,title:'只验证临时文件交还',commandId,
    message:'这是隔离验收。仅在当前项目创建 state.txt，写入一行 before。不改其他文件，不联网，不委派 Agent。完成后回复 HANDOFF_FIRST_OK。'});
  taskId=first.taskId;evidence.firstCommandStatus=first.status;
  executionCommandId=`${commandId}:turn`;
  if(!['running','completed','submitted'].includes(first.status))throw Error(`First real command returned ${first.status}`);
  const complete=async()=>{
    const task=core.store.getTask(first.taskId);
    if(Date.now()>=nextConversationRead&&task.status!=='submitted'){
      nextConversationRead=Date.now()+10000;
      const conversation=await core.plugin.conversation({taskId}).catch(error=>({error:safeText(error.message),messages:[]}));
      evidence.conversation={status:conversation.status,error:conversation.error,messages:conversation.messages?.slice(-4).map(x=>({role:x.role,text:safeText(x.text)}))};
      await writeFile(join(qa,'progress.json'),JSON.stringify({phase,taskStatus:task.status,...evidence.conversation},null,2),{mode:0o600});
      console.log(JSON.stringify({phase,taskStatus:task.status,conversationStatus:conversation.status,messages:conversation.messages?.length||0}));
    }
    if(['blocked','failed'].includes(task.status))throw Error(`Real Codex ended in ${task.status}: ${safeText(task.blockedReason)}`);
    return task.status==='submitted';
  };
  await until(complete,'First real turn did not complete',240000);
  assert.equal((await readFile(join(workspace,'state.txt'),'utf8')).trim(),'before');
  await until(()=>core.leases.state().active.length===0,'First turn lease was not reconciled');
  evidence.firstTurnFinal={taskStatus:core.store.getTask(taskId).status,executionStatus:(await core.plugin.getExecution({taskId,commandId:executionCommandId}))?.status};
  evidence.checks.push('real Codex created scratch file and completed its tracked turn');
  await core.request('POST','/api/terminal/profiles',{id:'default',label:'隔离 Shell',projectId:project.id,enabled:true,shell:'/bin/sh'});
  const ticket=await core.request('POST','/api/terminal/tickets',{profileId:'default'}),frames=[];
  ws=new WebSocket(ticket.wsUrl,{headers:{Origin:`http://127.0.0.1:${http.port}`}});
  ws.on('message',data=>frames.push(JSON.parse(data.toString())));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  const send=frame=>ws.send(JSON.stringify({v:1,...frame}));
  const frame=async(predicate,label)=>{
    await until(()=>frames.some(predicate),label,15000);
    const index=frames.findIndex(predicate);
    // Consume earlier state too: an initial ai_ready frame is not proof that
    // the later human return completed.
    return frames.splice(0,index+1).at(-1);
  };
  send({type:'auth',ticket:ticket.ticket});await frame(x=>x.type==='authenticated','Terminal auth failed');
  send({type:'open',mode:'shell',cols:80,rows:24});await frame(x=>x.code==='CONTROL_REQUIRED','Input was not fenced');
  send({type:'takeover'});await frame(x=>x.type==='control'&&x.phase==='human'&&x.owned,'Real provider process stop was not verified');
  send({type:'open',mode:'shell',cols:80,rows:24});const ready=await frame(x=>x.type==='ready','Shell did not start');
  const human=`human-${randomBytes(6).toString('hex')}`;
  send({type:'input',epoch:ready.epoch,seq:1,data:Buffer.from(`printf '\\n%s\\n' '${human}' >> state.txt\r`).toString('base64')});
  await until(async()=>(await readFile(join(workspace,'state.txt'),'utf8')).includes(human),'Manual PTY edit missing',5000);
  send({type:'return',notes:'人工修改了 state.txt。请先重读当前内容，再继续追加，保留人工修改。'});
  const returned=await frame(x=>x.type==='control'&&x.phase==='ai_ready','Human return was not verified');
  assert.ok(returned.changes.some(item=>item.path==='state.txt'));
  assert.match(core.store.context(project.id),/Human terminal handoff/);
  evidence.checks.push('verified provider stop, real manual PTY edit, returned change evidence and project handoff context');
  const task=core.store.getTask(first.taskId);
  phase='second-turn';nextConversationRead=0;executionCommandId=randomUUID();
  const second=await core.request('POST',`/api/tasks/${task.id}/message`,{expectedRevision:task.revision,commandId:executionCommandId,
    message:'继续隔离验收：先检查人工交还的现场，仅在 state.txt 已有内容末尾增加一行 after；保留之前所有内容，不改其他文件，不联网，不委派 Agent。完成后回复 HANDOFF_SECOND_OK。'});
  evidence.secondCommandStatus=second.status;
  if(!['running','completed','submitted'].includes(second.status))throw Error(`Second real command returned ${second.status}`);
  await until(complete,'Second real turn did not complete',240000);
  const final=await readFile(join(workspace,'state.txt'),'utf8');assert.match(final,/after\s*$/);assert.ok(final.includes('before'));assert.ok(final.includes(human));
  evidence.secondTurnFinal={taskStatus:core.store.getTask(taskId).status,executionStatus:(await core.plugin.getExecution({taskId,commandId:executionCommandId}))?.status};
  assert.notEqual(core.store.getTask(task.id).acceptance,'passed');
  evidence.checks.push('same real Codex conversation continued after handoff, preserved human edit, acceptance remained unverified');
  evidence.functionalChecksPassed=true;
}catch(error){
  evidence.error=safeText(error.message);process.exitCode=1;
  if(core){
    const task=taskId?core.store.getTask(taskId):null;
    const state=await core.plugin.state().catch(()=>null);
    const execution=taskId&&executionCommandId?await core.plugin.getExecution({taskId,commandId:executionCommandId}).catch(()=>null):null;
    const conversation=taskId?await core.plugin.conversation({taskId}).catch(error=>({error:safeText(error.message)})):null;
    evidence.diagnostics={phase,taskStatus:task?.status,blockedReason:safeText(task?.blockedReason),revision:task?.revision,conversationBound:Boolean(task?.conversationId),
      pluginStatus:state?.status,pluginError:safeText(state?.lastError),executionStatus:execution?.status,executionError:safeText(execution?.error),
      conversationError:conversation?.error,messages:conversation?.messages?.slice(-6).map(x=>({role:x.role,text:safeText(x.text)})),
      activeLeases:core.leases.state().active.map(({status})=>({status}))};
  }
}
finally{
  ws?.terminate();
  const shutdownErrors=[];
  for(const [stage,close] of [['http',()=>http?.close()],['core',()=>core?.close()]]){
    try{await close();}catch(error){shutdownErrors.push({stage,...safeError(error)});}
  }
  clean=shutdownErrors.length===0;
  if(!clean){evidence.shutdownErrors=shutdownErrors;process.exitCode=1;}
  evidence.passed=evidence.functionalChecksPassed===true&&clean;
  evidence.cleanShutdown=clean;evidence.finishedAt=new Date().toISOString();
  if(evidence.passed)await rm(root,{recursive:true,force:true});
  else await writeFile(join(qa,'fixture-location.txt'),root+'\n',{mode:0o600});
  await writeFile(join(qa,'results.json'),JSON.stringify(evidence,null,2),{mode:0o600});console.log(JSON.stringify(evidence));
}
