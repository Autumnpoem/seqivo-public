import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCore} from '../server/core.mjs';
import {createHub} from '../server/hub/http.mjs';

test('real Core and Hub start one original task through a fake plugin',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seqivo-start-task-core-'));
  const pluginDir=join(root,'plugins'),extension=join(pluginDir,'codex-autocontinue');
  await mkdir(extension,{recursive:true});
  await writeFile(join(extension,'plugin.json'),JSON.stringify({id:'codex-autocontinue',name:'Fake Codex',version:'1',
    apiVersion:1,entry:'host.mjs',permissions:['tasks.read','tasks.write','thread.create','task.resume','task.pause'],capabilities:['task.resume','task.pause']}));
  await writeFile(join(extension,'host.mjs'),`export function createPlugin(context){
    const state=()=>({enabled:true,available:true,status:'ready',policies:[]});
    return {state,enable:state,disable:state,check:state,configure:state,close:async()=>{},
      createSession:async input=>{await context.revalidateExecution({taskId:input.taskId,commandId:input.commandId,expectedRevision:input.expectedRevision});
        await context.updateTask(input.taskId,{conversationId:'fake-thread'},input.expectedRevision);
        return {taskId:input.taskId,expectedRevision:input.expectedRevision,commandId:input.commandId,status:'created',threadId:'fake-thread'};},
      resume:async input=>{await context.revalidateExecution({taskId:input.taskId,commandId:input.commandId,expectedRevision:input.expectedRevision,expectedConversationId:'fake-thread'});
        await context.updateTask(input.taskId,{status:'running'},input.expectedRevision);
        return {taskId:input.taskId,status:'running'};},
      pause:async()=>({status:'paused'}),conversation:async input=>({taskId:input.taskId,status:'running',messages:[]})};
  }`);
  const hub=await createHub({dataDir:join(root,'hub')});
  const core=await createCore({dataDir:join(root,'core'),pluginDir,files:false});
  t.after(async()=>{await core.close();await hub.close();await rm(root,{recursive:true,force:true});});
  const project=core.store.project({name:'Original project',directory:root});
  const task=core.store.createTask({projectId:project.id,title:'Original task',goal:'Keep original',criteria:['Original criterion']});
  const criterion=task.criteria[0].id;
  core.store.addEvidence(task.id,{summary:'Existing evidence',reference:'local',expectedRevision:task.revision});
  const original=core.store.getTask(task.id);
  const owner=(await readFile(hub.store.bootstrap('start-task').tokenPath,'utf8')).trim();
  const call=async(method,path,body,token=owner)=>{
    const response=await fetch(hub.url+path,{method,headers:{Authorization:`Bearer ${token}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const nodePair=await call('POST','/api/admin/pairings',{role:'node',projectIds:[project.id]});
  await core.remote.configure({url:hub.url,pairingCode:nodePair.body.code,projectIds:[project.id]});
  const pair=async role=>{const initial=await call('POST','/api/admin/pairings',{role,projectIds:[project.id]});
    return (await call('POST','/api/pairings/redeem',{code:initial.body.code})).body;};
  const controller=await pair('controller');
  const input={commandId:'start-original',projectId:project.id,taskId:task.id,action:'start_task',
    expectedRevision:original.revision,expiresAt:new Date(Date.now()+60000).toISOString(),queueOffline:false,
    body:{message:'Work on this exact task'}};
  assert.equal((await call('POST','/api/commands',input,controller.token)).status,200);
  await core.remote.sync();
  const receipt=await call('GET','/api/commands/start-original',undefined,controller.token);
  assert.equal(receipt.body.status,'running',JSON.stringify({receipt:receipt.body,
    task:((value)=>({revision:value.revision,status:value.status,conversationId:value.conversationId}))(core.store.getTask(task.id)),
    command:core.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('conversation.command.v1.start-original')?.value}));
  assert.equal(receipt.body.result.taskId,task.id);
  const tasks=core.store.tasks(project.id);
  assert.equal(tasks.length,1);
  assert.equal(tasks[0].id,task.id);
  assert.equal(tasks[0].criteria[0].id,criterion);
  assert.equal(tasks[0].evidence[0].id,original.evidence[0].id);
  assert.equal(tasks[0].conversationId,'fake-thread');
  assert.equal(tasks[0].status,'running');
  assert.equal((await call('POST','/api/commands',input,controller.token)).body.status,'running');
  assert.equal((await call('POST','/api/commands',{...input,body:{message:'Different'}},controller.token)).status,409);
});
