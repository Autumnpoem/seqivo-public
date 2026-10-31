import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

// The fixed runner is the job leader. It acknowledges a build only after the
// fixed worker has closed both pipes and exited normally with code zero.
const worker=process.argv[2],settings=process.argv[3];
if(!isAbsolute(worker||'')||!isAbsolute(settings||''))process.exit(2);
let child;
try{
  child=spawn(process.execPath,[worker,settings],{
    cwd:process.cwd(),env:process.env,stdio:['ignore','pipe','pipe']});
  let output='',overflow=false;
  child.stdout.on('data',chunk=>{output+=chunk.toString('utf8');if(output.length>1024){overflow=true;child.kill();}});
  child.stderr.on('data',()=>{});
  const result=await new Promise((resolve,reject)=>{
    child.once('error',reject);
    child.once('close',(code,signal)=>resolve({code,signal}));
  });
  if(overflow||result.code!==0||result.signal!==null||output.trim()!=='{"v":1,"status":"built"}')
    throw Error('worker_not_successful');
  await new Promise((resolve,reject)=>process.stdout.write('{"v":1,"status":"built"}\n',error=>error?reject(error):resolve()));
}catch{
  process.exitCode=1;
}
