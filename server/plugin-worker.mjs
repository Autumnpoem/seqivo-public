import {format} from 'node:util';
import {pathToFileURL} from 'node:url';

const MAX_FRAME=1_000_000;
const METHODS=new Set(['state','configure','enable','disable','check','setPolicy','reconcile','createSession','getExecution','getSessionBinding','quiesce','resume','pause','conversation','close']);
for(const method of ['log','info','warn','error','debug'])console[method]=(...args)=>process.stderr.write(format(...args)+'\n');
let instance=null,buffer=Buffer.alloc(0),sequence=0,closing=false;
const pending=new Map();
function serializeError(error){return {message:error?.message||String(error),status:Number.isInteger(error?.status)?error.status:undefined,code:typeof error?.code==='string'?error.code:undefined};}
function reviveError(value){const error=new Error(value?.message||'Host callback failed');if(Number.isInteger(value?.status))error.status=value.status;if(typeof value?.code==='string')error.code=value.code;return error;}
function send(frame){const wire=JSON.stringify(frame)+'\n';if(Buffer.byteLength(wire)>MAX_FRAME)throw Error('RPC message exceeds 1 MB');process.stdout.write(wire);}
function callback(method,args){
  const id=`worker-${++sequence}`;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(Error(`Host callback timed out: ${method}`));},
      ['verifyRetirementWorkspace','verifyLinuxBridgeRetirementWorkspace','verifyLinuxJobRetirement'].includes(method)?45_000:15_000);
    pending.set(id,{resolve,reject,timer});
    try{send({type:'request',id,method,args});}catch(error){clearTimeout(timer);pending.delete(id);reject(error);}
  });
}
const context={
  getTask:id=>callback('getTask',[id]),
  getProject:id=>callback('getProject',[id]),
  resolveWorkspace:input=>callback('resolveWorkspace',[input]),
  updateTask:(id,patch,revision)=>callback('updateTask',[id,patch,revision]),
  authorizeExecution:input=>callback('authorizeExecution',[input]),
  revalidateExecution:input=>callback('revalidateExecution',[input]),
  reserveExecutorStartup:input=>callback('reserveExecutorStartup',[input]),
  bindExecutorStartup:input=>callback('bindExecutorStartup',[input]),
  confirmExecutorStartup:input=>callback('confirmExecutorStartup',[input]),
  bindExecutorConversation:input=>callback('bindExecutorConversation',[input]),
  verifyExecutorStartup:input=>callback('verifyExecutorStartup',[input]),
  retireExecutorStartup:input=>callback('retireExecutorStartup',[input]),
  disposeStoppedUnknownExecutor:input=>callback('disposeStoppedUnknownExecutor',[input]),
  verifyRetirementWorkspace:input=>callback('verifyRetirementWorkspace',[input]),
  verifyLinuxExecutorAdmission:input=>callback('verifyLinuxExecutorAdmission',[input]),
  verifyLinuxBridgeRetirementWorkspace:input=>callback('verifyLinuxBridgeRetirementWorkspace',[input]),
  verifyLinuxJobRetirement:input=>callback('verifyLinuxJobRetirement',[input]),
  emit:()=>callback('emit',[]),
};
async function dispatch(message){
  const {id,method,args}=message;
  try{
    if(typeof id!=='string'||!Array.isArray(args))throw Error('Invalid RPC request');
    let result;
    if(method==='initialize'){
      if(instance)throw Error('Plugin is already initialized');
      const config=args[0];
      if(!config||typeof config.entry!=='string'||typeof config.dataDir!=='string'||typeof config.pluginDir!=='string')throw Error('Invalid plugin startup options');
      const module=await import(pathToFileURL(config.entry).href);
      if(typeof module.createPlugin!=='function')throw Error('Plugin must export createPlugin');
      instance=await module.createPlugin({...context,dataDir:config.dataDir,pluginDir:config.pluginDir,
        ...(config.executableBaseDirectory?{executableBaseDirectory:config.executableBaseDirectory}:{})});
      const required=['state','configure','enable','disable','check','close'];
      if(required.some(name=>typeof instance?.[name]!=='function'))throw Error('Plugin lifecycle interface is incomplete');
      result={ready:true};
    }else{
      if(!METHODS.has(method)||!instance||typeof instance[method]!=='function')throw Error(`Plugin method unavailable: ${method}`);
      if(closing&&method!=='close')throw Error('Plugin is closing');
      if(method==='close')closing=true;
      result=await instance[method](...args);
    }
    send({type:'response',id,result:result??null});
  }catch(error){try{send({type:'response',id,error:serializeError(error)});}catch{}}
}
function receive(line){
  let message;try{message=JSON.parse(line);}catch{process.stderr.write('Invalid RPC JSON\n');process.exitCode=1;process.stdin.pause();return;}
  if(message?.type==='response'&&typeof message.id==='string'){
    const item=pending.get(message.id);if(!item)return;
    pending.delete(message.id);clearTimeout(item.timer);
    message.error?item.reject(reviveError(message.error)):item.resolve(message.result);
    return;
  }
  if(message?.type==='request'){void dispatch(message);return;}
  process.stderr.write('Invalid RPC frame\n');process.exitCode=1;process.stdin.pause();
}
process.stdin.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  let index;while((index=buffer.indexOf(10))!==-1){
    const frame=buffer.subarray(0,index);buffer=buffer.subarray(index+1);
    if(frame.length>MAX_FRAME){process.stderr.write('RPC input exceeds 1 MB\n');process.exitCode=1;process.stdin.pause();return;}
    if(frame.length)receive(frame.toString('utf8'));
  }
  if(buffer.length>MAX_FRAME){process.stderr.write('RPC input exceeds 1 MB\n');process.exitCode=1;process.stdin.pause();}
});
process.stdin.on('end',()=>{
  if(closing||!instance)return;
  closing=true;
  Promise.race([Promise.resolve().then(()=>instance.close()),new Promise((_,reject)=>setTimeout(()=>reject(Error('Plugin close timed out')),5000))])
    .then(()=>{process.exitCode=0;},error=>{process.stderr.write(`Plugin close after host disconnect failed: ${error.message}\n`);process.exitCode=1;});
});
process.on('SIGTERM',()=>{
  closing=true;
  const close=instance&&typeof instance.close==='function'?Promise.resolve().then(()=>instance.close()):Promise.resolve();
  Promise.race([close,new Promise((_,reject)=>setTimeout(()=>reject(Error('Plugin close timed out')),7000))])
    .then(()=>process.exit(0),error=>{process.stderr.write(`Plugin SIGTERM cleanup failed: ${error.message}\n`);process.exit(1);});
});
