import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createCore } from '../../server/core.mjs';

const [dataDir,root,sessionRefJson,marker] = process.argv.slice(2);
const sessionRef=JSON.parse(sessionRefJson);
const core=await createCore({dataDir,pluginDir:join(root,'plugins'),files:false,
  managedPythonPath:process.env.TASKBOARD_TEST_PYTHON || '/usr/bin/python3'});
try {
  const frames=[],send=frame=>frames.push(frame),ctx={local:true,profileId:'managed',connectionId:'new-process-owner'};
  await core.terminal.frame(ctx,{v:1,type:'open',mode:'tmux',cols:80,rows:24},send);
  await core.terminal.frame(ctx,{v:1,type:'reconcile-control',action:'acquire',sessionRef,requestId:'new-process-recovery'},send);
  if (frames.filter(frame=>frame.type==='control').at(-1)?.owned !== true) throw new Error('Original owner recovery was not confirmed');
  await core.terminal.frame(ctx,{v:1,type:'select',epoch:0,sessionRef},send);
  const ready=frames.filter(frame=>frame.type==='ready').at(-1);
  if (!ready?.epoch) throw new Error('Original managed pane did not attach');
  await core.terminal.frame(ctx,{v:1,type:'input',epoch:ready.epoch,seq:1,
    data:Buffer.from(`printf AFTER > '${marker}'\n`).toString('base64')},send);
  const deadline=Date.now()+8000;
  while (Date.now()<deadline && (await readFile(marker,'utf8').catch(()=>''))!=='AFTER')
    await new Promise(resolve=>setTimeout(resolve,50));
  if ((await readFile(marker,'utf8').catch(()=>''))!=='AFTER') throw new Error('Recovered original shell did not write marker');
} finally { await core.close(); }
