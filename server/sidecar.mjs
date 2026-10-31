import { createInterface } from 'node:readline';
import { createCore } from './core.mjs';
import { startHttp } from './http.mjs';
import { writeFile } from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import { join } from 'node:path';
import { loadVerifiedPreviewPython } from './preview/python-runtime.mjs';
import {createShutdownStageRecorder} from './shutdown-diagnostics.mjs';
const [dataDir,pluginDir,workspace]=process.argv.slice(2);
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const sendShutdownReceipt=()=>new Promise((resolve,reject)=>{
  process.stdout.write(JSON.stringify({event:'shutdown-complete'})+'\n',error=>error?reject(error):resolve());
});
const startupStarted=performance.now();
const startupStages=[];
const stage=name=>{
  const entry={stage:name,elapsedMs:Math.round(performance.now()-startupStarted)};
  // One bounded history per boot; only internal phase labels, never plugin
  // settings, command output, paths, addresses or credentials.
  if(startupStages.length<24)startupStages.push(entry);
  try{writeFileSync(join(dataDir,'startup.json'),JSON.stringify({stage:name,at:new Date().toISOString(),stages:startupStages}),{mode:0o600});}catch{/* Diagnostics must not prevent a usable board from opening. */}
};
let shutdownStarted;
const shutdownStage=createShutdownStageRecorder({dataDir,
  elapsedMs:()=>performance.now()-(shutdownStarted??performance.now())});
// Preview has its own packaged interpreter. Do not rebind existing terminal jobs.
let previewPythonPath=null;
stage('preview-runtime-check');
try{previewPythonPath=loadVerifiedPreviewPython().pythonPath;}catch{/* Unsupported previews must not prevent the board opening. */}
stage('core-start');
let core;
try{core=await createCore({dataDir,pluginDir,workspace:workspace||undefined,desktop:true,previewPythonPath,onStartup:stage,onShutdown:shutdownStage});}
catch(error){
  if(error?.code!=='UNCLEAN_SHUTDOWN_REVIEW_REQUIRED')throw error;
  await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify({event:'startup-blocked',reason:'unclean_shutdown_review_required'})+'\n',writeError=>writeError?reject(writeError):resolve()));
  process.exit(1);
}
stage('http-start');
const http=await startHttp({core,dataDir,distDir:join(pluginDir,'..','dist'),port:0});
await writeFile(join(dataDir,'connection.json'),JSON.stringify({url:`http://127.0.0.1:${http.port}`}),{mode:0o600});
stage('ready');
core.events.on('change',()=>send({event:'changed'}));send({event:'ready'});
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
lines.on('line',async line=>{let req;try{
  if(Buffer.byteLength(line)>16_100_000)throw Error('请求过大');
  req=JSON.parse(line);
  if(req?.event==='shutdown'){void stop();return;}
  if(closing)throw Error('任务服务正在关闭');
  const result=await core.request(req.method,req.path,req.body||{});send({id:req.id,result});
}catch(e){send({id:req?.id,error:{message:e.message,status:e.status||500,code:e.code}});}});
let closing=false;
async function stop(){
  if(closing)return;closing=true;
  stage('closing');
  shutdownStarted=performance.now();
  try{writeFileSync(join(dataDir,'shutdown-stages.jsonl'),'',{mode:0o600});}catch{/* Diagnostics cannot change shutdown behavior. */}
  try{
    // Start provider cancellation before waiting for active HTTP requests.
    shutdownStage({stage:'core',status:'started'});
    const coreShutdown=core.close().then(value=>{shutdownStage({stage:'core',status:'fulfilled'});return value;},error=>{shutdownStage({stage:'core',status:'rejected'});throw error;});
    shutdownStage({stage:'http',status:'started'});
    const httpShutdown=http.close().then(value=>{shutdownStage({stage:'http',status:'fulfilled'});return value;},error=>{shutdownStage({stage:'http',status:'rejected'});throw error;});
    const results=await Promise.allSettled([coreShutdown,httpShutdown]);
    const failures=results.filter(result=>result.status==='rejected').map(result=>result.reason);
    if(failures.length)throw new AggregateError(failures,'任务服务关闭未完成');
    stage('closed');await sendShutdownReceipt();process.exit(0);
  }
  catch{console.error('关闭任务服务失败');process.exit(1);}
}
lines.on('close',()=>void stop());process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
