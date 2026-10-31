import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedPlugin } from '../server/plugin-process.mjs';

async function fixture(t,{trustedBuiltIn}) {
  const root=await mkdtemp(join(tmpdir(),'seqivo-startup-rpc-'));
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const pluginDir=join(root,'codex-autocontinue');
  await mkdir(pluginDir);
  const entry=join(pluginDir,'host.mjs');
  await writeFile(entry,`export function createPlugin(context){
    const state=()=>({enabled:true,available:true});
    return {state,configure:async input=>context[input.method](input.payload),
      enable:state,disable:state,check:state,close:async()=>{}};
  }`);
  const seen=[];
  const context=Object.fromEntries(['reserveExecutorStartup','bindExecutorStartup',
    'confirmExecutorStartup','bindExecutorConversation','verifyExecutorStartup','retireExecutorStartup'].map(method=>
    [method,async input=>{seen.push({method,input});return {verified:true};}]));
  const plugin=await createIsolatedPlugin({entry,pluginDir,dataDir:join(root,'data'),
    manifest:{id:'codex-autocontinue',name:'Built-in contract fixture',version:'1',permissions:['task.resume']},
    context,trustedBuiltIn});
  return {root,plugin,seen};
}

test('only the trusted built-in receives narrowly validated startup callbacks',async t=>{
  const x=await fixture(t,{trustedBuiltIn:true});
  const base={taskId:'task',startupId:'startup',recordId:'a'.repeat(32)};
  try {
    const reserve={taskId:'task',startupId:'startup',requestCommandId:'command',projectId:'project',
      workspace:x.root,worktreeId:null,purpose:'session',expectedRevision:1,expectedHandoffGeneration:3};
    for(const [method,payload] of [
      ['reserveExecutorStartup',reserve],['bindExecutorStartup',base],
      ['confirmExecutorStartup',base],['bindExecutorConversation',{...base,threadId:'thread-original'}],
      ['verifyExecutorStartup',{...base,workspace:x.root}],
      ['retireExecutorStartup',{...base,settledCommands:[]}]])
      assert.equal((await x.plugin.configure({method,payload})).verified,true);
    assert.equal(x.seen.length,6);
    const shutdownUnknown={version:1,taskId:'task',projectId:'project',startupId:'startup',
      recordId:base.recordId,commandId:'command',threadId:'thread',turnId:'turn',
      bridgePid:4321,workspace:x.root,worktreeId:null,expectedHandoffGeneration:null,
      recordGeneration:5,
      proofScope:'macos-original-task-job-coalition-known-descendants-and-current-writers'};
    assert.equal((await x.plugin.configure({method:'retireExecutorStartup',
      payload:{...base,settledCommands:[],shutdownUnknown}})).verified,true);
    assert.equal(x.seen.at(-1).input.shutdownUnknown.commandId,'command');
    assert.equal((await x.plugin.configure({method:'retireExecutorStartup',
      payload:{...base,settledCommands:[],shutdownUnknown:{...shutdownUnknown,
        stopCause:'provider_approval'}}})).verified,true);
    assert.equal(x.seen.at(-1).input.shutdownUnknown.stopCause,'provider_approval');
    for(const receipt of [{...shutdownUnknown,workspace:'relative'},
      {...shutdownUnknown,recordId:'../secret'},
      {...shutdownUnknown,proofScope:'untrusted'},
      {...shutdownUnknown,stopCause:'untrusted'},
      {...shutdownUnknown,rawToken:'secret'}])
      await assert.rejects(x.plugin.configure({method:'retireExecutorStartup',
        payload:{...base,settledCommands:[],shutdownUnknown:receipt}}),
      error=>error.code==='INVALID_CALLBACK');
    for(const payload of [{...base,recordId:'../secret'},
      {...base,recordId:'a'.repeat(32),unexpected:'token'}])
      await assert.rejects(x.plugin.configure({method:'bindExecutorStartup',payload}),
        error=>error.code==='INVALID_CALLBACK');
    assert.equal(x.seen.length,8);
  } finally { await x.plugin.close(); }
});

test('side-loaded plugin with the built-in ID cannot invoke startup authority',async t=>{
  const x=await fixture(t,{trustedBuiltIn:false});
  try {
    await assert.rejects(x.plugin.configure({method:'bindExecutorStartup',
      payload:{taskId:'task',startupId:'startup',recordId:'a'.repeat(32)}}),
    error=>error.code==='PERMISSION_DENIED');
    assert.equal(x.seen.length,0);
  } finally { await x.plugin.close(); }
});
