import {DatabaseSync,backup} from 'node:sqlite';
import {mkdir,readdir,copyFile,chmod,writeFile,lstat,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {resolve,join} from 'node:path';
const args=process.argv.slice(2),arg=name=>args[args.indexOf(name)+1];
if(!args.includes('--data-dir')||!args.includes('--output'))throw Error('Use --data-dir DIR --output NEW_DIRECTORY');
const source=resolve(arg('--data-dir')),output=resolve(arg('--output'));
await mkdir(output,{mode:0o700});
const db=new DatabaseSync(join(source,'hub.sqlite'),{readOnly:true});
try{await backup(db,join(output,'hub.sqlite'));}finally{db.close();}
await chmod(join(output,'hub.sqlite'),0o600);
for(const name of await readdir(source))if(/^[A-Za-z0-9_-]+-owner-[a-f0-9-]+\.token$/.test(name)){await copyFile(join(source,name),join(output,name));await chmod(join(output,name),0o600);}
const sshSource=join(source,'ssh'),sshOutput=join(output,'ssh');
let sshIncluded=false;
let sshState='absent';
try {
  const directory=await lstat(sshSource);
  if(!directory.isDirectory()||directory.isSymbolicLink())throw new Error('SSH backup source must be a real directory');
  await mkdir(sshOutput,{mode:0o700});await chmod(sshOutput,0o700);
  const readSshFile=async name=>{
    let handle;
    try {
      handle=await open(join(sshSource,name),constants.O_RDONLY|constants.O_NOFOLLOW);
      const info=await handle.stat();
      if(!info.isFile())throw new Error(`SSH backup file is not regular: ${name}`);
      return await handle.readFile();
    } catch(error) {
      if(error.code==='ENOENT')return null;
      if(error.code==='ELOOP')throw new Error(`SSH backup refuses symbolic link: ${name}`);
      throw error;
    } finally { await handle?.close(); }
  };
  const hosts=await readSshFile('ssh-hosts.json'),key=await readSshFile('ssh-vault.key');
  if(!hosts&&!key)throw new Error('SSH backup is incomplete: both SSH files are missing');
  if(hosts&&!key)throw new Error('SSH backup is incomplete: missing ssh-vault.key');
  if(key&&key.length!==32)throw new Error('SSH backup vault key must be exactly 32 bytes');
  for(const [name,contents] of [['ssh-hosts.json',hosts??Buffer.from('{"version":1,"owners":{}}')],['ssh-vault.key',key]]){
    if(!contents)continue;
    await writeFile(join(sshOutput,name),contents,{mode:0o600,flag:'wx'});
    await chmod(join(sshOutput,name),0o600);
  }
  sshIncluded=true;sshState=hosts?'configured':'empty';
} catch(error) {
  if(error.code!=='ENOENT'||error.path!==sshSource)throw error;
}
await writeFile(join(output,'manifest.json'),JSON.stringify({format:'tuijin-hub-backup',version:2,createdAt:new Date().toISOString(),sshIncluded,sshState},null,2),{mode:0o600});
console.log(output);
