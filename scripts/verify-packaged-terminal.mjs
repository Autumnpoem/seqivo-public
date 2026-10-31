// Exercise only the supplied generated/package resources, without checkout dependencies.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

if(process.argv[2]!=='--child'){
  if(!process.argv[2])throw Error('Usage: node scripts/verify-packaged-terminal.mjs <resources-dir> [packaged-node]');
  const resources=resolve(process.argv[2]);
  const node=process.argv[3]?resolve(process.argv[3]):process.execPath;
  const env={...process.env,PATH:'/usr/bin:/bin'};
  for(const name of ['TMUX_PATH','NODE_PATH','DYLD_LIBRARY_PATH','DYLD_FALLBACK_LIBRARY_PATH','DYLD_INSERT_LIBRARIES'])delete env[name];
  execFileSync(node,[process.argv[1],'--child',resources],{cwd:tmpdir(),env,stdio:'inherit',timeout:20000});
}else{
  const resources=resolve(process.argv[3]);
  const {createTmuxAdapter}=await import(pathToFileURL(join(resources,'server/terminal/tmux.mjs')));
  const {createTerminalRuntime}=await import(pathToFileURL(join(resources,'server/terminal/runtime.mjs')));
  const dir=await mkdtemp(join(tmpdir(),'seqivo-packaged-terminal-'));
  const name=`seqivo-pkg-${randomBytes(8).toString('hex')}`;
  const binary=join(resources,'terminal/bin/tmux');
  const adapter=createTmuxAdapter({serverName:name});
  let runtime,created=false;
  const wait=async condition=>{const end=Date.now()+5000;while(Date.now()<end){if(await condition())return;await new Promise(r=>setTimeout(r,25));}throw Error('Packaged terminal observation timed out');};
  try{
    const capability=await adapter.inspect();assert.equal(capability.available,true);
    let output='';
    runtime=createTerminalRuntime({shell:'/bin/sh',args:[],cwd:dir,onData:data=>{output+=data;}});
    runtime.write("printf '%s%s\\n' PACKAGED_ PTY_OK\r");
    await wait(()=>output.includes('PACKAGED_PTY_OK'));
    runtime.write("printf '%s' '中文✓' > packaged.txt\r");
    await wait(async()=>await readFile(join(dir,'packaged.txt'),'utf8').catch(()=>'')==='中文✓');
    await runtime.close();runtime=null;
    const session=await adapter.create({name:'packaged',cwd:dir});created=true;
    const target=await adapter.attachTarget({sessionRef:session.sessionRef});
    assert.equal(target.command,binary,'automatically resolves the bundled executable without development PATH');
    output='';runtime=createTerminalRuntime({...target,shell:target.command,cwd:dir,onData:data=>{output+=data;}});
    runtime.write("printf '%s%s\\n' PACKAGED_ TMUX_OK\r");
    await wait(()=>output.includes('PACKAGED_TMUX_OK'));
    await runtime.close();runtime=null;
    assert.equal((await adapter.list()).sessions.length,1,'closing the attachment preserves the tmux session');
    console.log(JSON.stringify({passed:true,node:process.versions.node,platform:process.platform,architecture:process.arch,
      checks:['bundled dependency discovery','real PTY input/output','Unicode file write','real tmux attach','detach preserves session']}));
  }finally{
    await runtime?.close();
    if(created)try{execFileSync(binary,['-L',name,'kill-server'],{timeout:5000,stdio:'ignore'});}catch{/* Only the disposable server. */}
    await rm(dir,{recursive:true,force:true});
  }
}
