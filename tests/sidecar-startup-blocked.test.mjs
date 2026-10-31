import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const sidecar=fileURLToPath(new URL('../server/sidecar.mjs',import.meta.url));

test('unclean lock reports only a fixed startup block and preserves all prior state',async t=>{
  const root=await mkdtemp(join(tmpdir(),'seqivo-sidecar-startup-blocked-'));
  let completed=false;
  t.after(async()=>{if(completed)await rm(root,{recursive:true,force:true});});
  const dataDir=join(root,'data'),pluginDir=join(root,'plugins');
  const plugin=join(pluginDir,'sentinel'),marker=join(root,'plugin-initialized');
  await mkdir(dataDir,{recursive:true});await mkdir(plugin,{recursive:true});
  await writeFile(join(plugin,'plugin.json'),JSON.stringify({id:'sentinel',name:'Sentinel',version:'1',apiVersion:1,entry:'host.mjs'}));
  await writeFile(join(plugin,'host.mjs'),`import {writeFileSync} from 'node:fs';
export function createPlugin(){writeFileSync(${JSON.stringify(marker)},'initialized');throw Error('PRIVATE_PLUGIN_ERROR');}`);
  const privateToken='PRIVATE_LOCK_TOKEN_NEVER_EXPOSE';
  const lockBytes=Buffer.from(JSON.stringify({pid:process.pid,token:privateToken,uncleanShutdown:true}));
  await writeFile(join(dataDir,'core.lock'),lockBytes,{mode:0o600});
  const child=spawn(process.execPath,[sidecar,dataDir,pluginDir],{cwd:root,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
  const exit=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill('SIGTERM');reject(Error('sidecar startup did not exit within 10 seconds'));},10_000);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal});});
  });
  assert.deepEqual(exit,{code:1,signal:null});
  assert.ok(stdout.trim(),'sidecar did not emit a startup frame');
  assert.deepEqual(stdout.trim().split('\n').map(JSON.parse),[
    {event:'startup-blocked',reason:'unclean_shutdown_review_required'},
  ]);
  assert.equal(stderr,'');
  for(const privateValue of [privateToken,root,'PRIVATE_PLUGIN_ERROR']){
    assert.equal(stdout.includes(privateValue)||stderr.includes(privateValue),false);
  }
  assert.deepEqual(await readFile(join(dataDir,'core.lock')),lockBytes);
  for(const path of [marker,join(dataDir,'board.sqlite'),join(dataDir,'connection.json'),join(dataDir,'core.lock.guard')])
    assert.equal(existsSync(path),false,`${path} was unexpectedly created`);
  const startup=JSON.parse(await readFile(join(dataDir,'startup.json'),'utf8'));
  assert.deepEqual(startup.stages.map(item=>item.stage),['preview-runtime-check','core-start']);
  completed=true;
});
